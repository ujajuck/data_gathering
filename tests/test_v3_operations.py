"""§4.11 검수 큐: unmatched(구조 서명)·review(profile)·failed(error_code|locked)·changed(profile|incompatible)·conflict(field_key) 묶음,
멤버 keyset 페이지, 묶음 처리 작업(approve_all → 추출·발행, assign_profile → 적용 건 생성, reparse → 위임), 404/422."""

from __future__ import annotations

import pytest

from kg.v3.db import Problem
from kg.v3.operations import members, queue, queue_action, queues
from tests.v3_ops_fixture import World, kelvin_profile, variant_profile


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = World(tmp_path, monkeypatch)
    yield w
    w.service.close()


@pytest.fixture
def scene(world):
    """A 승인(a.xlsx 발행) · c(compatible → review) · n1/n2(시트 '기록' → unmatched, 같은 서명) · k(단위 K → 자동 승인 후 UNIT_MISMATCH 실패,
    K 프로파일 수동 발행 → 단위 불일치) · a 재등록(승계 identical → changed) · b 재등록(온도 라벨 변경 → incompatible) · locked."""
    s = world.service
    base = world.approve_profile_with("a.xlsx")
    profile = base["profile"]
    world.file("b.xlsx", temps=(1, 2, 3))
    doc_b = world.register("b.xlsx")
    assert doc_b["status"] == "normal"
    world.file("c.xlsx", shift=1)
    doc_c = world.register("c.xlsx")
    assert doc_c["status"] == "review"
    world.file("n1.xlsx", sheet="기록")
    world.file("n2.xlsx", sheet="기록", temps=(5, 6, 7))
    n1, n2 = world.register("n1.xlsx"), world.register("n2.xlsx")
    assert n1["status"] == "unmatched" and n2["status"] == "unmatched"
    world.file("k.xlsx", unit="K", temps=(300, 310, 320))
    doc_k = world.register("k.xlsx")
    assert doc_k["status"] == "failed" and doc_k["applied"][0]["compatibility"] == "identical"
    kelvin = s.import_profile("process_standard", kelvin_profile())
    app_k = s.apply_profile(doc_k["snapshot"]["snapshot_id"], kelvin["profile_id"])
    assert s.approve_all(app_k["application_id"])["extraction"]["state"] == "succeeded"
    assert world.status(doc_k["document_id"]) == "failed"  # A 프로파일의 마지막 실행은 여전히 실패
    world.file("a.xlsx", temps=(11, 21, 31))
    changed_a = world.register("a.xlsx")
    assert changed_a["status"] == "changed" and changed_a["applied"][0]["compatibility"] == "identical"
    world.file("b.xlsx", temps=(1, 2, 3), temp_label="온도2")
    changed_b = world.register("b.xlsx")
    assert changed_b["status"] == "changed" and changed_b["applied"] == []
    (world.root / "data/raw/locked.xlsx").write_bytes(b"\xd0\xcf\x11\xe0drm")
    assert s.register_documents(["locked.xlsx"], wait=60)["state"] == "failed"
    world.calls.clear()
    return {"profile": profile, "kelvin": kelvin, "a": changed_a, "b": changed_b, "c": doc_c, "n1": n1, "n2": n2, "k": doc_k}


def group_of(result, kind, key):
    return next(g for g in result["groups"][kind] if g["group_key"] == key)


# ---------------------------------------------------------------------------- 묶음


