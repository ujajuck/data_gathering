"""복합 실데이터 4종(A/B/C/D) — 이미지 6패널(온톨로지·KG·매핑·단위·통합·Lineage) 검증."""
from __future__ import annotations

from pathlib import Path

import pytest

from src.api.queries import (
    knowledge_graph_projection,
    load_relations,
    lot_hub_projection,
    ontology_projection,
)
from src.inspect.inspector import WorkbookInspector
from src.mapping.doc_dictionary import extract_document_dictionary
from src.pipeline import Pipeline
from src.segment.detector import segment_workbook

from tests.conftest import FIXTURES, REPO_ROOT, stage_fixture

F_A = FIXTURES / "A_생산일보_중합2팀_202608.xlsx"
F_B = FIXTURES / "B_MES_BatchPerformance_Aug2026.xlsx"
F_C = FIXTURES / "C_QC_Lab_ResultSheet_R4.xlsx"
F_D = FIXTURES / "D_complex_semistructured.xlsx"

LOTS = {f"BT2682{i}" for i in range(1, 9)}


@pytest.fixture(scope="module")
def pipe(tmp_path_factory):
    import shutil
    root = tmp_path_factory.mktemp("complex")
    shutil.copytree(REPO_ROOT / "config", root / "config")
    (root / "data" / "raw").mkdir(parents=True)
    for f in (F_A, F_B, F_C, F_D):
        shutil.copy2(f, root / "data" / "raw" / f.name)
    p = Pipeline(root)
    results = p.process_dir(root / "data" / "raw")
    assert all(r["status"] == "SUCCESS" for r in results)
    return p


# ---------------------------------------------------- 내장 사전 (패널 3/4) ----

def test_embedded_dictionaries_absorbed():
    """MASTER_코드표/Tag_Dictionary/현장코드/계산근거가 사전으로 흡수·해소된다."""
    insp = WorkbookInspector()
    from src.mapping.concepts import ConceptRegistry
    reg = ConceptRegistry.load(REPO_ROOT / "config" / "concepts.yaml")
    expected = {F_A: "현장코드", F_B: "Tag_Dictionary", F_C: "계산근거"}
    for fixture, sheet in expected.items():
        dd = extract_document_dictionary(insp.inspect(fixture), reg)
        assert dd.sheet_names == {sheet}, fixture.name
        syn = dd.synonyms()
        assert len(syn) >= 8
    # Tag_Dictionary의 태그가 표준 개념으로 해소
    from src.mapping.concepts import normalize_label
    dd = extract_document_dictionary(insp.inspect(F_B), reg)
    syn = dd.synonyms()
    assert syn[normalize_label("RX_TEMP")] == "reaction_temperature"
    assert syn[normalize_label("QTY_IN")] == "input_amount"


# ------------------------------------------- 다영역/전치 구조 파싱 (P2 확장) ----

def test_side_by_side_and_area_blocks():
    """좌우 병렬 블록([Block A]|[Block B])과 AREA 1/2/3이 분리된다."""
    insp = WorkbookInspector()
    from src.units.converter import UnitRegistry
    units = UnitRegistry.load(REPO_ROOT / "config" / "units.yaml")
    st = insp.inspect(F_D)
    segs = {s.sheet_name: s for s in segment_workbook(st, units=units,
                                                      skip_sheets={"MASTER_코드표"})}
    titles_02 = [b.title for b in segs["02_품질검사_MIX"].blocks]
    assert any(t.startswith("[Block A]") for t in titles_02)
    assert any(t.startswith("[Block B]") for t in titles_02)
    assert any(t.startswith("[Block C]") for t in titles_02)
    titles_03 = [b.title for b in segs["03_설비_Energy&Alarm"].blocks]
    assert sum(1 for t in titles_03 if t.startswith("AREA-")) == 3


def test_unit_header_row_stripped():
    """헤더 아래 단위 행(degC/kPa/metric ton)이 header_path에서 분리되어 단위가 된다."""
    insp = WorkbookInspector()
    from src.units.converter import UnitRegistry
    units = UnitRegistry.load(REPO_ROOT / "config" / "units.yaml")
    st = insp.inspect(F_B)
    seg = segment_workbook(st, units=units, skip_sheets={"Tag_Dictionary"})[0]
    fields = [f for b in seg.blocks for r in b.regions for f in r.fields]
    rx = next(f for f in fields if f.raw_label == "RX_TEMP")
    assert rx.raw_unit == "degC"
    qty = next(f for f in fields if f.raw_label == "QTY_IN")
    assert qty.raw_unit == "metric ton"


def test_inline_legend_roles():
    """'파랑=PLC / 노랑=수기' 인라인 범례가 fill→역할로 해석된다."""
    insp = WorkbookInspector()
    st = insp.inspect(F_A)
    seg = segment_workbook(st, skip_sheets={"현장코드"})[0]
    meanings = set(seg.style_semantics.values())
    assert "PLC" in meanings and any("수기" in m for m in meanings)


# --------------------------------------------------- Grain 교정 (패널 5) ----

def test_row_per_record_grain(pipe):
    """행=LOT 표(A/B)와 전치 표(C)가 LOT 단위 레코드로 분할된다."""
    recs = pipe.loader.current_records()
    for stem, expected in [("생산일보", 8), ("Batch_Performance", 8), ("검사결과", 8)]:
        keys = {r["business_key"] for r in recs
                if r["source_sheet"] == stem or stem in r["record_type"]}
        assert LOTS <= keys, (stem, keys)


