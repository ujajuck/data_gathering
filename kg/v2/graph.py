"""고정 KG의 유한 부분 그래프와 문서 버전별 커버리지. 원본 셀은 읽지 않는다."""

from __future__ import annotations

from pydantic import BaseModel

from .db import decode_cursor, norm, one, page


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
