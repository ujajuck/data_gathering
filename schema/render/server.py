"""렌더 서버(§5 server.py): 단일 워커 스레드 큐 + FastAPI 엔드포인트. 렌더 자체는 Reader 격리 프로세스에서 돈다.

`RenderWorker`가 큐·상태·응답 조립을 모두 맡고, FastAPI 앱과 in-process `RenderClient`는 같은 메서드를 부른다
(두 모드가 같은 모양을 돌려주도록).
"""

from __future__ import annotations

import hmac
import logging
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from ..db import Problem, uid
from ..jobs import env
from . import RENDERER_VERSION
from .assemble import assemble
from .cache import RenderCache, valid_id

log = logging.getLogger(__name__)
FAILURE_TTL = 60
NO_CACHE = {"Cache-Control": "private, no-cache"}
RENDER_ROWS, RENDER_COLS = 2000, 200


def default_event_source(root, provider, principal, payload, checkpoint):
    from ..jobs import reader_events

    return reader_events(root, provider, principal, "render", payload, checkpoint)


def failure_body(exc: Problem):
    """Reader Problem → 실패 응답. SOURCE_VERSION_CHANGED는 SNAPSHOT_STALE 409, 4xx는 그대로, 그 외 422."""
    code, status = exc.code, exc.status
    if code == "SOURCE_VERSION_CHANGED":
        code, status = "SNAPSHOT_STALE", 409
    elif not 400 <= status < 500:
        status = 422
    return status, {"status": "failed", "error": {"code": code, "message": exc.message}, "retry_after": FAILURE_TTL}


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str = Field(min_length=36, max_length=36)
    provider: str = Field(min_length=1, max_length=64)
    source_ref: str = Field(min_length=1, max_length=1024)
    expected_token: str = Field(min_length=1, max_length=256)
    sheet_id: str = Field(min_length=36, max_length=36)
    sheet_name: str = Field(min_length=1, max_length=255)
    range: Optional[str] = Field(default=None, max_length=40)
    principal: Optional[str] = Field(default=None, max_length=128)


class RenderJob:
    __slots__ = ("job_id", "key", "request", "state", "error", "failed_at", "created_at")

    def __init__(self, key, request):
        self.job_id, self.key, self.request = uid(), key, request
        self.state, self.error, self.failed_at, self.created_at = "queued", None, None, time.monotonic()


