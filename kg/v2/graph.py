"""KG 리비전 하나의 개념 트리와 현재 발행 출처 수. 문서 ID는 노출하지 않고 개수만 돌려준다."""

from __future__ import annotations

import hashlib

from pydantic import BaseModel

from .db import decode_cursor, norm, one, page

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


# ---- 이웃 탐색 그래프 (codex/v2-kg-coverage): 유한 부분 그래프 + 문서 버전별 검수 커버리지 ----

class Coverage(BaseModel):
    proposed: int = 0
    approved: int = 0
    rejected: int = 0
    published_series: int = 0


class GraphNode(BaseModel):
    concept_id: str
    name: str
    level: int
    status: str
    canonical_unit: str | None
    coverage: Coverage | None = None


class GraphEdge(BaseModel):
    from_concept_id: str
    to_concept_id: str
    relation_type: str


class CoverageVersion(BaseModel):
    document_id: str
    document_version_id: str
    filename: str
    revision_no: int
    is_current: bool


class GraphPage(BaseModel):
    items: list[GraphNode]
    focus: GraphNode | None
    edges: list[GraphEdge]
    edges_truncated: bool
    coverage_version: CoverageVersion | None
    has_more: bool
    next_cursor: str | None


NODE_COLUMNS = "c.concept_id,c.name,c.level,c.status,c.canonical_unit"


def graph_page(service, kg, focus, query, version, cursor, limit):
    scope = ["graph", kg, focus, query, version]
    after = decode_cursor(cursor, scope, 2)
    with service.db.connect() as conn:
        # 노드·관계·상태를 동일한 읽기 스냅샷에서 가져온다.
        conn.execute("BEGIN")
        one(
            conn, "SELECT kg_revision_id FROM kg_revision WHERE kg_revision_id=?", (kg,)
        )
        center = (
            one(
                conn,
                f"SELECT {NODE_COLUMNS} FROM domain_concept c WHERE kg_revision_id=? AND concept_id=?",
                (kg, focus),
            )
            if focus
            else None
        )
        sql = f"SELECT {NODE_COLUMNS} FROM domain_concept c WHERE c.kg_revision_id=?"
        params = [kg]
        if focus:
            # 한 단계 이웃만 조회한다. 다부모/순환 관계도 전체 그래프 순회 없이 처리한다.
            sql += """ AND c.concept_id<>? AND (EXISTS(
                SELECT 1 FROM domain_edge e WHERE e.kg_revision_id=c.kg_revision_id
                AND e.from_concept_id=? AND e.to_concept_id=c.concept_id) OR EXISTS(
                SELECT 1 FROM domain_edge e WHERE e.kg_revision_id=c.kg_revision_id
                AND e.to_concept_id=? AND e.from_concept_id=c.concept_id))"""
            params.extend([focus, focus, focus])
        if query:
            sql += """ AND (c.name LIKE ? OR c.concept_id LIKE ? OR EXISTS(
                SELECT 1 FROM domain_alias a WHERE a.kg_revision_id=c.kg_revision_id
                AND a.concept_id=c.concept_id AND a.alias_norm LIKE ?))"""
            params.extend(
                ["%" + query + "%", "%" + query + "%", "%" + norm(query) + "%"]
            )
        if after:
            sql += " AND (c.level,c.concept_id)>(?,?)"
            params.extend(after)
        sql += " ORDER BY c.level,c.concept_id LIMIT ?"
        result = page(
            conn.execute(sql, (*params, limit + 1)),
            limit,
            ["level", "concept_id"],
            scope,
        )
        nodes = result["items"] + ([center] if center else [])
        ids = [n["concept_id"] for n in nodes]
        placeholders = ",".join("?" for _ in ids) or "NULL"
        edges = [
            dict(r)
            for r in conn.execute(
                f"""SELECT from_concept_id,to_concept_id,relation_type FROM domain_edge
                WHERE kg_revision_id=? AND from_concept_id IN ({placeholders})
                AND to_concept_id IN ({placeholders})
                ORDER BY CASE WHEN from_concept_id=? OR to_concept_id=? THEN 0 ELSE 1 END,
                    from_concept_id,to_concept_id,relation_type LIMIT 121""",
                (kg, *ids, *ids, focus, focus),
            )
        ]
        selected_version = None
        counts = {}
        if version:
            selected_version = one(
                conn,
                """SELECT v.document_id,v.document_version_id,v.filename,v.revision_no,
                    d.current_version_id=v.document_version_id is_current
                    FROM document_version v JOIN document d USING(document_id)
                    WHERE v.document_version_id=?""",
                (version,),
            )
            # 규칙별 최신 검수 한 건만 집계한다. 과거 추출이나 여러 item으로 규칙 수를 부풀리지 않는다.
            counts = {
                r["concept_id"]: dict(r)
                for r in conn.execute(
                    f"""WITH latest AS (
                    SELECT m.concept_id,m.status,m.mapping_revision_id,a.published_run_id
                    FROM template_application a JOIN mapping_revision m USING(application_id)
                    WHERE a.document_version_id=? AND m.kg_revision_id=?
                    AND m.concept_id IN ({placeholders})
                    AND m.revision_no=(SELECT max(x.revision_no) FROM mapping_revision x
                        WHERE x.application_id=m.application_id AND x.rule_key=m.rule_key)
                ) SELECT m.concept_id,
                    count(DISTINCT CASE WHEN m.status='proposed' THEN m.mapping_revision_id END) proposed,
                    count(DISTINCT CASE WHEN m.status='approved' THEN m.mapping_revision_id END) approved,
                    count(DISTINCT CASE WHEN m.status='rejected' THEN m.mapping_revision_id END) rejected,
                    count(s.series_id) published_series
                    FROM latest m LEFT JOIN extracted_series s
                    ON s.mapping_revision_id=m.mapping_revision_id AND s.run_id=m.published_run_id
                    AND s.status='ready'
                    GROUP BY m.concept_id""",
                    (version, kg, *ids),
                )
            }
        for node in nodes:
            node["coverage"] = (
                {
                    k: counts.get(node["concept_id"], {}).get(k, 0)
                    for k in ("proposed", "approved", "rejected", "published_series")
                }
                if version
                else None
            )
        return {
            **result,
            "focus": center,
            "edges": edges[:120],
            "edges_truncated": len(edges) > 120,
            "coverage_version": selected_version,
        }
