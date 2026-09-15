"""§4.13 문서 삭제 — 표별로 사라지는 행, 원본 파일 보존/삭제, 심볼릭 링크 거부, 대표 문서 참조 되돌림,
재등록, 작업 내역, 다중 삭제 요약, 진행 중 작업·상한 거부. §1.10 가드는 tests/test_schema.py가 DDL 쪽에서 본다."""

from __future__ import annotations

import json
import types

from schema import drm

from examples.demo import demo
from tests.test_api import seeded, world  # noqa: F401  (시드 작업 공간 fixture 재사용)

REFERENCE = demo.REFERENCE_DOCUMENT
PLAIN = "공정데이터_2024_02.xlsx"
UNMATCHED = demo.OTHER_DOCUMENT
LOCKED = demo.LOCKED_DOCUMENT
TABLES = (
    "document", "document_snapshot", "sheet", "source_region", "snapshot_signature",
    "parsing_application", "application_sheet", "mapping", "mapping_revision", "mapping_region",
    "extraction_run", "extracted_value", "extracted_value_region", "source_digest",
    "parsing_schema", "parsing_field", "parsing_alias", "parsing_field_edge", "parsing_profile", "parsing_rule",
)


def counts(world):
    with world.service.db.connect() as conn:
        return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in TABLES}


def jobs_of(world, kind):
    with world.service.db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM runtime_job WHERE kind=? ORDER BY created_at", (kind,))]


def raw(world, name):
    return world.root / "data/raw" / name


# ---------------------------------------------------------------------------- 단건 삭제


def test_delete_document_removes_only_its_own_rows_and_keeps_the_source(world):
    document_id = world.doc(PLAIN)["document_id"]
    before = counts(world)
    body = world.client.delete(f"/api/documents/{document_id}")
    assert body.status_code == 200, body.text
    result = body.json()
    assert result == {
        "documents": [
            {
                "document_id": document_id,
                "document_name": PLAIN,
                "source_ref": PLAIN,
                "deleted": {"snapshots": 1, "applications": 1, "mappings": 11, "runs": 1, "values": 88},
                "source_removed": False,
            }
        ],
        "profiles_reset": [],
        "summary": {"requested": 1, "deleted": 1, "failed": 0},
    }
    after = counts(world)
    assert {t: before[t] - after[t] for t in TABLES} == {
        "document": 1, "document_snapshot": 1, "sheet": 2, "source_region": 109, "snapshot_signature": 1,
        "parsing_application": 1, "application_sheet": 2, "mapping": 11, "mapping_revision": 11, "mapping_region": 25,
        "extraction_run": 1, "extracted_value": 88, "extracted_value_region": 284, "source_digest": 1,
        # 정의와 projection은 하나도 건드리지 않는다.
        "parsing_schema": 0, "parsing_field": 0, "parsing_alias": 0, "parsing_field_edge": 0,
        "parsing_profile": 0, "parsing_rule": 0,
    }
    with world.service.db.connect() as conn:
        # §1.10 가드는 삭제 트랜잭션 안에서만 열린다 — 커밋된 DB에는 남지 않는다.
        assert conn.execute("SELECT count(*) FROM purge_guard").fetchone()[0] == 0
    assert raw(world, PLAIN).is_file()  # 원본은 그대로(기본 purge_source=false)
    assert world.get(f"/documents/{document_id}", expect=404)["error"]["code"] == "NOT_FOUND"
    assert PLAIN not in [d["document_name"] for d in world.get("/documents")["items"]]
    # 다른 문서는 그대로다.
    assert world.get(f"/documents/{world.doc(REFERENCE)['document_id']}")["status"] == "normal"
    assert world.get(f"/profiles/{world.profile_id}")["status"] == "approved"


