"""혼돈양식 v3 회귀 — 서식 없는 헤더/전치 변형/행별 단위 열까지 파서가 흡수하는지.

같은 휘낭시에 도메인의 훨씬 흐트러진 버전:
- 커피: bold/fill 없는 헤더 + 단위행(min/#/°F/cm/%/g) + °F 심부온도
- 치즈: '…숫자열… | core T | °C' 후행 라벨/단위 전치 + 원가표 kg/g 혼합 단위 열
- 초코: 'CORE TEMP (℃)' 캡션 아래 variant|숫자열 그룹 + 전치 KPI(metric|185|195…)
"""
from __future__ import annotations

import shutil

import pytest

from src.pipeline import Pipeline

from tests.conftest import FIXTURES

V3_FILES = [
    "치즈_휘낭시에_실험데이터_혼돈양식_v3.xlsx",
    "커피_휘낭시에_실험데이터_혼돈양식_v3.xlsx",
    "초코_휘낭시에_실험데이터_혼돈양식_v3.xlsx",
]


@pytest.fixture(scope="module")
def pipe(tmp_path_factory):
    root = tmp_path_factory.mktemp("financier_v3")
    shutil.copytree(FIXTURES / "financier_config", root / "config")
    (root / "data" / "raw").mkdir(parents=True)
    p = Pipeline(root)
    for name in V3_FILES:
        shutil.copy2(FIXTURES / "financier" / name, root / "data" / "raw" / name)
        r = p.process_file(root / "data" / "raw" / name)
        assert r["status"] == "SUCCESS"
    return p


def test_mapping_coverage(pipe):
    """혼돈양식 3종 매핑률 90%+ (사전+구조 휴리스틱만으로)."""
    obs = pipe.loader.current_observations()
    mapped = sum(1 for o in obs if o["concept_id"])
    assert mapped / len(obs) >= 0.90


def test_unformatted_header_recognized(pipe):
    """커피: 서식 없는 헤더(t/add-in/core/…)가 단위행 근거로 헤더로 인식된다."""
    obs = pipe.loader.current_observations()
    core = [o for o in obs if o["concept_id"] == "core_temperature"
            and "커피" in o["record_key"]]
    assert len(core) > 100                       # 온도 시트 8장 × 시계열


def test_fahrenheit_affine_conversion(pipe):
    """커피 심부온도 °F가 아핀 변환으로 ℃ 정규화된다: 77.7°F → 25.39℃."""
    obs = pipe.loader.current_observations()
    f_obs = [o for o in obs if o["raw_unit"] == "°F" and o["concept_id"] == "core_temperature"]
    assert f_obs
    sample = min(f_obs, key=lambda o: o["normalized_value_num"] or 1e9)
    assert sample["canonical_unit"] == "℃"
    assert 20.0 < sample["normalized_value_num"] < 30.0   # 시작 시점 실온 부근


def test_trailing_label_unit_rescue(pipe):
    """치즈 Oven 시트: '…숫자… | core T | °C' 전치 행이 개념+단위로 구출되고
    열 키(0,3,…,21분)가 row_key로 붙는다."""
    obs = pipe.loader.current_observations()
    core = [o for o in obs if o["raw_label"] == "core T" and o["source_sheet"] == "Oven180"]
    assert core and all(o["concept_id"] == "core_temperature" for o in core)
    assert {o["row_key"] for o in core} >= {"0", "3", "21"}
    assert all(o["canonical_unit"] == "℃" for o in core)


def test_per_row_unit_column_propagation(pipe):
    """원가표 단위 열(kg/g 혼합): 0.115 kg 버터가 115 g으로 정규화된다."""
    obs = pipe.loader.current_observations()
    kg = [o for o in obs if o["concept_id"] == "ingredient_qty" and o["raw_unit"] == "kg"]
    assert kg
    assert any(o["raw_value_num"] == 0.115 and o["normalized_value_num"] == 115.0 for o in kg)


def test_caption_group_rescue(pipe):
    """초코: 'CORE TEMP (℃)' 캡션 그룹이 variant(base/Rum 2%…)별 시계열로 구출된다."""
    obs = pipe.loader.current_observations()
    core = [o for o in obs if o["concept_id"] == "core_temperature"
            and "초코" in o["record_key"]]
    assert len(core) >= 30
    variants = {o["row_key"].split("@")[0] for o in core if o["row_key"] and "@" in o["row_key"]}
    assert {"base", "glaze"} <= variants


def test_transposed_kpi_label_run(pipe):
    """전치 KPI(metric|185|195…): 'core max(℃)'/'rise mm'/'crack%' 행이
    개념으로 매핑되고 열 키(설정온도)가 row_key로 남는다."""
    obs = pipe.loader.current_observations()
    kpi = [o for o in obs if o["raw_label"] == "core max(℃)"]
    assert kpi and all(o["concept_id"] == "core_temp_max" for o in kpi)
    crack = [o for o in obs if o["raw_label"] == "crack%"]
    assert crack and all(o["concept_id"] == "crack_rate" for o in crack)
