"""v3 API 통합(계약 §6, 빌드·큐 제외): examples.schema_v3.demo.seed 작업 공간 위에서 TestClient로 엔드포인트를 검증한다.

상태·검색·설정 · 문서 목록(필터·정렬·커서·상태 칩) · 상세 탭 · 등록(+wait) · 수동 적용 · 렌더 프록시(202→200→304, asset) ·
프로파일(목록·상세·리비전·export·import-preview v1/v2·생성·수정 SCHEMA_IMMUTABLE·테스트·승인·재파싱) · 스키마(목록·상세·트리·그래프·
필드) · 검수(집계·CAS 충돌·rollback·approve-all→발행·역방향 조회) · 작업 목록/취소 · 토큰 401 · 본문 한도."""

from __future__ import annotations

import copy
import shutil
import time

import pytest
from fastapi.testclient import TestClient

from examples.schema_v3 import demo
from kg.v2.readers import file_hash
from kg.v3.api import create_app
from kg.v3.db import Problem
from kg.v3.render.client import RenderClient, RenderUnavailable
from kg.v3.render.renderer import render_events



def inprocess_source(root, provider, principal, payload, checkpoint):
    """Reader 격리 프로세스 대신 같은 프로세스에서 renderer를 부르는 event_source(테스트 속도)."""
    path = root / "data/raw" / payload["source_ref"]
    token = file_hash(path)
    if payload["expected_token"] != token:
        raise Problem("SOURCE_VERSION_CHANGED", "원본이 변경되었습니다.", 409)
    yield from render_events(path, payload["sheet_name"], token, payload["r1"], payload["c1"], payload["rows"], payload["cols"])
    checkpoint()
    yield {"type": "verified", "token": token}


