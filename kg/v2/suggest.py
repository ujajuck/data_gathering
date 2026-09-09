"""문서 버전의 구조 서명과 문서군 제안·레시피 이식. 서명은 재계산 가능한 파생 캐시다."""

from __future__ import annotations

import copy
import json
import os

from .db import Problem, digest, dump, insert, norm, now, one, uid
from .readers import (
    SIGNATURE_COLS,
    SIGNATURE_ROWS,
    SIGNATURE_SHEETS,
    SIGNATURE_TERMS,
    signature_terms,
)
from .spec import address, validate_rule

# v2: 헤더 성분이 라벨로 판정한 셀만 담는다. 알고리즘이 바뀌면 이전 캐시는 재계산 대상이다.
ALGORITHM = "structure-v2"
WEIGHTS = {"sheet_names": 0.4, "headers": 0.4, "merges": 0.2}
CANDIDATE_LIMIT = 2000
LIST_PREVIEW = 20


def _reader_revision():
    return os.environ.get("KG_V2_READER_REVISION", "unversioned-operator-adapter")


def _fallback_signature(service, version, sheets, principal, checkpoint):
    # 서명 연산이 없는 제공자는 기존 viewport 계약으로 시트별 앞 30×30 창을 읽는다.
    result = []
    for n, sheet in enumerate(sheets[:SIGNATURE_SHEETS]):
        view = service.read(
            version["provider"],
            principal,
            "viewport",
            {
                "source_ref": version["source_ref"],
                "expected_token": version["provider_version_token"],
                "sheet": sheet["name"],
                "r1": 1,
                "c1": 1,
                "rows": SIGNATURE_ROWS,
                "cols": SIGNATURE_COLS,
            },
            checkpoint,
        )
        grid = [[None] * SIGNATURE_COLS for _ in range(SIGNATURE_ROWS)]
        anchors, merges = set(), set()
        for cell in view.get("cells", []) if isinstance(view, dict) else []:
            try:
                r1, c1, r2, c2 = (int(cell[k]) for k in ("r1", "c1", "r2", "c2"))
            except (KeyError, TypeError, ValueError):
                continue
            if 1 <= r1 <= SIGNATURE_ROWS and 1 <= c1 <= SIGNATURE_COLS:
                grid[r1 - 1][c1 - 1] = cell.get("text")
            if r2 > r1 or c2 > c1:
                merges.add(address(r1, c1, r2, c2))
                anchors.add((r1, c1))
        result.append(
            {
                "name": sheet["name"],
                "ordinal": n,
                "visibility": sheet.get("visibility") or "visible",
                "dims": {
                    "rows": view.get("estimated_rows", sheet.get("estimated_rows")),
                    "cols": view.get("estimated_cols", sheet.get("estimated_cols")),
                },
                "headers": signature_terms(grid, anchors),
                "merges": sorted(merges)[:SIGNATURE_TERMS],
            }
        )
    return {"token": version["provider_version_token"], "sheets": result}


def _normalize(raw, version):
    """제공자의 서명 응답을 검증해 저장 형태로 바꾼다. 형식 오류는 INVALID_READER_CONTRACT다."""
    invalid = Problem(
        "INVALID_READER_CONTRACT", "제공자의 구조 서명 응답이 유효하지 않습니다."
    )
    if not isinstance(raw, dict) or not isinstance(raw.get("sheets"), list):
        raise invalid
    if raw.get("token") != version["provider_version_token"]:
        raise Problem(
            "SOURCE_VERSION_CHANGED", "원본이 변경되었습니다. 새 버전을 등록하세요.", 409
        )
    sheets = []
    for n, sheet in enumerate(raw["sheets"][:SIGNATURE_SHEETS]):
        if not isinstance(sheet, dict) or not isinstance(sheet.get("name"), str):
            raise invalid
        headers, merges = sheet.get("headers", []), sheet.get("merges", [])
        dims = sheet.get("dims") or {}
        if not isinstance(headers, (list, tuple)) or not isinstance(merges, (list, tuple)):
            raise invalid
        if not isinstance(dims, dict) or not all(
            isinstance(t, str) for t in (*headers, *merges)
        ):
            raise invalid
        sheets.append(
            {
                "name": sheet["name"],
                "name_norm": norm(sheet["name"]),
                "ordinal": n,
                "visibility": str(sheet.get("visibility") or "visible"),
                "dims": {k: dims.get(k) for k in ("rows", "cols")},
                # 정렬 뒤 절단하므로 같은 입력에는 항상 같은 bounded 목록이 나온다.
                "headers": sorted(set(headers))[:SIGNATURE_TERMS],
                "merges": sorted(set(merges))[:SIGNATURE_TERMS],
            }
        )
    return {
        "algorithm": ALGORITHM,
        "window": {"rows": SIGNATURE_ROWS, "cols": SIGNATURE_COLS},
        "sheets": sheets,
    }


