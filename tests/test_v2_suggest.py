"""같은 양식 문서군 제안과 레시피(매핑) 이식: 서명 캐시, 점수·임계값, 검수 대기 이식, 시트 바인딩."""

import json

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from kg.v2.api import create_app
from kg.v2.db import uid
from kg.v2.spec import decimal


def process_workbook(path, second_sheet="공통 정보", base=100):
    wb = Workbook()
    ws = wb.active
    ws.title = "공정 기록"
    ws["A1"] = "공정 운전 기록"
    ws.merge_cells("A1:F1")
    ws["A3"], ws["B3"], ws["D3"], ws["E3"] = "배치", "공정", "온도", "시간"
    ws.merge_cells("B3:C3")
    for n, row in enumerate(range(4, 21)):
        ws.cell(row, 1, f"LOT-{n + 1:03d}")
        ws.cell(row, 2, base + n)
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=3)
        ws.cell(row, 4, base * 2 + n)
        ws.cell(row, 5, n)
    common = wb.create_sheet(second_sheet)
    common["A1"], common["B1"] = "온도 단위", "°C"
    wb.save(path)


def sales_workbook(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "매출"
    ws["A1"], ws["B1"], ws["C1"] = "지역", "월", "매출액"
    for row in range(2, 15):
        ws.cell(row, 1, row * 10)
        ws.cell(row, 2, row)
        ws.cell(row, 3, row * 1000)
    wb.create_sheet("메모")["A1"] = "비고"
    wb.save(path)


@pytest.fixture(scope="module")
def workspace(tmp_path_factory):
    root = tmp_path_factory.mktemp("suggest")
    raw = root / "data/raw"
    raw.mkdir(parents=True)
    process_workbook(raw / "report_a.xlsx", base=100)
    process_workbook(raw / "report_b.xlsx", base=500)
    process_workbook(raw / "report_d.xlsx", second_sheet="단위", base=900)
    sales_workbook(raw / "report_c.xlsx")
    app = create_app(root, start_worker=False)
    with TestClient(app) as client:
        service = app.state.v2

        def request(method, url, body=None, code=200):
            response = client.request(method, "/api/v2" + url, json=body)
            assert response.status_code == code, response.text
            return response.json()

        def work(url, body):
            job = request("POST", url, {**body, "request_key": uid()}, 202)
            service.jobs.run_one()
            return request("GET", "/jobs/" + job["job_id"])

        def register(name):
            job = work("/documents/register", {"source_refs": [name]})
            assert job["state"] == "succeeded", job
            doc = job["result"]["documents"][0]
            doc["sheets"] = request("GET", f"/versions/{doc['version_id']}/sheets")[
                "items"
            ]
            doc["by_name"] = {s["name"]: s["sheet_id"] for s in doc["sheets"]}
            return doc

        docs = {k: register(f"report_{k}.xlsx") for k in ("a", "b", "c", "d")}
        kg = request(
            "POST",
            "/kg/import",
            {
                "concepts": [
                    {"concept_id": "temperature", "name": "공정온도", "level": 1},
                    {"concept_id": "ambient", "name": "주위온도", "level": 1},
                ]
            },
        )
        rule = {
            "rule_key": "temperature",
            "concept_id": "temperature",
            "record_spec": {"scope": ["process"], "key": {"column": "A"}},
            "selector": {
                "key": {
                    "areas": [
                        {"sheet_role": "main", "range": "B3:C3"},
                        {"sheet_role": "main", "range": "D3"},
                    ]
                },
                "value": {
                    "areas": [{"sheet_role": "main", "range": "B4:C20"}],
                    "cardinality": "list",
                    "axis": "down",
                    "element_layout": "one_per_row",
                },
                "unit": {"areas": [{"sheet_role": "common", "range": "B1"}]},
            },
            "value_spec": {"type": "decimal", "unit": "°C"},
        }
        template = request(
            "POST",
            "/templates",
            {
                "name": "공정 운전 기록",
                "definition": {
                    "kg_revision_id": kg["kg_revision_id"],
                    "sheet_roles": {
                        "main": {"cardinality": "one"},
                        "common": {"cardinality": "one"},
                    },
                    "rules": [rule],
                },
            },
        )
        app_a = request(
            "POST",
            "/applications",
            {
                "version_id": docs["a"]["version_id"],
                "template_version_id": template["template_version_id"],
                "bindings": {
                    "main": [docs["a"]["by_name"]["공정 기록"]],
                    "common": [docs["a"]["by_name"]["공통 정보"]],
                },
                "approved": True,
            },
        )["application_id"]
        first = request("GET", f"/applications/{app_a}/mappings")["items"][0]
        edited = json.loads(json.dumps(rule))
        edited["selector"]["value"]["areas"][0]["range"] = "B4:C18"
        head_a = request(
            "POST",
            f"/applications/{app_a}/mappings/{first['mapping_revision_id']}/revisions",
            {
                "expected_seq": first["edit_seq"],
                "effective_spec": edited,
                "concept_id": "temperature",
                "status": "approved",
                "reason": "값 영역 축소",
            },
        )
        app_c = request(
            "POST",
            "/applications",
            {
                "version_id": docs["c"]["version_id"],
                "template_version_id": template["template_version_id"],
                "bindings": {
                    "main": [docs["c"]["by_name"]["매출"]],
                    "common": [docs["c"]["by_name"]["메모"]],
                },
            },
        )["application_id"]
        yield {
            "api": request,
            "work": work,
            "register": register,
            "service": service,
            "client": client,
            "root": root,
            "docs": docs,
            "template": template,
            "app_a": app_a,
            "app_c": app_c,
            "head_a": head_a,
        }


def signature_of(s, version_id):
    with s["service"].db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM version_signature WHERE document_version_id=?",
            (version_id,),
        ).fetchone()
    return dict(row) if row else None


