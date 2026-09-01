"""/api/sheet 렌더 우선순위 회귀 — DRM 원본이 깨져 보이던 결함의 재발 방지.

우선순위: ① 읽을 수 있는 원본 xlsx(항상 원본 충실) → ② DB 렌더 캐시
(Windows에서 사전 생성한 DRM 충실 렌더) → ③ DRM+COM(리눅스에선 불가) →
④ tree_node 폴백(저하 렌더임을 degraded로 명시).
"""
import json
import shutil

import pytest

from kg.domain.loader import load_domain_kg
from kg.store import KgStore
from tests.test_kg2_groups import KG_YAML, UNITS_YAML, _mini

_NASCA = b"<## NASC" + b"\x00" * 128     # kg.webapp._is_drm_file 매직 헤더


@pytest.fixture()
def ws_client(tmp_path):
    wsdir = tmp_path / "ws"
    (wsdir / "config").mkdir(parents=True)
    (wsdir / "data" / "raw").mkdir(parents=True)
    shutil.copy(KG_YAML, wsdir / "config" / "domain_kg.yaml")
    shutil.copy(UNITS_YAML, wsdir / "config" / "units.yaml")
    store = KgStore(wsdir / "data" / "kg" / "kg.db")
    load_domain_kg(store, KG_YAML, UNITS_YAML)
    store.close()
    _mini(wsdir / "data" / "raw" / "mini.xlsx")

    from fastapi.testclient import TestClient

    from kg.webapp import create_app
    with TestClient(create_app(wsdir)) as c:
        doc = c.post("/api/ingest", json={"filename": "mini.xlsx"}).json()["document_id"]
        yield wsdir, c, doc


def test_readable_xlsx_renders_faithfully_and_ignores_stale_cache(ws_client):
    wsdir, c, doc = ws_client
    # 열 수 있는 원본은 구식 DB 캐시가 있어도 파일 충실 렌더가 이긴다
    store = KgStore(wsdir / "data" / "kg" / "kg.db")
    sheet_name = c.get(f"/api/sheet?doc={doc}").json()["sheet"]
    store.save_render(doc, sheet_name,
                      json.dumps({"sheet": sheet_name, "sheets": [sheet_name],
                                  "max_row": 1, "max_col": 1, "cols": [1],
                                  "rows": [1],
                                  "cells": [{"r": 1, "c": 1, "v": "STALE"}]}),
                      "stale")
    store.commit()
    store.close()
    data = c.get(f"/api/sheet?doc={doc}").json()
    assert all(cell["v"] != "STALE" for cell in data["cells"])
    assert "degraded" not in data
    assert any(cell["v"] == "심부온도" for cell in data["cells"])


def test_drm_locked_falls_back_with_degraded_notice(ws_client):
    wsdir, c, doc = ws_client
    # 원본이 DRM으로 잠기면(매직 헤더) — COM 없는 환경에선 tree 폴백 +
    # 저하 렌더임을 명시해야 한다 ('원본 충실'인 척 금지)
    (wsdir / "data" / "raw" / "mini.xlsx").write_bytes(_NASCA)
    data = c.get(f"/api/sheet?doc={doc}").json()
    assert "degraded" in data and "DRM" in data["degraded"]
    assert data["sheets"]                       # 시트 목록은 tree에서 유지


def test_drm_locked_serves_prebuilt_faithful_cache(ws_client):
    wsdir, c, doc = ws_client
    sheet_name = c.get(f"/api/sheet?doc={doc}").json()["sheet"]
    (wsdir / "data" / "raw" / "mini.xlsx").write_bytes(_NASCA)
    # Windows 쪽에서 사전 생성해 둔 충실 렌더 캐시가 있으면 그것을 서빙
    store = KgStore(wsdir / "data" / "kg" / "kg.db")
    store.save_render(doc, sheet_name,
                      json.dumps({"sheet": sheet_name, "sheets": [sheet_name],
                                  "max_row": 1, "max_col": 1, "cols": [64],
                                  "rows": [20],
                                  "cells": [{"r": 1, "c": 1, "v": "PREBUILT",
                                             "f": "#FFEEDD"}]}),
                      "prebuilt")
    store.commit()
    store.close()
    data = c.get(f"/api/sheet?doc={doc}").json()
    assert data["cells"][0]["v"] == "PREBUILT"
    assert "degraded" not in data
