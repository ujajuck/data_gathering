"""폴더 일괄 등록(계약 §4.1.1): 재귀 스캔 분류·source_digest 재사용·일괄 등록 작업·한도·API·CLI.

사용자는 파일을 하나씩 고르지 않고 루트 폴더 하나를 지정한다. 스캔은 Reader 프로세스를 띄우지 않고(stat + 캐시된 해시),
등록 작업은 파일마다 진행률을 남기며, 변경 없는 파일은 건너뛴다.
"""

from __future__ import annotations

import json
import types

import pytest
from fastapi.testclient import TestClient

from schema import __main__ as cli
from schema import drm
from schema import jobs as jobs_module
from schema import service as service_module
from schema.api import create_app
from schema.db import Problem
from schema.service import Service
from tests.test_service import build_workbook

LOCKED_BYTES = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64  # PK 매직이 아닌 파일 = 잠김(DRM)
ALL_REFS = ("일괄/a.xlsx", "일괄/잠김.xlsx", "일괄/2024/b.xlsx", "일괄/2024/하위/c.xlsx")


def make_tree(root):
    """`일괄/` 아래 2단 하위 폴더 + 잠긴 파일 + 임시/지원하지 않는 파일 + 심볼릭 링크 + 숨김 폴더."""
    raw = root / "data/raw"
    (raw / "일괄/2024/하위").mkdir(parents=True)
    (raw / ".숨김").mkdir()
    build_workbook(raw / "일괄/a.xlsx")
    build_workbook(raw / "일괄/2024/b.xlsx")
    build_workbook(raw / "일괄/2024/하위/c.xlsx")
    build_workbook(raw / ".숨김/d.xlsx")
    (raw / "일괄/잠김.xlsx").write_bytes(LOCKED_BYTES)
    (raw / "일괄/~$임시.xlsx").write_text("temp", encoding="utf-8")
    (raw / "일괄/메모.txt").write_text("memo", encoding="utf-8")
    (raw / "일괄/링크.xlsx").symlink_to(raw / "일괄/a.xlsx")
    return raw


@pytest.fixture
def ws(tmp_path):
    root = tmp_path / "ws"
    (root / "data/raw").mkdir(parents=True)
    service = Service(root)
    service._render = types.SimpleNamespace(invalidate=lambda *_: None, close=lambda: None)
    service.raw = make_tree(root)
    try:
        yield service
    finally:
        service.close()


def refs_of(result):
    return [d["source_ref"] for d in result["documents"]]


def states_of(result):
    return {d["source_ref"]: d["state"] for d in result["documents"]}


# ---------------------------------------------------------------- 스캔(미리보기)


def test_scan_walks_subfolders_and_counts_skipped(ws):
    scan = ws.scan_sources("일괄")
    assert scan["directory"] == "일괄" and scan["folders"] == 2 and scan["files"] == 4
    assert scan["states"] == {"new": 4, "changed": 0, "unchanged": 0, "locked": 0}
    # 심볼릭 링크는 따라가지 않고, `~$`는 임시, 나머지 확장자는 지원하지 않음으로 센다.
    assert scan["skipped"] == {"temp": 1, "unsupported": 1, "symlink": 1}
    assert scan["targeted"] == 4 and scan["limit"] == 10000
    # 이름 순으로 결정적이다(폴더마다 파일 먼저, 그다음 하위 폴더).
    assert [s["source_ref"] for s in scan["sample"]] == list(ALL_REFS)
    assert {s["state"] for s in scan["sample"]} == {"new"}
    # 최상위 스캔은 숨김 폴더(.숨김/d.xlsx)에 들어가지 않는다.
    top = ws.scan_sources("")
    assert top["directory"] == "" and top["files"] == 4 and top["folders"] == 3


