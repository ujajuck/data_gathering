"""보호 문서(DRM) 접근(계약 §3.5) — 컨테이너 판별·Reader 선택·해제 세션·감사·점검 명령.

전제가 뒤집혔다: 평문 OOXML이 예외고 보호 문서가 기본이다. 여기서 확인하는 것은
"보호 문서를 잠금으로 끝내지 않고 어댑터로 넘기는가"와 "해제 비용을 snapshot당 한 번만 치르는가"다.

윈도우가 없으므로 Excel COM 경로는 실제로 돌릴 수 없다 — import가 죽지 않고 사용 시 명확한 오류를 내는 것까지만 본다.
"""

from __future__ import annotations

import json
import os
import types
from pathlib import Path

import pytest

from schema import __main__ as cli
from schema import drm
from schema.db import Problem
from schema.readers import XlsxReader, make_reader
from schema.service import Service
from tests import drm_fixture
from tests.test_service import build_workbook

PLAIN = "평문.xlsx"
PROTECTED = "보호.xlsx"


@pytest.fixture
def ws(tmp_path, monkeypatch):
    """작업 공간 + 해제본 임시 폴더(작업 공간 **밖**) + 해제 호출 기록."""
    root = tmp_path / "ws"
    raw = root / "data/raw"
    raw.mkdir(parents=True)
    build_workbook(raw / PLAIN)
    drm_fixture.wrap(raw / PLAIN, raw / PROTECTED)
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(tmp_path / "drm-temp"))
    monkeypatch.setenv("SCHEMA_TEST_DRM_COUNTER", str(tmp_path / "unlocks.log"))
    monkeypatch.delenv("SCHEMA_READER_FACTORY", raising=False)
    monkeypatch.delenv("SCHEMA_DRM_MAGIC", raising=False)
    monkeypatch.delenv("SCHEMA_DRM_CACHE_TTL_SECONDS", raising=False)
    drm.SESSIONS.reset()
    try:
        yield root
    finally:
        drm.SESSIONS.release_all()


@pytest.fixture
def adapter(monkeypatch):
    monkeypatch.setenv("SCHEMA_READER_FACTORY", "tests.drm_fixture:factory")


def service_of(root):
    service = Service(root)
    service._render = types.SimpleNamespace(invalidate=lambda *_: None, close=lambda: None)
    return service


# ---------------------------------------------------------------- (1) 컨테이너 판별


def test_sniff_container_covers_the_four_branches():
    assert drm.sniff_container(b"PK\x03\x04rest") == {"container": "ooxml", "protected": False, "magic": None}
    assert drm.sniff_container(drm.MAGIC_OLE2 + b"x") == {"container": "ole2", "protected": True, "magic": None}
    # 모르면 보호 문서로 취급한다(리더에게 맡긴다) — 빈 파일·짧은 파일도 마찬가지다.
    assert drm.sniff_container(b"")["container"] == "unknown"
    assert drm.sniff_container(b"P") == {"container": "unknown", "protected": True, "magic": None}
    assert drm.sniff_container(b"\x00\x01\x02") == {"container": "unknown", "protected": True, "magic": None}


def test_operator_magic_wins_over_plain_ooxml(monkeypatch):
    """운영자 시그니처가 PK보다 먼저다 — 평문처럼 보이는 래퍼를 운영자가 선언할 수 있어야 한다."""
    monkeypatch.setenv("SCHEMA_DRM_MAGIC", "hex:504b0304deadbeef")
    assert drm.sniff_container(b"PK\x03\x04\xde\xad\xbe\xefrest") == {
        "container": "vendor",
        "protected": True,
        "magic": "hex:504b0304deadbeef",
    }
    assert drm.sniff_container(b"PK\x03\x04other")["container"] == "ooxml"


def test_magic_list_parses_three_forms_and_ignores_bad_items(capsys, monkeypatch):
    monkeypatch.delenv("SCHEMA_DRM_MAGIC", raising=False)
    parsed = drm.parse_magics("hex:d0cf11e0, ascii:NASCA, VENDOR, , hex:zz, " + "ascii:" + "x" * 33)
    assert [item["raw"] for item in parsed] == ["hex:d0cf11e0", "ascii:NASCA", "VENDOR"]
    assert [item["bytes"] for item in parsed] == [b"\xd0\xcf\x11\xe0", b"NASCA", b"VENDOR"]
    # 잘못된 항목은 조용히 버리지 않고 한 번 알린다(오타로 판별이 바뀌지 않게).
    assert "SCHEMA_DRM_MAGIC" in capsys.readouterr().err
    assert drm.parse_magics("") == []