def count(s, sql, params=()):
    with s["service"].db.connect() as conn:
        return conn.execute(sql, params).fetchone()[0]


def test_signature_cached_on_registration_and_listing_never_opens_sources(workspace):
    s = workspace
    for doc in s["docs"].values():
        row = signature_of(s, doc["version_id"])
        assert row and row["algorithm"] == "structure-v1"
        assert doc["signature"] == "ready"
    sheet = json.loads(signature_of(s, s["docs"]["b"]["version_id"])["signature_json"])[
        "sheets"
    ][0]
    assert sheet["name"] == "공정 기록" and sheet["name_norm"] == "공정 기록"
    assert {"공정", "온도", "배치", "공정 운전 기록", "lot-001"} <= set(sheet["headers"])
    for term in sheet["headers"]:
        with pytest.raises(Exception):
            decimal(term)
    assert {"A1:F1", "B3:C3", "B4:C4"} <= set(sheet["merges"])
    assert sheet["dims"]["rows"] == 20 and sheet["dims"]["cols"] == 6
    # 제안 목록은 메타데이터와 캐시된 서명만 사용하며 원본을 열지 않는다.
    original = s["service"].read

    def no_read(*args, **kwargs):
        raise AssertionError("suggestion listing opened source")

    s["service"].read = no_read
    try:
        result = s["api"]("GET", f"/versions/{s['docs']['b']['version_id']}/suggestions")
    finally:
        s["service"].read = original
    assert result["signature_status"] == "ready" and result["items"]


def test_suggestions_rank_by_score_and_apply_threshold(workspace):
    s = workspace
    vid = s["docs"]["b"]["version_id"]
    result = s["api"]("GET", f"/versions/{vid}/suggestions")
    assert result["signature_status"] == "ready"
    assert result["candidates"] == 2 and result["unsigned_candidates"] == 0
    assert [i["source_application_id"] for i in result["items"]] == [s["app_a"]]
    top = result["items"][0]
    assert top["score"] >= 0.95
    assert top["breakdown"]["sheet_names"]["score"] == 1
    assert top["breakdown"]["headers"]["score"] >= 0.9
    assert top["breakdown"]["merges"]["score"] >= 0.9
    assert top["source_document_name"] == "report_a.xlsx"
    assert top["template_name"] == "공정 운전 기록"
    assert top["template_version_id"] == s["template"]["template_version_id"]
    assert top["approved_rules"] == 1 and top["total_rules"] == 1
    assert top["unmatched_roles"] == []
    assert {m["role"]: m["target_sheet"] for m in top["matched_sheets"]} == {
        "main": "공정 기록",
        "common": "공통 정보",
    }
    assert all(m["target_sheet_id"] for m in top["matched_sheets"])
    everything = s["api"]("GET", f"/versions/{vid}/suggestions?threshold=0")
    assert [i["source_application_id"] for i in everything["items"]] == [
        s["app_a"],
        s["app_c"],
    ]
    assert everything["items"][1]["score"] < 0.5
    assert everything["items"][1]["unmatched_roles"] == ["common", "main"]
    assert everything["has_more"] is False and everything["next_cursor"] is None
    limited = s["api"]("GET", f"/versions/{vid}/suggestions?threshold=0&limit=1")
    assert len(limited["items"]) == 1 and limited["candidates"] == 2
    s["api"]("GET", "/versions/missing/suggestions", code=404)
    error = s["api"]("GET", f"/versions/{vid}/suggestions?threshold=2", code=422)
    assert error["error"]["code"] == "VALIDATION_ERROR"