def test_lot_hub_cross_document(pipe):
    """BT26821이 문서 횡단 허브로 통합된다 (이미지 패널 5)."""
    hub = lot_hub_projection(pipe.loader, business_key="BT26821")
    lot = hub["lots"]["BT26821"]
    assert lot["record_count"] >= 4
    assert len(lot["documents"]) >= 4
    assert "reaction_temperature" in lot["concepts"]


# ------------------------------------------- 단위 정규화 + Lineage (패널 4/6) ----

def test_cross_document_lineage_reaction_temperature(pipe):
    """이미지 패널 6: 75℃ / 75 degC / 348.15 K / PV 75 → 전부 반응온도 75.00℃."""
    obs = [o for o in pipe.loader.current_observations()
           if o["concept_id"] == "reaction_temperature" and "BT26821" in o["record_key"]]
    assert len(obs) == 4                      # A, B, C, D 네 문서
    sheets = {o["source_sheet"] for o in obs}
    assert sheets == {"생산일보", "Batch_Performance", "검사결과", "01_공정실적_RAW"}
    for o in obs:
        assert o["normalized_value_num"] == pytest.approx(75.0)
        assert o["canonical_unit"] == "℃"
        assert o["source_address"]            # 출처 셀 보존
    raws = {(o["raw_value_num"], o["raw_unit"]) for o in obs}
    assert (348.15, "K") in raws              # 켈빈 아핀 변환 증거


def test_unit_normalization_matrix(pipe):
    """kPa/MPa→bar, ton/g→kg, Pa·s→cP, fraction→%, %→ppm, MWh→kWh."""
    obs = [o for o in pipe.loader.current_observations() if "BT26821" in o["record_key"]]
    def norm(cid):
        return {(o["raw_unit"], round(o["normalized_value_num"], 4), o["canonical_unit"])
                for o in obs if o["concept_id"] == cid and o["normalized_value_num"] is not None}
    press = norm("reaction_pressure")
    assert ("kPa", 1.6, "bar") in press and ("MPa", 1.6, "bar") in press
    amt = norm("input_amount")
    assert ("metric ton", 4800.0, "kg") in amt and ("g", 4800.0, "kg") in amt
    visc = norm("viscosity")
    assert any(u and u.startswith("Pa") and v == 118.0 for u, v, _ in visc)
    assert ("0~1", 95.5, "%") in norm("yield_rate")
    assert ("MWh", 670.0, "kWh") in norm("energy_consumption")
    moist = norm("moisture")
    assert ("%", 210.0, "ppm") in moist or ("mass%", 210.0, "ppm") in moist


def test_excel_serial_timestamp_normalized(pipe):
    """MES EVENT_TS(serial 46254.98)가 ISO datetime으로 정규화된다."""
    recs = [r for r in pipe.loader.current_records()
            if "Batch_Performance" in r["record_type"] and r["business_key"] == "BT26821"]
    assert recs and recs[0]["event_time"].startswith("2026-08-2")


def test_cross_sheet_formula_lineage():
    """'01_공정실적_RAW'!W15 참조가 시트명까지 lineage로 보존된다."""
    insp = WorkbookInspector()
    st = insp.inspect(F_D)
    sheet02 = next(s for s in st.sheets if s.sheet_name == "02_품질검사_MIX")
    b23 = next(c for c in sheet02.cells if c.address == "B23")
    assert b23.is_formula
    assert any("01_공정실적_RAW" in ref for ref in b23.formula_refs)


# ------------------------------------- 온톨로지 + 지식 그래프 (패널 1/2) ----

def test_ontology_domains(pipe):
    onto = ontology_projection(pipe.registry)
    names = {d["name_ko"] for d in onto["domains"].values()}
    assert {"공정", "품질", "설비", "에너지", "시간"} <= names
    quality = onto["domains"]["quality"]["concepts"]
    assert any(c["concept_id"] == "viscosity" and c["canonical_unit"] == "cP" for c in quality)


def test_knowledge_graph_projection(pipe):
    rel = load_relations(REPO_ROOT / "config")
    kg = knowledge_graph_projection(pipe.loader, pipe.registry, rel)
    nodes = {n["class"]: n for n in kg["nodes"]}
    assert nodes["lot"]["instances"]          # BT26821 등 실제 인스턴스
    assert "BT26821" in nodes["lot"]["instances"]
    edges = {(e["subject"], e["predicate"], e["object"]): e["evidence_records"]
             for e in kg["edges"]}
    assert edges[("run", "uses", "equipment")] > 0
    assert edges[("run", "produces", "output")] > 0
    assert edges[("quality", "evaluates", "lot")] > 0


# -------------------------------------------------------- 회귀: 혼합 적재 ----

def test_all_seven_documents_coexist(tmp_repo):
    """기존 반복블록 3종 + 복합 4종이 한 DB에 공존하고 재처리는 cache hit."""
    import shutil
    for f in sorted(FIXTURES.glob("*.xlsx")):
        stage_fixture(tmp_repo, f)
    pipe = Pipeline(tmp_repo)
    r1 = pipe.process_dir(tmp_repo / "data" / "raw")
    assert all(r["status"] == "SUCCESS" for r in r1)
    n_records = len(pipe.loader.current_records())
    assert n_records >= 60                    # 11(반복블록) + 49+(복합)
    r2 = pipe.process_dir(tmp_repo / "data" / "raw")
    assert all(r["cache_hit"] for r in r2)
    obs = pipe.loader.current_observations()
    mapped = sum(1 for o in obs if o["concept_id"])
    assert mapped / len(obs) >= 0.7           # 매핑 커버리지 70%+
