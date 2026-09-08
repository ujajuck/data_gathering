"""v2 스키마의 합성 데이터 예시. 실제 Excel/DRM 접근이나 현행 앱 DB 변경은 하지 않는다.

실행: python examples/schema_v2/demo.py
선택: python examples/schema_v2/demo.py --output /tmp/data_gathering_v2_demo.db
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sqlite3
from uuid import uuid4
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AT = "2026-09-08T00:00:00Z"


def canonical(value: object) -> str:
    """정렬 가능한 작은 규칙/식별 튜플을 정규 직렬화한다. 숫자는 십진 문자열로 전달한다."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def insert(conn: sqlite3.Connection, table: str, **values: object) -> None:
    """예시 내부의 고정 테이블/컬럼 이름만 받는다. 사용자 값은 항상 바인딩한다."""
    columns = ",".join(values)
    conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))


def deduplicate_for_field(rows: list, field_key: str) -> list[list]:
    """목적별 동일 출처를 묶되 값 충돌은 보류한다. 원본 관찰 행은 삭제하지 않는다.

    source_identity_key/derivation_key는 추출기가 원자 출처와 정규 규칙에서 계산한다.
    같은 값이라도 위치/문맥/개념/변환이 다르면 별개이며, 해시만 비교하지 않는다.
    """
    groups: dict[tuple, list] = {}
    values: dict[tuple, tuple] = {}
    for row in rows:
        key = (field_key, row["kg_revision_id"], row["concept_id"],
               row["source_identity_key"], row["derivation_key"],
               row["record_scope_key"], row["record_key"])
        value = (row["value_type"], row["value_state"], row["value_text"], row["unit_normalized"])
        if key in values and values[key] != value:
            raise ValueError("동일 출처/의미/변환에서 값 충돌: 우선순위 또는 검수가 필요합니다")
        values[key] = value
        groups.setdefault(key, []).append(row)
    return list(groups.values())


def append_manual_revision(conn: sqlite3.Connection, application_id: str, rule_key: str,
                           expected_seq: int, effective_spec: dict, concept_id: str) -> str:
    """수정 트랜잭션 예시. 실제 API에서는 먼저 권한·DSL·영역·개념을 검증해야 한다."""
    with conn:
        old = conn.execute(
            "SELECT m.*,h.edit_seq FROM mapping_head h JOIN mapping_revision m USING (mapping_revision_id) "
            "WHERE h.application_id=? AND h.rule_key=?", (application_id, rule_key)).fetchone()
        if old is None or old["edit_seq"] != expected_seq:
            raise ValueError("동시 수정 충돌")
        row = dict(old)
        row.pop("edit_seq")
        row.update(mapping_revision_id=str(uuid4()), supersedes_id=old["mapping_revision_id"],
                   revision_no=conn.execute("SELECT max(revision_no)+1 FROM mapping_revision WHERE application_id=? AND rule_key=?",
                                            (application_id, rule_key)).fetchone()[0],
                   effective_spec_json=canonical(effective_spec), concept_id=concept_id,
                   origin="manual", created_by="demo-reviewer", reason="예시의 영역/개념 수정")
        insert(conn, "mapping_revision", **row)
        changed = conn.execute(
            "UPDATE mapping_head SET mapping_revision_id=?,edit_seq=edit_seq+1 "
            "WHERE application_id=? AND rule_key=? AND edit_seq=?",
            (row["mapping_revision_id"], application_id, rule_key, expected_seq)).rowcount
        if changed != 1:
            raise ValueError("동시 수정 충돌")  # with conn이 새 리비전까지 롤백한다.
    return row["mapping_revision_id"]