def test_from_suggestion_creates_proposed_candidate_revisions_without_heads(workspace):
    s = workspace
    vid = s["docs"]["b"]["version_id"]
    before = count(s, "SELECT count(*) FROM mapping_revision WHERE application_id=?", (s["app_a"],))
    created = s["api"](
        "POST",
        f"/versions/{vid}/applications/from-suggestion",
        {"source_application_id": s["app_a"]},
    )
    new = created["application_id"]
    assert created["status"] == "proposed" and created["rules"] == 1
    assert created["template_version_id"] == s["template"]["template_version_id"]
    assert created["bindings"] == {
        "main": [s["docs"]["b"]["by_name"]["공정 기록"]],
        "common": [s["docs"]["b"]["by_name"]["공통 정보"]],
    }
    mappings = s["api"]("GET", f"/applications/{new}/mappings")["items"]
    assert len(mappings) == 1
    assert all(
        m["status"] == "proposed" and m["edit_seq"] == 0 and m["revision_no"] == 1
        for m in mappings
    )
    detail = s["api"]("GET", "/mappings/" + mappings[0]["mapping_revision_id"])
    assert detail["origin"] == "candidate" and detail["status"] == "proposed"
    assert detail["effective_spec"]["selector"]["value"]["areas"][0]["range"] == "B4:C18"
    assert detail["concept_id"] == "temperature"
    origin = detail["evidence"]["transplanted_from"]
    assert origin["mapping_revision_id"] == s["head_a"]["mapping_revision_id"]
    assert origin["was_head"] is True and origin["application_id"] == s["app_a"]
    assert detail["evidence"]["similarity"]["score"] >= 0.95
    assert detail["evidence"]["concept_dropped"] is False
    assert s["app_a"] in detail["reason"]
    assert count(s, "SELECT count(*) FROM mapping_head WHERE application_id=?", (new,)) == 0
    assert (
        count(s, "SELECT count(*) FROM mapping_revision WHERE application_id=?", (s["app_a"],))
        == before
    )
    # 자동 승인되지 않았으므로 추출은 검수를 요구한다.
    error = s["api"](
        "POST", f"/applications/{new}/extract", {"request_key": uid()}, code=409
    )
    assert error["error"]["code"] == "REVIEW_REQUIRED"
    approved = s["api"](
        "POST",
        f"/applications/{new}/mappings/{mappings[0]['mapping_revision_id']}/revisions",
        {
            "expected_seq": 0,
            "effective_spec": detail["effective_spec"],
            "concept_id": "temperature",
            "status": "approved",
        },
    )
    assert approved["edit_seq"] == 2 and approved["revision_no"] == 2
    job = s["work"](f"/applications/{new}/extract", {})
    assert job["state"] == "succeeded", job


def test_from_suggestion_reports_unmatched_roles_and_accepts_override(workspace):
    s = workspace
    vid = s["docs"]["d"]["version_id"]
    url = f"/versions/{vid}/applications/from-suggestion"
    error = s["api"]("POST", url, {"source_application_id": s["app_a"]}, code=409)
    assert error["error"]["code"] == "SHEET_UNMATCHED"
    assert "common" in error["error"]["message"] and "공통 정보" in error["error"]["message"]
    assert (
        count(s, "SELECT count(*) FROM template_application WHERE document_version_id=?", (vid,))
        == 0
    )
    unit = s["docs"]["d"]["by_name"]["단위"]
    created = s["api"](
        "POST",
        url,
        {"source_application_id": s["app_a"], "sheet_bindings": {"common": unit}},
    )
    assert created["bindings"] == {
        "main": [s["docs"]["d"]["by_name"]["공정 기록"]],
        "common": [unit],
    }
    bad = s["api"](
        "POST",
        url,
        {"source_application_id": s["app_a"], "sheet_bindings": {"common": "nope"}},
        code=422,
    )
    assert bad["error"]["code"] == "INVALID_SHEET_BINDING"
    dup = s["api"](
        "POST",
        url,
        {"source_application_id": s["app_a"], "sheet_bindings": {"common": [unit, unit]}},
        code=422,
    )
    assert dup["error"]["code"] == "INVALID_SHEET_BINDING"
    named = s["api"](
        "POST",
        url,
        {
            "source_application_id": s["app_a"],
            "sheet_bindings": {"common": [unit]},
            "name": "재검수",
        },
    )
    with s["service"].db.connect() as conn:
        assert (
            conn.execute(
                "SELECT scope_key FROM template_application WHERE application_id=?",
                (named["application_id"],),
            ).fetchone()[0]
            == "재검수"
        )
    conflict = s["api"](
        "POST",
        url,
        {
            "source_application_id": s["app_a"],
            "sheet_bindings": {"common": [unit]},
            "name": "재검수",
        },
        code=409,
    )
    assert conflict["error"]["code"] == "INTEGRITY_CONFLICT"
    same = s["api"](
        "POST",
        f"/versions/{s['docs']['a']['version_id']}/applications/from-suggestion",
        {"source_application_id": s["app_a"]},
        code=409,
    )
    assert same["error"]["code"] == "SAME_VERSION"
    s["api"]("POST", url, {"source_application_id": s["app_a"], "extra": 1}, code=422)
    s["api"]("POST", url, {"source_application_id": "missing"}, code=404)


