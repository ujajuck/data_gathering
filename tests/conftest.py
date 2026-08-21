from __future__ import annotations

import shutil
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"

F_INSPECTION = FIXTURES / "01_설비점검일지_반복블록.xlsx"
F_QUALITY = FIXTURES / "02_품질검사성적서_반복양식.xlsx"
F_BATCH = FIXTURES / "03_공정운전실적_반복카드.xlsx"


@pytest.fixture
def tmp_repo(tmp_path: Path) -> Path:
    """Pipeline이 기대하는 최소 repo 구조(config + data/raw)를 tmp에 만든다."""
    shutil.copytree(REPO_ROOT / "config", tmp_path / "config")
    (tmp_path / "data" / "raw").mkdir(parents=True)
    return tmp_path


def stage_fixture(tmp_repo: Path, fixture: Path, name: str | None = None) -> Path:
    dst = tmp_repo / "data" / "raw" / (name or fixture.name)
    shutil.copy2(fixture, dst)
    return dst