def test_scan_classifies_new_unchanged_changed_locked(ws):
    job = ws.register_directory("일괄", wait=120)
    assert job["state"] == "succeeded", job
    after = ws.scan_sources("일괄")
    assert after["states"] == {"new": 0, "changed": 0, "unchanged": 3, "locked": 1}
    assert after["targeted"] == 0
    # 내용이 바뀐 파일만 changed로 바뀐다.
    build_workbook(ws.raw / "일괄/2024/b.xlsx", temps=(41.5, 42, 43))
    changed = ws.scan_sources("일괄")
    assert changed["states"] == {"new": 0, "changed": 1, "unchanged": 2, "locked": 1}
    assert changed["targeted"] == 1
    assert [s for s in changed["sample"] if s["state"] == "changed"] == [{"source_ref": "일괄/2024/b.xlsx", "state": "changed"}]


def test_scan_reuses_source_digest_without_reading_files(ws, monkeypatch):
    """등록이 (byte_size, mtime_ns, change_token)을 캐시하므로 다음 스캔은 파일을 읽지 않는다(§1.6)."""
    assert ws.register_directory("일괄", wait=120)["state"] == "succeeded"
    calls = []
    monkeypatch.setattr(service_module, "file_hash", lambda path: calls.append(str(path)) or "0" * 64)
    scan = ws.scan_sources("일괄")
    assert calls == []
    assert scan["states"] == {"new": 0, "changed": 0, "unchanged": 3, "locked": 1}


def test_scan_skips_hash_when_size_differs(ws, monkeypatch):
    assert ws.register_directory("일괄", wait=120)["state"] == "succeeded"
    path = ws.raw / "일괄/a.xlsx"
    path.write_bytes(path.read_bytes() + b"\x00")  # 크기가 달라지면 해시를 계산하지 않는다

    def forbidden(_path):
        raise AssertionError("크기가 다르면 해시를 계산하지 않아야 한다")

    monkeypatch.setattr(service_module, "file_hash", forbidden)
    scan = ws.scan_sources("일괄")
    assert scan["states"] == {"new": 0, "changed": 1, "unchanged": 2, "locked": 1}


def test_invalid_or_missing_directory(ws):
    for directory in ("..", "일괄/../..", "/etc"):
        with pytest.raises(Problem) as exc:
            ws.scan_sources(directory)
        assert (exc.value.code, exc.value.status) == ("INVALID_SOURCE", 422), directory
    with pytest.raises(Problem) as exc:
        ws.scan_sources("없는폴더")
    assert (exc.value.code, exc.value.status) == ("SOURCE_NOT_FOUND", 404)
    # 절대 경로·상위 이동은 작업을 만들기 전에 거부한다.
    with pytest.raises(Problem) as exc:
        ws.register_directory("..", wait=0)
    assert exc.value.code == "INVALID_SOURCE"
    # 없는 폴더는 스캔에서 실패하므로 작업이 failed로 끝난다.
    job = ws.register_directory("없는폴더", wait=120)
    assert (job["state"], job["error_code"]) == ("failed", "SOURCE_NOT_FOUND")


def test_directory_limit(ws, monkeypatch):
    monkeypatch.setenv("SCHEMA_REGISTER_DIRECTORY_LIMIT", "3")
    with pytest.raises(Problem) as exc:
        ws.scan_sources("일괄")
    assert (exc.value.code, exc.value.status) == ("DIRECTORY_LIMIT", 413)
    assert "하위 폴더를 나누어 등록하세요" in exc.value.message
    job = ws.register_directory("일괄", wait=120)
    assert (job["state"], job["error_code"]) == ("failed", "DIRECTORY_LIMIT")
    monkeypatch.setenv("SCHEMA_REGISTER_DIRECTORY_LIMIT", "4")
    assert ws.scan_sources("일괄")["files"] == 4 and ws.scan_sources("일괄")["limit"] == 4
    # 걸은 항목(폴더+파일) 상한도 같은 코드로 막는다.
    monkeypatch.setattr(service_module, "SCAN_ENTRY_LIMIT", 2)
    with pytest.raises(Problem) as exc:
        ws.scan_sources("일괄")
    assert (exc.value.code, exc.value.status) == ("DIRECTORY_LIMIT", 413)