def store_signature(
    service, version_id, principal, checkpoint=lambda **kw: None, described=None
):
    """구조 서명을 계산해 캐시한다.

    `described`는 같은 등록 절차의 `describe` 응답이다. 그 안의 `capabilities`(제공자 authorize(extract) 결과)와
    `signature`가 있으면 별도의 authorize/signature Reader 호출 없이 재사용한다. 없으면 기존 경로로 호출한다.
    """
    with service.db.connect() as conn:
        cached = conn.execute(
            "SELECT algorithm FROM version_signature WHERE document_version_id=?",
            (version_id,),
        ).fetchone()
    if cached and cached["algorithm"] == ALGORITHM:
        return {"status": "ready", "cached": True, "algorithm": ALGORITHM}
    described = described if isinstance(described, dict) else {}
    caps = described.get("capabilities")
    if isinstance(caps, dict):
        version = service.version(version_id)
        service.grant(version, principal, caps, "extract")
    else:
        version, _ = service.authorize(version_id, principal, "extract", checkpoint)
    if not version.get("provider_version_token"):
        raise Problem(
            "VERSION_REQUIRED",
            "제공자가 고정 원본 버전을 지원해야 구조 서명을 계산할 수 있습니다.",
        )
    raw = described.get("signature")
    if not (isinstance(raw, dict) and isinstance(raw.get("sheets"), list)):
        with service.db.connect() as conn:
            sheets = [
                dict(r)
                for r in conn.execute(
                    "SELECT sheet_id,name,ordinal,visibility,estimated_rows,estimated_cols FROM sheet WHERE document_version_id=? ORDER BY ordinal",
                    (version_id,),
                )
            ]
        try:
            raw = service.read(
                version["provider"],
                principal,
                "signature",
                {
                    "source_ref": version["source_ref"],
                    "expected_token": version["provider_version_token"],
                    "rows": SIGNATURE_ROWS,
                    "cols": SIGNATURE_COLS,
                },
                checkpoint,
            )
        except Problem as exc:
            if exc.code != "READER_FAILED":
                raise
            raw = _fallback_signature(service, version, sheets, principal, checkpoint)
    signature = _normalize(raw, version)
    computed = now()
    sha = digest(signature)
    with service.db.connect(write=True) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO version_signature(document_version_id,algorithm,signature_json,signature_sha256,reader_revision,computed_at) VALUES (?,?,?,?,?,?)",
            (version_id, ALGORITHM, dump(signature), sha, _reader_revision(), computed),
        )
    return {
        "status": "ready",
        "cached": False,
        "sheets": len(signature["sheets"]),
        "algorithm": ALGORITHM,
        "signature_sha256": sha,
        "computed_at": computed,
    }


def _jaccard(a, b):
    if not a and not b:
        return None
    return len(a & b) / len(a | b)


def _preview(values):
    return sorted(values)[:LIST_PREVIEW]


def similarity(target, source):
    t_names = {s["name_norm"] for s in target["sheets"]}
    s_names = {s["name_norm"] for s in source["sheets"]}
    t_headers = {h for s in target["sheets"] for h in s["headers"]}
    s_headers = {h for s in source["sheets"] for h in s["headers"]}
    t_merges = {(s["name_norm"], m) for s in target["sheets"] for m in s["merges"]}
    s_merges = {(s["name_norm"], m) for s in source["sheets"] for m in s["merges"]}
    scores = {
        "sheet_names": _jaccard(t_names, s_names),
        "headers": _jaccard(t_headers, s_headers),
        "merges": _jaccard(t_merges, s_merges),
    }
    breakdown = {
        "sheet_names": {
            "score": scores["sheet_names"],
            "weight": WEIGHTS["sheet_names"],
            "shared": _preview(t_names & s_names),
            "only_target": _preview(t_names - s_names),
            "only_source": _preview(s_names - t_names),
        },
        # 헤더·병합 성분은 개수만 돌려준다. 다른 문서의 셀 문자열은 응답에 싣지 않는다.
        "headers": {
            "score": scores["headers"],
            "weight": WEIGHTS["headers"],
            "shared_count": len(t_headers & s_headers),
            "target_count": len(t_headers),
            "source_count": len(s_headers),
        },
        "merges": (
            {
                "score": scores["merges"],
                "weight": WEIGHTS["merges"],
                "shared_count": len(t_merges & s_merges),
                "target_count": len(t_merges),
                "source_count": len(s_merges),
            }
            if scores["merges"] is not None
            else None
        ),
    }
    # 양쪽 모두 비어 있는 성분은 정보가 없으므로 제외하고 가중치를 재정규화한다.
    weighted = [(WEIGHTS[k], v) for k, v in scores.items() if v is not None]
    total = sum(w for w, _ in weighted)
    score = round(sum(w * v for w, v in weighted) / total, 4) if total else 0.0
    return score, breakdown


