"""DRM SDK가 아닌 계약 테스트용 제공자. 원본 복사/복호화/저장은 구현하지 않는다."""

import base64
import io
from datetime import datetime, timedelta, timezone

from PIL import Image

from kg.v2.db import Problem
from kg.v2.readers import XlsxReader, file_hash
from kg.v2.spec import address


class Reader:
    def __init__(self, root, provider, principal):
        self.root, self.provider, self.principal = root, provider, principal

    def authorize(self, source_ref, required="view"):
        if (self.root / "revoked").exists():
            raise Problem("ACCESS_DENIED", "테스트 제공자가 접근을 거부했습니다.", 403)
        return {
            "can_view": True,
            "can_extract": True,
            "can_render_web": True,
            "can_cache_derivative": False,
            "native_render": True,
            "access_scope_key": self.principal,
            "policy_revision": "fixture-v1",
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=60)
            ).isoformat(),
        }

    def describe(self, source_ref):
        self.authorize(source_ref)
        return {
            "token": file_hash(self.root / "data/raw/protected.bin"),
            "filename": "보안문서.xlsx",
            "sheets": [
                {"name": "Protected", "estimated_rows": 10, "estimated_cols": 10}
            ],
        }

    def viewport(self, source_ref, expected_token, sheet, r1, c1, rows, cols):
        self.authorize(source_ref)
        if expected_token != self.describe(source_ref)["token"]:
            raise Problem(
                "SOURCE_VERSION_CHANGED", "제공자 버전이 변경되었습니다.", 409
            )
        data = io.BytesIO()
        Image.new("RGB", (cols * 80, rows * 20), "white").save(data, format="PNG")
        cells = [
            {
                "range": address(r, c),
                "r1": r,
                "c1": c,
                "r2": r,
                "c2": c,
                "x": (c - c1) * 80,
                "y": (r - r1) * 20,
                "width": 80,
                "height": 20,
            }
            for r in range(r1, r1 + rows)
            for c in range(c1, c1 + cols)
        ]
        if (self.root / "bad-geometry").exists():
            cells[0]["x"] = 9
        return {
            "mode": "native",
            "layout_revision": expected_token,
            "sheet": sheet,
            "r1": r1,
            "c1": c1,
            "r2": r1 + rows - 1,
            "c2": c1 + cols - 1,
            "width": cols * 80,
            "height": rows * 20,
            "rows": [
                {"index": r, "y": (r - r1) * 20, "height": 20}
                for r in range(r1, r1 + rows)
            ],
            "columns": [
                {"index": c, "x": (c - c1) * 80, "width": 80}
                for c in range(c1, c1 + cols)
            ],
            "cells": cells,
            "images": [
                {
                    "x": 0,
                    "y": 0,
                    "width": cols * 80,
                    "height": rows * 20,
                    "data_url": "data:image/png;base64,"
                    + base64.b64encode(data.getvalue()).decode(),
                }
            ],
        }


def factory(root, provider, principal):
    if provider == "revocable-xlsx":

        class Revocable(XlsxReader):
            def authorize(self, source_ref, required="view"):
                if (root / "revoked").exists():
                    raise Problem(
                        "ACCESS_DENIED", "추출값의 원본 권한이 철회되었습니다.", 403
                    )
                return super().authorize(source_ref, required)

        return Revocable(root, principal)
    return Reader(root, provider, principal)