def test_delete_records_what_it_removed_in_the_job_history(world):
    document_id = world.doc(PLAIN)["document_id"]
    world.client.delete(f"/api/documents/{document_id}")
    rows = jobs_of(world, "delete")
    assert len(rows) == 1
    job = rows[0]
    assert job["state"] == "succeeded" and job["principal"] == world.service.principal
    assert job["target_kind"] == "workspace" and job["target_id"] is None
    assert job["label"] == f"{PLAIN} 삭제"
    assert json.loads(job["payload_json"]) == {"document_ids": [document_id], "purge_source": False}
    stored = json.loads(job["result_json"])
    assert stored["summary"] == {"requested": 1, "deleted": 1, "failed": 0}
    assert stored["documents"][0]["document_name"] == PLAIN and stored["documents"][0]["source_ref"] == PLAIN
    assert stored["documents"][0]["deleted"]["values"] == 88
    listed = world.get("/jobs?kind=delete")["items"]
    assert [j["label"] for j in listed] == [f"{PLAIN} 삭제"]


def test_delete_purges_the_source_file_only_when_asked(world):
    document_id = world.doc(UNMATCHED)["document_id"]
    assert raw(world, UNMATCHED).is_file()
    result = world.client.delete(f"/api/documents/{document_id}?purge_source=true").json()
    assert result["documents"][0]["source_removed"] is True
    assert "source_error" not in result["documents"][0]
    assert not raw(world, UNMATCHED).exists()
    assert (world.root / "data/raw").is_dir()  # 폴더는 지우지 않는다


def test_missing_source_file_does_not_fail_the_document_delete(world):
    document_id = world.doc(LOCKED)["document_id"]
    raw(world, LOCKED).unlink()
    result = world.client.delete(f"/api/documents/{document_id}?purge_source=true").json()
    row = result["documents"][0]
    assert row["source_removed"] is False
    assert row["source_error"] == {"code": "SOURCE_MISSING", "message": "원본 파일이 이미 없습니다."}
    # 원본 삭제 실패는 summary.failed가 아니다 — 문서는 지워졌다.
    assert result["summary"] == {"requested": 1, "deleted": 1, "failed": 0}
    assert world.get(f"/documents/{document_id}", expect=404)


def test_purge_source_never_follows_a_symlink_out_of_raw(world):
    document_id = world.doc(UNMATCHED)["document_id"]
    outside = world.root / "밖에있는파일.xlsx"
    raw(world, UNMATCHED).rename(outside)
    raw(world, UNMATCHED).symlink_to(outside)
    result = world.client.delete(f"/api/documents/{document_id}?purge_source=true").json()
    row = result["documents"][0]
    assert row["source_removed"] is False
    assert row["source_error"]["code"] == "SOURCE_SYMLINK"
    assert outside.is_file() and raw(world, UNMATCHED).is_symlink()  # 링크도 대상 파일도 그대로다
    assert result["summary"] == {"requested": 1, "deleted": 1, "failed": 0}


def test_deleting_the_reference_document_drops_the_profile_to_draft(world):
    document_id = world.doc(REFERENCE)["document_id"]
    result = world.client.delete(f"/api/documents/{document_id}").json()
    assert result["profiles_reset"] == [{"profile_id": world.profile_id, "profile_name": demo.PROFILE_NAME}]
    profile = world.get(f"/profiles/{world.profile_id}")
    assert profile["status"] == "draft"
    with world.service.db.connect() as conn:
        row = dict(conn.execute("SELECT * FROM parsing_profile WHERE profile_id=?", (world.profile_id,)).fetchone())
    assert row["reference_application_id"] is None and row["reference_profile_rev"] is None and row["reference_signature"] is None
    # 다른 문서의 적용 건·추출값은 그대로 남는다.
    assert world.get(f"/documents/{world.doc(PLAIN)['document_id']}")["status"] == "normal"


