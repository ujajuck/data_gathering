"""§4.9 한 건 재파싱(`POST /applications/{aid}/reparse`): 전체 재파싱과 **같은 판정**으로 적용 건 하나만
현재 프로파일 리비전에 다시 맞추고 추출한다. 새 리비전이 그 문서에만 닿는 것, 건너뛴 사유(up_to_date·
review_required·incompatible), 추출까지 가지 않은 처리(compatible → 제안 리비전만, extraction=None),
초안 프로파일의 재추출·422와 폐기 프로파일의 422, 진행 중 작업 가드, 작업 행·404."""

from __future__ import annotations

import copy

from examples.demo import demo
from tests.test_api import seeded, world  # noqa: F401  (시드 작업 공간 fixture 재사용)


def mappings(world, application_id):
    return {m["rule_key"]: m for m in world.get(f"/applications/{application_id}/mappings")["items"]}


def value_rows(mapping):
    """컴파일된 effective_spec의 값 영역 높이 — 리비전이 실제로 '새 스펙'인지 보는 눈."""
    return mapping["effective_spec"]["selector"]["value"]["areas"][0].get("relative", {}).get("rows")


def narrowed_definition():
    definition = copy.deepcopy(demo.PROFILE)
    definition["description"] = "값 영역을 60행에서 40행으로 좁힌 리비전"
    for rule in definition["rules"]:
        relative = rule["selector"]["value"]["areas"][0].get("relative") or {}
        if "rows" in relative:
            relative["rows"] = 40
    return definition


def approve_at_current_rev(world):
    """대표 문서로 다시 승인해 참조 rev를 현재 rev로 올린다(§4.8).

    승인이 큐에 넣는 것은 **프로파일 전체** 재파싱이다 — 한 건 경로만 보려는 테스트이므로 돌기 전에 취소한다."""
    approved = world.post(f"/profiles/{world.profile_id}/approve", {"application_id": world.application_id(demo.REFERENCE_DOCUMENT)})
    world.post(f"/jobs/{approved['reparse_job']['job_id']}/cancel")
    world.service.jobs.run_one()
    assert world.get(f"/jobs/{approved['reparse_job']['job_id']}")["state"] == "cancelled"
    return approved


def test_reparse_one_application_applies_the_new_revision_to_that_document_only(world):
    target, other = demo.IDENTICAL_DOCUMENTS[1], demo.IDENTICAL_DOCUMENTS[2]
    application_id, other_id = world.application_id(target), world.application_id(other)
    before = mappings(world, application_id)
    assert before["temperature"]["revision_no"] == 1 and value_rows(before["temperature"]) == 60
    other_published = world.get(f"/applications/{other_id}")["published"]

    revised = world.client.put(f"/api/profiles/{world.profile_id}", json={"definition": narrowed_definition()}).json()
    assert revised["current_rev"] == 2
    approve_at_current_rev(world)

    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    result = job["result"]
    assert result["outcome"] == "처리됨" and result["reason"] is None and result["action"] == "rematch"
    assert result["application_id"] == application_id and result["document_name"] == target
    assert result["profile"] == {"id": world.profile_id, "name": demo.PROFILE_NAME, "rev": 2}
    assert result["extraction"]["state"] == "succeeded" and result["extraction"]["values"] > 0

    after = mappings(world, application_id)
    assert after["temperature"]["revision_no"] == 2 and after["temperature"]["status"] == "approved"
    assert after["temperature"]["origin"] == "auto" and value_rows(after["temperature"]) == 40
    assert world.get(f"/applications/{application_id}")["published"]
    # 같은 프로파일을 쓰는 다른 문서는 손대지 않는다 — 전체 재파싱과 다른 점은 범위 하나뿐이다.
    untouched = mappings(world, other_id)
    assert untouched["temperature"]["revision_no"] == 1 and value_rows(untouched["temperature"]) == 60
    assert world.get(f"/applications/{other_id}")["published"] == other_published


def test_reparse_skips_when_the_application_is_already_up_to_date(world):
    application_id = world.application_id(demo.IDENTICAL_DOCUMENTS[1])
    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    result = job["result"]
    assert result["outcome"] == "건너뜀" and result["reason"] == "up_to_date"
    assert result["extraction"] is None and result["profile"]["rev"] == 1
    assert mappings(world, application_id)["temperature"]["revision_no"] == 1


