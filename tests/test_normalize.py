"""정규화기 레지스트리 — 원자 연산은 코드, 조합·선택은 데이터(yaml/config).

사용자 요구: 정규화 방식은 다양할 수 있으니 코드에 고정하지 말고 별도로
관리하며 툴처럼 가져다 쓴다. 이 테스트가 그 경계를 고정한다.
"""
from __future__ import annotations

import shutil

import pytest

from tests.conftest import FIXTURES

from kg.integration.dag import Frame, run_dag
from kg.normalize import (NormalizeError, apply_steps, catalog, load_presets,
                          validate_steps)
from src.units.converter import UnitRegistry

ROOT = FIXTURES.parent.parent
UNITS = UnitRegistry.load(ROOT / "domains" / "financier" / "config" / "units.yaml")
ENV = {"units": UNITS}


def test_atomic_normalizers():
    step = lambda op, **params: [{"op": op, "params": params or None}]  # noqa: E731
    assert apply_steps("  195  ", step("trim_text"), ENV)[0] == "195"
    assert apply_steps("1,234.5", step("strip_thousands"), ENV)[0] == 1234.5
    assert apply_steps("12%", step("percent_to_ratio"), ENV)[0] == 0.12
    assert apply_steps(12, step("percent_to_ratio", assume_percent=True), ENV)[0] == 0.12

    v, meta = apply_steps("195 ℃", step("split_unit_suffix"), ENV)
    assert v == 195.0 and meta["unit"] == "℃"        # 분리된 단위는 메타로 전달
    assert apply_steps("180", step("split_unit_suffix"), ENV)[0] == 180.0
    # 미등록 표기는 기본 보존, allow_unknown일 때만 분리
    assert apply_steps("3 zorks", step("split_unit_suffix"), ENV)[0] == "3 zorks"
    v, meta = apply_steps("3 zorks", step("split_unit_suffix", allow_unknown=True), ENV)
    assert v == 3.0 and meta["unit"] == "zorks"
    # 정규화기는 값을 파괴하지 않는다 — 비대상 값은 원본 그대로
    assert apply_steps("판정: 우수", step("split_unit_suffix"), ENV)[0] == "판정: 우수"


def test_steps_validation_rejects_unknown_op():
    with pytest.raises(NormalizeError):
        validate_steps([{"op": "no_such_normalizer"}])
    with pytest.raises(NormalizeError):
        validate_steps([])
    assert {c["op"] for c in catalog()} >= {
        "trim_text", "strip_thousands", "percent_to_ratio", "split_unit_suffix"}


def test_presets_load_from_domain_yaml(tmp_path):
    ws = tmp_path / "ws"
    (ws / "config").mkdir(parents=True)
    assert load_presets(ws) == []                     # 파일 없으면 빈 목록
    shutil.copy(ROOT / "domains" / "financier" / "config" / "normalizers.yaml",
                ws / "config" / "normalizers.yaml")
    presets = {p["id"]: p for p in load_presets(ws)}
    assert "split_unit" in presets and presets["split_unit"]["steps"]
    (ws / "config" / "normalizers.yaml").write_text(
        "presets:\n  - id: bad\n    steps:\n      - op: nope\n", encoding="utf-8")
    with pytest.raises(NormalizeError):
        load_presets(ws)                              # 잘못된 선언은 로딩 시 거부


def test_value_normalize_block_feeds_unit_convert():
    """'195 ℃' 텍스트 → 숫자 + 단위 메타 → 이어지는 unit_convert가 K로 변환.
    적용 이력은 lineage.normalized로 남는다 (출처 추적)."""
    f = Frame(["temp"],
              rows=[{"temp": "195 ℃"}, {"temp": "180"}, {"temp": "판정: 우수"}],
              lineage=[{"temp": {"node_id": "n1"}}, {"temp": {"node_id": "n1"}},
                       {"temp": {"node_id": "n2"}}])
    env = {"units": UNITS, "field_units": {"temp": "K"}, "node_units": {}}
    out = run_dag([f], [
        {"op": "value_normalize", "config": {"rules": [
            {"steps": [{"op": "trim_text"}, {"op": "split_unit_suffix"}],
             "node_ids": ["n1"]}]}},
        {"op": "unit_convert"},
    ], env)[0]
    assert out.rows[0]["temp"] == pytest.approx(195 + 273.15)   # ℃→K 변환까지
    assert out.lineage[0]["temp"]["unit"] == "K"
    assert out.lineage[0]["temp"]["normalized"] == ["trim_text", "split_unit_suffix"]
    assert out.rows[1]["temp"] == 180.0            # 단위 없는 숫자 문자열 → 숫자
    assert out.rows[2]["temp"] == "판정: 우수"       # 규칙 밖 노드(n2)는 불변


def test_convert_scalar_uses_unit_registry():
    """parsing의 단위 정규화는 units.yaml(UnitRegistry)이 원본이다 —
    폴백 dict에 없는 g→kg도 레지스트리가 있으면 변환된다."""
    from kg.parsing import _convert_scalar
    assert _convert_scalar(1500, "number", "g", {"target_unit": "kg"},
                           units=UNITS) == pytest.approx(1.5)
    with pytest.raises(ValueError):                 # 레지스트리 없으면 폴백만
        _convert_scalar(1500, "number", "g", {"target_unit": "kg"})