def test_scan_skips_names_that_normalization_would_move(ws):
    """이름에 '\\'가 든 파일은 §4.1 정규화가 경로를 바꿔 고른 폴더 밖을 가리킬 수 있다 — 대상에서 뺀다."""
    build_workbook(ws.raw / "target.xlsx")  # '일괄' 폴더 밖(최상위)의 문서
    (ws.raw / "일괄/..\\target.xlsx").write_bytes((ws.raw / "target.xlsx").read_bytes())
    (ws.raw / "일괄/b\\c.xlsx").write_bytes((ws.raw / "target.xlsx").read_bytes())
    (ws.raw / "일괄/d\\e").mkdir()
    build_workbook(ws.raw / "일괄/d\\e/f.xlsx")
    scan = ws.scan_sources("일괄")
    assert scan["files"] == 4 and scan["folders"] == 2  # 그대로: 셋 다 대상이 아니다
    assert scan["skipped"]["unsupported"] == 3  # 메모.txt + '\\'가 든 파일 2개
    assert [s["source_ref"] for s in scan["sample"]] == list(ALL_REFS)
    job = ws.register_directory("일괄", wait=120)
    assert job["state"] == "succeeded"
    # 폴더 밖 target.xlsx가 등록되지 않았다(정규화가 '일괄/..\\target.xlsx'를 'target.xlsx'로 바꾸는 구멍).
    names = sorted(d["document_name"] for d in ws.document_query(limit=50)["items"])
    assert names == ["a.xlsx", "b.xlsx", "c.xlsx", "잠김.xlsx"]


def test_legacy_xls_message_names_the_format(ws):
    """.xls(OLE2)는 보호 문서와 매직이 같다 — 어댑터가 없으면 둘 다 잠김이고, 문구가 무엇을 설정해야 하는지 말한다(§3.5(2))."""
    (ws.raw / "일괄/구형.xls").write_bytes(LOCKED_BYTES)
    job = ws.register_directory("일괄", wait=120)
    assert job["state"] == "succeeded", job
    rows = {d["source_ref"]: d for d in job["result"]["documents"]}
    legacy = rows["일괄/구형.xls"]
    assert (legacy["error"]["code"], legacy["status"]) == ("DRM_READER_REQUIRED", "locked")
    assert "구형 .xls 형식" in legacy["error"]["message"]
    assert ".xlsx로 저장" in legacy["error"]["message"]
    assert "SCHEMA_READER_FACTORY" in legacy["error"]["message"]
    # 확장자가 .xlsx인 보호 문서는 기본 문구 — 설정할 것(SCHEMA_READER_FACTORY)을 알려 준다.
    assert rows["일괄/잠김.xlsx"]["error"]["message"] == drm.READER_REQUIRED_MESSAGE
    assert "SCHEMA_READER_FACTORY" in drm.READER_REQUIRED_MESSAGE
    assert job["result"]["summary"]["locked"] == 2
    # §3.5(4): 잠긴 접근도 작업 결과의 해제 비용에 남는다.
    assert job["result"]["drm"] == {"unlocked": 0, "reused": 0, "failed": 2}


def test_unknown_provider_is_rejected_before_the_job(ws, monkeypatch):
    """Reader 어댑터가 없는 provider로는 작업을 만들지 않는다(§4.1) — 잠긴 문서 행 양산 방지."""
    for provider in ("xxxxxxxx", " "):
        with pytest.raises(Problem) as exc:
            ws.register_directory("일괄", provider=provider, wait=0)
        assert (exc.value.code, exc.value.status) == ("UNKNOWN_PROVIDER", 422)
        with pytest.raises(Problem) as exc:
            ws.register_documents(["일괄/a.xlsx"], provider=provider, wait=0)
        assert exc.value.code == "UNKNOWN_PROVIDER"
    assert ws.document_query(limit=50)["items"] == []
    # 어댑터를 연결하면 통과한다(등록은 그 어댑터가 맡는다).
    monkeypatch.setenv("SCHEMA_READER_FACTORY", "tests.fake_reader:make")
    assert ws.check_provider("drm-x") == "drm-x"