def test_registering_the_same_file_again_makes_a_new_document(world):
    old_id = world.doc(PLAIN)["document_id"]
    world.client.delete(f"/api/documents/{old_id}")
    job = world.post("/documents/register?wait=60", {"source_refs": [PLAIN]}, expect=200)
    assert job["state"] == "succeeded", job
    fresh = job["result"]["documents"][0]
    assert fresh["document_id"] != old_id and fresh["document_name"] == PLAIN
    assert fresh["snapshot"]["revision_no"] == 1  # 처음부터 다시 만들어진다
    assert world.get(f"/documents/{fresh['document_id']}")["document_name"] == PLAIN


# ---------------------------------------------------------------------------- 다중 삭제


def test_multi_delete_dedupes_keeps_going_and_summarizes(world):
    first, second = world.doc(PLAIN)["document_id"], world.doc(UNMATCHED)["document_id"]
    job = world.post(
        "/documents/delete?wait=60",
        {"document_ids": [first, first, "없는-문서", second], "purge_source": False},
        expect=200,
    )
    assert job["state"] == "succeeded" and job["kind"] == "delete"
    assert job["target_kind"] == "workspace" and job["target_id"] is None and job["label"] == "문서 3개 삭제"
    result = job["result"]
    assert result["summary"] == {"requested": 3, "deleted": 2, "failed": 1}
    assert [d["document_id"] for d in result["documents"]] == [first, "없는-문서", second]
    failed = result["documents"][1]
    assert failed["error"]["code"] == "UNKNOWN_DOCUMENT"
    assert failed["document_name"] is None and failed["source_ref"] is None
    assert failed["deleted"] == {"snapshots": 0, "applications": 0, "mappings": 0, "runs": 0, "values": 0}
    assert world.get(f"/documents/{first}", expect=404) and world.get(f"/documents/{second}", expect=404)
    assert raw(world, PLAIN).is_file() and raw(world, UNMATCHED).is_file()


def test_multi_delete_rejects_an_empty_list_and_more_than_two_hundred(world):
    empty = world.post("/documents/delete", {"document_ids": []}, expect=422)
    assert empty["error"]["code"] == "VALIDATION_ERROR"
    many = world.post("/documents/delete", {"document_ids": [f"d{n}" for n in range(201)]}, expect=422)
    assert many["error"]["code"] == "TOO_MANY_DOCUMENTS"
    assert many["error"]["message"] == "한 번에 최대 200개까지 지울 수 있습니다. 나누어 지우세요."
    assert len(world.get("/documents")["items"]) == 6


def test_delete_waits_for_a_job_that_targets_the_document(world):
    document_id = world.doc(PLAIN)["document_id"]
    application_id = world.application_id(PLAIN)
    with world.service.db.connect(write=True) as conn:
        conn.execute(
            "INSERT INTO runtime_job (job_id,kind,state,principal,payload_json,request_key,request_hash,"
            "target_kind,target_id,created_at) VALUES ('busy-1','extract','running',?,'{}','busy-1','h','application',?,'2026-01-01T00:00:00.000+00:00')",
            (world.service.principal, application_id),
        )
    denied = world.client.delete(f"/api/documents/{document_id}")
    assert denied.status_code == 409
    assert denied.json()["error"] == {
        "code": "DOCUMENT_BUSY",
        "message": "이 문서에 진행 중인 작업이 있습니다. 끝난 뒤 다시 지우세요.",
    }
    assert world.get(f"/documents/{document_id}")["document_name"] == PLAIN
    # 지운 것이 없는 삭제 작업은 작업 내역에 failed로 남는다.
    assert [(j["state"], j["error_code"]) for j in jobs_of(world, "delete")] == [("failed", "DOCUMENT_BUSY")]
    with world.service.db.connect(write=True) as conn:
        conn.execute("UPDATE runtime_job SET state='succeeded' WHERE job_id='busy-1'")
    assert world.client.delete(f"/api/documents/{document_id}").status_code == 200
    assert [j["state"] for j in jobs_of(world, "delete")] == ["failed", "succeeded"]


def test_unknown_document_is_404_on_the_single_path(world):
    missing = world.client.delete("/api/documents/없는-문서")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "UNKNOWN_DOCUMENT"
    assert jobs_of(world, "delete") == []  # 지울 것이 없으면 작업 행도 남기지 않는다


