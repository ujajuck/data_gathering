"""raw 폴더의 XLSX를 v2 문서 버전으로 자동 등록한다. 원본을 열어 저장하거나 해제본을 만들지 않는다."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from kg.watch import FileEventWatcher, IngestEvent

from .db import Problem
from .service import Service


class Watcher:
    def __init__(self, root, raw=None, provider="local-xlsx", principal=None):
        # register는 동기 호출이므로 작업 워커는 필요 없다.
        self.service = Service(root)
        self.base = (self.service.root / "data/raw").resolve()
        self.raw = Path(raw).resolve() if raw else self.base
        if not self.raw.is_relative_to(self.base) or not self.raw.is_dir():
            raise Problem(
                "INVALID_RAW_DIR",
                "감시 폴더는 <workspace>/data/raw 아래의 기존 폴더여야 합니다.",
            )
        self.provider = provider
        self.principal = principal or os.environ.get("KG_V2_PRINCIPAL", "local-user")
        self.watcher = FileEventWatcher(raw_dir=self.raw)

    def source_ref(self, path) -> str:
        # 로컬 Reader 계약: data/raw 기준 상대경로 (예: "sub/a.xlsx"). raw 밖을 가리키는 심볼릭 링크는 거부한다.
        try:
            return Path(path).resolve().relative_to(self.base).as_posix()
        except ValueError:
            raise Problem("OUTSIDE_RAW_DIR", "data/raw 밖을 가리키는 항목은 등록하지 않습니다.")

    def handle(self, event: IngestEvent) -> dict:
        try:
            line = {"event": event.kind, "source_ref": self.source_ref(event.path)}
        except Problem as exc:
            return {
                "event": event.kind,
                "path": Path(event.path).name,
                "skipped": exc.code,
                "message": exc.message,
            }
        if event.kind == "deleted":
            return {
                **line,
                "skipped": "FILE_DELETED",
                "message": "파일이 사라졌습니다. 등록된 문서·버전은 삭제하지 않습니다.",
            }
        try:
            result = self.service.register(
                line["source_ref"], self.provider, self.principal
            )
        except Problem as exc:  # DRM_READER_REQUIRED, READER_FAILED, SOURCE_NOT_FOUND 등
            return {**line, "skipped": exc.code, "message": exc.message}
        except Exception as exc:  # 한 파일의 예외가 감시 루프를 멈추지 않게 한다.
            return {**line, "skipped": "REGISTER_FAILED", "message": type(exc).__name__}
        with self.service.db.connect() as conn:
            revision = conn.execute(
                "SELECT revision_no FROM document_version WHERE document_version_id=?",
                (result["version_id"],),
            ).fetchone()[0]
        return {**line, **result, "revision_no": revision}

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
                    lines.append(
                        {"event": "scan", "path": p.name, "skipped": "STAT_FAILED",
                         "message": "끊어진 링크이거나 스캔 중 사라진 파일"}
                    )
        try:
            events = self.watcher.scan_once()
        except OSError as exc:  # 권한 변화 등 폴더 수준 실패
            return lines + [
                {"event": "scan", "skipped": "SCAN_FAILED", "message": type(exc).__name__}
            ]
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
        print(
            json.dumps({"error": exc.code, "message": exc.message}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2
    if once:
        for line in watcher.run_once():
            emit(line)
        return 0
    try:
        while True:
            for line in watcher.scan():
                emit(line)
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