def test_detect_reads_only_the_head(ws):
    assert drm.detect(ws / "data/raw" / PLAIN) == "plain"
    assert drm.detect(ws / "data/raw" / PROTECTED) == "protected"
    assert drm.detect(ws / "data/raw/없음.xlsx") == "protected"  # 읽을 수 없으면 보호 문서 취급


# ---------------------------------------------------------------- (2) Reader 선택


def test_make_reader_picks_by_container(ws, monkeypatch):
    assert type(make_reader(ws, "local-xlsx", "tester", PLAIN)) is XlsxReader  # 규칙 2
    assert type(make_reader(ws, "local-xlsx", "tester", None)) is XlsxReader  # 규칙 4
    assert type(make_reader(ws, "local-xlsx", "tester", "없음.xlsx")) is XlsxReader  # 없는 파일은 404로 말한다
    with pytest.raises(Problem) as exc:
        make_reader(ws, "local-xlsx", "tester", PROTECTED)  # 규칙 3, 어댑터 없음
    assert (exc.value.code, exc.value.status) == ("DRM_READER_REQUIRED", 403)
    monkeypatch.setenv("SCHEMA_READER_FACTORY", "tests.drm_fixture:factory")
    assert type(make_reader(ws, "local-xlsx", "tester", PROTECTED)) is drm_fixture.FakeDrmReader
    # 규칙 1: provider가 local-xlsx가 아니면 컨테이너와 무관하게 언제나 어댑터다.
    assert type(make_reader(ws, "vendor-x", "tester", PLAIN)) is drm_fixture.FakeDrmReader


def test_reader_required_message_says_what_to_configure(ws):
    with pytest.raises(Problem) as exc:
        make_reader(ws, "local-xlsx", "tester", PROTECTED)
    assert exc.value.message == drm.READER_REQUIRED_MESSAGE
    assert "SCHEMA_READER_FACTORY" in exc.value.message and "Reader 카드" in exc.value.message
    (ws / "data/raw/구형.xls").write_bytes(drm.MAGIC_OLE2 + b"\x00" * 64)
    with pytest.raises(Problem) as exc:
        make_reader(ws, "local-xlsx", "tester", "구형.xls")
    assert exc.value.message == drm.READER_REQUIRED_XLS_MESSAGE
    assert ".xlsx로 저장" in exc.value.message and "SCHEMA_READER_FACTORY" in exc.value.message


def test_authorize_no_longer_locks_by_magic(ws):
    """판정은 make_reader 한 곳에서만 한다 — XlsxReader.authorize가 다시 잠그면 어댑터를 붙여도 계속 잠긴다(§3.5(2))."""
    reader = XlsxReader(ws, "tester")
    assert reader.authorize(PROTECTED)["can_view"] is True


# ---------------------------------------------------------------- (3) 해제 세션


def test_one_unlock_per_snapshot_is_reused_by_every_operation(ws, adapter):
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    token = reader.describe(PROTECTED)["token"]
    assert reader.describe(PROTECTED)["token"] == token
    assert reader.match(PROTECTED, token, []) == []
    # describe·describe·match 세 연산이 해제 한 번을 나눠 쓴다(§3.5(3)).
    assert drm_fixture.unlock_count() == 1
    assert drm.SESSIONS.counts() == {"unlocked": 1, "reused": 2, "failed": 0}
    assert reader.describe(PROTECTED)["filename"] == PROTECTED  # 이름·크기는 원본 기준


def test_new_token_unlocks_again_and_the_old_session_can_be_dropped(ws, adapter):
    raw = ws / "data/raw"
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    first = reader.describe(PROTECTED)["token"]
    build_workbook(raw / "다음.xlsx", shift=2)
    drm_fixture.wrap(raw / "다음.xlsx", raw / PROTECTED)
    second = make_reader(ws, "local-xlsx", "tester", PROTECTED).describe(PROTECTED)["token"]
    assert second != first and drm_fixture.unlock_count() == 2
    folder = drm.temp_dir()
    assert (folder / f"{drm.session_name('local-xlsx', PROTECTED, first)}.xlsx").is_file()
    assert drm.SESSIONS.drop("local-xlsx", PROTECTED, first, ws) is True
    assert not (folder / f"{drm.session_name('local-xlsx', PROTECTED, first)}.xlsx").exists()
    assert (folder / f"{drm.session_name('local-xlsx', PROTECTED, second)}.xlsx").is_file()