def test_delete_invalidates_render_cache_and_drops_unlocked_copies(world, monkeypatch):
    invalidated, dropped = [], []
    world.service._render = types.SimpleNamespace(invalidate=invalidated.append, close=lambda: None)
    monkeypatch.setattr(drm.SESSIONS, "drop", lambda *a, **kw: dropped.append(a) or True)
    snapshot_id = world.snapshot_id(PLAIN)
    world.client.delete(f"/api/documents/{world.doc(PLAIN)['document_id']}")
    assert invalidated == [snapshot_id]
    assert [a[:2] for a in dropped] == [("local-xlsx", PLAIN)]


def test_render_failure_does_not_undo_the_database_delete(world):
    from schema.db import Problem

    def broken(_snapshot_id):
        raise Problem("RENDER_UNAVAILABLE", "렌더 서버에 연결할 수 없습니다.", 503)

    world.service._render = types.SimpleNamespace(invalidate=broken, close=lambda: None)
    document_id = world.doc(PLAIN)["document_id"]
    assert world.client.delete(f"/api/documents/{document_id}").status_code == 200
    assert world.get(f"/documents/{document_id}", expect=404)


def test_purge_source_judges_by_location_not_by_provider(world):
    """보호 문서(DRM)도 원본은 `<ws>/data/raw`에 있고 Reader가 거기서 읽는다 — 체크했으면 그 파일도 지워야 한다."""
    document_id = world.doc(UNMATCHED)["document_id"]
    with world.service.db.connect(write=True) as conn:
        conn.execute("UPDATE document SET provider='protected-excel-com' WHERE document_id=?", (document_id,))
    row = world.client.delete(f"/api/documents/{document_id}?purge_source=true").json()["documents"][0]
    assert row["source_removed"] is True and "source_error" not in row
    assert not raw(world, UNMATCHED).exists()


def test_purge_source_is_unsupported_when_the_workspace_holds_no_file(world):
    """진짜 원격 vault — raw 아래에 파일이 없을 때만 '지울 것이 없다'고 말한다."""
    document_id = world.doc(UNMATCHED)["document_id"]
    with world.service.db.connect(write=True) as conn:
        conn.execute("UPDATE document SET provider='drm-vault' WHERE document_id=?", (document_id,))
    raw(world, UNMATCHED).unlink()
    row = world.client.delete(f"/api/documents/{document_id}?purge_source=true").json()["documents"][0]
    assert row["source_removed"] is False
    assert row["source_error"] == {"code": "PURGE_UNSUPPORTED", "message": "작업 공간 안에 지울 원본 파일이 없습니다."}


# ---------------------------------------------------------------------------- 취소·중단 기록(§4.13)


def test_cancelled_multi_delete_keeps_the_summary_of_what_it_already_deleted(world):
    """되돌릴 수 없는 삭제라 취소해도 '무엇이 사라졌는지'가 작업 기록에 남아야 한다."""
    service = world.service
    ids = [world.doc(PLAIN)["document_id"], world.doc(UNMATCHED)["document_id"], world.doc(LOCKED)["document_id"]]
    job = service.delete_documents(ids, False, service.principal, wait=0)
    original, seen = service._delete_one, []

    def cancel_after_one(document_id, purge_source, principal, profiles_reset):
        out = original(document_id, purge_source, principal, profiles_reset)
        seen.append(document_id)
        if len(seen) == 1:
            with service.db.connect(write=True) as conn:
                conn.execute("UPDATE runtime_job SET cancel_requested=1 WHERE job_id=?", (job["job_id"],))
        return out

    service._delete_one = cancel_after_one
    try:
        service.jobs.run_one()
    finally:
        service._delete_one = original
    row = [j for j in jobs_of(world, "delete") if j["job_id"] == job["job_id"]][0]
    assert row["state"] == "cancelled" and row["error_code"] == "CANCELLED"
    # 문서 하나만 지우고 멈췄다 — 진행률도 결과도 그 하나를 가리킨다.
    assert (row["completed"], row["total"]) == (1, 3)
    stored = json.loads(row["result_json"])
    assert stored["summary"] == {"requested": 3, "deleted": 1, "failed": 0}
    assert [d["document_name"] for d in stored["documents"]] == [PLAIN]
    assert stored["documents"][0]["source_ref"] == PLAIN and stored["documents"][0]["deleted"]["values"] > 0
    assert world.get(f"/documents/{ids[0]}", expect=404)
    assert world.get(f"/documents/{ids[1]}")["document_name"] == UNMATCHED  # 나머지는 그대로다