def poll(client, path, timeout=15.0):
    """UI처럼 202가 아닌 응답이 올 때까지 같은 GET을 반복한다."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(path)
        if response.status_code != 202:
            return response
        time.sleep(0.03)
    raise AssertionError("render timed out")


@pytest.fixture(scope="session")
def seeded(tmp_path_factory):
    root = tmp_path_factory.mktemp("v3-seed")
    return root, demo.seed(root)


@pytest.fixture
def world(tmp_path, seeded):
    source, summary = seeded
    root = tmp_path / "ws"
    shutil.copytree(source, root)
    app = create_app(root, start_worker=False)
    with TestClient(app) as client:
        service = app.state.v3
        service._render = RenderClient(root, event_source=inprocess_source)
        yield Env(client, root, copy.deepcopy(summary), service)


class Env:
    def __init__(self, client, root, summary, service):
        self.client, self.root, self.summary, self.service = client, root, summary, service
        self.docs = {d["document_name"]: d for d in summary["documents"]}
        self.profile_id = summary["profile"]["profile_id"]

    def get(self, path, expect=200, **kw):
        response = self.client.get("/api/v3" + path, **kw)
        assert response.status_code == expect, (path, response.status_code, response.text[:400])
        return response.json() if response.content else None

    def post(self, path, body=None, expect=200, **kw):
        response = self.client.post("/api/v3" + path, json=body, **kw)
        assert response.status_code == expect, (path, response.status_code, response.text[:400])
        return response.json()

    def doc(self, name):
        return self.docs[name]

    def snapshot_id(self, name):
        return self.docs[name]["snapshot_id"]

    def application_id(self, name):
        return self.docs[name]["applied"][0]["application_id"]


# ---------------------------------------------------------------------------- 공통


def test_status_search_settings_presets(world):
    status = world.get("/status")
    assert status["version"] == "3" and status["counts"]["documents"] == 6 and status["counts"]["profiles"] == 1 and status["counts"]["schemas"] == 1
    assert status["counts"]["review"] == 1 and status["counts"]["jobs_running"] == 0
    assert status["render"]["mode"] == "inprocess" and status["render"]["available"] and status["render"]["queue_depth"] == 0
    found = world.get("/search?q=공정")
    kinds = {i["kind"] for i in found["items"]}
    assert kinds >= {"document", "profile", "schema", "field"} and all(i["route"].startswith("?screen=") for i in found["items"])
    assert [i["kind"] for i in world.get("/search?q=잠김")["items"]] == ["document"]
    assert world.get("/search?q=")["items"] == []
    settings = world.get("/settings")
    assert settings["render"]["mode"] == "inprocess" and settings["reader"]["timeout_seconds"] > 0 and settings["limits"]["wait_seconds"] == 60
    assert settings["workspace"] == str(world.root) and not settings["access_token_required"] and settings["limits"]["profile"]["rules"] == 200
    presets = world.get("/normalization-presets")
    assert {p["id"] for p in presets["items"]} >= {"identity", "automatic"}
    response = world.client.get("/api/v3/status")
    assert response.headers["Cache-Control"] == "no-store" and response.headers["X-Content-Type-Options"] == "nosniff"


# ---------------------------------------------------------------------------- 문서


def test_documents_list_filters_sort_cursor_and_status_chips(world):
    listed = world.get("/documents")
    assert len(listed["items"]) == 6 and not listed["has_more"]
    assert {d["status"] for d in listed["items"]} == {"normal", "review", "unmatched", "locked"}
    by_status = {s: [d["document_name"] for d in world.get(f"/documents?status={s}")["items"]] for s in ("normal", "review", "unmatched", "locked", "changed", "failed", "not_extracted")}
    assert len(by_status["normal"]) == 3 and by_status["review"] == [demo.SHIFTED_DOCUMENT] and by_status["unmatched"] == [demo.OTHER_DOCUMENT]
    assert by_status["locked"] == [demo.LOCKED_DOCUMENT] and by_status["changed"] == by_status["failed"] == by_status["not_extracted"] == []
    normal = world.get("/documents?status=normal&sort=document_name")["items"]
    assert [d["document_name"] for d in normal] == list(demo.IDENTICAL_DOCUMENTS)
    row = normal[1]
    assert row["current_snapshot"]["revision_no"] == 1 and row["profiles"][0]["state"] == "published" and row["profiles"][0]["compatibility"] == "identical"
    assert row["schemas"] == [{"schema_key": "process_standard", "schema_name": "공정 데이터 표준"}] and row["last_processed_at"]
    page1 = world.get("/documents?sort=document_name&limit=2")
    assert page1["has_more"] and len(page1["items"]) == 2
    page2 = world.get(f"/documents?sort=document_name&limit=2&cursor={page1['next_cursor']}")
    assert [d["document_name"] for d in page2["items"]] == [demo.IDENTICAL_DOCUMENTS[2], demo.SHIFTED_DOCUMENT]
    desc = world.get("/documents?sort=-document_name")["items"]
    assert desc[0]["document_name"] == demo.OTHER_DOCUMENT
    assert [d["document_name"] for d in world.get("/documents?q=품질")["items"]] == [demo.OTHER_DOCUMENT]
    assert len(world.get(f"/documents?profile_id={world.profile_id}")["items"]) == 4
    assert len(world.get("/documents?schema_key=process_standard")["items"]) == 4
    assert len(world.get("/documents?schema_key=nope")["items"]) == 0
    assert world.get("/documents?status=bogus", expect=422)["error"]["code"] == "VALIDATION_ERROR"
    assert world.get("/documents?sort=updated_at", expect=422)["error"]["code"] == "VALIDATION_ERROR"
    assert world.get(f"/documents?sort=-document_name&cursor={page1['next_cursor']}", expect=422)["error"]["code"] == "INVALID_CURSOR"
    assert world.get("/documents?limit=0", expect=422)["error"]["code"] == "VALIDATION_ERROR"


def test_document_detail_snapshots_sheets_applications_values(world):
    name = demo.IMAGE_DOCUMENT
    doc = world.get(f"/documents/{world.doc(name)['document_id']}")
    assert doc["status"] == "normal" and doc["current_snapshot"]["snapshot_id"] == world.snapshot_id(name) and doc["profiles"][0]["profile_name"] == demo.PROFILE_NAME
    snapshots = world.get(f"/documents/{doc['document_id']}/snapshots")["items"]
    assert len(snapshots) == 1 and snapshots[0]["current"] and snapshots[0]["application_count"] == 1 and snapshots[0]["filename"] == name
    sheets = world.get(f"/snapshots/{world.snapshot_id(name)}/sheets")["items"]
    assert [s["sheet_name"] for s in sheets] == [demo.MAIN_SHEET, demo.COMMON_SHEET, demo.IMAGE_SHEET] and [s["ordinal"] for s in sheets] == [0, 1, 2]
    apps = world.get(f"/snapshots/{world.snapshot_id(name)}/applications")["items"]
    assert len(apps) == 1 and apps[0]["state"] == "published" and apps[0]["published"] and apps[0]["origin"] == "auto" and apps[0]["heads_approved"] == 11
    assert apps[0]["profile"]["profile_name"] == demo.PROFILE_NAME and not apps[0]["is_reference"]
    reference = world.get(f"/snapshots/{world.snapshot_id(demo.REFERENCE_DOCUMENT)}/applications")["items"][0]
    assert reference["is_reference"] and reference["origin"] == "manual"
    values = world.get(f"/snapshots/{world.snapshot_id(name)}/values?field_key=temperature")
    assert len(values["items"]) == demo.LOT_COUNT and not values["has_more"]
    first = values["items"][0]
    assert first["value_text"] == "150" and first["unit_normalized"] == "°C" and first["source"]["sheet_name"] == demo.MAIN_SHEET and first["source"]["range"] == "C9"
    assert first["record_key"] == "r9" and first["derivation_key"] == "relation:lot:same_row" and first["rule_key"] == "temperature"
    assert {r["role"] for r in first["regions"]} == {"key", "value", "unit", "record_key"}
    dated = world.get(f"/snapshots/{world.snapshot_id(name)}/values?rule_key=measured_at&limit=3")
    assert dated["has_more"] and dated["items"][0]["value_type"] == "datetime" and dated["items"][0]["value_text"].startswith("2024-01-03T09:00")
    more = world.get(f"/snapshots/{world.snapshot_id(name)}/values?rule_key=measured_at&limit=3&cursor={dated['next_cursor']}")
    assert {v["value_id"] for v in more["items"]}.isdisjoint({v["value_id"] for v in dated["items"]})
    assert world.get("/documents/nope", expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.get("/snapshots/nope/sheets", expect=404)["error"]["code"] == "NOT_FOUND"
    locked = world.get(f"/documents/{world.doc(demo.LOCKED_DOCUMENT)['document_id']}")
    assert locked["status"] == "locked" and locked["current_snapshot"] is None and locked["status_detail"]["locked"]["code"] == "DRM_READER_REQUIRED"


def test_register_via_sources_wait_and_job_cancel(world):
    demo.build_process_workbook(world.root / "data/raw/신규_2024_07.xlsx", 7)
    sources = world.get("/sources")
    assert not sources["has_more"] and {s["source_ref"] for s in sources["items"]} >= {"신규_2024_07.xlsx", demo.LOCKED_DOCUMENT}
    assert world.get("/sources?directory=../")["items"] == []
    job = world.post("/documents/register?wait=30", {"source_refs": ["신규_2024_07.xlsx"]})
    assert job["state"] == "succeeded" and job["kind"] == "register" and job["label"] == "신규_2024_07.xlsx" and job["finished_at"]
    result = job["result"]["documents"][0]
    assert result["status"] == "normal" and [(a["compatibility"], a["state"]) for a in result["applied"]] == [("identical", "approved")]
    assert world.get("/status")["counts"]["documents"] == 7
    queued = world.post("/documents/register", {"source_refs": ["신규_2024_07.xlsx"]}, expect=202)
    assert queued["state"] == "queued"
    assert world.get(f"/jobs/{queued['job_id']}")["state"] == "queued"
    assert world.post(f"/jobs/{queued['job_id']}/cancel") == {"job_id": queued["job_id"], "cancel_requested": True}
    world.service.jobs.run_one()
    assert world.get(f"/jobs/{queued['job_id']}")["state"] == "cancelled"
    assert world.post("/documents/register", {"source_refs": ["a.xlsx", "b.xlsx"], "document_id": "x"}, expect=422)["error"]["code"] == "ONE_DOCUMENT_REQUIRED"
    assert world.post("/documents/register", {"source_refs": []}, expect=422)["error"]["code"] == "VALIDATION_ERROR"
    error = world.post("/documents/register", {"source_refs": ["a.xlsx"], "extra": 1}, expect=422)["error"]
    assert error["code"] == "VALIDATION_ERROR" and error["fields"][0]["field"].endswith("extra")
    assert world.post("/documents/register?wait=61", {"source_refs": ["a.xlsx"]}, expect=422)["error"]["code"] == "VALIDATION_ERROR"
    missing = world.post("/documents/register?wait=30", {"source_refs": ["없음.xlsx"]})
    assert missing["state"] == "failed" and missing["error_code"] == "SOURCE_NOT_FOUND"


def test_manual_application_with_draft_profile_and_extract_gate(world):
    definition = copy.deepcopy(demo.PROFILE)
    definition["profile_name"] = "공정데이터_초안"
    draft = world.post("/profiles", {"schema_key": "process_standard", "definition": definition}, expect=201)
    assert draft["status"] == "draft" and draft["current_rev"] == 1 and draft["report"]["format_detected"] == "parsing-profile-3.0"
    sid = world.snapshot_id(demo.IDENTICAL_DOCUMENTS[1])
    unbound = world.post(f"/snapshots/{world.snapshot_id(demo.OTHER_DOCUMENT)}/applications", {"profile_id": draft["profile_id"]}, expect=422)
    assert unbound["error"]["code"] == "SHEET_ROLE_UNBOUND"
    app = world.post(f"/snapshots/{sid}/applications", {"profile_id": draft["profile_id"]}, expect=201)
    assert app["origin"] == "manual" and app["compatibility"] == "manual" and app["heads_total"] == 11 and app["heads_approved"] == 0
    assert all(m["status"] == "proposed" and m["origin"] == "profile" and m["field"] for m in app["mappings"])
    assert world.post(f"/snapshots/{sid}/applications", {"profile_id": draft["profile_id"]}, expect=409)["error"]["code"] == "ALREADY_APPLIED"
    gate = world.post(f"/applications/{app['application_id']}/extract", expect=422)["error"]
    assert gate["code"] == "REVIEW_REQUIRED" and len(gate["fields"]) == 11
    assert world.get(f"/documents/{app['document']['document_id']}")["status"] == "review"
    done = world.post(f"/applications/{app['application_id']}/approve-all?wait=30", {"reason": "초안 검수"})
    assert done["approved"] == 11 and done["skipped"] == [] and done["extraction"]["state"] == "succeeded"
    assert world.get(f"/applications/{app['application_id']}")["published"]
    assert world.get(f"/documents/{app['document']['document_id']}")["status"] == "normal"
    docs = world.get(f"/profiles/{draft['profile_id']}/documents")["items"]
    assert len(docs) == 1 and docs[0]["published"] and docs[0]["status"] == "published" and not docs[0]["is_reference"]
    assert world.post(f"/profiles/{draft['profile_id']}/reparse", {"mode": "fill"}, expect=422)["error"]["code"] == "PROFILE_NOT_APPROVED"
    approved = world.post(f"/profiles/{draft['profile_id']}/approve", {"application_id": app["application_id"]})
    assert approved["status"] == "approved" and approved["reparse_job"]["kind"] == "reparse"
    rematch = world.get(f"/jobs/{approved['reparse_job']['job_id']}")
    assert rematch["state"] == "queued" and rematch["target_kind"] == "profile" and rematch["label"].startswith("공정데이터_초안 v1")
    world.service.jobs.run_one()
    assert world.get(f"/jobs/{approved['reparse_job']['job_id']}")["state"] == "succeeded"
    assert world.get(f"/profiles/{draft['profile_id']}")["auto_approval_active"]


# ---------------------------------------------------------------------------- 렌더 프록시


def test_render_proxy_202_200_304_and_assets(world):
    name = demo.IMAGE_DOCUMENT
    sid = world.snapshot_id(name)
    sheets = {s["sheet_name"]: s["sheet_id"] for s in world.get(f"/snapshots/{sid}/sheets")["items"]}
    path = f"/api/v3/snapshots/{sid}/sheets/{sheets[demo.MAIN_SHEET]}/render"
    first = world.client.get(path)
    assert first.status_code == 202 and first.json()["status"] in ("queued", "rendering") and first.headers["Cache-Control"] == "private, no-cache"
    ready = poll(world.client, path)
    assert ready.status_code == 200, ready.text[:300]
    window = ready.json()
    assert window["sheet"]["sheet_name"] == demo.MAIN_SHEET and window["range"] == "A1:Z60" and window["renderer_version"]
    texts = {(c["r1"], c["c1"]): c["text"] for c in window["cells"]}
    assert texts[(8, 1)] == "LOT" and texts[(3, 1)] == "제품명" and window["merges"] and window["freeze"]
    etag = ready.headers["ETag"]
    assert etag.startswith('"') and ready.headers["Cache-Control"] == "private, no-cache"
    cached = world.client.get(path, headers={"If-None-Match": etag})
    assert cached.status_code == 304 and cached.headers["ETag"] == etag and not cached.content
    small = world.client.get(path + "?range=A8:C10")
    assert small.status_code == 200 and small.headers["ETag"] != etag
    assert {(c["r1"], c["c1"]) for c in small.json()["cells"]} <= {(r, c) for r in range(8, 11) for c in range(1, 4)}
    assert world.client.get(path + "?range=A1:ZZ500").json()["error"]["code"] == "RANGE_TOO_LARGE"
    assert world.client.get(path + "?range=xyz").json()["error"]["code"] == "INVALID_RANGE"
    assert world.get(f"/snapshots/{sid}/sheets/{sheets[demo.COMMON_SHEET]}/render", expect=202)["status"] in ("queued", "rendering")

    image_path = f"/api/v3/snapshots/{sid}/sheets/{sheets[demo.IMAGE_SHEET]}/render"
    world.client.get(image_path)
    rendered = poll(world.client, image_path)
    assert rendered.status_code == 200, rendered.text[:300]
    images = rendered.json()["images"]
    assert len(images) == 1 and images[0]["url"].startswith(f"/api/v3/snapshots/{sid}/render-assets/")
    asset = world.client.get(images[0]["url"])
    assert asset.status_code == 200 and asset.headers["content-type"] == "image/png" and asset.content.startswith(b"\x89PNG")
    assert asset.headers["Cache-Control"] == "private, no-cache" and asset.headers["ETag"] == f'"{images[0]["asset_id"]}"'
    assert world.client.get(images[0]["url"], headers={"If-None-Match": asset.headers["ETag"]}).status_code == 304
    assert world.client.get(f"/api/v3/snapshots/{sid}/render-assets/..%2F..%2Fetc%2Fpasswd").status_code == 404
    unknown = world.client.get("/api/v3/snapshots/etc/passwd")
    assert unknown.status_code == 404 and unknown.headers["content-type"].startswith("application/json")  # SPA fallback은 API 경로에 적용되지 않는다
    assert world.client.get(f"/api/v3/snapshots/{sid}/render-assets/{'0' * 64}.png").status_code == 404
    assert world.client.get(f"/api/v3/snapshots/{sid}/render-assets/{images[0]['asset_id']}.exe").status_code == 404
    other = world.snapshot_id(demo.OTHER_DOCUMENT)
    assert world.client.get(f"/api/v3/snapshots/{other}/render-assets/{images[0]['asset_id']}").status_code == 404  # asset은 snapshot 안에서만
    assert world.get(f"/snapshots/{sid}/sheets/{sheets[demo.MAIN_SHEET]}/render".replace(sid, other), expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.get(f"/snapshots/{sid}/sheets/not-a-sheet/render", expect=404)["error"]["code"] == "NOT_FOUND"

    def unavailable(*args, **kwargs):
        raise RenderUnavailable()

    world.service._render.request = unavailable
    down = world.client.get(path)
    assert down.status_code == 503 and down.json()["error"]["code"] == "RENDER_UNAVAILABLE" and down.headers["Retry-After"] == "5"


# ---------------------------------------------------------------------------- 프로파일


V1_TEMPLATE = {
    "format": "kg-parsing-template/1",
    "spec": {
        "sheet_templates": [
            {
                "name": "본문",
                "match": {"names": [demo.MAIN_SHEET]},
                "mappings": [
                    {"key": "temp", "concept_id": "temperature", "source": {"key_search": ["온도"], "offset": {"row": 1, "col": 0}}, "type": "number", "unit": "°C", "normalization": {"target_unit": "K"}},
                    {"key": "product", "concept_id": "product_name", "source": {"range": "B3"}, "type": "text"},
                ],
            }
        ]
    },
}

V2_TEMPLATE = {
    "kg_revision_id": "kg-1",
    "sheet_roles": {"main": {"cardinality": "one", "match": {"name": demo.MAIN_SHEET}}},
    "rules": [
        {"rule_key": "temp", "concept_id": "temperature", "selector": {"key": {"areas": [{"sheet_role": "main", "find": {"texts": ["온도"]}}]}, "value": {"areas": [{"sheet_role": "main", "relative": {"row": 1}}]}}, "value_spec": {"type": "decimal", "unit": "°C"}},
        {"rule_key": "free", "concept_id": None, "selector": {"key": {"areas": [{"sheet_role": "main", "find": {"texts": ["비고"]}}]}, "value": {"areas": [{"sheet_role": "main", "relative": {"col": 1}}]}}},
    ],
}


def test_profiles_list_detail_revisions_export(world):
    listed = world.get("/profiles")
    assert len(listed["items"]) == 1 and not listed["has_more"]
    item = listed["items"][0]
    assert item["profile_name"] == demo.PROFILE_NAME and item["status"] == "approved" and item["schema"] == {"key": "process_standard", "name": "공정 데이터 표준"}
    assert item["document_count"] == 4 and item["success_rate"] == 0.75 and item["current_rev"] == 1
    assert world.get("/profiles?status=draft")["items"] == [] and len(world.get("/profiles?q=A양식&schema_key=process_standard")["items"]) == 1
    detail = world.get(f"/profiles/{world.profile_id}")
    assert detail["auto_approval_active"] and detail["reference"]["document_name"] == demo.REFERENCE_DOCUMENT and detail["reference"]["profile_rev"] == 1
    assert detail["reference"]["snapshot"]["revision_no"] == 1 and detail["reference"]["application_id"] == world.application_id(demo.REFERENCE_DOCUMENT)
    assert set(detail["sheet_roles"]) == {"main", "common"} and len(detail["rules"]) == 11 and detail["rules"][0]["rule_key"] == "product_name"
    temperature = next(r for r in detail["rules"] if r["rule_key"] == "temperature")
    assert temperature["field"] == {"key": "temperature", "name": "온도", "type": "decimal", "unit": "°C"} and temperature["status"] == "active"
    assert temperature["selector_summary"] == "key: main @hdr_temp · value: main rel(+1,+0)[60×1] list/down · unit: common rel(+0,+1)@unit_temp"
    assert temperature["value_spec"]["unit"] == "°C" and detail["document_count"] == 4
    revisions = world.get(f"/profiles/{world.profile_id}/revisions")["items"]
    assert [(r["rev"], r["current"], r["rule_count"]) for r in revisions] == [(1, True, 11)]
    canonical = world.get(f"/profiles/{world.profile_id}/revisions/1")
    assert canonical["format"] == "parsing-profile" and canonical["schema_version"] == "3.0" and len(canonical["rules"]) == 11
    assert world.get(f"/profiles/{world.profile_id}/revisions/2", expect=404)["error"]["code"] == "NOT_FOUND"
    export = world.client.get(f"/api/v3/profiles/{world.profile_id}/export")
    assert export.status_code == 200 and export.headers["Content-Disposition"].startswith("attachment;") and "filename*=UTF-8''" in export.headers["Content-Disposition"]
    assert export.json() == canonical
    assert world.get("/profiles/nope", expect=404)["error"]["code"] == "NOT_FOUND"


def test_profile_import_preview_create_update_and_test(world):
    preview = world.post("/profiles/import-preview", {"schema_key": "process_standard", "definition": V1_TEMPLATE})
    assert preview["format_detected"] == "v1-parsing-template" and preview["errors"] == []
    assert {w["code"] for w in preview["warnings"]} >= {"KEY_SEARCH_WINDOW", "CASEFOLD_MATCH", "KEY_INFERRED", "UNIT_CONVERSION"}
    assert preview["canonical"]["sheet_roles"]["본문"]["match"] == {"name": demo.MAIN_SHEET}
    preview_v2 = world.post("/profiles/import-preview", {"schema_key": "process_standard", "definition": V2_TEMPLATE})
    assert preview_v2["format_detected"] == "v2-template" and {w["code"] for w in preview_v2["warnings"]} >= {"DROPPED_FIELD", "MISSING_FIELD"}
    bad = world.post("/profiles/import-preview", {"schema_key": "process_standard", "definition": {"hello": 1}})
    assert bad["canonical"] is None and bad["errors"][0]["code"] == "UNSUPPORTED_PROFILE_FORMAT"
    unknown = world.post("/profiles/import-preview", {"schema_key": "nope", "definition": V2_TEMPLATE})
    assert unknown["errors"][0]["code"] == "UNKNOWN_SCHEMA"

    created = world.post("/profiles", {"name": "v1 이관", "schema_key": "process_standard", "definition": V1_TEMPLATE, "format": "v1-parsing-template"}, expect=201)
    assert created["status"] == "draft" and created["report"]["format_detected"] == "v1-parsing-template" and created["rules"] == 2
    assert world.post("/profiles", {"name": "v1 이관", "schema_key": "process_standard", "definition": V1_TEMPLATE}, expect=409)["error"]["code"] == "PROFILE_NAME_CONFLICT"
    assert world.post("/profiles", {"schema_key": "nope", "definition": V2_TEMPLATE}, expect=404)["error"]["code"] == "UNKNOWN_SCHEMA"
    other_schema = {"format": "parsing-schema", "schema_version": "3.0", "schema_key": "other", "schema_name": "다른 스키마", "fields": [{"field_key": "x", "name": "엑스", "type": "text"}]}
    world.post("/schemas", {"definition": other_schema}, expect=201)
    moved = copy.deepcopy(demo.PROFILE)
    moved["schema_key"] = "other"
    response = world.client.put(f"/api/v3/profiles/{created['profile_id']}", json={"definition": moved})
    assert response.status_code == 422 and response.json()["error"]["code"] == "SCHEMA_IMMUTABLE"
    updated = world.client.put(f"/api/v3/profiles/{created['profile_id']}", json={"definition": V2_TEMPLATE, "name": "v1 이관(v2 정의)"}).json()
    assert updated["current_rev"] == 2 and updated["profile_name"] == "v1 이관(v2 정의)" and updated["deprecated_rules"] == 1
    revisions = world.get(f"/profiles/{created['profile_id']}/revisions")["items"]
    assert [(r["rev"], r["current"]) for r in revisions] == [(2, True), (1, False)]
    assert world.get(f"/profiles/{created['profile_id']}")["current_rev"] == 2 and len(world.get("/profiles")["items"]) == 2

    sid = world.snapshot_id(demo.IDENTICAL_DOCUMENTS[1])
    tested = world.post(f"/profiles/{world.profile_id}/test", {"snapshot_id": sid})
    assert tested["compatibility"] == "identical" and tested["errors"] == [] and tested["bindings"] == {"main": [demo.MAIN_SHEET], "common": [demo.COMMON_SHEET]}
    groups = {g["rule_key"]: g for g in tested["groups"]}
    assert groups["temperature"]["count"] == demo.LOT_COUNT and groups["temperature"]["values"][0]["range"] == "C9" and groups["temperature"]["field"]["key"] == "temperature"
    job = world.get(f"/jobs/{tested['job_id']}")
    assert job["kind"] == "test" and job["state"] == "succeeded" and job["result"] == {"errors": 0, "groups": 11, "compatibility": "identical"}
    draft_test = world.post("/profiles/test", {"schema_key": "process_standard", "definition": V2_TEMPLATE, "snapshot_id": sid})
    assert draft_test["compatibility"] in ("compatible", "incompatible") and {g["rule_key"] for g in draft_test["groups"]} >= {"temp"}
    assert world.post(f"/profiles/{world.profile_id}/test", {"snapshot_id": "nope"}, expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.post(f"/profiles/{world.profile_id}/approve", {"application_id": world.application_id(demo.SHIFTED_DOCUMENT)}, expect=422)["error"]["code"] == "REVIEW_REQUIRED"
    assert world.post(f"/profiles/{created['profile_id']}/approve", {"application_id": world.application_id(demo.REFERENCE_DOCUMENT)}, expect=422)["error"]["code"] == "INVALID_APPLICATION"
    fill = world.post(f"/profiles/{world.profile_id}/reparse?wait=30", {"mode": "fill"})
    assert fill["state"] == "succeeded" and fill["result"]["queued"] == 0 and {s["reason"] for s in fill["result"]["skipped"]} == {"published", "review_required"}
    assert world.post(f"/profiles/{world.profile_id}/reparse", {"mode": "nope"}, expect=422)["error"]["code"] == "VALIDATION_ERROR"


# ---------------------------------------------------------------------------- 스키마


def test_schemas_list_detail_tree_graph_fields_and_edit(world):
    listed = world.get("/schemas")["items"]
    assert len(listed) == 1 and listed[0]["schema_key"] == "process_standard" and listed[0]["field_count"] == 14
    assert listed[0]["profile_count"] == 1 and listed[0]["document_count"] == 4 and listed[0]["current_rev"] == 1
    detail = world.get("/schemas/process_standard")
    assert detail["schema_name"] == "공정 데이터 표준" and len(detail["fields"]) == 14 and detail["fields"][0]["field_key"] == "basic"
    tree = world.get("/schemas/process_standard/tree")
    assert [n["field_key"] for n in tree["nodes"]] == ["basic", "process", "result"]
    process = tree["nodes"][1]
    assert [c["field_key"] for c in process["children"]] == ["process_name", "equipment", "lot", "measured_at", "temperature", "pressure", "duration"]
    assert process["children"][4]["unit"] == "°C" and process["children"][4]["children"] == [] and process["children"][4]["aliases"] == ["온도값", "Temp"]
    graph = world.get("/schemas/process_standard/graph")
    nodes = {n["field_key"]: n for n in graph["nodes"]}
    assert nodes["temperature"]["parents"] == ["process"] and nodes["temperature"]["document_count"] == 3 and nodes["temperature"]["profile_count"] == 1
    assert nodes["basic"]["document_count"] == 0 and nodes["basic"]["level"] == 1
    assert {"from": "process", "to": "temperature", "relation": "parent_of"} in graph["edges"] and {"from": "temperature", "to": "pressure", "relation": "related_to"} in graph["edges"]
    revisions = world.get("/schemas/process_standard/revisions")["items"]
    assert [(r["rev"], r["current"], r["field_count"]) for r in revisions] == [(1, True, 14)]
    profiles = world.get("/schemas/process_standard/profiles")["items"]
    assert len(profiles) == 1 and profiles[0]["rules"] == {"count": 11, "keys": ["product_name", "recipe_name", "process_name", "equipment", "lot"]} and profiles[0]["document_count"] == 4
    assert world.get("/schemas/process_standard/profiles?field_key=temperature")["items"][0]["rules"] == {"count": 1, "keys": ["temperature"]}
    assert world.get("/schemas/process_standard/profiles?field_key=basic")["items"] == []
    docs = world.get("/schemas/process_standard/documents?limit=3")
    assert docs["has_more"] and len(docs["items"]) == 3 and docs["items"][0]["profile"]["profile_name"] == demo.PROFILE_NAME and docs["items"][0]["snapshot"]["revision_no"] == 1
    rest = world.get(f"/schemas/process_standard/documents?limit=3&cursor={docs['next_cursor']}")
    assert [d["document_name"] for d in rest["items"]] == [demo.SHIFTED_DOCUMENT] and rest["items"][0]["status"] == "review" and not rest["items"][0]["published"]
    assert len(world.get("/schemas/process_standard/documents?field_key=temperature")["items"]) == 3
    assert world.get("/schemas/process_standard/documents?field_key=nope", expect=404)["error"]["code"] == "NOT_FOUND"
    field = world.get("/schemas/process_standard/fields/temperature")
    assert field["name"] == "온도" and field["type"] == "decimal" and field["unit"] == "°C" and field["aliases"] == ["온도값", "Temp"]
    assert field["parents"] == ["process"] and field["related"] == ["pressure"] and field["children"] == [] and field["profile_count"] == 1 and field["document_count"] == 3
    assert world.get("/schemas/process_standard/fields/process")["children"] == ["process_name", "equipment", "lot", "measured_at", "temperature", "pressure", "duration"]
    assert len(world.get("/schemas/process_standard/fields/temperature/profiles")["items"]) == 1
    assert len(world.get("/schemas/process_standard/fields/temperature/documents")["items"]) == 3
    values = world.get("/schemas/process_standard/fields/temperature/values?limit=5")["items"]
    assert len(values) == 5 and values[0]["sheet_name"] == demo.MAIN_SHEET and values[0]["range"].startswith("C") and values[0]["document_name"] in demo.IDENTICAL_DOCUMENTS
    assert values[0]["created_at"] >= values[-1]["created_at"] and values[0]["rule_key"] == "temperature" and values[0]["text"]
    assert world.get("/schemas/process_standard/fields/basic/values")["items"] == []
    patched = world.client.patch("/api/v3/schemas/process_standard/fields/temperature", json={"aliases": ["온도값", "Temp", "설정온도"], "description": "설정 온도"}).json()
    assert patched["current_rev"] == 2 and not patched["unchanged"]
    field = world.get("/schemas/process_standard/fields/temperature")
    assert field["aliases"] == ["온도값", "Temp", "설정온도"] and field["description"] == "설정 온도"
    assert [r["rev"] for r in world.get("/schemas/process_standard/revisions")["items"]] == [2, 1]
    assert world.client.patch("/api/v3/schemas/process_standard/fields/nope", json={"name": "x"}).status_code == 404
    assert world.client.patch("/api/v3/schemas/process_standard/fields/temperature", json={"status": "gone"}).json()["error"]["code"] == "VALIDATION_ERROR"
    definition = world.service.schema_definition("process_standard")
    definition["fields"].append({"field_key": "note", "name": "비고", "type": "text"})
    mismatch = world.client.put("/api/v3/schemas/other_key", json={"definition": definition})
    assert mismatch.status_code == 422 and mismatch.json()["error"]["code"] == "SCHEMA_KEY_MISMATCH"
    updated = world.client.put("/api/v3/schemas/process_standard", json={"definition": definition}).json()
    assert updated["current_rev"] == 3 and updated["added"] == 1
    assert world.get("/schemas")["items"][0]["field_count"] == 15
    invalid = world.post("/schemas", {"definition": {"schema_key": "bad key!", "schema_name": "x", "fields": []}}, expect=422)
    assert invalid["error"]["code"] == "INVALID_SCHEMA"
    assert world.get("/schemas/nope/tree", expect=404)["error"]["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------- 검수


def test_review_aggregate_cas_rollback_approve_all_and_reverse_lookup(world):
    aid = world.application_id(demo.SHIFTED_DOCUMENT)
    summary = world.get(f"/applications/{aid}")
    assert summary["compatibility"] == "compatible" and summary["origin"] == "auto" and not summary["published"]
    assert summary["heads_total"] == 11 and summary["heads_approved"] == 0 and summary["profile"]["profile_name"] == demo.PROFILE_NAME
    assert summary["document"]["document_name"] == demo.SHIFTED_DOCUMENT and [s["roles"] for s in summary["sheets"]] == [["main"], ["common"]]
    lot = next(m for m in summary["mappings"] if m["rule_key"] == "lot")
    assert lot["status"] == "proposed" and lot["edit_seq"] == 1 and lot["revision_no"] == 1 and lot["value"] is None
    assert lot["regions"][0] == {"role": "key", "sheet_id": summary["sheets"][0]["sheet_id"], "sheet_name": demo.MAIN_SHEET, "range": "A11"}
    assert world.get(f"/applications/{aid}/mappings")["items"] == summary["mappings"]
    single = world.get(f"/mappings/{lot['mapping_id']}")
    assert single["application_id"] == aid and single["rule_key"] == "lot"
    history = world.get(f"/mappings/{lot['mapping_id']}/revisions")["items"]
    assert len(history) == 1 and history[0]["origin"] == "profile" and history[0]["evidence"]["reason"] == "compatible" and history[0]["mapping_revision_id"]

    conflict = world.post(f"/mappings/{lot['mapping_id']}/revisions", {"expected_seq": 0, "status": "approved"}, expect=409)
    assert conflict["error"]["code"] == "EDIT_CONFLICT" and len(world.get(f"/mappings/{lot['mapping_id']}/revisions")["items"]) == 1
    sheet_id = summary["sheets"][0]["sheet_id"]
    revised = world.post(
        f"/mappings/{lot['mapping_id']}/revisions",
        {"expected_seq": 1, "status": "approved", "regions": [{"role": "key", "sheet_id": sheet_id, "range": "A11"}, {"role": "value", "sheet_id": sheet_id, "range": "A12:A23"}], "reason": "확인"},
        expect=201,
    )
    assert revised["status"] == "approved" and revised["edit_seq"] == 2 and revised["extraction"] is None and [r["range"] for r in revised["regions"]] == ["A11", "A12:A23"]
    assert world.post(f"/mappings/{lot['mapping_id']}/revisions", {"expected_seq": 1, "status": "proposed"}, expect=409)["error"]["code"] == "EDIT_CONFLICT"
    assert world.post(f"/mappings/{lot['mapping_id']}/revisions", {"expected_seq": 2, "status": "approved", "field_key": "basic"}, expect=422)["error"]["code"] == "GROUP_FIELD_TARGET"
    assert world.post(f"/mappings/{lot['mapping_id']}/revisions", {"expected_seq": 2, "status": "approved", "field_key": "nope"}, expect=422)["error"]["code"] == "UNKNOWN_FIELD"
    assert world.post(f"/mappings/{lot['mapping_id']}/revisions", {"expected_seq": -1, "status": "approved"}, expect=422)["error"]["code"] == "VALIDATION_ERROR"
    first_rev = world.get(f"/mappings/{lot['mapping_id']}/revisions")["items"][-1]["mapping_revision_id"]
    rolled = world.post(f"/mappings/{lot['mapping_id']}/rollback", {"expected_seq": 2, "target_revision_id": first_rev}, expect=201)
    assert rolled["status"] == "proposed" and rolled["revision_no"] == 3 and rolled["edit_seq"] == 3
    assert world.post(f"/mappings/{lot['mapping_id']}/rollback", {"expected_seq": 2, "target_revision_id": first_rev}, expect=409)["error"]["code"] == "EDIT_CONFLICT"
    assert world.post(f"/mappings/{lot['mapping_id']}/rollback", {"expected_seq": 3, "target_revision_id": "nope"}, expect=404)["error"]["code"] == "NOT_FOUND"

    done = world.post(f"/applications/{aid}/approve-all?wait=30", {})
    assert done["approved"] == 11 and done["skipped"] == [] and done["extraction"]["state"] == "succeeded" and done["extraction"]["kind"] == "extract"
    summary = world.get(f"/applications/{aid}")
    assert summary["published"] and summary["heads_approved"] == 11 and summary["mappings"][0]["value"]["value_text"] == "제품-04"
    temperature = next(m for m in summary["mappings"] if m["rule_key"] == "temperature")
    assert temperature["value"]["count"] == demo.LOT_COUNT and temperature["value"]["first_region"]["range"] == "C12"
    assert world.get(f"/documents/{summary['document']['document_id']}")["status"] == "normal"
    values = world.get(f"/applications/{aid}/values?rule_key=temperature")["items"]
    assert len(values) == demo.LOT_COUNT and values[0]["source"]["range"] == "C12" and values[0]["application_id"] == aid
    detail = world.get(f"/values/{values[0]['value_id']}")
    assert detail["document"]["document_name"] == demo.SHIFTED_DOCUMENT and detail["snapshot"]["revision_no"] == 1 and detail["mapping_id"] == temperature["mapping_id"]
    region_id = next(r["region_id"] for r in detail["regions"] if r["role"] == "value")
    reverse = world.get(f"/regions/{region_id}/values")
    assert reverse["region"]["range"] == "C12" and reverse["values"][0]["value_id"] == values[0]["value_id"] and reverse["values"][0]["published"]
    key_region = next(r["region_id"] for r in detail["regions"] if r["role"] == "key")
    key_reverse = world.get(f"/regions/{key_region}/values")
    assert any(m["rule_key"] == "temperature" and m["is_head"] for m in key_reverse["mappings"])
    grid = world.get(f"/sheets/{sheet_id}/regions?range=A11:C12")
    assert {r["range"] for r in grid["items"]} >= {"A11", "C11", "C12"} and grid["sheet"]["sheet_name"] == demo.MAIN_SHEET
    assert next(r for r in grid["items"] if r["range"] == "C12")["value_count"] == 1
    assert world.get(f"/sheets/{sheet_id}/regions?range=bad", expect=422)["error"]["code"] == "INVALID_RANGE"
    again = world.post(f"/applications/{aid}/extract?wait=30", expect=200)
    assert again["state"] == "succeeded" and again["result"]["published"] and again["result"]["value_count"] == 4 + demo.LOT_COUNT * 7
    queued = world.post(f"/applications/{aid}/extract", expect=202)
    assert queued["state"] == "queued" and queued["target_kind"] == "application"
    assert world.get("/values/nope", expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.get("/regions/nope/values", expect=404)["error"]["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------- 작업·보안


def test_jobs_list_filters_cursor_and_auth(world, monkeypatch):
    jobs = world.get("/jobs")
    assert jobs["items"] and jobs["items"][0]["created_at"] >= jobs["items"][-1]["created_at"]
    kinds = {j["kind"] for j in jobs["items"]}
    assert kinds >= {"register", "extract", "reparse"} and all(j["state"] == "succeeded" for j in jobs["items"])
    assert {j["kind"] for j in world.get("/jobs?kind=register")["items"]} == {"register"}
    assert world.get("/jobs?state=failed")["items"] == [] and world.get("/jobs?state=nope", expect=422)["error"]["code"] == "VALIDATION_ERROR"
    page1 = world.get("/jobs?limit=2")
    assert page1["has_more"] and len(page1["items"]) == 2
    page2 = world.get(f"/jobs?limit=2&cursor={page1['next_cursor']}")
    assert {j["job_id"] for j in page2["items"]}.isdisjoint({j["job_id"] for j in page1["items"]})
    one_job = world.get(f"/jobs/{page1['items'][0]['job_id']}")
    assert one_job["job_id"] == page1["items"][0]["job_id"] and set(one_job) >= {"kind", "state", "completed", "total", "result", "label", "target_kind", "target_id"}
    assert world.get("/jobs/nope", expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.post("/jobs/nope/cancel", expect=404)["error"]["code"] == "NOT_FOUND"

    monkeypatch.setenv("KG_V3_ACCESS_TOKEN", "secret")
    denied = world.client.get("/api/v3/status")
    assert denied.status_code == 401 and denied.json()["error"]["code"] == "AUTH_REQUIRED"
    assert world.client.get("/api/v3/status", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert world.client.get("/api/v3/status", headers={"Authorization": "Bearer secret"}).status_code == 200
    assert world.client.get("/api/v3/settings", headers={"Authorization": "Bearer secret"}).json()["access_token_required"]
    monkeypatch.delenv("KG_V3_ACCESS_TOKEN")
    monkeypatch.setenv("KG_V2_ACCESS_TOKEN", "fallback")
    assert world.client.get("/api/v3/status").status_code == 401
    assert world.client.get("/api/v3/status", headers={"Authorization": "Bearer fallback"}).status_code == 200


def test_body_limit_and_validation_shapes(world):
    big = world.client.post("/api/v3/profiles/import-preview", content=b'{"schema_key":"x","definition":{"pad":"' + b"a" * (2 * 1024 * 1024 + 10) + b'"}}', headers={"content-type": "application/json"})
    assert big.status_code == 413 and big.json()["error"]["code"] == "BODY_LIMIT"
    broken = world.client.post("/api/v3/profiles/import-preview", content=b"{not json", headers={"content-type": "application/json"})
    assert broken.status_code == 422 and broken.json()["error"]["code"] == "VALIDATION_ERROR"
    assert world.post("/profiles", {"schema_key": "process_standard"}, expect=422)["error"]["fields"][0]["field"].endswith("definition")


def test_install_into_webapp_alongside_v2(tmp_path, seeded):
    from kg.webapp import create_app as create_webapp

    source, _ = seeded
    root = tmp_path / "ws"
    shutil.copytree(source, root)
    app = create_webapp(root)
    with TestClient(app) as client:
        assert client.get("/api/v3/status").json()["counts"]["documents"] == 6
        assert client.get("/api/v2/status").status_code == 200
        v2_error = client.get("/api/v2/jobs/nope")
        assert v2_error.status_code == 404 and v2_error.json()["error"]["code"]
        assert client.get("/api/v3/documents?status=bogus").json()["error"]["code"] == "VALIDATION_ERROR"