def test_session_file_lives_outside_the_workspace_and_hides_the_name(ws, adapter):
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    token = reader.describe(PROTECTED)["token"]
    folder = drm.temp_dir()
    session = folder / f"{drm.session_name('local-xlsx', PROTECTED, token)}.xlsx"
    assert session.is_file() and not session.is_relative_to(ws)
    assert PROTECTED not in session.name and "tester" not in session.name
    assert session.stat().st_mode & 0o777 == 0o600
    assert folder.stat().st_mode & 0o777 == 0o700


def test_ttl_zero_never_reuses_and_deletes_at_once(ws, adapter, monkeypatch):
    monkeypatch.setenv("SCHEMA_DRM_CACHE_TTL_SECONDS", "0")
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    reader.describe(PROTECTED)
    reader.describe(PROTECTED)
    assert drm_fixture.unlock_count() == 2 and drm.SESSIONS.counts()["reused"] == 0
    # TTL 0은 메모리 전용과 같다: 연산(격리 프로세스)이 끝나면 남기지 않는다.
    drm.SESSIONS.release_all()
    assert sorted(p.name for p in drm.temp_dir().glob("*")) == []


def test_expired_session_is_unlocked_again(ws, adapter, monkeypatch):
    monkeypatch.setenv("SCHEMA_DRM_CACHE_TTL_SECONDS", "60")
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    token = reader.describe(PROTECTED)["token"]
    session = drm.temp_dir() / f"{drm.session_name('local-xlsx', PROTECTED, token)}.xlsx"
    os.utime(session, (session.stat().st_atime, session.stat().st_mtime - 120))
    reader.describe(PROTECTED)
    assert drm_fixture.unlock_count() == 2


def test_temp_dir_inside_the_workspace_stops_the_server(ws, monkeypatch):
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(ws / "data/drm"))
    with pytest.raises(Problem) as exc:
        drm.temp_dir(ws)
    assert (exc.value.code, exc.value.status) == ("DRM_TEMP_IN_WORKSPACE", 500)
    assert drm.settings_snapshot(ws)["temp_dir_ok"] is False


def test_prune_drops_the_oldest_over_the_session_cap(ws, adapter, monkeypatch):
    monkeypatch.setenv("SCHEMA_DRM_CACHE_MAX_SESSIONS", "1")
    folder = drm.temp_dir(create=True)
    stale = folder / "00000000.xlsx"
    stale.write_bytes(b"old")
    os.utime(stale, (0, 0))
    make_reader(ws, "local-xlsx", "tester", PROTECTED).describe(PROTECTED)
    assert not stale.exists() and len(list(folder.glob("*.xlsx"))) == 1


# ---------------------------------------------------------------- (4) 감사


def test_every_protected_access_leaves_one_audit_line(ws, adapter):
    reader = make_reader(ws, "local-xlsx", "tester", PROTECTED)
    token = reader.describe(PROTECTED)["token"]
    counts = drm.record_access(
        ws, provider="fake-drm", principal="tester", source_ref=PROTECTED, operation="describe", outcome="ok", reader="drm"
    )
    assert counts == {"unlocked": 1, "reused": 0, "failed": 0}
    files = list((ws / "data/audit").glob("drm-*.jsonl"))
    assert len(files) == 1 and files[0].stat().st_mode & 0o777 == 0o600
    line = json.loads(files[0].read_text(encoding="utf-8").splitlines()[-1])
    assert line["operation"] == "describe" and line["container"] == "ole2" and line["outcome"] == "ok"
    assert line["principal"] == "tester" and line["source_ref"] == PROTECTED and line["unlock"] == "new"
    # 해제본 경로·내용은 남기지 않는다.
    assert token not in files[0].read_text(encoding="utf-8")
    assert str(drm.temp_dir()) not in files[0].read_text(encoding="utf-8")


def test_plain_documents_are_not_audited(ws):
    assert drm.record_access(ws, provider="local-xlsx", principal="tester", source_ref=PLAIN, operation="describe", outcome="ok") is None
    assert not (ws / "data/audit").exists()


# ---------------------------------------------------------------- §4.1 등록(어댑터 유무)