def test_single_register_fills_the_digest_cache(ws, monkeypatch):
    """§4.1 register가 캐시를 채우므로 watch·단일 등록으로 들어온 문서도 첫 폴더 미리보기가 파일을 읽지 않는다."""
    job = ws.register_documents(["일괄/a.xlsx", "일괄/2024/b.xlsx", "일괄/2024/하위/c.xlsx"], wait=120)
    assert job["state"] == "succeeded", job
    with ws.db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM source_digest").fetchone()[0] == 3
    calls = []
    monkeypatch.setattr(service_module, "file_hash", lambda path: calls.append(str(path)) or "0" * 64)
    scan = ws.scan_sources("일괄")
    assert calls == []  # stat만 보고 끝난다
    assert scan["states"] == {"new": 1, "changed": 0, "unchanged": 3, "locked": 0}


def test_scan_and_hash_report_progress(ws, monkeypatch):
    """스캔·해시 구간에도 checkpoint를 불러 진행률이 비지 않고 취소가 먹는다(§4.1.1)."""
    seen = []

    def note(completed=None, total=None, force=False):
        seen.append((completed, total))

    ws._scan_files("일괄", note)
    assert len(seen) == 3  # 폴더를 하나 끝낼 때마다(일괄 · 2024 · 하위)
    assert ws.register_directory("일괄", wait=120)["state"] == "succeeded"
    with ws.db.connect(write=True) as conn:
        conn.execute("DELETE FROM source_digest")  # §1.6 캐시는 언제 지워도 된다 — 다음 스캔이 다시 해시한다
    seen.clear()
    monkeypatch.setattr(service_module, "HASH_CHECKPOINT", 1)
    ws._classify_files(ws._scan_files("일괄")["files"], "local-xlsx", "일괄", note)
    # 해시를 계산할 때마다 (지금까지 본 파일 수, 스캔한 파일 수). 잠긴 파일은 해시하지 않는다.
    assert seen == [(1, 4), (3, 4), (4, 4)]


# ---------------------------------------------------------------- 일괄 등록 작업


def test_register_directory_job_summary_and_rows(ws):
    job = ws.register_directory("일괄", wait=120)
    assert job["state"] == "succeeded", job
    assert (job["kind"], job["target_kind"], job["label"]) == ("register", "workspace", "일괄 폴더 일괄 등록")
    assert (job["completed"], job["total"]) == (4, 4)
    result = job["result"]
    assert result["directory"] == "일괄" and result["truncated"] is False
    # 전부 실패해도 작업은 succeeded다: 잠긴 파일 1개는 행의 error로 남는다.
    assert result["summary"] == {
        "found": 4,
        "targeted": 4,
        "registered": 3,
        "new": 4,
        "changed": 0,
        "unchanged": 0,
        "failed": 1,
        "locked": 1,
        "skipped": {"temp": 1, "unsupported": 1, "symlink": 1},
    }
    assert refs_of(result) == list(ALL_REFS)
    assert set(states_of(result).values()) == {"new"}
    rows = {d["source_ref"]: d for d in result["documents"]}
    assert rows["일괄/a.xlsx"]["document_name"] == "a.xlsx"
    assert rows["일괄/a.xlsx"]["snapshot"]["revision_no"] == 1
    assert rows["일괄/a.xlsx"]["status"] == "unmatched" and rows["일괄/a.xlsx"]["applied"] == []
    assert rows["일괄/잠김.xlsx"]["error"]["code"] == "DRM_READER_REQUIRED"
    assert rows["일괄/잠김.xlsx"]["status"] == "locked"
    # 하위 폴더 파일도 data/raw 기준 상대 경로로 등록된다.
    documents = ws.document_query(limit=50)["items"]
    assert sorted(d["document_name"] for d in documents) == ["a.xlsx", "b.xlsx", "c.xlsx", "잠김.xlsx"]

    # 두 번째 실행: 변경 없는 파일은 건너뛴다(등록 대상 0).
    again = ws.register_directory("일괄", wait=120)
    assert again["state"] == "succeeded"
    assert again["result"]["summary"] | {"skipped": None} == {
        "found": 4,
        "targeted": 0,
        "registered": 0,
        "new": 0,
        "changed": 0,
        "unchanged": 3,
        "failed": 0,
        "locked": 1,
        "skipped": None,
    }
    assert again["result"]["documents"] == []


