"""PostgreSQL DDL 번역본의 구문/구조 검증. 실제 PostgreSQL 서버는 없으므로 pglast 파싱만 한다."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

pglast = pytest.importorskip("pglast")
from pglast import parser as pg_parser  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SQLITE_DDL = ROOT / "db/v2/schema_sqlite.sql"
POSTGRES_DDL = ROOT / "db/v2/schema_postgres.sql"

UUID_COLUMNS = {
    "artifact": {"artifact_id"},
    "kg_revision": {"kg_revision_id"},
    "domain_concept": {"kg_revision_id"},
    "domain_edge": {"kg_revision_id"},
    "domain_alias": {"kg_revision_id"},
    "document": {"document_id", "current_version_id"},
    "document_version": {"document_version_id", "document_id", "source_artifact_id"},
    "sheet": {"sheet_id", "document_version_id"},
    "access_observation": {"access_id", "document_version_id"},
    "source_region": {"region_id", "document_version_id", "sheet_id"},
    "template": {"template_id"},
    "template_version": {
        "template_version_id",
        "template_id",
        "kg_revision_id",
        "code_artifact_id",
    },
    "template_rule": {"template_version_id", "kg_revision_id"},
    "template_application": {
        "application_id",
        "document_version_id",
        "template_version_id",
        "published_run_id",
    },
    "application_sheet": {"application_id", "document_version_id", "sheet_id"},
    "mapping_revision": {
        "mapping_revision_id",
        "application_id",
        "document_version_id",
        "template_version_id",
        "kg_revision_id",
        "supersedes_id",
    },
    "mapping_head": {"application_id", "mapping_revision_id"},
    "extraction_run": {
        "run_id",
        "application_id",
        "document_version_id",
        "template_version_id",
    },
    "run_mapping": {"run_id", "application_id", "mapping_revision_id"},
    "extracted_series": {
        "series_id",
        "run_id",
        "mapping_revision_id",
        "document_version_id",
    },
    "series_region": {"series_id", "document_version_id", "region_id"},
    "extracted_item": {"item_id", "series_id", "document_version_id"},
    "item_region": {"item_id", "document_version_id", "region_id"},
    "render_chunk": {"sheet_id", "artifact_id"},
    "integration_project": {"project_id"},
    "integration_version": {"integration_version_id", "project_id", "kg_revision_id"},
    "integration_field": {"integration_version_id", "kg_revision_id"},
    "build_run": {
        "build_id",
        "integration_version_id",
        "output_artifact_id",
        "report_artifact_id",
    },
    "build_input": {"build_id", "run_id"},
    "integration_source": {
        "integration_version_id",
        "application_id",
        "template_version_id",
        "pinned_run_id",
    },
    "build_lineage": {"build_id", "integration_version_id", "item_id"},
}
NAIVE_TEXT_TIMESTAMPS = {("document_version", "authored_at"), ("document_version", "source_modified_at")}


def sqlite_objects(kind):
    conn = sqlite3.connect(":memory:")
    conn.executescript(SQLITE_DDL.read_text(encoding="utf-8"))
    return {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type=? AND sql IS NOT NULL", (kind,)
        )
    }


def pg_statements():
    return [s.stmt for s in pglast.parse_sql(POSTGRES_DDL.read_text(encoding="utf-8"))]


def by_type(name):
    return [s for s in pg_statements() if type(s).__name__ == name]


def columns():
    result = {}
    for stmt in by_type("CreateStmt"):
        for element in stmt.tableElts or ():
            if type(element).__name__ == "ColumnDef":
                result[(stmt.relation.relname, element.colname)] = element.typeName.names[-1].sval
    return result


def test_postgres_ddl_parses_and_table_set_matches_sqlite():
    tables = {s.relation.relname for s in by_type("CreateStmt")}
    assert tables == sqlite_objects("table")
    assert len(tables) == 32 and "runtime_job" not in tables


def test_every_sqlite_trigger_has_postgres_counterpart():
    triggers = by_type("CreateTrigStmt")
    assert {t.trigname for t in triggers} == sqlite_objects("trigger")
    assert len(triggers) == 72
    assert all(t.row is True for t in triggers)


def test_trigger_functions_exist_and_plpgsql_bodies_parse():
    defined = {f.funcname[-1].sval for f in by_type("CreateFunctionStmt")}
    used = {t.funcname[-1].sval for t in by_type("CreateTrigStmt")}
    assert used <= defined, used - defined
    assert defined <= used, defined - used
    bodies = [
        text
        for text in pglast.split(POSTGRES_DDL.read_text(encoding="utf-8"))
        if "LANGUAGE plpgsql" in text
    ]
    assert len(bodies) == len(defined)
    for text in bodies:
        assert "$fn$" in text
        pg_parser.parse_plpgsql_json(text)


def test_column_type_translation():
    types = columns()
    for (table, column), type_name in types.items():
        if column.endswith("_json"):
            assert type_name == "jsonb", (table, column, type_name)
        if column.endswith("_at"):
            expected = "text" if (table, column) in NAIVE_TEXT_TIMESTAMPS else "timestamptz"
            assert type_name == expected, (table, column, type_name)
        if column.startswith("can_"):
            assert type_name == "bool", (table, column, type_name)
        if column in ("concept_id", "from_concept_id", "to_concept_id", "rule_key", "field_key"):
            assert type_name == "text", (table, column, type_name)
        if column == "byte_size":
            assert type_name == "int8", (table, column, type_name)
    for table, names in UUID_COLUMNS.items():
        for column in names:
            assert types[(table, column)] == "uuid", (table, column)
    assert types[("extracted_item", "value_text")] == "text"
    assert types[("extracted_item", "value_numeric")] == "numeric"
    assert types[("schema_meta", "version")] == "int4"


def test_forward_references_use_alter_table():
    altered = {s.relation.relname for s in by_type("AlterTableStmt")}
    assert {"document", "template_application"} <= altered


def test_view_indexes_and_schema_meta():
    assert {v.view.relname for v in by_type("ViewStmt")} == {"current_extracted_item"}
    indexes = {i.idxname for i in by_type("IndexStmt")}
    assert sqlite_objects("index") <= indexes
    inserts = [s for s in by_type("InsertStmt") if s.relation.relname == "schema_meta"]
    assert len(inserts) == 1
    first_value = inserts[0].selectStmt.valuesLists[0][0]
    assert first_value.val.ival == 2


def test_no_sqlite_only_syntax_remains():
    # 주석을 제외한 실제 문장만 검사한다.
    text = "\n".join(pglast.split(POSTGRES_DDL.read_text(encoding="utf-8")))
    assert "PRAGMA" not in text
    assert "json_valid" not in text
    assert "RAISE(ABORT" not in text
    assert " IS NOT OLD." not in text
