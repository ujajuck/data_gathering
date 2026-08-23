"""별도 도메인(휘낭시에 실험) 회귀 — 파이프라인이 도메인 교체만으로 동작하는지."""
from __future__ import annotations

import shutil

import pytest

from src.pipeline import Pipeline

from tests.conftest import FIXTURES

F_FIN = FIXTURES / "financier" / "오리지날_휘낭시에_실험데이터_복합양식.xlsx"


@pytest.fixture(scope="module")
def pipe(tmp_path_factory):
    root = tmp_path_factory.mktemp("financier")
    shutil.copytree(FIXTURES / "financier_config", root / "config")
    (root / "data" / "raw").mkdir(parents=True)
    shutil.copy2(F_FIN, root / "data" / "raw" / F_FIN.name)
    p = Pipeline(root)
    r = p.process_file(root / "data" / "raw" / F_FIN.name)
    assert r["status"] == "SUCCESS"
    return p


def test_domain_grain_and_coverage(pipe):
    """10개 시트 → 25개 레코드, 매핑 커버리지 95%+ (도메인 사전만 교체)."""
    recs = pipe.loader.current_records()
    assert len(recs) == 25
    obs = pipe.loader.current_observations()
    mapped = sum(1 for o in obs if o["concept_id"])
    assert mapped / len(obs) >= 0.95


def test_experiment_records_keyed_by_recipe(pipe):
    """실험조건 레코드가 레시피(business key)+실험일로 식별된다 — LOT 없는 도메인."""
    exps = [r for r in pipe.loader.current_records() if r["record_type"] == "실험 조건"]
    assert len(exps) == 7                     # 온도 시트 180~210
    assert all(r["business_key"] == "오리지날" for r in exps)
    assert all(r["event_time"] for r in exps)


def test_embedded_value_unit_split(pipe):
    """KV 값 '180 ℃' / '24℃' 가 숫자+단위로 분해되어 매핑·정규화된다."""
    obs = pipe.loader.current_observations()
    oven = [o for o in obs if o["raw_label"] == "오븐설정"]
    assert oven and oven[0]["concept_id"] == "oven_temperature"
    assert oven[0]["raw_value_num"] == 180.0 and oven[0]["raw_unit"] == "℃"
    amb = [o for o in obs if o["raw_label"] == "실내온도"]
    assert amb and amb[0]["concept_id"] == "ambient_temperature"
    assert amb[0]["raw_value_num"] == 24.0


def test_kpi_table_not_transposed(pipe):
    """Summary KPI 표: 단위행의 'unit' 토큰에도 전치 오판 없이 온도별 관측치 생성."""
    obs = pipe.loader.current_observations()
    kpi_temp = [o for o in obs if o["concept_id"] == "oven_temperature"
                and "핵심 지표" in o["record_key"]]
    temps = sorted(o["raw_value_num"] for o in kpi_temp)
    assert temps == [180.0, 185.0, 190.0, 195.0, 200.0, 205.0, 210.0]


def test_cost_sheet_rows_are_instances(pipe):
    """원가표: '재료명' 열 → 행=인스턴스(row_key), 열(단가/배합량)이 개념으로 매핑."""
    obs = pipe.loader.current_observations()
    price = [o for o in obs if o["concept_id"] == "unit_price"]
    assert len(price) == 8                    # 재료 8종
    keys = {o["row_key"] for o in price}
    assert "무염버터" in keys and "아몬드파우더" in keys
    # 재료명이 개념 라벨로 pending 되지 않는다
    pend = pipe.loader.conn.execute(
        "SELECT count(*) FROM mapping_decision WHERE decision='pending' AND raw_label='무염버터'"
    ).fetchone()[0]
    assert pend == 0


def test_vertical_merged_addin_inherited(pipe):
    """세로 병합된 부재료 셀 값이 반복(rep2) 행의 row_key로 상속된다."""
    obs = [o for o in pipe.loader.current_observations()
           if o["concept_id"] == "core_temperature" and "시간별" in o["record_key"]]
    row_keys = {o["row_key"] for o in obs}
    assert any(k and k.startswith("슈가코팅") for k in row_keys)
    # 상속 실패 시 생기는 'rowN' 키가 없어야 한다
    assert not any((k or "").startswith("row") for k in row_keys)


def test_recipe_hub(pipe):
    """레시피가 허브 키로 인식되어 시트 횡단 통합된다 (ID 패턴 없는 도메인)."""
    from src.api import store
    store.register_functions(pipe.loader.conn)
    hub = store.lots_page(pipe.loader.conn, 1, 20)
    lots = {l["lot"]: l for l in hub["items"]}
    assert "오리지날" in lots and lots["오리지날"]["record_count"] >= 8
