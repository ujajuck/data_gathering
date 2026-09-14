"""폴더 폴링 스캐너 + 안정화 검사 — `watch`가 쓰는 파일 변경 감지.

저장 중인 파일을 읽지 않도록 (size, mtime)이 연속 스캔에서 동일할 때만 안정으로 판단하고,
변경 목록만 만들어 돌려준다. 등록은 호출자(`schema.watch.Watcher`)가 한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


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
                try:
                    st = p.stat()
                except OSError:
                    # 끊어진 링크나 스캔 중 사라진 파일: 이 항목만 건너뛰고 다음 스캔에서 다시 본다.
                    self.guard.forget(key)
                    continue
                present.add(key)
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