def test_delete_writes_the_partial_summary_as_it_goes(world):
    """서버가 중단되면(INTERRUPTED) 예외로 결과를 실어 보낼 길이 없다 — 문서마다 작업 행에 적어 둔다."""
    service = world.service
    ids = [world.doc(PLAIN)["document_id"], world.doc(UNMATCHED)["document_id"]]
    job = service.delete_documents(ids, False, service.principal, wait=0)
    original, snapshots = service._delete_one, []

    def record(document_id, purge_source, principal, profiles_reset):
        out = original(document_id, purge_source, principal, profiles_reset)
        with service.db.connect() as conn:
            snapshots.append(conn.execute("SELECT result_json FROM runtime_job WHERE job_id=?", (job["job_id"],)).fetchone()[0])
        return out

    service._delete_one = record
    try:
        service.jobs.run_one()
    finally:
        service._delete_one = original
    # 두 번째 문서를 지우기 직전에 이미 첫 문서가 작업 행에 적혀 있다.
    assert snapshots[0] is None
    partial = json.loads(snapshots[1])
    assert partial["summary"] == {"requested": 2, "deleted": 1, "failed": 0}
    assert [d["document_name"] for d in partial["documents"]] == [PLAIN]


def test_delete_is_refused_while_a_reparse_job_runs_on_its_profile(world):
    """재파싱(§4.9)은 프로파일 하나로 여러 문서의 추출을 돈다 — 그 사이 문서를 지우면 작업이 죽는다."""
    document_id = world.doc(PLAIN)["document_id"]
    with world.service.db.connect(write=True) as conn:
        conn.execute(
            "INSERT INTO runtime_job (job_id,kind,state,principal,payload_json,request_key,request_hash,"
            "target_kind,target_id,created_at) VALUES ('reparse-1','reparse','running',?,'{}','reparse-1','h','profile',?,'2026-01-01T00:00:00.000+00:00')",
            (world.service.principal, world.profile_id),
        )
    denied = world.client.delete(f"/api/documents/{document_id}")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "DOCUMENT_BUSY"
    assert world.get(f"/documents/{document_id}")["document_name"] == PLAIN
    # 그 프로파일이 붙지 않은 문서는 막지 않는다(지우는 범위를 넓히지 않는다).
    assert world.client.delete(f"/api/documents/{world.doc(UNMATCHED)['document_id']}").status_code == 200


def test_a_vanished_application_does_not_kill_the_whole_reparse(world):
    """페이지를 읽은 뒤 그 문서가 지워져도 나머지 문서의 재파싱은 이어진다."""
    service = world.service
    original = service._application_row

    def gone(conn, application_id):
        from schema.db import Problem

        raise Problem("NOT_FOUND", "적용 건을 찾을 수 없습니다.", 404)

    service._application_row = gone
    try:
        result = service.execute_reparse(world.profile_id, "rematch", service.principal, lambda *a, **k: None)
    finally:
        service._application_row = original
    assert "deleted" in [s["reason"] for s in result["skipped"]]


# ---------------------------------------------------------------------------- 렌더 캐시(§4.13)