def match_sheets(conn, source_application_id, target_version_id):
    sources = [
        dict(r)
        for r in conn.execute(
            "SELECT a.role_key,a.ordinal,a.sheet_id,s.name FROM application_sheet a JOIN sheet s USING(sheet_id) WHERE a.application_id=? ORDER BY a.role_key,a.ordinal",
            (source_application_id,),
        )
    ]
    by_norm = {}
    for row in conn.execute(
        "SELECT sheet_id,name FROM sheet WHERE document_version_id=?",
        (target_version_id,),
    ):
        by_norm.setdefault(norm(row["name"]), []).append(
            (row["sheet_id"], row["name"])
        )
    matched, unmatched = [], set()
    for row in sources:
        # 정규화 이름이 둘 이상에 겹치면 동일성을 단정하지 않고 미매칭으로 둔다.
        hits = by_norm.get(norm(row["name"]), [])
        target = hits[0] if len(hits) == 1 else None
        if target is None:
            unmatched.add(row["role_key"])
        matched.append(
            {
                "role": row["role_key"],
                "ordinal": row["ordinal"],
                "source_sheet": row["name"],
                "source_sheet_id": row["sheet_id"],
                "target_sheet": target[1] if target else None,
                "target_sheet_id": target[0] if target else None,
            }
        )
    return matched, sorted(unmatched)


def _signature_row(conn, version_id):
    row = conn.execute(
        "SELECT signature_json FROM version_signature WHERE document_version_id=? AND algorithm=?",
        (version_id, ALGORITHM),
    ).fetchone()
    return json.loads(row["signature_json"]) if row else None


def list_suggestions(service, version_id, threshold, limit):
    limit = max(1, min(int(limit), 100))
    with service.db.connect() as conn:
        one(
            conn,
            "SELECT document_version_id FROM document_version WHERE document_version_id=?",
            (version_id,),
        )
        target = _signature_row(conn, version_id)
        base = {
            "items": [],
            "has_more": False,
            "next_cursor": None,
            "threshold": threshold,
            "candidates": 0,
            "unsigned_candidates": 0,
        }
        if target is None:
            return {**base, "signature_status": "missing"}
        candidates = [
            dict(r)
            for r in conn.execute(
                """SELECT a.application_id,a.document_version_id AS source_version_id,a.template_version_id,a.created_at,
                          d.document_id AS source_document_id,d.display_name AS source_document_name,v.revision_no AS source_revision_no,
                          t.template_id,t.name AS template_name,tv.revision_no AS template_revision_no,s.signature_json
                   FROM template_application a
                   JOIN document_version v ON v.document_version_id=a.document_version_id
                   JOIN document d ON d.document_id=v.document_id
                   JOIN template_version tv ON tv.template_version_id=a.template_version_id
                   JOIN template t ON t.template_id=tv.template_id
                   LEFT JOIN version_signature s ON s.document_version_id=a.document_version_id AND s.algorithm=?
                   WHERE a.document_version_id<>?
                   ORDER BY a.created_at DESC,a.application_id LIMIT ?""",
                (ALGORITHM, version_id, CANDIDATE_LIMIT),
            )
        ]
        scored, unsigned = [], 0
        for row in candidates:
            if row["signature_json"] is None:
                unsigned += 1
                continue
            score, breakdown = similarity(target, json.loads(row["signature_json"]))
            if score >= threshold:
                scored.append((score, row, breakdown))
        scored.sort(key=lambda x: (-x[0], x[1]["created_at"], x[1]["application_id"]))
        items = []
        for score, row, breakdown in scored[:limit]:
            matched, unmatched = match_sheets(
                conn, row["application_id"], version_id
            )
            approved = conn.execute(
                "SELECT count(*) FROM mapping_head WHERE application_id=?",
                (row["application_id"],),
            ).fetchone()[0]
            total = conn.execute(
                "SELECT count(*) FROM template_rule WHERE template_version_id=?",
                (row["template_version_id"],),
            ).fetchone()[0]
            items.append(
                {
                    "score": score,
                    "breakdown": breakdown,
                    "source_application_id": row["application_id"],
                    "source_document_id": row["source_document_id"],
                    "source_document_name": row["source_document_name"],
                    "source_version_id": row["source_version_id"],
                    "source_revision_no": row["source_revision_no"],
                    "template_id": row["template_id"],
                    "template_version_id": row["template_version_id"],
                    "template_name": row["template_name"],
                    "template_revision_no": row["template_revision_no"],
                    "approved_rules": approved,
                    "total_rules": total,
                    "matched_sheets": matched,
                    "unmatched_roles": unmatched,
                }
            )
    return {
        **base,
        "items": items,
        "has_more": len(scored) > limit,
        "signature_status": "ready",
        "candidates": len(candidates),
        "unsigned_candidates": unsigned,
    }


