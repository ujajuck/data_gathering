"""v2 SQLite의 KG 리비전 하나를 Apache AGE 그래프로 투영하는 멱등 SQL 스크립트를 만든다.

서비스 ID(kg_revision_id, concept_id)를 그래프 속성으로 유지하고 AGE 내부 id는 FK로 쓰지 않는다
(docs/design/db-schema-v2.md §10). 생성된 스크립트는 pglast 구문 검증만 거쳤고 실제 AGE에서 실행 검증하지 않았다.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .db import Database, Problem, now, one

GRAPH_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
LABEL = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DOLLAR_TAGS = ("$cy$", "$v2age$")
VERTEX_LABEL = "domain_concept"


def resolve_revision(conn, selector: str) -> dict:
    selector = str(selector or "current")
    if selector == "current":
        # 리비전 번호는 단조 증가하므로 최대 revision_no가 현재 KG다.
        sql, params = "SELECT * FROM kg_revision ORDER BY revision_no DESC LIMIT 1", ()
    elif selector.isdigit():
        sql, params = "SELECT * FROM kg_revision WHERE revision_no=?", (int(selector),)
    else:
        sql, params = "SELECT * FROM kg_revision WHERE kg_revision_id=?", (selector,)
    try:
        return one(conn, sql, params)
    except Problem:
        raise Problem("NOT_FOUND", "요청한 KG 리비전을 찾을 수 없습니다.", 404) from None


def cypher_text(value) -> str:
    text = "" if value is None else str(value)
    out = []
    for ch in text:
        if ch == "\\":
            out.append("\\\\")
        elif ch == "'":
            out.append("\\'")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ch == "\x7f":
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    literal = "'" + "".join(out) + "'"
    if any(tag in literal for tag in DOLLAR_TAGS):
        raise Problem("AGE_UNSAFE_TEXT", "달러 인용 태그를 포함한 이름은 투영할 수 없습니다.")
    return literal


def edge_label(relation_type: str) -> str:
    if LABEL.match(relation_type):
        return relation_type
    return "rel_" + hashlib.sha256(relation_type.encode()).hexdigest()[:12]


def _cypher(graph: str, body: str) -> str:
    return f"SELECT * FROM cypher('{graph}', $cy$\n{body}\n$cy$) AS (v agtype);\n"


def projection_script(conn, revision: dict, graph: str | None = None) -> str:
    return build_projection(conn, revision, graph)["script"]


def build_projection(conn, revision: dict, graph: str | None = None) -> dict:
    graph = graph or f"v2_kg_r{revision['revision_no']}"
    if not GRAPH_NAME.match(graph):
        raise Problem(
            "INVALID_GRAPH_NAME",
            "그래프 이름은 소문자/숫자/밑줄로 시작 문자가 영문 또는 밑줄이어야 합니다.",
        )
    rid = revision["kg_revision_id"]
    concepts = conn.execute(
        "SELECT concept_id, name, level, status FROM domain_concept WHERE kg_revision_id=? ORDER BY concept_id",
        (rid,),
    ).fetchall()
    edges = conn.execute(
        "SELECT from_concept_id, to_concept_id, relation_type FROM domain_edge WHERE kg_revision_id=? "
        "ORDER BY from_concept_id, to_concept_id, relation_type",
        (rid,),
    ).fetchall()
    rid_lit = cypher_text(rid)
    parts = [
        "-- data_gathering v2 AGE projection\n",
        f"-- kg_revision_id: {rid}  revision_no: {revision['revision_no']}  "
        f"content_sha256: {revision['content_sha256']}  generated_at: {now()}\n",
        "-- 서비스 ID(kg_revision_id, concept_id)를 그래프 속성으로 유지한다. AGE 내부 id는 FK로 쓰지 않는다.\n",
        "-- 멱등: MERGE는 도메인 PK와 같은 속성으로 정점/엣지를 식별한다. 검증 블록이 실패하면 전체가 롤백된다.\n",
        "LOAD 'age';\n",
        'SET search_path = ag_catalog, "$user", public;\n',
        "BEGIN;\n",
        "DO $v2age$ BEGIN\n"
        f"  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '{graph}') THEN\n"
        f"    PERFORM ag_catalog.create_graph('{graph}');\n"
        "  END IF;\n"
        "END $v2age$;\n",
    ]
    for concept in concepts:
        cid = cypher_text(concept["concept_id"])
        parts.append(
            _cypher(
                graph,
                f"  MERGE (c:{VERTEX_LABEL} {{kg_revision_id: {rid_lit}, concept_id: {cid}}})\n"
                f"  SET c.name = {cypher_text(concept['name'])}, c.level = {int(concept['level'])}, "
                f"c.status = {cypher_text(concept['status'])}\n"
                "  RETURN c",
            )
        )
    for edge in edges:
        src = cypher_text(edge["from_concept_id"])
        dst = cypher_text(edge["to_concept_id"])
        relation = cypher_text(edge["relation_type"])
        label = edge_label(edge["relation_type"])
        parts.append(
            _cypher(
                graph,
                f"  MATCH (a:{VERTEX_LABEL} {{kg_revision_id: {rid_lit}, concept_id: {src}}}),\n"
                f"        (b:{VERTEX_LABEL} {{kg_revision_id: {rid_lit}, concept_id: {dst}}})\n"
                f"  MERGE (a)-[e:{label} {{kg_revision_id: {rid_lit}, from_concept_id: {src}, "
                f"to_concept_id: {dst}, relation_type: {relation}}}]->(b)\n"
                "  RETURN e",
            )
        )
    parts.append(
        "DO $v2age$ DECLARE n bigint; BEGIN\n"
        f"  SELECT count(*) INTO n FROM cypher('{graph}', $cy$ MATCH (c:{VERTEX_LABEL} {{kg_revision_id: {rid_lit}}}) RETURN c $cy$) AS (v agtype);\n"
        f"  IF n <> {len(concepts)} THEN RAISE EXCEPTION 'domain_concept vertex count % <> %', n, {len(concepts)}; END IF;\n"
        f"  SELECT count(*) INTO n FROM cypher('{graph}', $cy$ MATCH (:{VERTEX_LABEL} {{kg_revision_id: {rid_lit}}})-[e]->(:{VERTEX_LABEL}) "
        f"WHERE e.kg_revision_id = {rid_lit} RETURN e $cy$) AS (v agtype);\n"
        f"  IF n <> {len(edges)} THEN RAISE EXCEPTION 'domain_edge count % <> %', n, {len(edges)}; END IF;\n"
        "END $v2age$;\n"
        "COMMIT;\n"
        f"-- domain_concept vertices: {len(concepts)}; domain_edge edges: {len(edges)}\n"
    )
    return {
        "script": "".join(parts),
        "graph": graph,
        "vertices": len(concepts),
        "edges": len(edges),
    }


def write_projection(root, selector: str, out, graph: str | None = None) -> dict:
    db = Database(Path(root))
    with db.connect() as conn:
        revision = resolve_revision(conn, selector)
        built = build_projection(conn, revision, graph)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(built["script"], encoding="utf-8")
    return {
        "kg_revision_id": revision["kg_revision_id"],
        "revision_no": revision["revision_no"],
        "graph": built["graph"],
        "vertices": built["vertices"],
        "edges": built["edges"],
        "out": str(out),
    }
