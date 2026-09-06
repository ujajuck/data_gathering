"""/api/proposal 스케일 회귀 — 500개 캡으로 초과분이 조용히 누락되던 버그.

요청된 위치는 전부 제안에 반영되거나 stale로 명시되어야 한다 (침묵 누락 금지).
"""
from __future__ import annotations

import shutil

import pytest

from tests.conftest import FIXTURES

from kg.domain.loader import load_domain_kg
from kg.store import KgStore, now_iso

KG_YAML = FIXTURES.parent.parent / "domains" / "financier" / "config" / "domain_kg.yaml"
UNITS_YAML = FIXTURES.parent.parent / "domains" / "financier" / "config" / "units.yaml"
N_NODES = 620                      # 옛 캡(500)보다 크게


@pytest.fixture()
def client(tmp_path):
    wsdir = tmp_path / "ws"
    (wsdir / "config").mkdir(parents=True)
    (wsdir / "data" / "raw").mkdir(parents=True)
    shutil.copy(KG_YAML, wsdir / "config" / "domain_kg.yaml")
    shutil.copy(UNITS_YAML, wsdir / "config" / "units.yaml")
    store = KgStore(wsdir / "data" / "kg" / "kg.db")
    load_domain_kg(store, KG_YAML, UNITS_YAML)

    store.conn.execute("INSERT INTO document VALUES ('doc-1','big.xlsx',NULL,'xlsx','v1')")
    store.conn.execute(
        "INSERT INTO document_version VALUES ('v1','doc-1','hash',NULL,?)", (now_iso(),))
    for i in range(N_NODES):
        store.conn.execute(
            """INSERT INTO tree_node (node_id, document_id, node_type, node_name,
                 tree_path, locator, data_type, unit, semantic_fingerprint,
                 content_fingerprint, status)
               VALUES (?,?,'HEADER',?,?,?,'numeric','℃',?,?, 'ACTIVE')""",
            (f"node-{i}", "doc-1", f"h{i}", f"doc/s/t/h{i}", f"s!A{i + 1}",
             f"sf{i}", f"cf{i}"))
        store.conn.execute(
            """INSERT INTO semantic_mapping (mapping_id, tree_node_id, concept_id,
                 confidence, status, is_active, created_at)
               VALUES (?,?,'oven_temperature',0.9,'AUTO_APPROVED',1,?)""",
            (f"MAP-{i:012x}", f"node-{i}", now_iso()))
    store.conn.commit()
    store.close()

    from fastapi.testclient import TestClient

    from kg.webapp import create_app
    with TestClient(create_app(wsdir)) as c:
        yield c


def test_proposal_handles_more_than_500_nodes_without_dropping(client):
    ids = [f"node-{i}" for i in range(N_NODES)] + ["node-gone"]
    r = client.post("/api/proposal", json={"node_ids": ids})
    assert r.status_code == 200
    p = r.json()
    field = next(f for f in p["fields"] if f["concept_id"] == "oven_temperature")
    assert field["sources"] == N_NODES                 # 500 초과분도 전부 포함
    assert len(field["node_ids"]) == N_NODES
    assert p["stale_node_ids"] == ["node-gone"]        # 없는 위치는 명시적으로
    assert p["documents"] == ["big.xlsx"]