def test_reparse_that_only_proposes_a_revision_reports_no_extraction(world):
    """구조가 조금 달라(compatible) proposed 리비전만 올린 경우: 처리됐지만 **추출은 없다**.

    기준 서명이 옛 rev에서 계산돼 있으면(정의만 저장하고 대표 문서로 다시 승인하지 않음) 매치가 identical이 아니다.
    화면은 이 조합(`outcome='처리됨'` + `extraction=None`)을 '검수가 필요합니다'로 말해야 한다(§7) — 값은 하나도 뽑히지 않았다."""
    name = demo.IDENTICAL_DOCUMENTS[1]
    application_id, document_id = world.application_id(name), world.doc(name)["document_id"]
    published_before = world.get(f"/applications/{application_id}")["published"]
    assert published_before and world.get(f"/documents/{document_id}")["status"] == "normal"
    assert world.client.put(f"/api/profiles/{world.profile_id}", json={"definition": narrowed_definition()}).json()["current_rev"] == 2

    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    result = job["result"]
    assert result["outcome"] == "처리됨" and result["reason"] is None and result["action"] == "rematch"
    assert result["extraction"] is None and result["profile"]["rev"] == 2
    # 헤드는 제안(proposed)으로만 올라가고 문서는 검수 대기로 내려간다 — 발행된 값은 옛 리비전 그대로다.
    heads = mappings(world, application_id)
    assert {m["status"] for m in heads.values()} == {"proposed"} and {m["origin"] for m in heads.values()} == {"profile"}
    assert world.get(f"/documents/{document_id}")["status"] == "review"


def test_reparse_is_refused_for_a_deprecated_profile(world):
    """폐기(§4.10)는 '적용 기록·추출값을 그대로 둔다'는 탈출구다 — 재추출이 발행분을 덮어쓰면 안 된다.

    전체 재파싱이 같은 프로파일을 422로 막는 것과도 어긋나지 않는다."""
    application_id = world.application_id(demo.IDENTICAL_DOCUMENTS[1])
    with world.service.db.connect() as conn:
        published = conn.execute("SELECT published_run_id FROM parsing_application WHERE application_id=?", (application_id,)).fetchone()[0]
    assert published
    world.post(f"/profiles/{world.profile_id}/deprecate")

    denied = world.post(f"/applications/{application_id}/reparse?wait=30", expect=422)
    assert denied["error"]["code"] == "PROFILE_DEPRECATED"
    with world.service.db.connect() as conn:
        assert conn.execute("SELECT published_run_id FROM parsing_application WHERE application_id=?", (application_id,)).fetchone()[0] == published


def test_reparse_skips_an_inherited_snapshot_that_waits_for_review(world):
    """새 snapshot 승계(§4.4)는 사람이 approve_all로 끝낸다 — 한 건 재파싱이 대신 승인하지 않는다."""
    name = demo.IDENTICAL_DOCUMENTS[1]
    demo.mutate_document(world.root, name, 0.7)
    registered = world.post("/documents/register?wait=30", {"source_refs": [name]})
    assert registered["state"] == "succeeded", registered
    document_id = world.doc(name)["document_id"]
    assert world.get(f"/documents/{document_id}")["status"] == "changed"
    snapshot_id = world.get(f"/documents/{document_id}/snapshots")["items"][0]["snapshot_id"]
    application_id = world.get(f"/snapshots/{snapshot_id}/applications")["items"][0]["application_id"]

    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    assert job["result"]["outcome"] == "건너뜀" and job["result"]["reason"] == "review_required"
    assert job["result"]["extraction"] is None
    assert world.get(f"/documents/{document_id}")["status"] == "changed"