def test_include_unchanged_rereads_unchanged_and_locked(ws):
    assert ws.register_directory("일괄", wait=120)["state"] == "succeeded"
    job = ws.register_directory("일괄", include_unchanged=True, wait=120)
    assert job["state"] == "succeeded", job
    summary = job["result"]["summary"]
    assert (summary["targeted"], summary["registered"], summary["failed"]) == (4, 3, 1)
    # 잠김은 스캔 분류와 이번 실패를 합쳐 두 번 세지 않는다.
    assert (summary["unchanged"], summary["locked"], summary["new"], summary["changed"]) == (3, 1, 0, 0)
    assert states_of(job["result"]) == {
        "일괄/a.xlsx": "unchanged",
        "일괄/잠김.xlsx": "locked",
        "일괄/2024/b.xlsx": "unchanged",
        "일괄/2024/하위/c.xlsx": "unchanged",
    }
    rows = {d["source_ref"]: d for d in job["result"]["documents"]}
    # 다시 읽어도 token이 같으므로 새 snapshot은 만들지 않는다.
    assert rows["일괄/a.xlsx"]["snapshot"]["revision_no"] == 1
    assert rows["일괄/a.xlsx"]["snapshot"]["unchanged"] is True


def test_documents_rows_are_capped(ws, monkeypatch):
    monkeypatch.setattr(service_module, "REGISTER_DIRECTORY_ROWS", 2)
    result = ws.register_directory("일괄", wait=120)["result"]
    assert result["truncated"] is True and len(result["documents"]) == 2
    assert refs_of(result) == list(ALL_REFS[:2])
    # 요약은 항상 전체 기준이다.
    assert (result["summary"]["found"], result["summary"]["registered"]) == (4, 3)


def test_cancel_keeps_already_registered_documents(ws, monkeypatch):
    job = ws.register_directory("일괄", wait=0)
    assert job["state"] == "queued"
    original = Service.register

    def register_then_cancel(self, *args, **kwargs):
        row = original(self, *args, **kwargs)
        ws.jobs.cancel(job["job_id"])  # 첫 파일을 끝낸 직후 취소를 요청한다
        return row

    monkeypatch.setattr(Service, "register", register_then_cancel)
    assert ws.jobs.run_one() is True
    final = ws.jobs.get(job["job_id"])
    assert (final["state"], final["error_code"]) == ("cancelled", "CANCELLED")
    # 그때까지 등록된 문서는 남는다.
    names = [d["document_name"] for d in ws.document_query(limit=50)["items"]]
    assert names == ["a.xlsx"]


# ---------------------------------------------------------------- API


@pytest.fixture
def client(tmp_path):
    root = tmp_path / "api-ws"
    (root / "data/raw").mkdir(parents=True)
    make_tree(root)
    app = create_app(root, start_worker=False)
    with TestClient(app, base_url="http://127.0.0.1") as test_client:
        app.state.service._render = types.SimpleNamespace(
            invalidate=lambda *_: None, close=lambda: None, mode="inprocess", url=None, status=lambda: {}
        )
        yield test_client


