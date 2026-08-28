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

import json

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


class RemapAction(BaseModel):
    node_id: str
    concept_id: str


class ProposalReq(BaseModel):
    node_ids: list[str]


class BuildField(BaseModel):
    name: str
    concept: str
    unit: str | None = None
    type: str | None = None


class BuildReq(BaseModel):
    name: str
    fields: list[BuildField]
    include_nodes: dict[str, list[str]] = {}


def _node_role(node_meta: dict, data_type: str | None, concept_type: str | None) -> str:
    """Semantic Overlay 역할 (§4.2): KEY / VALUE / CONTEXT."""
    if concept_type in ("identifier", "temporal"):
        return "KEY"
    if (node_meta or {}).get("region_type") in ("KEY_VALUE", "SUMMARY", "NOTE"):
        return "CONTEXT"
    if data_type == "numeric":
        return "VALUE"
    return "CONTEXT"


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
            # 뷰어 점프/Inspector에 필요한 document_id·node_id 부착
            for s in res["sources"]:
                n = store.node(s["node_id"])
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
    def review_queue(limit: int = 50, doc: str | None = None):
        """검수 큐 (§9 Warning Badge) — doc 지정 시 그 파일의 순차 검수 목록."""
        where = "m.status='REVIEW_REQUIRED' AND m.is_active=1 AND n.status='ACTIVE'"
        params: list = []
        if doc:
            where += " AND n.document_id=?"
            params.append(doc)
        params.append(limit)
        with lock:
            rows = store.conn.execute(
                f"""SELECT m.mapping_id, m.concept_id, m.confidence, n.node_id,
                           n.node_name, n.locator, n.document_id, d.filename,
                           e.reason
                    FROM semantic_mapping m
                    JOIN tree_node n ON n.node_id=m.tree_node_id
                    JOIN document d ON d.document_id=n.document_id
                    LEFT JOIN mapping_evidence e ON e.mapping_id=m.mapping_id
                    WHERE {where}
                    ORDER BY m.confidence DESC LIMIT ?""", params).fetchall()
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

    # ---------------------------------------------- KG View Models (§8 v3) ----
    def _isa_roots():
        """concept → L1 루트 (IS_A 체인). Document KG의 묶음 축이 된다."""
        levels = {}
        parents = {}
        for r in store.conn.execute("SELECT concept_id, domain_level FROM domain_concept"):
            levels[r["concept_id"]] = r["domain_level"]
        for r in store.conn.execute(
                "SELECT source_concept_id s, target_concept_id t FROM domain_relation "
                "WHERE relation_type='IS_A'"):
            parents[r["s"]] = r["t"]
        roots = {}
        for cid in levels:
            cur, hops = cid, 0
            while levels.get(cur) != "L1" and cur in parents and hops < 6:
                cur = parents[cur]
                hops += 1
            roots[cid] = cur if levels.get(cur) == "L1" else None
        return roots, levels, parents

    def _document_kgs():
        """Document KG 도출(§4.3): L1 도메인 그룹별로, 그 그룹 개념에 매핑을
        제공하는 문서군 + 커버 노드 + 위치/값 수. Core 파생 View Model."""
        roots, levels, _ = _isa_roots()
        rows = store.conn.execute(
            """SELECT m.concept_id, n.document_id, d.filename, n.node_id,
                      n.locator, n.tree_path, c.canonical_name,
                      (SELECT p.row_count FROM data_payload p
                       WHERE p.tree_node_id=n.node_id AND p.is_current=1) rowc
               FROM semantic_mapping m
               JOIN tree_node n ON n.node_id=m.tree_node_id AND n.status='ACTIVE'
               JOIN document d ON d.document_id=n.document_id
               JOIN domain_concept c ON c.concept_id=m.concept_id
               WHERE m.is_active=1 AND m.status IN ('AUTO_APPROVED','APPROVED')
            """).fetchall()
        kgs: dict[str, dict] = {}
        for r in rows:
            root = roots.get(r["concept_id"])
            if root is None:
                continue
            g = kgs.setdefault(root, {"id": root, "nodes": {}, "docs": {},
                                      "sources": 0, "values": 0})
            g["nodes"].setdefault(r["concept_id"], 0)
            g["nodes"][r["concept_id"]] += 1
            doc = g["docs"].setdefault(r["document_id"], {
                "document_id": r["document_id"], "filename": r["filename"],
                "nodes": set(), "first_locator": r["locator"], "sources": 0})
            doc["nodes"].add(r["canonical_name"])
            doc["sources"] += 1
            g["sources"] += 1
            g["values"] += r["rowc"] or 0
        out = []
        for root, g in kgs.items():
            c = store.concept(root)
            out.append({
                "id": root,
                "name": (c["canonical_name"] if c else root) + " KG",
                "domain_node_ids": sorted(g["nodes"], key=lambda k: -g["nodes"][k]),
                "member_document_count": len(g["docs"]),
                "member_documents": sorted(
                    ({**d, "nodes": sorted(d["nodes"])} for d in g["docs"].values()),
                    key=lambda d: -d["sources"]),
                "source_location_count": g["sources"],
                "value_count": g["values"],
            })
        out.sort(key=lambda k: -k["source_location_count"])
        return out

    @app.get("/api/kg/domain")
    def kg_domain():
        """전체 Domain KG Snapshot (§8): 노드(레벨/그룹/소스수) + IS_A 엣지."""
        with lock:
            roots, levels, parents = _isa_roots()
            src_counts = {r["concept_id"]: r["n"] for r in store.conn.execute(
                """SELECT concept_id, count(*) n FROM semantic_mapping
                   WHERE is_active=1 AND status IN ('AUTO_APPROVED','APPROVED')
                   GROUP BY concept_id""")}
            nodes = [{
                "id": r["concept_id"], "name": r["canonical_name"],
                "level": r["domain_level"], "root": roots.get(r["concept_id"]),
                "parent": parents.get(r["concept_id"]),
                "sources": src_counts.get(r["concept_id"], 0),
            } for r in store.concepts()]
        return {"nodes": nodes,
                "edges": [{"s": s, "t": t} for s, t in parents.items()]}

    @app.get("/api/kg/document")
    def kg_document_list():
        with lock:
            kgs = _document_kgs()
        for g in kgs:                      # 목록은 요약만 (§7.3 데이터 많은 경우)
            g["member_document_ids"] = [d["document_id"] for d in g["member_documents"]]
            g["member_documents"] = g["member_documents"][:4]
        return kgs

    @app.get("/api/kg/document/{dkg_id}")
    def kg_document_detail(dkg_id: str):
        with lock:
            kgs = {g["id"]: g for g in _document_kgs()}
        if dkg_id not in kgs:
            raise HTTPException(404, "unknown document kg")
        return kgs[dkg_id]

    @app.get("/api/files")
    def files():
        """S01 파일 분석: 파일별 Ready/Review 상태·매핑률·검토 건수 (§3, §6.1)."""
        with lock:
            rows = store.conn.execute(
                """SELECT d.document_id, d.filename,
                     (SELECT count(DISTINCT substr(n.tree_path,
                          instr(n.tree_path,'/')+1,
                          CASE WHEN instr(substr(n.tree_path, instr(n.tree_path,'/')+1),'/')=0
                               THEN length(n.tree_path)
                               ELSE instr(substr(n.tree_path, instr(n.tree_path,'/')+1),'/')-1 END))
                      FROM tree_node n WHERE n.document_id=d.document_id
                        AND n.status='ACTIVE' AND n.node_type='SHEET') sheets,
                     count(h.node_id) headers,
                     sum(CASE WHEN m.status IN ('AUTO_APPROVED','APPROVED') THEN 1 ELSE 0 END) mapped,
                     sum(CASE WHEN m.status='REVIEW_REQUIRED' THEN 1 ELSE 0 END) review
                   FROM document d
                   LEFT JOIN tree_node h ON h.document_id=d.document_id
                        AND h.status='ACTIVE' AND h.node_type='HEADER'
                   LEFT JOIN semantic_mapping m ON m.tree_node_id=h.node_id AND m.is_active=1
                   GROUP BY d.document_id ORDER BY d.filename""").fetchall()
        out = []
        for r in rows:
            headers = r["headers"] or 0
            mapped = r["mapped"] or 0
            review = r["review"] or 0
            status = "ERROR" if headers == 0 else \
                ("REVIEW_REQUIRED" if review > 0 else "READY")
            out.append({
                "document_id": r["document_id"], "filename": r["filename"],
                "sheets": r["sheets"] or 0, "headers": headers,
                "coverage_pct": round(100 * mapped / headers, 1) if headers else 0,
                "review": review, "status": status})
        return out

    @app.get("/api/overlay")
    def overlay(doc: str, name: str):
        """활성 시트의 Semantic Overlay (§4.2): 매핑된 영역의 role/개념/범위."""
        with lock:
            rows = store.conn.execute(
                """SELECT n.node_id, n.node_name, n.locator, n.data_type, n.metadata,
                          m.concept_id, m.confidence, m.status,
                          c.canonical_name, c.concept_type
                   FROM tree_node n
                   JOIN semantic_mapping m ON m.tree_node_id=n.node_id AND m.is_active=1
                   LEFT JOIN domain_concept c ON c.concept_id=m.concept_id
                   WHERE n.document_id=? AND n.status='ACTIVE' AND n.node_type='HEADER'
                     AND m.status IN ('AUTO_APPROVED','APPROVED','REVIEW_REQUIRED',
                                      'UNMAPPED')""", (doc,)).fetchall()
        out = []
        for r in rows:
            loc = r["locator"] or ""
            # 시트 부분 완전일치 — LIKE의 '_'/'%' 와일드카드 과매칭을 배제한다
            if loc.rsplit("!", 1)[0] != name:
                continue
            rng = loc.rsplit("!", 1)[-1]
            meta = json.loads(r["metadata"] or "{}")
            role = "IGNORE" if r["status"] == "UNMAPPED" else \
                _node_role(meta, r["data_type"], r["concept_type"])
            out.append({
                "node_id": r["node_id"], "header": r["node_name"], "range": rng,
                "role": role,
                "concept_id": r["concept_id"], "concept_name": r["canonical_name"],
                "confidence": round(r["confidence"], 2), "status": r["status"]})
        return out

    @app.get("/api/source/{node_id}")
    def source_detail(node_id: str):
        """S03 Inspector (§4.1 우측): 영역/역할/개념/값 Preview/Row Context."""
        with lock:
            n = store.node(node_id)
            if n is None:
                raise HTTPException(404, "unknown node")
            meta = json.loads(n["metadata"] or "{}")
            m = store.active_mapping(node_id)
            concept = store.concept(m["concept_id"]) if m and m["concept_id"] else None
            ev = store.conn.execute(
                "SELECT candidates_json FROM mapping_evidence WHERE mapping_id=?",
                (m["mapping_id"],)).fetchone() if m else None
            pv = store.conn.execute(
                """SELECT pv.row_key, pv.value_num, pv.value_text, pv.cell_address
                   FROM payload_value pv JOIN data_payload p ON p.payload_id=pv.payload_id
                   WHERE p.tree_node_id=? AND p.is_current=1
                   ORDER BY pv.row_idx LIMIT 8""", (node_id,)).fetchall()
            doc = store.conn.execute(
                "SELECT filename FROM document WHERE document_id=?",
                (n["document_id"],)).fetchone()
        parts = (n["tree_path"] or "").split("/")
        return {
            "node_id": node_id, "header": n["node_name"],
            "document_id": n["document_id"],
            "document": doc["filename"] if doc else "",
            "sheet": parts[1] if len(parts) > 1 else "",
            "range": (n["locator"] or "").rsplit("!", 1)[-1],
            "unit": n["unit"], "data_type": n["data_type"],
            "role": _node_role(meta, n["data_type"],
                               concept["concept_type"] if concept else None),
            "mapping": {
                "mapping_id": m["mapping_id"], "concept_id": m["concept_id"],
                "confidence": round(m["confidence"], 2), "status": m["status"],
            } if m else None,
            "concept_name": concept["canonical_name"] if concept else None,
            "candidates": json.loads(ev["candidates_json"])[:5] if ev else [],
            "row_context": {
                "keys": [h for h in (meta.get("adjacent_headers") or [])][:4],
                "header_path": meta.get("header_path") or [],
            },
            "values": [{
                "key": p["row_key"],
                "value": p["value_num"] if p["value_num"] is not None else p["value_text"],
                "cell": p["cell_address"]} for p in pv],
        }

    @app.post("/api/proposal")
    def proposal(body: ProposalReq):
        """S04: 선택 노드 묶음 → Row Context 기반 통합 스키마 제안 (§5.1)."""
        with lock:
            by_concept: dict[str, dict] = {}
            docs: set[str] = set()
            stale: list[str] = []
            for nid in body.node_ids[:500]:
                n = store.node(nid)
                m = store.active_mapping(nid) if n else None
                if n is None or n["status"] != "ACTIVE" or m is None \
                        or not m["concept_id"]:
                    stale.append(nid)   # 재적재로 사라졌거나 매핑 해제된 위치
                    continue
                c = store.concept(m["concept_id"])
                if c is None:
                    stale.append(nid)
                    continue
                usable = m["status"] in ("AUTO_APPROVED", "APPROVED")
                g = by_concept.setdefault(m["concept_id"], {
                    "concept_id": c["concept_id"], "concept_name": c["canonical_name"],
                    "field_name": re.sub(r"[^A-Za-z0-9_]", "_",
                                         (c["canonical_name_en"] or c["concept_id"])
                                         .strip().lower().replace(" ", "_")) or c["concept_id"],
                    "target_unit": c["canonical_unit"], "type": c["data_type"],
                    "units": set(), "sources": 0, "review": 0, "node_ids": [],
                    "role": None})
                if usable:
                    # build와 같은 자격 기준 — REVIEW_REQUIRED는 승인 전까지 제외
                    g["sources"] += 1
                    g["node_ids"].append(nid)
                else:
                    g["review"] += 1
                if n["unit"]:
                    g["units"].add(n["unit"])
                meta = json.loads(n["metadata"] or "{}")
                g["role"] = g["role"] or _node_role(meta, n["data_type"], c["concept_type"])
                doc = store.conn.execute(
                    "SELECT filename FROM document WHERE document_id=?",
                    (n["document_id"],)).fetchone()
                if doc:
                    docs.add(doc["filename"])
        fields = []
        for g in by_concept.values():
            units = sorted(g.pop("units"))
            tgt = g["target_unit"]
            note = (f"{'/'.join(units)} → {tgt}" if tgt and units and
                    (len(units) > 1 or units[0] != tgt) else
                    (f"{tgt} 통일" if tgt else "타입 정규화"))
            if g["review"] and not g["sources"]:
                status, note = "검토", f"검토 대기 {g['review']}건 — 승인 후 포함됩니다"
            elif g["review"]:
                status = "검토"
                note += f" · 검토 대기 {g['review']}건 제외"
            elif len(units) > 1 and not tgt:
                status = "검토"
            else:
                status = "정상"
            fields.append({**g, "units": units, "note": note, "status": status})
        return {"fields": fields, "documents": sorted(docs), "stale_node_ids": stale}

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

    @app.post("/api/remap")
    def remap(body: RemapAction):
        """Inspector '매핑 수정' (§7.4): 사람이 개념을 확정 — APPROVED 매핑 생성."""
        with lock:
            if store.node(body.node_id) is None:
                raise HTTPException(404, "unknown node")
            if store.concept(body.concept_id) is None:
                raise HTTPException(404, "unknown concept")
            m = store.active_mapping(body.node_id)
            if m is not None:
                store.deactivate_mapping(m["mapping_id"], action="REMAP",
                                         note=f"web → {body.concept_id}")
            store.save_mapping(body.node_id, body.concept_id, 1.0, "human", "APPROVED",
                               context={}, candidates=[], reason="web remap")
            store.commit()
        return JSONResponse({"ok": True})

    @app.post("/api/build")
    def build_db(body: BuildReq):
        """S04→S05: 선택 묶음으로 통합 DB 생성, Schema/Lineage/Report 반환 (§5.3, §9)."""
        from src.units.converter import UnitRegistry

        from kg.integration.builder import build as run_build, define_project
        units_path = root / "config" / "units.yaml"
        units = UnitRegistry.load(units_path) if units_path.exists() else None
        config = {
            "name": body.name,
            "fields": [{"name": f.name, "concept": f.concept, "unit": f.unit,
                        "type": f.type} for f in body.fields],
            "sources": {"include_nodes": body.include_nodes or {}},
            "transform": [
                {"op": "unit_convert"},
                {"op": "union"},
                {"op": "deduplicate"},
            ],
        }
        with lock:
            from kg.integration.builder import delete_project
            iid = None
            try:
                iid = define_project(store, config)
                result = run_build(store, iid, root / "data" / "kg" / "builds",
                                   units=units)
            except (ValueError, KeyError) as e:
                if iid is not None:
                    delete_project(store, iid)   # 유령 프로젝트 버전 방지 (보상 삭제)
                raise HTTPException(400, str(e))
            # 결과 미리보기 + Schema/Lineage manifest (§9)
            import sqlite3 as _sq
            con = _sq.connect(result["output_db"])
            con.row_factory = _sq.Row
            try:
                actual_cols = {r[1] for r in con.execute(
                    f'PRAGMA table_info("{body.name}")')}
                preview = [dict(r) for r in con.execute(
                    f'SELECT * FROM "{body.name}" LIMIT 5')]
                lineage_docs = con.execute(
                    f'SELECT count(DISTINCT _source_document_id) FROM "{body.name}"'
                ).fetchone()[0]
            finally:
                con.close()
        # Schema Manifest는 산출물의 진실을 말한다 — 소스가 없어 탈락한 필드는
        # included=false + warning으로 드러낸다 (§9.2 Warning은 차단과 분리)
        warnings = list(result.get("warnings") or [])
        schema = []
        for f in body.fields:
            included = f.name in actual_cols
            schema.append({"field": f.name, "concept": f.concept, "unit": f.unit,
                           "type": f.type, "included": included})
            if not included:
                warnings.append({"op": "source_select", "field": f.name,
                                 "reason": "사용 가능한 소스가 없어 결과에서 제외됨 "
                                           "(검토 대기/매핑 해제 여부 확인)"})
        status = "COMPLETED_WITH_WARNINGS" if warnings else "COMPLETED"
        return {
            "status": status, "build_id": result["build_id"],
            "artifact": result["output_db"], "table": result["table"],
            "row_count": result["rows"],
            "schema": schema,
            "lineage": {"edges": result["lineage_edges"], "documents": lineage_docs},
            "build_report": {"frames": result["frames"], "warnings": warnings},
            "preview": preview,
        }

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
