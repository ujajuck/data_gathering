"""값 전처리 파이프라인(DSL 3.0) — v2 op는 kg.v2.normalization에 위임하고 `split_delimiter`만 여기서 실행한다.

계약 §2.1 'normalization'. v2 `spec.validate_rule`의 normalization 분기는 호출하지 않는다.
"""

from __future__ import annotations

import copy

from kg.v2 import normalization as v2
from kg.v2.db import Problem as V2Problem

from .db import Problem

SPLIT = "split_delimiter"
SPLIT_KEYS = {"op", "delimiter", "index", "strip"}
OPS = set(v2.OPS) | {SPLIT}


def _lift(exc: V2Problem) -> Problem:
    # v2 Problem은 별개 클래스라 v3 API 계층이 잡지 못한다. 코드·메시지를 유지한 채 바꿔 던진다.
    return Problem(exc.code, exc.message, exc.status)


def validate_pipeline(normal, target):
    """steps를 검증하고 기본값(strip=true)과 version('2' if split_delimiter)을 채운 사본을 돌려준다."""
    steps = normal.get("steps") if isinstance(normal, dict) else None
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        raise Problem("INVALID_PRESET", "전처리 단계는 1~16개여야 합니다.")
    out = copy.deepcopy(normal)
    out["steps"] = []
    has_split = False
    for step in steps:
        if not isinstance(step, dict) or step.get("op") not in OPS:
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

    step 목록을 split_delimiter 기준으로 잘라 v2 구간은 kg.v2.normalization.prepare에 부분 파이프라인으로
    맡기고, 단위/비율은 구간이 만든 마지막 값을 쓴다.
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
        try:
            current, seg_unit, seg_ratio = v2.prepare(
                current, {"operation": "pipeline", "steps": segment}, target
            )
        except V2Problem as exc:
            raise _lift(exc) from None
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
    try:
        return v2.presets(root)
    except V2Problem as exc:
        raise _lift(exc) from None
