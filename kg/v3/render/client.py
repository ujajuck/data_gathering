"""`RenderClient`(§5 client.py): 메인 API가 렌더 서버에 닿는 한 가지 길.

http 모드(`url` 또는 `KG_V3_RENDER_URL`)는 httpx `Timeout(connect=0.5, read=2.0)`으로 절대 렌더 완료를 기다리지 않는다.
in-process 모드는 같은 `RenderWorker`/`RenderCache`를 스레드로 띄운다. 두 모드는 같은 모양의 결과를 돌려준다:
`{status: cached|queued|rendering|failed|not_modified|not_rendered, http_status, body, etag}`.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx

from ..db import Problem
from ..jobs import env
from .cache import RenderCache
from .server import RenderWorker

TIMEOUT = httpx.Timeout(connect=0.5, read=2.0, write=2.0, pool=2.0)


class RenderUnavailable(Problem):
    def __init__(self, message="렌더 서버에 연결할 수 없습니다."):
        super().__init__("RENDER_UNAVAILABLE", message, 503)


def _status_of(http_status, body):
    if http_status == 304:
        return "not_modified"
    if http_status == 200:
        return "cached"
    if http_status == 202 and isinstance(body, dict):
        return body.get("status", "queued")
    if http_status == 404 and isinstance(body, dict) and (body.get("error") or {}).get("code") == "NOT_RENDERED":
        return "not_rendered"
    return "failed"


class RenderClient:
    def __init__(self, root, url=None, event_source=None, transport=None, worker=None):
        self.root = Path(root).resolve()
        self.url = (url or os.environ.get("KG_V3_RENDER_URL") or "").rstrip("/")
        self.mode = "http" if self.url else "inprocess"
        self.http = None
        self.worker = None
        if self.mode == "http":
            # 렌더 서버도 같은 접근 토큰을 요구하므로 매 요청에 실어 보낸다.
            token = env("ACCESS_TOKEN", "")
            headers = {"Authorization": "Bearer " + token} if token else None
            self.http = httpx.Client(base_url=self.url, timeout=TIMEOUT, transport=transport, headers=headers)
        else:
            self.worker = worker or RenderWorker(self.root, RenderCache(self.root), event_source)
            self.worker.start()

    def close(self):
        if self.http is not None:
            self.http.close()
        if self.worker is not None:
            self.worker.close()

    # ---- 공통 ------------------------------------------------------------------------
    @staticmethod
    def _result(http_status, body, headers):
        return {
            "status": _status_of(http_status, body),
            "http_status": http_status,
            "body": body,
            "etag": (headers or {}).get("ETag") or (headers or {}).get("etag"),
        }

    def _call(self, method, path, json=None, headers=None, params=None):
        try:
            response = self.http.request(method, path, json=json, headers=headers or {}, params=params)
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RenderUnavailable() from exc
        return response

    def _json_call(self, method, path, json=None, headers=None, params=None):
        response = self._call(method, path, json, headers, params)
        body = None
        if response.status_code != 304 and response.content:
            try:
                body = response.json()
            except ValueError:
                raise RenderUnavailable("렌더 서버 응답을 해석할 수 없습니다.") from None
        return self._result(response.status_code, body, response.headers)

    # ---- 연산 ------------------------------------------------------------------------
    def request(
        self,
        snapshot_id,
        sheet_id,
        sheet_name,
        provider,
        source_ref,
        expected_token,
        principal,
        range=None,
        if_none_match=None,
    ):
        """POST /render과 같은 의미: 캐시면 창을 돌려주고 아니면 (멱등) 큐에 넣는다."""
        payload = {
            "snapshot_id": snapshot_id,
            "sheet_id": sheet_id,
            "sheet_name": sheet_name,
            "provider": provider,
            "source_ref": source_ref,
            "expected_token": expected_token,
            "range": range,
            "principal": principal,
        }
        if self.mode == "http":
            headers = {"If-None-Match": if_none_match} if if_none_match else None
            return self._json_call("POST", "/render", payload, headers)
        try:
            status, body, headers = self.worker.submit(payload, if_none_match)
        except Problem as exc:
            return self._result(exc.status, {"error": {"code": exc.code, "message": exc.message}}, {})
        return self._result(status, body, headers)

    def window(self, snapshot_id, sheet_id, range=None, if_none_match=None):
        """GET /render/{sid}/sheet/{sheet_id}?range= 과 같은 의미(큐에 넣지 않는다)."""
        if self.mode == "http":
            headers = {"If-None-Match": if_none_match} if if_none_match else None
            params = {"range": range} if range else None
            return self._json_call("GET", f"/render/{snapshot_id}/sheet/{sheet_id}", None, headers, params)
        try:
            status, body, headers = self.worker.get(snapshot_id, sheet_id, range, if_none_match)
        except Problem as exc:
            return self._result(exc.status, {"error": {"code": exc.code, "message": exc.message}}, {})
        return self._result(status, body, headers)

    def sheets(self, snapshot_id):
        if self.mode == "http":
            result = self._json_call("GET", f"/render/{snapshot_id}/sheets")
            if result["http_status"] != 200:
                error = (result["body"] or {}).get("error") or {}
                raise Problem(error.get("code", "NOT_FOUND"), error.get("message", "요청한 항목을 찾을 수 없습니다."), result["http_status"])
            return result["body"]
        return self.worker.sheets(snapshot_id)

    def asset(self, snapshot_id, asset_id):
        """(bytes, media_type, etag) | None."""
        if self.mode == "http":
            response = self._call("GET", f"/render/{snapshot_id}/assets/{asset_id}")
            if response.status_code != 200:
                return None
            return response.content, response.headers.get("content-type", "application/octet-stream"), response.headers.get("ETag")
        path = self.worker.cache.asset_path(snapshot_id, asset_id)
        if path is None:
            return None
        return path.read_bytes(), self.worker.cache.media_type(asset_id), f'"{asset_id}"'

    def invalidate(self, snapshot_id):
        if self.mode == "http":
            return self._json_call("DELETE", f"/render/{snapshot_id}")["body"]
        return self.worker.invalidate(snapshot_id)

    def status(self):
        if self.mode == "http":
            return self._json_call("GET", "/render/status")["body"]
        return self.worker.status()
