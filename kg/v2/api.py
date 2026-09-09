"""유한 범위 조회와 비동기 작업으로 제공하는 v2 API. 기본 배포는 로컬 단일 사용자다."""

from __future__ import annotations

import heapq
import csv
import io
from datetime import date
from typing import Literal
import hmac
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles

from .contracts import (
    RegisterRequest,
    ViewportRequest,
    JobRequest,
    JobResponse,
    KGRequest,
    TemplateRequest,
    ApplicationRequest,
    RevisionRequest,
    IntegrationRequest,
    RollbackRequest,
    ConceptEditRequest,
    FromSuggestionRequest,
)
from .build import authorize_build, create_integration, output_path, prepare_build
from .db import Problem, decode_cursor, dump, norm, one, page
from .features import document_query, selection_cte, rollback, edit_concept
from .service import Service
from .spec import address, bounds
from .suggest import list_suggestions, store_signature, transplant


def install(app: FastAPI, root, start_worker=True):
    service = Service(root)
    app.state.v2 = service
    router = APIRouter(prefix="/api/v2")

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, exc: Problem):
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message}},
            status_code=exc.status,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        errors = [
            {"field": ".".join(map(str, e["loc"])), "message": e["msg"]}
            for e in exc.errors()
        ]
        code, status = "VALIDATION_ERROR", 422
        if any(e["loc"][-1] == "request_key" for e in exc.errors()):
            code = "REQUEST_KEY_REQUIRED"
        if request.url.path == "/api/v2/viewports" and any(
            e["loc"][-1] in ("rows", "cols", "r1", "c1") for e in exc.errors()
        ):
            code, status = "VIEWPORT_LIMIT", 413
        return JSONResponse(
            {
                "error": {
                    "code": code,
                    "message": "; ".join(
                        e["field"] + ": " + e["message"] for e in errors
                    ),
                    "fields": errors,
                }
            },
            status_code=status,
        )

    @app.middleware("http")
    async def bounded_request(request: Request, call_next):
        if request.url.path.startswith("/api/v2/"):
            if request.method in ("POST", "PUT", "PATCH"):
                data = bytearray()
                async for chunk in request.stream():
                    data.extend(chunk)
                    if len(data) > 2 * 1024 * 1024:
                        return JSONResponse(
                            {
                                "error": {
                                    "code": "BODY_LIMIT",
                                    "message": "요청 본문은 2MB 이하여야 합니다.",
                                }
                            },
                            status_code=413,
                        )
                request._body = bytes(data)
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        return await call_next(request)

    def principal(authorization: str | None = Header(None)):
        token = os.environ.get("KG_V2_ACCESS_TOKEN")
        if token and not hmac.compare_digest(authorization or "", "Bearer " + token):
            raise Problem("AUTH_REQUIRED", "서버 접근 토큰이 필요합니다.", 401)
        # 클라이언트가 임의 사용자 이름을 전달해 권한을 바꾸지 못하게 한다.
        return os.environ.get("KG_V2_PRINCIPAL", "local-user")

    def listing(sql, params, scope, keys, cursor, limit, descending=False):
        values = decode_cursor(cursor, scope, len(keys))
        if values:
            sql += (
                " AND ("
                + ",".join(keys)
                + ") "
                + ("<" if descending else ">")
                + " ("
                + ",".join("?" for _ in keys)
                + ")"
            )
            params = (*params, *values)
        sql += (
            " ORDER BY "
            + ",".join(k + (" DESC" if descending else " ASC") for k in keys)
            + " LIMIT ?"
        )
        with service.db.connect() as conn:
            return page(
                conn.execute(sql, (*params, limit + 1)),
                limit,
                [k.split(".")[-1] for k in keys],
                scope,
            )

    def submit(kind, body, user, prepare=None):
        payload = dict(body)
        request_key = payload.pop("request_key", None)
        try:
            return service.jobs.submit(kind, payload, user, request_key, prepare)
        except sqlite3.IntegrityError:
            raise Problem(
                "INTEGRITY_CONFLICT",
                "같은 항목이 이미 있거나 버전·출처 관계가 유효하지 않습니다.",
                409,
            ) from None

    def safe_write(function, *args, **kwargs):
        try:
            return function(*args, **kwargs)
        except sqlite3.IntegrityError:
            raise Problem(
                "INTEGRITY_CONFLICT",
                "중복 ID 또는 올바르지 않은 버전·개념 연결이 있습니다.",
                409,
            ) from None
        except (KeyError, TypeError, ValueError, AttributeError):
            raise Problem(
                "INVALID_DEFINITION", "필수 항목과 정의 형식을 확인하세요."
            ) from None

    @router.get("/status")
    def status(user=Depends(principal)):
        return {
            "schema_version": 2,
            "engine": "data-gathering-v2.0",
            "principal": user,
            "reader_configured": bool(os.environ.get("KG_V2_READER_FACTORY")),
            "limits": {"page": 100, "viewport_rows": 100, "viewport_cols": 30},
            "local_reader_fidelity": "simplified",
            "worker": "single-process",
        }

    @router.get("/sources")
    def sources(
        directory: str = "",
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
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
                        raise Problem(
                            "DIRECTORY_LIMIT",
                            "원본 폴더를 하위 폴더로 나누거나 경로를 직접 지정하세요.",
                            413,
                        )
                    if item.is_symlink() or after and item.name <= after[0]:
                        continue
                    if item.is_dir() or Path(item.name).suffix.lower() in (
                        ".xlsx",
                        ".xlsm",
                        ".xls",
                    ):
                        yield {
                            "name": item.name,
                            "source_ref": str(Path(directory) / item.name),
                            "directory": item.is_dir(),
                        }

        rows = heapq.nsmallest(limit + 1, entries(), key=lambda r: r["name"])
        return page(rows, limit, ["name"], scope)

    @router.post("/documents/register", status_code=202, response_model=JobResponse)
    def register(body: RegisterRequest, user=Depends(principal)):
        body = body.payload()
        refs = body.get("source_refs")
        if (
            not isinstance(refs, list)
            or not 1 <= len(refs) <= 100
            or any(not isinstance(r, str) or not r or len(r) > 2048 for r in refs)
        ):
            raise Problem("INVALID_SOURCES", "원본 참조를 1~100개 지정하세요.")
        if body.get("document_id") and len(refs) != 1:
            raise Problem(
                "ONE_DOCUMENT_REQUIRED", "기존 문서의 새 버전은 한 파일씩 등록하세요."
            )
        if not isinstance(body.get("provider", "local-xlsx"), str):
            raise Problem("INVALID_PROVIDER", "제공자 이름을 지정하세요.")
        return submit("register", body, user)

    @router.get("/documents")
    def documents(
        q: str = Query("", max_length=200),
        author: str = Query("", max_length=200),
        date_from: date | None = None,
        date_to: date | None = None,
        access_status: Literal["", "unknown", "allowed", "denied", "expired"] = "",
        extraction_status: Literal[
            "", "unassigned", "review", "pending", "published", "failed"
        ] = "",
        template: str = Query("", max_length=200),
        sort: Literal["name", "author", "authored_at", "registered_at"] = "name",
        direction: Literal["asc", "desc"] = "asc",
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        if date_from and date_to and date_from > date_to:
            raise Problem("INVALID_DATE_RANGE", "시작일은 종료일 이전이어야 합니다.")
        sql, params = document_query(
            user,
            q,
            author,
            date_from,
            date_to,
            access_status,
            extraction_status,
            template,
            sort,
        )
        return listing(
            sql,
            params,
            [
                "documents",
                user,
                q,
                author,
                str(date_from),
                str(date_to),
                access_status,
                extraction_status,
                template,
                sort,
                direction,
            ],
            ["sort_value", "document_id"],
            cursor,
            limit,
            direction == "desc",
        )

    @router.get("/documents/{doc_id}/versions")
    def versions(
        doc_id: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT document_version_id,document_id,revision_no,filename,author,authored_at,byte_size,captured_at FROM document_version WHERE document_id=?",
            (doc_id,),
            ["versions", doc_id],
            ["revision_no"],
            cursor,
            limit,
        )

    @router.get("/versions/{vid}/sheets")
    def sheets(
        vid: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT * FROM sheet WHERE document_version_id=?",
            (vid,),
            ["sheets", vid],
            ["ordinal"],
            cursor,
            limit,
        )

    @router.get("/versions/{vid}/access")
    def access(vid: str, user=Depends(principal)):
        _, caps = service.authorize(vid, user)
        return caps

    @router.post("/viewports", status_code=202, response_model=JobResponse)
    def viewport(body: ViewportRequest, user=Depends(principal)):
        body = body.payload()
        for key, default, minimum, maximum in (
            ("r1", 1, 1, 1048576),
            ("c1", 1, 1, 16384),
            ("rows", 40, 1, 100),
            ("cols", 12, 1, 30),
        ):
            value = body.setdefault(key, default)
            if type(value) is not int or not minimum <= value <= maximum:
                raise Problem(
                    "VIEWPORT_LIMIT", "표시 범위는 100행·30열 이내로 지정하세요.", 413
                )
        bounds(
            address(
                body["r1"],
                body["c1"],
                body["r1"] + body["rows"] - 1,
                body["c1"] + body["cols"] - 1,
            )
        )
        if not body.get("version_id") or not body.get("sheet_id"):
            raise Problem("SHEET_REQUIRED", "문서 버전과 시트를 선택하세요.")
        return submit("viewport", body, user)

    @router.get("/jobs/{jid}", response_model=JobResponse)
    def job(jid: str, user=Depends(principal)):
        result = service.jobs.get(jid, user)
        if result["kind"] == "viewport" and result["result"]:
            service.authorize(result["result"]["version_id"], user, "render")
        if result["kind"] == "build" and result["result"]:
            authorize_build(service, result["result"]["build_id"], user)
        return result

    @router.post("/jobs/{jid}/cancel")
    def cancel(jid: str, user=Depends(principal)):
        service.jobs.cancel(jid, user)
        return {"cancel_requested": True}

    @router.get("/kg/revisions")
    def kg_revisions(
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT * FROM kg_revision WHERE 1=1",
            (),
            ["kg"],
            ["revision_no"],
            cursor,
            limit,
        )

    @router.post("/kg/import")
    def kg_import(body: KGRequest, user=Depends(principal)):
        body = body.payload()
        return safe_write(service.import_kg, body, user)

    @router.post("/kg/import-current")
    def kg_current(user=Depends(principal)):
        return safe_write(service.import_current_kg, user)

    @router.get("/kg/{kg}/concepts")
    def concepts(
        kg: str,
        q: str = Query("", max_length=200),
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT c.* FROM domain_concept c WHERE c.kg_revision_id=? AND (c.name LIKE ? OR c.concept_id LIKE ? OR EXISTS (SELECT 1 FROM domain_alias a WHERE a.kg_revision_id=c.kg_revision_id AND a.concept_id=c.concept_id AND a.alias_norm LIKE ?))",
            (kg, "%" + q + "%", "%" + q + "%", "%" + norm(q) + "%"),
            ["concepts", kg, q],
            ["c.concept_id"],
            cursor,
            limit,
        )

    @router.get("/kg/{kg}/concepts/{cid}/relations")
    def relations(
        kg: str,
        cid: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT * FROM domain_edge WHERE kg_revision_id=? AND (from_concept_id=? OR to_concept_id=?)",
            (kg, cid, cid),
            ["edges", kg, cid],
            ["from_concept_id", "to_concept_id", "relation_type"],
            cursor,
            limit,
        )

    @router.get("/kg/{kg}/aliases")
    def aliases(
        kg: str,
        text: str = Query(..., max_length=200),
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT a.*,c.name FROM domain_alias a JOIN domain_concept c USING(kg_revision_id,concept_id) WHERE a.kg_revision_id=? AND a.alias_norm=?",
            (kg, norm(text)),
            ["aliases", kg, norm(text)],
            ["a.concept_id", "a.context_key"],
            cursor,
            limit,
        )

    @router.get("/templates")
    def templates(
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT t.*,v.template_version_id,v.revision_no,v.kg_revision_id FROM template t JOIN template_version v USING(template_id) WHERE v.revision_no=(SELECT max(revision_no) FROM template_version x WHERE x.template_id=t.template_id)",
            (),
            ["templates"],
            ["t.template_id"],
            cursor,
            limit,
        )

    @router.post("/templates")
    def template_create(body: TemplateRequest, user=Depends(principal)):
        body = body.payload()
        return safe_write(
            service.create_template,
            body.get("name"),
            body.get("definition"),
            user,
            body.get("template_id"),
        )

    @router.get("/templates/{tid}/versions")
    def template_versions(
        tid: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT template_version_id,template_id,revision_no,kg_revision_id,created_at FROM template_version WHERE template_id=?",
            (tid,),
            ["template-versions", tid],
            ["revision_no"],
            cursor,
            limit,
        )

    @router.get("/template-versions/{tid}")
    def template_detail(tid: str, user=Depends(principal)):
        with service.db.connect() as conn:
            result = one(
                conn,
                "SELECT * FROM template_version WHERE template_version_id=?",
                (tid,),
            )
        result["definition"] = json.loads(result.pop("definition_json"))
        return result

    @router.post("/applications")
    def application_create(body: ApplicationRequest, user=Depends(principal)):
        body = body.payload()
        service.authorize(body.get("version_id"), user)
        return safe_write(
            service.apply_template,
            body.get("version_id"),
            body.get("template_version_id"),
            body.get("bindings", {}),
            body.get("scope_key"),
            body.get("approved", False) is True,
            user,
        )

    @router.get("/applications")
    def applications(
        version_id: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT a.*,t.name,v.kg_revision_id,v.revision_no FROM template_application a JOIN template_version v USING(template_version_id) JOIN template t USING(template_id) WHERE a.document_version_id=?",
            (version_id,),
            ["applications", version_id],
            ["a.application_id"],
            cursor,
            limit,
        )

    @router.get("/applications/{aid}")
    def application(aid: str, user=Depends(principal)):
        with service.db.connect() as conn:
            result = one(
                conn,
                "SELECT a.*,v.kg_revision_id,v.definition_json,t.name FROM template_application a JOIN template_version v USING(template_version_id) JOIN template t USING(template_id) WHERE application_id=?",
                (aid,),
            )
            result["bindings"] = [
                dict(r)
                for r in conn.execute(
                    "SELECT a.*,s.name FROM application_sheet a JOIN sheet s USING(sheet_id) WHERE application_id=? ORDER BY role_key,ordinal",
                    (aid,),
                )
            ]
        service.authorize(result["document_version_id"], user)
        result["definition"] = json.loads(result.pop("definition_json"))
        return result

    @router.get("/applications/{aid}/mappings")
    def mappings(
        aid: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        with service.db.connect() as conn:
            v = one(
                conn,
                "SELECT document_version_id FROM template_application WHERE application_id=?",
                (aid,),
            )
        service.authorize(v["document_version_id"], user)
        return listing(
            "SELECT m.mapping_revision_id,m.rule_key,m.revision_no,m.status,m.concept_id,m.created_at,coalesce(h.edit_seq,0) edit_seq FROM mapping_revision m LEFT JOIN mapping_head h ON h.application_id=m.application_id AND h.rule_key=m.rule_key WHERE m.application_id=? AND m.revision_no=(SELECT max(revision_no) FROM mapping_revision x WHERE x.application_id=m.application_id AND x.rule_key=m.rule_key)",
            (aid,),
            ["mappings", aid],
            ["m.rule_key"],
            cursor,
            limit,
        )

    @router.get("/mappings/{mid}")
    def mapping(mid: str, user=Depends(principal)):
        result = service.mapping(mid)
        service.authorize(result["document_version_id"], user)
        return result

    @router.post("/applications/{aid}/mappings/{mid}/revisions")
    def revise(aid: str, mid: str, body: RevisionRequest, user=Depends(principal)):
        body = body.payload()
        previous = service.mapping(mid)
        service.authorize(previous["document_version_id"], user)
        return safe_write(
            service.revise,
            aid,
            mid,
            body.get("expected_seq"),
            body.get("effective_spec"),
            body.get("concept_id"),
            body.get("status", "approved"),
            body.get("reason"),
            user,
        )

    @router.post(
        "/applications/{aid}/extract", status_code=202, response_model=JobResponse
    )
    def extract(aid: str, body: JobRequest, user=Depends(principal)):
        body = body.payload()
        return submit(
            "extract",
            {"application_id": aid, "request_key": body.get("request_key")},
            user,
            service.prepare_extraction,
        )

    @router.get("/series")
    def series(
        run_id: str | None = None,
        concept_id: str | None = None,
        kg_revision_id: str | None = None,
        roots: list[str] = Query([]),
        excluded: list[str] = Query([]),
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        sql = "SELECT s.*,m.concept_id,m.rule_key,m.application_id,m.kg_revision_id,(SELECT c.name FROM domain_concept c WHERE c.kg_revision_id=m.kg_revision_id AND c.concept_id=m.concept_id) concept_name,json_extract(m.effective_spec_json,'$.value_spec.type') target_type,(SELECT i.unit_normalized FROM extracted_item i WHERE i.series_id=s.series_id ORDER BY i.item_index LIMIT 1) target_unit FROM extracted_series s JOIN mapping_revision m USING(mapping_revision_id) JOIN template_application a USING(application_id) JOIN document_version v ON v.document_version_id=s.document_version_id JOIN document d USING(document_id) WHERE "
        if run_id:
            sql += "s.run_id=? AND EXISTS(SELECT 1 FROM extraction_run e WHERE e.run_id=s.run_id AND e.status='succeeded')"
            params = (run_id,)
        elif roots:
            cte, selected_params = selection_cte(kg_revision_id, roots, excluded)
            sql = (
                cte
                + sql
                + "s.run_id=a.published_run_id AND d.current_version_id=s.document_version_id AND m.kg_revision_id=? AND m.concept_id IN(SELECT id FROM selected)"
            )
            params = (*selected_params, kg_revision_id)
        else:
            sql += "s.run_id=a.published_run_id AND d.current_version_id=s.document_version_id AND m.concept_id=? AND m.kg_revision_id=?"
            params = (concept_id, kg_revision_id)
        result = listing(
            sql,
            params,
            ["series", run_id, concept_id, kg_revision_id, roots, excluded],
            ["s.series_id"],
            cursor,
            limit,
        )
        for vid in {r["document_version_id"] for r in result["items"]}:
            service.authorize(vid, user)
        return result

    @router.get("/series/{sid}/items")
    def items(
        sid: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        with service.db.connect() as conn:
            s = one(
                conn,
                "SELECT s.* FROM extracted_series s JOIN extraction_run r USING(run_id) WHERE s.series_id=? AND r.status='succeeded'",
                (sid,),
            )
        service.authorize(s["document_version_id"], user)
        return listing(
            "SELECT item_id,series_id,item_index,substr(record_key,1,256) record_key,value_type,substr(value_text,1,2048) value_text,value_state,substr(display_text,1,2048) display_text,unit_normalized,formula_state,length(value_text)>2048 preview_truncated FROM extracted_item WHERE series_id=?",
            (sid,),
            ["items", sid],
            ["item_index"],
            cursor,
            limit,
        )

    @router.get("/series/{sid}/regions")
    def series_regions(
        sid: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        with service.db.connect() as conn:
            s = one(conn, "SELECT * FROM extracted_series WHERE series_id=?", (sid,))
        service.authorize(s["document_version_id"], user)
        return listing(
            "SELECT r.*,x.role,x.ordinal,s.name FROM series_region x JOIN source_region r USING(region_id) JOIN sheet s USING(sheet_id) WHERE x.series_id=?",
            (sid,),
            ["series-regions", sid],
            ["x.role", "x.ordinal"],
            cursor,
            limit,
        )

    @router.get("/items/{iid}/regions")
    def item_regions(
        iid: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        with service.db.connect() as conn:
            i = one(
                conn,
                "SELECT i.* FROM extracted_item i JOIN extracted_series s USING(series_id) JOIN extraction_run r USING(run_id) WHERE item_id=? AND r.status='succeeded'",
                (iid,),
            )
        service.authorize(i["document_version_id"], user)
        return listing(
            "SELECT r.*,x.role,x.ordinal,s.name FROM item_region x JOIN source_region r USING(region_id) JOIN sheet s USING(sheet_id) WHERE x.item_id=?",
            (iid,),
            ["item-regions", iid],
            ["x.role", "x.ordinal"],
            cursor,
            limit,
        )

    @router.get("/items/{iid}")
    def item_detail(iid: str, user=Depends(principal)):
        with service.db.connect() as conn:
            result = one(
                conn,
                "SELECT i.item_id,i.series_id,i.document_version_id,s.mapping_revision_id,m.application_id,v.document_id FROM extracted_item i JOIN extracted_series s USING(series_id) JOIN mapping_revision m USING(mapping_revision_id) JOIN document_version v ON v.document_version_id=i.document_version_id JOIN extraction_run r USING(run_id) WHERE i.item_id=? AND r.status='succeeded'",
                (iid,),
            )
        service.authorize(result["document_version_id"], user)
        return result

    @router.post("/integrations")
    def integration_create(body: IntegrationRequest, user=Depends(principal)):
        body = body.payload()
        return safe_write(
            create_integration,
            service,
            body.get("name"),
            body.get("spec"),
            user,
            body.get("project_id"),
        )

    @router.get("/integrations")
    def integrations(
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT p.*,v.integration_version_id,v.revision_no FROM integration_project p JOIN integration_version v USING(project_id) WHERE v.revision_no=(SELECT max(revision_no) FROM integration_version x WHERE x.project_id=p.project_id)",
            (),
            ["integrations"],
            ["p.project_id"],
            cursor,
            limit,
        )

    @router.post(
        "/integrations/{vid}/build", status_code=202, response_model=JobResponse
    )
    def build(vid: str, body: JobRequest, user=Depends(principal)):
        body = body.payload()
        return submit(
            "build",
            {"integration_version_id": vid, "request_key": body.get("request_key")},
            user,
            prepare_build,
        )

    @router.get("/builds")
    def builds(
        integration_version_id: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        return listing(
            "SELECT build_id,integration_version_id,status,row_count,created_at,finished_at FROM build_run WHERE integration_version_id=?",
            (integration_version_id,),
            ["builds", integration_version_id],
            ["created_at", "build_id"],
            cursor,
            limit,
        )

    @router.get("/builds/{bid}/rows")
    def build_rows(
        bid: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        authorize_build(service, bid, user)
        path = output_path(service, bid)
        scope = ["build-rows", bid]
        values = decode_cursor(cursor, scope, 1)
        with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            fields = [dict(r) for r in conn.execute("SELECT * FROM _field_schema")]
            limit = min(limit, max(1, 3000 // len(fields)))
            quote = lambda value: '"' + value.replace('"', '""') + '"'
            preview = ",".join(
                "substr("
                + quote(f["output_name"])
                + ",1,256) AS "
                + quote(f["output_name"])
                for f in fields
            )
            result = page(
                conn.execute(
                    "SELECT _row_no,_row_key,"
                    + (
                        "_record_key,"
                        if any(
                            r[1] == "_record_key"
                            for r in conn.execute("PRAGMA table_info(data)")
                        )
                        else "NULL _record_key,"
                    )
                    + preview
                    + " FROM data WHERE _row_no>? ORDER BY _row_no LIMIT ?",
                    ((values or [0])[0], limit + 1),
                ),
                limit,
                ["_row_no"],
                scope,
            )
            result["fields"] = fields
            result["preview_char_limit"] = 256
        return result

    @router.get("/builds/{bid}/lineage")
    def lineage(
        bid: str,
        row_key: str,
        field_key: str,
        cursor: str | None = None,
        limit: int = Query(50, ge=1, le=100),
        user=Depends(principal),
    ):
        authorize_build(service, bid, user)
        return listing(
            "SELECT * FROM build_lineage WHERE build_id=? AND output_row_key=? AND field_key=?",
            (bid, row_key, field_key),
            ["lineage", bid, row_key, field_key],
            ["ordinal"],
            cursor,
            limit,
        )

    @router.get("/builds/{bid}/download")
    def download(
        bid: str, format: Literal["sqlite", "csv"] = "sqlite", user=Depends(principal)
    ):
        authorize_build(service, bid, user)
        path = output_path(service, bid)
        if format == "csv":

            def stream():
                with sqlite3.connect(
                    f"file:{path.as_posix()}?mode=ro", uri=True
                ) as conn:
                    rows = conn.execute("SELECT * FROM data ORDER BY _row_no")
                    buffer = io.StringIO()
                    writer = csv.writer(buffer)
                    yield "\ufeff"
                    writer.writerow([c[0] for c in rows.description])
                    yield buffer.getvalue()
                    buffer.seek(0)
                    buffer.truncate(0)
                    for row in rows:
                        writer.writerow(row)
                        yield buffer.getvalue()
                        buffer.seek(0)
                        buffer.truncate(0)

            return StreamingResponse(
                stream(),
                media_type="text/csv; charset=utf-8",
                headers={
                    "Content-Disposition": f'attachment; filename="custom-db-{bid}.csv"'
                },
            )
        return FileResponse(
            path,
            filename="custom-db-" + bid + ".sqlite",
            media_type="application/vnd.sqlite3",
        )

    @router.get("/review-queue")
    def review_queue(
        q: str = Query("", max_length=200),
        status: Literal["proposed", "approved", "rejected", "all"] = "proposed",
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        sql = """SELECT m.mapping_revision_id,m.application_id,m.document_version_id,m.rule_key,m.status,m.revision_no,m.created_at,
                 d.document_id,d.display_name,t.name template_name,coalesce(h.edit_seq,0) edit_seq
                 FROM mapping_revision m JOIN document_version v USING(document_version_id) JOIN document d USING(document_id)
                 JOIN template_version tv USING(template_version_id) JOIN template t USING(template_id)
                 LEFT JOIN mapping_head h ON h.application_id=m.application_id AND h.rule_key=m.rule_key
                 WHERE d.current_version_id=m.document_version_id AND m.revision_no=(SELECT max(x.revision_no) FROM mapping_revision x WHERE x.application_id=m.application_id AND x.rule_key=m.rule_key)
                 AND (d.display_name LIKE ? OR m.rule_key LIKE ?)"""
        params = ("%" + q + "%", "%" + q + "%")
        if status != "all":
            sql += " AND m.status=?"
            params += (status,)
        result = listing(
            sql,
            params,
            ["review", q, status],
            ["m.created_at", "m.mapping_revision_id"],
            cursor,
            limit,
        )
        for vid in {r["document_version_id"] for r in result["items"]}:
            service.authorize(vid, user)
        return result

    @router.get("/normalization-presets")
    def normalization_presets(user=Depends(principal)):
        from .normalization import presets

        return presets(service.root)

    @router.get("/applications/{aid}/rules/{rule_key}/revisions")
    def history(
        aid: str,
        rule_key: str,
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        application(aid, user)
        return listing(
            "SELECT mapping_revision_id,revision_no,status,concept_id,reason,created_by,created_at FROM mapping_revision WHERE application_id=? AND rule_key=?",
            (aid, rule_key),
            ["history", aid, rule_key],
            ["revision_no"],
            cursor,
            limit,
            True,
        )

    @router.post("/applications/{aid}/mappings/{mid}/rollback")
    def restore(aid: str, mid: str, body: RollbackRequest, user=Depends(principal)):
        previous = service.mapping(mid)
        service.authorize(previous["document_version_id"], user)
        return safe_write(rollback, service, aid, mid, body.payload(), user)

    @router.get("/kg/{kg}/tree")
    def tree(
        kg: str,
        parent_id: str = "",
        roots: list[str] = Query([]),
        excluded: list[str] = Query([]),
        cursor: str | None = None,
        limit: int = Query(30, ge=1, le=100),
        user=Depends(principal),
    ):
        sql = """SELECT c.*,(SELECT count(*) FROM domain_edge e WHERE e.kg_revision_id=c.kg_revision_id AND e.from_concept_id=c.concept_id AND e.relation_type='parent_of') child_count
                 FROM domain_concept c WHERE c.kg_revision_id=? AND c.status='active' AND """
        params = (kg,)
        if parent_id:
            sql += "EXISTS(SELECT 1 FROM domain_edge e WHERE e.kg_revision_id=c.kg_revision_id AND e.to_concept_id=c.concept_id AND e.from_concept_id=? AND e.relation_type='parent_of')"
            params += (parent_id,)
        else:
            sql += "NOT EXISTS(SELECT 1 FROM domain_edge e WHERE e.kg_revision_id=c.kg_revision_id AND e.to_concept_id=c.concept_id AND e.relation_type='parent_of')"
        result = listing(
            sql,
            params,
            # 선택은 체크 표시만 바꾼다. 목록 필터(부모/KG)가 같으면 커서를 유지한다.
            ["tree", kg, parent_id],
            ["c.concept_id"],
            cursor,
            limit,
        )
        cte, values = selection_cte(kg, roots, excluded)
        with service.db.connect() as conn:
            # 페이지에 표시한 노드에만 하위 선택 상태를 계산한다.
            for node in result["items"]:
                sql = (
                    cte
                    + ", subtree(id) AS (SELECT ? UNION SELECT e.to_concept_id FROM domain_edge e JOIN subtree t ON t.id=e.from_concept_id WHERE e.kg_revision_id=? AND e.relation_type='parent_of') SELECT count(*) total,sum(concept_id IN(SELECT id FROM selected)) chosen FROM domain_concept WHERE kg_revision_id=? AND status='active' AND concept_id IN(SELECT id FROM subtree)"
                )
                counts = conn.execute(
                    sql, (*values, node["concept_id"], kg, kg)
                ).fetchone()
                node["checked"] = bool(
                    counts["total"] and counts["chosen"] == counts["total"]
                )
                node["indeterminate"] = bool(
                    counts["chosen"] and counts["chosen"] < counts["total"]
                )
                candidates = list(dict.fromkeys([*roots, *excluded]))
                node["descendant_selections"] = [
                    r[0]
                    for r in conn.execute(
                        "WITH RECURSIVE subtree(id) AS (SELECT ? UNION SELECT e.to_concept_id FROM domain_edge e JOIN subtree t ON t.id=e.from_concept_id WHERE e.kg_revision_id=? AND e.relation_type='parent_of') SELECT id FROM subtree WHERE id IN ("
                        + (",".join("?" for _ in candidates) or "NULL")
                        + ")",
                        (node["concept_id"], kg, *candidates),
                    )
                ]
        return result

    @router.post("/kg/{kg}/concepts/{cid}/revisions")
    def concept_revision(
        kg: str, cid: str, body: ConceptEditRequest, user=Depends(principal)
    ):
        return safe_write(edit_concept, service, kg, cid, body.payload(), user)

    @router.get("/template-versions/{tid}/download")
    def template_export(tid: str, user=Depends(principal)):
        result = template_detail(tid, user)
        return JSONResponse(
            result["definition"],
            headers={
                "Content-Disposition": f'attachment; filename="template-{tid}.json"'
            },
        )

    @router.get("/versions/{vid}/suggestions")
    def suggestions(
        vid: str,
        threshold: float = Query(0.5, ge=0.0, le=1.0),
        limit: int = Query(10, ge=1, le=100),
        user=Depends(principal),
    ):
        # 메타데이터와 캐시된 서명만 비교한다. 후보 원본은 열지 않는다.
        return list_suggestions(service, vid, threshold, limit)

    @router.post("/versions/{vid}/signature")
    def signature(vid: str, user=Depends(principal)):
        return store_signature(service, vid, user)

    @router.post("/versions/{vid}/applications/from-suggestion")
    def application_from_suggestion(
        vid: str, body: FromSuggestionRequest, user=Depends(principal)
    ):
        body = body.payload()
        service.authorize(vid, user)
        with service.db.connect() as conn:
            source = one(
                conn,
                "SELECT document_version_id FROM template_application WHERE application_id=?",
                (body["source_application_id"],),
            )
        service.authorize(source["document_version_id"], user)
        return safe_write(transplant, service, vid, body, user)

    app.include_router(router)
    if start_worker:
        previous_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application):
            async with previous_lifespan(application) as state:
                service.jobs.start()
                try:
                    yield state
                finally:
                    service.jobs.close()

        app.router.lifespan_context = lifespan
    return service


def create_app(root, start_worker=True):
    app = FastAPI(title="Semantic Excel Integration v2")
    install(app, root, start_worker)
    dist = Path(__file__).resolve().parents[2] / "frontend/dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True))
    return app
