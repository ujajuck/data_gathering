"""File Watcher — polling scanner + 안정화 검사 + debounce (설계문서 §8.4, §15).

이벤트를 직접 처리하지 않고 queue에 넣고 coalesce 한다. 저장 중인 파일을
읽지 않도록 (size, mtime)이 연속 스캔에서 동일할 때만 안정으로 판단한다.
watchdog이 설치되어 있으면 이벤트 소스로 쓸 수 있지만 폴링만으로도 완결된다.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class FileState:
    size: int
    mtime: float
    stable_count: int = 0


@dataclass
class IngestEvent:
    kind: str            # created / modified / deleted
    path: str


class StabilityGuard:
    """(size, mtime)이 required_stable 회 연속 동일해야 안정 판정."""

    def __init__(self, required_stable: int = 2):
        self.required_stable = required_stable
        self._states: dict[str, FileState] = {}

    def observe(self, path: Path) -> bool:
        st = path.stat()
        key = str(path)
        prev = self._states.get(key)
        if prev and prev.size == st.st_size and prev.mtime == st.st_mtime:
            prev.stable_count += 1
        else:
            self._states[key] = FileState(size=st.st_size, mtime=st.st_mtime, stable_count=1)
        return self._states[key].stable_count >= self.required_stable

    def forget(self, path: str) -> None:
        self._states.pop(path, None)


def wait_until_stable(path: Path, interval: float = 0.2, timeout: float = 30.0) -> None:
    guard = StabilityGuard(required_stable=2)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if guard.observe(path):
            return
        time.sleep(interval)
    raise TimeoutError(f"file never stabilized: {path}")


@dataclass
class FileEventWatcher:
    """raw 디렉터리를 스캔해 변경 파일 목록을 만든다 (다중 파일 대응)."""

    raw_dir: Path
    patterns: tuple[str, ...] = ("*.xlsx", "*.xlsm")
    known: dict[str, str] = field(default_factory=dict)  # path -> f"{size}:{mtime}"
    guard: StabilityGuard = field(default_factory=StabilityGuard)

    def scan_once(self) -> list[IngestEvent]:
        events: list[IngestEvent] = []
        present: set[str] = set()
        for pattern in self.patterns:
            for p in sorted(Path(self.raw_dir).glob(pattern)):
                if p.name.startswith("~$"):
                    continue  # Excel lock/temp file
                key = str(p)
                present.add(key)
                st = p.stat()
                sig = f"{st.st_size}:{st.st_mtime_ns}"
                if not self.guard.observe(p):
                    continue  # 저장 중 — 다음 스캔에서 재시도
                if key not in self.known:
                    self.known[key] = sig
                    events.append(IngestEvent("created", key))
                elif self.known[key] != sig:
                    self.known[key] = sig
                    events.append(IngestEvent("modified", key))
        for key in list(self.known):
            if key not in present:
                del self.known[key]
                self.guard.forget(key)
                events.append(IngestEvent("deleted", key))
        return events

    def run(self, handler: Callable[[IngestEvent], None], interval: float = 2.0,
            stop_after: int | None = None) -> None:
        loops = 0
        while stop_after is None or loops < stop_after:
            for ev in self.scan_once():
                handler(ev)
            loops += 1
            time.sleep(interval)
