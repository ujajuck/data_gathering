"""v3 PostgreSQL DDL 번역본의 구문/구조 검증(계약 §1.8). 실제 PostgreSQL 서버는 없으므로 pglast 파싱과 SQLite DDL과의 객체 집합 비교만 한다."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

pglast = pytest.importorskip("pglast")
from pglast import parser as pg_parser  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SQLITE_DDL = ROOT / "db/v3/schema_sqlite.sql"
POSTGRES_DDL = ROOT / "db/v3/schema_postgres.sql"

CORE_TABLES = {
    "document", "document_snapshot", "sheet", "source_region",
    "parsing_schema", "parsing_field", "parsing_alias", "parsing_field_edge",
    "parsing_profile", "parsing_rule",
    "parsing_application", "application_sheet", "mapping", "mapping_revision", "mapping_region",
    "extraction_run", "extracted_value", "extracted_value_region",
}
# 애플리케이션 발급 UUID id 컬럼(그 외 *_id·*_key는 논리 키라 TEXT).
UUID_COLUMNS = {
    "document": {"document_id", "current_snapshot_id"},
    "document_snapshot": {"snapshot_id", "document_id"},
    "sheet": {"sheet_id", "snapshot_id"},
    "source_region": {"region_id", "snapshot_id", "sheet_id"},
    "parsing_schema": {"schema_id"},
    "parsing_field": {"field_id", "schema_id"},
    "parsing_alias": {"alias_id", "field_id"},
    "parsing_field_edge": {"edge_id", "schema_id", "from_field_id", "to_field_id"},
    "parsing_profile": {"profile_id", "schema_id", "reference_application_id"},
    "parsing_rule": {"rule_id", "profile_id", "default_field_id"},
    "parsing_application": {"application_id", "snapshot_id", "profile_id", "schema_id", "published_run_id"},
    "application_sheet": {"application_id", "snapshot_id", "sheet_id"},
    "mapping": {"mapping_id", "application_id", "snapshot_id", "rule_id", "current_revision_id"},
    "mapping_revision": {"mapping_revision_id", "mapping_id", "snapshot_id", "field_id"},
    "mapping_region": {"mapping_revision_id", "snapshot_id", "region_id"},
    "extraction_run": {"run_id", "application_id", "snapshot_id"},
    "extracted_value": {"value_id", "run_id", "snapshot_id", "mapping_revision_id", "field_id"},
    "extracted_value_region": {"value_id", "snapshot_id", "region_id"},
}
NAIVE_TEXT_TIMESTAMPS = {("document_snapshot", "authored_at")}


def sqlite_conn():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SQLITE_DDL.read_text(encoding="utf-8"))
    return conn


def sqlite_objects(kind):
    return {
        r[0]
        for r in sqlite_conn().execute(
            "SELECT name FROM sqlite_master WHERE type=? AND sql IS NOT NULL", (kind,)
        )
    }


def sqlite_columns():
    conn = sqlite_conn()
    return {
        table: [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        for table in sqlite_objects("table")
    }


def pg_statements():
    return [s.stmt for s in pglast.parse_sql(POSTGRES_DDL.read_text(encoding="utf-8"))]


def by_type(name):
    return [s for s in pg_statements() if type(s).__name__ == name]


def pg_columns():
    result = {}
    for stmt in by_type("CreateStmt"):
        result[stmt.relation.relname] = [
            (e.colname, e.typeName.names[-1].sval)
            for e in stmt.tableElts or ()
            if type(e).__name__ == "ColumnDef"
        ]
    return result


def test_postgres_ddl_parses_and_table_set_matches_sqlite():
    tables = set(pg_columns())
    assert tables == sqlite_objects("table") == CORE_TABLES | {"schema_meta"}
    assert len(CORE_TABLES) == 18
    assert "runtime_job" not in tables and "snapshot_signature" not in tables


def test_column_names_and_order_match_sqlite():
    expected = sqlite_columns()
    for table, columns in pg_columns().items():
        assert [name for name, _ in columns] == expected[table], table
    assert "source_region_id" not in expected["extracted_value"]


def test_column_type_translation():
    for table, columns in pg_columns().items():
        for column, type_name in columns:
            if column.endswith("_json"):
                assert type_name == "jsonb", (table, column, type_name)
            elif column.endswith("_at"):
                expected = "text" if (table, column) in NAIVE_TEXT_TIMESTAMPS else "timestamptz"
                assert type_name == expected, (table, column, type_name)
            elif column in UUID_COLUMNS.get(table, ()):
                assert type_name == "uuid", (table, column, type_name)
            elif column.endswith("_key") or column.endswith("_sha256") or column in ("change_token", "match_signature"):
                assert type_name == "text", (table, column, type_name)
            elif column in ("byte_size",):
                assert type_name == "int8", (table, column, type_name)
            elif column in ("auto_approved",):
                assert type_name == "bool", (table, column, type_name)
            elif column in ("revision_no", "ordinal", "edit_seq", "current_rev", "profile_rev", "schema_rev",
                            "field_level", "item_index", "r1", "c1", "r2", "c2", "version"):
                assert type_name == "int4", (table, column, type_name)
    # 그 외 UUID 컬럼은 정확히 UUID_COLUMNS에 열거된 것뿐이다.
    actual_uuid = {(t, c) for t, cols in pg_columns().items() for c, ty in cols if ty == "uuid"}
    assert actual_uuid == {(t, c) for t, cols in UUID_COLUMNS.items() for c in cols}


def test_every_sqlite_trigger_has_postgres_counterpart():
    triggers = by_type("CreateTrigStmt")
    assert {t.trigname for t in triggers} == sqlite_objects("trigger")
    assert len(triggers) == len(sqlite_objects("trigger")) == 35
    assert all(t.row is True for t in triggers)


def test_trigger_functions_exist_and_plpgsql_bodies_parse():
    defined = {f.funcname[-1].sval for f in by_type("CreateFunctionStmt")}
    used = {t.funcname[-1].sval for t in by_type("CreateTrigStmt")}
    assert used == defined, used ^ defined
    bodies = [
        text
        for text in pglast.split(POSTGRES_DDL.read_text(encoding="utf-8"))
        if "LANGUAGE plpgsql" in text
    ]
    assert len(bodies) == len(defined)
    for text in bodies:
        assert "$fn$" in text
        pg_parser.parse_plpgsql_json(text)


def test_circular_foreign_keys_use_deferred_alter_table():
    altered = {}
    for stmt in by_type("AlterTableStmt"):
        for cmd in stmt.cmds:
            constraint = cmd.def_
            altered[(stmt.relation.relname, constraint.conname)] = (
                [k.sval for k in constraint.fk_attrs], constraint.pktable.relname,
                constraint.deferrable, constraint.initdeferred)
    assert altered == {
        ("document", "document_current_snapshot_fk"): (["document_id", "current_snapshot_id"], "document_snapshot", True, True),
        ("parsing_profile", "profile_reference_application_fk"): (["reference_application_id"], "parsing_application", True, True),
        ("mapping", "mapping_current_revision_fk"): (["mapping_id", "current_revision_id"], "mapping_revision", True, True),
        ("parsing_application", "application_published_run_fk"): (["published_run_id", "application_id"], "extraction_run", True, True),
    }


def test_view_indexes_and_schema_meta():
    assert {v.view.relname for v in by_type("ViewStmt")} == sqlite_objects("view") == {"current_value"}
    indexes = {i.idxname for i in by_type("IndexStmt")}
    assert indexes == sqlite_objects("index")
    inserts = [s for s in by_type("InsertStmt") if s.relation.relname == "schema_meta"]
    assert len(inserts) == 1
    assert inserts[0].selectStmt.valuesLists[0][0].val.ival == 3


def test_publish_trigger_compares_manifest_with_jsonb():
    text = POSTGRES_DDL.read_text(encoding="utf-8")
    body = text[text.index("v3_publish_run()"):text.index("v3_application_identity()")]
    assert "jsonb_each(r.input_manifest_json->'mappings')" in body
    assert "->>'revision_id'" in body
    assert body.count(" EXCEPT SELECT ") == 2


def test_no_sqlite_only_syntax_remains():
    text = "\n".join(pglast.split(POSTGRES_DDL.read_text(encoding="utf-8")))
    assert "PRAGMA" not in text
    assert "json_valid" not in text
    assert "json_each" not in text.replace("jsonb_each", "")
    assert "RAISE(ABORT" not in text
    assert " IS NOT OLD." not in text and " IS NOT NEW." not in text
