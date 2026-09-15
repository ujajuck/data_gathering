"""스키마 쓰기 경로(계약 §4.2·§4.2.1·§4.2.2, §6 스키마 표) — 생성/새 리비전 분리, 스키마 삭제, 필드 추가·수정·삭제.

`POST /schemas`는 생성 전용이고(같은 키는 409 `SCHEMA_EXISTS`, 아무것도 쓰지 않는다) 새 리비전은 `PUT`만 만든다.
삭제는 참조가 하나도 없을 때만 실제로 행과 정의 폴더를 지운다 — 거부는 무엇이 쓰고 있는지 응답에 담는다.
필드 `POST`·`PATCH`·`GET` 응답은 모두 같은 필드 상세이며 `schema.rev`는 저장 뒤 `current_rev`다.
"""

from __future__ import annotations

import copy

import pytest

from examples.demo import demo
from tests.test_api import seeded, world  # noqa: F401  (작업 공간 fixture 재사용)

SCHEMA_KEY = demo.SCHEMA_KEY
PROFILE_NAME = demo.PROFILE_NAME
EXISTS_MESSAGE = "이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요."


def standalone(key="warehouse", name="창고 표준", fields=None):
    """어떤 프로파일도 쓰지 않는 새 스키마 정의."""
    return {
        "format": "parsing-schema",
        "schema_version": "3.0",
        "schema_key": key,
        "schema_name": name,
        "fields": fields
        or [
            {"field_key": "bin", "name": "적치장", "type": "text", "level": 1},
            {"field_key": "quantity", "name": "수량", "type": "decimal", "unit": "ea", "level": 2, "parents": ["bin"]},
        ],
    }


def files(world, key):
    folder = world.root / "schemas" / key
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


def field_rows(world, key):
    with world.service.db.connect() as conn:
        return {
            r["field_key"]: r["status"]
            for r in conn.execute(
                "SELECT f.field_key, f.status FROM parsing_field f JOIN parsing_schema s ON s.schema_id=f.schema_id WHERE s.schema_key=?",
                (key,),
            )
        }


# ---------------------------------------------------------------------------- 생성 vs 새 리비전


def test_post_schemas_is_create_only_and_writes_nothing_on_conflict(world):
    created = world.post("/schemas", {"definition": standalone()}, expect=201)
    assert created == {
        "schema_key": "warehouse",
        "schema_name": "창고 표준",
        "current_rev": 1,
        "unchanged": False,
        "fields": {"total": 2, "added": 2, "updated": 0, "deprecated": 0},
    }
    assert files(world, "warehouse") == ["current.json", "r0001.json"]

    # 같은 키로 (다른 내용으로) 다시 POST → 409, 파일·리비전·projection 모두 그대로.
    second = copy.deepcopy(standalone())
    second["schema_name"] = "창고 표준 v2"
    second["fields"].append({"field_key": "zone", "name": "구역", "type": "text", "level": 1})
    conflict = world.post("/schemas", {"definition": second}, expect=409)
    assert conflict["error"]["code"] == "SCHEMA_EXISTS" and conflict["error"]["message"] == EXISTS_MESSAGE
    assert files(world, "warehouse") == ["current.json", "r0001.json"]
    detail = world.get("/schemas/warehouse")
    assert detail["current_rev"] == 1 and detail["schema_name"] == "창고 표준" and len(detail["fields"]) == 2
    assert set(field_rows(world, "warehouse")) == {"bin", "quantity"}

    # 시드 스키마도 마찬가지 — POST로는 덮어쓸 수 없다.
    again = world.post("/schemas", {"definition": demo.SCHEMA}, expect=409)
    assert again["error"]["code"] == "SCHEMA_EXISTS"
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 1