def test_reparse_skips_an_application_whose_document_does_not_match_the_profile(world):
    """수동 적용(§4.3)은 구조가 맞지 않아도 붙는다 — 다시 파싱은 그 사실을 사유로 돌려준다."""
    snapshot_id = world.snapshot_id(demo.OTHER_DOCUMENT)
    sheet_id = world.get(f"/snapshots/{snapshot_id}/sheets")["items"][0]["sheet_id"]
    applied = world.post(
        f"/snapshots/{snapshot_id}/applications",
        {"profile_id": world.profile_id, "sheet_bindings": {"main": [sheet_id], "common": [sheet_id]}},
        expect=201,
    )
    job = world.post(f"/applications/{applied['application_id']}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    assert job["result"]["outcome"] == "건너뜀" and job["result"]["reason"] == "incompatible"
    assert job["result"]["extraction"] is None


def test_reparse_of_an_unapproved_profile_only_reextracts_and_needs_approved_heads(world):
    """승인되지 않은 프로파일: 헤드가 전부 approved일 때만 '재추출'이 되고, 아니면 전체 경로와 같이 422다."""
    definition = copy.deepcopy(demo.PROFILE)
    definition["profile_name"] = "공정데이터_A양식 초안"
    draft = world.post("/profiles", {"schema_key": demo.SCHEMA_KEY, "definition": definition}, expect=201)
    snapshot_id = world.snapshot_id(demo.IDENTICAL_DOCUMENTS[2])
    applied = world.post(f"/snapshots/{snapshot_id}/applications", {"profile_id": draft["profile_id"]}, expect=201)
    application_id = applied["application_id"]
    assert world.post(f"/applications/{application_id}/reparse", expect=422)["error"]["code"] == "PROFILE_NOT_APPROVED"

    approved = world.post(f"/applications/{application_id}/approve-all?wait=30", {"reason": "초안 검수"})
    assert approved["extraction"]["state"] == "succeeded", approved
    revisions = {m["revision_no"] for m in world.get(f"/applications/{application_id}/mappings")["items"]}

    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    result = job["result"]
    assert result["action"] == "extract" and result["outcome"] == "처리됨" and result["reason"] is None
    assert result["profile"]["name"] == "공정데이터_A양식 초안" and result["profile"]["rev"] == 1
    assert result["extraction"]["state"] == "succeeded" and result["extraction"]["values"] > 0
    # 재추출만 했으므로 매핑 리비전은 늘지 않는다(스펙을 다시 맞추지 않았다).
    assert {m["revision_no"] for m in world.get(f"/applications/{application_id}/mappings")["items"]} == revisions


def test_reparse_is_refused_while_another_job_holds_the_document(world):
    """문서 삭제(§4.13)와 같은 가드 — 같은 문서를 두 작업이 동시에 잡지 않는다."""
    name = demo.IDENTICAL_DOCUMENTS[1]
    application_id = world.application_id(name)
    with world.service.db.connect(write=True) as conn:
        conn.execute(
            "INSERT INTO runtime_job (job_id,kind,state,principal,payload_json,request_key,request_hash,"
            "target_kind,target_id,created_at) VALUES ('busy-1','extract','running',?,'{}','busy-1','h','application',?,'2026-01-01T00:00:00.000+00:00')",
            (world.service.principal, application_id),
        )
    denied = world.post(f"/applications/{application_id}/reparse", expect=409)
    assert denied["error"]["code"] == "DOCUMENT_BUSY"
    # 다른 문서는 막지 않는다(막는 범위를 넓히지 않는다).
    other = world.post(f"/applications/{world.application_id(demo.IDENTICAL_DOCUMENTS[2])}/reparse", expect=202)
    assert other["kind"] == "reparse"


def test_reparse_job_row_and_unknown_application(world):
    name = demo.IDENTICAL_DOCUMENTS[1]
    application_id = world.application_id(name)
    # 본문은 받지 않는다 — 프런트가 빈 객체를 보내도 그대로 통한다(mode는 rematch 고정).
    job = world.post(f"/applications/{application_id}/reparse", {}, expect=202)
    assert job["kind"] == "reparse" and job["target_kind"] == "application" and job["target_id"] == application_id
    assert job["label"] == f"{name} · {demo.PROFILE_NAME} v1 · 다시 파싱"
    assert world.get(f"/jobs/{job['job_id']}")["state"] in ("queued", "running", "succeeded")
    assert world.post("/applications/없는-적용-건/reparse", expect=404)["error"]["code"] == "NOT_FOUND"


def test_reparse_reports_a_failed_extraction_without_failing_the_job(world):
    """추출 실패는 작업을 실패로 만들지 않는다(§4.6) — 실행 행에 남고, 결과의 `extraction`이 그 사실을 말한다."""
    definition = copy.deepcopy(demo.PROFILE)
    definition["profile_name"] = "공정데이터_A양식 초안2"
    draft = world.post("/profiles", {"schema_key": demo.SCHEMA_KEY, "definition": definition}, expect=201)
    name = demo.IDENTICAL_DOCUMENTS[2]
    applied = world.post(f"/snapshots/{world.snapshot_id(name)}/applications", {"profile_id": draft["profile_id"]}, expect=201)
    application_id = applied["application_id"]
    world.post(f"/applications/{application_id}/approve-all?wait=30", {"reason": "초안 검수"})
    (world.root / "data/raw" / name).unlink()

    job = world.post(f"/applications/{application_id}/reparse?wait=30")
    assert job["state"] == "succeeded", job
    extraction = job["result"]["extraction"]
    assert job["result"]["outcome"] == "처리됨" and job["result"]["action"] == "extract"
    assert extraction["state"] == "failed" and extraction["values"] == 0
    assert extraction["error"]["code"] and extraction["error"]["message"], extraction
    assert world.get(f"/documents/{world.doc(name)['document_id']}")["status"] == "failed"
