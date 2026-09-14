"""코어 DDL(db/schema_sqlite.sql)의 불변식 검증(계약 §1, §10 첫 항목). 서비스/API가 아니라 DB가 막는지를 본다."""

from __future__ import annotations

import json
import sqlite3
import unittest
from pathlib import Path

from schema.db import RUNTIME_DDL

ROOT = Path(__file__).resolve().parents[1]
DDL = ROOT / "db/schema_sqlite.sql"
AT = "2026-09-14T00:00:00.000+00:00"


def insert(conn, table, **values):
    conn.execute(
        f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
        tuple(values.values()),
    )


def region(conn, region_id, snapshot_id, sheet_id, locator, r1, c1, r2=None, c2=None):
    insert(conn, "source_region", region_id=region_id, snapshot_id=snapshot_id, sheet_id=sheet_id,
           kind="cells", locator_key=locator, r1=r1, c1=c1, r2=r2 or r1, c2=c2 or c1, created_at=AT)


def revision(conn, rev_id, mapping_id, revision_no, snapshot_id, field_id, status, origin="manual", **extra):
    insert(conn, "mapping_revision", mapping_revision_id=rev_id, mapping_id=mapping_id, revision_no=revision_no,
           snapshot_id=snapshot_id, field_id=field_id, effective_spec_json='{"selector":{}}',
           status=status, origin=origin, created_at=AT, **extra)


def manifest(pairs):
    return json.dumps({"mappings": {m: {"revision_id": r, "rule_key": k} for m, r, k in pairs},
                       "bindings": {"main": ["sheet-1"]}, "engine": {"version": "v3-engine/1"}})


