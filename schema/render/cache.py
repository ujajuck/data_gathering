"""렌더 캐시(§5 cache.py): 키 (snapshot_id, sheet_id, renderer_version) → 디렉터리, 창 응답은 교차 밴드만 읽는다.

디렉터리: <ws>/data/render-cache/<snapshot_id>/<sheet_id>.<renderer_version 파일명>/{meta.json, band-<r1>-<r2>.json}
          <ws>/data/render-cache/<snapshot_id>/assets/<sha256>.<ext>   (asset은 snapshot 안에만; 전역 공유 금지)
renderer_version의 '/'는 디렉터리 이름에서 '_'로 바꾼다(정확한 값은 meta.json에 있다).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path


from ..db import Problem, dump
from ..spec import address, bounds
from . import RENDERER_VERSION

ID_RE = re.compile(r"^[0-9a-f-]{36}$")
ASSET_RE = re.compile(r"^[0-9a-f]{64}\.(png|jpe?g|gif)$")
MEDIA_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif"}
WINDOW_ROWS, WINDOW_COLS = 120, 60
DEFAULT_RANGE = "A1:Z60"


def parse_range(value):
    """렌더 창 범위(A1:Z60 형태)를 (r1, c1, r2, c2)로 판다."""
    if value in (None, ""):
        value = DEFAULT_RANGE
    try:
        return bounds(value)
    except Problem as exc:
        raise Problem("INVALID_RANGE", exc.message, 422) from None


def valid_id(value):
    return isinstance(value, str) and bool(ID_RE.fullmatch(value))


def version_dirname(renderer_version):
    return renderer_version.replace("/", "_")


def _write_json(path: Path, payload):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(dump(payload), encoding="utf-8")
    os.replace(tmp, path)


def _dir_bytes(path: Path):
    total = 0
    for base, _, files in os.walk(path):
        for name in files:
            try:
                total += os.stat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


class RenderCache:
    def __init__(self, root, renderer_version=RENDERER_VERSION):
        self.root = Path(root).resolve()
        self.base = self.root / "data/render-cache"
        self.base.mkdir(parents=True, exist_ok=True)
        self.renderer_version = renderer_version
        self.version_dir = version_dirname(renderer_version)
        self.lock = threading.RLock()
        self.lru_limit = int(os.environ.get("SCHEMA_RENDER_LRU_MB", "256")) * 1024 * 1024
        self.disk_limit = int(os.environ.get("SCHEMA_RENDER_CACHE_MB", "4096")) * 1024 * 1024
        self.lru: OrderedDict[str, tuple[object, int]] = OrderedDict()
        self.lru_bytes = 0
        self.generations: dict[str, int] = {}
        self.snapshots: dict[str, dict] = {}  # snapshot_id → {"bytes", "touched"}
        self._startup_purge()

    # ---- 디렉터리 -----------------------------------------------------------------
    def snapshot_dir(self, snapshot_id):
        return self.base / snapshot_id

    def dir(self, key):
        snapshot_id, sheet_id, renderer_version = key
        return self.base / snapshot_id / f"{sheet_id}.{version_dirname(renderer_version)}"

    def assets_dir(self, snapshot_id):
        return self.base / snapshot_id / "assets"

    def _startup_purge(self):
        """현재 renderer_version이 아닌 시트 캐시와 미완성(.tmp) 디렉터리를 지우고 디스크 사용량을 센다."""
        for snapshot in self.base.iterdir():
            if not snapshot.is_dir() or not valid_id(snapshot.name):
                continue
            for entry in snapshot.iterdir():
                if entry.name == "assets" or not entry.is_dir():
                    continue
                sheet_id, _, version = entry.name.partition(".")
                if ".tmp" in entry.name or version != self.version_dir or not valid_id(sheet_id):
                    shutil.rmtree(entry, ignore_errors=True)
            self.snapshots[snapshot.name] = {
                "bytes": _dir_bytes(snapshot),
                "touched": snapshot.stat().st_mtime,
            }

    # ---- 세대 -----------------------------------------------------------------------
    def generation(self, snapshot_id):
        with self.lock:
            return self.generations.get(snapshot_id, 0)

    def invalidate(self, snapshot_id):
        """세대를 올려 진행 중 렌더 결과를 버리게 하고 snapshot 디렉터리 전체(asset 포함)를 지운다."""
        with self.lock:
            self.generations[snapshot_id] = self.generations.get(snapshot_id, 0) + 1
            self.snapshots.pop(snapshot_id, None)
            for path in [p for p in self.lru if p.startswith(str(self.snapshot_dir(snapshot_id)) + os.sep)]:
                _, size = self.lru.pop(path)
                self.lru_bytes -= size
        shutil.rmtree(self.snapshot_dir(snapshot_id), ignore_errors=True)

    # ---- 쓰기 -----------------------------------------------------------------------
    def stage(self, key):
        """assemble이 파일을 쓰는 임시 디렉터리. put에서 최종 이름으로 바꾼다."""
        final = self.dir(key)
        staging = final.with_name(final.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        return staging

    def discard(self, staging: Path):
        shutil.rmtree(staging, ignore_errors=True)

    def write_asset(self, snapshot_id, asset_id, ext, data: bytes):
        name = f"{asset_id}.{ext}"
        if not ASSET_RE.fullmatch(name):
            raise Problem("INVALID_ASSET", "이미지 자산 이름이 유효하지 않습니다.")
        directory = self.assets_dir(snapshot_id)
        directory.mkdir(parents=True, exist_ok=True)
        final = directory / name
        if not final.exists():
            tmp = final.with_name(name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, final)
        return name

    def put(self, key, staging: Path, generation=None):
        """스테이징 디렉터리를 최종 위치로 옮긴다. 같은 시트의 다른 renderer_version은 지우고 디스크 예산을 지킨다."""
        snapshot_id, sheet_id, _ = key
        final = self.dir(key)
        with self.lock:
            if generation is not None and generation != self.generations.get(snapshot_id, 0):
                self.discard(staging)
                raise Problem("CANCELLED", "렌더 중 스냅샷이 무효화되었습니다.", 409)
            snapshot_dir = self.snapshot_dir(snapshot_id)
            if snapshot_dir.exists():
                for entry in snapshot_dir.iterdir():
                    if entry.is_dir() and entry.name.startswith(sheet_id + ".") and entry != staging:
                        shutil.rmtree(entry, ignore_errors=True)
            os.replace(staging, final)
            for path in [p for p in self.lru if p.startswith(str(final) + os.sep)]:
                _, size = self.lru.pop(path)
                self.lru_bytes -= size
            self.snapshots[snapshot_id] = {"bytes": _dir_bytes(snapshot_dir), "touched": time.time()}
            self._evict_disk(keep=snapshot_id)

    def _evict_disk(self, keep):
        total = sum(s["bytes"] for s in self.snapshots.values())
        while total > self.disk_limit:
            candidates = [(s["touched"], sid) for sid, s in self.snapshots.items() if sid != keep]
            if not candidates:
                break
            _, victim = min(candidates)
            total -= self.snapshots[victim]["bytes"]
            self.invalidate(victim)

    # ---- 읽기 -----------------------------------------------------------------------
    def cache_bytes(self):
        with self.lock:
            return sum(s["bytes"] for s in self.snapshots.values())

    def has(self, key):
        return (self.dir(key) / "meta.json").is_file()

    def _load(self, path: Path):
        text = str(path)
        with self.lock:
            hit = self.lru.get(text)
            if hit is not None:
                self.lru.move_to_end(text)
                return hit[0]
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            raise Problem("NOT_RENDERED", "이 시트는 아직 렌더되지 않았습니다.", 404) from None
        value = json.loads(raw)
        with self.lock:
            if text not in self.lru:
                self.lru[text] = (value, len(raw))
                self.lru_bytes += len(raw)
                while self.lru_bytes > self.lru_limit and len(self.lru) > 1:
                    _, (_, size) = self.lru.popitem(last=False)
                    self.lru_bytes -= size
        return value

    def meta(self, key):
        return self._load(self.dir(key) / "meta.json")

    def sheets(self, snapshot_id):
        """캐시된 시트 목록(meta.json이 있는 것만). sheets 엔드포인트용."""
        out = []
        snapshot_dir = self.snapshot_dir(snapshot_id)
        if not snapshot_dir.is_dir():
            return out
        for entry in sorted(snapshot_dir.iterdir()):
            sheet_id, _, version = entry.name.partition(".")
            if version != self.version_dir or not valid_id(sheet_id) or not (entry / "meta.json").is_file():
                continue
            meta = self._load(entry / "meta.json")
            out.append(
                {
                    "sheet_id": sheet_id,
                    "sheet_name": meta["sheet"],
                    "renderer_version": meta["renderer_version"],
                    "rendered_bounds": meta["rendered_bounds"],
                    "truncated": meta["truncated"],
                    "estimated_rows": meta["estimated_rows"],
                    "estimated_cols": meta["estimated_cols"],
                }
            )
        return out

    def etag(self, key, range_text):
        snapshot_id, sheet_id, renderer_version = key
        raw = (renderer_version + snapshot_id + sheet_id + range_text).encode()
        return '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'

    def clamp(self, meta, range_text):
        """요청 범위를 검증(120×60)하고 캐시 범위로 자른다. 교차가 없으면 RANGE_OUT_OF_BOUNDS."""
        r1, c1, r2, c2 = parse_range(range_text)
        if r2 - r1 + 1 > WINDOW_ROWS or c2 - c1 + 1 > WINDOW_COLS:
            raise Problem(
                "RANGE_TOO_LARGE",
                f"표시 범위는 {WINDOW_ROWS}행 × {WINDOW_COLS}열 이내여야 합니다.",
                422,
                {"max_rows": WINDOW_ROWS, "max_cols": WINDOW_COLS},
            )
        bounds = meta["rendered_bounds"]
        lo_r, lo_c = meta.get("r1", 1), meta.get("c1", 1)
        w = (max(r1, lo_r), max(c1, lo_c), min(r2, bounds["r2"]), min(c2, bounds["c2"]))
        if w[0] > w[2] or w[1] > w[3]:
            raise Problem(
                "RANGE_OUT_OF_BOUNDS",
                "요청 범위가 렌더된 범위 밖입니다.",
                422,
                {"rendered_bounds": bounds},
            )
        return w

    def window(self, key, range_text=None, sheet_name=None):
        """창 JSON. meta.json + range와 교차하는 밴드만 읽고 열로 거른다 — O(창)."""
        snapshot_id, sheet_id, _ = key
        meta = self.meta(key)
        wr1, wc1, wr2, wc2 = self.clamp(meta, range_text)
        lo_r, lo_c = meta.get("r1", 1), meta.get("c1", 1)
        cells, seen = [], set()
        for band in meta["bands"]:
            if band["r2"] < wr1 or band["r1"] > wr2:
                continue
            data = self._load(self.dir(key) / f"band-{band['r1']}-{band['r2']}.json")
            for cell in data["cells"]:
                if cell["r1"] > wr2:
                    break  # 밴드는 행 순서라 창 아래로 내려가면 끝
                if cell["r2"] < wr1 or cell["c2"] < wc1 or cell["c1"] > wc2:
                    continue
                anchor = (cell["r1"], cell["c1"])
                if anchor in seen:
                    continue  # 여러 밴드에 걸친 병합 앵커의 복제본
                seen.add(anchor)
                if cell["r1"] < wr1 or cell["c1"] < wc1 or cell["r2"] > wr2 or cell["c2"] > wc2:
                    cell = {**cell, "clipped": True}
                cells.append(cell)
        merges = [m for m in meta["merges"] if m[2] >= wr1 and m[0] <= wr2 and m[3] >= wc1 and m[1] <= wc2]
        columns, rows = meta["columns"], meta["rows"]
        x1, y1 = columns[wc1 - lo_c]["x"], rows[wr1 - lo_r]["y"]
        x2 = columns[wc2 - lo_c]["x"] + columns[wc2 - lo_c]["width"]
        y2 = rows[wr2 - lo_r]["y"] + rows[wr2 - lo_r]["height"]
        images = [
            img
            for img in meta["images"]
            if img["x"] < x2 and img["x"] + img["width"] > x1 and img["y"] < y2 and img["y"] + img["height"] > y1
        ]
        with self.lock:
            if snapshot_id in self.snapshots:
                self.snapshots[snapshot_id]["touched"] = time.time()
        return {
            "renderer_version": meta["renderer_version"],
            "sheet": {"sheet_id": sheet_id, "sheet_name": sheet_name or meta["sheet"]},
            "range": address(wr1, wc1, wr2, wc2),
            "rows": rows,
            "columns": columns,
            "width": meta["width"],
            "height": meta["height"],
            "estimated_rows": meta["estimated_rows"],
            "estimated_cols": meta["estimated_cols"],
            "truncated": meta["truncated"],
            "rendered_bounds": meta["rendered_bounds"],
            "freeze": meta.get("freeze"),
            "styles": meta["styles"],
            "cells": cells,
            "merges": merges,
            "images": images,
        }

    def effective_range(self, key, range_text=None):
        """ETag 계산용: 캐시 범위로 자른 실제 range 문자열."""
        wr1, wc1, wr2, wc2 = self.clamp(self.meta(key), range_text)
        return address(wr1, wc1, wr2, wc2)

    def asset_path(self, snapshot_id, asset_id):
        """엄격한 이름 검증 + 실제 경로가 캐시 루트 안인지 확인. 아니면 None(404)."""
        if not valid_id(snapshot_id) or not isinstance(asset_id, str) or not ASSET_RE.fullmatch(asset_id):
            return None
        path = (self.assets_dir(snapshot_id) / asset_id).resolve()
        if not path.is_relative_to(self.base) or not path.is_file():
            return None
        return path

    @staticmethod
    def media_type(asset_id):
        return MEDIA_TYPES[asset_id.rsplit(".", 1)[1]]
