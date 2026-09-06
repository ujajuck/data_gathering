"""Domain Search — KG 노드 기준 역방향 탐색 (§8.1 Reverse Lookup).

Domain Concept 하나를 고르면 semantic_mapping을 역방향으로 조회해 연결된
모든 Tree Node를 찾고 Document/Sheet/Locator/행수까지 추적한다. 이 결과가
Integration의 Source 후보 목록이 된다 (§9.1).
"""
from __future__ import annotations

import json

from kg.store import KgStore

_USABLE = ("AUTO_APPROVED", "APPROVED")


def reverse_lookup(store: KgStore, concept_id: str,
                   include_review: bool = False) -> dict:
    concept = store.concept(concept_id)
    if concept is None:
        raise KeyError(f"unknown concept: {concept_id}")
    statuses = _USABLE + (("REVIEW_REQUIRED",) if include_review else ())
    rows = store.conn.execute(
        f"""SELECT m.mapping_id, m.confidence, m.status, n.node_id, n.node_name,
                   n.tree_path, n.locator, n.unit, n.data_type, d.filename,
                   p.payload_id, p.row_count
            FROM semantic_mapping m
            JOIN tree_node n ON n.node_id = m.tree_node_id
            JOIN document d ON d.document_id = n.document_id
            LEFT JOIN data_payload p ON p.tree_node_id = n.node_id AND p.is_current=1
            WHERE m.concept_id=? AND m.is_active=1 AND n.status='ACTIVE'
              AND m.status IN ({','.join('?' * len(statuses))})
            ORDER BY d.filename, n.tree_path""",
        (concept_id, *statuses)).fetchall()
    sources = [{
        "document": r["filename"], "sheet": (r["tree_path"].split("/") + [""])[1],
        "header": r["node_name"], "tree_path": r["tree_path"],
        "locator": r["locator"], "unit": r["unit"], "data_type": r["data_type"],
        "rows": r["row_count"] or 0, "mapping": round(r["confidence"], 2),
        "status": r["status"], "node_id": r["node_id"], "payload_id": r["payload_id"],
    } for r in rows]
    return {"concept": dict(concept), "sources": sources,
            "documents": sorted({s["document"] for s in sources}),
            "total_rows": sum(s["rows"] for s in sources)}


def concept_neighbors(store: KgStore, concept_id: str) -> list[dict]:
    """개념의 그래프 이웃 (IS_A/AFFECTS/… 관계) — 탐색 UI/추천용."""
    rows = store.conn.execute(
        """SELECT r.relation_type, r.source_concept_id, r.target_concept_id,
                  cs.canonical_name AS source_name, ct.canonical_name AS target_name
           FROM domain_relation r
           JOIN domain_concept cs ON cs.concept_id = r.source_concept_id
           JOIN domain_concept ct ON ct.concept_id = r.target_concept_id
           WHERE r.source_concept_id=? OR r.target_concept_id=?""",
        (concept_id, concept_id)).fetchall()
    return [dict(r) for r in rows]


def lineage_of(store: KgStore, build_id: str, row_id: int, field: str) -> dict:
    """§11 계보: Custom DB 값 → 변환 → 원본 셀 → 헤더 → 시트 → 문서 → 버전."""
    edge = store.conn.execute(
        """SELECT * FROM lineage_edge
           WHERE build_id=? AND output_row_id=? AND output_field=?""",
        (build_id, row_id, field)).fetchone()
    if edge is None:
        raise KeyError(f"no lineage for {build_id}/{row_id}/{field}")
    chain: dict = {"build_id": build_id, "output_row_id": row_id,
                   "output_field": field,
                   "transform_path": json.loads(edge["transform_path"] or "[]")}
    if edge["payload_id"] and edge["row_idx"] is not None:
        pv = store.conn.execute(
            "SELECT * FROM payload_value WHERE payload_id=? AND row_idx=?",
            (edge["payload_id"], edge["row_idx"])).fetchone()
        if pv:
            chain["source_value"] = pv["value_num"] if pv["value_num"] is not None \
                else pv["value_text"]
            chain["source_cell"] = pv["cell_address"]
    node = store.node(edge["tree_node_id"]) if edge["tree_node_id"] else None
    if node is not None:
        parts = (node["tree_path"] or "").split("/")
        ver = store.conn.execute(
            """SELECT p.version_id FROM data_payload p WHERE p.payload_id=?""",
            (edge["payload_id"],)).fetchone() if edge["payload_id"] else None
        doc = store.conn.execute(
            "SELECT filename FROM document WHERE document_id=?",
            (node["document_id"],)).fetchone()
        chain.update({
            "header": node["node_name"], "tree_path": node["tree_path"],
            "sheet": parts[1] if len(parts) > 1 else "",
            "document": doc["filename"] if doc else node["document_id"],
            "document_version": ver["version_id"] if ver else None,
        })
    return chain
