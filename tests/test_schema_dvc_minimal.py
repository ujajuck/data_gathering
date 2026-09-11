"""DVC 중심 최소 스키마의 핵심 불변식만 검증한다.

파일 버전 이력 자체는 DVC의 책임이므로 document/template/KG revision 테이블을
검증하지 않는다. 이 테스트는 안정 ID, 관계 무결성, 현재 매핑, 실행 DVC pin을 본다.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA = Path(__file__).resolve().parents[1] / "db" / "dvc" / "schema_sqlite.sql"
AT = "2026-09-11T12:00:00+00:00"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    return conn


def seed(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO document VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            "doc-1",
            "공정실험.xlsx",
            "tester",
            "2026-09-01",
            "data/raw/공정실험.xlsx",
            "xlsx",
            "git-a1",
            "same-content",
            AT,
            AT,
        ),
    )
    conn.execute(
        "INSERT INTO sheet VALUES (?,?,?,?,?)",
        ("sheet-1", "doc-1", "실험", 0, "native-1"),
    )
    conn.execute(
        "INSERT INTO source_region VALUES (?,?,?,?,?,?,?,?,?)",
        ("region-key", "sheet-1", "cells", "B3", 3, 2, 3, 2, "{}"),
    )
    conn.execute(
        "INSERT INTO source_region VALUES (?,?,?,?,?,?,?,?,?)",
        ("region-value", "sheet-1", "cells", "C3:C5", 3, 3, 5, 3, "{}"),
    )
    conn.execute(
        "INSERT INTO domain_concept VALUES (?,?,?,?,?,?,?,?)",
        ("temperature", "오븐 온도", "오븐 설정 온도", 4, "decimal", "degC", "active", AT),
    )
    conn.execute(
        "INSERT INTO template VALUES (?,?,?,?,?,?,?)",
        (
            "template-1",
            "공정 실험",
            "templates/process.json",
            "git-t1",
            "template-sha",
            AT,
            AT,
        ),
    )
    conn.execute(
        "INSERT INTO template_rule VALUES (?,?,?,?,?,?,?)",
        (
            "rule-temp",
            "template-1",
            "temperature",
            "temperature",
            0,
            '{"find":"오븐 온도"}',
            '{"type":"decimal"}',
        ),
    )
    conn.execute(
        "INSERT INTO template_application VALUES (?,?,?,?,?,?,?,?,?)",
        (
            "app-1",
            "doc-1",
            "template-1",
            "default",
            "git-a1",
            "git-t1",
            "git-kg1",
            AT,
            AT,
        ),
    )
    conn.execute(
        "INSERT INTO mapping VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "map-1",
            "app-1",
            "rule-temp",
            "sheet-1",
            "temperature",
            "default",
            "오븐 온도",
            "region-key",
            "region-value",
            "approved",
            AT,
            AT,
        ),
    )
    conn.execute(
        "INSERT INTO extraction_run VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            "run-1",
            "app-1",
            "git-a1",
            "git-t1",
            "git-kg1",
            "extractor/1",
            "succeeded",
            AT,
            AT,
            None,
        ),
    )
    conn.execute(
        "INSERT INTO extracted_value VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "value-1",
            "run-1",
            "map-1",
            0,
            "row-1",
            "180",
            "180",
            "decimal",
            "°C",
            "degC",
            "region-value",
            AT,
        ),
    )
    conn.commit()


def test_schema_is_small_and_integral():
    conn = connect()
    try:
        business_tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta'"
            )
        }
        assert business_tables == {
            "document",
            "sheet",
            "source_region",
            "domain_concept",
            "domain_alias",
            "domain_edge",
            "template",
            "template_rule",
            "template_application",
            "mapping",
            "extraction_run",
            "extracted_value",
        }
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def test_hash_is_not_document_identity():
    conn = connect()
    try:
        seed(conn)
        conn.execute(
            "INSERT INTO document VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "doc-2",
                "복사본.xlsx",
                None,
                None,
                "data/raw/복사본.xlsx",
                "xlsx",
                "git-a1",
                "same-content",
                AT,
                AT,
            ),
        )
        assert conn.execute("SELECT count(*) FROM document WHERE content_sha256='same-content'").fetchone()[0] == 2
    finally:
        conn.close()


def test_same_alias_can_point_to_multiple_concepts():
    conn = connect()
    try:
        seed(conn)
        conn.execute(
            "INSERT INTO domain_concept VALUES (?,?,?,?,?,?,?,?)",
            ("ambient-temperature", "주변 온도", None, 4, "decimal", "degC", "active", AT),
        )
        conn.execute(
            "INSERT INTO domain_alias VALUES (?,?,?,?)",
            ("temperature", "온도", "온도", "oven"),
        )
        conn.execute(
            "INSERT INTO domain_alias VALUES (?,?,?,?)",
            ("ambient-temperature", "온도", "온도", "ambient"),
        )
        assert conn.execute("SELECT count(*) FROM domain_alias WHERE alias_norm='온도'").fetchone()[0] == 2
    finally:
        conn.close()


def test_run_pins_dvc_revisions_even_after_current_refs_move():
    conn = connect()
    try:
        seed(conn)
        conn.execute("UPDATE document SET dvc_rev='git-a2', updated_at=? WHERE document_id='doc-1'", (AT,))
        conn.execute("UPDATE template SET dvc_rev='git-t2', updated_at=? WHERE template_id='template-1'", (AT,))
        run = conn.execute(
            "SELECT document_dvc_rev,template_dvc_rev,kg_dvc_rev FROM extraction_run WHERE run_id='run-1'"
        ).fetchone()
        assert tuple(run) == ("git-a1", "git-t1", "git-kg1")
    finally:
        conn.close()


def test_mapping_and_value_keep_relational_provenance():
    conn = connect()
    try:
        seed(conn)
        row = conn.execute(
            """
            SELECT d.document_name,s.sheet_name,m.observed_key,c.domain_name,v.value_text,r.locator_key
            FROM extracted_value v
            JOIN mapping m ON m.mapping_id=v.mapping_id
            JOIN template_application a ON a.application_id=m.application_id
            JOIN document d ON d.document_id=a.document_id
            JOIN sheet s ON s.sheet_id=m.sheet_id
            JOIN domain_concept c ON c.domain_id=m.domain_id
            LEFT JOIN source_region r ON r.region_id=v.source_region_id
            WHERE v.value_id='value-1'
            """
        ).fetchone()
        assert tuple(row) == (
            "공정실험.xlsx",
            "실험",
            "오븐 온도",
            "오븐 온도",
            "180",
            "C3:C5",
        )
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()
