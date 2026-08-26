"""KG 간단 웹 UI — 단일 화면: 왼쪽 개념 검색·검수, 오른쪽 웹 xlsx 뷰어.

기존 7-뷰 UI와 달리 화면 하나만 둔다. 서버가 원본 workbook을 파싱해 그리드
JSON(병합/채움색/굵기 포함)을 내려주고, 프론트가 표로 그린다 — 외부 뷰어
라이브러리/CDN 없음. 역탐색 소스나 검수 항목을 클릭하면 뷰어가 해당 시트로
이동해 locator 범위를 하이라이트한다.

    python -m kg.webapp --ws domains/financier --port 8010
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src.inspect.inspector import WorkbookInspector
from src.mapping.concepts import normalize_label

from kg.search import concept_neighbors, reverse_lookup
from kg.store import KgStore

WEB_DIR = Path(__file__).parent / "web_kg"
_SHEET_CAP_ROWS = 300
_SHEET_CAP_COLS = 40


class ReviewAction(BaseModel):
    mapping_id: str
    action: str            # approve / reject


def _grid_json(structure, sheet_name: str) -> dict:
    sheet = next((s for s in structure.sheets if s.sheet_name == sheet_name), None)
    if sheet is None:
        raise HTTPException(404, f"sheet not found: {sheet_name}")
    from openpyxl.utils import range_boundaries
    spans: dict[str, tuple[int, int]] = {}
    for rng in sheet.merged_ranges:
        a, b, c, d = range_boundaries(rng)
        spans[rng] = (d - b + 1, c - a + 1)          # (rowspan, colspan)
    cells = []
    max_r = max_c = 1
    for cell in sheet.cells:
        if cell.row > _SHEET_CAP_ROWS or cell.col > _SHEET_CAP_COLS:
            continue
        if cell.merged_into:                          # 병합 피복 셀은 마스터가 그린다
            max_r, max_c = max(max_r, cell.row), max(max_c, cell.col)
            continue
        rs, cs = spans.get(cell.merged_range or "", (1, 1))
        v = cell.cached_value if cell.is_formula and cell.cached_value is not None \
            else cell.value
        cells.append({
            "r": cell.row, "c": cell.col,
            "v": "" if v is None else str(v),
            "b": 1 if cell.bold else 0,
            "f": f"#{cell.fill_rgb[-6:]}" if cell.fill_rgb else None,
            "rs": rs, "cs": cs,
        })
        max_r = max(max_r, cell.row + rs - 1)
        max_c = max(max_c, cell.col + cs - 1)
    return {"sheet": sheet_name, "max_row": min(max_r, _SHEET_CAP_ROWS),
            "max_col": min(max_c, _SHEET_CAP_COLS), "cells": cells,
            "truncated": sheet.max_row > _SHEET_CAP_ROWS or
                         sheet.max_col > _SHEET_CAP_COLS}


def create_app(ws_root: str | Path) -> FastAPI:
    root = Path(ws_root).resolve()
    store = KgStore(root / "data" / "kg" / "kg.db", threadsafe=True)
    lock = threading.Lock()
    inspector = WorkbookInspector()
    struct_cache: dict[tuple[str, float], object] = {}

    app = FastAPI(title="KG viewer", docs_url=None, redoc_url=None)

    def _doc_path(document_id: str) -> Path:
        with lock:
            row = store.conn.execute(
                "SELECT filepath, filename FROM document WHERE document_id=?",
                (document_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "unknown document")
        p = Path(row["filepath"] or "").resolve()
        if not p.exists() or p.suffix.lower() != ".xlsx":
            # 경로가 이사했으면 워크스페이스 raw에서 같은 이름을 찾는다
            fallback = root / "data" / "raw" / row["filename"]
            if not fallback.exists():
                raise HTTPException(404, f"file missing: {row['filename']}")
            p = fallback
        return p

    def _structure(path: Path):
        key = (str(path), path.stat().st_mtime)
        if key not in struct_cache:
            struct_cache.clear()                      # 파일당 1개만 유지 (경량)
            struct_cache[key] = inspector.inspect(path)
        return struct_cache[key]

    # ------------------------------------------------------------- reads ----
    @app.get("/api/documents")
    def documents():
        with lock:
            rows = store.conn.execute(
                """SELECT d.document_id, d.filename,
                          count(DISTINCT n.node_id) nodes
                   FROM document d
                   LEFT JOIN tree_node n ON n.document_id=d.document_id
                        AND n.status='ACTIVE' AND n.node_type='HEADER'
                   GROUP BY d.document_id ORDER BY d.filename""").fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/concepts")
    def concepts():
        with lock:
            rows = store.conn.execute(
                """SELECT c.concept_id, c.canonical_name, c.domain_level,
                          count(m.mapping_id) sources
                   FROM domain_concept c
                   LEFT JOIN semantic_mapping m ON m.concept_id=c.concept_id
                        AND m.is_active=1 AND m.status IN ('AUTO_APPROVED','APPROVED')
                   WHERE c.status='ACTIVE'
                   GROUP BY c.concept_id ORDER BY sources DESC, c.concept_id""").fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/search")
    def search(concept: str):
        with lock:
            cid = concept
            if store.concept(cid) is None:            # 이름/동의어로도 검색
                row = store.conn.execute(
                    "SELECT concept_id FROM domain_alias WHERE alias_norm=? LIMIT 1",
                    (normalize_label(concept),)).fetchone()
                if row is None:
                    raise HTTPException(404, f"unknown concept: {concept}")
                cid = row["concept_id"]
            res = reverse_lookup(store, cid, include_review=True)
            # 뷰어 점프에 필요한 document_id 부착
            for s in res["sources"]:
                n = store.node(s.pop("node_id"))
                s.pop("payload_id", None)
                s["document_id"] = n["document_id"] if n else None
            # 지식 그래프 1-hop 이웃 (이웃별 연결 소스 수 포함 — 탐색 단서)
            neighbors = concept_neighbors(store, cid)
            counts = {r["concept_id"]: r["n"] for r in store.conn.execute(
                """SELECT concept_id, count(*) n FROM semantic_mapping
                   WHERE is_active=1 AND status IN ('AUTO_APPROVED','APPROVED')
                   GROUP BY concept_id""")}
            for e in neighbors:
                other = e["target_concept_id"] if e["source_concept_id"] == cid \
                    else e["source_concept_id"]
                e["other_sources"] = counts.get(other, 0)
        res["neighbors"] = neighbors
        res["concept"] = {k: res["concept"][k] for k in
                          ("concept_id", "canonical_name", "description",
                           "canonical_unit") if k in res["concept"].keys()}
        return res

    @app.get("/api/review")
    def review_queue(limit: int = 30):
        with lock:
            rows = store.conn.execute(
                """SELECT m.mapping_id, m.concept_id, m.confidence,
                          n.node_name, n.locator, n.document_id, d.filename,
                          e.reason
                   FROM semantic_mapping m
                   JOIN tree_node n ON n.node_id=m.tree_node_id
                   JOIN document d ON d.document_id=n.document_id
                   LEFT JOIN mapping_evidence e ON e.mapping_id=m.mapping_id
                   WHERE m.status='REVIEW_REQUIRED' AND m.is_active=1
                     AND n.status='ACTIVE'
                   ORDER BY m.confidence DESC LIMIT ?""", (limit,)).fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/sheet")
    def sheet(doc: str, name: str | None = None):
        path = _doc_path(doc)
        structure = _structure(path)
        names = [s.sheet_name for s in structure.sheets]
        target = name or (names[0] if names else None)
        if target is None:
            raise HTTPException(404, "empty workbook")
        return {"document_id": doc, "sheets": names, **_grid_json(structure, target)}

    # ------------------------------------------------------------- write ----
    @app.post("/api/review")
    def review_act(body: ReviewAction):
        if body.action not in ("approve", "reject"):
            raise HTTPException(400, "action must be approve|reject")
        if not re.match(r"^MAP-[0-9a-f]{12}$", body.mapping_id):
            raise HTTPException(400, "bad mapping id")
        with lock:
            row = store.conn.execute(
                "SELECT 1 FROM semantic_mapping WHERE mapping_id=? AND is_active=1",
                (body.mapping_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown mapping")
            store.review(body.mapping_id, body.action.upper(), "web")
            store.commit()
        return JSONResponse({"ok": True})

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="static")
    return app


def main() -> int:
    import argparse

    import uvicorn
    p = argparse.ArgumentParser(prog="kg.webapp")
    p.add_argument("--ws", default=".", type=Path)
    p.add_argument("--port", default=8010, type=int)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()
    uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