def test_put_schema_makes_the_new_revision_and_guards_key_and_existence(world):
    world.post("/schemas", {"definition": standalone()}, expect=201)
    revised = copy.deepcopy(standalone())
    revised["fields"].append({"field_key": "zone", "name": "구역", "type": "text", "level": 1})
    body = world.client.put("/api/schemas/warehouse", json={"definition": revised})
    assert body.status_code == 200
    assert body.json() == {
        "schema_key": "warehouse",
        "schema_name": "창고 표준",
        "current_rev": 2,
        "unchanged": False,
        "fields": {"total": 3, "added": 1, "updated": 2, "deprecated": 0},
    }
    assert files(world, "warehouse") == ["current.json", "r0001.json", "r0002.json"]

    # 해시가 같으면 리비전을 올리지 않는다.
    same = world.client.put("/api/schemas/warehouse", json={"definition": revised}).json()
    assert same["unchanged"] is True and same["current_rev"] == 2 and files(world, "warehouse") == ["current.json", "r0001.json", "r0002.json"]

    mismatch = world.client.put("/api/schemas/process_standard", json={"definition": revised})
    assert mismatch.status_code == 422 and mismatch.json()["error"]["code"] == "SCHEMA_KEY_MISMATCH"
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 1

    unknown = world.client.put("/api/schemas/nope", json={"definition": standalone("nope", "없는 스키마")})
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "UNKNOWN_SCHEMA"
    assert files(world, "nope") == []

    # 각 리비전의 canonical 정의를 그대로 돌려준다('새 리비전'·'이름 바꾸기' 대화상자가 읽는다).
    assert [f["field_key"] for f in world.get("/schemas/warehouse/revisions/1")["fields"]] == ["bin", "quantity"]
    assert [f["field_key"] for f in world.get("/schemas/warehouse/revisions/2")["fields"]] == ["bin", "quantity", "zone"]
    assert world.get("/schemas/warehouse/revisions/3", expect=404)["error"]["code"] == "DEFINITION_MISSING"


# ---------------------------------------------------------------------------- 스키마 삭제


def test_delete_schema_refuses_while_a_profile_uses_it(world):
    denied = world.client.delete(f"/api/schemas/{SCHEMA_KEY}")
    assert denied.status_code == 409
    error = denied.json()["error"]
    assert error["code"] == "SCHEMA_IN_USE"
    assert error["message"] == (
        f"이 스키마는 파싱 프로파일 1개({PROFILE_NAME})가 쓰고 있고 적용된 문서가 4개입니다. "
        f"프로파일 상세에서 '삭제'한 뒤 다시 시도하거나, 더 쓰지 않으려면 이 스키마를 '폐기'하세요."
    )
    assert error["detail"]["profile_count"] == 1 and error["detail"]["document_count"] == 4
    assert error["detail"]["profiles"] == [
        {"profile_id": world.profile_id, "profile_name": PROFILE_NAME, "current_rev": 1, "status": "approved", "document_count": 4}
    ]
    # 아무것도 지우지 않았다.
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 1 and len(field_rows(world, SCHEMA_KEY)) == 14
    assert "r0001.json" in files(world, SCHEMA_KEY)


def test_delete_schema_removes_projection_rows_and_definition_folder(world):
    world.post("/schemas", {"definition": standalone()}, expect=201)
    revised = copy.deepcopy(standalone())
    revised["fields"][1]["aliases"] = ["수량(ea)", "QTY"]
    world.client.put("/api/schemas/warehouse", json={"definition": revised})

    removed = world.client.delete("/api/schemas/warehouse")
    assert removed.status_code == 200
    assert removed.json() == {
        "schema_key": "warehouse",
        "schema_name": "창고 표준",
        "deleted": {"fields": 2, "aliases": 2, "edges": 1, "revisions": 2},
    }
    assert files(world, "warehouse") == [] and not (world.root / "schemas/warehouse").exists()
    assert field_rows(world, "warehouse") == {}
    with world.service.db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM parsing_schema WHERE schema_key='warehouse'").fetchone()[0] == 0
    assert world.get("/schemas/warehouse", expect=404)["error"]["code"] == "NOT_FOUND"
    assert [s["schema_key"] for s in world.get("/schemas")["items"]] == [SCHEMA_KEY]
    assert world.client.delete("/api/schemas/warehouse").status_code == 404


# ---------------------------------------------------------------------------- 필드 추가·수정


