"""파일 분석 탭의 작성자/작성일 공급(kg.webapp._doc_props) 검증."""
from pathlib import Path

from openpyxl import Workbook

from kg.webapp import _doc_props


def test_doc_props_reads_core_properties(tmp_path: Path):
    p = tmp_path / "authored.xlsx"
    wb = Workbook()
    wb.properties.creator = "품질팀 김검사"
    wb.active["A1"] = "x"
    wb.save(p)
    props = _doc_props(p)
    assert props["author"] == "품질팀 김검사"
    assert props["created"]                       # dcterms:created ISO 문자열
    # mtime 키 캐시 — 같은 파일 재조회는 동일 결과
    assert _doc_props(p) == props


def test_doc_props_missing_file_and_locked(tmp_path: Path):
    assert _doc_props(tmp_path / "없음.xlsx") == {
        "author": None, "created": None, "modified": None}
    # 잠긴(비-zip) 컨테이너 — 속성은 없고 작성일은 mtime으로 대체
    locked = tmp_path / "locked.xlsx"
    locked.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)
    props = _doc_props(locked)
    assert props["author"] is None
    assert props["created"]
