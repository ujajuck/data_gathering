"""원본 충실 렌더의 텍스트박스 추출 검증 (kg.webapp._render_sheet).

앵커가 알려진 텍스트박스 2개(fixture)를 드로잉 XML로 주입하고, /api/sheet가
쓰는 _render_sheet가 셀 그리드와 같은 px 좌표계로 도형을 돌려주는지 확인한다.
"""
from pathlib import Path

import pytest

from kg.webapp import _render_sheet
from tests.textbox_fixture import build_textbox_xlsx


@pytest.fixture()
def textbox_xlsx(tmp_path: Path) -> Path:
    return build_textbox_xlsx(tmp_path / "textbox.xlsx")


def test_textboxes_extracted_with_anchor_px(textbox_xlsx: Path):
    data = _render_sheet(textbox_xlsx, None)
    shapes = data["shapes"]
    assert len(shapes) == 2

    # 기본 열폭 8.43자 → 64px, 기본 행높이 15pt → 20px (셀 그리드와 동일 환산)
    col_w, row_h = data["cols"][0], data["rows"][0]
    assert (col_w, row_h) == (64, 20)

    # twoCellAnchor C3→E6: x=cum_x[2], y=cum_y[2], w=3열, h=4행 — 그리드 정합
    box = shapes[0]
    assert "C3:E6" in box["text"] and "반출 금지" in box["text"]
    assert (box["x"], box["y"]) == (2 * col_w, 2 * row_h)
    assert (box["w"], box["h"]) == (3 * col_w, 4 * row_h)

    # oneCellAnchor H2 + EMU 오프셋/ext: 47625EMU=5px, 19050EMU=2px,
    # 1828800×731520EMU = 192×76.8px
    memo = shapes[1]
    assert "검사자 메모" in memo["text"]
    assert (memo["x"], memo["y"]) == (7 * col_w + 5, row_h + 2)
    assert (memo["w"], memo["h"]) == (192, 77)


def test_sheet_without_drawings_has_no_shapes(tmp_path: Path):
    from openpyxl import Workbook
    p = tmp_path / "plain.xlsx"
    wb = Workbook()
    wb.active["A1"] = "no drawings"
    wb.save(p)
    assert _render_sheet(p, None)["shapes"] == []
