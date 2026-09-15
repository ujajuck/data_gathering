"""API(계약 §6, prefix `/api`) — 서비스 규칙은 `service.py`에 있고 여기는 HTTP 경계만 맡는다.

공통: 오류 `{error:{code,message,fields?,detail?}}`, 목록 `{items,has_more,next_cursor}`(keyset, limit ≤ 200), 본문 2MB,
`Cache-Control: no-store`(렌더 창·asset만 `private, no-cache` + ETag/304). 사용자 인증은 없다 — 메인 API는 기본으로
127.0.0.1에만 바인딩하고, 접근 제어는 그 경계에서 한다(렌더 서버와 주고받는 내부 bearer는 별개다).
`?wait=<초≤60>`는 작업 완료를 기다렸다가 최종 JobResponse를 돌려준다. 빌드(`/builds*`)는 `build.py`, 작업 큐(`/queues*`)는 `operations.py`에 위임한다.
"""

from __future__ import annotations

import heapq
import os
import re
import threading
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request
from fastapi import Path as FPath
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field

from . import ENGINE_VERSION
from . import build as build_module
from . import drm
from . import operations
from .contracts import (
    ApplicationRequest,
    ApproveAllRequest,
    BuildCandidatesRequest,
    Contract,
    BuildPreviewRequest,
    DocumentDeleteRequest,
    BuildRequest,
    FieldPatchRequest,
    ImportPreviewRequest,
    JobResponse,
    FieldCreateRequest,
    ProfileApproveRequest,
    ProfileCreateRequest,
    ProfileTestRequest,
    ProfileUpdateRequest,
    QueueActionRequest,
    RegisterRequest,
    ReparseRequest,
    RevisionRequest,
    RollbackRequest,
    SchemaDefinitionRequest,
)
from .db import Problem, decode_cursor, load, one, page, rows
from .jobs import Jobs, env
from .normalization import presets
from .profile import LIMITS, ROLES
from .render import RENDERER_VERSION
from .render.cache import ASSET_RE, WINDOW_COLS, WINDOW_ROWS, valid_id
from .render.client import RenderUnavailable
from .service import Service

BODY_LIMIT = 2 * 1024 * 1024
MAX_WAIT = 60
NO_CACHE = "private, no-cache"
DocumentStatus = Literal["not_extracted", "locked", "unmatched", "review", "changed", "failed", "normal"]
DocumentSort = Literal["document_name", "status", "last_processed_at", "-document_name", "-status", "-last_processed_at"]
JobState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
JobKind = Literal["register", "extract", "reparse", "build", "test", "queue_action", "delete"]


class RegisterDirectoryRequest(Contract):
    """§4.1.1 폴더 일괄 등록 본문(POST /documents/register-directory)."""

    directory: str = Field("", max_length=1024)
    provider: str = Field("local-xlsx", min_length=1, max_length=200)
    include_unchanged: bool = False


ProfileStatus = Literal["draft", "approved", "deprecated"]
SchemaListStatus = Literal["active", "deprecated", "all"]
BuildFormat = Literal["csv", "xlsx", "sqlite"]
FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
AUTHORIZE_TTL_SECONDS = 30
THREAD_POOL_TOKENS = 200

# pydantic 오류 유형 → 한국어 문구(ctx 값을 채운다). 원문 msg는 fields[].detail로 남긴다.
VALIDATION_MESSAGES = {
    "missing": "{field}은(는) 필수입니다.",
    "extra_forbidden": "{field}은(는) 허용되지 않는 항목입니다.",
    "less_than_equal": "{field}은(는) {le} 이하여야 합니다.",
    "less_than": "{field}은(는) {lt} 미만이어야 합니다.",
    "greater_than_equal": "{field}은(는) {ge} 이상이어야 합니다.",
    "greater_than": "{field}은(는) {gt} 초과여야 합니다.",
    "literal_error": "{field}은(는) {expected} 중 하나여야 합니다.",
    "enum": "{field}은(는) {expected} 중 하나여야 합니다.",
    "string_too_long": "{field}은(는) {max_length}자 이하여야 합니다.",
    "string_too_short": "{field}은(는) {min_length}자 이상이어야 합니다.",
    "too_long": "{field}은(는) {max_length}개 이하여야 합니다.",
    "too_short": "{field}은(는) {min_length}개 이상이어야 합니다.",
    "string_type": "{field}은(는) 문자열이어야 합니다.",
    "int_type": "{field}은(는) 정수여야 합니다.",
    "int_parsing": "{field}은(는) 정수여야 합니다.",
    "float_type": "{field}은(는) 숫자여야 합니다.",
    "float_parsing": "{field}은(는) 숫자여야 합니다.",
    "bool_type": "{field}은(는) true/false여야 합니다.",
    "bool_parsing": "{field}은(는) true/false여야 합니다.",
    "list_type": "{field}은(는) 배열이어야 합니다.",
    "dict_type": "{field}은(는) 객체여야 합니다.",
    "model_type": "{field}은(는) 객체여야 합니다.",
    "json_invalid": "요청 본문이 올바른 JSON이 아닙니다.",
    "value_error": "{field}이(가) 유효하지 않습니다.",
}


def validation_message(error):
    """pydantic 오류 하나를 사용자용 한국어 문장으로 옮긴다(다른 오류와 같은 언어)."""
    loc = [str(part) for part in error.get("loc", ()) if part not in ("body", "query", "path", "header")]
    field = ".".join(loc) or "요청"
    ctx = dict(error.get("ctx") or {})
    if "expected" in ctx:
        ctx["expected"] = str(ctx["expected"]).replace("'", "")
    template = VALIDATION_MESSAGES.get(error.get("type"), "{field}이(가) 유효하지 않습니다.")
    try:
        return field, template.format(field=field, **ctx)
    except (KeyError, IndexError):
        return field, f"{field}이(가) 유효하지 않습니다."


# ---------------------------------------------------------------------------- 조회 도우미(읽기 전용 SQL)


def _area_text(area):
    if "range" in area:
        return area["range"]
    if "find" in area:
        find = area["find"]
        return "find " + ("/" + find["regex"] + "/" if find.get("regex") else "|".join(find.get("texts") or []))
    if "relative" in area:
        rel = area["relative"]
        text = f"rel({rel.get('row', 0):+d},{rel.get('col', 0):+d})"
        if rel.get("rows", 1) > 1 or rel.get("cols", 1) > 1:
            text += f"[{rel.get('rows', 1)}×{rel.get('cols', 1)}]"
        if rel.get("anchor"):
            text += "@" + str(rel["anchor"] if isinstance(rel["anchor"], str) else rel["anchor"].get("anchor_name", "?"))
        return text
    if "anchor" in area:
        return "@" + str(area["anchor"])
    return "?"


def selector_summary(selector):
    """규칙 목록에 보이는 한 줄 요약(UUID 없음)."""
    parts = []
    for role in ROLES:
        sel = (selector or {}).get(role)
        if not isinstance(sel, dict):
            continue
        areas = ", ".join(f"{a.get('sheet_role')} {_area_text(a)}" for a in sel.get("areas") or [] if isinstance(a, dict))
        extra = ""
        if role == "value":
            cardinality = sel.get("cardinality", "scalar")
            extra = " " + cardinality + (f"/{sel['axis']}" if cardinality != "scalar" and sel.get("axis") else "")
        parts.append(f"{role}: {areas}{extra}")
    return " · ".join(parts)


def _rate(published, total):
    return round(published / total, 3) if total else None


def _definition_revisions(folder: Path, current_rev, count_key):
    """정의 파일 폴더의 r%04d.json 목록(최신순). count_key 항목 수를 함께 센다."""
    items = []
    if folder.is_dir():
        for path in sorted(folder.glob("r[0-9][0-9][0-9][0-9].json"), reverse=True):
            rev = int(path.stem[1:])
            stat = path.stat()
            try:
                definition = load(path.read_text(encoding="utf-8"))
            except ValueError:
                definition = {}
            entry = {
                "rev": rev,
                "current": rev == current_rev,
                "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
                "byte_size": stat.st_size,
                count_key: len(definition.get("rules" if count_key == "rule_count" else "fields") or []),
            }
            if isinstance(definition, dict):
                entry["description"] = definition.get("description")
                if count_key == "rule_count":
                    entry["profile_name"] = definition.get("profile_name")
            items.append(entry)
    return {"items": items, "has_more": False, "next_cursor": None}