def test_render_cache_failure_is_reported_in_the_row(world):
    from schema.db import Problem

    def broken(_snapshot_id):
        raise Problem("RENDER_UNAVAILABLE", "렌더 서버에 연결할 수 없습니다.", 503)

    world.service._render = types.SimpleNamespace(invalidate=broken, close=lambda: None)
    document_id = world.doc(PLAIN)["document_id"]
    row = world.client.delete(f"/api/documents/{document_id}").json()["documents"][0]
    # DB 삭제는 유효하지만 '지웠다'고만 말하지 않는다 — 셀 내용 파생물이 디스크에 남았다.
    assert row["render_error"] == {"code": "RENDER_UNAVAILABLE", "message": "렌더 서버에 연결할 수 없습니다."}
    assert world.get(f"/documents/{document_id}", expect=404)
    stored = json.loads(jobs_of(world, "delete")[0]["result_json"])
    assert stored["documents"][0]["render_error"]["code"] == "RENDER_UNAVAILABLE"


def test_startup_reclaims_orphan_render_cache_directories(world):
    """렌더 서버가 내려간 채 지운 문서의 캐시는 시작 시 회수한다 — `document_snapshot`에 없는 디렉터리."""
    live = world.snapshot_id(PLAIN)
    base = world.root / "data/render-cache"
    (base / live).mkdir(parents=True, exist_ok=True)
    (base / live / "meta.json").write_text("{}", encoding="utf-8")
    orphan = base / "00000000-0000-4000-8000-000000000000"
    orphan.mkdir(parents=True, exist_ok=True)
    (orphan / "band-1-60.json").write_text('{"cells":["평문 셀 내용"]}', encoding="utf-8")
    removed = []
    world.service._render = types.SimpleNamespace(
        invalidate=lambda sid: (removed.append(sid), __import__("shutil").rmtree(base / sid, ignore_errors=True)),
        close=lambda: None,
    )
    assert world.service.reclaim_render_cache() == 1
    assert removed == [orphan.name] and not orphan.exists()
    assert (base / live).is_dir()  # 살아 있는 snapshot의 캐시는 건드리지 않는다


# ---------------------------------------------------------------------------- 계약 §10이 적은 기준


def test_delete_removes_the_document_from_the_queues_and_build_candidates(world):
    document_id = world.doc(PLAIN)["document_id"]
    candidates = world.post("/builds/candidates", {"document_ids": [document_id], "schema_key": demo.SCHEMA_KEY})
    assert candidates["summary"]["usable"] == 1
    before = world.get("/queues")
    assert sum(before["summary"].values()) > 0  # 큐가 실제로 무언가를 세고 있다
    world.client.delete(f"/api/documents/{document_id}")
    after = world.post("/builds/candidates", {"document_ids": [document_id], "schema_key": demo.SCHEMA_KEY})
    assert after["summary"]["usable"] == 0
    queues = world.get("/queues")
    assert document_id not in json.dumps(queues, ensure_ascii=False)
    for kind in queues["groups"]:
        listed = world.get(f"/queues/{kind}")["items"]
        assert document_id not in json.dumps(listed, ensure_ascii=False)
        for group in listed:
            members = world.get(f"/queues/{kind}/groups/{group['group_key']}/members")
            assert document_id not in json.dumps(members, ensure_ascii=False)


def test_delete_does_not_touch_the_definition_files_on_disk(world):
    def definitions():
        return sorted(str(p.relative_to(world.root)) for p in [*(world.root / "schemas").rglob("*.json"), *(world.root / "profiles").rglob("*.json")])

    before = definitions()
    assert before  # 정의 파일이 실제로 있다(이 단언이 비면 검사가 아무것도 보지 않는다)
    world.client.delete(f"/api/documents/{world.doc(REFERENCE)['document_id']}?purge_source=true")
    assert definitions() == before