def transplant(service, version_id, body, principal):
    invalid = Problem(
        "INVALID_SHEET_BINDING", "현재 문서 버전의 시트를 역할별로 선택하세요."
    )
    with service.db.connect(write=True) as conn:
        one(
            conn,
            "SELECT document_version_id FROM document_version WHERE document_version_id=?",
            (version_id,),
        )
        source = one(
            conn,
            "SELECT a.*,tv.definition_json,tv.kg_revision_id FROM template_application a JOIN template_version tv USING(template_version_id) WHERE a.application_id=?",
            (body["source_application_id"],),
        )
        if source["document_version_id"] == version_id:
            raise Problem(
                "SAME_VERSION", "같은 문서 버전의 적용 건은 이식할 수 없습니다.", 409
            )
        roles = json.loads(source["definition_json"])["sheet_roles"]
        matched, _ = match_sheets(conn, source["application_id"], version_id)
        sheets = {
            r["sheet_id"]: dict(r)
            for r in conn.execute(
                "SELECT sheet_id,name FROM sheet WHERE document_version_id=?",
                (version_id,),
            )
        }
        overrides = {}
        for role, ids in (body.get("sheet_bindings") or {}).items():
            overrides[role] = [ids] if isinstance(ids, str) else list(ids or [])
        bindings, unmatched = {}, []
        for role in roles:
            entries = sorted(
                (m for m in matched if m["role"] == role), key=lambda m: m["ordinal"]
            )
            if role in overrides:
                ids = overrides[role]
                if (
                    not ids
                    or len(ids) != len(set(ids))
                    or any(not isinstance(i, str) or i not in sheets for i in ids)
                ):
                    raise invalid
            else:
                ids = [m["target_sheet_id"] for m in entries if m["target_sheet_id"]]
                if not entries or len(ids) != len(entries):
                    names = "/".join(m["source_sheet"] for m in entries) or "-"
                    unmatched.append(f"{role}({names})")
            bindings[role] = ids
        if unmatched:
            raise Problem(
                "SHEET_UNMATCHED",
                "다음 시트 역할에 맞는 시트를 찾지 못했습니다: "
                + ", ".join(unmatched)
                + ". sheet_bindings로 직접 지정하세요.",
                409,
            )
        for role, ids in bindings.items():
            if roles[role].get("cardinality", "one") == "one" and len(ids) != 1:
                raise Problem(
                    "INVALID_SHEET_BINDING", "이 시트 역할에는 한 시트만 연결할 수 있습니다."
                )
        rules = [
            dict(r)
            for r in conn.execute(
                "SELECT rule_key,ordinal FROM template_rule WHERE template_version_id=? ORDER BY ordinal",
                (source["template_version_id"],),
            )
        ]
        chosen = []
        for rule in rules:
            head = conn.execute(
                "SELECT mapping_revision_id FROM mapping_head WHERE application_id=? AND rule_key=?",
                (source["application_id"], rule["rule_key"]),
            ).fetchone()
            # head가 없으면 검수자가 거절하지 않은 최신 리비전을 쓴다. 거절된 명세는 후보로 되살리지 않는다.
            revision = conn.execute(
                "SELECT * FROM mapping_revision WHERE application_id=? AND rule_key=? AND mapping_revision_id=coalesce(?,(SELECT x.mapping_revision_id FROM mapping_revision x WHERE x.application_id=? AND x.rule_key=? AND x.status<>'rejected' ORDER BY x.revision_no DESC LIMIT 1))",
                (
                    source["application_id"],
                    rule["rule_key"],
                    head["mapping_revision_id"] if head else None,
                    source["application_id"],
                    rule["rule_key"],
                ),
            ).fetchone()
            if revision is None:
                if conn.execute(
                    "SELECT 1 FROM mapping_revision WHERE application_id=? AND rule_key=?",
                    (source["application_id"], rule["rule_key"]),
                ).fetchone():
                    raise Problem(
                        "SOURCE_REJECTED",
                        f"원본 적용 건의 규칙 {rule['rule_key']}은(는) 거절된 리비전만 있어 이식할 수 없습니다.",
                        409,
                    )
                raise Problem(
                    "SOURCE_INCOMPLETE", "원본 적용 건에 모든 규칙의 매핑이 없습니다.", 409
                )
            chosen.append((dict(revision), bool(head)))
        target_sig = _signature_row(conn, version_id)
        source_sig = _signature_row(conn, source["document_version_id"])
        sim = None
        if target_sig and source_sig:
            score, breakdown = similarity(target_sig, source_sig)
            sim = {"score": score, "breakdown": breakdown}
        app_id = uid()
        insert(
            conn,
            "template_application",
            application_id=app_id,
            document_version_id=version_id,
            template_version_id=source["template_version_id"],
            scope_key=body.get("name") or app_id,
            created_at=now(),
        )
        for role, ids in bindings.items():
            for n, sid in enumerate(ids):
                insert(
                    conn,
                    "application_sheet",
                    application_id=app_id,
                    document_version_id=version_id,
                    role_key=role,
                    ordinal=n,
                    sheet_id=sid,
                )
        for row, was_head in chosen:
            effective = copy.deepcopy(json.loads(row["effective_spec_json"]))
            validate_rule(effective, roles)
            concept_id, dropped = row["concept_id"], False
            if concept_id and not conn.execute(
                "SELECT 1 FROM domain_concept WHERE kg_revision_id=? AND concept_id=? AND status='active'",
                (source["kg_revision_id"], concept_id),
            ).fetchone():
                concept_id, dropped = None, True
            effective["concept_id"] = concept_id
            insert(
                conn,
                "mapping_revision",
                mapping_revision_id=uid(),
                application_id=app_id,
                document_version_id=version_id,
                template_version_id=source["template_version_id"],
                rule_key=row["rule_key"],
                revision_no=1,
                kg_revision_id=source["kg_revision_id"],
                concept_id=concept_id,
                origin="candidate",
                # 규칙 §4.10: 이식한 매핑은 검수 대기이며 head를 만들지 않는다.
                status="proposed",
                effective_spec_json=dump(effective),
                evidence_json=dump(
                    {
                        "transplanted_from": {
                            "application_id": source["application_id"],
                            "mapping_revision_id": row["mapping_revision_id"],
                            "revision_no": row["revision_no"],
                            "status": row["status"],
                            "document_version_id": source["document_version_id"],
                            "was_head": was_head,
                        },
                        "similarity": sim,
                        "concept_dropped": dropped,
                    }
                ),
                created_by=principal,
                reason=(
                    f"문서군 제안에서 이식 · 원본 적용 {source['application_id']}"
                    f" · 리비전 {row['revision_no']} ({row['status']})"
                ),
                created_at=now(),
            )
    return {
        "application_id": app_id,
        "template_version_id": source["template_version_id"],
        "bindings": bindings,
        "rules": len(chosen),
        "status": "proposed",
    }


def sign_versions(service, version_id, principal):
    if version_id:
        targets = [version_id]
    else:
        # 현재 버전과, 제안 후보가 되는 템플릿 적용 버전(이전 버전 포함) 중 현재 알고리즘 서명이 없는 것을 모두 계산한다.
        with service.db.connect() as conn:
            targets = [
                r[0]
                for r in conn.execute(
                    """SELECT v.document_version_id FROM document_version v JOIN document d USING(document_id)
                       WHERE (d.current_version_id=v.document_version_id
                              OR EXISTS (SELECT 1 FROM template_application a WHERE a.document_version_id=v.document_version_id))
                         AND NOT EXISTS (SELECT 1 FROM version_signature s WHERE s.document_version_id=v.document_version_id AND s.algorithm=?)
                       ORDER BY d.display_name,v.revision_no,v.document_version_id""",
                    (ALGORITHM,),
                )
            ]
    for vid in targets:
        try:
            yield f"{vid} {store_signature(service, vid, principal)['status']}"
        except Problem as exc:
            yield f"{vid} failed {exc.code}"