PROFILE_COUNTS = (
    "(SELECT count(DISTINCT d.document_id) FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id WHERE a.profile_id=p.profile_id) document_count, "
    "(SELECT count(DISTINCT d.document_id) FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id WHERE a.profile_id=p.profile_id AND a.published_run_id IS NOT NULL) published_count"
)


def profile_list(service, q, status, schema_key, cursor, limit):
    where, params = [], []
    if q:
        where.append("p.profile_name LIKE ? ESCAPE '\\'")
        params.append("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    if status:
        where.append("p.status=?")
        params.append(status)
    if schema_key:
        where.append("s.schema_key=?")
        params.append(schema_key)
    scope = ["profiles", q, status, schema_key]
    after = decode_cursor(cursor, scope, 2)
    if after:
        where.append("(p.profile_name, p.profile_id) > (?,?)")
        params.extend(after)
    with service.db.connect() as conn:
        found = rows(
            conn,
            f"SELECT p.profile_id, p.profile_name, p.current_rev, p.status, p.updated_at, p.description, s.schema_key, s.schema_name, {PROFILE_COUNTS} "
            f"FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY p.profile_name, p.profile_id LIMIT ?",
            (*params, limit + 1),
        )
    result = page(found, limit, ("profile_name", "profile_id"), scope)
    result["items"] = [
        {
            "profile_id": r["profile_id"],
            "profile_name": r["profile_name"],
            "description": r["description"],
            "current_rev": r["current_rev"],
            "schema": {"key": r["schema_key"], "name": r["schema_name"]},
            "status": r["status"],
            "document_count": r["document_count"],
            "success_rate": _rate(r["published_count"], r["document_count"]),
            "updated_at": r["updated_at"],
        }
        for r in result["items"]
    ]
    return result


def profile_detail(service, profile_id):
    with service.db.connect() as conn:
        p = one(
            conn,
            f"SELECT p.*, s.schema_key, s.schema_name, {PROFILE_COUNTS} FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.profile_id=?",
            (profile_id,),
            "파싱 프로파일을 찾을 수 없습니다.",
        )
        rules = rows(
            conn,
            "SELECT r.rule_key, r.rule_name, r.selector_json, r.value_spec_json, r.status, r.ordinal, f.field_key, f.field_name, f.value_type, f.canonical_unit "
            "FROM parsing_rule r LEFT JOIN parsing_field f ON f.field_id=r.default_field_id WHERE r.profile_id=? ORDER BY r.status='deprecated', r.ordinal, r.rule_key",
            (profile_id,),
        )
        reference = None
        if p["reference_application_id"]:
            ref = conn.execute(
                "SELECT a.application_id, d.document_id, d.document_name, s.snapshot_id, s.revision_no, s.captured_at, (d.current_snapshot_id = s.snapshot_id) is_current "
                "FROM parsing_application a JOIN document_snapshot s ON s.snapshot_id=a.snapshot_id JOIN document d ON d.document_id=s.document_id WHERE a.application_id=?",
                (p["reference_application_id"],),
            ).fetchone()
            if ref:
                reference = {
                    "application_id": ref["application_id"],
                    "document_id": ref["document_id"],
                    "document_name": ref["document_name"],
                    "snapshot": {"snapshot_id": ref["snapshot_id"], "revision_no": ref["revision_no"], "captured_at": ref["captured_at"], "is_current": bool(ref["is_current"])},
                    "approved_at": p["updated_at"],
                    "profile_rev": p["reference_profile_rev"],
                }
    canonical = service.profile_canonical(profile_id, p["current_rev"]) if p["current_rev"] else {}
    return {
        "profile_id": profile_id,
        "profile_name": p["profile_name"],
        "description": p["description"],
        "status": p["status"],
        "current_rev": p["current_rev"],
        "schema": {"key": p["schema_key"], "name": p["schema_name"]},
        "reference": reference,
        "auto_approval_active": bool(p["status"] == "approved" and p["reference_signature"] and p["reference_profile_rev"] == p["current_rev"]),
        "sheet_roles": canonical.get("sheet_roles") or {},
        "anchors": canonical.get("anchors") or {},
        "rules": [
            {
                "rule_key": r["rule_key"],
                "rule_name": r["rule_name"],
                "field": {"key": r["field_key"], "name": r["field_name"], "type": r["value_type"], "unit": r["canonical_unit"]} if r["field_key"] else None,
                "selector_summary": selector_summary(load(r["selector_json"])),
                "selector": load(r["selector_json"]),
                "value_spec": load(r["value_spec_json"]),
                "status": r["status"],
            }
            for r in rules
        ],
        "document_count": p["document_count"],
        "success_rate": _rate(p["published_count"], p["document_count"]),
        "created_at": p["created_at"],
        "updated_at": p["updated_at"],
    }


SCHEMA_COUNTS = (
    "(SELECT count(*) FROM parsing_field f WHERE f.schema_id=s.schema_id AND f.status='active') field_count, "
    "(SELECT count(*) FROM parsing_profile p WHERE p.schema_id=s.schema_id) profile_count, "
    "(SELECT count(DISTINCT d.document_id) FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id WHERE a.schema_id=s.schema_id) document_count, "
    # 화면이 '삭제' 버튼을 띄울지 판단하는 값 — delete_schema가 막는 기준과 같다(§4.2.1).
    "(SELECT count(*) FROM parsing_application a WHERE a.schema_id=s.schema_id) application_count"
)


def _schema_row(conn, schema_key):
    return one(conn, f"SELECT s.*, {SCHEMA_COUNTS} FROM parsing_schema s WHERE s.schema_key=?", (schema_key,), "파싱 스키마를 찾을 수 없습니다.")


def _schema_public(r):
    return {
        "schema_key": r["schema_key"],
        "schema_name": r["schema_name"],
        "description": r["description"],
        "current_rev": r["current_rev"],
        "status": r["status"],
        "field_count": r["field_count"],
        "profile_count": r["profile_count"],
        "document_count": r["document_count"],
        "application_count": r["application_count"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def _fields_with_edges(conn, schema_id):
    """필드 행(ordinal 순) + parents/children/related(field_key 목록) + aliases. 그래프·트리·상세가 공유한다."""
    fields = rows(conn, "SELECT * FROM parsing_field WHERE schema_id=? ORDER BY ordinal, field_key", (schema_id,))
    by_id = {f["field_id"]: f for f in fields}
    for f in fields:
        f["parents"], f["children"], f["related"], f["aliases"] = [], [], [], []
    for e in conn.execute("SELECT * FROM parsing_field_edge WHERE schema_id=? ORDER BY ordinal, edge_id", (schema_id,)):
        src, dst = by_id.get(e["from_field_id"]), by_id.get(e["to_field_id"])
        if not src or not dst:
            continue
        if e["relation"] == "parent_of":
            dst["parents"].append(src["field_key"])
            src["children"].append(dst["field_key"])
        else:
            src["related"].append(dst["field_key"])
    for a in conn.execute(
        "SELECT a.field_id, a.alias_text FROM parsing_alias a JOIN parsing_field f ON f.field_id=a.field_id WHERE f.schema_id=? ORDER BY a.rowid", (schema_id,)
    ):
        by_id[a["field_id"]]["aliases"].append(a["alias_text"])
    order = {f["field_key"]: n for n, f in enumerate(fields)}
    for f in fields:
        # 간선 ordinal은 정의 안의 순서일 뿐이므로 목록은 필드 순서(ordinal)로 보여 준다.
        for key in ("parents", "children", "related"):
            f[key].sort(key=order.__getitem__)
    return fields


def _field_public(f):
    return {
        "field_key": f["field_key"],
        "name": f["field_name"],
        "description": f["description"],
        "type": f["value_type"],
        "unit": f["canonical_unit"],
        "level": f["field_level"],
        "status": f["status"],
        "ordinal": f["ordinal"],
        "aliases": f["aliases"],
        "parents": f["parents"],
        "children": f["children"],
        "related": f["related"],
    }


def _field_usage(conn, schema_id):
    """field_id → {profile_count, document_count}(현재 snapshot·발행 실행 기준)."""
    usage = {}
    for r in conn.execute(
        "SELECT r.default_field_id field_id, count(DISTINCT r.profile_id) n FROM parsing_rule r JOIN parsing_field f ON f.field_id=r.default_field_id WHERE f.schema_id=? AND r.status='active' GROUP BY r.default_field_id",
        (schema_id,),
    ):
        usage.setdefault(r["field_id"], {})["profile_count"] = r["n"]
    # 발행 실행 목록은 작고, (run_id, field_id) 쌍은 커버링 인덱스 value_by_run_field_record만으로 뽑힌다(값 행을 읽지 않는다).
    for r in conn.execute(
        "SELECT field_id, count(*) n FROM (SELECT DISTINCT p.run_id, v.field_id FROM (SELECT a.published_run_id run_id FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id WHERE a.schema_id=? AND a.published_run_id IS NOT NULL) p "
        "JOIN extracted_value v ON v.run_id=p.run_id) GROUP BY field_id",
        (schema_id,),
    ):
        usage.setdefault(r["field_id"], {})["document_count"] = r["n"]
    return usage


def schema_list(service, status="active"):
    """§4.2.3 목록. 기본이 active라 폐기 스키마는 스키마 화면·새 프로파일 대화상자·데이터 빌드 선택에서 빠진다."""
    where, params = ("", ()) if status == "all" else ("WHERE s.status=? ", (status,))
    with service.db.connect() as conn:
        found = rows(conn, f"SELECT s.*, {SCHEMA_COUNTS} FROM parsing_schema s {where}ORDER BY s.schema_name", params)
    return {"items": [_schema_public(r) for r in found], "has_more": False, "next_cursor": None}


def schema_detail(service, schema_key):
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        fields = _fields_with_edges(conn, s["schema_id"])
    return {**_schema_public(s), "fields": [_field_public(f) for f in fields]}


def schema_tree(service, schema_key):
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        fields = _fields_with_edges(conn, s["schema_id"])
    by_key = {f["field_key"]: f for f in fields}

    def node(f):
        # parent_of는 레벨이 +1로 강제되므로(트리거) 순환이 없다. 다부모 필드는 부모마다 나타난다.
        return {
            "field_key": f["field_key"],
            "name": f["field_name"],
            "type": f["value_type"],
            "unit": f["canonical_unit"],
            "level": f["field_level"],
            "status": f["status"],
            "aliases": f["aliases"],
            "parents": f["parents"],
            "children": [node(by_key[c]) for c in f["children"] if c in by_key],
        }

    return {
        "schema_key": schema_key,
        "schema_name": s["schema_name"],
        "current_rev": s["current_rev"],
        "nodes": [node(f) for f in fields if not f["parents"]],
    }


def schema_graph(service, schema_key):
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        fields = _fields_with_edges(conn, s["schema_id"])
        usage = _field_usage(conn, s["schema_id"])
    edges = []
    for f in fields:
        for p in f["parents"]:
            edges.append({"from": p, "to": f["field_key"], "relation": "parent_of"})
        for r in f["related"]:
            edges.append({"from": f["field_key"], "to": r, "relation": "related_to"})
    return {
        "schema_key": schema_key,
        "schema_name": s["schema_name"],
        "current_rev": s["current_rev"],
        "nodes": [
            {
                "field_key": f["field_key"],
                "name": f["field_name"],
                "level": f["field_level"],
                "type": f["value_type"],
                "unit": f["canonical_unit"],
                "status": f["status"],
                "parents": f["parents"],
                "document_count": usage.get(f["field_id"], {}).get("document_count", 0),
                "profile_count": usage.get(f["field_id"], {}).get("profile_count", 0),
            }
            for f in fields
        ],
        "edges": edges,
    }


def schema_profiles(service, schema_key, field_key=None):
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        field = _require_field(conn, s, field_key) if field_key else None
        where, params = ["p.schema_id=?"], [s["schema_id"]]
        if field:
            where.append("EXISTS (SELECT 1 FROM parsing_rule r WHERE r.profile_id=p.profile_id AND r.default_field_id=? AND r.status='active')")
            params.append(field["field_id"])
        profiles = rows(
            conn,
            f"SELECT p.profile_id, p.profile_name, p.current_rev, p.status, p.updated_at, {PROFILE_COUNTS} FROM parsing_profile p WHERE {' AND '.join(where)} ORDER BY p.profile_name",
            params,
        )
        rule_rows = rows(
            conn,
            "SELECT r.profile_id, r.rule_key, r.default_field_id FROM parsing_rule r JOIN parsing_profile p ON p.profile_id=r.profile_id WHERE p.schema_id=? AND r.status='active' ORDER BY r.profile_id, r.ordinal, r.rule_key",
            (s["schema_id"],),
        )
    keys = {}
    for r in rule_rows:
        if field is None or r["default_field_id"] == field["field_id"]:
            keys.setdefault(r["profile_id"], []).append(r["rule_key"])
    return {
        "items": [
            {
                "profile_id": p["profile_id"],
                "profile_name": p["profile_name"],
                "current_rev": p["current_rev"],
                "status": p["status"],
                "rules": {"count": len(keys.get(p["profile_id"], [])), "keys": keys.get(p["profile_id"], [])[:5]},
                "document_count": p["document_count"],
                "success_rate": _rate(p["published_count"], p["document_count"]),
                "updated_at": p["updated_at"],
            }
            for p in profiles
        ],
        "has_more": False,
        "next_cursor": None,
    }


def _require_field(conn, schema, field_key):
    return one(conn, "SELECT * FROM parsing_field WHERE schema_id=? AND field_key=?", (schema["schema_id"], field_key), "필드를 찾을 수 없습니다.")


def schema_documents(service, schema_key, field_key, cursor, limit):
    scope = ["schema-documents", schema_key, field_key]
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        where, params = ["a.schema_id=?"], [s["schema_id"]]
        if field_key:
            field = _require_field(conn, s, field_key)
            where.append("EXISTS (SELECT 1 FROM extracted_value v WHERE v.run_id=a.published_run_id AND v.field_id=?)")
            params.append(field["field_id"])
        after = decode_cursor(cursor, scope, 2)
        if after:
            where.append("(d.document_name, a.application_id) > (?,?)")
            params.extend(after)
        found = rows(
            conn,
            "SELECT d.document_id, d.document_name, d.status, a.application_id, a.profile_id, a.profile_rev, a.published_run_id, p.profile_name, p.status profile_status, s.snapshot_id, s.revision_no, s.captured_at "
            "FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id JOIN document_snapshot s ON s.snapshot_id=a.snapshot_id JOIN parsing_profile p ON p.profile_id=a.profile_id "
            f"WHERE {' AND '.join(where)} ORDER BY d.document_name, a.application_id LIMIT ?",
            (*params, limit + 1),
        )
    result = page(found, limit, ("document_name", "application_id"), scope)
    result["items"] = [
        {
            "document_id": r["document_id"],
            "document_name": r["document_name"],
            "profile": {"profile_id": r["profile_id"], "profile_name": r["profile_name"], "rev": r["profile_rev"], "status": r["profile_status"]},
            "snapshot": {"snapshot_id": r["snapshot_id"], "revision_no": r["revision_no"], "captured_at": r["captured_at"]},
            "status": r["status"],
            "application_id": r["application_id"],
            "published": bool(r["published_run_id"]),
        }
        for r in result["items"]
    ]
    return result


def field_detail(service, schema_key, field_key):
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        fields = _fields_with_edges(conn, s["schema_id"])
        field = next((f for f in fields if f["field_key"] == field_key), None)
        if field is None:
            raise Problem("NOT_FOUND", "필드를 찾을 수 없습니다.", 404)
        usage = _field_usage(conn, s["schema_id"]).get(field["field_id"], {})
    return {
        **_field_public(field),
        "schema": {"key": s["schema_key"], "name": s["schema_name"], "rev": s["current_rev"]},
        "profile_count": usage.get("profile_count", 0),
        "document_count": usage.get("document_count", 0),
    }


def field_values(service, schema_key, field_key, limit):
    """발행된(현재 snapshot) 값 중 최신순 — 필드 상세의 'Source Review 열기' 진입점."""
    with service.db.connect() as conn:
        s = _schema_row(conn, schema_key)
        field = _require_field(conn, s, field_key)
        found = rows(
            conn,
            "SELECT cv.value_id, cv.display_text, cv.value_text, cv.unit_normalized, cv.value_state, cv.created_at, cv.application_id, cv.document_id, cv.snapshot_id, cv.record_key, "
            "d.document_name, s.captured_at, r.rule_key "
            "FROM current_value cv JOIN document d ON d.document_id=cv.document_id JOIN document_snapshot s ON s.snapshot_id=cv.snapshot_id "
            "JOIN mapping_revision mr ON mr.mapping_revision_id=cv.mapping_revision_id JOIN mapping m ON m.mapping_id=mr.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id "
            "WHERE cv.field_id=? ORDER BY cv.created_at DESC, cv.value_id LIMIT ?",
            (field["field_id"], limit),
        )
        firsts = service._first_regions(conn, [r["value_id"] for r in found])
    return {
        "items": [
            {
                "text": r["display_text"] if r["display_text"] not in (None, "") else (r["value_text"] or ""),
                "value_id": r["value_id"],
                "value_state": r["value_state"],
                "unit_normalized": r["unit_normalized"],
                "record_key": r["record_key"],
                **(firsts.get(r["value_id"]) or {"sheet_id": None, "sheet_name": None, "range": None}),
                "application_id": r["application_id"],
                "rule_key": r["rule_key"],
                "document_id": r["document_id"],
                "document_name": r["document_name"],
                "snapshot_id": r["snapshot_id"],
                "captured_at": r["captured_at"],
                "created_at": r["created_at"],
            }
            for r in found
        ],
        "has_more": False,
        "next_cursor": None,
    }


def jobs_list(service, state, kind, cursor, limit):
    """작업 내역은 작업 공간 전체(principal은 서버 설정값이라 CLI/시드가 만든 작업도 같은 내역이다)."""
    scope = ["jobs", state, kind]
    where, params = ["1=1"], []
    if state:
        where.append("state=?")
        params.append(state)
    if kind:
        where.append("kind=?")
        params.append(kind)
    after = decode_cursor(cursor, scope, 2)
    if after:
        where.append("(created_at, job_id) < (?,?)")
        params.extend(after)
    with service.db.connect() as conn:
        found = rows(conn, f"SELECT * FROM runtime_job WHERE {' AND '.join(where)} ORDER BY created_at DESC, job_id DESC LIMIT ?", (*params, limit + 1))
    result = page(found, limit, ("created_at", "job_id"), scope)
    # 목록은 축약 결과만 싣는다(§6): 폴더 일괄 등록의 documents[≤500]까지 실으면 한 페이지가 수 MB가 된다.
    result["items"] = [Jobs.public(r, brief=True) for r in result["items"]]
    return result


def snapshot_context(service, snapshot_id):
    with service.db.connect() as conn:
        return one(
            conn,
            "SELECT s.snapshot_id, s.change_token, s.document_id, d.provider, d.source_path, d.document_name FROM document_snapshot s JOIN document d ON d.document_id=s.document_id WHERE s.snapshot_id=?",
            (snapshot_id,),
            "snapshot을 찾을 수 없습니다.",
        )


# ---------------------------------------------------------------------------- 출처 방어

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


def allowed_hosts() -> list[str]:
    """`SCHEMA_ALLOWED_HOSTS`(쉼표 구분)로 넓힐 수 있는 Host 허용 목록. 기본은 루프백뿐이다."""
    extra = [h.strip().lower() for h in env("ALLOWED_HOSTS", "").split(",") if h.strip()]
    return list(LOOPBACK_HOSTS) + extra


def host_allowed(host: str, allowed=None) -> bool:
    """`Host` 헤더가 허용 목록에 있는가. 포트는 무시하고 이름만 본다."""
    name = (host or "").strip().lower()
    if not name:
        return False
    if name.startswith("["):  # IPv6 리터럴 [::1]:8031
        name = name.split("]", 1)[0] + "]"
    else:
        name = name.rsplit(":", 1)[0] if name.count(":") == 1 else name
    allowed = allowed_hosts() if allowed is None else allowed
    return name in allowed or (name == "*" and "*" in allowed)


def guard_origin(request: Request):
    """DNS 리바인딩·교차 출처 쓰기 차단(§6 공통).

    메인 API에는 사용자 인증이 없고 기본으로 127.0.0.1에만 바인딩한다. 브라우저의 동일 출처 정책은 루프백을
    막아 주지만 DNS 리바인딩은 막지 못한다 — 공격자 도메인이 127.0.0.1로 바뀌면 그 페이지에게 `/api/*`는
    **동일 출처**가 된다. 그래서 (1) `Host`가 루프백(또는 `SCHEMA_ALLOWED_HOSTS`)이 아니면 끊고,
    (2) 쓰기 메서드는 교차 출처(`Sec-Fetch-Site`/`Origin`)면 거부한다."""
    allowed = allowed_hosts()
    if "*" not in allowed and not host_allowed(request.headers.get("host", ""), allowed):
        return JSONResponse(
            {
                "error": {
                    "code": "HOST_NOT_ALLOWED",
                    "message": "이 주소로는 API를 쓸 수 없습니다. 127.0.0.1로 접속하거나 서버에 SCHEMA_ALLOWED_HOSTS를 설정하세요.",
                }
            },
            status_code=400,
        )
    if request.method in WRITE_METHODS:
        site = (request.headers.get("sec-fetch-site") or "").lower()
        origin = (request.headers.get("origin") or "").strip()
        cross = site in ("cross-site", "same-site") or (
            not site and origin and not host_allowed(origin.split("//", 1)[-1], allowed)
        )
        if cross:
            return JSONResponse(
                {"error": {"code": "CROSS_ORIGIN_DENIED", "message": "다른 출처에서 온 쓰기 요청은 거부합니다."}},
                status_code=403,
            )
    return None


# ---------------------------------------------------------------------------- 설치


def install(app: FastAPI, root, start_worker=True):
    service = Service(root)
    app.state.service = service
    router = APIRouter(prefix="/api")
    previous_validation = app.exception_handlers.get(RequestValidationError)

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, exc: Problem):
        body = {"error": {"code": exc.code, "message": exc.message}}
        if exc.fields:
            body["error"]["fields"] = exc.fields
        # §6 detail — SCHEMA_IN_USE·FIELD_IN_USE·FIELD_HAS_CHILDREN의 구조화 본문(화면은 message만으로도 뜻이 통한다).
        if getattr(exc, "detail", None) is not None:
            body["error"]["detail"] = exc.detail
        headers = {"Retry-After": "5"} if exc.code in ("RENDER_UNAVAILABLE", "RENDER_QUEUE_FULL", "QUEUE_FULL") else None
        return JSONResponse(body, status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        if previous_validation is not None and not request.url.path.startswith("/api/"):
            return await previous_validation(request, exc)
        errors = []
        for e in exc.errors():
            field, message = validation_message(e)
            errors.append({"field": ".".join(map(str, e["loc"])), "name": field, "message": message, "detail": e.get("msg")})
        return JSONResponse(
            {"error": {"code": "VALIDATION_ERROR", "message": " ".join(e["message"] for e in errors) or "요청이 유효하지 않습니다.", "fields": errors}},
            status_code=422,
        )

    @app.middleware("http")
    async def bounded_request(request: Request, call_next):
        if not request.url.path.startswith("/api/"):
            return await call_next(request)
        denied = guard_origin(request)
        if denied is not None:
            return denied
        if request.method in ("POST", "PUT", "PATCH"):
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > BODY_LIMIT:
                    return JSONResponse({"error": {"code": "BODY_LIMIT", "message": "요청 본문은 2MB 이하여야 합니다."}}, status_code=413)
            request._body = bytes(data)
        response = await call_next(request)
        # 렌더 창·asset은 엔드포인트가 private, no-cache + ETag를 직접 설정한다.
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def principal():
        # 메인 API는 사용자 토큰을 받지 않는다(§6). 클라이언트가 사용자 이름을 전달해 권한을 바꾸지 못하게
        # principal은 언제나 서버 설정(SCHEMA_PRINCIPAL)에서만 읽는다.
        return service.principal

    Wait = Query(0.0, ge=0, le=MAX_WAIT)
    Limit = Query(50, ge=1, le=200)

    def job_response(job):
        body = JobResponse(**job).model_dump()
        return JSONResponse(body, status_code=202 if body["state"] in ("queued", "running") else 200)

    authorize_cache, authorize_lock = {}, threading.Lock()

    def authorize(context, user, required="view"):
        """Reader authorize. local-xlsx는 4바이트 매직 검사뿐이라 프로세스 격리 없이 확인한다(창 응답 지연 없음).
        다른 provider는 Reader 프로세스를 띄우므로 (principal, 원본, token, 권한)별로 짧게(30초) 결과를 기억한다."""
        if context["provider"] == "local-xlsx":
            from .readers import XlsxReader

            caps = XlsxReader(service.root, user).authorize(context["source_path"], required)
        else:
            cache_key = (user, context["provider"], context["source_path"], context.get("change_token"), required)
            with authorize_lock:
                hit = authorize_cache.get(cache_key)
            if hit and hit[0] > time.monotonic():
                caps = hit[1]
            else:
                caps = service._read(context["provider"], user, "authorize", {"source_ref": context["source_path"], "required": required})
                with authorize_lock:
                    if len(authorize_cache) > 512:
                        authorize_cache.clear()
                    authorize_cache[cache_key] = (time.monotonic() + AUTHORIZE_TTL_SECONDS, caps)
        key = {"view": "can_view", "extract": "can_extract", "render": "can_render_web"}[required]
        if not isinstance(caps, dict) or not caps.get("can_view") or not caps.get(key):
            raise Problem("ACCESS_DENIED", "이 작업에 필요한 원본 접근 권한이 없습니다.", 403)
        return caps

    # ---- 공통 --------------------------------------------------------------------------
    @router.get("/status")
    def status(user=Depends(principal)):
        result = service.status()
        client = service.render
        render = {"mode": client.mode, "url": client.url or None, "available": True, "queue_depth": None, "rendering": None}
        try:
            info = client.status() or {}
            render.update({k: info.get(k) for k in ("queue_depth", "rendering", "renderer_version", "cache_bytes")})
        except Problem:
            render["available"] = False
        return {**result, "render": render}

    @router.get("/search")
    def search(q: str = Query("", max_length=200), user=Depends(principal)):
        return service.search(q)

    @router.get("/settings")
    def settings(user=Depends(principal)):
        client = service.render
        return {
            "version": "3",
            # 절대 경로 대신 작업 공간 이름만 노출한다(paths는 상대 경로).
            "workspace": service.root.name,
            "principal": user,
            "engine_version": ENGINE_VERSION,
            "renderer_version": RENDERER_VERSION,
            "render": {"mode": client.mode, "url": client.url or None, "concurrency": int(env("RENDER_CONCURRENCY", "1")), "queue": int(env("RENDER_QUEUE", "32"))},
            "reader": {
                "factory": env("READER_FACTORY", "") or None,
                "timeout_seconds": int(env("READER_TIMEOUT_SECONDS", "120")),
                "memory_mb": int(env("READER_MEMORY_MB", "1536")),
                "revision": env("READER_REVISION", "unversioned-operator-adapter"),
                # 설정 화면 Reader 카드의 보호 문서(DRM) 줄(§3.5·§6). 절대 경로는 싣지 않는다.
                "drm": drm.settings_snapshot(service.root),
            },
            "limits": {
                "page": 200,
                "body_bytes": BODY_LIMIT,
                "wait_seconds": MAX_WAIT,
                "window_rows": WINDOW_ROWS,
                "window_cols": WINDOW_COLS,
                "render_rows": 2000,
                "render_cols": 200,
                "register_files": 100,
                "register_directory_files": int(env("REGISTER_DIRECTORY_LIMIT", "10000")),
                "profile": dict(LIMITS),
            },
            "paths": {
                "database": str(service.db.path.relative_to(service.root)),
                "raw": "data/raw",
                "schemas": "schemas",
                "profiles": "profiles",
                "exports": "data/exports",
                "render_cache": "data/render-cache",
            },
        }

    @router.get("/normalization-presets")
    def normalization_presets(user=Depends(principal)):
        return presets(service.root)

    # ---- 문서 --------------------------------------------------------------------------
    @router.get("/sources")
    def sources(directory: str = Query("", max_length=1024), cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        raw = (service.root / "data/raw").resolve()
        folder = (raw / directory).resolve()
        if not folder.is_relative_to(raw) or not folder.is_dir():
            return {"items": [], "has_more": False, "next_cursor": None}
        scope = ["sources", directory]
        after = decode_cursor(cursor, scope, 1)

        def entries():
            with os.scandir(folder) as files:
                for n, item in enumerate(files):
                    if n > 50000:
                        raise Problem("DIRECTORY_LIMIT", "원본 폴더를 하위 폴더로 나누거나 경로를 직접 지정하세요.", 413)
                    if item.is_symlink() or (after and item.name <= after[0]):
                        continue
                    if item.is_dir() or Path(item.name).suffix.lower() in (".xlsx", ".xlsm", ".xls"):
                        yield {"name": item.name, "source_ref": str(Path(directory) / item.name), "directory": item.is_dir()}

        found = heapq.nsmallest(limit + 1, entries(), key=lambda r: r["name"])
        return page(found, limit, ["name"], scope)

    @router.get("/sources/scan")
    def sources_scan(directory: str = Query("", max_length=1024), user=Depends(principal)):
        """§4.1.1 폴더 일괄 등록 미리보기(재귀 스캔). Reader 프로세스를 띄우지 않는다."""
        return service.scan_sources(directory)

    @router.post("/documents/register-directory", response_model=JobResponse, status_code=202)
    def register_directory(body: RegisterDirectoryRequest, wait: float = Wait, user=Depends(principal)):
        """§4.1.1 폴더 아래 전부를 한 작업으로 등록한다(결과 summary + documents[≤500] + truncated)."""
        return job_response(service.register_directory(body.directory, body.provider, body.include_unchanged, user, wait))

    @router.post("/documents/register", response_model=JobResponse, status_code=202)
    def register(body: RegisterRequest, wait: float = Wait, user=Depends(principal)):
        if body.document_id and len(body.source_refs) != 1:
            raise Problem("ONE_DOCUMENT_REQUIRED", "기존 문서의 새 snapshot은 한 파일씩 등록하세요.")
        return job_response(service.register_documents(body.source_refs, body.provider, body.document_id, user, wait))

    @router.post("/documents/delete", response_model=JobResponse, status_code=202)
    def delete_documents(body: DocumentDeleteRequest, wait: float = Wait, user=Depends(principal)):
        """§4.13 다중 삭제(작업). 한 건이 실패해도 작업은 succeeded이고 요약이 결과물이다."""
        return job_response(service.delete_documents(body.document_ids, body.purge_source, user, wait))

    @router.delete("/documents/{document_id}")
    def delete_document(document_id: str, purge_source: bool = False, user=Depends(principal)):
        """§4.13 단건 삭제(동기). 없는 문서 404 UNKNOWN_DOCUMENT, 진행 중 작업이 있으면 409 DOCUMENT_BUSY."""
        return service.delete_document(document_id, purge_source, user)

    @router.get("/documents")
    def documents(
        q: str = Query("", max_length=200),
        status: Optional[DocumentStatus] = None,
        profile_id: Optional[str] = Query(None, max_length=64),
        schema_key: Optional[str] = Query(None, max_length=64),
        sort: DocumentSort = "-last_processed_at",
        cursor: Optional[str] = None,
        limit: int = Limit,
        user=Depends(principal),
    ):
        return service.document_query(q or None, status, profile_id, schema_key, sort, cursor, limit)

    @router.get("/documents/{document_id}")
    def document(document_id: str, user=Depends(principal)):
        return service.document(document_id)

    @router.get("/documents/{document_id}/snapshots")
    def document_snapshots(document_id: str, user=Depends(principal)):
        current = (service.document(document_id).get("current_snapshot") or {}).get("snapshot_id")
        items = [
            {
                "snapshot_id": s["snapshot_id"],
                "revision_no": s["revision_no"],
                "captured_at": s["captured_at"],
                "change_token": s["change_token"],
                "content_sha256": s["content_sha256"],
                "provider_version": s["provider_version"],
                "filename": s["filename"],
                "byte_size": s["byte_size"],
                "author": s["author"],
                "authored_at": s["authored_at"],
                "application_count": s["application_count"],
                "current": s["snapshot_id"] == current,
            }
            for s in service.document_snapshots(document_id)
        ]
        return {"items": items, "has_more": False, "next_cursor": None}

    @router.get("/snapshots/{snapshot_id}/sheets")
    def snapshot_sheets(snapshot_id: str, user=Depends(principal)):
        items = [
            {k: s[k] for k in ("sheet_id", "sheet_name", "ordinal", "visibility", "estimated_rows", "estimated_cols")}
            for s in service.snapshot_sheets(snapshot_id)
        ]
        return {"snapshot_id": snapshot_id, "items": items, "has_more": False, "next_cursor": None}

    @router.get("/snapshots/{snapshot_id}/applications")
    def snapshot_applications(snapshot_id: str, user=Depends(principal)):
        items = [
            {
                "application_id": a["application_id"],
                "profile": {"profile_id": a["profile_id"], "profile_name": a["profile_name"], "rev": a["profile_rev"], "status": a["profile_status"]},
                "schema": {"schema_key": a["schema_key"], "schema_name": a["schema_name"]},
                "origin": a["origin"],
                "compatibility": a["compatibility"],
                "state": a["state"],
                "published": a["published"],
                "heads_approved": a["heads_approved"] or 0,
                "heads_total": a["heads_total"] or 0,
                "last_run": a["last_run"],
                "last_error": a["last_error"],
                "is_reference": a["reference_application_id"] == a["application_id"],
                "created_at": a["created_at"],
            }
            for a in service.snapshot_applications(snapshot_id)
        ]
        return {"snapshot_id": snapshot_id, "items": items, "has_more": False, "next_cursor": None}

    @router.get("/snapshots/{snapshot_id}/values")
    def snapshot_values(
        snapshot_id: str,
        field_key: Optional[str] = Query(None, max_length=64),
        rule_key: Optional[str] = Query(None, max_length=128),
        cursor: Optional[str] = None,
        limit: int = Limit,
        user=Depends(principal),
    ):
        return service.snapshot_values(snapshot_id, field_key, rule_key, cursor, limit)

    @router.post("/snapshots/{snapshot_id}/applications", status_code=201)
    def apply_profile(snapshot_id: str, body: ApplicationRequest, wait: float = Wait, user=Depends(principal)):
        # 수동 적용은 Reader match 1회 뒤 바로 application을 만든다(작업 큐 없음) — wait와 무관하게 결과를 돌려준다.
        return service.apply_profile(snapshot_id, body.profile_id, body.sheet_bindings, user)

    # ---- 렌더 프록시(§5) -----------------------------------------------------------------------
    def render_response(result):
        status_code = result["http_status"]
        headers = {"Cache-Control": NO_CACHE}
        if result.get("etag"):
            headers["ETag"] = result["etag"]
        if status_code == 304:
            return Response(status_code=304, headers=headers)
        if status_code == 503:
            headers["Retry-After"] = "5"
        body = result["body"]
        # POST 의미의 요청은 {status:'cached', sheet: 창}으로 감싸 오지만 프록시는 창 JSON 자체를 돌려준다.
        if status_code == 200 and isinstance(body, dict) and body.get("status") == "cached" and isinstance(body.get("sheet"), dict):
            body = body["sheet"]
        return JSONResponse(body, status_code=status_code, headers=headers)

    @router.get("/snapshots/{snapshot_id}/sheets/{sheet_id}/render")
    def render_window(
        snapshot_id: str,
        sheet_id: str,
        range: Optional[str] = Query(None, max_length=40),
        if_none_match: Optional[str] = Header(None),
        user=Depends(principal),
    ):
        if not valid_id(snapshot_id) or not valid_id(sheet_id):
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        with service.db.connect() as conn:
            sheet = one(conn, "SELECT sheet_name FROM sheet WHERE sheet_id=? AND snapshot_id=?", (sheet_id, snapshot_id), "시트를 찾을 수 없습니다.")
        context = snapshot_context(service, snapshot_id)
        authorize(context, user, "view")
        try:
            result = service.render.request(
                snapshot_id, sheet_id, sheet["sheet_name"], context["provider"], context["source_path"], context["change_token"], user, range, if_none_match
            )
        except RenderUnavailable:
            return JSONResponse(
                {"error": {"code": "RENDER_UNAVAILABLE", "message": "렌더 서버에 연결할 수 없습니다."}}, status_code=503, headers={"Retry-After": "5", "Cache-Control": NO_CACHE}
            )
        return render_response(result)

    @router.get("/snapshots/{snapshot_id}/render-assets/{asset_id}")
    def render_asset(snapshot_id: str, asset_id: str, if_none_match: Optional[str] = Header(None), user=Depends(principal)):
        if not valid_id(snapshot_id) or not ASSET_RE.fullmatch(asset_id or ""):
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        context = snapshot_context(service, snapshot_id)
        authorize(context, user, "view")
        try:
            found = service.render.asset(snapshot_id, asset_id)
        except RenderUnavailable:
            return JSONResponse(
                {"error": {"code": "RENDER_UNAVAILABLE", "message": "렌더 서버에 연결할 수 없습니다."}}, status_code=503, headers={"Retry-After": "5", "Cache-Control": NO_CACHE}
            )
        if found is None:
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        data, media_type, etag = found
        etag = etag or f'"{asset_id}"'
        headers = {"Cache-Control": NO_CACHE, "ETag": etag}
        if if_none_match and etag in [t.strip() for t in if_none_match.split(",")]:
            return Response(status_code=304, headers=headers)
        chunk = 256 * 1024
        return StreamingResponse((data[i : i + chunk] for i in range(0, len(data), chunk)), media_type=media_type, headers=headers)

    # ---- 프로파일 -----------------------------------------------------------------------------
    @router.get("/profiles")
    def profiles(
        q: str = Query("", max_length=200),
        status: Optional[ProfileStatus] = None,
        schema_key: Optional[str] = Query(None, max_length=64),
        cursor: Optional[str] = None,
        limit: int = Limit,
        user=Depends(principal),
    ):
        return profile_list(service, q or None, status, schema_key, cursor, limit)

    @router.post("/profiles", status_code=201)
    def create_profile(body: ProfileCreateRequest, user=Depends(principal)):
        return service.import_profile(body.schema_key, body.definition, body.format, name=body.name, principal=user)

    @router.post("/profiles/import-preview")
    def import_preview(body: ImportPreviewRequest, user=Depends(principal)):
        return service.preview_profile(body.schema_key, body.definition, body.format)

    @router.get("/profiles/{profile_id}")
    def profile(profile_id: str, user=Depends(principal)):
        return profile_detail(service, profile_id)

    @router.put("/profiles/{profile_id}")
    def update_profile(profile_id: str, body: ProfileUpdateRequest, user=Depends(principal)):
        with service.db.connect() as conn:
            row = service._profile_row(conn, profile_id)
        declared = body.definition.get("schema_key") if isinstance(body.definition, dict) else None
        if declared not in (None, "", row["schema_key"]):
            raise Problem("SCHEMA_IMMUTABLE", "프로파일의 대상 스키마는 바꿀 수 없습니다.")
        return service.import_profile(row["schema_key"], body.definition, body.format, profile_id=profile_id, name=body.name, principal=user)

    @router.get("/profiles/{profile_id}/revisions")
    def profile_revisions(profile_id: str, user=Depends(principal)):
        with service.db.connect() as conn:
            row = service._profile_row(conn, profile_id)
        return _definition_revisions(service.root / "profiles" / profile_id, row["current_rev"], "rule_count")

    @router.get("/profiles/{profile_id}/revisions/{rev}")
    def profile_revision(profile_id: str, rev: int, user=Depends(principal)):
        with service.db.connect() as conn:
            row = service._profile_row(conn, profile_id)
        if not 1 <= rev <= row["current_rev"]:
            raise Problem("NOT_FOUND", "프로파일 리비전을 찾을 수 없습니다.", 404)
        return service.profile_canonical(profile_id, rev)

    @router.get("/profiles/{profile_id}/export")
    def profile_export(profile_id: str, user=Depends(principal)):
        with service.db.connect() as conn:
            row = service._profile_row(conn, profile_id)
        canonical = service.profile_canonical(profile_id, row["current_rev"])
        ascii_name = FILENAME_SAFE.sub("_", row["profile_name"]).strip("_") or "profile"
        filename = f"{ascii_name}-r{row['current_rev']}.json"
        utf8 = quote(f"{row['profile_name']}-r{row['current_rev']}.json")
        return JSONResponse(canonical, headers={"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{utf8}"})

    @router.post("/profiles/{profile_id}/test")
    def test_profile(profile_id: str, body: ProfileTestRequest, user=Depends(principal)):
        return service.test_profile(body.snapshot_id, profile_id=profile_id, principal=user)

    @router.post("/profiles/{profile_id}/approve")
    def approve_profile(profile_id: str, body: ProfileApproveRequest, user=Depends(principal)):
        return service.approve_profile(profile_id, body.application_id, user)

    @router.delete("/profiles/{profile_id}")
    def delete_profile(profile_id: str, user=Depends(principal)):
        """§4.2.1. 적용된 문서가 있으면 409 PROFILE_IN_USE(아무것도 지우지 않는다)."""
        return service.delete_profile(profile_id, user)

    @router.post("/profiles/{profile_id}/deprecate")
    def deprecate_profile(profile_id: str, user=Depends(principal)):
        """프로파일 폐기. 스키마 삭제(§4.2.1)를 막는 '쓰는 프로파일'에서 빠진다."""
        return service.deprecate_profile(profile_id, user)

    @router.post("/profiles/{profile_id}/reparse", response_model=JobResponse, status_code=202)
    def reparse(profile_id: str, body: ReparseRequest, wait: float = Wait, user=Depends(principal)):
        return job_response(service.reparse(profile_id, body.mode, user, wait))

    @router.get("/profiles/{profile_id}/documents")
    def profile_documents(profile_id: str, cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        return service.profile_documents(profile_id, cursor, limit)

    # ---- 스키마 -------------------------------------------------------------------------------
    @router.get("/schemas")
    def schemas(status: SchemaListStatus = "active", user=Depends(principal)):
        """§4.2.3 status=active(기본)|deprecated|all."""
        return schema_list(service, status)

    @router.post("/schemas", status_code=201)
    def create_schema(body: SchemaDefinitionRequest, user=Depends(principal)):
        """생성 전용(§4.2). 이미 있는 키는 409 SCHEMA_EXISTS로 거부하고 아무것도 쓰지 않는다."""
        return service.import_schema(body.definition, user, mode="create")

    @router.get("/schemas/{schema_key}")
    def schema(schema_key: str, user=Depends(principal)):
        return schema_detail(service, schema_key)

    @router.put("/schemas/{schema_key}")
    def update_schema(schema_key: str, body: SchemaDefinitionRequest, user=Depends(principal)):
        """새 리비전 전용(§4.2). 없는 키는 404, 본문 schema_key가 경로와 다르면 422."""
        declared = body.definition.get("schema_key") if isinstance(body.definition, dict) else None
        if declared != schema_key:
            raise Problem("SCHEMA_KEY_MISMATCH", "정의의 schema_key가 경로의 스키마와 다릅니다.")
        return service.import_schema(body.definition, user, mode="revision")

    @router.delete("/schemas/{schema_key}")
    def delete_schema(schema_key: str, user=Depends(principal)):
        """§4.2.1. 쓰는 프로파일·적용 건이 있으면 409 SCHEMA_IN_USE(아무것도 지우지 않는다)."""
        return service.delete_schema(schema_key, user)

    @router.post("/schemas/{schema_key}/deprecate")
    def deprecate_schema(schema_key: str, user=Depends(principal)):
        """§4.2.3. 응답은 GET /schemas/{key}와 같은 형태라 화면이 이 하나로 헤더·칩·버튼을 갱신한다."""
        service.deprecate_schema(schema_key, user)
        return schema_detail(service, schema_key)

    @router.post("/schemas/{schema_key}/activate")
    def activate_schema(schema_key: str, user=Depends(principal)):
        """§4.2.3 폐기 해제 — 되돌릴 수 있는 일이라 확인 없이 바로 부른다."""
        service.activate_schema(schema_key, user)
        return schema_detail(service, schema_key)

    @router.get("/schemas/{schema_key}/tree")
    def schema_tree_view(schema_key: str, user=Depends(principal)):
        return schema_tree(service, schema_key)

    @router.get("/schemas/{schema_key}/graph")
    def schema_graph_view(schema_key: str, user=Depends(principal)):
        return schema_graph(service, schema_key)

    @router.get("/schemas/{schema_key}/revisions")
    def schema_revisions(schema_key: str, user=Depends(principal)):
        with service.db.connect() as conn:
            row = _schema_row(conn, schema_key)
        return _definition_revisions(service.root / "schemas" / schema_key, row["current_rev"], "field_count")

    @router.get("/schemas/{schema_key}/revisions/{rev}")
    def schema_revision(schema_key: str, rev: int = FPath(ge=1), user=Depends(principal)):
        """그 리비전의 canonical 정의 JSON('새 리비전'·'이름 바꾸기' 대화상자가 현재 정의를 채울 때 쓴다).

        rev는 1부터다 — 0은 현재 정의로 넘어가지 않고 422로 거절한다(`rev or current_rev`의 0 함정)."""
        return service.schema_definition(schema_key, rev)

    @router.get("/schemas/{schema_key}/profiles")
    def schema_profiles_view(schema_key: str, field_key: Optional[str] = Query(None, max_length=64), user=Depends(principal)):
        return schema_profiles(service, schema_key, field_key)

    @router.get("/schemas/{schema_key}/documents")
    def schema_documents_view(
        schema_key: str, field_key: Optional[str] = Query(None, max_length=64), cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)
    ):
        return schema_documents(service, schema_key, field_key, cursor, limit)

    @router.post("/schemas/{schema_key}/fields", status_code=201)
    def create_field(schema_key: str, body: FieldCreateRequest, user=Depends(principal)):
        """필드 추가 = 새 리비전. 본문은 아래 GET·PATCH와 같은 필드 상세다."""
        service.create_field(
            schema_key, body.field_key, body.name, body.type, body.unit, body.description, body.aliases, body.parent_field_key, user
        )
        return field_detail(service, schema_key, body.field_key)

    @router.get("/schemas/{schema_key}/fields/{field_key}")
    def field(schema_key: str, field_key: str, user=Depends(principal)):
        return field_detail(service, schema_key, field_key)

    @router.patch("/schemas/{schema_key}/fields/{field_key}")
    def patch_field(schema_key: str, field_key: str, body: FieldPatchRequest, user=Depends(principal)):
        """필드 단건 편집 = 새 리비전 + projection. 화면이 이 응답만으로 갱신하도록 필드 상세를 돌려준다."""
        service.patch_field(schema_key, field_key, body.name, body.description, body.aliases, body.status)
        return field_detail(service, schema_key, field_key)

    @router.delete("/schemas/{schema_key}/fields/{field_key}")
    def delete_field(schema_key: str, field_key: str, user=Depends(principal)):
        """§4.2.2. 자식이 있으면 409 FIELD_HAS_CHILDREN, 규칙·매핑·추출값이 쓰면 409 FIELD_IN_USE."""
        return service.delete_field(schema_key, field_key, user)

    @router.get("/schemas/{schema_key}/fields/{field_key}/profiles")
    def field_profiles(schema_key: str, field_key: str, user=Depends(principal)):
        return schema_profiles(service, schema_key, field_key)

    @router.get("/schemas/{schema_key}/fields/{field_key}/documents")
    def field_documents(schema_key: str, field_key: str, cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        return schema_documents(service, schema_key, field_key, cursor, limit)

    @router.get("/schemas/{schema_key}/fields/{field_key}/values")
    def field_values_view(schema_key: str, field_key: str, limit: int = Query(20, ge=1, le=200), user=Depends(principal)):
        return field_values(service, schema_key, field_key, limit)

    # ---- 검수 ----------------------------------------------------------------------------------
    @router.get("/applications/{application_id}")
    def application(application_id: str, user=Depends(principal)):
        return service.application_summary(application_id)

    @router.get("/applications/{application_id}/mappings")
    def application_mappings(application_id: str, user=Depends(principal)):
        return {"items": service.application_mappings(application_id), "has_more": False, "next_cursor": None}

    @router.get("/applications/{application_id}/values")
    def application_values(
        application_id: str, rule_key: Optional[str] = Query(None, max_length=128), cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)
    ):
        return service.application_values(application_id, rule_key, cursor, limit)

    @router.post("/applications/{application_id}/approve-all")
    def approve_all(application_id: str, body: ApproveAllRequest, wait: float = Wait, user=Depends(principal)):
        return service.approve_all(application_id, body.reason, body.extract, user, wait)

    @router.post("/applications/{application_id}/extract", response_model=JobResponse, status_code=202)
    def extract(application_id: str, wait: float = Wait, user=Depends(principal)):
        return job_response(service.extract(application_id, user, wait))

    @router.get("/mappings/{mapping_id}")
    def mapping(mapping_id: str, user=Depends(principal)):
        return service.mapping(mapping_id)

    @router.get("/mappings/{mapping_id}/revisions")
    def mapping_revisions(mapping_id: str, user=Depends(principal)):
        return {"items": service.mapping_revisions(mapping_id), "has_more": False, "next_cursor": None}

    @router.post("/mappings/{mapping_id}/revisions", status_code=201)
    def revise(mapping_id: str, body: RevisionRequest, wait: float = Wait, user=Depends(principal)):
        regions = [r.model_dump() for r in body.regions] if body.regions is not None else None
        return service.revise(mapping_id, body.expected_seq, body.status, body.field_key, body.effective_spec, regions, body.reason, body.extract, user, wait)

    @router.post("/mappings/{mapping_id}/rollback", status_code=201)
    def rollback(mapping_id: str, body: RollbackRequest, user=Depends(principal)):
        return service.rollback(mapping_id, body.expected_seq, body.target_revision_id, body.reason, user)

    @router.get("/values/{value_id}")
    def value(value_id: str, user=Depends(principal)):
        return service.value(value_id)

    @router.get("/regions/{region_id}/values")
    def region_values(region_id: str, limit: int = Query(200, ge=1, le=500), user=Depends(principal)):
        return service.region_values(region_id, limit)

    @router.get("/sheets/{sheet_id}/regions")
    def sheet_regions(sheet_id: str, range: Optional[str] = Query(None, max_length=40), limit: int = Query(500, ge=1, le=2000), user=Depends(principal)):
        return service.sheet_regions(sheet_id, range, limit)

    # ---- 작업 ----------------------------------------------------------------------------------
    @router.get("/jobs")
    def jobs(state: Optional[JobState] = None, kind: Optional[JobKind] = None, cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        return jobs_list(service, state, kind, cursor, limit)

    @router.get("/jobs/{job_id}", response_model=JobResponse)
    def job(job_id: str, user=Depends(principal)):
        return service.jobs.get(job_id)

    @router.post("/jobs/{job_id}/cancel")
    def cancel(job_id: str, user=Depends(principal)):
        service.jobs.cancel(job_id)
        return {"job_id": job_id, "cancel_requested": True}

    # ---- 데이터 빌드(§4.10) ------------------------------------------------------------------
    def build_body(result):
        # 서버 파일 경로는 응답에 싣지 않는다(다운로드는 download_url로만).
        return {k: v for k, v in result.items() if k != "path"}

    @router.post("/builds/candidates")
    def build_candidates(body: BuildCandidatesRequest, user=Depends(principal)):
        return build_module.candidates(service, body.document_ids, body.schema_key)

    @router.post("/builds/preview")
    def build_preview(body: BuildPreviewRequest, user=Depends(principal)):
        return build_module.preview(service, body)

    @router.post("/builds")
    def build_export(body: BuildRequest, wait: float = Wait, user=Depends(principal)):
        result = build_module.build(service, body, user, wait)
        # 큰 입력은 작업으로 돌고, wait 안에 끝나지 않으면 manifest 없이 202(작업 내역에서 이어서 확인).
        pending = result.get("job") is not None and result.get("manifest") is None
        return JSONResponse(build_body(result), status_code=202 if pending else 200)

    @router.get("/builds/{build_key}/manifest")
    def build_manifest(build_key: str, user=Depends(principal)):
        return build_module.manifest(service, build_key)

    @router.get("/builds/{build_key}/download")
    def build_download(build_key: str, format: Optional[BuildFormat] = None, user=Depends(principal)):
        path, filename, media_type = build_module.output_path(service, build_key, format)
        utf8 = quote(filename)
        return FileResponse(
            path,
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{utf8}", "Cache-Control": "no-store"},
        )

    # ---- 검수 큐(§4.11) -----------------------------------------------------------------------
    def queue_kind(kind):
        if kind not in operations.KINDS:
            raise Problem("GROUP_NOT_FOUND", "그런 검수 큐가 없습니다.", 404)
        return kind

    @router.get("/queues")
    def queues(user=Depends(principal)):
        return operations.queues(service)

    @router.get("/queues/{kind}")
    def queue(kind: str, cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        return operations.queue(service, queue_kind(kind), cursor, limit)

    @router.get("/queues/{kind}/groups/{group_key}/members")
    def queue_members(kind: str, group_key: str, cursor: Optional[str] = None, limit: int = Limit, user=Depends(principal)):
        return operations.members(service, queue_kind(kind), group_key, cursor, limit)

    @router.post("/queues/{kind}/groups/{group_key}/actions", response_model=JobResponse, status_code=202)
    def queue_group_action(kind: str, group_key: str, body: QueueActionRequest, wait: float = Wait, user=Depends(principal)):
        job = operations.queue_action(
            service, queue_kind(kind), group_key, body.action, body.profile_id, body.sheet_bindings, body.extract, body.mode, user, wait
        )
        return job_response(job)

    app.include_router(router)
    previous_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with previous_lifespan(application) as state:
            if start_worker:
                service.jobs.start()
            try:
                # 동기 핸들러가 ?wait=로 스레드를 오래 잡아도 다른 요청이 굶지 않도록 스레드 풀을 넓힌다(기본 40).
                import anyio

                limiter = anyio.to_thread.current_default_thread_limiter()
                if limiter.total_tokens < THREAD_POOL_TOKENS:
                    limiter.total_tokens = THREAD_POOL_TOKENS
            except Exception:  # pragma: no cover - anyio 버전 차이
                pass
            try:
                yield state
            finally:
                service.close()

    app.router.lifespan_context = lifespan
    return service


class SpaStaticFiles(StaticFiles):
    """확장자 없는 경로(화면 라우트)는 index.html로 돌린다(SPA fallback); 파일 경로의 404는 그대로."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except Exception as exc:  # StaticFiles는 HTTPException(404)을 던진다
            # API 경로의 404는 JSON 그대로 두고, 화면 라우트(확장자 없음)만 index.html로 돌린다.
            if getattr(exc, "status_code", None) == 404 and "." not in Path(path).name and not path.lstrip("/").startswith("api/"):
                return await super().get_response("index.html", scope)
            raise


def create_app(root, start_worker=True):
    app = FastAPI(title="Semantic Excel Integration")
    install(app, root, start_worker)
    dist = Path(__file__).resolve().parents[1] / "frontend/dist"
    if dist.is_dir():
        app.mount("/", SpaStaticFiles(directory=dist, html=True), name="static")
    return app