def create_fixture(conn):
    """문서 1(snapshot 2), 스키마 1(group+필드 3), 프로파일 1(규칙 2), snapshot 1에 application/매핑/발행 실행."""
    conn.executescript(DDL.read_text(encoding="utf-8"))
    conn.executescript(RUNTIME_DDL)
    insert(conn, "document", document_id="doc-1", document_name="공정기록.xlsx", provider="local-xlsx",
           source_path="raw/공정기록.xlsx", file_type="xlsx", created_at=AT, updated_at=AT)
    for sid, rev in (("snap-1", 1), ("snap-2", 2)):
        insert(conn, "document_snapshot", snapshot_id=sid, document_id="doc-1", revision_no=rev,
               change_token=f"sha-{rev}", content_sha256=f"sha-{rev}", filename="공정기록.xlsx", captured_at=AT)
        insert(conn, "sheet", sheet_id=f"sheet-{rev}", snapshot_id=sid, sheet_name="공정 기록", ordinal=0)
        insert(conn, "sheet", sheet_id=f"sheet-{rev}-common", snapshot_id=sid, sheet_name="공통", ordinal=1)
    conn.execute("UPDATE document SET current_snapshot_id='snap-1' WHERE document_id='doc-1'")
    region(conn, "reg-1-temp-key", "snap-1", "sheet-1", "B3", 3, 2)
    region(conn, "reg-1-temp-val", "snap-1", "sheet-1", "B4:B6", 4, 2, 6, 2)
    region(conn, "reg-1-lot-key", "snap-1", "sheet-1", "A3", 3, 1)
    region(conn, "reg-1-lot-val", "snap-1", "sheet-1", "A4", 4, 1)
    region(conn, "reg-2-temp-key", "snap-2", "sheet-2", "B3", 3, 2)
    region(conn, "reg-2-temp-val", "snap-2", "sheet-2", "B4", 4, 2)

    insert(conn, "parsing_schema", schema_id="schema-1", schema_key="process_standard",
           schema_name="공정 데이터 표준", current_rev=1, created_at=AT, updated_at=AT)
    fields = [("field-process", "process", "공정 정보", 1, "group"), ("field-temp", "temperature", "온도", 2, "decimal"),
              ("field-lot", "lot", "배치", 2, "text"), ("field-note", "note", "비고", None, "text")]
    for fid, key, name, level, vtype in fields:
        insert(conn, "parsing_field", field_id=fid, schema_id="schema-1", field_key=key, field_name=name,
               field_level=level, value_type=vtype, canonical_unit="°C" if key == "temperature" else None,
               created_at=AT, updated_at=AT)
    insert(conn, "parsing_alias", alias_id="alias-1", field_id="field-temp", alias_text="Temp", alias_norm="temp")
    for eid, to in (("edge-1", "field-temp"), ("edge-2", "field-lot")):
        insert(conn, "parsing_field_edge", edge_id=eid, schema_id="schema-1", from_field_id="field-process",
               to_field_id=to, relation="parent_of")
    insert(conn, "parsing_field_edge", edge_id="edge-3", schema_id="schema-1", from_field_id="field-temp",
           to_field_id="field-note", relation="related_to")

    insert(conn, "parsing_profile", profile_id="profile-1", profile_name="공정데이터_A양식", schema_id="schema-1",
           current_rev=1, status="approved", created_at=AT, updated_at=AT)
    for rid, key, fid, ordinal in (("rule-temp", "temperature", "field-temp", 0), ("rule-lot", "lot", "field-lot", 1)):
        insert(conn, "parsing_rule", rule_id=rid, profile_id="profile-1", rule_key=key, rule_name=key,
               default_field_id=fid, ordinal=ordinal, selector_json='{"key":{}}', value_spec_json='{"type":"text"}',
               created_at=AT)

    insert(conn, "parsing_application", application_id="app-1", snapshot_id="snap-1", profile_id="profile-1",
           schema_id="schema-1", profile_rev=1, schema_rev=1, origin="auto", match_signature="sig-1",
           compatibility="identical", created_at=AT)
    insert(conn, "application_sheet", application_id="app-1", snapshot_id="snap-1", role_key="main", ordinal=0,
           sheet_id="sheet-1")
    for mid, rid in (("map-temp", "rule-temp"), ("map-lot", "rule-lot")):
        insert(conn, "mapping", mapping_id=mid, application_id="app-1", snapshot_id="snap-1", rule_id=rid, created_at=AT)
    revision(conn, "rev-temp-1", "map-temp", 1, "snap-1", "field-temp", "approved", "auto",
             observed_key="온도", evidence_json='{"profile_rev":1}')
    revision(conn, "rev-lot-1", "map-lot", 1, "snap-1", "field-lot", "approved", "auto")
    for rev_id, role, rid in (("rev-temp-1", "key", "reg-1-temp-key"), ("rev-temp-1", "value", "reg-1-temp-val"),
                              ("rev-lot-1", "key", "reg-1-lot-key"), ("rev-lot-1", "value", "reg-1-lot-val")):
        insert(conn, "mapping_region", mapping_revision_id=rev_id, snapshot_id="snap-1", region_id=rid, role=role, ordinal=0)

    insert(conn, "extraction_run", run_id="run-1", application_id="app-1", snapshot_id="snap-1", schema_rev=1,
           profile_rev=1, engine_version="v3-engine/1", status="queued",
           input_manifest_json=manifest([("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-1", "lot")]))
    conn.execute("UPDATE extraction_run SET status='running', started_at=? WHERE run_id='run-1'", (AT,))
    for i, text in enumerate(("180", "185", "190")):
        insert(conn, "extracted_value", value_id=f"val-temp-{i}", run_id="run-1", snapshot_id="snap-1",
               mapping_revision_id="rev-temp-1", field_id="field-temp", group_key="temperature|sheet-1|B3",
               record_key=f"r{4 + i}", item_index=i, raw_text=text, display_text=text, value_text=text,
               value_type="decimal", value_state="present", unit_raw="°C", unit_normalized="°C",
               source_identity_key=f"snap-1|sheet-1|B{4 + i}", derivation_key="identity", created_at=AT)
        insert(conn, "extracted_value_region", value_id=f"val-temp-{i}", snapshot_id="snap-1",
               region_id="reg-1-temp-val", role="value", ordinal=0)
    insert(conn, "extracted_value", value_id="val-lot-0", run_id="run-1", snapshot_id="snap-1",
           mapping_revision_id="rev-lot-1", field_id="field-lot", group_key="lot|sheet-1|A3", record_key="r4",
           item_index=0, raw_text="L-1", value_text="L-1", value_type="text", value_state="present",
           source_identity_key="snap-1|sheet-1|A4", derivation_key="identity", created_at=AT)
    insert(conn, "extracted_value_region", value_id="val-lot-0", snapshot_id="snap-1", region_id="reg-1-lot-val",
           role="value", ordinal=0)
    conn.execute("UPDATE extraction_run SET status='succeeded', finished_at=? WHERE run_id='run-1'", (AT,))
    conn.execute("UPDATE parsing_application SET published_run_id='run-1' WHERE application_id='app-1'")
    conn.commit()


class CoreSchemaTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.conn.execute("PRAGMA foreign_keys=ON")
        create_fixture(self.conn)

    def scalar(self, sql, params=()):
        return self.conn.execute(sql, params).fetchone()[0]

    def rows(self, sql, params=()):
        return list(self.conn.execute(sql, params))

    def assertRejected(self, pattern, fn, *args, **kwargs):
        with self.assertRaisesRegex(sqlite3.IntegrityError, pattern):
            fn(*args, **kwargs)

    def new_run(self, run_id, pairs, application_id="app-1", snapshot_id="snap-1", finish="succeeded"):
        insert(self.conn, "extraction_run", run_id=run_id, application_id=application_id, snapshot_id=snapshot_id,
               engine_version="v3-engine/1", status="queued", input_manifest_json=manifest(pairs))
        if finish:
            self.conn.execute("UPDATE extraction_run SET status='running' WHERE run_id=?", (run_id,))
            self.conn.execute("UPDATE extraction_run SET status=? WHERE run_id=?", (finish, run_id))

    # --- 기본 무결성 -------------------------------------------------------------------------
    def test_fixture_is_consistent(self):
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])
        self.assertEqual(self.scalar("PRAGMA integrity_check"), "ok")
        self.assertEqual(self.scalar("SELECT version FROM schema_meta"), 3)
        core = {r[0] for r in self.rows("SELECT name FROM sqlite_master WHERE type='table'")}
        # 런타임 표(§1.6 runtime_job·snapshot_signature·source_digest)를 뺀 코어 18개
        self.assertEqual(len(core - {"schema_meta", "runtime_job", "snapshot_signature", "source_digest"}), 18)
        self.assertEqual(self.scalar("SELECT published_run_id FROM parsing_application WHERE application_id='app-1'"), "run-1")
        self.assertEqual(self.rows("SELECT edit_seq, current_revision_id FROM mapping ORDER BY mapping_id"),
                         [(1, "rev-lot-1"), (1, "rev-temp-1")])

    def test_database_class_initializes_from_ddl(self):
        import tempfile
        from schema.db import Database
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(Path(tmp))
            with db.connect() as conn:
                self.assertEqual(conn.execute("SELECT version FROM schema_meta").fetchone()[0], 3)
                names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("runtime_job", names)
            self.assertIn("mapping_revision", names)
            Database(Path(tmp))  # 두 번째 열기는 버전을 확인만 한다

    def test_current_value_view_follows_current_snapshot_and_published_run(self):
        self.assertEqual(self.scalar("SELECT count(*) FROM current_value"), 4)
        self.assertEqual(self.rows("SELECT DISTINCT document_id, application_id, profile_id FROM current_value"),
                         [("doc-1", "app-1", "profile-1")])
        self.assertEqual(self.scalar("SELECT count(*) FROM current_value WHERE field_id='field-temp'"), 3)
        self.conn.execute("UPDATE document SET current_snapshot_id='snap-2' WHERE document_id='doc-1'")
        self.assertEqual(self.scalar("SELECT count(*) FROM current_value"), 0)
        self.assertEqual(self.scalar("SELECT count(*) FROM extracted_value"), 4)

    def test_single_source_path_has_no_source_region_column(self):
        columns = {r[1] for r in self.rows("PRAGMA table_info(extracted_value)")}
        self.assertNotIn("source_region_id", columns)
        self.assertEqual(self.scalar("SELECT count(*) FROM extracted_value_region WHERE role='value'"), 4)
        self.assertEqual(self.scalar(
            "SELECT count(DISTINCT v.value_id) FROM extracted_value_region r JOIN extracted_value v USING (value_id) "
            "WHERE r.region_id='reg-1-temp-val'"), 3)

    # --- 불변 테이블 -------------------------------------------------------------------------
    def test_immutable_tables_reject_update_and_delete(self):
        cases = [
            ("UPDATE document_snapshot SET filename='x'", "document_snapshot is immutable"),
            ("DELETE FROM document_snapshot WHERE snapshot_id='snap-2'", "document_snapshot is immutable"),
            ("UPDATE sheet SET sheet_name='x'", "sheet is immutable"),
            ("DELETE FROM sheet WHERE sheet_id='sheet-2-common'", "sheet is immutable"),
            ("UPDATE source_region SET r1=99", "source_region is immutable"),
            ("DELETE FROM source_region WHERE region_id='reg-2-temp-val'", "source_region is immutable"),
            ("UPDATE mapping_revision SET status='rejected'", "mapping_revision is immutable"),
            ("UPDATE mapping_revision SET field_id='field-lot' WHERE mapping_revision_id='rev-temp-1'", "mapping_revision is immutable"),
            ("DELETE FROM mapping_revision", "mapping_revision is immutable"),
            ("UPDATE mapping_region SET ordinal=5", "mapping_region is immutable"),
            ("DELETE FROM mapping_region", "mapping_region is immutable"),
            ("UPDATE extracted_value SET value_text='999'", "extracted_value is immutable"),
            ("DELETE FROM extracted_value", "extracted_value is immutable"),
            ("UPDATE extracted_value_region SET role='key'", "extracted_value_region is immutable"),
            ("DELETE FROM extracted_value_region", "extracted_value_region is immutable"),
        ]
        for sql, message in cases:
            with self.subTest(sql=sql):
                self.assertRejected(message, self.conn.execute, sql)

    # --- CAS ---------------------------------------------------------------------------------
    def test_cas_same_expected_seq_twice_conflicts_and_keeps_revision_count(self):
        revision(self.conn, "rev-temp-2", "map-temp", 2, "snap-1", "field-temp", "proposed")
        self.assertEqual(self.rows("SELECT edit_seq, current_revision_id FROM mapping WHERE mapping_id='map-temp'"),
                         [(2, "rev-temp-2")])
        count = self.scalar("SELECT count(*) FROM mapping_revision")
        self.assertRejected("edit conflict", revision, self.conn, "rev-temp-2b", "map-temp", 2, "snap-1", "field-temp", "proposed")
        self.assertRejected("edit conflict", revision, self.conn, "rev-temp-9", "map-temp", 9, "snap-1", "field-temp", "proposed")
        self.assertEqual(self.scalar("SELECT count(*) FROM mapping_revision"), count)
        self.assertEqual(self.scalar("SELECT edit_seq FROM mapping WHERE mapping_id='map-temp'"), 2)

    def test_cas_stale_insert_rolls_back_regions_in_same_transaction(self):
        # 서비스는 BEGIN IMMEDIATE 안에서 리비전+영역을 넣고 IntegrityError면 모두 롤백한다.
        self.conn.execute("BEGIN")
        try:
            revision(self.conn, "rev-temp-2", "map-temp", 2, "snap-1", "field-temp", "proposed")
            insert(self.conn, "mapping_region", mapping_revision_id="rev-temp-2", snapshot_id="snap-1",
                   region_id="reg-1-temp-val", role="value", ordinal=0)
            revision(self.conn, "rev-temp-2b", "map-temp", 2, "snap-1", "field-temp", "proposed")
        except sqlite3.IntegrityError:
            self.conn.rollback()
        self.assertEqual(self.scalar("SELECT count(*) FROM mapping_region WHERE mapping_revision_id='rev-temp-2'"), 0)
        self.assertEqual(self.scalar("SELECT edit_seq FROM mapping WHERE mapping_id='map-temp'"), 1)

    def test_direct_head_update_is_rejected(self):
        revision(self.conn, "rev-temp-2", "map-temp", 2, "snap-1", "field-temp", "proposed")
        for sql in ["UPDATE mapping SET edit_seq=edit_seq+1 WHERE mapping_id='map-temp'",
                    "UPDATE mapping SET edit_seq=7 WHERE mapping_id='map-temp'",
                    "UPDATE mapping SET edit_seq=edit_seq WHERE mapping_id='map-temp'",
                    "UPDATE mapping SET current_revision_id='rev-temp-1' WHERE mapping_id='map-temp'",
                    "UPDATE mapping SET edit_seq=3, current_revision_id='rev-temp-1' WHERE mapping_id='map-temp'",
                    "UPDATE mapping SET current_revision_id=NULL, edit_seq=0 WHERE mapping_id='map-temp'"]:
            with self.subTest(sql=sql):
                self.assertRejected("mapping head can only advance", self.conn.execute, sql)
        self.assertRejected("mapping identity", self.conn.execute, "UPDATE mapping SET rule_id='rule-lot' WHERE mapping_id='map-temp'")
        self.assertEqual(self.rows("SELECT edit_seq, current_revision_id FROM mapping WHERE mapping_id='map-temp'"),
                         [(2, "rev-temp-2")])

    def test_first_revision_requires_expected_seq_zero(self):
        insert(self.conn, "parsing_application", application_id="app-2", snapshot_id="snap-2", profile_id="profile-1",
               schema_id="schema-1", profile_rev=1, schema_rev=1, origin="inherited", match_signature="sig-2",
               compatibility="compatible", created_at=AT)
        insert(self.conn, "mapping", mapping_id="map-2-temp", application_id="app-2", snapshot_id="snap-2",
               rule_id="rule-temp", created_at=AT)
        self.assertRejected("edit conflict", revision, self.conn, "rev-2-temp-2", "map-2-temp", 2, "snap-2", "field-temp", "proposed")
        revision(self.conn, "rev-2-temp-1", "map-2-temp", 1, "snap-2", None, "proposed", "inherited")
        self.assertEqual(self.scalar("SELECT current_revision_id FROM mapping WHERE mapping_id='map-2-temp'"), "rev-2-temp-1")

    def test_approved_revision_requires_field(self):
        self.assertRejected("CHECK", revision, self.conn, "rev-temp-2", "map-temp", 2, "snap-1", None, "approved")
        revision(self.conn, "rev-temp-2", "map-temp", 2, "snap-1", None, "rejected")
        self.assertEqual(self.scalar("SELECT status FROM mapping_revision WHERE mapping_revision_id="
                                     "(SELECT current_revision_id FROM mapping WHERE mapping_id='map-temp')"), "rejected")

    # --- 발행 --------------------------------------------------------------------------------
    def test_head_change_clears_published_run(self):
        revision(self.conn, "rev-lot-2", "map-lot", 2, "snap-1", "field-lot", "approved")
        self.assertIsNone(self.scalar("SELECT published_run_id FROM parsing_application WHERE application_id='app-1'"))
        # 이전 실행의 manifest는 옛 헤드를 가리키므로 다시 발행할 수 없다.
        self.assertRejected("differ from current mapping heads", self.conn.execute,
                            "UPDATE parsing_application SET published_run_id='run-1' WHERE application_id='app-1'")
        self.new_run("run-2", [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-2", "lot")])
        self.conn.execute("UPDATE parsing_application SET published_run_id='run-2' WHERE application_id='app-1'")
        self.assertEqual(self.scalar("SELECT published_run_id FROM parsing_application WHERE application_id='app-1'"), "run-2")

    def test_publish_requires_succeeded_run(self):
        for finish in ("failed", "cancelled", None):
            with self.subTest(finish=finish):
                run_id = f"run-{finish}"
                self.new_run(run_id, [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-1", "lot")], finish=finish)
                self.assertRejected("successful owned run", self.conn.execute,
                                    "UPDATE parsing_application SET published_run_id=? WHERE application_id='app-1'", (run_id,))

    def test_publish_requires_manifest_to_equal_heads_both_directions(self):
        self.new_run("run-missing", [("map-temp", "rev-temp-1", "temperature")])
        self.new_run("run-extra", [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-1", "lot"),
                                   ("map-ghost", "rev-ghost", "ghost")])
        self.new_run("run-wrong-rev", [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-temp-1", "lot")])
        insert(self.conn, "extraction_run", run_id="run-no-mappings", application_id="app-1", snapshot_id="snap-1",
               engine_version="v3-engine/1", status="queued", input_manifest_json='{"bindings":{}}')
        self.conn.execute("UPDATE extraction_run SET status='running' WHERE run_id='run-no-mappings'")
        self.conn.execute("UPDATE extraction_run SET status='succeeded' WHERE run_id='run-no-mappings'")
        for run_id in ("run-missing", "run-extra", "run-wrong-rev", "run-no-mappings"):
            with self.subTest(run=run_id):
                self.assertRejected("differ from current mapping heads", self.conn.execute,
                                    "UPDATE parsing_application SET published_run_id=? WHERE application_id='app-1'", (run_id,))
        self.new_run("run-ok", [("map-lot", "rev-lot-1", "lot"), ("map-temp", "rev-temp-1", "temperature")])
        self.conn.execute("UPDATE parsing_application SET published_run_id='run-ok' WHERE application_id='app-1'")

    def test_publish_requires_all_heads_approved_and_present(self):
        revision(self.conn, "rev-lot-2", "map-lot", 2, "snap-1", "field-lot", "proposed")
        self.new_run("run-2", [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-2", "lot")])
        self.assertRejected("must be approved", self.conn.execute,
                            "UPDATE parsing_application SET published_run_id='run-2' WHERE application_id='app-1'")
        # 헤드 없는 mapping(리비전 없음)이 있으면 발행 불가.
        insert(self.conn, "parsing_rule", rule_id="rule-note", profile_id="profile-1", rule_key="note",
               default_field_id="field-note", ordinal=2, selector_json='{}', value_spec_json='{}', created_at=AT)
        insert(self.conn, "mapping", mapping_id="map-note", application_id="app-1", snapshot_id="snap-1",
               rule_id="rule-note", created_at=AT)
        revision(self.conn, "rev-lot-3", "map-lot", 3, "snap-1", "field-lot", "approved")
        self.new_run("run-3", [("map-temp", "rev-temp-1", "temperature"), ("map-lot", "rev-lot-3", "lot")])
        self.assertRejected("needs a head revision", self.conn.execute,
                            "UPDATE parsing_application SET published_run_id='run-3' WHERE application_id='app-1'")

    def test_published_run_must_be_owned_by_application(self):
        insert(self.conn, "parsing_application", application_id="app-2", snapshot_id="snap-2", profile_id="profile-1",
               schema_id="schema-1", profile_rev=1, schema_rev=1, origin="inherited", match_signature="sig-2",
               compatibility="identical", created_at=AT)
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("UPDATE parsing_application SET published_run_id='run-1' WHERE application_id='app-2'")
        # 다른 application의 실행을 FK만으로도 붙일 수 없다(run_id, application_id 복합 FK).
        self.new_run("run-2", [], application_id="app-2", snapshot_id="snap-2")
        self.conn.execute("UPDATE parsing_application SET published_run_id='run-2' WHERE application_id='app-2'")
        self.assertRejected("successful owned run", self.conn.execute,
                            "UPDATE parsing_application SET published_run_id='run-2' WHERE application_id='app-1'")

    def test_application_starts_unpublished_and_identity_is_immutable(self):
        self.assertRejected("start unpublished", insert, self.conn, "parsing_application",
                            application_id="app-x", snapshot_id="snap-2", profile_id="profile-1", schema_id="schema-1",
                            profile_rev=1, schema_rev=1, origin="manual", match_signature="s", compatibility="manual",
                            published_run_id="run-1", created_at=AT)
        for column, value in (("snapshot_id", "snap-2"), ("profile_id", "profile-1"), ("schema_id", "schema-1"),
                              ("scope_key", "other"), ("profile_rev", 2), ("schema_rev", 2), ("application_id", "app-9")):
            with self.subTest(column=column):
                if column in ("profile_id", "schema_id"):
                    # 같은 값으로의 UPDATE는 변화가 없으므로 통과하고, 다른 값은 FK 이전에 트리거가 막는다.
                    self.conn.execute(f"UPDATE parsing_application SET {column}=? WHERE application_id='app-1'", (value,))
                    value = "missing"
                self.assertRejected("application identity", self.conn.execute,
                                    f"UPDATE parsing_application SET {column}=? WHERE application_id='app-1'", (value,))
        self.conn.execute("UPDATE parsing_application SET match_signature_json='{}' WHERE application_id='app-1'")

    # --- projection / 스키마 규칙 ---------------------------------------------------------------
    def test_field_delete_needs_no_references_and_deprecate_works(self):
        """§1.2 parsing_field_in_use_no_delete: 참조가 있으면 거부, 없으면 통과(§4.2.1·§4.2.2 삭제 경로)."""
        # 규칙(default_field_id)·매핑 리비전·추출값이 가리키는 필드.
        self.assertRejected("in use", self.conn.execute, "DELETE FROM parsing_field WHERE field_id='field-temp'")
        # 자식 parent_of 간선이 있는 필드.
        self.assertRejected("in use", self.conn.execute, "DELETE FROM parsing_field WHERE field_id='field-process'")
        # parsing_rule도 매핑이 가리키는 동안에는 금지(§4.2.1 프로파일 삭제에서만 실제로 지운다).
        self.assertRejected("in use", self.conn.execute, "DELETE FROM parsing_rule WHERE rule_id='rule-lot'")
        # 참조가 없는 필드는 간선·alias를 먼저 지우면 실제로 사라진다.
        self.conn.execute("DELETE FROM parsing_field_edge WHERE from_field_id='field-note' OR to_field_id='field-note'")
        self.conn.execute("DELETE FROM parsing_field WHERE field_id='field-note'")
        self.assertEqual(self.scalar("SELECT count(*) FROM parsing_field WHERE field_key='note'"), 0)
        # deprecate 경로는 그대로다.
        self.conn.execute("UPDATE parsing_field SET status='deprecated', updated_at=? WHERE field_id='field-temp'", (AT,))
        self.conn.execute("UPDATE parsing_rule SET status='deprecated' WHERE rule_id='rule-lot'")
        self.assertEqual(self.scalar("SELECT status FROM parsing_field WHERE field_id='field-temp'"), "deprecated")
        self.assertEqual(self.scalar("SELECT status FROM parsing_rule WHERE rule_id='rule-lot'"), "deprecated")

    def test_group_field_cannot_be_mapping_target(self):
        self.assertRejected("group field", insert, self.conn, "parsing_rule", rule_id="rule-group", profile_id="profile-1",
                            rule_key="process", default_field_id="field-process", ordinal=5, selector_json='{}',
                            value_spec_json='{}', created_at=AT)
        self.assertRejected("group field", self.conn.execute,
                            "UPDATE parsing_rule SET default_field_id='field-process' WHERE rule_id='rule-lot'")
        self.assertRejected("group field", revision, self.conn, "rev-temp-2", "map-temp", 2, "snap-1", "field-process", "proposed")
        self.assertRejected("group field", self.conn.execute,
                            "UPDATE parsing_field SET value_type='group' WHERE field_id='field-temp'")
        # 규칙의 field_key 없음(NULL)은 허용된다.
        insert(self.conn, "parsing_rule", rule_id="rule-free", profile_id="profile-1", rule_key="free", ordinal=6,
               selector_json='{}', value_spec_json='{}', created_at=AT)

    def test_parent_of_level_rules(self):
        insert(self.conn, "parsing_field", field_id="field-l3", schema_id="schema-1", field_key="l3", field_name="L3",
               field_level=3, value_type="text", created_at=AT, updated_at=AT)
        self.assertRejected("parent level", insert, self.conn, "parsing_field_edge", edge_id="bad-1", schema_id="schema-1",
                            from_field_id="field-process", to_field_id="field-l3", relation="parent_of")
        self.assertRejected("parent level", insert, self.conn, "parsing_field_edge", edge_id="bad-2", schema_id="schema-1",
                            from_field_id="field-process", to_field_id="field-note", relation="parent_of")
        self.assertRejected("parent level", insert, self.conn, "parsing_field_edge", edge_id="bad-3", schema_id="schema-1",
                            from_field_id="field-note", to_field_id="field-temp", relation="parent_of")
        insert(self.conn, "parsing_field_edge", edge_id="ok-1", schema_id="schema-1", from_field_id="field-temp",
               to_field_id="field-l3", relation="parent_of")
        insert(self.conn, "parsing_field_edge", edge_id="ok-2", schema_id="schema-1", from_field_id="field-process",
               to_field_id="field-note", relation="related_to")
        # 다부모 허용: lot도 l3의 부모가 될 수 있다.
        insert(self.conn, "parsing_field_edge", edge_id="ok-3", schema_id="schema-1", from_field_id="field-lot",
               to_field_id="field-l3", relation="parent_of")
        with self.assertRaises(sqlite3.IntegrityError):
            insert(self.conn, "parsing_field_edge", edge_id="bad-self", schema_id="schema-1", from_field_id="field-temp",
                   to_field_id="field-temp", relation="related_to")
        self.assertRejected("parent level", self.conn.execute,
                            "UPDATE parsing_field_edge SET from_field_id='field-process' WHERE edge_id='ok-1'")

    def test_field_level_guard_on_update(self):
        self.assertRejected("breaks a parent_of", self.conn.execute, "UPDATE parsing_field SET field_level=5 WHERE field_id='field-temp'")
        self.assertRejected("breaks a parent_of", self.conn.execute, "UPDATE parsing_field SET field_level=NULL WHERE field_id='field-temp'")
        self.assertRejected("breaks a parent_of", self.conn.execute, "UPDATE parsing_field SET field_level=2 WHERE field_id='field-process'")
        self.assertRejected("breaks a parent_of", self.conn.execute, "UPDATE parsing_field SET field_level=NULL WHERE field_id='field-process'")
        self.conn.execute("UPDATE parsing_field SET field_level=2 WHERE field_id='field-temp'")  # 같은 값은 통과
        self.conn.execute("UPDATE parsing_field SET field_level=7 WHERE field_id='field-note'")  # 간선 없음
        self.assertRejected("CHECK", self.conn.execute, "UPDATE parsing_field SET field_level=0 WHERE field_id='field-note'")

    def test_edge_must_stay_inside_its_schema(self):
        insert(self.conn, "parsing_schema", schema_id="schema-2", schema_key="other", schema_name="다른 스키마",
               created_at=AT, updated_at=AT)
        insert(self.conn, "parsing_field", field_id="field-other", schema_id="schema-2", field_key="x", field_name="x",
               field_level=2, value_type="text", created_at=AT, updated_at=AT)
        self.assertRejected("edge schema", insert, self.conn, "parsing_field_edge", edge_id="cross", schema_id="schema-1",
                            from_field_id="field-process", to_field_id="field-other", relation="parent_of")

    # --- snapshot 바인딩 ----------------------------------------------------------------------
    def test_snapshot_binding_rejects_cross_snapshot_rows(self):
        with self.subTest("mapping_region → 다른 snapshot의 region"):
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "mapping_region", mapping_revision_id="rev-temp-1", snapshot_id="snap-1",
                       region_id="reg-2-temp-val", role="unit", ordinal=0)
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "mapping_region", mapping_revision_id="rev-temp-1", snapshot_id="snap-2",
                       region_id="reg-2-temp-val", role="unit", ordinal=0)
        with self.subTest("application_sheet → 다른 snapshot의 sheet"):
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "application_sheet", application_id="app-1", snapshot_id="snap-1", role_key="common",
                       ordinal=0, sheet_id="sheet-2-common")
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "application_sheet", application_id="app-1", snapshot_id="snap-2", role_key="common",
                       ordinal=0, sheet_id="sheet-2-common")
        with self.subTest("source_region → 다른 snapshot의 sheet"):
            with self.assertRaises(sqlite3.IntegrityError):
                region(self.conn, "bad", "snap-2", "sheet-1", "Z9", 9, 26)
        with self.subTest("mapping → 다른 snapshot의 application"):
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "mapping", mapping_id="bad", application_id="app-1", snapshot_id="snap-2",
                       rule_id="rule-temp", created_at=AT)
        with self.subTest("mapping_revision → 다른 snapshot의 mapping"):
            with self.assertRaises(sqlite3.IntegrityError):
                revision(self.conn, "bad", "map-temp", 2, "snap-2", "field-temp", "proposed")
        with self.subTest("extraction_run → 다른 snapshot의 application"):
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "extraction_run", run_id="bad", application_id="app-1", snapshot_id="snap-2",
                       engine_version="v", status="queued", input_manifest_json="{}")
        with self.subTest("extracted_value → 다른 snapshot의 revision/run"):
            insert(self.conn, "parsing_application", application_id="app-2", snapshot_id="snap-2", profile_id="profile-1",
                   schema_id="schema-1", profile_rev=1, schema_rev=1, origin="inherited", match_signature="s",
                   compatibility="identical", created_at=AT)
            self.new_run("run-2", [], application_id="app-2", snapshot_id="snap-2", finish=None)
            self.conn.execute("UPDATE extraction_run SET status='running' WHERE run_id='run-2'")
            for snapshot_id, run_id in (("snap-2", "run-2"), ("snap-1", "run-2"), ("snap-2", "run-1")):
                with self.assertRaises(sqlite3.IntegrityError):
                    insert(self.conn, "extracted_value", value_id="bad", run_id=run_id, snapshot_id=snapshot_id,
                           mapping_revision_id="rev-temp-1", field_id="field-temp", group_key="g", value_type="decimal",
                           value_state="present", source_identity_key="k", derivation_key="d", created_at=AT)
        with self.subTest("extracted_value_region → 다른 snapshot의 region"):
            with self.assertRaises(sqlite3.IntegrityError):
                insert(self.conn, "extracted_value_region", value_id="val-lot-0", snapshot_id="snap-1",
                       region_id="reg-2-temp-val", role="input", ordinal=0)
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])

    def test_document_current_snapshot_must_belong_to_document(self):
        insert(self.conn, "document", document_id="doc-2", document_name="b.xlsx", provider="local-xlsx",
               source_path="raw/b.xlsx", file_type="xlsx", created_at=AT, updated_at=AT)
        self.conn.commit()
        self.conn.execute("UPDATE document SET current_snapshot_id='snap-1' WHERE document_id='doc-2'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.commit()  # 지연 FK는 COMMIT에서 검사된다
        self.conn.rollback()
        self.assertIsNone(self.scalar("SELECT current_snapshot_id FROM document WHERE document_id='doc-2'"))

    # --- extraction_run 상태 ------------------------------------------------------------------
    def test_run_state_transitions(self):
        self.new_run("run-2", [("map-temp", "rev-temp-1", "temperature")], finish=None)
        self.assertRejected("state transition", self.conn.execute, "UPDATE extraction_run SET status='succeeded' WHERE run_id='run-2'")
        self.conn.execute("UPDATE extraction_run SET status='running', started_at=? WHERE run_id='run-2'", (AT,))
        self.assertRejected("state transition", self.conn.execute, "UPDATE extraction_run SET status='queued' WHERE run_id='run-2'")
        self.assertRejected("immutable", self.conn.execute, "UPDATE extraction_run SET input_manifest_json='{}' WHERE run_id='run-2'")
        self.assertRejected("immutable", self.conn.execute, "UPDATE extraction_run SET application_id='app-1', snapshot_id='snap-2' WHERE run_id='run-2'")
        self.conn.execute("UPDATE extraction_run SET error_summary='x' WHERE run_id='run-2'")  # 진행 중 메타 갱신은 가능
        self.conn.execute("UPDATE extraction_run SET status='failed', finished_at=? WHERE run_id='run-2'", (AT,))
        for sql in ["UPDATE extraction_run SET status='running' WHERE run_id='run-2'",
                    "UPDATE extraction_run SET error_summary='late' WHERE run_id='run-2'",
                    "UPDATE extraction_run SET status='succeeded' WHERE run_id='run-1'",
                    "DELETE FROM extraction_run WHERE run_id='run-2'"]:
            with self.subTest(sql=sql):
                self.assertRejected("immutable after completion", self.conn.execute, sql)
        # 대기 중 취소, 대기 중 실행은 삭제 가능(산출물 없음).
        self.new_run("run-3", [], finish=None)
        self.conn.execute("UPDATE extraction_run SET status='cancelled' WHERE run_id='run-3'")
        self.new_run("run-4", [], finish=None)
        self.conn.execute("DELETE FROM extraction_run WHERE run_id='run-4'")

    def test_indexes_exist_for_contract_queries(self):
        indexed = {tuple(r[2] for r in self.rows(f"PRAGMA index_info({name})"))
                   for (name,) in self.rows("SELECT name FROM sqlite_master WHERE type='index'")}
        for columns in [("status", "document_name"), ("status", "updated_at"), ("current_snapshot_id",),
                        ("document_id", "revision_no"), ("document_id", "change_token"), ("snapshot_id", "profile_id"),
                        ("profile_id",), ("application_id", "rule_id"), ("mapping_id", "revision_no"),
                        ("application_id", "started_at"), ("run_id", "field_id", "record_key"), ("mapping_revision_id",),
                        ("field_id",), ("region_id",), ("sheet_id", "r1", "c1"), ("alias_norm",),
                        ("schema_id", "status", "ordinal"), ("state", "created_at", "job_id"), ("target_kind", "target_id")]:
            self.assertIn(columns, indexed, columns)


if __name__ == "__main__":
    unittest.main()