def test_queues_group_same_cause_and_signature(world, scene):
    s = world.service
    result = queues(s)
    assert result["summary"] == {"unmatched": 2, "review": 1, "failed": 2, "changed": 2, "conflict": 1}
    assert {kind: len(items) for kind, items in result["groups"].items()} == {"unmatched": 1, "review": 1, "failed": 2, "changed": 2, "conflict": 1}

    unmatched = result["groups"]["unmatched"][0]
    assert len(unmatched["group_key"]) == 64 and unmatched["count"] == 2 and unmatched["label"] == "신규 양식 후보 · 2문서"
    assert unmatched["actions"] == ["create_profile", "assign_profile"] and unmatched["impact"]["sheets"] == ["기록"] and unmatched["impact"]["documents"] == 2
    assert unmatched["representative"]["document_name"] == "n1.xlsx" and unmatched["representative"]["snapshot_id"] == scene["n1"]["snapshot"]["snapshot_id"]
    with s.db.connect() as conn:
        sha = conn.execute("SELECT signature_sha256 FROM snapshot_signature WHERE snapshot_id=?", (scene["n1"]["snapshot"]["snapshot_id"],)).fetchone()[0]
    assert unmatched["group_key"] == sha

    review = result["groups"]["review"][0]
    assert review["group_key"] == scene["profile"]["profile_id"] and review["count"] == 1 and review["label"] == "공정데이터_A양식 v1 · 매핑 검수 · 1문서"
    assert review["impact"]["rules"] == ["lot", "signer", "temperature"] and review["actions"] == ["open_review", "approve_all"] and "호환 1" in review["cause"]
    assert review["representative"]["document_id"] == scene["c"]["document_id"] and review["representative"]["application_id"] == scene["c"]["applied"][0]["application_id"]

    failed = group_of(result, "failed", "UNIT_MISMATCH")
    assert failed["count"] == 1 and failed["label"] == "파싱 실패 · UNIT_MISMATCH · 1문서" and failed["actions"] == ["open_review", "reparse"]
    assert failed["impact"]["auto_approved"] == 1 and "단위" in failed["cause"] and failed["representative"]["document_name"] == "k.xlsx"
    locked = group_of(result, "failed", "locked")
    assert locked["count"] == 1 and locked["label"] == "잠김(DRM) · 1문서" and locked["actions"] == [] and locked["representative"]["document_name"] == "locked.xlsx"

    changed = group_of(result, "changed", scene["profile"]["profile_id"])
    assert changed["count"] == 1 and changed["impact"]["identical"] == 1 and changed["actions"] == ["open_review", "approve_all", "assign_profile"]
    assert changed["representative"]["document_name"] == "a.xlsx" and changed["representative"]["application_id"] == scene["a"]["applied"][0]["application_id"]
    incompatible = group_of(result, "changed", "incompatible")
    assert incompatible["count"] == 1 and incompatible["actions"] == ["assign_profile"] and incompatible["representative"]["document_name"] == "b.xlsx"
    assert incompatible["representative"]["profile_id"] == scene["profile"]["profile_id"] and incompatible["label"] == "변경 감지 · 프로파일 불일치 · 1문서"

    conflict = result["groups"]["conflict"][0]
    assert conflict["group_key"] == "temperature" and conflict["count"] == 1 and conflict["label"] == "온도 · 단위 불일치 · 1문서"
    assert conflict["impact"] == {"documents": 1, "fields": ["temperature"], "units": ["K"], "values": 3} and conflict["cause"] == "°C 기대 · K 관측"
    assert conflict["representative"]["document_name"] == "k.xlsx" and conflict["representative"]["profile_id"] == scene["kelvin"]["profile_id"] and conflict["actions"] == ["open_review"]

    # 표시 규칙: 라벨/원인에 UUID·sha256이 없다.
    for items in result["groups"].values():
        for g in items:
            assert not any(len(part) == 36 and part.count("-") == 4 for part in g["label"].split()) and len(g["cause"]) < 200