def test_create_field_returns_field_detail_and_guards_key_and_parent(world):
    created = world.client.post(
        f"/api/schemas/{SCHEMA_KEY}/fields",
        json={"field_key": "note", "name": "비고", "type": "text", "description": "자유 기재", "aliases": ["메모"], "parent_field_key": "process"},
    )
    assert created.status_code == 201
    field = created.json()
    assert field["field_key"] == "note" and field["name"] == "비고" and field["type"] == "text" and field["description"] == "자유 기재"
    assert field["aliases"] == ["메모"] and field["parents"] == ["process"] and field["children"] == [] and field["related"] == []
    assert field["status"] == "active" and field["profile_count"] == 0 and field["document_count"] == 0
    assert field["schema"] == {"key": SCHEMA_KEY, "name": demo.SCHEMA["schema_name"], "rev": 2}
    # GET·POST 응답이 같은 형태다.
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/note") == field
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 2 and len(field_rows(world, SCHEMA_KEY)) == 15
    assert "note" in [f["field_key"] for f in world.get(f"/schemas/{SCHEMA_KEY}/revisions/2")["fields"]]

    duplicate = world.client.post(f"/api/schemas/{SCHEMA_KEY}/fields", json={"field_key": "note", "name": "비고2"})
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "FIELD_EXISTS"
    orphan = world.client.post(f"/api/schemas/{SCHEMA_KEY}/fields", json={"field_key": "x", "name": "엑스", "parent_field_key": "없는키"})
    assert orphan.status_code == 422 and orphan.json()["error"]["code"] == "UNKNOWN_PARENT"
    # 거부는 리비전을 늘리지 않는다.
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 2


def test_patch_field_returns_field_detail_with_the_new_revision(world):
    patched = world.client.patch(
        f"/api/schemas/{SCHEMA_KEY}/fields/pressure", json={"name": "압력(절대)", "aliases": ["압력", "PRESS"], "description": "절대압"}
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["field_key"] == "pressure" and body["name"] == "압력(절대)" and body["aliases"] == ["압력", "PRESS"]
    assert body["description"] == "절대압" and body["parents"] == ["process"] and body["unit"] == "bar"
    assert body["schema"]["rev"] == 2 and body["profile_count"] == 1
    assert "unchanged" not in body and "added" not in body  # 가져오기 요약이 아니다
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/pressure") == body
    assert [r["rev"] for r in world.get(f"/schemas/{SCHEMA_KEY}/revisions")["items"]] == [2, 1]


# ---------------------------------------------------------------------------- 필드 삭제


def test_delete_field_refuses_when_children_exist(world):
    denied = world.client.delete(f"/api/schemas/{SCHEMA_KEY}/fields/process")
    assert denied.status_code == 409
    error = denied.json()["error"]
    assert error["code"] == "FIELD_HAS_CHILDREN" and error["message"].startswith("하위 필드 7개(")
    assert error["detail"]["count"] == 7
    assert {c["field_key"] for c in error["detail"]["children"]} == {
        "process_name",
        "equipment",
        "lot",
        "measured_at",
        "temperature",
        "pressure",
        "duration",
    }
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 1 and len(field_rows(world, SCHEMA_KEY)) == 14


def test_delete_field_refuses_when_rules_or_values_use_it(world):
    denied = world.client.delete(f"/api/schemas/{SCHEMA_KEY}/fields/temperature")
    assert denied.status_code == 409
    error = denied.json()["error"]
    assert error["code"] == "FIELD_IN_USE"
    assert error["message"].startswith(f"이 필드는 프로파일 1개({PROFILE_NAME} 규칙 temperature)가 쓰고 있고 추출값이 ")
    assert error["message"].endswith("개입니다. 프로파일 정의에서 이 필드를 쓰는 규칙을 뺀 새 리비전을 저장한 뒤 다시 시도하세요.")
    assert error["detail"]["profiles"] == [{"profile_id": world.profile_id, "profile_name": PROFILE_NAME, "rule_keys": ["temperature"]}]
    assert error["detail"]["value_count"] > 0 and error["detail"]["mapping_count"] > 0
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 1 and field_rows(world, SCHEMA_KEY)["temperature"] == "active"


def test_delete_field_saves_a_revision_without_it_and_drops_the_projection_row(world):
    world.client.post(
        f"/api/schemas/{SCHEMA_KEY}/fields", json={"field_key": "note", "name": "비고", "type": "text", "aliases": ["메모"], "parent_field_key": "process"}
    )
    assert world.get(f"/schemas/{SCHEMA_KEY}")["current_rev"] == 2 and "note" in field_rows(world, SCHEMA_KEY)

    removed = world.client.delete(f"/api/schemas/{SCHEMA_KEY}/fields/note")
    assert removed.status_code == 200
    assert removed.json() == {"schema_key": SCHEMA_KEY, "field_key": "note", "name": "비고", "current_rev": 3, "fields_remaining": 14}
    # 새 리비전 파일에서 빠졌고 projection 행은 deprecated가 아니라 아예 사라졌다.
    assert "note" not in [f["field_key"] for f in world.get(f"/schemas/{SCHEMA_KEY}/revisions/3")["fields"]]
    assert "note" not in field_rows(world, SCHEMA_KEY) and len(field_rows(world, SCHEMA_KEY)) == 14
    with world.service.db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM parsing_alias WHERE alias_text='메모'").fetchone()[0] == 0
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/note", expect=404)["error"]["code"] == "NOT_FOUND"
    assert world.client.delete(f"/api/schemas/{SCHEMA_KEY}/fields/note").status_code == 404
    # 남은 필드의 관계는 그대로다.
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/process")["children"] == [
        "process_name",
        "equipment",
        "lot",
        "measured_at",
        "temperature",
        "pressure",
        "duration",
    ]


