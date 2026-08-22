"""REST API 서버 (WEB_PLAN §1) — FastAPI로 §12 엔드포인트를 구현한다.

구성 원칙:
- 조회는 store.py의 페이지네이션/집계 SQL만 사용 (N+1 없음)
- 크기 고정 projection(stats/ontology/graph/documents)은 프로세스 캐시 + ETag
- 쓰기(매핑 승인, 재처리)는 기존 idempotent 파이프라인/사전 로직 호출
- SQLite 접근은 서버 전역 lock으로 직렬화 (§15)
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import yaml
from fastapi import Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.api import store
from src.api.queries import (
    document_versions,
    knowledge_graph_projection,
    load_relations,
    ontology_projection,
)
from src.pipeline import Pipeline


class DecisionIn(BaseModel):
    field_signature: str
    action: str = Field(pattern="^(approve|reject)$")
    concept_id: str | None = None
    approved_by: str = "web"
    promote_synonym: bool = True


class ReprocessIn(BaseModel):
    file: str | None = None
    force: bool = True


class AppState:
    def __init__(self, repo_root: Path, db_path: Path | None):
        self.repo_root = Path(repo_root)
        self.db_path = db_path
        self.lock = threading.RLock()
        self.cache: dict[str, tuple[str, dict]] = {}
        self.reload()

    def reload(self) -> None:
        old = getattr(self, "pipeline", None)
        self.pipeline = Pipeline(self.repo_root, db_path=self.db_path)
        store.register_functions(self.pipeline.loader.conn)
        self.relations = load_relations(self.repo_root / "config")
        self.cache.clear()
        if old is not None:
            try:
                old.loader.close()
            except Exception:
                pass

    @property
    def conn(self):
        return self.pipeline.loader.conn

    def freshness(self) -> str:
        return store.freshness_key(
            self.conn,
            self.pipeline.registry.version,
            self.pipeline.units.version,
            str(self.relations.get("version", "0")),
        )


def create_app(repo_root: Path | str = ".", db_path: Path | str | None = None,
               web_dir: Path | str | None = None) -> FastAPI:
    state = AppState(Path(repo_root), Path(db_path) if db_path else None)
    app = FastAPI(title="공정 데이터 온톨로지 API", version="1.0.0",
                  description="반정형 Excel 통합·DB화·DVC 변경추적 시스템의 조회/운영 API (설계문서 §12)")
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.ctx = state

    # -------------------------------------------------- cached projections ----
    def cached(name: str, request: Request, response: Response, build) -> Response | dict:
        with state.lock:
            etag = f'W/"{name}-{state.freshness()}"'
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304)
            hit = state.cache.get(name)
            if hit and hit[0] == etag:
                payload = hit[1]
            else:
                payload = build()
                state.cache[name] = (etag, payload)
            response.headers["ETag"] = etag
            response.headers["Cache-Control"] = "no-cache"
            return payload

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/stats")
    def stats(request: Request, response: Response):
        return cached("stats", request, response, lambda: store.stats(state.conn))

    @app.get("/api/ontology")
    def ontology(request: Request, response: Response):
        return cached("ontology", request, response,
                      lambda: ontology_projection(state.pipeline.registry))

    @app.get("/api/graph")
    def graph(request: Request, response: Response):
        return cached("graph", request, response,
                      lambda: knowledge_graph_projection(
                          state.pipeline.loader, state.pipeline.registry, state.relations))

    @app.get("/api/documents")
    def documents(request: Request, response: Response):
        def build():
            docs = store.documents_summary(state.conn)
            doc_concepts = store.document_concepts(state.conn)
            for d in docs:
                d["concepts"] = doc_concepts.get(d["logical_name"], [])
            return {"items": docs, "total": len(docs)}
        return cached("documents", request, response, build)

    @app.get("/api/documents/{name}/versions")
    def doc_versions(name: str):
        with state.lock:
            items = document_versions(state.pipeline.loader, name)
        if not items:
            raise HTTPException(404, f"document not found: {name}")
        return {"items": items, "total": len(items)}

    # ------------------------------------------------------------ concepts ----
    @app.get("/api/concepts")
    def concepts(domain: str | None = None, q: str | None = None,
                 used: bool = False, page: int = 1, size: int = 100):
        page, size = store.clamp_page(page, size)
        with state.lock:
            usage = store.concept_usage(state.conn)
        reg = state.pipeline.registry
        items = []
        needle = (q or "").lower()
        for c in reg.concepts.values():
            if domain and c.domain != domain:
                continue
            if used and c.concept_id not in usage:
                continue
            if needle and needle not in " ".join(
                    [c.concept_id, c.canonical_name_ko, c.canonical_name_en, *c.synonyms]).lower():
                continue
            u = usage.get(c.concept_id, {})
            items.append({
                "concept_id": c.concept_id, "name_ko": c.canonical_name_ko,
                "name_en": c.canonical_name_en, "domain": c.domain,
                "parent_concept": c.parent_concept, "canonical_unit": c.canonical_unit,
                "value_type": c.value_type, "synonyms": c.synonyms,
                "source_count": u.get("source_count", 0),
                "document_count": u.get("document_count", 0),
            })
        items.sort(key=lambda x: (-x["source_count"], x["concept_id"]))
        total = len(items)
        items = items[(page - 1) * size: page * size]
        return {"items": items, "page": page, "size": size, "total": total}

    @app.get("/api/concepts/{concept_id}/sources")
    def concept_sources(concept_id: str, page: int = 1, size: int = 50):
        if concept_id not in state.pipeline.registry.concepts:
            raise HTTPException(404, f"unknown concept: {concept_id}")
        with state.lock:
            return store.concept_sources_page(state.conn, concept_id, page, size)

    @app.get("/api/lineage/{concept_id}")
    def lineage(concept_id: str, lot: str | None = None):
        with state.lock:
            items = store.lineage(state.conn, concept_id, lot)
        return {"items": items, "total": len(items)}

    # ------------------------------------------------------- records / lots ----
    @app.get("/api/records")
    def records(page: int = 1, size: int = 50, type: str | None = None,
                lot: str | None = None, sheet: str | None = None,
                q: str | None = None, status: str | None = None):
        with state.lock:
            return store.records_page(state.conn, page, size, record_type=type,
                                      lot=lot, sheet=sheet, q=q, status=status)

    @app.get("/api/records/{record_key:path}/detail")
    def record_detail(record_key: str):
        with state.lock:
            out = store.record_detail(state.conn, record_key)
        if out is None:
            raise HTTPException(404, f"record not found: {record_key}")
        return out

    @app.get("/api/sheets")
    def sheets():
        with state.lock:
            return {"items": store.record_sheets(state.conn)}

    @app.get("/api/lots")
    def lots(page: int = 1, size: int = 50, q: str | None = None):
        with state.lock:
            return store.lots_page(state.conn, page, size, q)

    @app.get("/api/lots/{lot}")
    def lot_detail(lot: str):
        with state.lock:
            out = store.lot_detail(state.conn, lot)
        if out is None:
            raise HTTPException(404, f"lot not found: {lot}")
        return out

    # ------------------------------------------------------ mapping review ----
    @app.get("/api/mapping/pending")
    def mapping_pending(page: int = 1, size: int = 50):
        with state.lock:
            return store.pending_page(state.conn, page, size)

    @app.post("/api/mapping/decisions")
    def mapping_decide(body: DecisionIn):
        with state.lock:
            row = state.conn.execute(
                """SELECT * FROM mapping_decision WHERE field_signature=? AND decision='pending'
                   ORDER BY created_at DESC LIMIT 1""",
                (body.field_signature,),
            ).fetchone()
            if row is None:
                raise HTTPException(404, f"no pending decision for: {body.field_signature}")
            if body.action == "reject":
                state.conn.execute(
                    "UPDATE mapping_decision SET decision='rejected', approved_by=? WHERE mapping_id=?",
                    (body.approved_by, row["mapping_id"]),
                )
                state.conn.commit()
                state.cache.clear()   # freshness_key가 pending 수를 포함하므로 ETag도 함께 갱신됨
                return {"result": "rejected", "field_signature": body.field_signature}

            concept_id = body.concept_id or row["concept_id"]
            if not concept_id or concept_id not in state.pipeline.registry.concepts:
                raise HTTPException(422, f"approve requires a valid concept_id (got {concept_id!r})")
            state.conn.execute(
                """UPDATE mapping_decision SET decision='approved', approved_by=?, concept_id=?
                   WHERE mapping_id=?""",
                (body.approved_by, concept_id, row["mapping_id"]),
            )
            state.conn.commit()
            state.cache.clear()
            promoted = False
            if body.promote_synonym and row["raw_label"]:
                promoted = _promote_synonym(state, concept_id, row["raw_label"])
            return {"result": "approved", "concept_id": concept_id,
                    "synonym_promoted": promoted,
                    "note": "다음 ingest부터 새 사전 버전으로 재매핑됩니다 (§5.4)" if promoted else None}

    # ----------------------------------------------------------- operations ----
    @app.post("/api/ingestion/reprocess")
    def reprocess(body: ReprocessIn):
        with state.lock:
            pipe = state.pipeline
            if body.file:
                # path traversal 차단: data/raw 아래의 파일만 허용
                raw_root = (state.repo_root / "data" / "raw").resolve()
                path = (state.repo_root / body.file).resolve()
                if not path.is_relative_to(raw_root) or path.suffix.lower() not in (".xlsx", ".xlsm"):
                    raise HTTPException(422, "file은 data/raw 아래의 xlsx 경로여야 합니다")
                if not path.exists():
                    raise HTTPException(404, f"file not found: {body.file}")
                results = [pipe.process_file(path, trigger="api", force=body.force)]
            else:
                results = [pipe.process_file(p, trigger="api", force=body.force)
                           for p in sorted((state.repo_root / "data" / "raw").glob("*.xlsx"))
                           if not p.name.startswith("~$")]
            state.cache.clear()
            return {"results": results}

    @app.get("/api/jobs")
    def jobs(page: int = 1, size: int = 50):
        with state.lock:
            return store.jobs_page(state.conn, page, size)

    # ------------------------------------------------------------ frontend ----
    web = Path(web_dir) if web_dir else (Path(repo_root) / "web")
    if web.is_dir():
        app.mount("/", StaticFiles(directory=str(web), html=True), name="web")
    return app


def _promote_synonym(state: AppState, concept_id: str, raw_label: str) -> bool:
    """승인된 라벨을 concepts.yaml synonym으로 승격 + 사전 버전 bump (§5 학습 루프)."""
    path = state.repo_root / "config" / "concepts.yaml"
    cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    for c in cfg.get("concepts") or []:
        if c.get("concept_id") != concept_id:
            continue
        names = {c.get("canonical_name_ko"), c.get("canonical_name_en"),
                 *(c.get("synonyms") or [])}
        if raw_label in names:
            return False
        c.setdefault("synonyms", []).append(raw_label)
        old = str(cfg.get("version", "0"))
        cfg["version"] = str(int(old) + 1) if old.isdigit() else f"{old}.1"
        # 원자적 교체: truncate-후-쓰기 중 크래시로 사전 원본이 파손되지 않게 한다
        tmp = path.with_suffix(".yaml.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        state.reload()   # registry/mapper가 새 사전으로 재구성된다
        return True
    return False


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.api.server:app", host="0.0.0.0", port=8000, reload=False)
