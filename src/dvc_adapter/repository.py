"""DVC adapter (설계문서 §8, §13 src.dvc_adapter).

DVC는 daemon이 아니므로 watcher/pipeline이 명령을 호출한다 (§8.4).
DVC CLI가 없는 환경에서는 HashOnlyDvc가 동일 인터페이스로 sha256 기반
버전 manifest(metadata/source_manifest.jsonl)를 유지해 파이프라인이
동작하도록 한다 — 원격/바이너리 보존만 빠지고 버전 lineage는 유지된다.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from src.common.hashing import sha256_file


@dataclass
class RawVersion:
    hash: str            # DVC hash 또는 sha256 fallback
    sha256: str
    path: str
    backend: str         # "dvc" | "hash-only"


class DvcRepository:
    """실제 DVC CLI wrapper. dvc add <path> → 새 hash, dvc push → remote 보존."""

    def __init__(self, repo_root: Path):
        self.repo_root = Path(repo_root)

    @staticmethod
    def available() -> bool:
        return shutil.which("dvc") is not None

    def _run(self, *args: str) -> str:
        out = subprocess.run(
            ["dvc", *args], cwd=self.repo_root, capture_output=True, text=True, check=True
        )
        return out.stdout

    def update_path(self, path: Path) -> RawVersion:
        rel = Path(path).resolve().relative_to(self.repo_root.resolve())
        self._run("add", str(rel))
        sha = sha256_file(path)
        # dvc add가 만든 pointer 파일에서 md5 해시를 읽는다
        dvc_hash = sha
        pointer = Path(path).with_suffix(Path(path).suffix + ".dvc")
        if pointer.exists():
            import yaml
            meta = yaml.safe_load(pointer.read_text(encoding="utf-8")) or {}
            outs = meta.get("outs") or []
            if outs and outs[0].get("md5"):
                dvc_hash = outs[0]["md5"]
        return RawVersion(hash=dvc_hash, sha256=sha, path=str(rel), backend="dvc")

    def push(self) -> None:
        self._run("push")


class HashOnlyDvc:
    """DVC 미설치 fallback: sha256 manifest로 파일별 버전 이력만 유지."""

    def __init__(self, repo_root: Path, manifest: Path | None = None):
        self.repo_root = Path(repo_root)
        self.manifest = manifest or (self.repo_root / "metadata" / "source_manifest.jsonl")
        self.manifest.parent.mkdir(parents=True, exist_ok=True)

    def update_path(self, path: Path) -> RawVersion:
        path = Path(path)
        sha = sha256_file(path)
        rel = str(path.resolve().relative_to(self.repo_root.resolve()))
        entry = {
            "path": rel,
            "sha256": sha,
            "size": path.stat().st_size,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(self.manifest, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return RawVersion(hash=sha, sha256=sha, path=rel, backend="hash-only")

    def push(self) -> None:  # remote 없음 — no-op
        return None


def make_dvc(repo_root: Path):
    return DvcRepository(repo_root) if DvcRepository.available() else HashOnlyDvc(repo_root)