def test_delete_field_drops_parent_and_related_references_in_the_new_revision(world):
    # 상위 필드 밑에 자식 없는 필드 두 개를 만들고, 서로를 related로 잇는다.
    world.client.post(f"/api/schemas/{SCHEMA_KEY}/fields", json={"field_key": "note", "name": "비고", "parent_field_key": "process"})
    definition = world.service.schema_definition(SCHEMA_KEY)
    for f in definition["fields"]:
        if f["field_key"] == "pressure":
            f["related"] = ["note"]
    world.client.put(f"/api/schemas/{SCHEMA_KEY}", json={"definition": definition})
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/pressure")["related"] == ["note"]

    removed = world.client.delete(f"/api/schemas/{SCHEMA_KEY}/fields/note")
    assert removed.status_code == 200 and removed.json()["fields_remaining"] == 14
    rev = world.get(f"/schemas/{SCHEMA_KEY}/revisions/{removed.json()['current_rev']}")
    assert all("note" not in (f.get("related") or []) + (f.get("parents") or []) for f in rev["fields"])
    assert world.get(f"/schemas/{SCHEMA_KEY}/fields/pressure")["related"] == []


# ---------------------------------------------------------------------------- 인증 제거


def test_main_api_has_no_user_access_token(world, monkeypatch):
    # 남은 토큰은 렌더 서버 내부 bearer 하나뿐이고, 그것도 메인 API를 잠그지 않는다(계약 §6 공통).
    monkeypatch.setenv("SCHEMA_RENDER_TOKEN", "secret")
    settings = world.get("/settings")
    assert "access_token_required" not in settings and settings["principal"]
    # 토큰이 설정돼 있어도 헤더 없이 읽기·쓰기가 모두 된다(메인 API는 인증하지 않는다).
    assert world.client.get("/api/schemas").status_code == 200
    assert world.client.post("/api/schemas", json={"definition": standalone("plain", "무인증 스키마")}).status_code == 201
    assert world.client.delete("/api/schemas/plain").status_code == 200


@pytest.mark.parametrize("key", ["..", ".", "a/b"])
def test_schema_key_path_fragments_are_rejected(world, key):
    body = world.post("/schemas", {"definition": standalone(key, f"경로 {key}")}, expect=422)
    assert body["error"]["code"] == "INVALID_SCHEMA"


# ---------------------------------------------------------------------------- 리뷰 반영(2차)


