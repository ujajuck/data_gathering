"""raw 폴더 감시(계약 §10 watch): 파일을 넣으면 등록되고, approved 프로파일과 identical이면 자동 적용·추출·발행된다."""

from __future__ import annotations

import json
import shutil
import types

import pytest

from kg.v3.__main__ import parse
from kg.v3.db import Problem
from kg.v3.service import Service
from kg.v3.watch import Watcher, run
from tests.test_v3_service import SCHEMA, build_workbook, profile_definition


@pytest.fixture
def approved(tmp_path):
    """문서 A로 프로파일을 승인해 둔 작업 공간."""
    root = tmp_path / "ws"
    (root / "data/raw").mkdir(parents=True)
    service = Service(root)
    service._render = types.SimpleNamespace(invalidate=lambda *_: None, close=lambda: None)
    try:
        service.import_schema(SCHEMA)
        profile = service.import_profile("process_standard", profile_definition())
        build_workbook(root / "data/raw/a.xlsx")
        job = service.register_documents(["a.xlsx"], wait=60)
        assert job["state"] == "succeeded", job
        doc = job["result"]["documents"][0]
        assert doc["applied"] == []  # draft 프로파일은 자동 적용되지 않는다
        application = service.apply_profile(doc["snapshot"]["snapshot_id"], profile["profile_id"])
        approved_all = service.approve_all(application["application_id"], wait=60)
        assert approved_all["extraction"]["state"] == "succeeded", approved_all
        result = service.approve_profile(profile["profile_id"], application["application_id"])
        assert result["status"] == "approved"
        yield {"root": root, "service": service, "profile": profile, "document": doc}
    finally:
        service.close()


def test_dropped_file_is_registered_and_auto_applied(approved):
    root, service = approved["root"], approved["service"]
    watcher = Watcher(root, service=service, principal="watcher")
    # 감시 시작 시점의 a.xlsx는 'created'로 보여 한 번 등록되지만 token이 같아 snapshot은 그대로다(unchanged).
    lines = watcher.run_once()
    assert [l["source_ref"] for l in lines] == ["a.xlsx"] and lines[0]["unchanged"] is True and lines[0]["status"] == "normal"

    build_workbook(root / "data/raw/b.xlsx", temps=(11, 22, 33), lots=("X1", "X2", "X3"))
    (root / "data/raw/locked.xlsx").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)
    first = watcher.scan()
    assert first == []  # 안정화 판정(2회 연속 동일) 전에는 등록하지 않는다
    lines = {l["source_ref"]: l for l in watcher.scan()}
    b = lines["b.xlsx"]
    assert b["event"] == "created" and b["status"] == "normal" and b["revision_no"] == 1
    # applied[].state는 자동 적용 시점의 상태(approved); 같은 작업에서 추출·발행이 이어져 문서 상태는 normal이다.
    assert [(a["profile_id"], a["compatibility"], a["state"]) for a in b["applied"]] == [(approved["profile"]["profile_id"], "identical", "published")]
    assert service.application_summary(b["applied"][0]["application_id"])["published"] is True
    assert lines["locked.xlsx"]["skipped"] == "DRM_READER_REQUIRED"
    assert service.document(lines["locked.xlsx"]["document_id"])["status"] == "locked"
    assert service.document(b["document_id"])["status"] == "normal"
    values = service.snapshot_values(b["snapshot_id"], rule_key="lot")
    assert [v["value_text"] for v in values["items"]] == ["X1", "X2", "X3"]

    # 수정된 파일은 새 snapshot으로 등록되고 승계 리비전(proposed)이 '변경 감지'로 남는다.
    build_workbook(root / "data/raw/b.xlsx", temps=(12, 22, 33), lots=("X1", "X2", "X3"))
    watcher.scan()
    modified = {l["source_ref"]: l for l in watcher.scan()}["b.xlsx"]
    assert modified["event"] == "modified" and modified["revision_no"] == 2 and modified["status"] == "changed"

    # 삭제는 문서를 지우지 않는다.
    (root / "data/raw/b.xlsx").unlink()
    deleted = [l for l in watcher.scan() if l.get("skipped") == "FILE_DELETED"]
    assert deleted and deleted[0]["source_ref"] == "b.xlsx"
    assert service.document(b["document_id"])["document_name"] == "b.xlsx"


def test_watch_covers_subfolders_by_default(approved):
    """계약 §10: watch는 기본으로 하위 폴더까지 감시한다(source_ref는 data/raw 기준 상대 경로)."""
    root, service = approved["root"], approved["service"]
    (root / "data/raw/하위/더").mkdir(parents=True)
    build_workbook(root / "data/raw/하위/더/e.xlsx", temps=(41, 42, 43), lots=("Y1", "Y2", "Y3"))
    watcher = Watcher(root, service=service, principal="watcher")
    assert watcher.watcher.patterns == ("**/*.xlsx", "**/*.xlsm")
    lines = {l.get("source_ref"): l for l in watcher.run_once()}
    nested = lines["하위/더/e.xlsx"]
    assert nested["event"] == "created" and nested["status"] == "normal"
    assert [a["compatibility"] for a in nested["applied"]] == ["identical"]
    assert [v["value_text"] for v in service.snapshot_values(nested["snapshot_id"], rule_key="lot")["items"]] == ["Y1", "Y2", "Y3"]

    # --no-recursive면 최상위만 본다.
    flat = Watcher(root, service=service, principal="watcher", recursive=False)
    assert flat.watcher.patterns == ("*.xlsx", "*.xlsm")
    refs = {l.get("source_ref") for l in flat.run_once()}
    assert "a.xlsx" in refs and "하위/더/e.xlsx" not in refs
    assert parse(["watch", "--ws", str(root), "--no-recursive"]).no_recursive is True


def test_raw_dir_must_be_inside_workspace(tmp_path):
    root = tmp_path / "ws"
    (root / "data/raw/sub").mkdir(parents=True)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    with pytest.raises(Problem) as exc:
        Watcher(root, raw=outside)
    assert exc.value.code == "INVALID_RAW_DIR"
    watcher = Watcher(root, raw=root / "data/raw/sub")
    try:
        assert watcher.source_ref(root / "data/raw/sub/x.xlsx") == "sub/x.xlsx"
        with pytest.raises(Problem):
            watcher.source_ref(outside / "x.xlsx")
    finally:
        watcher.close()
    assert run(root, outside, once=True) == 2


def test_run_once_cli(approved, capsys):
    root = approved["root"]
    approved["service"].close()
    shutil.copy2(root / "data/raw/a.xlsx", root / "data/raw/c.xlsx")
    assert run(root, once=True) == 0
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    by_ref = {l["source_ref"]: l for l in lines}
    assert by_ref["c.xlsx"]["status"] == "normal" and by_ref["c.xlsx"]["applied"][0]["compatibility"] == "identical"