def test_queue_pages_groups_and_members_keyset(world, scene):
    s = world.service
    first = queue(s, "failed", limit=1)
    assert [g["group_key"] for g in first["items"]] in (["UNIT_MISMATCH"], ["locked"]) and first["has_more"] and first["kind"] == "failed"
    second = queue(s, "failed", limit=1, cursor=first["next_cursor"])
    assert len(second["items"]) == 1 and second["items"][0]["group_key"] != first["items"][0]["group_key"] and not second["has_more"]
    with pytest.raises(Problem) as exc:
        queue(s, "nope")
    assert exc.value.code == "GROUP_NOT_FOUND" and exc.value.status == 404

    key = queues(s)["groups"]["unmatched"][0]["group_key"]
    page1 = members(s, "unmatched", key, limit=1)
    assert [m["document_name"] for m in page1["items"]] == ["n1.xlsx"] and page1["has_more"] and page1["items"][0]["state"] == "unmatched"
    page2 = members(s, "unmatched", key, limit=1, cursor=page1["next_cursor"])
    assert [m["document_name"] for m in page2["items"]] == ["n2.xlsx"] and not page2["has_more"]
    review = members(s, "review", scene["profile"]["profile_id"])
    assert [m["document_name"] for m in review["items"]] == ["c.xlsx"] and review["items"][0]["detail"]["rules"] == ["lot", "signer", "temperature"]
    assert review["items"][0]["application_id"] == scene["c"]["applied"][0]["application_id"] and review["items"][0]["compatibility"] == "compatible"
    failed = members(s, "failed", "UNIT_MISMATCH")["items"]
    assert [m["document_name"] for m in failed] == ["k.xlsx"] and failed[0]["detail"]["auto_approved"] == 1 and failed[0]["detail"]["error"].startswith("UNIT_MISMATCH:")
    assert [m["state"] for m in members(s, "failed", "locked")["items"]] == ["locked"]
    changed = members(s, "changed", scene["profile"]["profile_id"])["items"]
    assert [(m["document_name"], m["compatibility"], m["detail"]["inherited"]) for m in changed] == [("a.xlsx", "identical", 3)]
    incompatible = members(s, "changed", "incompatible")["items"]
    assert [(m["document_name"], m["profile_name"], m["application_id"]) for m in incompatible] == [("b.xlsx", "공정데이터_A양식", None)]
    assert incompatible[0]["detail"]["missing"] == [{"rule_key": "temperature", "role": "key", "code": "ANCHOR_NOT_FOUND"}]
    conflict = members(s, "conflict", "temperature")["items"]
    assert [(m["document_name"], m["detail"]) for m in conflict] == [("k.xlsx", {"units": ["K"], "expected": "°C", "values": 3})]
    for kind, key_ in (("unmatched", "nope"), ("review", "nope"), ("failed", "NOPE"), ("changed", "nope"), ("conflict", "pressure"), ("zzz", "x")):
        with pytest.raises(Problem) as exc:
            members(s, kind, key_)
        assert exc.value.code == "GROUP_NOT_FOUND" and exc.value.status == 404


# ---------------------------------------------------------------------------- 묶음 처리


def test_action_validation(world, scene):
    s = world.service
    key = queues(s)["groups"]["unmatched"][0]["group_key"]
    for kind, gk, action in (("unmatched", key, "approve_all"), ("review", scene["profile"]["profile_id"], "open_review"), ("failed", "locked", "reparse"), ("changed", "incompatible", "approve_all"), ("conflict", "temperature", "reparse")):
        with pytest.raises(Problem) as exc:
            queue_action(s, kind, gk, action)
        assert exc.value.code == "ACTION_NOT_ALLOWED" and exc.value.status == 422, (kind, action)
    with pytest.raises(Problem) as exc:
        queue_action(s, "unmatched", key, "assign_profile")
    assert exc.value.code == "ACTION_NOT_ALLOWED"
    with pytest.raises(Problem) as exc:
        queue_action(s, "unmatched", "missing", "assign_profile", profile_id=scene["profile"]["profile_id"])
    assert exc.value.code == "GROUP_NOT_FOUND" and exc.value.status == 404
    with pytest.raises(Problem) as exc:
        queue_action(s, "unmatched", key, "assign_profile", profile_id="nope")
    assert exc.value.code == "NOT_FOUND"


def test_approve_all_action_extracts_and_publishes(world, scene):
    s = world.service
    job = queue_action(s, "review", scene["profile"]["profile_id"], "approve_all", wait=60)
    assert job["state"] == "succeeded" and job["kind"] == "queue_action" and job["total"] == 1 and job["completed"] == 1, job
    assert job["target_kind"] == "queue_group" and job["target_id"] == f"review/{scene['profile']['profile_id']}" and job["label"].endswith("일괄 승인")
    assert job["result"] == {"queued": 1, "skipped": []} and world.calls == ["extract"]
    app = s.application_summary(scene["c"]["applied"][0]["application_id"])
    assert app["published"] and app["heads_approved"] == 3 and world.status(scene["c"]["document_id"]) == "normal"
    assert [v["value_text"] for v in s.snapshot_values(scene["c"]["snapshot"]["snapshot_id"], field_key="temperature")["items"]] == ["10.5", "20", "30"]
    after = queues(s)
    assert after["summary"]["review"] == 0 and after["groups"]["review"] == []
    with pytest.raises(Problem) as exc:
        queue_action(s, "review", scene["profile"]["profile_id"], "approve_all")
    assert exc.value.code == "GROUP_NOT_FOUND"

    # 변경 감지 묶음: identical 승계 건은 승인·추출·발행이 요청 1회.
    world.calls.clear()
    job = queue_action(s, "changed", scene["profile"]["profile_id"], "approve_all", wait=60)
    assert job["state"] == "succeeded" and job["result"] == {"queued": 1, "skipped": []} and world.calls == ["extract"]
    assert world.status(scene["a"]["document_id"]) == "normal"
    assert [v["value_text"] for v in s.snapshot_values(scene["a"]["snapshot"]["snapshot_id"], field_key="temperature")["items"]] == ["11", "21", "31"]
    assert queues(s)["summary"]["changed"] == 1  # incompatible 묶음만 남는다