def test_level_is_filled_in_so_added_fields_always_have_a_parent_level(world):
    """level을 적지 않은 정의도 트리 깊이를 받는다 — `+ 필드 추가`가 422로 막히던 자리(§1.2)."""
    flat = standalone(
        "levelless",
        "레벨 없는 표준",
        [{"field_key": "root", "name": "뿌리", "type": "group"}, {"field_key": "leaf", "name": "잎", "type": "text", "parents": ["root"]}],
    )
    created = world.post("/schemas", {"definition": flat}, expect=201)
    assert created["current_rev"] == 1
    levels = {f["field_key"]: f["level"] for f in world.get("/schemas/levelless/revisions/1")["fields"]}
    assert levels == {"root": 1, "leaf": 2}
    # 그 아래에 하위 필드를 더한다 — 예전에는 부모 level이 None이라 422 INVALID_SCHEMA였다.
    child = world.post("/schemas/levelless/fields", {"field_key": "twig", "name": "잔가지", "type": "text", "parent_field_key": "leaf"}, expect=201)
    assert child["field_key"] == "twig"
    nodes = {n["field_key"]: n["level"] for n in _flatten(world.get("/schemas/levelless/tree")["nodes"])}
    assert nodes == {"root": 1, "leaf": 2, "twig": 3}
    # 최상위 필드도 언제나 level 1이다(화면의 들여쓰기·그래프 묶기가 null을 만나지 않는다).
    top = world.post("/schemas/levelless/fields", {"field_key": "zone", "name": "구역", "type": "group"}, expect=201)
    assert top["field_key"] == "zone"
    assert {n["field_key"]: n["level"] for n in _flatten(world.get("/schemas/levelless/tree")["nodes"])}["zone"] == 1


def _flatten(nodes):
    for node in nodes:
        yield node
        yield from _flatten(node.get("children") or [])


def test_last_field_delete_is_refused_with_its_own_message(world):
    world.post("/schemas", {"definition": standalone("solo", "필드 하나", [{"field_key": "bin", "name": "적치장", "type": "text"}])}, expect=201)
    denied = world.client.delete("/api/schemas/solo/fields/bin")
    assert denied.status_code == 409
    error = denied.json()["error"]
    assert error["code"] == "LAST_FIELD"
    assert error["message"] == "마지막 남은 필드는 지울 수 없습니다. 스키마 자체를 지우려면 스키마 상세의 '삭제'를 쓰세요."
    assert world.get("/schemas/solo")["current_rev"] == 1


def test_deprecated_rules_do_not_block_field_delete(world):
    """폐기된 규칙은 `GET /schemas/{key}/profiles`에 안 나오므로 삭제도 막지 않는다(두 질의의 기준을 하나로).

    예전에는 `FIELD_IN_USE`가 지목한 프로파일이 '사용 프로파일 보기' 목록에는 없어, 사용자가 무엇을 떼어내야
    지울 수 있는지 끝내 알 수 없었다."""
    world.post("/schemas", {"definition": standalone("wh5", "창고 표준 5")}, expect=201)
    definition = {
        "format": "parsing-profile",
        "schema_version": "3.0",
        "profile_name": "창고 양식 5",
        "schema_key": "wh5",
        "sheet_roles": {"main": {"cardinality": "one", "match": {"name": "Sheet1"}}},
        "anchors": {},
        "rules": [_rule("quantity", "수량")],
    }
    profile = world.post("/profiles", {"schema_key": "wh5", "name": "창고 양식 5", "definition": definition}, expect=201)
    # quantity 규칙이 있는 동안에는 막힌다.
    denied = world.client.delete("/api/schemas/wh5/fields/quantity")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "FIELD_IN_USE"
    # 정의에서 그 규칙을 빼면 규칙 행은 deprecated로 남는다 — 그 뒤에는 목록에도 없고 삭제도 막지 않는다.
    revised = {**definition, "rules": [_rule("bin", "적치장")]}
    assert world.client.put(f"/api/profiles/{profile['profile_id']}", json={"definition": revised}).status_code == 200
    assert world.get("/schemas/wh5/profiles?field_key=quantity")["items"] == []
    removed = world.client.delete("/api/schemas/wh5/fields/quantity")
    assert removed.status_code == 200, removed.text
    assert removed.json()["field_key"] == "quantity"