class RenderWorker:
    """(snapshot_id, sheet_id) 키별 멱등 큐. submit/get은 (http_status, body, headers)를 돌려준다."""

    def __init__(self, root, cache=None, event_source=None, concurrency=None, queue_limit=None, principal=None):
        self.root = Path(root).resolve()
        self.cache = cache or RenderCache(self.root)
        self.event_source = event_source or default_event_source
        self.concurrency = int(concurrency or env("RENDER_CONCURRENCY", "1"))
        self.queue_limit = int(queue_limit or env("RENDER_QUEUE", "32"))
        self.principal = principal or env("PRINCIPAL", "render")
        self.cv = threading.Condition()
        self.queue: deque[RenderJob] = deque()
        self.jobs: dict[tuple, RenderJob] = {}
        self.rendering: set[tuple] = set()
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []

    # ---- 수명 ------------------------------------------------------------------------
    def start(self):
        if any(t.is_alive() for t in self.threads):
            return
        self.stop.clear()
        self.threads = [
            threading.Thread(target=self._loop, name=f"schema-render-{n}", daemon=True)
            for n in range(max(1, self.concurrency))
        ]
        for thread in self.threads:
            thread.start()

    def close(self):
        self.stop.set()
        with self.cv:
            self.cv.notify_all()
        for thread in self.threads:
            thread.join(timeout=3)

    # ---- 키·상태 ----------------------------------------------------------------------
    def key(self, snapshot_id, sheet_id):
        return (snapshot_id, sheet_id, self.cache.renderer_version)

    def _position(self, job):
        if job.state == "rendering":
            return 0
        try:
            return list(self.queue).index(job) + 1
        except ValueError:
            return 0

    def _pending(self, job):
        return 202, {"status": job.state, "job_id": job.job_id, "position": self._position(job)}, dict(NO_CACHE)

    def _lookup(self, key):
        """큐/실패 보관 상태. 60초 지난 실패는 잊는다(다음 POST가 다시 넣는다)."""
        job = self.jobs.get(key)
        if job and job.state == "failed" and time.monotonic() - job.failed_at > FAILURE_TTL:
            self.jobs.pop(key, None)
            return None
        return job

    def _window(self, key, range_text, if_none_match, sheet_name=None, wrap=False):
        effective = self.cache.effective_range(key, range_text)
        etag = self.cache.etag(key, effective)
        headers = {**NO_CACHE, "ETag": etag}
        if if_none_match and etag in [t.strip() for t in if_none_match.split(",")]:
            return 304, None, headers
        window = self.cache.window(key, range_text, sheet_name)
        return 200, ({"status": "cached", "sheet": window} if wrap else window), headers

    # ---- 요청 --------------------------------------------------------------------------
    def submit(self, request: dict, if_none_match=None):
        """POST /render. 캐시 200 | 진행 중이면 같은 작업으로 202(멱등) | 실패 보관 4xx | 큐에 넣고 202 | 큐 초과 503."""
        snapshot_id, sheet_id = request["snapshot_id"], request["sheet_id"]
        if not valid_id(snapshot_id) or not valid_id(sheet_id):
            raise Problem("INVALID_ID", "snapshot_id/sheet_id 형식이 올바르지 않습니다.", 422)
        key = self.key(snapshot_id, sheet_id)
        range_text = request.get("range")
        if self.cache.has(key):
            return self._window(key, range_text, if_none_match, request.get("sheet_name"), wrap=True)
        with self.cv:
            if self.cache.has(key):  # 잠금 사이에 완료된 경우
                pass
            else:
                job = self._lookup(key)
                if job is not None:
                    if job.state == "failed":
                        return (*failure_body(job.error), dict(NO_CACHE))
                    return self._pending(job)
                if len(self.queue) >= self.queue_limit:
                    raise Problem("RENDER_QUEUE_FULL", "렌더 대기열이 가득 찼습니다. 잠시 뒤 다시 시도하세요.", 503)
                job = RenderJob(key, dict(request))
                self.jobs[key] = job
                self.queue.append(job)
                self.cv.notify()
                self.start()
                return self._pending(job)
        return self._window(key, range_text, if_none_match, request.get("sheet_name"), wrap=True)

    def get(self, snapshot_id, sheet_id, range_text=None, if_none_match=None):
        """GET /render/{sid}/sheet/{sheet_id}. 200 창 | 202 | 4xx failed | 404 NOT_RENDERED."""
        if not valid_id(snapshot_id) or not valid_id(sheet_id):
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        key = self.key(snapshot_id, sheet_id)
        if self.cache.has(key):
            return self._window(key, range_text, if_none_match)
        with self.cv:
            job = self._lookup(key)
            if job is not None:
                if job.state == "failed":
                    return (*failure_body(job.error), dict(NO_CACHE))
                return self._pending(job)
        if self.cache.has(key):
            return self._window(key, range_text, if_none_match)
        raise Problem("NOT_RENDERED", "이 시트는 아직 렌더되지 않았습니다.", 404)

    def sheets(self, snapshot_id):
        if not valid_id(snapshot_id):
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        with self.cv:
            pending = [
                {"sheet_id": job.key[1], "sheet_name": job.request.get("sheet_name"), "status": job.state, "job_id": job.job_id}
                for job in self.jobs.values()
                if job.key[0] == snapshot_id and job.state != "failed"
            ]
        return {"snapshot_id": snapshot_id, "items": self.cache.sheets(snapshot_id), "pending": pending}

    def invalidate(self, snapshot_id):
        """세대를 올리고(진행 중 결과는 put에서 버려짐) 대기 중 작업과 실패 보관을 지운다."""
        if not valid_id(snapshot_id):
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        with self.cv:
            for key in [k for k in self.jobs if k[0] == snapshot_id]:
                job = self.jobs.pop(key)
                try:
                    self.queue.remove(job)
                except ValueError:
                    pass
            self.cache.invalidate(snapshot_id)
        return {"status": "invalidated", "snapshot_id": snapshot_id}

    def status(self):
        with self.cv:
            depth, rendering = len(self.queue), len(self.rendering)
        return {
            "queue_depth": depth,
            "rendering": rendering,
            "renderer_version": self.cache.renderer_version,
            "cache_bytes": self.cache.cache_bytes(),
        }

    # ---- 워커 --------------------------------------------------------------------------
    def _loop(self):
        while not self.stop.is_set():
            with self.cv:
                while not self.queue and not self.stop.is_set():
                    self.cv.wait(0.5)
                if self.stop.is_set():
                    return
                job = self.queue.popleft()
                job.state = "rendering"
                self.rendering.add(job.key)
            try:
                self._run(job)
            finally:
                with self.cv:
                    self.rendering.discard(job.key)
                    self.cv.notify_all()

    def _run(self, job):
        key, request = job.key, job.request
        snapshot_id = key[0]
        generation = self.cache.generation(snapshot_id)

        def checkpoint():
            if self.stop.is_set() or self.cache.generation(snapshot_id) != generation:
                raise Problem("CANCELLED", "렌더 중 스냅샷이 무효화되었습니다.", 409)

        payload = {
            "source_ref": request["source_ref"],
            "expected_token": request["expected_token"],
            "sheet_name": request["sheet_name"],
            "r1": 1,
            "c1": 1,
            "rows": RENDER_ROWS,
            "cols": RENDER_COLS,
        }
        try:
            events = self.event_source(
                self.root, request["provider"], request.get("principal") or self.principal, payload, checkpoint
            )
            assemble(events, self.cache, key, request["expected_token"], generation)
        except Problem as exc:
            self._finish(job, None if exc.code == "CANCELLED" else exc)
            return
        except Exception:
            log.exception("render failed: %s/%s", key[0], key[1])
            self._finish(job, Problem("RENDER_FAILED", "렌더에 실패했습니다. 서버 기록을 확인하세요.", 500))
            return
        self._finish(job, None)

    def _finish(self, job, error):
        with self.cv:
            if self.jobs.get(job.key) is not job:
                return  # invalidate로 이미 버려졌거나 새 작업으로 대체됨
            if error is None:
                self.jobs.pop(job.key, None)
            else:
                job.state, job.error, job.failed_at = "failed", error, time.monotonic()