def test_protected_document_registers_normally_when_the_adapter_is_attached(ws, adapter):
    service = service_of(ws)
    try:
        job = service.register_documents([PROTECTED], wait=120)
        assert job["state"] == "succeeded", job
        row = job["result"]["documents"][0]
        assert row["error"] is None if "error" in row else True
        assert row["status"] != "locked" and row["snapshot"]["revision_no"] == 1
        # §3.5(4) 작업 내역에 해제 비용이 남는다.
        assert job["result"]["drm"] == {"unlocked": 1, "reused": 0, "failed": 0}
        assert list((ws / "data/audit").glob("drm-*.jsonl"))
    finally:
        service.close()


def test_new_snapshot_drops_the_previous_sessions_plaintext(ws, adapter):
    """새 snapshot이 생기면 이전 token의 해제본을 TTL을 기다리지 않고 바로 지운다(§3.5(3))."""
    from schema.readers import file_hash

    service = service_of(ws)
    try:
        assert service.register_documents([PROTECTED], wait=120)["state"] == "succeeded"
        old_token = file_hash(ws / "data/raw" / PROTECTED)
        old_session = Path(os.environ["SCHEMA_DRM_TEMP_DIR"]) / f"{drm.session_name('local-xlsx', PROTECTED, old_token)}.xlsx"
        assert old_session.is_file()
        # 원본을 바꿔 새 snapshot을 만든다.
        build_workbook(ws / "data/raw" / PLAIN, temps=(11.5, 21, 31))
        drm_fixture.wrap(ws / "data/raw" / PLAIN, ws / "data/raw" / PROTECTED)
        assert service.register_documents([PROTECTED], wait=120)["state"] == "succeeded"
        assert file_hash(ws / "data/raw" / PROTECTED) != old_token
        assert not old_session.exists()  # 지난 snapshot의 평문이 임시 폴더에 남지 않는다
    finally:
        service.close()


def test_sessions_are_reused_across_reader_processes(ws, adapter):
    """Reader는 연산마다 별도 프로세스다 — 재사용이 메모리가 아니라 파일로 이뤄지는지 본다(§3.5(3))."""
    from schema.readers import file_hash

    service = service_of(ws)
    try:
        assert service.register_documents([PROTECTED], wait=120)["state"] == "succeeded"
        token = file_hash(ws / "data/raw" / PROTECTED)
        assert service._read("local-xlsx", "local-user", "match", {"source_ref": PROTECTED, "expected_token": token, "profiles": []}) == []
        # 등록(describe)이 해제한 세션 파일을 다음 프로세스의 match가 그대로 쓴다.
        assert drm_fixture.unlock_count() == 1
        lines = [json.loads(line) for line in (sorted((ws / "data/audit").glob("drm-*.jsonl"))[0]).read_text(encoding="utf-8").splitlines()]
        assert [line["operation"] for line in lines] == ["describe", "match"]
        assert [line["unlock"] for line in lines] == ["new", "reused"]
    finally:
        service.close()


def test_protected_document_is_locked_only_without_an_adapter(ws):
    service = service_of(ws)
    try:
        job = service.register_documents([PROTECTED], wait=120)
        assert job["state"] == "failed" and job["error_code"] == "DRM_READER_REQUIRED"
        listed = service.document_query(limit=10)["items"]
        assert listed[0]["status"] == "locked" and listed[0]["last_error"] == drm.READER_REQUIRED_MESSAGE
    finally:
        service.close()


# ---------------------------------------------------------------- (6) Excel COM 참조 구현


def test_excel_com_is_importable_everywhere_and_says_why_it_cannot_run(ws, monkeypatch):
    """비윈도우에서 import만으로 죽지 않는다. 실제로 쓰면 무엇이 필요한지 말한다(§3.5(6))."""
    reader = drm.excel_com_reader(root=ws, provider="protected-excel-com", principal="tester")
    assert isinstance(reader, drm.ExcelComReader)
    assert reader.authorize(PROTECTED)["can_view"] is True
    if os.name == "nt":  # pragma: no cover - 여기서 멈춘다. Windows 실행 경로를 검증하는 테스트는 아직 없다(§10).
        pytest.skip("Windows에서는 실제 Excel COM 경로를 타므로 이 단정은 성립하지 않는다 — Windows 스모크는 아직 없다")
    with pytest.raises(Problem) as exc:
        drm.excel_com_unlock(ws / "data/raw" / PROTECTED, ws / "out.xlsx")
    assert exc.value.code == "DRM_OPEN_FAILED" and "Windows" in exc.value.message
    with pytest.raises(Problem) as exc:
        reader.describe(PROTECTED)
    assert exc.value.code == "DRM_OPEN_FAILED"