def _rule(field_key, label):
    return {
        "rule_key": field_key,
        "rule_name": label,
        "field_key": field_key,
        "selector": {
            "key": {"areas": [{"sheet_role": "main", "find": {"texts": [label], "within": "A1:D10"}}]},
            "value": {"areas": [{"sheet_role": "main", "relative": {"row": 0, "col": 1}}]},
        },
        "value_spec": {"type": "text"},
    }


def test_deleting_the_profile_unblocks_schema_delete(world):
    """§4.2.1 거부 문구가 시키는 '프로파일 삭제'가 실제로 되는 행동이고, 그 뒤 스키마 삭제가 통한다."""
    # 적용 건이 없는 스키마 + 그 스키마를 쓰는 프로파일 하나.
    world.post("/schemas", {"definition": standalone("wh2", "창고 표준 2")}, expect=201)
    profile = world.post(
        "/profiles",
        {
            "schema_key": "wh2",
            "name": "창고 양식",
            "definition": {
                "format": "parsing-profile",
                "schema_version": "3.0",
                "profile_name": "창고 양식",
                "schema_key": "wh2",
                "sheet_roles": {"main": {"cardinality": "one", "match": {"name": "Sheet1"}}},
                "anchors": {},
                "rules": [_rule("bin", "적치장")],
            },
        },
        expect=201,
    )
    denied = world.client.delete("/api/schemas/wh2")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "SCHEMA_IN_USE"
    assert "'삭제'한 뒤 다시 시도하거나, 더 쓰지 않으려면 이 스키마를 '폐기'하세요." in denied.json()["error"]["message"]
    removed = world.client.delete(f"/api/profiles/{profile['profile_id']}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["deleted"]["rules"] == 1
    assert world.get("/schemas/wh2")["profile_count"] == 0
    again = world.client.delete("/api/schemas/wh2")
    assert again.status_code == 200, again.text
    assert files(world, "wh2") == []


def test_profile_delete_is_refused_while_documents_use_it_and_deprecate_is_the_way_out(world):
    """적용된 문서가 있는 프로파일은 지울 수 없다 — 그때 가능한 행동('폐기')만 안내한다."""
    denied = world.client.delete(f"/api/profiles/{world.profile_id}")
    assert denied.status_code == 409
    error = denied.json()["error"]
    assert error["code"] == "PROFILE_IN_USE"
    assert error["message"] == "이 프로파일은 문서 4개에 적용돼 있어 지울 수 없습니다. 더 쓰지 않으려면 '폐기'하세요."
    assert world.post(f"/profiles/{world.profile_id}/deprecate", {})["status"] == "deprecated"
    assert world.get(f"/profiles/{world.profile_id}")["status"] == "deprecated"
    # 폐기는 기록을 지우지 않는다 — 스키마 삭제는 여전히 막힌다.
    assert world.client.delete(f"/api/schemas/{SCHEMA_KEY}").status_code == 409


def test_recreating_a_deleted_key_does_not_resurrect_old_revisions(world):
    """지운 스키마의 리비전 파일이 같은 키의 새 스키마에 되살아나지 않는다(§4.2.1)."""
    world.post("/schemas", {"definition": standalone("wh3", "창고 표준 3")}, expect=201)
    assert world.client.put("/api/schemas/wh3", json={"definition": standalone("wh3", "창고 표준 3 v2")}).status_code == 200
    assert files(world, "wh3") == ["current.json", "r0001.json", "r0002.json"]
    assert world.client.delete("/api/schemas/wh3").status_code == 200
    world.post("/schemas", {"definition": standalone("wh3", "새 창고 표준")}, expect=201)
    assert files(world, "wh3") == ["current.json", "r0001.json"]
    assert [r["rev"] for r in world.get("/schemas/wh3/revisions")["items"]] == [1]
    assert world.get("/schemas/wh3/revisions/2", expect=404)["error"]["code"] == "DEFINITION_MISSING"
    assert not (world.root / "schemas/.trash").exists() or not any((world.root / "schemas/.trash").iterdir())


def test_schema_revision_zero_is_rejected(world):
    body = world.get(f"/schemas/{SCHEMA_KEY}/revisions/0", expect=422)
    assert body["error"]["code"] == "VALIDATION_ERROR"


# ---------------------------------------------------------------------------- 스키마 폐기·폐기 해제(§4.2.3)


def _profile_body(schema_key=SCHEMA_KEY, name="폐기 확인용"):
    return {
        "name": name,
        "schema_key": schema_key,
        "definition": {
            "format": "parsing-profile",
            "schema_version": "3.0",
            "profile_name": name,
            "schema_key": schema_key,
            "sheet_roles": {"main": {"cardinality": "one", "match": {"name": "공정 기록"}}},
            "anchors": {},
            "rules": [_rule("lot", "LOT")] if schema_key == SCHEMA_KEY else [_rule("bin", "적치장")],
        },
    }


def test_deprecate_schema_returns_the_detail_shape_and_hides_it_from_the_default_list(world):
    detail = world.get(f"/schemas/{SCHEMA_KEY}")
    assert detail["status"] == "active"

    body = world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    assert body["status"] == "deprecated"
    # 응답은 GET /schemas/{key}와 같은 형태다 — 화면이 이 하나로 헤더·칩·버튼을 갱신한다.
    assert body == world.get(f"/schemas/{SCHEMA_KEY}")
    assert set(body) == set(detail) and [f["field_key"] for f in body["fields"]] == [f["field_key"] for f in detail["fields"]]
    # 정의·리비전·필드·프로파일·적용 건은 그대로다(리비전도 올리지 않는다).
    assert body["current_rev"] == detail["current_rev"] and body["application_count"] == detail["application_count"]
    assert body["profile_count"] == detail["profile_count"] and files(world, SCHEMA_KEY) == ["current.json", "r0001.json"]

    assert [s["schema_key"] for s in world.get("/schemas")["items"]] == []
    assert [s["schema_key"] for s in world.get("/schemas?status=deprecated")["items"]] == [SCHEMA_KEY]
    assert [s["schema_key"] for s in world.get("/schemas?status=all")["items"]] == [SCHEMA_KEY]
    # 상세·트리·그래프·필드·연관 목록은 상태와 무관하게 열린다.
    assert world.get(f"/schemas/{SCHEMA_KEY}/tree")["nodes"]
    assert world.get(f"/schemas/{SCHEMA_KEY}/graph")["nodes"]
    assert world.get(f"/schemas/{SCHEMA_KEY}/profiles")["items"]

    again = world.post(f"/schemas/{SCHEMA_KEY}/deprecate", expect=409)
    assert again["error"] == {"code": "ALREADY_DEPRECATED", "message": "이미 폐기된 스키마입니다."}
    assert world.get("/schemas?status=bogus", expect=422)["error"]["code"] == "VALIDATION_ERROR"
    assert world.post("/schemas/없는키/deprecate", expect=404)["error"]["code"] == "UNKNOWN_SCHEMA"


def test_deprecated_schema_refuses_new_profiles_but_keeps_editing_and_building(world):
    world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    denied = world.post("/profiles", _profile_body(), expect=422)
    assert denied["error"] == {
        "code": "SCHEMA_DEPRECATED",
        "message": "폐기된 파싱 스키마에는 새 프로파일을 만들 수 없습니다. 스키마 상세에서 '폐기 해제'한 뒤 다시 시도하세요.",
    }
    assert len(world.get("/profiles")["items"]) == 1

    # 이미 있는 프로파일의 새 리비전과 import-preview는 막지 않는다.
    current = world.get(f"/profiles/{world.profile_id}/revisions/1")
    revised = copy.deepcopy(current)
    revised["description"] = "폐기 뒤에도 고칠 수 있다"
    saved = world.client.put(f"/api/profiles/{world.profile_id}", json={"definition": revised})
    assert saved.status_code == 200 and saved.json()["current_rev"] == 2
    preview = world.post("/profiles/import-preview", {"schema_key": SCHEMA_KEY, "definition": revised})
    assert preview["errors"] == []

    # 필드 추가·수정과 PUT /schemas도 된다 — 폐기는 잠금이 아니다.
    created = world.post(
        f"/schemas/{SCHEMA_KEY}/fields",
        {"field_key": "extra_note", "name": "추가 비고", "type": "text"},
        expect=201,
    )
    assert created["field_key"] == "extra_note"

    # 빌드 API는 폐기 스키마의 schema_key를 받는다(목록에서만 빠진다).
    document_ids = [d["document_id"] for d in world.summary["documents"] if d["document_id"]]
    found = world.post("/builds/candidates", {"document_ids": document_ids, "schema_key": SCHEMA_KEY})
    assert found["summary"]["usable"] >= 1 and found["fields"]


def test_deprecated_schema_keeps_auto_applying_its_approved_profile(world):
    world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    source = world.root / "data/raw" / demo.IDENTICAL_DOCUMENTS[1]
    (world.root / "data/raw/공정데이터_2024_07.xlsx").write_bytes(source.read_bytes())
    job = world.post("/documents/register?wait=60", {"source_refs": ["공정데이터_2024_07.xlsx"]})
    assert job["state"] == "succeeded", job
    registered = job["result"]["documents"][0]
    # 스키마 폐기는 "새 정의를 더 만들지 말라"는 뜻이지 "돌고 있는 파싱을 멈추라"는 뜻이 아니다.
    assert [a["compatibility"] for a in registered["applied"]] == ["identical"]
    assert registered["status"] == "normal"


def test_activate_schema_brings_it_back_to_the_default_list(world):
    world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    body = world.post(f"/schemas/{SCHEMA_KEY}/activate")
    assert body["status"] == "active" and body == world.get(f"/schemas/{SCHEMA_KEY}")
    assert [s["schema_key"] for s in world.get("/schemas")["items"]] == [SCHEMA_KEY]
    assert [s["schema_key"] for s in world.get("/schemas?status=deprecated")["items"]] == []
    again = world.post(f"/schemas/{SCHEMA_KEY}/activate", expect=409)
    assert again["error"] == {"code": "ALREADY_ACTIVE", "message": "이미 활성 상태인 스키마입니다."}
    assert world.post("/schemas/없는키/activate", expect=404)["error"]["code"] == "UNKNOWN_SCHEMA"
    # 폐기 해제 뒤에는 새 프로파일도 다시 만들 수 있다.
    assert world.post("/profiles", _profile_body(), expect=201)["status"] == "draft"


def test_saving_a_revision_does_not_quietly_undo_the_deprecation(world):
    """폐기를 되돌리는 길은 `activate` 하나다 — 설명 한 줄 수정이 가드를 풀면 아무 화면도 그것을 알리지 않는다."""
    world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    current = world.get(f"/schemas/{SCHEMA_KEY}/revisions/1")
    revised = copy.deepcopy(current)
    revised["description"] = "설명만 바꾼다"
    saved = world.client.put(f"/api/schemas/{SCHEMA_KEY}", json={"definition": revised})
    assert saved.status_code == 200 and saved.json()["current_rev"] == 2
    assert world.get(f"/schemas/{SCHEMA_KEY}")["status"] == "deprecated"

    # 필드 PATCH도 같은 UPDATE를 탄다.
    field_key = world.get(f"/schemas/{SCHEMA_KEY}")["fields"][0]["field_key"]
    patched = world.client.patch(f"/api/schemas/{SCHEMA_KEY}/fields/{field_key}", json={"description": "필드 설명만 바꾼다"})
    assert patched.status_code == 200
    assert world.get(f"/schemas/{SCHEMA_KEY}")["status"] == "deprecated"
    # 가드도 그대로 산다 — 새 리비전을 저장했다고 새 프로파일이 붙지 않는다.
    assert world.post("/profiles", _profile_body(), expect=422)["error"]["code"] == "SCHEMA_DEPRECATED"
    assert [s["schema_key"] for s in world.get("/schemas")["items"]] == []
    # 새 스키마를 만들 때의 status는 그대로 active다.
    assert world.post(f"/schemas/{SCHEMA_KEY}/activate")["status"] == "active"


def test_deprecating_a_schema_does_not_open_the_delete_path(world):
    world.post(f"/schemas/{SCHEMA_KEY}/deprecate")
    denied = world.client.delete(f"/api/schemas/{SCHEMA_KEY}")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "SCHEMA_IN_USE"
    assert world.get(f"/schemas/{SCHEMA_KEY}?", expect=200)["current_rev"] == 1