def test_approve_all_skips_compatible_inherited_and_rejected(world, scene):
    s = world.service
    # compatible 승계: c.xlsx를 이동한 내용으로 재등록 → inherited compatible → approve_all은 검수 필요로 건너뛴다.
    world.file("c.xlsx", shift=2)
    changed_c = world.register("c.xlsx")
    assert changed_c["status"] == "changed" and changed_c["applied"][0]["compatibility"] == "compatible"
    group = next(g for g in queues(s)["groups"]["changed"] if g["group_key"] == scene["profile"]["profile_id"])
    assert group["count"] == 2 and group["impact"] == {"documents": 2, "rules": ["lot", "signer", "temperature"], "identical": 1, "compatible": 1}
    job = queue_action(s, "changed", scene["profile"]["profile_id"], "approve_all", extract=False, wait=60)
    assert job["result"] == {"queued": 1, "skipped": [{"document_id": changed_c["document_id"], "document_name": "c.xlsx", "reason": "review_required"}]}
    assert world.status(scene["a"]["document_id"]) == "not_extracted"  # extract=False: 승인만
    # 반려 헤드가 있는 application은 approve_all로 해소되지 않는다.
    lot = next(m for m in s.application_mappings(changed_c["applied"][0]["application_id"]) if m["rule_key"] == "lot")
    s.revise(lot["mapping_id"], expected_seq=lot["edit_seq"], status="rejected", reason="틀림")
    assert world.status(changed_c["document_id"]) == "changed"
    # identical 멤버가 없어진 묶음에는 approve_all이 비활성(ACTION_NOT_ALLOWED).
    group = next(g for g in queues(s)["groups"]["changed"] if g["group_key"] == scene["profile"]["profile_id"])
    assert group["count"] == 1 and group["actions"] == ["open_review", "assign_profile"]
    with pytest.raises(Problem) as exc:
        queue_action(s, "changed", scene["profile"]["profile_id"], "approve_all", wait=60)
    assert exc.value.code == "ACTION_NOT_ALLOWED" and exc.value.fields == {"allowed": ["assign_profile"]}
    review = s.approve_all(changed_c["applied"][0]["application_id"], extract=False)
    assert review["approved"] == 2 and review["skipped"] == [{"mapping_id": lot["mapping_id"], "rule_key": "lot", "reason": "rejected"}]
    assert world.status(changed_c["document_id"]) == "review"
    group = queues(s)["groups"]["review"][0]
    assert group["impact"]["rules"] == ["lot"] and group["impact"]["rejected"] == 1 and "반려됨" in group["cause"]
    job = queue_action(s, "review", scene["profile"]["profile_id"], "approve_all", wait=60)
    assert job["result"]["skipped"] == [{"document_id": changed_c["document_id"], "document_name": "c.xlsx", "reason": "rejected"}]