def test_excel_com_reader_delegates_reads_to_the_plain_reader(ws, monkeypatch):
    """해제본을 만든 뒤의 모든 읽기는 XlsxReader 로직이다 — 엔진·렌더러를 다시 쓰지 않는다."""
    reader = drm.ExcelComReader(ws, "tester", "protected-excel-com", unlock=lambda origin, destination: destination.write_bytes(origin.read_bytes()[len(drm_fixture.ENVELOPE) :]))
    described = reader.describe(PROTECTED)
    assert [s["name"] for s in described["sheets"]] == ["공정 기록"]
    assert described["filename"] == PROTECTED and described["capabilities"]["provider"] == "protected-excel-com"


# ---------------------------------------------------------------- (7) 점검 명령


def probe_of(ws, capsys, *args):
    code = cli.main(["drm-probe", "--ws", str(ws), "--json", *args])
    return code, json.loads(capsys.readouterr().out)


def test_probe_reports_containers_without_an_adapter(ws, capsys):
    code, report = probe_of(ws, capsys)
    rows = {row["source_ref"]: row for row in report["sources"]}
    assert rows[PLAIN]["status"] == "ok" and rows[PLAIN]["reader"] == "local-xlsx"
    assert rows[PROTECTED]["status"] == "reader_required" and rows[PROTECTED]["error_code"] == "DRM_READER_REQUIRED"
    assert report["reader"]["available"] is False and report["temp"]["inside_workspace"] is False
    assert report["summary"] == {"checked": 2, "plain": 1, "protected": 1, "unlockable": 0, "blocked": 1}
    assert code == 2  # 설정 없음


def test_probe_unlocks_once_and_removes_the_temp_file(ws, adapter, capsys):
    code, report = probe_of(ws, capsys, "--unlock")
    row = next(r for r in report["sources"] if r["source_ref"] == PROTECTED)
    assert (row["status"], row["reader"], row["sheet_count"], row["temp_removed"]) == ("ok", "drm", 1, True)
    assert row["unlock_ms"] is not None and drm_fixture.unlock_count() == 1
    assert list(drm.temp_dir().glob("*.xlsx")) == []
    assert code == 0
    # 원본 내용·시트 이름·해제본 경로를 출력하지 않는다.
    assert "공정 기록" not in json.dumps(report, ensure_ascii=False)


def test_probe_exit_code_one_when_a_source_cannot_be_read(ws, adapter, capsys, monkeypatch):
    monkeypatch.setenv("SCHEMA_TEST_DRM_FAIL", "1")
    code, report = probe_of(ws, capsys, "--source", PROTECTED, "--unlock")
    assert report["sources"][0]["status"] == "failed" and report["sources"][0]["error_code"] == "DRM_OPEN_FAILED"
    assert code == 1
    code, report = probe_of(ws, capsys, "--source", "없음.xlsx")
    assert report["sources"][0]["error_code"] == "SOURCE_NOT_FOUND" and code == 1


def test_probe_table_names_the_adapter_and_the_temp_folder(ws, capsys):
    assert cli.main(["drm-probe", "--ws", str(ws)]) == 2
    out = capsys.readouterr().out
    assert "보안 읽기 어댑터: 연결 안 됨" in out and "작업 공간 밖(정상)" in out
    assert f"{PROTECTED}: ole2 · 보호" in out and "어댑터 없음" in out
    assert "검사 2건" in out


def test_settings_snapshot_shows_the_reader_card_values(ws, adapter, monkeypatch):
    monkeypatch.setenv("SCHEMA_DRM_MAGIC", "ascii:NASCA,hex:d0cf11e0")
    snapshot = drm.settings_snapshot(ws)
    assert snapshot == {
        "available": True,
        "temp_dir_ok": True,
        "ttl_seconds": 900,
        "cache_mb": 2048,
        "magics": 2,  # 계약 §6은 개수다(원문 목록은 drm-probe --json)
    }


# ---------------------------------------------------------------- 리뷰 반영(2차)


