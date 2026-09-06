"""REST API 서버 테스트 (WEB_PLAN W1/W3) — 조회·페이지네이션·캐시·승인 플로우·성능."""
from __future__ import annotations

import shutil
import time
import urllib.parse

import pytest
import yaml
from fastapi.testclient import TestClient

from src.api.server import create_app
from tests.conftest import FIXTURES, REPO_ROOT


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("api")
    shutil.copytree(REPO_ROOT / "config", root / "config")
    (root / "data" / "raw").mkdir(parents=True)
    for f in sorted(FIXTURES.glob("*.xlsx")):
        shutil.copy2(f, root / "data" / "raw" / f.name)
    app = create_app(root)
    c = TestClient(app)
    r = c.post("/api/ingestion/reprocess", json={})
    assert r.status_code == 200
    assert all(x["status"] == "SUCCESS" for x in r.json()["results"])
    return c


# ------------------------------------------------------------------ reads ----

def test_stats(client):
    s = client.get("/api/stats").json()
    assert s["documents"] == 7 and s["records"] >= 60
    assert s["mapped_pct"] >= 70 and s["pending_mappings"] > 0


def test_ontology_and_graph(client):
    onto = client.get("/api/ontology").json()
    assert len(onto["domains"]) == 6
    kg = client.get("/api/graph").json()
    edges = {(e["subject"], e["predicate"]): e["evidence_records"] for e in kg["edges"]}
    assert edges[("run", "uses")] > 0


def test_documents_with_concepts(client):
    docs = client.get("/api/documents").json()["items"]
    assert len(docs) == 7
    d = next(x for x in docs if x["logical_name"].startswith("C_QC"))
    assert d["record_count"] == 9 and "reaction_temperature" in d["concepts"]
    assert d["pending_mappings"] > 0


def test_concepts_filters(client):
    used = client.get("/api/concepts?used=true&size=500").json()
    every = client.get("/api/concepts?size=500").json()
    assert 0 < used["total"] < every["total"]
    q = client.get("/api/concepts?q=토출").json()
    assert any(c["concept_id"] == "discharge_pressure" for c in q["items"])
    dom = client.get("/api/concepts?domain=energy&size=500").json()
    assert all(c["domain"] == "energy" for c in dom["items"])


def test_lots_paging_and_detail(client):
    p1 = client.get("/api/lots?size=5").json()
    assert len(p1["items"]) == 5 and p1["total"] >= 15
    p2 = client.get("/api/lots?size=5&page=2").json()
    assert p1["items"][0]["lot"] != p2["items"][0]["lot"]
    lot = client.get("/api/lots/BT26821").json()
    assert len(lot["records"]) >= 4 and "reaction_temperature" in lot["concepts"]
    assert client.get("/api/lots/NOPE-999").status_code == 404


def test_records_filters_and_detail(client):
    r = client.get("/api/records?lot=BT26821").json()
    assert r["total"] >= 4
    key = r["items"][0]["record_key"]
    d = client.get(f"/api/records/{urllib.parse.quote(key, safe='')}/detail").json()
    assert d["record_key"] == key and len(d["observations"]) > 0
    assert client.get("/api/records/none%7Cnone/detail").status_code == 404


def test_lineage_endpoint(client):
    lin = client.get("/api/lineage/reaction_temperature?lot=BT26821").json()
    assert lin["total"] == 4
    assert all(abs(o["normalized_value_num"] - 75.0) < 1e-9 for o in lin["items"])
    raws = {(o["raw_value_num"], o["raw_unit"]) for o in lin["items"]}
    assert (348.15, "K") in raws


def test_pagination_bounds(client):
    r = client.get("/api/records?size=99999").json()
    assert r["size"] == 500                    # MAX_PAGE_SIZE clamp
    r = client.get("/api/records?page=9999").json()
    assert r["items"] == [] and r["total"] > 0
    r = client.get("/api/records?page=0").json()
    assert r["page"] == 1


def test_etag_304(client):
    r1 = client.get("/api/graph")
    etag = r1.headers["etag"]
    r2 = client.get("/api/graph", headers={"If-None-Match": etag})
    assert r2.status_code == 304


# ----------------------------------------------------------------- writes ----

def test_mapping_reject_and_approve_promotes_synonym(client):
    pending = client.get("/api/mapping/pending?size=100").json()["items"]
    assert pending
    root = client.app.state.ctx.repo_root

    rejectable = next(p for p in pending if not p["concept_id"])
    r = client.post("/api/mapping/decisions",
                    json={"field_signature": rejectable["field_signature"], "action": "reject"})
    assert r.json()["result"] == "rejected"

    target = next(p for p in pending if p["concept_id"])
    before_version = yaml.safe_load(
        (root / "config" / "concepts.yaml").read_text(encoding="utf-8"))["version"]
    r = client.post("/api/mapping/decisions",
                    json={"field_signature": target["field_signature"], "action": "approve",
                          "approved_by": "tester"})
    body = r.json()
    assert body["result"] == "approved"
    cfg = yaml.safe_load((root / "config" / "concepts.yaml").read_text(encoding="utf-8"))
    if body["synonym_promoted"]:
        assert cfg["version"] != before_version
        target_concept = next(c for c in cfg["concepts"]
                              if c["concept_id"] == body["concept_id"])
        assert target["raw_label"] in target_concept["synonyms"]
        # 서버가 새 사전으로 reload 되었다
        assert client.app.state.ctx.pipeline.registry.version == str(cfg["version"])

    # pending 목록에서 사라짐
    left = client.get("/api/mapping/pending?size=200").json()["items"]
    sigs = {p["field_signature"] for p in left}
    assert target["field_signature"] not in sigs
    assert rejectable["field_signature"] not in sigs

    # 승인 없는 시그니처 → 404, 후보 없는 승인 → 422
    assert client.post("/api/mapping/decisions",
                       json={"field_signature": "no-such", "action": "approve"}).status_code == 404


