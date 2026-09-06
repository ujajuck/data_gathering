"""§12 projection 쿼리: Concept Map / lineage 역추적 / 버전 이력."""
from __future__ import annotations

from src.api.queries import concept_map_projection, concept_sources, document_versions
from src.pipeline import Pipeline

from tests.conftest import F_BATCH, F_INSPECTION, F_QUALITY, stage_fixture
from tests.mutations import change_cell_value


def test_concept_map_and_lineage(tmp_repo):
    for f in (F_INSPECTION, F_QUALITY, F_BATCH):
        stage_fixture(tmp_repo, f)
    pipe = Pipeline(tmp_repo)
    pipe.process_dir(tmp_repo / "data" / "raw")

    proj = concept_map_projection(pipe.loader, pipe.registry)
    by_id = {c["concept_id"]: c for c in proj["concepts"]}
    # 설비점검 4개 Block × (기준상한/실측값/판정) = 12개 source
    assert by_id["bearing_temperature"]["source_count"] == 12
    assert by_id["bearing_temperature"]["canonical_unit"] == "℃"
    assert any(e["concept_id"] == "yield_rate" for e in proj["source_edges"])

    # Concept → field → sheet → document → DVC version 역추적 (§11.1)
    sources = concept_sources(pipe.loader, "discharge_pressure")
    assert sources and all(s["document"].startswith("01_") for s in sources)
    assert all(s["dvc_hash"] and s["source_address"] for s in sources)


def test_document_version_listing(tmp_repo):
    target = stage_fixture(tmp_repo, F_INSPECTION)
    pipe = Pipeline(tmp_repo)
    pipe.process_file(target)
    mutated = tmp_repo / "m.xlsx"
    change_cell_value(target, mutated, "C10", "71", "75")
    mutated.replace(target)
    pipe.process_file(target)

    versions = document_versions(pipe.loader, F_INSPECTION.name)
    assert len(versions) == 2
    assert versions[0]["is_current"] == 0 and versions[1]["is_current"] == 1
    # binary/semantic hash 분리 (§11.4): 값 변경이므로 둘 다 달라진다
    assert versions[0]["sha256"] != versions[1]["sha256"]
    assert versions[0]["semantic_hash"] != versions[1]["semantic_hash"]
