"""KG 리비전 하나의 개념 트리와 현재 발행 출처 수. 문서 ID는 노출하지 않고 개수만 돌려준다."""

from __future__ import annotations

from .db import one

NODE_CAP = 2000

NODES = """SELECT c.concept_id,c.name,c.level FROM domain_concept c
           WHERE c.kg_revision_id=? AND c.status='active' ORDER BY c.level,c.concept_id LIMIT ?"""
EDGES = """SELECT e.from_concept_id,e.to_concept_id FROM domain_edge e
           JOIN domain_concept p ON p.kg_revision_id=e.kg_revision_id AND p.concept_id=e.from_concept_id AND p.status='active'
           JOIN domain_concept k ON k.kg_revision_id=e.kg_revision_id AND k.concept_id=e.to_concept_id AND k.status='active'
           WHERE e.kg_revision_id=? AND e.relation_type='parent_of' ORDER BY e.to_concept_id,e.from_concept_id"""
# 현재 문서 버전의 발행된 성공 실행만 센다. 이 KG 리비전에 고정된 매핑만 포함한다(GET /series와 같은 의미).
COVERAGE = """SELECT m.concept_id,d.document_id,count(*) n FROM extracted_series s
              JOIN extraction_run r ON r.run_id=s.run_id AND r.status='succeeded'
              JOIN mapping_revision m ON m.mapping_revision_id=s.mapping_revision_id
              JOIN template_application a ON a.application_id=m.application_id AND a.published_run_id=s.run_id
              JOIN document_version v ON v.document_version_id=s.document_version_id
              JOIN document d ON d.document_id=v.document_id AND d.current_version_id=v.document_version_id
              WHERE m.kg_revision_id=? AND m.concept_id IS NOT NULL GROUP BY m.concept_id,d.document_id"""


def coverage_graph(conn, kg, domain, cap=NODE_CAP):
    one(conn, "SELECT kg_revision_id FROM kg_revision WHERE kg_revision_id=?", (kg,))
    rows = [dict(r) for r in conn.execute(NODES, (kg, cap + 1))]
    truncated = len(rows) > cap
    rows = rows[:cap]
    level = {r["concept_id"]: r["level"] for r in rows}
    edges = [
        dict(e)
        for e in conn.execute(EDGES, (kg,))
        if e["from_concept_id"] in level and e["to_concept_id"] in level
    ]
    parents = {}
    for e in edges:
        # 다부모 허용: level-1 부모 중 concept_id 오름차순 첫 번째를 화면 부모로 쓴다(ORDER BY가 보장).
        if level[e["from_concept_id"]] == level[e["to_concept_id"]] - 1:
            parents.setdefault(e["to_concept_id"], e["from_concept_id"])

    def root_of(cid):
        seen = set()
        while level.get(cid) != 1 and cid in parents and cid not in seen:
            seen.add(cid)
            cid = parents[cid]
        return cid if level.get(cid) == 1 else None

    roots = {c: root_of(c) for c in level}
    sources, documents = {}, {}
    for c in conn.execute(COVERAGE, (kg,)):
        sources[c["concept_id"]] = sources.get(c["concept_id"], 0) + c["n"]
        root = roots.get(c["concept_id"])
        if root:
            documents.setdefault(root, set()).add(c["document_id"])
    nodes = [
        {
            **r,
            "parent": parents.get(r["concept_id"]),
            "root": roots[r["concept_id"]],
            "sources": sources.get(r["concept_id"], 0),
        }
        for r in rows
    ]
    groups = sorted(
        (
            {
                "root_concept_id": r["concept_id"],
                "name": r["name"],
                "member_document_count": len(documents.get(r["concept_id"], ())),
            }
            for r in rows
            if r["level"] == 1
        ),
        key=lambda g: (-g["member_document_count"], g["name"], g["root_concept_id"]),
    )
    return {
        "domain": domain,
        "nodes": nodes,
        "groups": groups,
        "edges": edges,
        "truncated": truncated,
        "node_cap": cap,
    }