def test_signature_endpoint_backfills_missing_signature(workspace):
    s = workspace
    vid = s["docs"]["b"]["version_id"]
    with s["service"].db.connect(write=True) as conn:
        conn.execute("DELETE FROM version_signature WHERE document_version_id=?", (vid,))
    missing = s["api"]("GET", f"/versions/{vid}/suggestions")
    assert missing["signature_status"] == "missing" and missing["items"] == []
    first = s["api"]("POST", f"/versions/{vid}/signature", {})
    assert first["status"] == "ready" and first["cached"] is False
    assert first["sheets"] == 2 and first["signature_sha256"]
    again = s["api"]("POST", f"/versions/{vid}/signature", {})
    assert again["cached"] is True
    restored = s["api"]("GET", f"/versions/{vid}/suggestions")
    assert restored["signature_status"] == "ready" and restored["items"]
    # 원본이 사라진 버전은 서명을 계산하지 못하지만 등록 자체는 유지된다.
    raw = s["root"] / "data/raw"
    process_workbook(raw / "report_e.xlsx", base=700)
    gone = s["register"]("report_e.xlsx")
    with s["service"].db.connect(write=True) as conn:
        conn.execute(
            "DELETE FROM version_signature WHERE document_version_id=?",
            (gone["version_id"],),
        )
    (raw / "report_e.xlsx").unlink()
    error = s["api"]("POST", f"/versions/{gone['version_id']}/signature", {}, code=404)
    assert error["error"]["code"] == "SOURCE_NOT_FOUND"
    assert s["api"]("GET", f"/versions/{gone['version_id']}/sheets")["items"]


def test_protected_reader_uses_viewport_fallback_for_signature(tmp_path, monkeypatch):
    monkeypatch.setenv("KG_V2_READER_FACTORY", "tests.v2_reader_fixture:factory")
    raw = tmp_path / "data/raw"
    raw.mkdir(parents=True)
    protected = raw / "protected.bin"
    protected.write_bytes(b"DRM\0opaque-test-ciphertext")
    app = create_app(tmp_path, start_worker=False)
    with TestClient(app) as client:
        service = app.state.v2
        response = client.post(
            "/api/v2/documents/register",
            json={
                "provider": "protected-reader",
                "source_refs": ["opaque:protected-1"],
                "request_key": uid(),
            },
        )
        assert response.status_code == 202, response.text
        service.jobs.run_one()
        job = service.jobs.get(response.json()["job_id"], "local-user")
        assert job["state"] == "succeeded", job
        doc = job["result"]["documents"][0]
        assert doc["signature"] == "ready"
        with service.db.connect() as conn:
            row = conn.execute(
                "SELECT signature_json FROM version_signature WHERE document_version_id=?",
                (doc["version_id"],),
            ).fetchone()
        signature = json.loads(row["signature_json"])
        assert signature["sheets"][0]["name"] == "Protected"
        assert signature["sheets"][0]["headers"] == []
        assert signature["sheets"][0]["merges"] == []
        assert list(raw.iterdir()) == [protected]
        result = client.get(f"/api/v2/versions/{doc['version_id']}/suggestions").json()
        assert result["items"] == [] and result["signature_status"] == "ready"


def test_cli_parse_keeps_serve_default_and_adds_sign(workspace):
    from kg.v2.__main__ import parse_args
    from kg.v2.suggest import sign_versions

    serve = parse_args(["--ws", "x", "--port", "1"])
    assert serve.command == "serve" and serve.port == 1 and str(serve.ws) == "x"
    assert parse_args([]).command == "serve"
    sign = parse_args(["sign", "--ws", "x", "--version", "v"])
    assert sign.command == "sign" and sign.version == "v"
    s = workspace
    vid = s["docs"]["b"]["version_id"]
    with s["service"].db.connect(write=True) as conn:
        conn.execute("DELETE FROM version_signature WHERE document_version_id=?", (vid,))
    lines = list(sign_versions(s["service"], None, "local-user"))
    assert f"{vid} ready" in lines
    assert signature_of(s, vid)
    assert list(sign_versions(s["service"], vid, "local-user")) == [f"{vid} ready"]
    assert list(sign_versions(s["service"], "missing", "local-user")) == [
        "missing failed NOT_FOUND"
    ]


def test_openapi_from_suggestion_contract(workspace):
    schema = workspace["client"].get("/openapi.json").json()["components"]["schemas"]
    model = schema["FromSuggestionRequest"]
    assert model["required"] == ["source_application_id"]
    assert {"sheet_bindings", "name"} <= set(model["properties"])
