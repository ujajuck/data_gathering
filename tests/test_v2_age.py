"""AGE projection 스크립트 생성 검증. 실제 Apache AGE는 없으므로 생성 텍스트와 pglast 구문만 검사한다."""

from __future__ import annotations

import hashlib
import json

import pytest

from kg.v2.age_projection import (
    build_projection,
    cypher_text,
    edge_label,
    projection_script,
    resolve_revision,
    write_projection,
)
from kg.v2.db import Problem
from kg.v2.service import Service

DEFINITION = {
    "concepts": [
        {"concept_id": "temperature", "name": "공정온도 'A'", "level": 1},
        {"concept_id": "zone", "name": "back\\slash", "level": 2},
        {"concept_id": "note", "name": "multi\nline", "level": 1, "status": "deprecated"},
    ],
    "relations": [
        ["temperature", "zone", "parent_of"],
        ["temperature", "note", "관련 있음"],
        ["zone", "note", "measured_in"],
    ],
}


@pytest.fixture
def kg(tmp_path):
    service = Service(tmp_path)
    first = service.import_kg(DEFINITION, "tester")
    second = service.import_kg(
        {**DEFINITION, "concepts": DEFINITION["concepts"][:2], "relations": DEFINITION["relations"][:1]},
        "tester",
    )
    return {"service": service, "root": tmp_path, "first": first, "second": second}


def script_for(kg, selector="1", graph=None):
    with kg["service"].db.connect() as conn:
        revision = resolve_revision(conn, selector)
        return revision, projection_script(conn, revision, graph)


def without_generated_at(script):
    return "\n".join(line for line in script.splitlines() if "generated_at:" not in line)


def test_projection_merges_by_service_ids_and_is_deterministic(kg):
    revision, script = script_for(kg)
    rid = revision["kg_revision_id"]
    assert script.count("MERGE (c:domain_concept {kg_revision_id: ") == 3
    assert script.count("MERGE (a)-[e:") == 3
    assert script.count(f"kg_revision_id: '{rid}'") >= 6
    for forbidden in ("id(", "start_id", "end_id"):
        assert forbidden not in script
    assert script.startswith("-- data_gathering v2 AGE projection\n")
    assert "PERFORM ag_catalog.create_graph('v2_kg_r1')" in script
    assert script.rstrip().endswith("-- domain_concept vertices: 3; domain_edge edges: 3")
    _, again = script_for(kg)
    assert without_generated_at(script) == without_generated_at(again)


def test_cypher_escaping(kg):
    _, script = script_for(kg)
    assert "'공정온도 \\'A\\''" in script
    assert "'back\\\\slash'" in script
    assert "'multi\\nline'" in script
    assert "'multi\n" not in script
    assert cypher_text("tab\there") == "'tab\\there'"
    assert cypher_text("bell\x07") == "'bell\\u0007'"
    assert cypher_text(None) == "''"


def test_relation_label_sanitized_and_property_preserved(kg):
    _, script = script_for(kg)
    hashed = "rel_" + hashlib.sha256("관련 있음".encode()).hexdigest()[:12]
    assert edge_label("관련 있음") == hashed
    assert f"[e:{hashed} {{" in script
    assert "relation_type: '관련 있음'" in script
    assert "[e:parent_of {" in script and "[e:measured_in {" in script
    assert "c.level = 2" in script and "c.status = 'deprecated'" in script


def test_revision_selector(kg):
    service = kg["service"]
    with service.db.connect() as conn:
        assert resolve_revision(conn, "current")["revision_no"] == 2
        assert resolve_revision(conn, "1")["kg_revision_id"] == kg["first"]["kg_revision_id"]
        assert resolve_revision(conn, kg["first"]["kg_revision_id"])["revision_no"] == 1
        with pytest.raises(Problem) as missing:
            resolve_revision(conn, "missing")
        assert missing.value.code == "NOT_FOUND" and missing.value.status == 404
        revision = resolve_revision(conn, "current")
        with pytest.raises(Problem) as bad:
            build_projection(conn, revision, "Bad Name")
        assert bad.value.code == "INVALID_GRAPH_NAME"
        assert build_projection(conn, revision, "custom_graph")["graph"] == "custom_graph"
    service.import_kg(
        {"concepts": [{"concept_id": "x", "name": "has $cy$ tag", "level": 1}]}, "tester"
    )
    with service.db.connect() as conn:
        revision = resolve_revision(conn, "current")
        with pytest.raises(Problem) as unsafe:
            projection_script(conn, revision)
        assert unsafe.value.code == "AGE_UNSAFE_TEXT"


def test_generated_script_is_valid_sql(kg):
    pglast = pytest.importorskip("pglast")
    _, script = script_for(kg)
    statements = [s.stmt for s in pglast.parse_sql(script)]
    assert sum(type(s).__name__ == "DoStmt" for s in statements) == 2
    assert sum(type(s).__name__ == "SelectStmt" for s in statements) == 6
    assert type(statements[0]).__name__ == "LoadStmt"


def test_cli_age_projection_writes_file(kg, capsys):
    from kg.v2.__main__ import main

    out = kg["root"] / "age" / "kg.sql"
    main(["age-projection", "--ws", str(kg["root"]), "--kg", "current", "--out", str(out)])
    text = out.read_text(encoding="utf-8")
    assert f"kg_revision_id: {kg['second']['kg_revision_id']}" in text
    result = json.loads(capsys.readouterr().out)
    assert result["vertices"] == 2 and result["edges"] == 1 and result["graph"] == "v2_kg_r2"
    assert result["out"] == str(out)
    direct = write_projection(kg["root"], "1", kg["root"] / "age" / "r1.sql")
    assert direct["vertices"] == 3 and direct["revision_no"] == 1
