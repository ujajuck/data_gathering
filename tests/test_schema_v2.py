"""별도 v2 DB의 관계/버전/다중 출처 불변식을 검증한다. DRM/화면 성능 테스트가 아니다."""
from __future__ import annotations

import sqlite3
import unittest

from examples.schema_v2.demo import AT, append_manual_revision, canonical, create_demo, deduplicate_for_field, insert


class SchemaV2Tests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.summary = create_demo(self.conn)

    def rows(self, query, params=()):
        return list(self.conn.execute(query, params))

    def clone(self, table, where, changes):
        """테스트가 지정한 고정 SQL에서 행을 복제한다. 실제 운영 API가 아니다."""
        row = dict(self.conn.execute(f"SELECT * FROM {table} WHERE {where}").fetchone())
        row.update(changes)
        insert(self.conn, table, **row)

    def new_second_run(self):
        # 완료된 입력 스냅샷은 수정하지 않고 재시도 실행을 새로 만든다.
        self.clone("extraction_run", "run_id='run-second'", {
            "run_id": "run-new", "request_key": "request-new", "status": "queued", "finished_at": None})
        self.clone("run_mapping", "run_id='run-second'", {"run_id": "run-new"})
        self.conn.execute("UPDATE extraction_run SET status='running' WHERE run_id='run-new'")

    def new_scalar_series(self):
        self.new_second_run()
        self.clone("extracted_series", "series_id='series-second-temperature'", {
            "series_id": "series-new", "run_id": "run-new", "cardinality": "scalar", "axis": "none"})
        for role, rid in [("key", "key-temp"), ("value", "temp-5")]:
            insert(self.conn, "series_region", series_id="series-new", document_version_id="dv-1",
                   role=role, ordinal=0, region_id=rid)

    def publish_new(self):
        self.conn.execute("UPDATE extraction_run SET status='succeeded' WHERE run_id='run-new'")
        self.conn.execute("UPDATE template_application SET published_run_id='run-new' WHERE application_id='app-second'")

    def test_demo_retains_all_observations_and_aggregate_lineage(self):
        self.assertEqual(self.summary["raw_temperature_items"], 10)
        self.assertEqual(self.summary["deduplicated_temperature_items_including_blank"], 5)
        self.assertEqual(self.summary["temperature_sum"], "750")
        self.assertEqual(self.summary["sum_lineage_sources"], 8)
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])
        self.assertEqual(self.conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_multi_template_multi_sheet_bindings(self):
        self.assertEqual(len(self.rows("SELECT * FROM application_sheet WHERE application_id='app-main'")), 2)
        self.assertEqual(len(self.rows("SELECT * FROM application_sheet WHERE sheet_id='sheet-main'")), 2)
        self.assertEqual(len(self.rows("SELECT * FROM current_extracted_item")), 13)

    def test_noncontiguous_key_and_value_regions_preserve_order(self):
        regions = self.rows("SELECT role,ordinal,locator_key FROM series_region JOIN source_region USING(region_id) "
                            "WHERE series_id='series-main-temperature' ORDER BY role,ordinal")
        self.assertEqual([r["locator_key"] for r in regions if r["role"] == "key"], ["B3:C3", "F3"])
        self.assertEqual([r["locator_key"] for r in regions if r["role"] == "value"], ["B5:B7", "B10:C11"])
        self.assertEqual(tuple(self.conn.execute("SELECT r1,c1,r2,c2,merge_anchor_r,merge_anchor_c FROM source_region WHERE region_id='temp-10'").fetchone()),
                         (10, 2, 10, 3, 10, 2))

    def test_blank_record_and_horizontal_direction_are_preserved(self):
        rows = self.rows("SELECT record_key,value_state FROM extracted_item WHERE series_id='series-main-temperature' ORDER BY item_index")
        self.assertEqual([r[0] for r in rows], ["r5", "r6", "r7", "r10", "r11"])
        self.assertEqual(rows[2][1], "blank")
        right = self.rows("SELECT record_key,value_text FROM extracted_item WHERE series_id='series-main-duration' ORDER BY item_index")
        self.assertEqual([tuple(r) for r in right], [("c2", "10"), ("c3", "12"), ("c4", "14")])

    def test_formula_cached_result_and_expression_are_separate(self):
        row = self.conn.execute("SELECT formula_text,formula_state,value_text FROM extracted_item WHERE item_id='item-main-temperature-1'").fetchone()
        self.assertEqual(tuple(row), ("=180+5", "cached_unknown_age", "185"))

    def test_cross_document_version_region_is_rejected(self):
        insert(self.conn, "document_version", document_version_id="dv-2", document_id="doc-1",
               revision_no=2, filename="new.xlsx", captured_at=AT)
        with self.assertRaises(sqlite3.IntegrityError):
            self.clone("source_region", "region_id='temp-5'", {
                "region_id": "bad-region", "document_version_id": "dv-2", "locator_key": "E2"})

    def test_other_template_mapping_cannot_be_attached_to_application(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.clone("mapping_revision", "mapping_revision_id='map-main-temperature'", {
                "mapping_revision_id": "bad-map", "application_id": "app-second", "revision_no": 2})

    def test_snapshot_and_completed_output_updates_are_rejected(self):
        for sql in ["UPDATE template_version SET definition_json='{}'",
                    "DELETE FROM mapping_revision", "UPDATE extracted_item SET value_text='999'",
                    "UPDATE document_version SET filename='overwritten.xlsx'",
                    "UPDATE source_region SET r1=1"]:
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.conn.execute(sql)

    def test_manual_revision_invalidates_only_affected_application(self):
        new = append_manual_revision(self.conn, "app-main", "temperature", 1,
                                     {"value": {"areas": [{"range": "B6"}]}}, "duration")
        self.assertEqual(self.conn.execute("SELECT concept_id FROM mapping_revision WHERE mapping_revision_id=?", (new,)).fetchone()[0], "duration")
        self.assertEqual(self.conn.execute("SELECT concept_id FROM mapping_revision WHERE mapping_revision_id='map-main-temperature'").fetchone()[0], "temperature")
        self.assertEqual(len(self.rows("SELECT * FROM current_extracted_item")), 5)
        self.assertEqual(len(self.rows("SELECT * FROM build_lineage WHERE build_id='build-1'")), 8)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "differ from current"):
            self.conn.execute("UPDATE template_application SET published_run_id='run-main' WHERE application_id='app-main'")

    def test_stale_edit_sequence_rolls_back_without_losing_revision(self):
        append_manual_revision(self.conn, "app-main", "temperature", 1, {"key": "new"}, "temperature")
        count = self.conn.execute("SELECT count(*) FROM mapping_revision").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "동시 수정"):
            append_manual_revision(self.conn, "app-main", "temperature", 1, {"key": "stale"}, "duration")
        self.assertEqual(self.conn.execute("SELECT count(*) FROM mapping_revision").fetchone()[0], count)

    def test_proposed_mapping_cannot_become_head(self):
        self.clone("mapping_revision", "mapping_revision_id='map-main-temperature'", {
            "mapping_revision_id": "proposed", "revision_no": 2, "status": "proposed", "origin": "candidate"})
        with self.assertRaisesRegex(sqlite3.IntegrityError, "must be approved"):
            self.conn.execute("UPDATE mapping_head SET mapping_revision_id='proposed',edit_seq=2 WHERE application_id='app-main' AND rule_key='temperature'")

    def test_late_output_is_not_added_to_completed_run(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "running job"):
            self.clone("extracted_item", "item_id='item-main-temperature-0'", {"item_id": "late", "item_index": 99})

    def test_executed_sheet_binding_is_sealed(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
            self.conn.execute("UPDATE application_sheet SET sheet_id='sheet-meta' WHERE application_id='app-main' AND role_key='measurements'")

    def test_applied_template_and_kg_cannot_gain_late_rules(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
            self.clone("template_rule", "rule_key='temperature' AND template_version_id='tv-main'", {"rule_key": "late", "ordinal": 8})
        with self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
            insert(self.conn, "domain_alias", kg_revision_id="kg-1", concept_id="temperature", alias_norm="late", alias_text="late")

    def test_request_idempotency_is_scoped_to_application(self):
        # run-main/run-second는 같은 request-1을 가질 수 있지만 같은 적용 건의 재전송은 중복 생성되지 않는다.
        with self.assertRaises(sqlite3.IntegrityError):
            self.clone("extraction_run", "run_id='run-main'", {"run_id": "retry", "status": "queued"})

    def test_run_cannot_pin_another_applications_mapping(self):
        self.clone("extraction_run", "run_id='run-second'", {"run_id": "queued-new", "request_key": "new", "status": "queued"})
        with self.assertRaises(sqlite3.IntegrityError):
            insert(self.conn, "run_mapping", run_id="queued-new", application_id="app-second",
                   rule_key="temperature", mapping_revision_id="map-main-temperature")

    def test_scalar_requires_exactly_one_item(self):
        self.new_scalar_series()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "exactly one"):
            self.publish_new()

    def test_publication_requires_atomic_provenance(self):
        self.new_scalar_series()
        self.clone("extracted_item", "item_id='item-second-temperature-0'", {"item_id": "new-item", "series_id": "series-new"})
        with self.assertRaisesRegex(sqlite3.IntegrityError, "atomic provenance"):
            self.publish_new()

    def test_decimal_text_preserves_precision(self):
        self.new_scalar_series()
        precise = "12345678901234567890.12345678901234567890"
        self.clone("extracted_item", "item_id='item-second-temperature-0'", {
            "item_id": "precise", "series_id": "series-new", "value_text": precise, "raw_text": precise})
        self.assertEqual(self.conn.execute("SELECT value_text FROM extracted_item WHERE item_id='precise'").fetchone()[0], precise)

    def test_same_value_at_another_location_is_not_deduplicated(self):
        row = dict(self.conn.execute("SELECT * FROM current_extracted_item LIMIT 1").fetchone())
        other = dict(row, source_identity_key=canonical({"version": "dv-1", "sheet": "sheet-main", "locator": "Z99"}))
        self.assertEqual(len(deduplicate_for_field([row, other], "field")), 2)

    def test_different_meaning_or_transform_is_not_deduplicated(self):
        row = dict(self.conn.execute("SELECT * FROM current_extracted_item LIMIT 1").fetchone())
        self.assertEqual(len(deduplicate_for_field([row, dict(row, derivation_key="fahrenheit")], "field")), 2)
        self.assertEqual(len(deduplicate_for_field([row, dict(row, concept_id="another")], "field")), 2)

    def test_same_source_different_value_is_a_conflict(self):
        row = dict(self.conn.execute("SELECT * FROM current_extracted_item LIMIT 1").fetchone())
        with self.assertRaisesRegex(ValueError, "충돌"):
            deduplicate_for_field([row, dict(row, value_text="999")], "field")

    def test_field_lineage_cannot_include_an_unselected_rule(self):
        self.clone("build_run", "build_id='build-1'", {"build_id": "build-new", "status": "queued", "output_artifact_id": None})
        insert(self.conn, "build_input", build_id="build-new", run_id="run-main")
        self.conn.execute("UPDATE build_run SET status='running' WHERE build_id='build-new'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "field source selection"):
            self.clone("build_lineage", "build_id='build-1' AND ordinal=0", {
                "build_id": "build-new", "item_id": "item-main-duration-0"})

    def test_new_document_version_does_not_reuse_old_current_items(self):
        insert(self.conn, "document_version", document_version_id="dv-2", document_id="doc-1", revision_no=2,
               filename="합성_공정실험.xlsx", captured_at=AT)
        self.conn.execute("UPDATE document SET current_version_id='dv-2' WHERE document_id='doc-1'")
        self.assertEqual(self.rows("SELECT * FROM current_extracted_item"), [])
        self.assertEqual(len(self.rows("SELECT * FROM extracted_item")), 13)
        self.assertEqual(len(self.rows("SELECT * FROM build_lineage")), 8)

    def test_same_alias_can_have_two_contextual_concepts(self):
        self.assertEqual(len(self.rows("SELECT * FROM domain_alias WHERE alias_norm='조건'")), 2)

    def test_fails_closed_for_existing_database(self):
        with self.assertRaisesRegex(ValueError, "빈 DB"):
            create_demo(self.conn)
        self.assertEqual(len(self.rows("SELECT * FROM extracted_item")), 13)


if __name__ == "__main__":
    unittest.main()
