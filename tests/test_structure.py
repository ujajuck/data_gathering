"""P0/P2 합격 기준 (설계문서 §14): Block/헤더/수식/색/이미지 탐지."""
from __future__ import annotations

from src.inspect.inspector import WorkbookInspector
from src.segment.detector import segment_workbook

from tests.conftest import F_BATCH, F_INSPECTION, F_QUALITY

inspector = WorkbookInspector()


def _segments(path):
    st = inspector.inspect(path)
    return st, segment_workbook(st)


def test_block_detection_counts():
    """샘플 11개 반복 Block(4+3+4)을 모두 분리한다."""
    counts = []
    for f in (F_INSPECTION, F_QUALITY, F_BATCH):
        _, segs = _segments(f)
        counts.append(sum(len(s.blocks) for s in segs))
    assert counts == [4, 3, 4]


def test_block_titles_are_report_headers():
    _, segs = _segments(F_INSPECTION)
    titles = [b.title for b in segs[0].blocks]
    assert all(t.startswith("설비 점검표 #") for t in titles)


def test_merged_hierarchical_header_path():
    """계층형 헤더 path가 상위/하위 의미를 모두 유지한다 (§4.3)."""
    _, segs = _segments(F_QUALITY)
    block = segs[0].blocks[0]
    fields = [f for r in block.regions for f in r.fields]
    od = next(f for f in fields if f.raw_label == "외경" and f.row_key == "S1")
    assert od.header_path == ["치수 검사 (mm)", "외경"]
    assert od.raw_unit == "mm"
    st = next(f for f in fields if f.raw_label == "강도" and f.row_key == "S1")
    assert st.header_path == ["물성 검사", "강도(MPa)"]
    assert st.raw_unit == "MPa"


def test_profile_region_inherits_group_unit():
    """가로형 온도 프로파일: 그룹 제목의 단위/문맥이 leaf에 상속된다 (§2.3)."""
    _, segs = _segments(F_BATCH)
    block = segs[0].blocks[0]
    profile = next(r for r in block.regions if r.region_type == "PROFILE")
    labels = {f.raw_label for f in profile.fields}
    assert labels == {"초기", "중간", "종료"}
    assert all(f.raw_unit == "℃" for f in profile.fields)
    assert all(f.header_path[0] == "온도 프로파일 (℃)" for f in profile.fields)


def test_formula_fields_not_classified_as_input():
    """계산/판정 수식이 input으로 오분류되지 않는다 (§14 Formula role)."""
    for fixture in (F_INSPECTION, F_QUALITY, F_BATCH):
        _, segs = _segments(fixture)
        for seg in segs:
            for b in seg.blocks:
                for r in b.regions:
                    for f in r.fields:
                        if f.is_formula:
                            assert f.style_role in ("calculated", "result"), (
                                fixture.name, f.address, f.style_role)


def test_color_semantics_are_document_local():
    """색 의미는 문서 로컬 — 같은 노랑이 문서마다 다른 뜻 (§10.2)."""
    _, segs1 = _segments(F_INSPECTION)
    _, segs2 = _segments(F_QUALITY)
    yellow = "FFFFF2CC"
    assert segs1[0].style_semantics[yellow] == "확인 필요"
    assert segs2[0].style_semantics[yellow] == "검사자 입력"


def test_image_lineage():
    """각 이미지가 올바른 Block/Record에 연결된다 (§14 Image lineage)."""
    for fixture, expected in ((F_INSPECTION, 4), (F_QUALITY, 3), (F_BATCH, 4)):
        st, segs = _segments(fixture)
        total = sum(len(s.images) for s in st.sheets)
        assert total == expected, fixture.name
        for seg in segs:
            for b in seg.blocks:
                assert len(b.images) == 1, (fixture.name, b.title)


def test_formula_refs_extracted_for_lineage():
    """수식 참조셀 파싱 → calculated_from lineage 재료 (§10.3)."""
    st, segs = _segments(F_BATCH)
    block = segs[0].blocks[0]
    fields = [f for r in block.regions for f in r.fields]
    avg = next(f for f in fields if f.raw_label == "평균온도" and f.is_formula and f.row_key == "값")
    assert "D9:F9" in avg.formula_refs