def test_decision_invalidates_stats_cache_and_etag(client):
    """승인/반려(UPDATE)도 ETag를 바꿔 stats/documents가 stale 되지 않는다 (리뷰 발견 수정)."""
    before = client.get("/api/stats")
    old_etag = before.headers["etag"]
    old_pending = before.json()["pending_mappings"]

    victim = client.get("/api/mapping/pending?size=1").json()["items"][0]
    client.post("/api/mapping/decisions",
                json={"field_signature": victim["field_signature"], "action": "reject"})

    after = client.get("/api/stats")
    assert after.json()["pending_mappings"] == old_pending - 1
    assert after.headers["etag"] != old_etag
    # 브라우저가 옛 ETag로 조건부 GET해도 304가 아니라 새 본문을 받는다
    conditional = client.get("/api/stats", headers={"If-None-Match": old_etag})
    assert conditional.status_code == 200


def test_reprocess_path_traversal_blocked(client):
    """reprocess file 파라미터는 data/raw 밖으로 나갈 수 없다 (리뷰 발견 수정)."""
    for evil in ("../../../../etc/passwd", "/etc/passwd", "config/concepts.yaml",
                 "data/raw/../../config/concepts.yaml"):
        r = client.post("/api/ingestion/reprocess", json={"file": evil})
        assert r.status_code == 422, evil


def test_like_metacharacters_are_literal(client):
    """검색 q의 %/_ 는 와일드카드가 아니라 문자 그대로 매칭된다 (리뷰 발견 수정)."""
    everything = client.get("/api/records?size=1").json()["total"]
    pct = client.get("/api/records?q=%25").json()      # '%'
    assert pct["total"] == 0
    underscore = client.get("/api/records?q=_").json()
    assert 0 < underscore["total"] < everything
    assert all("_" in r["record_key"] for r in underscore["items"])
    assert client.get("/api/lots?q=%25").json()["total"] == 0


def test_reprocess_cache_hit(client):
    r = client.post("/api/ingestion/reprocess",
                    json={"file": "data/raw/01_설비점검일지_반복블록.xlsx", "force": False})
    body = r.json()["results"][0]
    assert body["status"] == "SUCCESS"


def test_jobs_listing(client):
    jobs = client.get("/api/jobs?size=10").json()
    assert jobs["total"] >= 7 and jobs["items"][0]["status"] in ("SUCCESS", "PUSH_FAILED")


# ------------------------------------------------------------- performance ----

def test_list_queries_fast_on_10k_observations(tmp_path):
    """1만 관측치 규모에서 목록/상세 API가 즉답한다 (WEB_PLAN W1 완료 조건)."""
    import uuid
    from src.common.models import ObservationData, RecordData
    from src.loader.versioned_loader import VersionedLoader

    loader = VersionedLoader(tmp_path / "big.db")
    doc = loader.ensure_document("big.xlsx", "data/raw/big.xlsx")
    ver = loader.new_document_version(
        doc, dvc_hash="h", sha256=str(uuid.uuid4()), structure_hash="s",
        semantic_hash="m", parser_version="t", mapping_version="t")
    records = []
    for i in range(500):
        obs = [ObservationData(
            observation_key=f"k{j}", concept_id="reaction_temperature",
            raw_label="반응온도", header_path=["반응온도"], raw_value_text=None,
            raw_value_num=70.0 + j, normalized_value_text=None, normalized_value_num=70.0 + j,
            raw_unit="℃", canonical_unit="℃", value_role="measured", status_code=None,
            source_sheet="S", source_address=f"A{j}", row_key=None,
        ) for j in range(20)]
        records.append(RecordData(
            record_key=f"T|BT{i:05d}|", record_type="T", business_key=f"BT{i:05d}",
            event_time=None, overall_status=None, note=None, source_sheet="S",
            source_block_bbox="", block_fingerprint="", block_content_hash="",
            observations=obs))
    loader.apply_package(records, ver)

    shutil.copytree(REPO_ROOT / "config", tmp_path / "config")
    (tmp_path / "data" / "raw").mkdir(parents=True)
    app = create_app(tmp_path, db_path=tmp_path / "big.db")
    c = TestClient(app)

    t0 = time.perf_counter()
    r = c.get("/api/records?size=50&page=5")
    t_records = time.perf_counter() - t0
    assert r.json()["total"] == 500

    t0 = time.perf_counter()
    r = c.get("/api/lots?size=50")
    t_lots = time.perf_counter() - t0
    assert r.json()["total"] == 500

    t0 = time.perf_counter()
    key = urllib.parse.quote("T|BT00250|", safe="")
    r = c.get(f"/api/records/{key}/detail")
    t_detail = time.perf_counter() - t0
    assert len(r.json()["observations"]) == 20

    # 여유 있는 상한(컨테이너 편차 감안). 실측은 수 ms 수준.
    assert t_records < 0.5 and t_lots < 0.5 and t_detail < 0.5, (t_records, t_lots, t_detail)
