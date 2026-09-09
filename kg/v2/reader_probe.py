"""설치된 보안 Reader의 권한·버전·native 표시 계약을 원문 저장 없이 점검한다."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from .db import Problem, digest
from .jobs import reader_events
from .render import validate_viewport
from .spec import bounds


def probe(root, provider, source_ref, sheet_index=0, area="A1:L20"):
    if provider == "local-xlsx" or not os.environ.get("KG_V2_READER_FACTORY"):
        raise Problem(
            "DRM_READER_REQUIRED",
            "실제 보안 제공자와 KG_V2_READER_FACTORY를 설정하세요. 일반 XLSX나 테스트 대역으로 DRM 검증을 대체하지 않습니다.",
        )
    r1, c1, r2, c2 = bounds(area)
    request = dict(r1=r1, c1=c1, rows=r2 - r1 + 1, cols=c2 - c1 + 1)
    if (
        request["rows"] > 100
        or request["cols"] > 30
        or request["rows"] * request["cols"] > 3000
    ):
        raise Problem(
            "VIEWPORT_LIMIT", "검증 범위를 100행·30열·3,000셀 이내로 지정하세요."
        )
    principal = os.environ.get("KG_V2_PRINCIPAL", "local-user")

    def read(operation, payload):
        events = list(reader_events(root, provider, principal, operation, payload))
        if len(events) != 1:
            raise Problem(
                "INVALID_READER_CONTRACT", "단일 결과가 필요한 Reader 응답입니다."
            )
        return events[0]

    def authorize():
        caps = read("authorize", {"source_ref": source_ref, "required": "render"})
        if not all(
            caps.get(k) for k in ("can_view", "can_render_web", "native_render")
        ):
            raise Problem(
                "NATIVE_RENDER_REQUIRED",
                "원본 표시와 웹 렌더 권한 및 native 렌더 기능이 필요합니다.",
            )
        try:
            if datetime.fromisoformat(caps["expires_at"]) <= datetime.now(timezone.utc):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise Problem(
                "ACCESS_EXPIRED", "유효한 권한 만료 시각이 필요합니다."
            ) from None
        return caps

    caps = authorize()
    description = read("describe", {"source_ref": source_ref})
    sheets = description.get("sheets", [])
    if not description.get("token") or not 0 <= sheet_index < len(sheets):
        raise Problem(
            "INVALID_READER_CONTRACT", "원본 버전 토큰과 지정한 시트가 필요합니다."
        )
    view = read(
        "viewport",
        {
            "source_ref": source_ref,
            "expected_token": description["token"],
            "sheet": sheets[sheet_index]["name"],
            **request,
        },
    )
    validate_viewport(view, request, description["token"])
    if view["mode"] != "native":
        raise Problem(
            "NATIVE_RENDER_REQUIRED", "간략 보기는 원본 표시 검증을 통과할 수 없습니다."
        )
    caps = authorize()
    # Report only capabilities/counts; original names, text, tokens and render bytes stay in memory.
    return {
        "status": "render_contract_passed",
        "provider": provider,
        "source_reference_hash": digest(source_ref),
        "reader_revision": os.environ.get("KG_V2_READER_REVISION", "unversioned"),
        "cells": len(view["cells"]),
        "images": len(view["images"]),
        "can_extract": bool(caps.get("can_extract")),
        "extraction_verified": False,
        "can_cache_derivative": bool(caps.get("can_cache_derivative")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ws", type=Path, required=True)
    parser.add_argument("--provider", default="protected-reader")
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--sheet-index", type=int, default=0)
    parser.add_argument("--range", default="A1:L20", dest="area")
    args = parser.parse_args()
    try:
        report = probe(
            args.ws, args.provider, args.source_ref, args.sheet_index, args.area
        )
    except Problem as exc:
        print(
            json.dumps(
                {"status": "failed", "code": exc.code, "message": exc.message},
                ensure_ascii=False,
            )
        )
        raise SystemExit(1) from None
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
