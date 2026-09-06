"""통합 DB '반환' — 빌드 산출물 다운로드 엔드포인트 회귀.

사용자 요구: DB 생성 후 결과를 실제 파일(.db/.csv)로 돌려받을 수 있어야 한다.
"""
from __future__ import annotations

import shutil
import sqlite3

import pytest

from tests.conftest import FIXTURES

from kg.domain.loader import load_domain_kg
from kg.store import KgStore, now_iso

KG_YAML = FIXTURES.parent.parent / "domains" / "financier" / "config" / "domain_kg.yaml"
UNITS_YAML = FIXTURES.parent.parent / "domains" / "financier" / "config" / "units.yaml"


@pytest.fixture()
def client(tmp_path):
    wsdir = tmp_path / "ws"
    (wsdir / "config").mkdir(parents=True)
    (wsdir / "data" / "raw").mkdir(parents=True)
    shutil.copy(KG_YAML, wsdir / "config" / "domain_kg.yaml")
    shutil.copy(UNITS_YAML, wsdir / "config" / "units.yaml")
    store = KgStore(wsdir / "data" / "kg" / "kg.db")
    load_domain_kg(store, KG_YAML, UNITS_YAML)

    # 빌드 산출물과 build_run 이력을 흉내 낸다 (빌더 자체는 별도 테스트 범위)
    builds = wsdir / "data" / "kg" / "builds"
    builds.mkdir(parents=True)
    out = builds / "result_v1.db"
    con = sqlite3.connect(out)
    con.execute("CREATE TABLE result (oven_temperature REAL, _source_document_id TEXT)")
    con.execute("INSERT INTO result VALUES (190.0, 'doc-1'), (185.5, 'doc-1')")
    con.commit()
    con.close()
    store.conn.execute(          # build_run.integration_id FK 대상 먼저
        "INSERT INTO integration_project VALUES (?,?,?,?,?)",
        ("INT-test", "result", 1, "{}", now_iso()))
    store.conn.execute(
        "INSERT INTO build_run VALUES (?,?,?,?,?,?,?,?,?)",
        ("BLD-test", "INT-test", "SUCCESS", now_iso(), now_iso(),
         str(out), "result", 2, None))
    store.conn.commit()
    store.close()

    from fastapi.testclient import TestClient

    from kg.webapp import create_app
    with TestClient(create_app(wsdir)) as c:
        yield c, out


def test_build_artifact_downloads_as_db_and_csv(client):
    c, out = client
    r = c.get("/api/build/BLD-test/download")
    assert r.status_code == 200
    assert r.content.startswith(b"SQLite format 3")           # 진짜 DB 파일
    assert "result_v1.db" in r.headers.get("content-disposition", "")

    r = c.get("/api/build/BLD-test/download?format=csv")
    assert r.status_code == 200
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("oven_temperature")
    assert len(lines) == 3                                    # 헤더 + 2행
    assert ".csv" in r.headers.get("content-disposition", "")

    assert c.get("/api/build/BLD-none/download").status_code == 404
    out.unlink()                                              # 산출물 삭제 → 410
    assert c.get("/api/build/BLD-test/download").status_code == 410
