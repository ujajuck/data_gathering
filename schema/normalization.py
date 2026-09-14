"""값 전처리 파이프라인(DSL 3.0) — 계약 §2.1 'normalization'.

op는 값만 바꾸고 원본·수식은 건드리지 않으며 Decimal을 보존한다. `<ws>/config/normalizers.yaml`의
설정 프리셋은 버전에 고정한다.
"""

from __future__ import annotations

import copy
import re
from decimal import localcontext
from pathlib import Path

import yaml

from .db import Problem
from .spec import decimal, decimal_text

BASE_OPS = {
    "trim_text",
    "strip_thousands",
    "split_unit_suffix",
    "percent_to_ratio",
    "automatic",
}
SPLIT = "split_delimiter"
SPLIT_KEYS = {"op", "delimiter", "index", "strip"}
OPS = BASE_OPS | {SPLIT}
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"


def validate_pipeline(normal, target, ops=None):
    """steps를 검증하고 기본값(strip=true)과 version('2' if split_delimiter)을 채운 사본을 돌려준다.

    `ops`로 허용 op 집합을 좁힐 수 있다(설정 프리셋은 split_delimiter를 받지 않는다).
    """
    ops = OPS if ops is None else ops
    steps = normal.get("steps") if isinstance(normal, dict) else None
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        raise Problem("INVALID_PRESET", "전처리 단계는 1~16개여야 합니다.")
    out = copy.deepcopy(normal)
    out["steps"] = []
    has_split = False
    for step in steps:
        if not isinstance(step, dict) or step.get("op") not in ops:
            raise Problem(
                "UNSUPPORTED_NORMALIZER", "지원하지 않는 전처리 단계 또는 매개변수입니다."
            )
        if step["op"] == SPLIT:
            if not set(step) <= SPLIT_KEYS:
                raise Problem(
                    "UNSUPPORTED_NORMALIZER",
                    "split_delimiter에는 delimiter/index/strip만 지정할 수 있습니다.",
                )
            delimiter = step.get("delimiter")
            index = step.get("index", 0)
            strip = step.get("strip", True)
            if not isinstance(delimiter, str) or not 1 <= len(delimiter) <= 8:
                raise Problem("INVALID_PRESET", "구분자는 1~8자 문자열이어야 합니다.")
            if type(index) is not int or not -10000 <= index <= 10000:
                raise Problem("INVALID_PRESET", "조각 위치(index)는 정수여야 합니다(음수는 뒤에서).")
            if type(strip) is not bool:
                raise Problem("INVALID_PRESET", "strip은 true/false여야 합니다.")
            if target not in ("text", "decimal"):
                raise Problem(
                    "NORMALIZER_TYPE_MISMATCH",
                    f"split_delimiter의 기대 타입은 text/decimal, 지정한 타입은 {target}입니다.",
                )
            has_split = True
            out["steps"].append(
                {"op": SPLIT, "delimiter": delimiter, "index": index, "strip": strip}
            )
            continue
        if set(step) != {"op"}:
            raise Problem(
                "UNSUPPORTED_NORMALIZER", "지원하지 않는 전처리 단계 또는 매개변수입니다."
            )
        if step["op"] not in ("trim_text", "automatic") and target != "decimal":
            raise Problem(
                "NORMALIZER_TYPE_MISMATCH",
                f"{step['op']}의 기대 타입은 decimal, 지정한 타입은 {target}입니다.",
            )
        out["steps"].append({"op": step["op"]})
    out["operation"] = "pipeline"
    out["version"] = "2" if has_split else str(normal.get("version") or "1")
    return out


def _run_ops(value, steps, target):
    """검증이 끝난 op 목록을 차례로 적용해 (값, 셀 안의 단위, 비율 여부)를 돌려준다."""
    unit, ratio = None, False
    steps = [s["op"] for s in steps]
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


def split_delimiter(value, step):
    """문자열만 나눈다. 조각이 없으면 None(→ value_state 'null')."""
    if not isinstance(value, str):
        return value
    parts = value.split(step["delimiter"])
    if step.get("strip", True):
        parts = [p.strip() for p in parts]
    index = step.get("index", 0)
    if not -len(parts) <= index < len(parts):
        return None
    return parts[index]


def prepare(value, normal, target):
    """(변환값, 셀 안의 단위, 비율 여부). 변환값 None은 '조각 없음'(value_state='null')을 뜻한다.

    step 목록을 split_delimiter 기준으로 잘라 구간별로 `_run_ops`를 돌리고, 단위/비율은 구간이 만든 마지막 값을 쓴다.
    """
    if not isinstance(normal, dict) or normal.get("operation") != "pipeline":
        return value, None, False
    canonical = validate_pipeline(normal, target)
    unit, ratio = None, False
    segment = []

    def run_segment(current):
        nonlocal unit, ratio
        if not segment:
            return current
        current, seg_unit, seg_ratio = _run_ops(current, segment, target)
        if seg_unit is not None:
            unit = seg_unit
        ratio = ratio or seg_ratio
        return current

    for step in canonical["steps"]:
        if step["op"] != SPLIT:
            segment.append({"op": step["op"]})
            continue
        value = run_segment(value)
        segment = []
        value = split_delimiter(value, step)
        if value is None:
            return None, unit, ratio
    value = run_segment(value)
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
        validate_pipeline(normal, "decimal", BASE_OPS)
        items.append(
            {
                "id": item["id"],
                "label": str(item.get("label", item["id"])),
                "normalization": normal,
            }
        )
    return {"items": items, "has_more": False, "next_cursor": None}
