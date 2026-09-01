"""DKG(Document KG) 그룹 — 파생 + 사람 델타 (KG2).

DKG는 별도 엔티티가 아니라 L1 root concept 그 자체다. AUTO 멤버십은 승인
매핑에서 파생하고, 사람의 결정(INCLUDED/EXCLUDED)만 document_group_member에
저장한다. 최종 멤버 = 파생 ∪ INCLUDED − EXCLUDED.
"""
from __future__ import annotations

from kg.store import KgStore, now_iso

_APPROVED = "m.is_active=1 AND m.status IN ('AUTO_APPROVED','APPROVED')"


def isa_roots(store: KgStore) -> tuple[dict, dict, dict]:
    """concept → L1 루트 (IS_A 체인). 반환: (roots, levels, parents)."""
    levels = {}
    parents = {}
    for r in store.conn.execute("SELECT concept_id, domain_level FROM domain_concept"):
        levels[r["concept_id"]] = r["domain_level"]
    for r in store.conn.execute(
            "SELECT source_concept_id s, target_concept_id t FROM domain_relation "
            "WHERE relation_type='IS_A'"):
        parents[r["s"]] = r["t"]
    roots = {}
    for cid in levels:
        cur, hops = cid, 0
        while levels.get(cur) != "L1" and cur in parents and hops < 6:
            cur = parents[cur]
            hops += 1
        roots[cid] = cur if levels.get(cur) == "L1" else None
    return roots, levels, parents


def member_overrides(store: KgStore) -> dict[tuple[str, str], str]:
    """(root_concept_id, document_id) → 'INCLUDED'|'EXCLUDED'."""
    return {(r["root_concept_id"], r["document_id"]): r["state"]
            for r in store.conn.execute(
                "SELECT root_concept_id, document_id, state "
                "FROM document_group_member")}


def set_member_override(store: KgStore, root: str, document_id: str,
                        state: str) -> None:
    store.conn.execute(
        """INSERT INTO document_group_member VALUES (?,?,?,?)
           ON CONFLICT(root_concept_id, document_id)
           DO UPDATE SET state=excluded.state, created_at=excluded.created_at""",
        (root, document_id, state, now_iso()))


def clear_member_override(store: KgStore, root: str, document_id: str) -> int:
    cur = store.conn.execute(
        "DELETE FROM document_group_member WHERE root_concept_id=? AND document_id=?",
        (root, document_id))
    return cur.rowcount


def document_kgs(store: KgStore) -> list[dict]:
    """Document KG 도출(§4.3) + 사람 델타 반영. Core 파생 View Model.

    파생: L1 도메인 그룹별로 그 그룹 개념에 승인 매핑을 제공하는 문서군.
    델타: EXCLUDED 문서의 기여는 통계에서 제외, INCLUDED 문서는 매핑이 없어도
    sources=0 멤버로 나타난다(빈 DKG에 첫 문서를 핀 고정하는 경로).
    """
    roots, _levels, _parents = isa_roots(store)
    overrides = member_overrides(store)
    rows = store.conn.execute(
        f"""SELECT m.concept_id, n.document_id, d.filename, n.node_id,
                  n.locator, n.tree_path, c.canonical_name,
                  (SELECT p.row_count FROM data_payload p
                   WHERE p.tree_node_id=n.node_id AND p.is_current=1) rowc
           FROM semantic_mapping m
           JOIN tree_node n ON n.node_id=m.tree_node_id AND n.status='ACTIVE'
           JOIN document d ON d.document_id=n.document_id
           JOIN domain_concept c ON c.concept_id=m.concept_id
           WHERE {_APPROVED}""").fetchall()
    kgs: dict[str, dict] = {}

    def _group(root: str) -> dict:
        return kgs.setdefault(root, {"id": root, "nodes": {}, "docs": {},
                                     "sources": 0, "values": 0})

    for r in rows:
        root = roots.get(r["concept_id"])
        if root is None:
            continue
        if overrides.get((root, r["document_id"])) == "EXCLUDED":
            continue
        g = _group(root)
        g["nodes"].setdefault(r["concept_id"], 0)
        g["nodes"][r["concept_id"]] += 1
        doc = g["docs"].setdefault(r["document_id"], {
            "document_id": r["document_id"], "filename": r["filename"],
            "nodes": set(), "first_locator": r["locator"], "sources": 0})
        doc["nodes"].add(r["canonical_name"])
        doc["sources"] += 1
        g["sources"] += 1
        g["values"] += r["rowc"] or 0

    # INCLUDED 핀 + 레시피만 있는 빈 그룹도 그룹으로 노출한다
    filenames = {r["document_id"]: r["filename"] for r in store.conn.execute(
        "SELECT document_id, filename FROM document")}
    for (root, doc_id), state in overrides.items():
        if state != "INCLUDED":
            continue
        g = _group(root)
        if doc_id not in g["docs"]:
            g["docs"][doc_id] = {
                "document_id": doc_id,
                "filename": filenames.get(doc_id, doc_id),
                "nodes": set(), "first_locator": None, "sources": 0,
                "pinned": True}
    for r in store.conn.execute(
            "SELECT root_concept_id FROM extraction_recipe WHERE status='ACTIVE'"):
        _group(r["root_concept_id"])

    out = []
    for root, g in kgs.items():
        c = store.concept(root)
        out.append({
            "id": root,
            "name": (c["canonical_name"] if c else root) + " 문서군",
            "domain_node_ids": sorted(g["nodes"], key=lambda k: -g["nodes"][k]),
            "member_document_count": len(g["docs"]),
            "member_documents": sorted(
                ({**d, "nodes": sorted(d["nodes"])} for d in g["docs"].values()),
                key=lambda d: -d["sources"]),
            "source_location_count": g["sources"],
            "value_count": g["values"],
        })
    out.sort(key=lambda k: -k["source_location_count"])
    return out


def group_documents(store: KgStore, root: str) -> list[str]:
    """그룹의 최종 멤버 document_id 목록 (파생 ∪ INCLUDED − EXCLUDED)."""
    roots, _l, _p = isa_roots(store)
    derived: set[str] = set()
    for r in store.conn.execute(
            f"""SELECT DISTINCT m.concept_id, n.document_id
               FROM semantic_mapping m
               JOIN tree_node n ON n.node_id=m.tree_node_id AND n.status='ACTIVE'
               WHERE {_APPROVED}"""):
        if roots.get(r["concept_id"]) == root:
            derived.add(r["document_id"])
    for (rt, doc_id), state in member_overrides(store).items():
        if rt != root:
            continue
        if state == "INCLUDED":
            derived.add(doc_id)
        elif state == "EXCLUDED":
            derived.discard(doc_id)
    return sorted(derived)


def is_l1_concept(store: KgStore, concept_id: str) -> bool:
    row = store.concept(concept_id)
    return row is not None and row["domain_level"] == "L1"
