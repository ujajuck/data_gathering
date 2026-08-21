"""§14.1 mutation 회귀: 레이아웃/표기 변형에 대한 안정성."""
from __future__ import annotations

from src.inspect.inspector import WorkbookInspector
from src.pipeline import Pipeline
from src.segment.detector import segment_workbook

from tests.conftest import F_BATCH, F_INSPECTION, F_QUALITY, stage_fixture
from tests.mutations import combine_multi_sheet, rename_sheet, replace_label, shift_rows_down

inspector = WorkbookInspector()


def test_header_shift_keeps_record_keys(tmp_repo):
    """헤더 시작 행을 2행 내려도 record key와 block 수는 불변 (§14.1)."""
    target = stage_fixture(tmp_repo, F_INSPECTION)
    pipe = Pipeline(tmp_repo)
    pipe.process_file(target)
    keys_before = {r["record_key"] for r in pipe.loader.current_records()}

    shifted = tmp_repo / "shifted.xlsx"
    shift_rows_down(target, shifted, 2)
    shifted.replace(target)
    r = pipe.process_file(target)
    assert r["status"] == "SUCCESS"
    keys_after = {r["record_key"] for r in pipe.loader.current_records()}
    assert keys_before == keys_after
    # 위치 기반이 아니므로 새 record가 생기지 않는다
    assert r["stats"]["inserted"] == 0 and r["stats"]["tombstoned"] == 0


def test_sheet_rename_keeps_records(tmp_repo):
    """시트명 변경 → 새 document version, record key는 안정 (§9 Sheet rename)."""
    target = stage_fixture(tmp_repo, F_QUALITY)
    pipe = Pipeline(tmp_repo)
    pipe.process_file(target)

    renamed = tmp_repo / "renamed.xlsx"
    rename_sheet(target, renamed, "검사결과", "Quality")
    renamed.replace(target)
    r = pipe.process_file(target)
    assert r["status"] == "SUCCESS"
    # 의미가 동일하므로 record row는 재생성되지 않는다 (§9: 메타/lineage만 새 버전)
    assert r["stats"]["inserted"] == 0 and r["stats"]["tombstoned"] == 0
    keys = {rec["record_key"] for rec in pipe.loader.current_records()}
    assert len(keys) == 3 and all("LOT-" in k for k in keys)
    # 새 document version이 시트 rename을 기록한다
    versions = pipe.loader.conn.execute(
        "SELECT count(*) n FROM document_version").fetchone()["n"]
    assert versions == 2


def test_synonym_header_change_maps_to_same_concept(tmp_repo):
    """헤더를 승인된 동의어로 바꿔도 동일 concept로 매핑 (§14 Synonym mapping)."""
    target = stage_fixture(tmp_repo, F_INSPECTION)
    mutated = tmp_repo / "syn.xlsx"
    replace_label(target, mutated, "베어링온도", "베어링 온도")
    mutated.replace(target)

    pipe = Pipeline(tmp_repo)
    r = pipe.process_file(target)
    assert r["status"] == "SUCCESS"
    obs = pipe.loader.current_observations()
    bearing = [o for o in obs if o["raw_label"] == "베어링 온도"]
    assert bearing and all(o["concept_id"] == "bearing_temperature" for o in bearing)


def test_unit_change_normalizes_to_canonical(tmp_repo):
    """단위 kg→g 변경 시 정규화값은 표준 단위 kg 기준으로 유지 (§14 Unit)."""
    target = stage_fixture(tmp_repo, F_BATCH)
    mutated = tmp_repo / "unit.xlsx"
    replace_label(target, mutated, "투입량(kg)", "투입량(g)")
    mutated.replace(target)

    pipe = Pipeline(tmp_repo)
    pipe.process_file(target)
    obs = pipe.loader.current_observations("BATCH|B-260818-01|2026-08-18")
    amt = next(o for o in obs if o["raw_label"] == "투입량")
    assert amt["raw_unit"] == "g" and amt["raw_value_num"] == 1000.0
    assert amt["canonical_unit"] == "kg"
    assert abs(amt["normalized_value_num"] - 1.0) < 1e-9  # 1000 g == 1 kg


def test_multi_sheet_workbook_segments_every_sheet(tmp_repo):
    """실데이터 전제: 시트가 여러 개여도 시트별로 독립 분해된다 (§2)."""
    combined = tmp_repo / "data" / "raw" / "combined.xlsx"
    combine_multi_sheet([F_INSPECTION, F_BATCH], combined)

    st = inspector.inspect(combined)
    assert [s.sheet_name for s in st.sheets] == ["설비점검", "Batch운전"]
    segs = segment_workbook(st)
    assert [len(s.blocks) for s in segs] == [4, 4]
    # 시트별 로컬 범례가 독립적으로 유지된다 (§10.2)
    assert segs[0].style_semantics["FFFFF2CC"] == "확인 필요"
    assert segs[1].style_semantics["FFD9EAF7"] == "운전원 입력"

    pipe = Pipeline(tmp_repo)
    r = pipe.process_file(combined)
    assert r["status"] == "SUCCESS" and r["records"] == 8


def test_watcher_detects_lifecycle(tmp_repo):
    """Watcher: 생성/수정/삭제 감지 + 안정화 검사 (§8.4, §15)."""
    import shutil

    from src.watch.watcher import FileEventWatcher

    raw = tmp_repo / "data" / "raw"
    watcher = FileEventWatcher(raw_dir=raw)
    assert watcher.scan_once() == []

    shutil.copy2(F_INSPECTION, raw / "a.xlsx")
    first = watcher.scan_once()   # 1회차: 안정화 대기
    second = watcher.scan_once()  # 2회차: 안정 → created
    kinds = [e.kind for e in first + second]
    assert kinds == ["created"]

    (raw / "a.xlsx").touch()
    watcher.scan_once()
    events = watcher.scan_once()
    assert [e.kind for e in events] == ["modified"]

    (raw / "a.xlsx").unlink()
    events = watcher.scan_once()
    assert [e.kind for e in events] == ["deleted"]
