"""버전에 고정하는 전처리 프리셋. 원본·수식은 수정하지 않으며 Decimal을 보존한다."""

from __future__ import annotations

import copy
import re
from decimal import localcontext
from pathlib import Path

import yaml

from .db import Problem

OPS = {
    "trim_text",
    "strip_thousands",
    "split_unit_suffix",
    "percent_to_ratio",
    "automatic",
}
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"


def validate_pipeline(normal, target):
    steps = normal.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        raise Problem("INVALID_PRESET", "전처리 단계는 1~16개여야 합니다.")
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"op"} or step["op"] not in OPS:
            raise Problem(
                "UNSUPPORTED_NORMALIZER",
                "지원하지 않는 전처리 단계 또는 매개변수입니다.",
            )
        if step["op"] not in ("trim_text", "automatic") and target != "decimal":
            raise Problem(
                "NORMALIZER_TYPE_MISMATCH",
                f"{step['op']}의 기대 타입은 decimal, 지정한 타입은 {target}입니다.",
            )


def prepare(value, normal, target):
    """변환한 값과 셀에 포함된 단위를 반환한다. 단위 일치 검사는 reader가 수행한다."""
    from .spec import decimal, decimal_text

    if normal.get("operation") != "pipeline":
        return value, None, False
    validate_pipeline(normal, target)
    unit, ratio = None, False
    steps = [s["op"] for s in normal["steps"]]
    if "automatic" in steps:
        steps = [
            part
            for step in steps
            for part in (
                (
                    ["trim_text", "strip_thousands", "split_unit_suffix"]
                    if target == "decimal"
                    else ["trim_text"]
                )
                if step == "automatic"
                else [step]
            )
        ]
    for step in steps:
        if step == "trim_text" and isinstance(value, str):
            value = value.strip()
        elif step == "strip_thousands" and isinstance(value, str) and "," in value:
            # 쉼표 소수를 천 단위로 오인하지 않는다. 올바른 3자리 그룹만 허용한다.
            if not re.fullmatch(
                r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s+[^\d\s].*)?", value
            ):
                raise Problem(
                    "INVALID_THOUSANDS",
                    "천 단위 쉼표는 1,234.5 형태여야 합니다. 쉼표 소수는 별도 변환이 필요합니다.",
                )
            value = value.replace(",", "")
        elif step == "split_unit_suffix" and isinstance(value, str):
            if re.fullmatch(NUMBER, value):
                continue
            match = re.fullmatch(rf"({NUMBER})\s*([^\d\s.+-].*)", value)
            if match:
                value, unit = match.group(1), match.group(2).strip()
        elif step == "percent_to_ratio":
            text = str(value).strip()
            if text.endswith("%"):
                text, unit = text[:-1].strip(), "%"
            if unit != "%":
                raise Problem(
                    "PERCENT_REQUIRED", "퍼센트 전처리는 %가 표시된 값에 적용하세요."
                )
            with localcontext() as context:
                context.prec = 4096
                value = decimal_text(decimal(text) / 100)
            ratio = True
    return value, unit, ratio


def presets(root):
    items = [
        {
            "id": "identity",
            "label": "원값 유지 (형 변환만)",
            "normalization": {"operation": "identity", "version": "1"},
        },
        {
            "id": "automatic",
            "label": "자동 정규화 (공백·천 단위·단위 접미사)",
            "normalization": {
                "operation": "pipeline",
                "version": "1",
                "preset_id": "automatic",
                "steps": [{"op": "automatic"}],
            },
        },
    ]
    path = Path(root) / "config/normalizers.yaml"
    configured = []
    if path.exists():
        if path.stat().st_size > 131072:
            raise Problem(
                "PRESET_LIMIT", "normalizers.yaml은 128KB 이하로 나누세요.", 413
            )
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            configured = data["presets"]
        except (ValueError, KeyError, TypeError, yaml.YAMLError):
            raise Problem(
                "INVALID_PRESET", "normalizers.yaml의 presets 목록을 확인하세요."
            ) from None
    else:
        configured = [
            {
                "id": "split_unit",
                "label": "값·단위 분리",
                "steps": [{"op": "trim_text"}, {"op": "split_unit_suffix"}],
            },
            {
                "id": "clean_number",
                "label": "숫자 정리",
                "steps": [{"op": "trim_text"}, {"op": "strip_thousands"}],
            },
            {
                "id": "percent",
                "label": "퍼센트 → 비율",
                "steps": [{"op": "trim_text"}, {"op": "percent_to_ratio"}],
            },
        ]
    if not isinstance(configured, list) or len(configured) > 48:
        raise Problem("PRESET_LIMIT", "설정 프리셋은 48개 이하로 나누세요.", 413)
    seen = {i["id"] for i in items}
    for item in configured:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not item["id"]
            or item["id"] in seen
        ):
            raise Problem(
                "INVALID_PRESET", "프리셋 id는 비어 있지 않고 서로 달라야 합니다."
            )
        seen.add(item["id"])
        normal = {
            "operation": "pipeline",
            "version": "1",
            "preset_id": item["id"],
            "steps": copy.deepcopy(item.get("steps")),
        }
        validate_pipeline(normal, "decimal")
        items.append(
            {
                "id": item["id"],
                "label": str(item.get("label", item["id"])),
                "normalization": normal,
            }
        )
    return {"items": items, "has_more": False, "next_cursor": None}