def test_assign_profile_creates_applications(world, scene):
    s = world.service
    key = queues(s)["groups"]["unmatched"][0]["group_key"]
    draft = s.import_profile("process_standard", variant_profile(name="기록 양식", sheet="기록"))
    job = queue_action(s, "unmatched", key, "assign_profile", profile_id=draft["profile_id"], wait=60)
    assert job["state"] == "succeeded" and job["result"] == {"queued": 2, "skipped": []} and job["total"] == 2, job
    assert world.calls == ["match", "match"]
    for doc in (scene["n1"], scene["n2"]):
        apps = s.snapshot_applications(doc["snapshot"]["snapshot_id"])
        assert [(a["profile_id"], a["origin"], a["compatibility"], a["state"]) for a in apps] == [(draft["profile_id"], "manual", "manual", "review")]
        assert world.status(doc["document_id"]) == "review"
    after = queues(s)
    assert after["summary"]["unmatched"] == 0 and after["groups"]["review"][0]["group_key"] == draft["profile_id"] and after["groups"]["review"][0]["count"] == 2
    # 다시 지정하면 이미 적용됨으로 건너뛴다(묶음은 review로 옮겨졌으므로 review 묶음의 문서에 직접 확인).
    with pytest.raises(Problem) as exc:
        queue_action(s, "unmatched", key, "assign_profile", profile_id=draft["profile_id"])
    assert exc.value.code == "GROUP_NOT_FOUND"

    # 불일치 묶음(b.xlsx, 온도 라벨 변경)에 승인 프로파일을 지정: match는 incompatible → 수동 적용(proposed)으로 대체.
    world.calls.clear()
    job = queue_action(s, "changed", "incompatible", "assign_profile", profile_id=scene["profile"]["profile_id"], wait=60)
    assert job["state"] == "succeeded" and job["result"] == {"queued": 1, "skipped": []}
    apps = s.snapshot_applications(scene["b"]["snapshot"]["snapshot_id"])
    assert [(a["profile_id"], a["origin"], a["compatibility"]) for a in apps] == [(scene["profile"]["profile_id"], "manual", "manual")]
    assert queues(s)["groups"]["changed"] == [g for g in queues(s)["groups"]["changed"] if g["group_key"] != "incompatible"]

    # 승인 프로파일을 identical 문서에 지정하면 §4.3 규칙으로 자동 승인·추출까지.
    world.file("n3.xlsx", sheet="공정 기록", temps=(7, 8, 9))
    s.import_profile("process_standard", {**variant_profile(name="임시", sheet="없는 시트")})  # 무관한 초안
    with s.db.connect(write=True) as conn:
        # 승인 프로파일이 없던 것처럼 unmatched 문서를 만들기 위해 등록 전에 프로파일을 잠시 폐기한다.
        conn.execute("UPDATE parsing_profile SET status='deprecated' WHERE profile_id=?", (scene["profile"]["profile_id"],))
    n3 = world.register("n3.xlsx")
    assert n3["status"] == "unmatched"
    with s.db.connect(write=True) as conn:
        conn.execute("UPDATE parsing_profile SET status='approved' WHERE profile_id=?", (scene["profile"]["profile_id"],))
    key3 = next(g["group_key"] for g in queues(s)["groups"]["unmatched"] if g["representative"]["document_name"] == "n3.xlsx")
    world.calls.clear()
    job = queue_action(s, "unmatched", key3, "assign_profile", profile_id=scene["profile"]["profile_id"], wait=60)
    assert job["result"] == {"queued": 1, "skipped": []} and world.calls == ["match", "extract"]
    assert world.status(n3["document_id"]) == "normal"


def test_reparse_action_delegates_per_profile(world, scene):
    s = world.service
    calls = []

    def fake_reparse(profile_id, mode, principal, checkpoint):
        calls.append((profile_id, mode, principal))
        checkpoint(5, 9, force=True)  # 하위 진행률은 이 작업의 문서 단위 진행률을 덮어쓰지 않는다
        return {"queued": 1, "skipped": [{"document_id": "x", "document_name": "x.xlsx", "reason": "published"}]}

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(s, "execute_reparse", fake_reparse)
        job = queue_action(s, "failed", "UNIT_MISMATCH", "reparse", mode="rematch", wait=60)
        assert job["state"] == "succeeded" and job["result"] == {"queued": 1, "skipped": [{"document_id": "x", "document_name": "x.xlsx", "reason": "published"}]}
        assert calls == [(scene["profile"]["profile_id"], "rematch", "local")] and job["total"] == 1 and job["completed"] == 1
        job = queue_action(s, "failed", "UNIT_MISMATCH", "reparse", wait=60)
        assert calls[-1][1] == "fill"
        with pytest.raises(Problem) as exc:
            queue_action(s, "failed", "UNIT_MISMATCH", "reparse", mode="all")
        assert exc.value.code == "INVALID_MODE"
    # 실제 위임: fill은 승인된 미발행 건을 다시 추출하고(다시 실패) 작업은 성공으로 끝난다.
    world.calls.clear()
    job = queue_action(s, "failed", "UNIT_MISMATCH", "reparse", wait=60)
    assert job["state"] == "succeeded" and job["result"]["queued"] == 1 and world.calls == ["extract"]
    assert queues(s)["groups"]["failed"][0]["group_key"] in ("UNIT_MISMATCH", "locked")
