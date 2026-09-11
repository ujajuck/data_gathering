"""KG 리비전 하나의 개념 트리와 현재 발행 출처 수. 문서 ID는 노출하지 않고 개수만 돌려준다."""

from __future__ import annotations

import hashlib

from .db import one

NODE_CAP = 2000

NODES = """SELECT c.concept_id,c.name,c.level FROM domain_concept c
           WHERE c.kg_revision_id=? AND c.status='active' ORDER BY c.level,c.concept_id LIMIT ?"""
EDGES = """SELECT e.from_concept_id,e.to_concept_id FROM domain_edge e
           JOIN domain_concept p ON p.kg_revision_id=e.kg_revision_id AND p.concept_id=e.from_concept_id AND p.status='active'
           JOIN domain_concept k ON k.kg_revision_id=e.kg_revision_id AND k.concept_id=e.to_concept_id AND k.status='active'
           WHERE e.kg_revision_id=? AND e.relation_type='parent_of' ORDER BY e.to_concept_id,e.from_concept_id"""
# 현재 문서 버전의 발행된 성공 실행만 센다. 이 KG 리비전에 고정된 매핑만 포함한다(GET /series와 같은 의미).
COVERAGE = """SELECT m.concept_id,d.document_id,count(*) n FROM document d
              JOIN template_application a ON a.document_version_id=d.current_version_id AND a.published_run_id IS NOT NULL
              JOIN extraction_run r ON r.run_id=a.published_run_id AND r.status='succeeded'
              JOIN extracted_series s ON s.run_id=r.run_id AND s.document_version_id=d.current_version_id
              JOIN mapping_revision m ON m.mapping_revision_id=s.mapping_revision_id AND m.application_id=a.application_id
              WHERE m.kg_revision_id=? AND m.concept_id IS NOT NULL GROUP BY m.concept_id,d.document_id"""
# 발행 상태가 바뀌지 않았으면 같은 응답을 재사용한다. 커버리지는 (KG 리비전, 문서의 현재 버전, 적용 건의 발행 실행)의
# 함수이고 실행·series·매핑은 불변이므로 이 두 목록의 해시가 정확한 무효화 서명이다.
SNAPSHOT_DOCUMENTS = "SELECT document_id,current_version_id FROM document ORDER BY document_id"
SNAPSHOT_PUBLISHED = """SELECT application_id,published_run_id FROM template_application
                        WHERE published_run_id IS NOT NULL ORDER BY application_id"""
CACHE_LIMIT = 16
_cache: dict = {}


def _cache_key(conn, kg, cap):
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    return (path, kg, cap)


def coverage_graph(conn, kg, domain, cap=NODE_CAP):
    one(conn, "SELECT kg_revision_id FROM kg_revision WHERE kg_revision_id=?", (kg,))
    key = _cache_key(conn, kg, cap)
    digest = hashlib.sha256()
    for sql in (SNAPSHOT_DOCUMENTS, SNAPSHOT_PUBLISHED):
        for row in conn.execute(sql):
            digest.update(f"{row[0]}={row[1]};".encode())
    stamp = digest.hexdigest()
    hit = _cache.get(key)
    if hit and hit[0] == stamp:
        return {**hit[1], "domain": domain}
    result = _build_graph(conn, kg, cap)
    if len(_cache) >= CACHE_LIMIT:
        _cache.pop(next(iter(_cache)))
    _cache[key] = (stamp, result)
    return {**result, "domain": domain}


def _build_graph(conn, kg, cap):
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
        "nodes": nodes,
        "groups": groups,
        "edges": edges,
        "truncated": truncated,
        "node_cap": cap,
    }
