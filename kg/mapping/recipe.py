"""Extraction Recipe — DKG↔문서 연결부의 선언적 저장 (KG2).

크롤링 '코드'가 아니라 (tree_path, node_type, node_name) → concept 배정
템플릿을 저장한다. tree_path는 문서 독립적(layout_fingerprint가 라벨 구조
기반·행 수 무관)이라 같은 양식의 새 문서에 그대로 이식된다.

- snapshot: 그룹 멤버의 승인 매핑에서 2단 다수결(APPROVED 우선)로 추출.
  동률은 추측하지 않고 템플릿에서 제외(judge에 위임).
- apply: 활성 매핑이 없는 노드만 채운다(사람 결정·기존 판정 무접촉).
  정확 일치 → AUTO, 완화 일치(레이아웃 지문 변화) → REVIEW로 강등.
"""
from __future__ import annotations

import json
import re
from collections import Counter

from kg.groups import group_documents
from kg.store import KgStore, new_id, now_iso

RECIPE_FORMAT = 1
_REGION_SEG = re.compile(r"^([A-Z_]+):[0-9a-f]*#\d+$")

_MAPPABLE = ("HEADER", "SUB_HEADER")
# data_type 호환 행렬 — 비호환이면 REVIEW로 강등 (통과가 기본)
_INCOMPAT = {("numeric", "text"), ("numeric", "category"),
             ("text", "numeric"), ("text", "datetime")}


def _norm_path(tree_path: str) -> str:
    """region 세그먼트의 layout fingerprint/occ 제거 — 완화 매칭 키.

    열 추가/개명만으로 TABLE fingerprint가 바뀌어 정확 일치가 전멸하는
    시나리오의 완화책이다 (템플릿 쪽 후보가 유일할 때만 사용).
    """
    parts = []
    for seg in (tree_path or "").split("/"):
        m = _REGION_SEG.match(seg)
        parts.append(m.group(1) if m else seg)
    return "/".join(parts)


def active_recipe(store: KgStore, root: str):
    return store.conn.execute(
        "SELECT * FROM extraction_recipe WHERE root_concept_id=? AND status='ACTIVE'",
        (root,)).fetchone()


def _mapped_rows(store: KgStore, document_ids: list[str]):
    if not document_ids:
        return []
    ph = ",".join("?" * len(document_ids))
    return store.conn.execute(
        f"""SELECT n.tree_path, n.node_type, n.node_name, m.concept_id, m.status
           FROM semantic_mapping m
           JOIN tree_node n ON n.node_id=m.tree_node_id AND n.status='ACTIVE'
           WHERE m.is_active=1 AND m.status IN ('APPROVED','AUTO_APPROVED')
             AND m.concept_id IS NOT NULL
             AND n.node_type IN ({",".join("?" * len(_MAPPABLE))})
             AND n.document_id IN ({ph})""",
        (*_MAPPABLE, *document_ids)).fetchall()


def snapshot_recipe(store: KgStore, root: str, note: str = "",
                    created_by: str = "web") -> dict:
    """그룹 멤버 문서의 승인 매핑 → 새 ACTIVE 레시피 (기존은 ARCHIVED로)."""
    members = group_documents(store, root)
    votes: dict[tuple, dict[str, Counter]] = {}
    for r in _mapped_rows(store, members):
        key = (r["tree_path"], r["node_type"], r["node_name"])
        tier = votes.setdefault(key, {"APPROVED": Counter(),
                                      "AUTO_APPROVED": Counter()})
        tier[r["status"]][r["concept_id"]] += 1

    template, conflicts, dropped = [], [], []
    for key, tiers in sorted(votes.items()):
        # 2단 다수결: 사람(APPROVED) 표가 있으면 그 표만으로 결정한다
        tier = "APPROVED" if tiers["APPROVED"] else "AUTO_APPROVED"
        counts = tiers[tier]
        ranked = counts.most_common()
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            dropped.append({"tree_path": key[0], "node_type": key[1],
                            "node_name": key[2], "votes": dict(counts)})
            continue
        winner, support = ranked[0]
        total = sum(counts.values())
        entry = {"tree_path": key[0], "node_type": key[1], "node_name": key[2],
                 "concept_id": winner, "tier": tier,
                 "support": support, "total": total}
        dissent = [{"concept_id": c, "support": n}
                   for c, n in ranked[1:]]
        if dissent:
            entry["dissent"] = dissent
            conflicts.append({"tree_path": key[0], "node_type": key[1],
                              "node_name": key[2], "votes": dict(counts),
                              "resolved": winner})
        template.append(entry)

    if not template:
        raise ValueError("레시피로 저장할 승인 매핑이 없습니다 — "
                         "멤버 문서를 먼저 매핑/검수하세요")
    from src.inspect.inspector import PARSER_VERSION
    spec = {"recipe_format": RECIPE_FORMAT, "parser_version": PARSER_VERSION,
            "snapshot": {"at": now_iso(), "member_docs": len(members),
                         "from_documents": members},
            "template": template, "conflicts": conflicts, "dropped": dropped}
    rid = new_id("RCP")
    try:
        store.conn.execute(
            "UPDATE extraction_recipe SET status='ARCHIVED' "
            "WHERE root_concept_id=? AND status='ACTIVE'", (root,))
        store.conn.execute(
            "INSERT INTO extraction_recipe VALUES (?,?,?,?,?,?,?)",
            (rid, root, "ACTIVE", json.dumps(spec, ensure_ascii=False),
             note, now_iso(), created_by))
        store.commit()
    except Exception:
        store.conn.rollback()
        raise
    return {"recipe_id": rid, "template": len(template),
            "conflicts": len(conflicts), "dropped": len(dropped)}