def test_missing_source_is_not_counted_as_a_protected_document(ws):
    """등록 뒤 사라진 평문 문서·권한 오류를 DRM 실패로 세면 '못 연 보호 문서 건수'를 믿을 수 없다(§3.5(4))."""
    assert drm.sniff_source(ws, "없는문서.xlsx") == {"container": "missing", "protected": False, "magic": None}
    assert (
        drm.record_access(
            ws,
            provider="local-xlsx",
            principal="u",
            source_ref="없는문서.xlsx",
            operation="describe",
            outcome="failed",
            error_code="SOURCE_NOT_FOUND",
        )
        is None
    )
    audit = ws / "data/audit"
    assert not audit.exists() or not any(audit.iterdir())
    # 읽을 수 있는데 아는 매직이 아닌 파일은 여전히 보호 문서다.
    (ws / "data/raw/알수없음.bin").write_bytes(b"\x01\x02\x03\x04")
    assert drm.sniff_source(ws, "알수없음.bin")["protected"] is True


def test_temp_dir_refuses_a_folder_that_is_not_ours(ws, tmp_path, monkeypatch):
    """예측 가능한 공용 경로에 남이 만들어 둔 폴더·심볼릭 링크를 그대로 쓰지 않는다(§3.5(3))."""
    target = tmp_path / "attacker"
    target.mkdir()
    link = tmp_path / "linked-temp"
    link.symlink_to(target)
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(link))
    with pytest.raises(Problem) as caught:
        drm.temp_dir(create=True)
    assert caught.value.code == "DRM_TEMP_UNSAFE" and "심볼릭 링크" in caught.value.message
    assert not any(target.iterdir())  # 링크 대상에 아무것도 쓰지 않았다
    # 이미 있는 내 폴더는 권한을 0700으로 좁혀서 쓴다.
    mine = tmp_path / "mine"
    mine.mkdir(mode=0o777)
    os.chmod(mine, 0o777)
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(mine))
    assert drm.temp_dir(create=True) == mine
    assert mine.stat().st_mode & 0o777 == 0o700


def test_dead_lock_is_reclaimed_but_a_live_one_is_not(tmp_path, monkeypatch):
    """죽은 프로세스가 남긴 잠금은 곧바로 치우고, 살아 있는 프로세스의 잠금은 뺏지 않는다(§3.5(3))."""
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(tmp_path / "locks"))
    folder = drm.temp_dir(create=True)
    dead = folder / "dead.lock"
    dead.write_text("2147480000")  # 살아 있지 않은 PID
    with drm._exclusive(dead, 5.0):
        pass
    assert not dead.exists()
    live = folder / "live.lock"
    live.write_text(str(os.getpid()))
    with pytest.raises(Problem) as caught:
        with drm._exclusive(live, 1.0):
            pass
    assert caught.value.code == "DRM_OPEN_TIMEOUT"
    assert live.exists()  # 남의 잠금을 지우지 않았다


def test_purge_all_leaves_files_owned_by_a_live_process(tmp_path, monkeypatch):
    """임시 폴더는 메인·렌더 서버가 함께 쓴다 — 진행 중인 해제의 부분 파일·잠금을 지우면 상호 배제가 깨진다."""
    monkeypatch.setenv("SCHEMA_DRM_TEMP_DIR", str(tmp_path / "shared"))
    folder = drm.temp_dir(create=True)
    (folder / f"abc.{os.getpid()}.part").write_bytes(b"in-progress")
    (folder / "com.lock").write_text(str(os.getpid()))
    (folder / "dead.2147480000.part").write_bytes(b"orphan")
    (folder / "old.xlsx").write_bytes(b"PK\x03\x04")
    assert drm.purge_all() == 2
    assert sorted(p.name for p in folder.iterdir()) == ["abc." + str(os.getpid()) + ".part", "com.lock"]


def test_reader_operations_delete_the_plaintext_when_ttl_is_zero(ws, adapter, monkeypatch):
    """TTL 0(재사용 안 함)이면 연산이 끝나는 즉시 해제본이 사라진다 — atexit에 기대지 않는다(§3.5(3))."""
    monkeypatch.setenv("SCHEMA_DRM_CACHE_TTL_SECONDS", "0")
    reader = make_reader(ws, "local-xlsx", "u", PROTECTED)
    described = reader.describe(PROTECTED)
    assert described["sheets"]
    folder = drm.temp_dir(ws)
    assert [p.name for p in folder.iterdir() if p.suffix == ".xlsx"] == []
    assert drm.SESSIONS.released == 1