def _problem_response(exc: Problem):
    body = {"error": {"code": exc.code, "message": exc.message}}
    if exc.fields:
        body["error"]["fields"] = exc.fields
    headers = dict(NO_CACHE)
    if exc.code == "RENDER_QUEUE_FULL":
        headers["Retry-After"] = "5"
    return JSONResponse(body, status_code=exc.status, headers=headers)


def _respond(status, body, headers):
    if status == 304:
        return Response(status_code=304, headers=headers)
    return JSONResponse(body, status_code=status, headers=headers)


def require_token(authorization: Optional[str] = Header(default=None)):
    """메인 API와 같은 접근 토큰(`SCHEMA_ACCESS_TOKEN`). 토큰이 설정돼 있으면 모든 렌더 엔드포인트가 요구한다."""
    token = env("ACCESS_TOKEN", "")
    if token and not hmac.compare_digest(authorization or "", "Bearer " + token):
        raise Problem("AUTH_REQUIRED", "서버 접근 토큰이 필요합니다.", 401)


def create_render_app(root, event_source=None, worker: RenderWorker | None = None):
    worker = worker or RenderWorker(root, event_source=event_source)

    @asynccontextmanager
    async def lifespan(app):
        worker.start()
        yield
        worker.close()

    app = FastAPI(title="Semantic Excel Integration render", docs_url=None, redoc_url=None, lifespan=lifespan, dependencies=[Depends(require_token)])
    app.state.worker = worker

    @app.exception_handler(Problem)
    async def on_problem(request: Request, exc: Problem):
        return _problem_response(exc)

    @app.exception_handler(RequestValidationError)
    async def on_validation(request: Request, exc: RequestValidationError):
        return _problem_response(Problem("INVALID_REQUEST", "요청 본문이 올바르지 않습니다.", 422))


    @app.post("/render")
    def post_render(body: RenderRequest, if_none_match: Optional[str] = Header(default=None)):
        return _respond(*worker.submit(body.model_dump(), if_none_match))

    @app.get("/render/status")
    def get_status():
        return JSONResponse(worker.status(), headers={"Cache-Control": "no-store"})

    @app.get("/render/{snapshot_id}/sheets")
    def get_sheets(snapshot_id: str):
        return JSONResponse(worker.sheets(snapshot_id), headers={"Cache-Control": "no-store"})

    @app.get("/render/{snapshot_id}/sheet/{sheet_id}")
    def get_sheet(
        snapshot_id: str,
        sheet_id: str,
        range: Optional[str] = None,
        if_none_match: Optional[str] = Header(default=None),
    ):
        return _respond(*worker.get(snapshot_id, sheet_id, range, if_none_match))

    @app.get("/render/{snapshot_id}/assets/{asset_id}")
    def get_asset(snapshot_id: str, asset_id: str, if_none_match: Optional[str] = Header(default=None)):
        path = worker.cache.asset_path(snapshot_id, asset_id)
        if path is None:
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        etag = f'"{asset_id}"'
        headers = {**NO_CACHE, "ETag": etag}
        if if_none_match and etag in [t.strip() for t in if_none_match.split(",")]:
            return Response(status_code=304, headers=headers)
        return FileResponse(path, media_type=worker.cache.media_type(asset_id), headers=headers)

    @app.delete("/render/{snapshot_id}")
    def delete_snapshot(snapshot_id: str):
        return JSONResponse(worker.invalidate(snapshot_id), headers={"Cache-Control": "no-store"})

    return app


def serve(root, host="127.0.0.1", port=8790):
    import uvicorn

    if host not in ("127.0.0.1", "localhost", "::1") and not env("ACCESS_TOKEN", ""):
        # 루프백 밖에 열면 누구나 snapshot을 읽고 Reader 프로세스를 띄울 수 있으므로 토큰 없이는 거부한다.
        raise Problem("ACCESS_TOKEN_REQUIRED", "루프백이 아닌 주소로 렌더 서버를 열려면 SCHEMA_ACCESS_TOKEN을 설정하세요.", 403)
    uvicorn.run(create_render_app(root), host=host, port=port, log_level="info")