def rollback_recipe(store: KgStore, root: str, recipe_id: str) -> str:
    """과거 버전 spec을 복사한 새 ACTIVE 행 — spec_json 불변·선형 이력."""
    row = store.conn.execute(
        "SELECT * FROM extraction_recipe WHERE recipe_id=? AND root_concept_id=?",
        (recipe_id, root)).fetchone()
    if row is None:
        raise KeyError(recipe_id)
    rid = new_id("RCP")
    try:
        store.conn.execute(
            "UPDATE extraction_recipe SET status='ARCHIVED' "
            "WHERE root_concept_id=? AND status='ACTIVE'", (root,))
        store.conn.execute(
            "INSERT INTO extraction_recipe VALUES (?,?,?,?,?,?,?)",
            (rid, root, "ACTIVE", row["spec_json"],
             f"rollback → {recipe_id}", now_iso(), "web"))
        store.commit()
    except Exception:
        store.conn.rollback()
        raise
    return rid


# --------------------------------------------------------------- matching ----
def _unmapped_nodes(store: KgStore, document_id: str):
    return store.conn.execute(
        f"""SELECT n.* FROM tree_node n
           LEFT JOIN semantic_mapping m
             ON m.tree_node_id=n.node_id AND m.is_active=1
           WHERE n.document_id=? AND n.status='ACTIVE'
             AND n.node_type IN ({",".join("?" * len(_MAPPABLE))})
             AND m.mapping_id IS NULL""",
        (document_id, *_MAPPABLE)).fetchall()


def _match(spec: dict, node) -> tuple[dict | None, str]:
    """노드 1개에 대한 (템플릿 엔트리, 'exact'|'relaxed'|'none')."""
    exact = {(e["tree_path"], e["node_type"], e["node_name"]): e
             for e in spec["template"]}
    key = (node["tree_path"], node["node_type"], node["node_name"])
    if key in exact:
        return exact[key], "exact"
    relaxed: dict[tuple, list] = {}
    for e in spec["template"]:
        relaxed.setdefault(
            (_norm_path(e["tree_path"]), e["node_type"], e["node_name"]), []
        ).append(e)
    cands = relaxed.get(
        (_norm_path(node["tree_path"]), node["node_type"], node["node_name"]), [])
    if len(cands) == 1:                       # 템플릿 쪽 후보가 유일할 때만
        return cands[0], "relaxed"
    return None, "none"


def _dtype_incompatible(node_dtype: str | None, concept_dtype: str | None) -> bool:
    if not node_dtype or not concept_dtype or node_dtype in ("mixed", "empty"):
        return False
    return (node_dtype, concept_dtype) in _INCOMPAT


