"""적재 전 어휘 조사(survey) 패스 — 사전 격차를 적재 없이 예측하는지."""
from __future__ import annotations

import shutil
from pathlib import Path

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


def test_survey_mixed_absolute_relative_paths(root):
    """--repo-root와 파일 경로의 절대/상대 표기가 달라도 죽지 않는다 (resolve 일치)."""
    import os
    # repo_root 절대 + 파일 절대 (repo 밖) — 기본 케이스
    report = survey_paths(root, [F_CHEESE.resolve()])
    assert report["totals"]["files"] == 1
    # repo_root 상대 표기 + repo 안의 절대 경로 파일
    (root / "incoming").mkdir()
    shutil.copy2(F_CHEESE, root / "incoming" / F_CHEESE.name)
    cwd = os.getcwd()
    os.chdir(root)
    try:
        report = survey_paths(Path("."), [(root / "incoming" / F_CHEESE.name).resolve()])
    finally:
        os.chdir(cwd)
    assert report["totals"]["files"] == 1 and not report["errors"]


def test_survey_continues_past_broken_file(root):
    """깨진 파일 하나가 전체 조사를 중단시키지 않는다 — errors로 보고하고 계속."""
    bad = root / "broken.xlsx"
    bad.write_bytes(b"this is not a zip archive")
    report = survey_paths(root, [bad, F_CHEESE])
    assert report["totals"]["files"] == 1
    assert report["totals"]["failed_files"] == 1
    assert report["errors"][0]["file"] == "broken.xlsx"
    assert report["totals"]["observations"] > 500      # 치즈는 정상 조사됨


def test_survey_dir_missing_raises(root):
    """존재하지 않는 디렉터리는 빈 성공 리포트가 아니라 명시적 오류다."""
    from src.survey import survey_dir
    with pytest.raises(FileNotFoundError):
        survey_dir(root, root / "no_such_dir")


def test_pseudo_tokens_not_flagged_as_units(root):
    """text/enum/timestamp 같은 스키마 서술 토큰은 미등록 단위로 제안하지 않는다."""
    from src.survey import VocabularySurveyor
    s = VocabularySurveyor(root)
    assert not s._suspected_unit_token("text")
    assert not s._suspected_unit_token("enum")
    assert not s._suspected_unit_token("timestamp")
    assert not s._suspected_unit_token("1%")           # 값+단위 합성도 제외
    assert s._suspected_unit_token("°F") is False      # 등록되어 있으면 False
    # °F를 registry에서 지운 상태를 흉내: 임시로 units만 교체
    import yaml as _yaml
    upath = root / "config" / "units.yaml"
    cfg = _yaml.safe_load(upath.read_text(encoding="utf-8"))
    cfg["aliases"] = {k: v for k, v in (cfg.get("aliases") or {}).items() if v != "°F"}
    cfg["dimensions"]["temperature"].pop("°F", None)
    upath.write_text(_yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")
    s2 = VocabularySurveyor(root)
    assert s2._suspected_unit_token("°F") is True      # 미등록이면 의심 단위


def test_proposal_yaml_is_valid_yaml(root):
    """proposal_yaml은 따옴표/특수문자 라벨이 있어도 파싱 가능한 YAML이다."""
    cpath = root / "config" / "concepts.yaml"
    cfg = yaml.safe_load(cpath.read_text(encoding="utf-8"))
    for c in cfg["concepts"]:
        if c["concept_id"] == "core_temperature":
            c["synonyms"] = [s for s in c.get("synonyms", []) if s != "core T"]
    cpath.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                     encoding="utf-8")
    report = survey_paths(root, [F_CHEESE, F_CHOCO])
    parsed = yaml.safe_load(report["proposal_yaml"])
    assert isinstance(parsed, dict) and "add_synonyms" in parsed
