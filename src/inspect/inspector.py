"""WorkbookInspector — structural extraction of XLSX (설계문서 §4, §13 src.inspect).

Reads every sheet of a workbook and captures cell values, formulas with cached
values, fills, bold flags, merged ranges and image anchors. Nothing is thrown
away: downstream stages decide meaning (설계문서 §1 "시각적 요소는 장식이 아니다").
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path

import openpyxl
from openpyxl.utils import get_column_letter

from src.common.hashing import sha256_bytes, sha256_file
from src.common.models import CellInfo, ImageInfo, SheetStructure, WorkbookStructure

PARSER_VERSION = "1.0.0"

# A1-style references inside formulas, including ranges ("B10:D12") and
# sheet-qualified refs ("Sheet1!A1" — sheet part captured separately).
_REF_RE = re.compile(r"(?:'[^']+'|[A-Za-z0-9_가-힣]+)?!?\$?([A-Z]{1,3})\$?([0-9]{1,7})(?::\$?([A-Z]{1,3})\$?([0-9]{1,7}))?")


def extract_formula_refs(formula: str) -> list[str]:
    refs: list[str] = []
    for m in _REF_RE.finditer(formula):
        c1, r1, c2, r2 = m.groups()
        if c2 and r2:
            refs.append(f"{c1}{r1}:{c2}{r2}")
        else:
            refs.append(f"{c1}{r1}")
    return refs


def _fill_rgb(cell) -> str | None:
    f = cell.fill
    if f is None or f.patternType is None:
        return None
    fg = f.fgColor
    if fg is not None and fg.type == "rgb" and fg.rgb and fg.rgb not in ("00000000",):
        return str(fg.rgb)
    return None


def _jsonable_value(v):
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    return v


class WorkbookInspector:
    """Extracts a WorkbookStructure from one xlsx file (all sheets)."""

    def __init__(self, parser_version: str = PARSER_VERSION):
        self.parser_version = parser_version

    def inspect(self, path: Path, relative_to: Path | None = None) -> WorkbookStructure:
        path = Path(path)
        wb_f = openpyxl.load_workbook(path, data_only=False)
        wb_v = openpyxl.load_workbook(path, data_only=True)

        rel = str(path.relative_to(relative_to)) if relative_to else path.name
        stat = path.stat()
        structure = WorkbookStructure(
            file_name=path.name,
            relative_path=rel,
            sha256=sha256_file(path),
            file_size=stat.st_size,
            modified_time=stat.st_mtime,
            parser_version=self.parser_version,
        )

        for idx, sheet_name in enumerate(wb_f.sheetnames):
            ws = wb_f[sheet_name]
            wsv = wb_v[sheet_name]

            merged = [str(m) for m in ws.merged_cells.ranges]
            covered: dict[str, str] = {}
            masters: dict[str, str] = {}
            for m in ws.merged_cells.ranges:
                rng = str(m)
                for row in range(m.min_row, m.max_row + 1):
                    for col in range(m.min_col, m.max_col + 1):
                        addr = f"{get_column_letter(col)}{row}"
                        if row == m.min_row and col == m.min_col:
                            masters[addr] = rng
                        else:
                            covered[addr] = rng

            sheet = SheetStructure(
                sheet_name=sheet_name,
                sheet_index=idx,
                max_row=ws.max_row or 0,
                max_col=ws.max_column or 0,
            )
            sheet.merged_ranges = sorted(merged)

            for row in ws.iter_rows():
                for cell in row:
                    fill = _fill_rgb(cell)
                    if cell.value is None and fill is None and cell.coordinate not in masters:
                        continue
                    is_formula = isinstance(cell.value, str) and cell.value.startswith("=")
                    cached = None
                    if is_formula:
                        cached = _jsonable_value(wsv[cell.coordinate].value)
                    info = CellInfo(
                        address=cell.coordinate,
                        row=cell.row,
                        col=cell.column,
                        value=_jsonable_value(cell.value),
                        cached_value=cached,
                        is_formula=is_formula,
                        formula=cell.value if is_formula else None,
                        formula_refs=extract_formula_refs(cell.value) if is_formula else [],
                        fill_rgb=fill,
                        bold=bool(cell.font and cell.font.bold),
                        number_format=cell.number_format if cell.number_format != "General" else None,
                        merged_range=masters.get(cell.coordinate),
                        merged_into=covered.get(cell.coordinate),
                    )
                    sheet.cells.append(info)

            for img in getattr(ws, "_images", []):
                try:
                    data = img._data()
                except Exception:
                    continue
                anchor = img.anchor
                frm = getattr(anchor, "_from", None)
                a_row = frm.row if frm is not None else 0
                a_col = frm.col if frm is not None else 0
                sheet.images.append(
                    ImageInfo(
                        image_hash=sha256_bytes(data),
                        anchor_row=a_row,
                        anchor_col=a_col,
                        media_path=getattr(img, "path", ""),
                        ext=getattr(img, "format", "png") or "png",
                    )
                )

            structure.sheets.append(sheet)
        return structure
