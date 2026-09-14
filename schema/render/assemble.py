"""Reader `render` 스트림 → 캐시 파일(§5 assemble.py). 스테이징 디렉터리에 쓰고 `verified` 확인 뒤 `cache.put`으로 교체한다.

base64 이미지는 캐시 파일에 인라인하지 않고 assets/<sha256>.<ext>로 내려 meta.json에는 url만 남긴다.
"""

from __future__ import annotations

import base64
import hashlib

from ..db import Problem
from .cache import RenderCache

IMAGE_BYTES = 2 * 1024 * 1024


def asset_url(snapshot_id, asset_id):
    return f"/api/snapshots/{snapshot_id}/render-assets/{asset_id}"


def assemble(events, cache: RenderCache, key, expected_token=None, generation=None):
    """이벤트를 소비해 meta.json·band-*.json·assets를 쓴다. 완료된 meta(dict)를 돌려준다."""
    snapshot_id, sheet_id, renderer_version = key
    staging = cache.stage(key)
    meta, bands, images, verified = None, [], [], None
    seen_assets = set()
    try:
        for event in events:
            kind = event.get("type")
            if kind == "meta":
                if meta is not None:
                    raise Problem("RENDER_STREAM_INVALID", "렌더 스트림에 meta가 두 번 왔습니다.")
                meta = dict(event)
                if expected_token is not None and meta.get("layout_revision") != expected_token:
                    raise Problem("SOURCE_VERSION_CHANGED", "원본이 변경되었습니다. 새 버전을 등록하세요.", 409)
            elif kind == "band":
                if meta is None:
                    raise Problem("RENDER_STREAM_INVALID", "렌더 스트림이 meta 없이 시작했습니다.")
                r1, r2 = int(event["r1"]), int(event["r2"])
                cache.write_json(staging, f"band-{r1}-{r2}.json", {"r1": r1, "r2": r2, "cells": event["cells"]})
                bands.append({"r1": r1, "r2": r2, "cells": len(event["cells"])})
            elif kind == "image":
                if meta is None:
                    raise Problem("RENDER_STREAM_INVALID", "렌더 스트림이 meta 없이 시작했습니다.")
                data = base64.b64decode(event["bytes"])
                if len(data) > IMAGE_BYTES:
                    continue
                digest = hashlib.sha256(data).hexdigest()
                if event.get("asset_id") not in (None, digest):
                    raise Problem("RENDER_STREAM_INVALID", "이미지 자산 해시가 내용과 다릅니다.")
                name = cache.write_asset(snapshot_id, digest, str(event["ext"]).lower(), data)
                placement = (name, event["x"], event["y"])
                if placement in seen_assets:
                    continue  # 같은 그림이 같은 자리에 두 번 오면 한 번만
                seen_assets.add(placement)
                images.append(
                    {
                        "asset_id": name,
                        "x": event["x"],
                        "y": event["y"],
                        "width": event["width"],
                        "height": event["height"],
                        "url": asset_url(snapshot_id, name),
                    }
                )
            elif kind == "verified":
                verified = event.get("token")
            else:
                raise Problem("RENDER_STREAM_INVALID", f"알 수 없는 렌더 이벤트: {kind}")
        if meta is None:
            raise Problem("RENDER_STREAM_INVALID", "렌더 결과가 비어 있습니다.")
        if verified is None:
            raise Problem("RENDER_STREAM_INVALID", "렌더 스트림이 verified 없이 끝났습니다.")
        expected = expected_token if expected_token is not None else meta.get("layout_revision")
        if verified != expected or verified != meta.get("layout_revision"):
            raise Problem("SOURCE_VERSION_CHANGED", "렌더 중 원본이 변경되었습니다. 새 버전을 등록하세요.", 409)
        meta.pop("type", None)
        meta.update(
            snapshot_id=snapshot_id,
            sheet_id=sheet_id,
            renderer_version=renderer_version,
            bands=sorted(bands, key=lambda b: b["r1"]),
            images=images,
        )
        cache.write_json(staging, "meta.json", meta)
    except BaseException:
        cache.discard(staging)
        raise
    cache.put(key, staging, generation)
    return meta
