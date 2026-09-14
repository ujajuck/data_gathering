"""raw 폴더의 XLSX를 v3 문서로 자동 등록한다(계약 §10 `watch`: 등록 + 자동 적용).

`kg.watch.FileEventWatcher`(폴링 + 안정화 판정)를 v2 `kg/v2/watch.py`와 같은 방식으로 재사용하고,
등록은 v3 `Service.register_documents`(작업 1개: describe 1회 → snapshot → auto_apply → 추출·발행)로 보낸다.
원본을 열어 저장하거나 해제본을 만들지 않는다.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from kg.watch import FileEventWatcher, IngestEvent

from .db import Problem
from .jobs import env
from .service import Service

REGISTER_WAIT = 600  # 등록 작업(추출 포함)이 끝날 때까지 기다리는 상한(초). 워커 스레드가 없으면 run_one으로 직접 실행된다.


class Watcher:
    def __init__(self, root, raw=None, provider="local-xlsx", principal=None, service=None):
        # 등록은 같은 스레드에서 작업을 직접 실행하므로(jobs.wait → run_one) 워커 스레드는 띄우지 않는다.
        self.service = service or Service(root)
        self.base = (self.service.root / "data/raw").resolve()
        self.raw = Path(raw).resolve() if raw else self.base
        if not self.raw.is_relative_to(self.base) or not self.raw.is_dir():
            raise Problem("INVALID_RAW_DIR", "감시 폴더는 <workspace>/data/raw 아래의 기존 폴더여야 합니다.")
        self.provider = provider
        self.principal = principal or env("PRINCIPAL", "local-user")
        self.watcher = FileEventWatcher(raw_dir=self.raw)

    def close(self):
        self.service.close()

    def source_ref(self, path) -> str:
        # 로컬 Reader 계약: data/raw 기준 상대경로. raw 밖을 가리키는 심볼릭 링크는 거부한다.
        try:
            return Path(path).resolve().relative_to(self.base).as_posix()
        except ValueError:
            raise Problem("OUTSIDE_RAW_DIR", "data/raw 밖을 가리키는 항목은 등록하지 않습니다.") from None

    def handle(self, event: IngestEvent) -> dict:
        try:
            line = {"event": event.kind, "source_ref": self.source_ref(event.path)}
        except Problem as exc:
            return {"event": event.kind, "path": Path(event.path).name, "skipped": exc.code, "message": exc.message}
        if event.kind == "deleted":
            return {**line, "skipped": "FILE_DELETED", "message": "파일이 사라졌습니다. 등록된 문서·snapshot은 삭제하지 않습니다."}
        try:
            job = self.service.register_documents([line["source_ref"]], self.provider, principal=self.principal, wait=REGISTER_WAIT)
        except Problem as exc:  # QUEUE_FULL 등 제출 단계 오류
            return {**line, "skipped": exc.code, "message": exc.message}
        except Exception as exc:  # 한 파일의 예외가 감시 루프를 멈추지 않게 한다.
            return {**line, "skipped": "REGISTER_FAILED", "message": type(exc).__name__}
        line["job_id"] = job["job_id"]
        if job["state"] != "succeeded":
            # 잠긴 파일(DRM_READER_REQUIRED)은 문서 행이 status='locked'로 남고 작업은 실패한다(§4.1).
            with self.service.db.connect() as conn:
                doc = conn.execute("SELECT document_id, status FROM document WHERE provider=? AND source_path=?", (self.provider, line["source_ref"])).fetchone()
            if doc:
                line.update(document_id=doc["document_id"], status=doc["status"])
            return {**line, "skipped": job.get("error_code") or job["state"], "message": job.get("error_message")}
        document = (job.get("result") or {}).get("documents", [{}])[0]
        if document.get("error"):
            return {**line, "document_id": document.get("document_id"), "status": document.get("status"), "skipped": document["error"]["code"], "message": document["error"]["message"]}
        snapshot = document.get("snapshot") or {}
        return {
            **line,
            "document_id": document.get("document_id"),
            "document_name": document.get("document_name"),
            "snapshot_id": snapshot.get("snapshot_id"),
            "revision_no": snapshot.get("revision_no"),
            "unchanged": snapshot.get("unchanged", False),
            "status": document.get("status"),
            "applied": document.get("applied") or [],
        }

    def scan(self) -> list[dict]:
        # 끊어진 링크·스캔 중 사라진 파일은 FileEventWatcher가 항목별로 건너뛴다. 여기서는 그 사실만 알린다.
        lines = []
        for pattern in self.watcher.patterns:
            for p in Path(self.raw).glob(pattern):
                if p.name.startswith("~$"):
                    continue
                try:
                    p.stat()
                except OSError:
                    lines.append({"event": "scan", "path": p.name, "skipped": "STAT_FAILED", "message": "끊어진 링크이거나 스캔 중 사라진 파일"})
        try:
            events = self.watcher.scan_once()
        except OSError as exc:  # 권한 변화 등 폴더 수준 실패
            return lines + [{"event": "scan", "skipped": "SCAN_FAILED", "message": type(exc).__name__}]
        return lines + [self.handle(e) for e in events]

    def run_once(self, settle=0.1) -> list[dict]:
        # StabilityGuard는 (size, mtime)이 두 번 연속 같아야 이벤트를 낸다.
        first = self.scan()
        time.sleep(settle)
        return first + self.scan()


def emit(line, out=None):
    print(json.dumps(line, ensure_ascii=False), file=out or sys.stdout, flush=True)


def run(root, raw=None, provider="local-xlsx", interval=2.0, once=False) -> int:
    try:
        watcher = Watcher(root, raw, provider)
    except Problem as exc:
        print(json.dumps({"error": exc.code, "message": exc.message}, ensure_ascii=False), file=sys.stderr)
        return 2
    try:
        if once:
            for line in watcher.run_once():
                emit(line)
            return 0
        while True:
            for line in watcher.scan():
                emit(line)
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
    finally:
        watcher.close()