def apply_recipe(store: KgStore, recipe_row, document_id: str) -> dict:
    """활성 매핑이 없는 노드에 템플릿을 적용한다. 성공 시 commit."""
    spec = json.loads(recipe_row["spec_json"])
    rid = recipe_row["recipe_id"]
    stats = {"applied": 0, "review": 0, "relaxed": 0,
             "skipped_mapped": 0, "skipped_stale": 0}
    stats["skipped_mapped"] = store.conn.execute(
        f"""SELECT count(*) FROM tree_node n
           JOIN semantic_mapping m ON m.tree_node_id=n.node_id AND m.is_active=1
           WHERE n.document_id=? AND n.status='ACTIVE'
             AND n.node_type IN ({",".join("?" * len(_MAPPABLE))})""",
        (document_id, *_MAPPABLE)).fetchone()[0]
    try:
        for node in _unmapped_nodes(store, document_id):
            entry, how = _match(spec, node)
            if entry is None:
                continue
            c = store.concept(entry["concept_id"])
            if c is None or c["status"] != "ACTIVE":
                stats["skipped_stale"] += 1
                continue
            dissent = entry.get("dissent") or []
            support, total = entry["support"], entry["total"]
            if how == "relaxed":
                status, conf = "REVIEW_REQUIRED", 0.6
                reason = (f"recipe {rid}: 레이아웃 변경 감지(완화 매칭) — "
                          f"{support}/{total} 지지 ({entry['tier']})")
                stats["relaxed"] += 1
            elif dissent:
                status, conf = "REVIEW_REQUIRED", round(support / total, 3)
                reason = (f"recipe {rid}: 문서 간 배정 충돌 — "
                          f"{support}/{total} 지지 ({entry['tier']})")
            elif _dtype_incompatible(node["data_type"], c["data_type"]):
                status, conf = "REVIEW_REQUIRED", 0.6
                reason = (f"recipe {rid}: 데이터 타입 비호환 "
                          f"(노드 {node['data_type']} / 개념 {c['data_type']})")
            else:
                status = "AUTO_APPROVED"
                conf = 1.0 if entry["tier"] == "APPROVED" else 0.9
                reason = f"recipe {rid}: {support}/{total} 지지 ({entry['tier']})"
            candidates = [{"concept_id": entry["concept_id"],
                           "canonical_name": c["canonical_name"],
                           "score": round(support / total, 3),
                           "signals": {"recipe": entry["tier"], "match": how}}]
            for dis in dissent:
                dc = store.concept(dis["concept_id"])
                candidates.append({
                    "concept_id": dis["concept_id"],
                    "canonical_name": dc["canonical_name"] if dc else dis["concept_id"],
                    "score": round(dis["support"] / total, 3),
                    "signals": {"recipe": "dissent"}})
            store.save_mapping(
                node["node_id"], entry["concept_id"], conf, "recipe", status,
                context={"recipe_id": rid, "match": how,
                         "matched_key": [entry["tree_path"], entry["node_type"],
                                         entry["node_name"]]},
                candidates=candidates, reason=reason)
            if status == "AUTO_APPROVED":
                stats["applied"] += 1
            else:
                stats["review"] += 1
        store.commit()
    except Exception:
        store.conn.rollback()
        raise
    return stats


def preview_recipe(store: KgStore, recipe_row, document_id: str) -> list[dict]:
    """dry-run: 노드별 매칭 결과 (쓰기 없음)."""
    spec = json.loads(recipe_row["spec_json"])
    out = []
    rows = store.conn.execute(
        f"""SELECT n.*, m.concept_id cur_concept, m.status cur_status
           FROM tree_node n
           LEFT JOIN semantic_mapping m
             ON m.tree_node_id=n.node_id AND m.is_active=1
           WHERE n.document_id=? AND n.status='ACTIVE'
             AND n.node_type IN ({",".join("?" * len(_MAPPABLE))})""",
        (document_id, *_MAPPABLE)).fetchall()
    for node in rows:
        entry, how = _match(spec, node)
        out.append({
            "node_id": node["node_id"], "node_name": node["node_name"],
            "tree_path": node["tree_path"], "match": how,
            "entry": ({"concept_id": entry["concept_id"], "tier": entry["tier"],
                       "support": entry["support"], "total": entry["total"]}
                      if entry else None),
            "current_mapping": ({"concept_id": node["cur_concept"],
                                 "status": node["cur_status"]}
                                if node["cur_status"] else None)})
    return out


# ------------------------------------------------------------- suggestions ----
def _doc_keys(store: KgStore, document_id: str) -> set[tuple]:
    return {(r["tree_path"], r["node_type"], r["node_name"])
            for r in store.conn.execute(
                f"""SELECT tree_path, node_type, node_name FROM tree_node
                   WHERE document_id=? AND status='ACTIVE'
                     AND node_type IN ({",".join("?" * len(_MAPPABLE))})""",
                (document_id, *_MAPPABLE))}


def suggest_groups(store: KgStore, document_id: str) -> list[dict]:
    """새 문서의 구조 키를 각 DKG의 레시피(없으면 멤버 문서 키)와 비교 —
    '같은 형식' 후보를 match% 내림차순으로 돌려준다."""
    keys = _doc_keys(store, document_id)
    if not keys:
        return []
    out = []
    roots = {r["concept_id"]: r["canonical_name"] for r in store.conn.execute(
        "SELECT concept_id, canonical_name FROM domain_concept "
        "WHERE domain_level='L1' AND status='ACTIVE'")}
    for root, name in roots.items():
        rec = active_recipe(store, root)
        if rec is not None:
            spec = json.loads(rec["spec_json"])
            tpl = {(e["tree_path"], e["node_type"], e["node_name"])
                   for e in spec["template"]}
        else:
            tpl = set()
            for doc in group_documents(store, root):
                if doc != document_id:
                    tpl |= _doc_keys(store, doc)
        if not tpl:
            continue
        hit = len(keys & tpl)
        if hit:
            out.append({"root_concept_id": root, "name": name + " 문서군",
                        "match_pct": round(100 * hit / len(keys), 1),
                        "has_recipe": rec is not None})
    out.sort(key=lambda s: -s["match_pct"])
    return out