def create_demo(conn: sqlite3.Connection) -> dict:
    """새 빈 DB에만 스키마와 합성 fixture를 만든다. 실제 파서 구현의 대체물이 아니다."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone():
        raise ValueError("예시는 빈 DB에서만 실행할 수 있습니다")
    conn.row_factory = sqlite3.Row
    conn.executescript((ROOT / "db/v2/schema_sqlite.sql").read_text(encoding="utf-8"))
    insert(conn, "kg_revision", kg_revision_id="kg-1", revision_no=1,
           content_sha256=digest("demo-kg"), created_by="human", created_at=AT)
    for cid, name, level, unit in [("process", "공정", 1, None),
                                  ("temperature", "공정온도", 2, "degC"),
                                  ("duration", "공정시간", 2, "min")]:
        insert(conn, "domain_concept", kg_revision_id="kg-1", concept_id=cid,
               name=name, definition=f"사람이 정의한 {name}", level=level,
               value_type="decimal" if unit else None, canonical_unit=unit)
    for cid in ("temperature", "duration"):
        insert(conn, "domain_edge", kg_revision_id="kg-1", from_concept_id="process",
               to_concept_id=cid, relation_type="parent_of")
    # 한 표현의 의미가 문맥에 따라 달라지는 경우도 DB에서 금지하지 않는다.
    for cid, context in [("temperature", "thermal"), ("duration", "duration")]:
        insert(conn, "domain_alias", kg_revision_id="kg-1", concept_id=cid,
               alias_norm="조건", alias_text="조건", context_key=context,
               context_json=canonical({"section": context}))

    insert(conn, "document", document_id="doc-1", display_name="합성_공정실험.xlsx",
           provider="demo", source_ref="demo://protected-original", registered_at=AT)
    insert(conn, "document_version", document_version_id="dv-1", document_id="doc-1",
           revision_no=1, provider_version_token="demo-version-1", filename="합성_공정실험.xlsx",
           author="예시 작성자", excel_date_system="1900", captured_at=AT)
    conn.execute("UPDATE document SET current_version_id='dv-1' WHERE document_id='doc-1'")
    for sid, name, order in [("sheet-main", "가열시험", 0), ("sheet-meta", "기준정보", 1)]:
        insert(conn, "sheet", sheet_id=sid, document_version_id="dv-1", name=name, ordinal=order)

    regions = [
        ("key-process", "sheet-main", "B3:C3", 3, 2, 3, 3, True),
        ("key-temp", "sheet-main", "F3", 3, 6, 3, 6, False),
        ("values-top", "sheet-main", "B5:B7", 5, 2, 7, 2, False),
        ("values-bottom", "sheet-main", "B10:C11", 10, 2, 11, 3, False),
        ("unit", "sheet-meta", "B2", 2, 2, 2, 2, False),
        ("key-duration", "sheet-main", "A15", 15, 1, 15, 1, False),
        ("values-duration", "sheet-main", "B15:D15", 15, 2, 15, 4, False),
    ]
    for r in (5, 6, 7, 10, 11):
        regions.append((f"temp-{r}", "sheet-main", f"B{r}:C{r}" if r >= 10 else f"B{r}",
                        r, 2, r, 3 if r >= 10 else 2, r >= 10))
    for col, letter in [(2, "B"), (3, "C"), (4, "D")]:
        regions.append((f"duration-{col}", "sheet-main", f"{letter}15", 15, col, 15, col, False))
    for rid, sid, address, r1, c1, r2, c2, merged in regions:
        insert(conn, "source_region", region_id=rid, document_version_id="dv-1", sheet_id=sid,
               locator_key=address, r1=r1, c1=c1, r2=r2, c2=c2,
               merge_anchor_r=r1 if merged else None, merge_anchor_c=c1 if merged else None)

    definition = json.loads((ROOT / "examples/schema_v2/template_multisheet.json").read_text(encoding="utf-8"))
    specs = {"main": definition, "second": copy.deepcopy(definition)}
    specs["second"]["template_id"] = "quality-temperature"
    specs["second"]["rules"] = specs["second"]["rules"][:1]
    # 먼저 템플릿 전체를 발행하고 적용 건을 만든다. 적용 이후 규칙을 덧붙일 수 없다.
    for name, spec in specs.items():
        insert(conn, "template", template_id=name, name=name, created_by="human", created_at=AT)
        insert(conn, "template_version", template_version_id=f"tv-{name}", template_id=name,
               revision_no=1, kg_revision_id="kg-1", format="json", definition_json=canonical(spec),
               definition_sha256=digest(spec), engine_contract_version="2.0-proposal", created_by="human", created_at=AT)
        for ordinal, rule in enumerate(spec["rules"]):
            insert(conn, "template_rule", template_version_id=f"tv-{name}", rule_key=rule["rule_key"],
                   kg_revision_id="kg-1", concept_id=rule["concept_id"], ordinal=ordinal,
                   selector_json=canonical(rule["selector"]), record_spec_json=canonical(rule["record_spec"]),
                   value_spec_json=canonical(rule["value_spec"]))

    for name, spec in specs.items():
        app, run = f"app-{name}", f"run-{name}"
        insert(conn, "template_application", application_id=app, document_version_id="dv-1",
               template_version_id=f"tv-{name}", scope_key=name, created_at=AT)
        for role, sid in [("measurements", "sheet-main"), ("metadata", "sheet-meta")]:
            insert(conn, "application_sheet", application_id=app, document_version_id="dv-1",
                   role_key=role, ordinal=0, sheet_id=sid)
        for rule in spec["rules"]:
            key, mid = rule["rule_key"], f"map-{name}-{rule['rule_key']}"
            insert(conn, "mapping_revision", mapping_revision_id=mid, application_id=app,
                   document_version_id="dv-1", template_version_id=f"tv-{name}", rule_key=key,
                   revision_no=1, kg_revision_id="kg-1", concept_id=rule["concept_id"], origin="template",
                   status="approved", effective_spec_json=canonical(rule), created_by="human",
                   reason="합성 예시의 사용자 승인", created_at=AT)
            insert(conn, "mapping_head", application_id=app, rule_key=key, mapping_revision_id=mid)
        insert(conn, "extraction_run", run_id=run, application_id=app, document_version_id="dv-1",
               template_version_id=f"tv-{name}", request_key="request-1", input_fingerprint=digest(spec),
               engine_version="synthetic-fixture-1", environment_json=canonical({"mode": "synthetic"}),
               status="queued", created_at=AT)
        for rule in spec["rules"]:
            insert(conn, "run_mapping", run_id=run, application_id=app, rule_key=rule["rule_key"],
                   mapping_revision_id=f"map-{name}-{rule['rule_key']}")
        conn.execute("UPDATE extraction_run SET status='running' WHERE run_id=?", (run,))

        for rule in spec["rules"]:
            key = rule["rule_key"]
            sid = f"series-{name}-{key}"
            is_temp = key == "temperature"
            insert(conn, "extracted_series", series_id=sid, run_id=run,
                   mapping_revision_id=f"map-{name}-{key}", document_version_id="dv-1",
                   instance_key="block-1", record_scope_key=f"dv-1:sheet-main:{key}-block",
                   observed_key="공정온도" if is_temp else "공정시간", cardinality="list",
                   axis="down" if is_temp else "right", status="ready")
            role_regions = ({"key": ["key-process", "key-temp"], "value": ["values-top", "values-bottom"], "unit": ["unit"]}
                            if is_temp else {"key": ["key-duration"], "value": ["values-duration"]})
            for role, ids in role_regions.items():
                for ordinal, rid in enumerate(ids):
                    insert(conn, "series_region", series_id=sid, document_version_id="dv-1",
                           role=role, ordinal=ordinal, region_id=rid)
            pairs = [(5, "180"), (6, "185"), (7, None), (10, "190"), (11, "195")] if is_temp else [(2, "10"), (3, "12"), (4, "14")]
            for index, (coordinate, value) in enumerate(pairs):
                iid = f"item-{name}-{key}-{index}"
                rid = f"temp-{coordinate}" if is_temp else f"duration-{coordinate}"
                source = conn.execute("SELECT * FROM source_region WHERE region_id=?", (rid,)).fetchone()
                # 합성 fixture에서도 정체성은 원자 셀/병합 앵커로 계산하고 템플릿을 포함하지 않는다.
                identity = canonical({"version": "dv-1", "sheet": source["sheet_id"], "locator": source["locator_key"]})
                formula = "=180+5" if is_temp and coordinate == 6 else None
                insert(conn, "extracted_item", item_id=iid, series_id=sid, document_version_id="dv-1",
                       item_index=index, record_key=f"{'r' if is_temp else 'c'}{coordinate}",
                       row_ordinal=index if is_temp else 0, col_ordinal=0 if is_temp else index,
                       raw_type="formula" if formula else ("decimal" if value is not None else "blank"),
                       raw_text=formula or value, display_text=value or "", value_type="decimal" if value is not None else "null",
                       value_text=value, value_state="present" if value is not None else "blank",
                       formula_text=formula, formula_state="cached_unknown_age" if formula else "none",
                       unit_raw="℃" if is_temp else "분", unit_normalized="degC" if is_temp else "min",
                       source_identity_key=identity, derivation_key=canonical(rule["value_spec"]))
                insert(conn, "item_region", item_id=iid, document_version_id="dv-1", role="value", ordinal=0, region_id=rid)
                if is_temp:
                    insert(conn, "item_region", item_id=iid, document_version_id="dv-1", role="unit", ordinal=0, region_id="unit")
        conn.execute("UPDATE extraction_run SET status='succeeded',finished_at=? WHERE run_id=?", (AT, run))
        conn.execute("UPDATE template_application SET published_run_id=? WHERE application_id=?", (run, app))

    rows = list(conn.execute("SELECT * FROM current_extracted_item WHERE concept_id='temperature' ORDER BY template_version_id,item_index"))
    grouped = deduplicate_for_field(rows, "temperature")
    present = [group for group in grouped if group[0]["value_state"] == "present"]
    total = sum((Decimal(group[0]["value_text"]) for group in present), Decimal(0))
    insert(conn, "integration_project", project_id="project-1", name="공정온도 합계 예시", created_by="human", created_at=AT)
    build_spec = {"deduplicate": "same_source_and_derivation", "conflict": "error", "aggregate": "sum_after_dedup"}
    insert(conn, "integration_version", integration_version_id="iv-1", project_id="project-1", revision_no=1,
           kg_revision_id="kg-1", spec_json=canonical(build_spec), spec_sha256=digest(build_spec), created_at=AT)
    insert(conn, "integration_field", integration_version_id="iv-1", field_key="temperature", kg_revision_id="kg-1",
           concept_id="temperature", output_name="temperature_sum", ordinal=0, target_type="decimal", target_unit="degC")
    for name in ("main", "second"):
        insert(conn, "integration_source", integration_version_id="iv-1", field_key="temperature",
               application_id=f"app-{name}", template_version_id=f"tv-{name}", rule_key="temperature")
    insert(conn, "build_run", build_id="build-1", integration_version_id="iv-1", status="queued",
           input_fingerprint=digest(["run-main", "run-second", build_spec]),
           input_manifest_json=canonical({"runs": ["run-main", "run-second"]}), created_at=AT)
    for run in ("run-main", "run-second"):
        insert(conn, "build_input", build_id="build-1", run_id=run, selection_json=canonical({"rule_keys": ["temperature"]}))
    conn.execute("UPDATE build_run SET status='running' WHERE build_id='build-1'")
    ordinal = 0
    for group in present:
        for index, row in enumerate(group):
            insert(conn, "build_lineage", build_id="build-1", integration_version_id="iv-1", output_table="summary",
                   output_row_key="total", field_key="temperature", ordinal=ordinal, item_id=row["item_id"],
                   contribution_role="aggregate_input" if index == 0 else "deduplicated",
                   transform_path_json=canonical(["same_source_dedup", "sum"]))
            ordinal += 1
    # 메모리에서 계산한 결과를 나타내는 합성 artifact다. 외부 파일이 존재한다고 주장하지 않는다.
    insert(conn, "artifact", artifact_id="demo-output", kind="dataset", storage_ref="memory://demo-temperature-sum",
           sha256=digest({"temperature_sum": str(total)}), media_type="application/json", created_at=AT)
    conn.execute("UPDATE build_run SET status='succeeded',output_artifact_id='demo-output',row_count=1,finished_at=? WHERE build_id='build-1'", (AT,))
    conn.commit()
    return {"mode": "synthetic-schema-fixture", "raw_temperature_items": len(rows),
            "deduplicated_temperature_items_including_blank": len(grouped),
            "preserved_blank_record": "r7", "temperature_sum": str(total),
            "sum_lineage_sources": ordinal, "foreign_key_errors": len(list(conn.execute("PRAGMA foreign_key_check")))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("기존 DB를 덮어쓰지 않습니다. 새 경로를 지정하세요.")
    with sqlite3.connect(str(args.output) if args.output else ":memory:") as conn:
        print(json.dumps(create_demo(conn), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