def test_api_scan_and_register_directory(client, monkeypatch):
    scan = client.get("/api/sources/scan", params={"directory": "일괄"})
    assert scan.status_code == 200
    body = scan.json()
    assert body["files"] == 4 and body["folders"] == 2 and body["targeted"] == 4
    assert body["states"] == {"new": 4, "changed": 0, "unchanged": 0, "locked": 0}
    assert body["skipped"] == {"temp": 1, "unsupported": 1, "symlink": 1}

    error = client.get("/api/sources/scan", params={"directory": "../etc"})
    assert (error.status_code, error.json()["error"]["code"]) == (422, "INVALID_SOURCE")
    missing = client.get("/api/sources/scan", params={"directory": "없는폴더"})
    assert (missing.status_code, missing.json()["error"]["code"]) == (404, "SOURCE_NOT_FOUND")

    response = client.post("/api/documents/register-directory?wait=60", json={"directory": "일괄"})
    assert response.status_code == 200, response.text[:400]
    job = response.json()
    assert job["state"] == "succeeded" and job["label"] == "일괄 폴더 일괄 등록"
    assert job["result"]["summary"]["registered"] == 3 and job["result"]["summary"]["failed"] == 1
    assert len(job["result"]["documents"]) == 4

    # 미리보기를 다시 부르면 등록 대상이 0이다(프런트의 '등록 시작' 비활성 조건).
    assert client.get("/api/sources/scan", params={"directory": "일괄"}).json()["targeted"] == 0
    assert client.get("/api/settings").json()["limits"]["register_directory_files"] == 10000
    unknown = client.post("/api/documents/register-directory", json={"directory": "일괄", "recursive": False})
    assert (unknown.status_code, unknown.json()["error"]["code"]) == (422, "VALIDATION_ERROR")
    bad = client.post("/api/documents/register-directory?wait=60", json={"directory": "일괄", "provider": "xxxxxxxx"})
    assert (bad.status_code, bad.json()["error"]["code"]) == (422, "UNKNOWN_PROVIDER")
    assert len(client.get("/api/documents").json()["items"]) == 4  # 잠긴 행이 늘지 않았다

    # 짧은 배열은 목록에도 그대로 싣는다(§6).
    listed = next(j for j in client.get("/api/jobs").json()["items"] if j["kind"] == "register")
    assert len(listed["result"]["documents"]) == 4
    # 긴 배열은 본문 대신 <key>_count만(§6): 폴더 일괄 등록 500행이 목록 한 페이지를 수 MB로 만들지 않게 한다.
    monkeypatch.setattr(jobs_module, "BRIEF_ROWS", 2)
    listed = next(j for j in client.get("/api/jobs").json()["items"] if j["kind"] == "register")
    assert "documents" not in listed["result"] and listed["result"]["documents_count"] == 4
    assert listed["result"]["summary"]["registered"] == 3
    detail = client.get("/api/jobs/" + listed["job_id"]).json()
    assert len(detail["result"]["documents"]) == 4


# ---------------------------------------------------------------- CLI


def test_cli_register(tmp_path, capsys):
    root = tmp_path / "cli-ws"
    (root / "data/raw").mkdir(parents=True)
    make_tree(root)
    # 잠긴 파일 1개가 실패하므로 종료 코드는 1이다.
    assert cli.main(["register", "--ws", str(root), "--directory", "일괄"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["summary"]["registered"] == 3 and result["summary"]["failed"] == 1
    assert [d["source_ref"] for d in result["documents"]] == list(ALL_REFS)

    # 두 번째 실행은 변경 없음 3 + 잠김 1로 대상이 없어 성공(0)한다.
    assert cli.main(["register", "--ws", str(root), "--directory", "일괄"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"] == {
        "found": 4,
        "targeted": 0,
        "registered": 0,
        "new": 0,
        "changed": 0,
        "unchanged": 3,
        "failed": 0,
        "locked": 1,
        "skipped": {"temp": 1, "unsupported": 1, "symlink": 1},
    }
    assert cli.main(["register", "--ws", str(root), "--directory", ".."]) == 2
    assert json.loads(capsys.readouterr().err)["error"]["code"] == "INVALID_SOURCE"
