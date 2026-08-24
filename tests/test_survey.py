"""적재 전 어휘 조사(survey) 패스 — 사전 격차를 적재 없이 예측하는지."""
from __future__ import annotations

import shutil

import pytest
import yaml

from src.survey import survey_paths

from tests.conftest import FIXTURES

F_CHEESE = FIXTURES / "financier" / "치즈_휘낭시에_실험데이터_혼돈양식_v3.xlsx"
F_COFFEE = FIXTURES / "financier" / "커피_휘낭시에_실험데이터_혼돈양식_v3.xlsx"
F_CHOCO = FIXTURES / "financier" / "초코_휘낭시에_실험데이터_혼돈양식_v3.xlsx"


@pytest.fixture()
def root(tmp_path):
    shutil.copytree(FIXTURES / "financier_config", tmp_path / "config")
    return tmp_path


def test_survey_reports_without_side_effects(root):
    """dry-run: DB/스테이징/격리 등 어떤 상태도 만들지 않고 리포트만 낸다."""
    report = survey_paths(root, [F_CHEESE])
    assert report["totals"]["files"] == 1
    assert report["totals"]["observations"] > 500
    assert report["totals"]["expected_coverage_pct"] >= 90
    assert report["dictionary"]["concept_count"] > 40
    # 상태 불변: config만 있어야 한다
    assert sorted(p.name for p in root.iterdir()) == ["config"]


def test_survey_detects_dictionary_gaps(root):
    """사전에서 개념/동의어를 제거하면 survey가 그 격차를 정확히 짚는다."""
    cpath = root / "config" / "concepts.yaml"
    cfg = yaml.safe_load(cpath.read_text(encoding="utf-8"))
    cfg["concepts"] = [c for c in cfg["concepts"] if c["concept_id"] != "probe_type"]
    cpath.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")

    report = survey_paths(root, [F_CHOCO])
    flagged = {r["label"] for r in report["unknown_labels"]} \
        | {r["label"] for r in report["ambiguous_labels"]}
    assert "probe" in flagged
    # 각 항목은 발생 빈도와 출처를 갖는다
    probe = next(r for r in report["unknown_labels"] + report["ambiguous_labels"]
                 if r["label"] == "probe")
    assert probe["observations"] >= 1
    assert any("초코" in d for d in probe["documents"])


def test_survey_detects_unregistered_units(root):
    """units.yaml에서 °F를 빼면 커피 심부온도의 °F가 미등록 단위/라벨로 잡힌다."""
    upath = root / "config" / "units.yaml"
    cfg = yaml.safe_load(upath.read_text(encoding="utf-8"))
    cfg["aliases"] = {k: v for k, v in (cfg.get("aliases") or {}).items()
                      if v != "°F" and k != "°F"}
    cfg["dimensions"]["temperature"].pop("°F", None)
    upath.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")

    report = survey_paths(root, [F_COFFEE])
    flagged_units = {u["unit"] for u in report["unknown_units"]}
    flagged_labels = {r["label"] for r in report["unknown_labels"]} \
        | {r["label"] for r in report["ambiguous_labels"]}
    assert "°F" in flagged_units | flagged_labels


def test_survey_proposal_yaml(root):
    """모호 라벨은 후보 개념 아래 동의어 후보로, 미지 라벨은 신규 개념 스텁으로 제안된다."""
    cpath = root / "config" / "concepts.yaml"
    cfg = yaml.safe_load(cpath.read_text(encoding="utf-8"))
    for c in cfg["concepts"]:
        if c["concept_id"] == "core_temperature":
            c["synonyms"] = [s for s in c.get("synonyms", []) if s != "core T"]
    cfg["concepts"] = [c for c in cfg["concepts"] if c["concept_id"] != "pouch_width"]
    cpath.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")

    report = survey_paths(root, [F_CHEESE])
    yaml_text = report["proposal_yaml"]
    # 'core T'는 core_temperature의 동의어 후보로 (부분 일치 0.85 미만 → ambiguous)
    assert "core T" in yaml_text
    # '봉투 폭'은 개념이 사라졌으니 미지 라벨(신규 개념 스텁)로
    assert "봉투 폭" in yaml_text