def test_delete_succeeds_on_a_workspace_migrated_from_the_old_runtime_job_check(world):
    """§1.6 이관: `kind` CHECK에 'delete'가 없고 §1.10 가드도 없는 옛 DB를 열면 삭제가 그대로 된다."""
    import sqlite3 as sqlite

    from schema.db import RUNTIME_DDL
    from schema.service import Service

    document_id = world.doc(PLAIN)["document_id"]
    world.service.close()
    legacy = sqlite.connect(world.root / "workspace.db")
    columns = ",".join(r[1] for r in legacy.execute("PRAGMA table_info(runtime_job)"))
    saved = legacy.execute(f"SELECT {columns} FROM runtime_job").fetchall()
    drops = "".join(
        f"DROP TRIGGER IF EXISTS {r[0]};\n"
        for r in legacy.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%purge_guard%'")
    )
    legacy.executescript(
        "PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\nDROP TABLE runtime_job;\n"
        + RUNTIME_DDL.replace(",'queue_action','delete')", ",'queue_action')")
        + "\n" + drops + "DROP TABLE purge_guard;\nCOMMIT;"
    )
    if saved:
        legacy.executemany(f"INSERT INTO runtime_job ({columns}) VALUES ({','.join('?' * len(saved[0]))})", saved)
    legacy.commit()
    assert legacy.execute("SELECT 1 FROM sqlite_master WHERE name='purge_guard'").fetchone() is None
    assert "'delete'" not in legacy.execute("SELECT sql FROM sqlite_master WHERE name='runtime_job'").fetchone()[0]
    legacy.close()

    migrated = Service(world.root)  # 여는 것만으로 §1.6·§1.10 이관이 돈다
    try:
        result = migrated._delete_documents([document_id], False, migrated.principal)
        assert result["summary"] == {"requested": 1, "deleted": 1, "failed": 0}
        with migrated.db.connect() as conn:
            assert conn.execute("SELECT count(*) FROM document WHERE document_id=?", (document_id,)).fetchone()[0] == 0
    finally:
        migrated.close()


def test_reference_of_marks_the_document_even_when_the_reference_is_on_an_older_snapshot(world):
    """화면이 삭제 **전에** 경고할 근거(§4.13). 새 snapshot이 생겨도 참조는 옛 적용 건을 가리키는데,
    삭제는 그 문서의 모든 snapshot을 지우므로 그때도 프로파일이 초안으로 내려간다."""
    from schema.db import now, uid

    document_id = world.doc(REFERENCE)["document_id"]
    assert [r["profile_name"] for r in world.get(f"/documents/{document_id}")["reference_of"]] == [demo.PROFILE_NAME]
    # 새 snapshot을 현재로 올린다 — 프로파일의 reference_application_id는 옛 snapshot의 적용 건 그대로다.
    with world.service.db.connect(write=True) as conn:
        old = dict(conn.execute("SELECT * FROM document_snapshot WHERE document_id=?", (document_id,)).fetchone())
        fresh = {**old, "snapshot_id": uid(), "revision_no": old["revision_no"] + 1, "captured_at": now(), "change_token": uid()}
        conn.execute(
            "INSERT INTO document_snapshot (%s) VALUES (%s)" % (",".join(fresh), ",".join("?" * len(fresh))),
            tuple(fresh.values()),
        )
        conn.execute("UPDATE document SET current_snapshot_id=? WHERE document_id=?", (fresh["snapshot_id"], document_id))
    detail = world.get(f"/documents/{document_id}")
    assert detail["profiles"] == []  # 새 snapshot에는 적용 건이 없다
    assert [r["profile_name"] for r in detail["reference_of"]] == [demo.PROFILE_NAME]
    listed = {d["document_name"]: d for d in world.get("/documents")["items"]}
    assert [r["profile_name"] for r in listed[REFERENCE]["reference_of"]] == [demo.PROFILE_NAME]
    assert listed[PLAIN]["reference_of"] == []
    # 실제로 지우면 그 프로파일이 초안으로 내려간다 — 경고가 가리킨 것과 결과가 같다.
    result = world.client.delete(f"/api/documents/{document_id}").json()
    assert [p["profile_name"] for p in result["profiles_reset"]] == [demo.PROFILE_NAME]
