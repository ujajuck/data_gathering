"""P3 합격 기준: concept 매핑, 동의어 학습, 단위 정규화 (설계문서 §5, §14)."""
from __future__ import annotations

from pathlib import Path

import pytest

from src.common.models import FieldInfo
from src.mapping.concepts import ConceptMapper, ConceptRegistry
from src.units.converter import UnitRegistry

CONFIG = Path(__file__).resolve().parents[1] / "config"


@pytest.fixture(scope="module")
def mapper() -> ConceptMapper:
    return ConceptMapper(ConceptRegistry.load(CONFIG / "concepts.yaml"),
                         UnitRegistry.load(CONFIG / "units.yaml"))


def _field(label, path=None, unit=None, value=None, role="unknown"):
    return FieldInfo(field_id="t", address="A1", label_address=None, raw_label=label,
                     header_path=path or [label], raw_unit=unit, raw_value=value,
                     style_role=role)


def test_exact_and_synonym_match(mapper):
    d = mapper.decide(_field("토출압력", unit="bar"), "01_설비점검일지.xlsx", "설비점검")
    assert d.concept_id == "discharge_pressure" and d.decision == "auto"
    # 승인된 동의어 (§5.1 synonyms)
    d = mapper.decide(_field("토출 압", unit="bar"), "01_설비점검일지.xlsx", "설비점검")
    assert d.concept_id == "discharge_pressure" and d.decision == "auto"


def test_context_disambiguation_end_time_vs_final_temp(mapper):
    """'종료'가 KV(시각) 문맥과 온도 프로파일 문맥에서 다른 concept로 간다."""
    kv = mapper.decide(_field("종료", value="13:40"), "03_공정운전실적.xlsx", "Batch운전")
    assert kv.concept_id == "end_time"
    prof = mapper.decide(
        _field("종료", path=["온도 프로파일 (℃)", "종료"], unit="℃", value=75.2),
        "03_공정운전실적.xlsx", "Batch운전")
    assert prof.concept_id == "temp_final"


def test_unit_conflict_removes_candidate(mapper):
    """단위 차원이 안 맞으면 후보에서 제거된다 (§5.2-4)."""
    d = mapper.decide(_field("압력", unit="kg"), "doc.xlsx", "sheet")
    assert d.concept_id != "operating_pressure"


def test_unknown_label_goes_pending(mapper):
    d = mapper.decide(_field("알수없는항목XYZ"), "doc.xlsx", "sheet")
    assert d.decision == "pending"


def test_reasons_are_decomposed(mapper):
    """최종 숫자 하나가 아니라 근거를 분해 저장한다 (§5.3)."""
    d = mapper.decide(_field("토출압력", unit="bar"), "01.xlsx", "설비점검")
    assert "exact" in d.reasons["top"] and "unit" in d.reasons["top"]


def test_synonym_promotion_learns(mapper):
    """승인된 synonym 재등장 시 동일 concept로 안정 매핑 (§14 Synonym mapping)."""
    before = mapper.decide(_field("배출압력", unit="bar"), "doc.xlsx", "sheet")
    assert before.decision == "pending"
    mapper.registry.add_synonym("discharge_pressure", "배출압력")
    after = mapper.decide(_field("배출압력", unit="bar"), "doc.xlsx", "sheet")
    assert after.concept_id == "discharge_pressure" and after.decision == "auto"


def test_unit_conversion_deterministic():
    units = UnitRegistry.load(CONFIG / "units.yaml")
    assert units.convert(1500, "kPa", "bar") == pytest.approx(15.0)
    assert units.convert(2500, "g", "kg") == pytest.approx(2.5)
    assert units.normalize_unit("°C") == "℃"
    assert units.compatible("MPa", "bar")
    with pytest.raises(ValueError):
        units.convert(1, "kg", "bar")
