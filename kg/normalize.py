"""정규화기 레지스트리 — 원자 연산은 코드에, 조합·선택은 데이터에.

정규화 방식은 다양할 수 있으므로 파이프라인에 고정하지 않는다:
- 코드에는 작고 순수한 정규화기(카탈로그)만 둔다. 선언적 파라미터만 받고
  임의 코드(eval류)는 받지 않는다 — 재현성·감사 가능성의 경계.
- 어떤 정규화기를 어떤 조합으로 어디에 쓸지는 전부 데이터다:
  `domains/<d>/config/normalizers.yaml`의 프리셋(단계 조합)과
  빌드 config의 rules(value_normalize 블록).
- 실행은 통합 빌드의 value_normalize 블록에서만 일어난다 — Load 단계는
  원값을 보존한다는 시스템 불변식을 지킨다. 적용 이력은 lineage에 남는다.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_NUM_RE = re.compile(r"^\s*[-+]?\d+(?:\.\d+)?\s*$")
_THOUSANDS_RE = re.compile(r"(?<=\d),(?=\d{3}\b)")
_PERCENT_RE = re.compile(r"^\s*([-+]?\d+(?:[.,]\d+)?)\s*%\s*$")
# UnitRegistry 미등록 표기까지 처리하는 보수적 폴백: "숫자 + 짧은 접미"
_VALUE_SUFFIX_RE = re.compile(r"^\s*([-+]?\d+(?:\.\d+)?)\s*(\S{1,8})\s*$")


class NormalizeError(ValueError):
    """정규화기 선언이 잘못됐다 (알 수 없는 op / 잘못된 파라미터)."""


# ------------------------------------------------------------ 원자 연산 ----
# 시그니처: fn(value, params, env) -> (new_value, meta)
#   meta["unit"]  — 값에서 분리해 낸 단위 (unit_convert가 이어받는다)
#   실패/비대상 값은 원값 그대로 돌려준다 — 정규화기는 값을 파괴하지 않는다.

def _trim_text(value, params, env):
    if not isinstance(value, str):
        return value, {}
    return value.replace("\u00a0", " ").strip(), {}


def _strip_thousands(value, params, env):
    if not isinstance(value, str):
        return value, {}
    s = _THOUSANDS_RE.sub("", value.strip())
    if _NUM_RE.match(s):
        return float(s), {}
    return (s if s != value else value), {}


def _percent_to_ratio(value, params, env):
    if isinstance(value, str):
        m = _PERCENT_RE.match(value)
        if m:
            return float(m.group(1).replace(",", ".")) / 100.0, {}
        return value, {}
    if isinstance(value, (int, float)) and (params or {}).get("assume_percent"):
        return float(value) / 100.0, {}
    return value, {}


def _split_unit_suffix(value, params, env):
    """'195 ℃' → 195.0 + 단위 메타. 등록 단위(UnitRegistry) 우선, 그 외
    표기는 params.allow_unknown=True일 때만 접미로 떼어 낸다."""
    if not isinstance(value, str):
        return value, {}
    if _NUM_RE.match(value):
        return float(value), {}
    units = (env or {}).get("units")
    if units is not None:
        parsed = units.parse_value(value)
        if parsed is not None:
            return parsed[0], {"unit": parsed[1]}
    if (params or {}).get("allow_unknown"):
        m = _VALUE_SUFFIX_RE.match(value)
        if m:
            return float(m.group(1)), {"unit": m.group(2)}
    return value, {}


CATALOG: dict[str, dict] = {
    "trim_text": {
        "fn": _trim_text, "label": "공백 정리",
        "description": "앞뒤 공백·NBSP 제거", "params": {}},
    "strip_thousands": {
        "fn": _strip_thousands, "label": "천단위 콤마 제거",
        "description": '"1,234.5" → 1234.5', "params": {}},
    "percent_to_ratio": {
        "fn": _percent_to_ratio, "label": "퍼센트 → 비율",
        "description": '"12%" → 0.12',
        "params": {"assume_percent": "숫자값도 %로 간주해 /100 (기본 false)"}},
    "split_unit_suffix": {
        "fn": _split_unit_suffix, "label": "값·단위 분리",
        "description": '"195 ℃" → 195 (+단위는 단위 변환으로 전달)',
        "params": {"allow_unknown": "미등록 단위 표기도 접미로 분리 (기본 false)"}},
}


def catalog() -> list[dict]:
    """UI/문서용 카탈로그 메타 — 실행 함수는 노출하지 않는다."""
    return [{"op": name, "label": e["label"], "description": e["description"],
             "params": e["params"]} for name, e in CATALOG.items()]


def validate_steps(steps: list) -> None:
    if not isinstance(steps, list) or not steps:
        raise NormalizeError("steps는 비어 있지 않은 목록이어야 합니다")
    for s in steps:
        op = s.get("op") if isinstance(s, dict) else None
        if op not in CATALOG:
            raise NormalizeError(f"알 수 없는 정규화기: {op!r}")
        if s.get("params") is not None and not isinstance(s["params"], dict):
            raise NormalizeError(f"{op}: params는 매핑이어야 합니다")


def apply_steps(value, steps: list[dict], env: dict | None = None):
    """단계 조합 적용 → (값, meta). meta['unit']은 마지막으로 분리된 단위."""
    meta: dict = {}
    for s in steps:
        fn = CATALOG[s["op"]]["fn"]
        value, m = fn(value, s.get("params") or {}, env or {})
        meta.update(m)
    return value, meta


# ----------------------------------------------------------- 프리셋 로딩 ----
def load_presets(ws_root: Path) -> list[dict]:
    """domains/<d>/config/normalizers.yaml → 검증된 프리셋 목록.

    프리셋 = {id, label, steps:[{op, params}]}. 파일이 없으면 빈 목록 —
    도메인마다 필요한 정규화만 선언한다 (units.yaml과 같은 관리 모델).
    """
    path = Path(ws_root) / "config" / "normalizers.yaml"
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    presets = []
    seen: set[str] = set()
    for p in data.get("presets") or []:
        pid = p.get("id")
        if not isinstance(pid, str) or not pid or pid in seen:
            raise NormalizeError(f"프리셋 id가 없거나 중복입니다: {pid!r}")
        seen.add(pid)
        validate_steps(p.get("steps"))
        presets.append({"id": pid, "label": p.get("label") or pid,
                        "steps": p["steps"]})
    return presets
