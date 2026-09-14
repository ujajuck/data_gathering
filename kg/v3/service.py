"""v3 서비스 규칙(계약 §4.1–§4.9, §4.12) — 정의 파일이 진실, DB는 projection, 값은 불변.

흐름: register(describe 1회 → snapshot → auto_apply → 추출·발행) · import_schema/import_profile(파일 + projection) ·
revise/approve_all/rollback(CAS 리비전) · extract(격리 Reader → 값 배치 저장 → 발행) · test_profile(dry-run) ·
approve_profile/reparse(참조 서명·소급) · refresh_document_status(§4.12 우선순위).
쓰기 트랜잭션은 짧게(BEGIN IMMEDIATE), Reader 프로세스는 트랜잭션 밖에서 돈다.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import platform
import posixpath
import re
import sqlite3
import threading
import time
from importlib.metadata import version as package_version
from pathlib import Path

from kg.v2.spec import address

from . import ENGINE_VERSION
from .adapters import to_canonical
from .db import Database, Problem, decode_cursor, digest, dump, insert, load, norm, now, one, page, rows, uid
from .engine import signature_of
from .jobs import Cancelled, Jobs, env, reader_events, reader_result
from .profile import ROLES, bounds, compile_profile, compile_rule, validate_find, validate_rule

STRUCTURE_ALGORITHM = "structure-v2"
SIGNATURE_LIMIT = 200
FIELD_TYPES = ("text", "decimal", "boolean", "date", "datetime", "group")
TYPE_ALIASES = {"number": "decimal", "string": "text", "bool": "boolean"}
KEY_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
# schema_key는 정의 파일 폴더 이름이 되므로 '.'/'..' 같은 경로 조각을 막는다(첫 글자는 영숫자).
SCHEMA_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$")
REPARSE_PAGE = 200
log = logging.getLogger(__name__)
TEST_TIMEOUT_SECONDS = 20
VALUE_BATCH = 200
VALUE_REGION_LIMIT = 1000
RUN_VALUE_LIMIT = 1_000_000
DEFAULT_WAIT = 60
CANONICAL_CACHE = 64


# ---------------------------------------------------------------------------- 작은 도우미


def _integrity(exc: sqlite3.IntegrityError) -> Problem:
    """트리거/제약 메시지를 계약의 오류 코드로 옮긴다."""
    text = str(exc)
    if "mapping edit conflict" in text or "mapping_revision.mapping_id, mapping_revision.revision_no" in text:
        return Problem("EDIT_CONFLICT", "다른 수정이 먼저 저장되었습니다. 최신 매핑을 다시 확인하세요.", 409)
    if "group field" in text:
        return Problem("GROUP_FIELD_TARGET", "묶음(group) 필드에는 값을 추출할 수 없습니다.")
    if "parent_of requires" in text or "field level change" in text:
        return Problem("INVALID_SCHEMA", "parent_of 관계는 자식 레벨이 부모 레벨 + 1이어야 합니다.")
    if "run inputs differ" in text or "head must be approved" in text or "needs a head revision" in text:
        return Problem("MAPPING_CHANGED", "추출 중 매핑이 바뀌었거나 승인되지 않은 규칙이 있습니다. 현재 규칙으로 다시 추출하세요.", 409)
    if "parsing_profile.profile_name" in text:
        return Problem("PROFILE_NAME_CONFLICT", "같은 이름의 파싱 프로파일이 이미 있습니다.", 409)
    if "parsing_schema.schema_name" in text:
        return Problem("SCHEMA_NAME_CONFLICT", "같은 이름의 파싱 스키마가 이미 있습니다.", 409)
    if "parsing_application.snapshot_id, parsing_application.profile_id" in text:
        return Problem("ALREADY_APPLIED", "이 프로파일은 이미 이 snapshot에 적용되어 있습니다.", 409)
    if "only a successful owned run" in text:
        return Problem("RUN_NOT_PUBLISHABLE", "성공한 파싱 실행만 발행할 수 있습니다. 다시 추출하세요.", 409)
    if "invalid extraction state transition" in text or "run identity and manifest" in text:
        return Problem("INVALID_RUN_STATE", "이미 시작되었거나 끝난 파싱 실행입니다. 새로 추출하세요.", 409)
    if "must start unpublished" in text or "is immutable" in text or "can only advance" in text or "is a projection" in text:
        return Problem("IMMUTABLE_RECORD", "완료된 기록은 수정할 수 없습니다. 새 리비전이나 새 snapshot으로 변경하세요.", 409)
    if "FOREIGN KEY" in text:
        return Problem("REFERENCE_MISSING", "참조하는 항목이 없거나 다른 snapshot의 것입니다. 목록을 새로고침하세요.", 409)
    # 나머지는 스키마 내부 문구이므로 서버 기록에만 남기고 사용자에게는 고정 문구를 준다.
    log.warning("v3 integrity error: %s", text)
    return Problem("INTEGRITY_ERROR", "저장 규칙에 어긋나는 변경입니다. 최신 상태를 다시 확인하세요.", 409)


def normalize_source_ref(source_ref):
    """'a.xlsx'·'./a.xlsx'·'sub/../a.xlsx'가 같은 문서로 등록되도록 provider 상대 참조를 정규화한다(절대 경로·상위 이동 금지)."""
    if not isinstance(source_ref, str) or not source_ref or len(source_ref) > 2048:
        raise Problem("INVALID_SOURCE", "원본 참조가 유효하지 않습니다.")
    text = source_ref.replace("\\", "/")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise Problem("INVALID_SOURCE", "원본 참조는 원본 폴더 기준 상대 경로여야 합니다.")
    normalized = posixpath.normpath(text)
    if normalized in (".", "..") or normalized.startswith("../"):
        raise Problem("INVALID_SOURCE", "원본 참조는 원본 폴더 안을 가리켜야 합니다.")
    return normalized


def split_locator(text):
    """'sheet!range' → (sheet_name, range). 시트 이름에 '!'가 있어도 범위에는 없으므로 뒤에서 나눈다."""
    if not isinstance(text, str) or "!" not in text:
        raise Problem("INVALID_READER_CONTRACT", "제공자의 영역 위치 형식이 유효하지 않습니다.")
    sheet, range_text = text.rsplit("!", 1)
    return sheet, range_text


def _locators(value):
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def _flatten(locators):
    if not locators:
        return None
    return locators[0] if len(locators) == 1 else locators


def _primary_role(spec):
    return spec["selector"]["key"]["areas"][0]["sheet_role"]


def _field_public(row, prefix="field_"):
    if not row or not row.get(prefix + "key"):
        return None
    return {
        "key": row[prefix + "key"],
        "name": row.get(prefix + "name"),
        "type": row.get("value_type"),
        "unit": row.get("canonical_unit"),
    }


def _app_state(agg):
    """application 집계 → 사용자에게 보이는 상태 한 단어."""
    if agg.get("published_run_id"):
        return "published"
    if (agg.get("inherited") or 0) > 0:
        return "changed"
    if (agg.get("unapproved") or 0) > 0 or not agg.get("heads_total"):
        return "review"
    last = agg.get("last_run")
    if last in ("failed", "cancelled"):
        return "failed"
    if last in ("queued", "running"):
        return "extracting"
    return "approved"


def _normalize_signature(raw):
    """Reader describe의 구조 서명을 저장 형태(v2 suggest._normalize와 같은 모양)로 검증한다."""
    if not isinstance(raw, dict) or not isinstance(raw.get("sheets"), list):
        return None
    sheets = []
    for n, sheet in enumerate(raw["sheets"][:64]):
        if not isinstance(sheet, dict) or not isinstance(sheet.get("name"), str):
            return None
        headers, merges = sheet.get("headers") or [], sheet.get("merges") or []
        if not all(isinstance(t, str) for t in (*headers, *merges)):
            return None
        dims = sheet.get("dims") if isinstance(sheet.get("dims"), dict) else {}
        sheets.append(
            {
                "name": sheet["name"],
                "name_norm": norm(sheet["name"]),
                "ordinal": n,
                "visibility": str(sheet.get("visibility") or "visible"),
                "dims": {k: dims.get(k) for k in ("rows", "cols")},
                "headers": sorted(set(headers))[:SIGNATURE_LIMIT],
                "merges": sorted(set(merges))[:SIGNATURE_LIMIT],
            }
        )
    return {"algorithm": STRUCTURE_ALGORITHM, "window": {"rows": 30, "cols": 30}, "sheets": sheets}


def _rule_key_of(message, rule_keys):
    head = str(message).split(":", 1)[0].strip()
    return head if head in rule_keys else None


def ensure_region(conn, snapshot_id, sheet_id, range_text, cache=None):
    """source_region(kind='cells') upsert. locator_key는 정규화한 범위 주소다."""
    r1, c1, r2, c2 = bounds(range_text)
    key = address(r1, c1, r2, c2)
    cache_key = (sheet_id, key)
    if cache is not None and cache_key in cache:
        return cache[cache_key]
    row = conn.execute(
        "SELECT region_id FROM source_region WHERE sheet_id=? AND kind='cells' AND locator_key=?", (sheet_id, key)
    ).fetchone()
    if row:
        rid = row[0]
    else:
        rid = uid()
        insert(
            conn,
            "source_region",
            region_id=rid,
            snapshot_id=snapshot_id,
            sheet_id=sheet_id,
            kind="cells",
            locator_key=key,
            r1=r1,
            c1=c1,
            r2=r2,
            c2=c2,
            created_at=now(),
        )
    if cache is not None:
        cache[cache_key] = rid
    return rid


# ---------------------------------------------------------------------------- 스키마 정의 검증


def validate_schema_definition(definition):
    """schemas/<key>/r%04d.json 형식 → canonical(parents 배열, type 정규화). 오류 INVALID_SCHEMA."""
    if not isinstance(definition, dict):
        raise Problem("INVALID_SCHEMA", "스키마 정의는 JSON 객체여야 합니다.")
    if definition.get("format", "parsing-schema") != "parsing-schema" or str(definition.get("schema_version", "3.0")) != "3.0":
        raise Problem("INVALID_SCHEMA", "parsing-schema 3.0 형식만 지원합니다.")
    key, name = definition.get("schema_key"), definition.get("schema_name")
    if not isinstance(key, str) or not SCHEMA_KEY_RE.match(key) or key in (".", ".."):
        raise Problem("INVALID_SCHEMA", "schema_key는 영문·숫자로 시작하는 영문·숫자·_.- 1~64자여야 합니다.")
    if not isinstance(name, str) or not 1 <= len(name) <= 200:
        raise Problem("INVALID_SCHEMA", "schema_name은 1~200자여야 합니다.")
    fields = definition.get("fields")
    if not isinstance(fields, list) or not 1 <= len(fields) <= 5000:
        raise Problem("INVALID_SCHEMA", "필드를 1~5,000개 지정하세요.")
    out_fields, seen = [], {}
    for n, field in enumerate(fields):
        if not isinstance(field, dict):
            raise Problem("INVALID_SCHEMA", f"fields[{n}]는 객체여야 합니다.")
        fkey = field.get("field_key")
        if not isinstance(fkey, str) or not KEY_RE.match(fkey) or fkey in seen:
            raise Problem("INVALID_SCHEMA", f"fields[{n}].field_key는 고유한 영문·숫자·_.- 1~64자여야 합니다.")
        fname = field.get("name") or field.get("field_name")
        if not isinstance(fname, str) or not 1 <= len(fname) <= 200:
            raise Problem("INVALID_SCHEMA", f"{fkey}: 필드 이름은 1~200자여야 합니다.")
        ftype = field.get("type", field.get("value_type", "text"))
        ftype = TYPE_ALIASES.get(ftype, ftype)
        if ftype not in FIELD_TYPES:
            raise Problem("INVALID_SCHEMA", f"{fkey}: type은 text/decimal/boolean/date/datetime/group 중 하나여야 합니다.")
        level = field.get("level", field.get("field_level"))
        if level is not None and (type(level) is not int or level <= 0):
            raise Problem("INVALID_SCHEMA", f"{fkey}: level은 양의 정수여야 합니다.")
        parents = field.get("parents", field.get("parent"))
        parents = [] if parents in (None, "") else [parents] if isinstance(parents, str) else parents
        related = field.get("related") or []
        aliases = field.get("aliases") or []
        for what, items in (("parents", parents), ("related", related), ("aliases", aliases)):
            if not isinstance(items, list) or any(not isinstance(i, str) or not i for i in items):
                raise Problem("INVALID_SCHEMA", f"{fkey}: {what}는 문자열 배열이어야 합니다.")
        status = field.get("status", "active")
        if status not in ("active", "deprecated"):
            raise Problem("INVALID_SCHEMA", f"{fkey}: status는 active/deprecated 중 하나여야 합니다.")
        unit = field.get("unit", field.get("canonical_unit"))
        item = {
            "field_key": fkey,
            "name": fname,
            "type": ftype,
            "level": level,
            "parents": list(dict.fromkeys(parents)),
            "related": list(dict.fromkeys(related)),
            "aliases": list(dict.fromkeys(a.strip() for a in aliases if a.strip())),
            "status": status,
        }
        if unit not in (None, ""):
            item["unit"] = str(unit)
        if field.get("description") is not None:
            item["description"] = str(field["description"])[:4000]
        seen[fkey] = item
        out_fields.append(item)
    for item in out_fields:
        for parent in item["parents"]:
            if parent not in seen:
                raise Problem("INVALID_SCHEMA", f"{item['field_key']}: 부모 필드 {parent!r}가 없습니다.")
            if parent == item["field_key"]:
                raise Problem("INVALID_SCHEMA", f"{item['field_key']}: 자기 자신을 부모로 지정할 수 없습니다.")
            plevel = seen[parent]["level"]
            if plevel is None or item["level"] is None or item["level"] != plevel + 1:
                raise Problem("INVALID_SCHEMA", f"{item['field_key']}: parent_of 관계는 자식 레벨이 부모 레벨 + 1이어야 합니다.")
        for rel in item["related"]:
            if rel not in seen or rel == item["field_key"]:
                raise Problem("INVALID_SCHEMA", f"{item['field_key']}: 연관 필드 {rel!r}가 유효하지 않습니다.")
    out = {"format": "parsing-schema", "schema_version": "3.0", "schema_key": key, "schema_name": name, "fields": out_fields}
    if definition.get("description") is not None:
        out["description"] = str(definition["description"])[:4000]
    return out


# ---------------------------------------------------------------------------- 서비스


class Service:
    def __init__(self, root, start_worker=False):
        self.db = Database(Path(root))
        self.root = self.db.root
        self.principal = env("PRINCIPAL", "local")
        self.jobs = Jobs(self.db, self.handle_job, self.fail_job)
        self._render = None
        self._render_lock = threading.Lock()
        self._canonicals = {}
        if start_worker:
            self.jobs.start()

    @property
    def render(self):
        # in-process 렌더 워커는 스레드를 띄우므로 처음 필요할 때 만든다(요청 스레드가 동시에 와도 하나만).
        if self._render is None:
            with self._render_lock:
                if self._render is None:
                    from .render.client import RenderClient

                    self._render = RenderClient(self.root)
        return self._render

    def close(self):
        self.jobs.close()
        if self._render is not None:
            self._render.close()

    # ---- Reader 격리 --------------------------------------------------------------
    def _read(self, provider, principal, operation, payload, checkpoint=lambda *a, **k: None):
        return reader_result(self.root, provider, principal, operation, payload, checkpoint)

    def _stream(self, provider, principal, operation, payload, checkpoint=lambda *a, **k: None):
        return reader_events(self.root, provider, principal, operation, payload, checkpoint)

    # ---- 작업 분기 ----------------------------------------------------------------
    def handle_job(self, kind, payload, principal, checkpoint):
        if kind == "register":
            return self._register_job(payload, principal, checkpoint)
        if kind == "extract":
            return self.execute_extraction(payload, principal, checkpoint)
        if kind == "reparse":
            return self.execute_reparse(payload["profile_id"], payload["mode"], principal, checkpoint)
        if kind == "queue_action":
            from .operations import execute_queue_action

            return execute_queue_action(self, payload, principal, checkpoint)
        if kind == "build":
            from .build import execute_build

            return execute_build(self, payload, principal, checkpoint)
        raise Problem("UNKNOWN_JOB", "지원하지 않는 작업입니다.")

    def fail_job(self, kind, payload, exc):
        if kind == "extract" and payload.get("run_id"):
            self._finish_run_failed(payload["run_id"], exc)

    def job_result(self, job, wait=0, principal=None):
        return self.jobs.wait(job["job_id"], wait, principal) if wait else job

    # ---- 정의 파일 ------------------------------------------------------------------
    def _definition_folder(self, kind, key):
        folder = self.root / kind / key
        if folder.resolve().parent != (self.root / kind).resolve():
            raise Problem("INVALID_SCHEMA" if kind == "schemas" else "INVALID_PROFILE", "정의 키에 경로 문자를 쓸 수 없습니다.")
        return folder

    def _write_definition(self, folder: Path, rev: int, canonical):
        folder.mkdir(parents=True, exist_ok=True)
        text = json.dumps(canonical, ensure_ascii=False, indent=2, sort_keys=True)
        path = folder / f"r{rev:04d}.json"
        path.write_text(text, encoding="utf-8")
        current = folder / "current.json"
        tmp = folder / "current.json.tmp"
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, current)
        return path

    @staticmethod
    def _discard_definition(folder: Path, rev: int, previous_current, fresh):
        """projection 커밋이 실패하면 방금 쓴 r%04d.json을 지우고 current.json을 되돌린다(파일이 진실이므로 유령 리비전 금지)."""
        try:
            (folder / f"r{rev:04d}.json").unlink(missing_ok=True)
            current = folder / "current.json"
            if previous_current is None:
                current.unlink(missing_ok=True)
            else:
                current.write_bytes(previous_current)
            if fresh and folder.is_dir() and not any(folder.iterdir()):
                folder.rmdir()
        except OSError:
            log.exception("definition rollback failed: %s r%s", folder, rev)

    @staticmethod
    def _current_bytes(folder: Path):
        current = folder / "current.json"
        return current.read_bytes() if current.is_file() else None

    def _read_definition(self, folder: Path, rev: int):
        path = folder / f"r{rev:04d}.json"
        if not path.is_file():
            raise Problem("DEFINITION_MISSING", "정의 파일이 없습니다. 정의를 다시 가져오세요.", 404)
        return json.loads(path.read_text(encoding="utf-8"))

    def schema_definition(self, schema_key, rev=None):
        with self.db.connect() as conn:
            schema = one(conn, "SELECT * FROM parsing_schema WHERE schema_key=?", (schema_key,), "파싱 스키마를 찾을 수 없습니다.")
        return self._read_definition(self.root / "schemas" / schema_key, rev or schema["current_rev"])

    def profile_canonical(self, profile_id, rev):
        key = (profile_id, rev)
        if key not in self._canonicals:
            if len(self._canonicals) >= CANONICAL_CACHE:
                self._canonicals.pop(next(iter(self._canonicals)))
            self._canonicals[key] = self._read_definition(self.root / "profiles" / profile_id, rev)
        return copy.deepcopy(self._canonicals[key])

    # ---- 스키마 -----------------------------------------------------------------------
    def schema_fields(self, schema_key, conn=None):
        """{field_key: {field_id, value_type, status, name, aliases, unit}} 또는 스키마가 없으면 None."""
        if conn is None:
            with self.db.connect() as conn:
                return self.schema_fields(schema_key, conn)
        schema = conn.execute("SELECT schema_id FROM parsing_schema WHERE schema_key=?", (schema_key,)).fetchone()
        if not schema:
            return None
        fields = {}
        for r in conn.execute(
            "SELECT field_id,field_key,field_name,value_type,status,canonical_unit FROM parsing_field WHERE schema_id=? ORDER BY ordinal",
            (schema["schema_id"],),
        ):
            fields[r["field_key"]] = {
                "field_id": r["field_id"],
                "value_type": r["value_type"],
                "status": r["status"],
                "name": r["field_name"],
                "unit": r["canonical_unit"],
                "aliases": [],
            }
        by_id = {f["field_id"]: f for f in fields.values()}
        for r in conn.execute(
            "SELECT a.field_id,a.alias_text FROM parsing_alias a JOIN parsing_field f ON f.field_id=a.field_id WHERE f.schema_id=? ORDER BY a.rowid",
            (schema["schema_id"],),
        ):
            by_id[r["field_id"]]["aliases"].append(r["alias_text"])
        return fields

    def import_schema(self, definition, principal=None):
        """§4.2 파일 저장 + projection upsert(추가·갱신·deprecated, 삭제 없음), current_rev 증가."""
        canonical = validate_schema_definition(definition)
        key = canonical["schema_key"]
        sha = digest(canonical)
        folder = self._definition_folder("schemas", key)
        previous_current, written = self._current_bytes(folder), None
        try:
            with self.db.connect(write=True) as conn:
                schema = conn.execute("SELECT * FROM parsing_schema WHERE schema_key=?", (key,)).fetchone()
                if schema and schema["definition_sha256"] == sha:
                    return {"schema_id": schema["schema_id"], "schema_key": key, "current_rev": schema["current_rev"], "unchanged": True}
                rev = (schema["current_rev"] + 1) if schema else 1
                relative = str((folder / f"r{rev:04d}.json").relative_to(self.root))
                stamp = now()
                try:
                    if schema:
                        sid = schema["schema_id"]
                        conn.execute(
                            "UPDATE parsing_schema SET schema_name=?,description=?,definition_path=?,current_rev=?,definition_sha256=?,status='active',updated_at=? WHERE schema_id=?",
                            (canonical["schema_name"], canonical.get("description"), relative, rev, sha, stamp, sid),
                        )
                    else:
                        sid = uid()
                        insert(
                            conn,
                            "parsing_schema",
                            schema_id=sid,
                            schema_key=key,
                            schema_name=canonical["schema_name"],
                            description=canonical.get("description"),
                            definition_path=relative,
                            current_rev=rev,
                            definition_sha256=sha,
                            status="active",
                            created_at=stamp,
                            updated_at=stamp,
                        )
                    counts = self._project_schema(conn, sid, canonical, stamp)
                except sqlite3.IntegrityError as exc:
                    raise _integrity(exc) from None
                # projection이 통과한 뒤(커밋 직전)에 파일을 쓴다. 거부된 가져오기는 파일을 남기지 않는다.
                written = (rev, schema is None)
                self._write_definition(folder, rev, canonical)
        except BaseException:
            if written:
                self._discard_definition(folder, written[0], previous_current, written[1])
            raise
        return {"schema_id": sid, "schema_key": key, "current_rev": rev, "unchanged": False, **counts}

    def _project_schema(self, conn, schema_id, canonical, stamp):
        existing = {r["field_key"]: dict(r) for r in conn.execute("SELECT * FROM parsing_field WHERE schema_id=?", (schema_id,))}
        # 레벨 변경은 기존 parent_of 간선과 충돌하므로(트리거) 간선을 먼저 비우고 필드 갱신 뒤 다시 만든다.
        conn.execute("DELETE FROM parsing_field_edge WHERE schema_id=?", (schema_id,))
        conn.execute("DELETE FROM parsing_alias WHERE field_id IN (SELECT field_id FROM parsing_field WHERE schema_id=?)", (schema_id,))
        ids, added = {}, 0
        for n, field in enumerate(canonical["fields"]):
            row = existing.get(field["field_key"])
            if row:
                fid = row["field_id"]
                conn.execute(
                    "UPDATE parsing_field SET field_name=?,description=?,field_level=?,value_type=?,canonical_unit=?,status=?,ordinal=?,updated_at=? WHERE field_id=?",
                    (field["name"], field.get("description"), field["level"], field["type"], field.get("unit"), field["status"], n, stamp, fid),
                )
            else:
                fid = uid()
                added += 1
                insert(
                    conn,
                    "parsing_field",
                    field_id=fid,
                    schema_id=schema_id,
                    field_key=field["field_key"],
                    field_name=field["name"],
                    description=field.get("description"),
                    field_level=field["level"],
                    value_type=field["type"],
                    canonical_unit=field.get("unit"),
                    status=field["status"],
                    ordinal=n,
                    created_at=stamp,
                    updated_at=stamp,
                )
            ids[field["field_key"]] = fid
            seen = set()
            for alias in field["aliases"]:
                key = norm(alias)
                if not key or key in seen:
                    continue
                seen.add(key)
                insert(conn, "parsing_alias", alias_id=uid(), field_id=fid, alias_text=alias, alias_norm=key, context_key="")
        gone = [k for k in existing if k not in ids and existing[k]["status"] != "deprecated"]
        if gone:
            conn.executemany(
                "UPDATE parsing_field SET status='deprecated',updated_at=? WHERE field_id=?",
                [(stamp, existing[k]["field_id"]) for k in gone],
            )
        for field in canonical["fields"]:
            for n, parent in enumerate(field["parents"]):
                insert(conn, "parsing_field_edge", edge_id=uid(), schema_id=schema_id, from_field_id=ids[parent], to_field_id=ids[field["field_key"]], relation="parent_of", ordinal=n)
            for n, rel in enumerate(field["related"]):
                insert(conn, "parsing_field_edge", edge_id=uid(), schema_id=schema_id, from_field_id=ids[field["field_key"]], to_field_id=ids[rel], relation="related_to", ordinal=n)
        return {"fields": len(ids), "added": added, "deprecated": len(gone)}

    def patch_field(self, schema_key, field_key, name=None, description=None, aliases=None, status=None):
        """필드 단건 편집 = 정의 파일 새 리비전 + projection(§6 PATCH)."""
        canonical = self.schema_definition(schema_key)
        target = next((f for f in canonical["fields"] if f["field_key"] == field_key), None)
        if target is None:
            raise Problem("NOT_FOUND", "필드를 찾을 수 없습니다.", 404)
        if name is not None:
            target["name"] = name
        if description is not None:
            target["description"] = description
        if aliases is not None:
            target["aliases"] = aliases
        if status is not None:
            target["status"] = status
        return self.import_schema(canonical)

    # ---- 프로파일 ---------------------------------------------------------------------
    def _profile_row(self, conn, profile_id):
        return one(
            conn,
            "SELECT p.*, s.schema_key, s.schema_name, s.current_rev schema_rev FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.profile_id=?",
            (profile_id,),
            "파싱 프로파일을 찾을 수 없습니다.",
        )

    def preview_profile(self, schema_key, definition, format="auto"):
        """저장하지 않는 가져오기 미리보기(§6 import-preview)."""
        fields = self.schema_fields(schema_key)
        try:
            canonical, report = to_canonical(definition, schema_key, fields, format or "auto")
        except Problem as exc:
            return {"format_detected": None, "canonical": None, "warnings": [], "errors": [{"code": exc.code, "message": exc.message}]}
        return {"format_detected": report["format_detected"], "canonical": canonical, "warnings": report["warnings"], "errors": []}

    def import_profile(self, schema_key, definition, format="auto", profile_id=None, name=None, principal=None):
        """§4.2 adapter → validate → 파일 저장 + rule projection(사라진 rule은 deprecated), current_rev 증가, status 유지."""
        with self.db.connect() as conn:
            schema = conn.execute("SELECT * FROM parsing_schema WHERE schema_key=?", (schema_key,)).fetchone()
            fields = self.schema_fields(schema_key, conn) if schema else None
        if schema is None:
            raise Problem("UNKNOWN_SCHEMA", f"파싱 스키마 {schema_key!r}를 찾을 수 없습니다.", 404)
        canonical, report = to_canonical(definition, schema_key, fields, format or "auto")
        canonical["schema_key"] = schema_key
        with self.db.connect(write=True) as conn:
            profile = None
            if profile_id:
                profile = self._profile_row(conn, profile_id)
                if profile["schema_id"] != schema["schema_id"]:
                    raise Problem("SCHEMA_IMMUTABLE", "프로파일의 대상 스키마는 바꿀 수 없습니다.")
            profile_name = name or canonical.get("profile_name") or (profile["profile_name"] if profile else None)
            if not profile_name:
                raise Problem("INVALID_PROFILE", "프로파일 이름(name 또는 정의의 profile_name)을 지정하세요.")
            canonical["profile_name"] = profile_name
            rev = (profile["current_rev"] + 1) if profile else 1
            pid = profile["profile_id"] if profile else uid()
            folder = self._definition_folder("profiles", pid)
            previous_current = self._current_bytes(folder)
            relative = str((folder / f"r{rev:04d}.json").relative_to(self.root))
            sha, stamp = digest(canonical), now()
            try:
                if profile:
                    conn.execute(
                        "UPDATE parsing_profile SET profile_name=?,description=?,definition_path=?,current_rev=?,definition_sha256=?,updated_at=? WHERE profile_id=?",
                        (profile_name, canonical.get("description"), relative, rev, sha, stamp, pid),
                    )
                else:
                    insert(
                        conn,
                        "parsing_profile",
                        profile_id=pid,
                        profile_name=profile_name,
                        description=canonical.get("description"),
                        schema_id=schema["schema_id"],
                        definition_path=relative,
                        current_rev=rev,
                        definition_sha256=sha,
                        status="draft",
                        created_at=stamp,
                        updated_at=stamp,
                    )
                counts = self._project_rules(conn, pid, canonical, fields, stamp)
            except sqlite3.IntegrityError as exc:
                raise _integrity(exc) from None
            status = profile["status"] if profile else "draft"
            # projection 통과 뒤(커밋 직전) 파일 쓰기; 쓰기·커밋이 실패하면 파일을 되돌린다.
            try:
                self._write_definition(folder, rev, canonical)
                conn.commit()
            except BaseException:
                self._discard_definition(folder, rev, previous_current, profile is None)
                raise
        self._canonicals[(pid, rev)] = copy.deepcopy(canonical)
        return {"profile_id": pid, "profile_name": profile_name, "current_rev": rev, "status": status, "schema_key": schema_key, "report": report, **counts}

    def _project_rules(self, conn, profile_id, canonical, fields, stamp):
        existing = {r["rule_key"]: dict(r) for r in conn.execute("SELECT * FROM parsing_rule WHERE profile_id=?", (profile_id,))}
        seen = set()
        for n, rule in enumerate(canonical["rules"]):
            field_id = fields[rule["field_key"]]["field_id"] if rule.get("field_key") else None
            values = (rule.get("rule_name"), field_id, n, dump(rule["selector"]), dump(rule["value_spec"]))
            seen.add(rule["rule_key"])
            if rule["rule_key"] in existing:
                conn.execute(
                    "UPDATE parsing_rule SET rule_name=?,default_field_id=?,ordinal=?,selector_json=?,value_spec_json=?,status='active' WHERE rule_id=?",
                    (*values, existing[rule["rule_key"]]["rule_id"]),
                )
            else:
                insert(
                    conn,
                    "parsing_rule",
                    rule_id=uid(),
                    profile_id=profile_id,
                    rule_key=rule["rule_key"],
                    rule_name=values[0],
                    default_field_id=field_id,
                    ordinal=n,
                    selector_json=values[3],
                    value_spec_json=values[4],
                    status="active",
                    created_at=stamp,
                )
        gone = [k for k in existing if k not in seen]
        if gone:
            conn.executemany("UPDATE parsing_rule SET status='deprecated' WHERE rule_id=?", [(existing[k]["rule_id"],) for k in gone])
        return {"rules": len(seen), "deprecated_rules": len(gone)}

    def _profile_specs(self, conn, profile):
        """approved/active 규칙 행 + 현재 rev canonical의 compile 결과."""
        canonical = self.profile_canonical(profile["profile_id"], profile["current_rev"])
        specs = compile_profile(canonical)
        rules = rows(conn, "SELECT * FROM parsing_rule WHERE profile_id=? AND status='active' ORDER BY ordinal,rule_key", (profile["profile_id"],))
        rules = [r for r in rules if r["rule_key"] in specs]
        return canonical, specs, rules

    def _reader_profile(self, profile):
        reference = None
        if profile.get("reference_signature"):
            reference = {"signature": profile["reference_signature"], "profile_rev": profile["reference_profile_rev"]}
        return {
            "profile_id": profile["profile_id"],
            "profile_rev": profile["current_rev"],
            "canonical": self.profile_canonical(profile["profile_id"], profile["current_rev"]),
            "reference": reference,
        }

    def _approved_profiles(self, conn):
        return rows(
            conn,
            "SELECT p.*, s.schema_key, s.current_rev schema_rev FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.status='approved' ORDER BY p.profile_name",
        )

    # ---- 등록 ----------------------------------------------------------------------
    def register_documents(self, source_refs, provider="local-xlsx", document_id=None, principal=None, wait=0):
        """POST /documents/register: 작업 1개(등록 + 자동 적용 + 추출)."""
        principal = principal or self.principal
        label = Path(source_refs[0]).name + (f" 외 {len(source_refs) - 1}건" if len(source_refs) > 1 else "")
        payload = {"source_refs": list(source_refs), "provider": provider, "document_id": document_id}
        job = self.jobs.submit(
            "register",
            payload,
            principal,
            uid(),
            target_kind="document" if document_id else "workspace",
            target_id=document_id,
            label=label,
        )
        return self.job_result(job, wait, principal)

    def _register_job(self, payload, principal, checkpoint):
        refs = payload["source_refs"]
        results, failures = [], []
        for n, ref in enumerate(refs):
            checkpoint(n, len(refs), force=True)
            try:
                ref = normalize_source_ref(ref)
                results.append(self.register(ref, payload.get("provider", "local-xlsx"), principal, payload.get("document_id"), checkpoint))
            except Cancelled:
                raise
            except Problem as exc:
                failures.append(exc)
                results.append(self._register_failure(ref, payload.get("provider", "local-xlsx"), exc))
        if failures and len(failures) == len(refs):
            raise failures[0]
        return {"documents": results}

    def _register_failure(self, source_ref, provider, exc):
        """잠긴 파일(DRM_READER_REQUIRED): 문서 행은 남기고 status='locked' + last_error."""
        result = {"document_id": None, "document_name": Path(source_ref).name, "snapshot": None, "status": None, "applied": [], "error": {"code": exc.code, "message": exc.message}}
        if exc.code != "DRM_READER_REQUIRED":
            return result
        stamp = now()
        with self.db.connect(write=True) as conn:
            doc = conn.execute("SELECT * FROM document WHERE provider=? AND source_path=?", (provider, source_ref)).fetchone()
            if doc:
                did = doc["document_id"]
            else:
                did = uid()
                insert(
                    conn,
                    "document",
                    document_id=did,
                    document_name=Path(source_ref).name,
                    provider=provider,
                    source_path=source_ref,
                    file_type=Path(source_ref).suffix.lstrip(".").lower() or "xlsx",
                    status="locked",
                    created_at=stamp,
                    updated_at=stamp,
                )
            conn.execute(
                "UPDATE document SET status='locked',status_detail_json=?,last_error=?,last_processed_at=?,updated_at=? WHERE document_id=?",
                (dump({"locked": {"code": exc.code}}), exc.message, stamp, stamp, did),
            )
        result.update(document_id=did, status="locked")
        return result

    def register(self, source_ref, provider="local-xlsx", principal=None, document_id=None, checkpoint=lambda *a, **k: None):
        """§4.1 describe(profiles=approved) 1회 → document/snapshot/sheet/signature → §4.4 승계 → §4.3 auto_apply → 상태 갱신."""
        principal = principal or self.principal
        source_ref = normalize_source_ref(source_ref)
        with self.db.connect() as conn:
            approved = self._approved_profiles(conn)
        profiles = [self._reader_profile(p) for p in approved]
        metadata = self._read(provider, principal, "describe", {"source_ref": source_ref, "profiles": profiles}, checkpoint)
        if not isinstance(metadata, dict) or not metadata.get("token") or not isinstance(metadata.get("sheets"), list):
            raise Problem("INVALID_READER_CONTRACT", "제공자의 문서 snapshot/시트 정보가 유효하지 않습니다.")
        matches = {m["profile_id"]: m for m in metadata.get("matches") or [] if isinstance(m, dict)}
        checkpoint(force=True)
        snapshot, previous, document = self._store_snapshot(source_ref, provider, document_id, metadata)
        applied, incompatible, to_extract = [], [], []
        inherited_profiles = set()
        if previous is not None:
            inherited, incompatible = self._inherit(document, previous, snapshot, principal, checkpoint)
            applied.extend(inherited)
            inherited_profiles = {a["profile_id"] for a in inherited} | {i["profile_id"] for i in incompatible}
            try:
                self.render.invalidate(previous["snapshot_id"])
            except Problem:
                pass
        with self.db.connect(write=True) as conn:
            for profile in approved:
                match = matches.get(profile["profile_id"])
                if not match or profile["profile_id"] in inherited_profiles:
                    continue
                created = self.auto_apply(conn, snapshot, profile, match, principal)
                if created:
                    applied.append(created)
                    if created["extract"]:
                        to_extract.append(created["application_id"])
            if incompatible:
                detail = load(document.get("status_detail_json"), {}) or {}
                detail["incompatible"] = incompatible
                conn.execute("UPDATE document SET status_detail_json=? WHERE document_id=?", (dump(detail), document["document_id"]))
        for application_id in to_extract:
            self._extract_now(application_id, principal, checkpoint, auto_approved=1)
        status = self.refresh_document_status(document["document_id"])
        # applied[].state는 추출·발행까지 끝난 최종 상태(문서 목록의 profiles[].state와 같은 어휘)로 돌려준다.
        if applied:
            with self.db.connect() as conn:
                aggs = self._application_aggregates(conn, "a.snapshot_id=?", (snapshot["snapshot_id"],))
            states = {a["application_id"]: _app_state(a) for a in aggs}
            for a in applied:
                a["state"] = states.get(a["application_id"], a["state"])
        return {
            "document_id": document["document_id"],
            "document_name": document["document_name"],
            "snapshot": {k: snapshot[k] for k in ("snapshot_id", "revision_no", "captured_at", "change_token")} | {"unchanged": snapshot.get("unchanged", False)},
            "status": status["status"],
            "applied": [{k: a[k] for k in ("application_id", "profile_id", "profile_name", "compatibility", "state")} for a in applied],
        }

    def _store_snapshot(self, source_ref, provider, document_id, metadata):
        """document upsert + token 판정(같으면 새 snapshot 없음) + sheet + snapshot_signature. → (snapshot, previous|None, document)."""
        stamp = now()
        filename = metadata.get("filename") or Path(source_ref).name
        with self.db.connect(write=True) as conn:
            if document_id:
                doc = one(conn, "SELECT * FROM document WHERE document_id=?", (document_id,), "문서를 찾을 수 없습니다.")
                if doc["provider"] != provider:
                    raise Problem("PROVIDER_MISMATCH", "기존 문서와 원본 제공자가 다릅니다.", 409)
                # 이름/위치 변경은 사용자가 기존 문서 ID를 지정할 때만 같은 문서로 처리한다.
                try:
                    conn.execute("UPDATE document SET source_path=?,document_name=?,updated_at=? WHERE document_id=?", (source_ref, filename, stamp, document_id))
                except sqlite3.IntegrityError:
                    raise Problem("SOURCE_CONFLICT", "이 원본 경로는 다른 문서에 이미 등록되어 있습니다.", 409) from None
            else:
                doc = conn.execute("SELECT * FROM document WHERE provider=? AND source_path=?", (provider, source_ref)).fetchone()
                if doc:
                    document_id = doc["document_id"]
                    conn.execute("UPDATE document SET document_name=?,updated_at=? WHERE document_id=?", (filename, stamp, document_id))
                else:
                    document_id = uid()
                    insert(
                        conn,
                        "document",
                        document_id=document_id,
                        document_name=filename,
                        provider=provider,
                        source_path=source_ref,
                        file_type=Path(filename).suffix.lstrip(".").lower() or "xlsx",
                        status="not_extracted",
                        created_at=stamp,
                        updated_at=stamp,
                    )
            doc = dict(one(conn, "SELECT * FROM document WHERE document_id=?", (document_id,)))
            detail = load(doc.get("status_detail_json"), {}) or {}
            if "locked" in detail:
                detail.pop("locked")
                conn.execute("UPDATE document SET status_detail_json=?,last_error=NULL WHERE document_id=?", (dump(detail), document_id))
            current = None
            if doc["current_snapshot_id"]:
                current = dict(one(conn, "SELECT * FROM document_snapshot WHERE snapshot_id=?", (doc["current_snapshot_id"],)))
            if current and current["change_token"] == metadata["token"]:
                current["unchanged"] = True
                return current, None, doc
            latest = conn.execute("SELECT coalesce(max(revision_no),0) FROM document_snapshot WHERE document_id=?", (document_id,)).fetchone()[0]
            sid = uid()
            token = metadata["token"]
            snapshot = dict(
                snapshot_id=sid,
                document_id=document_id,
                revision_no=latest + 1,
                change_token=token,
                content_sha256=token if provider == "local-xlsx" else metadata.get("content_sha256"),
                ciphertext_sha256=metadata.get("ciphertext_sha256"),
                provider_version=None if provider == "local-xlsx" else str(metadata.get("provider_version") or token),
                dvc_rev=metadata.get("dvc_rev"),
                author=metadata.get("author"),
                authored_at=metadata.get("authored_at"),
                filename=filename,
                byte_size=metadata.get("byte_size"),
                excel_date_system=metadata.get("excel_date_system"),
                captured_at=stamp,
            )
            insert(conn, "document_snapshot", **snapshot)
            seen = set()
            for n, sheet in enumerate(metadata["sheets"]):
                if not isinstance(sheet, dict) or not isinstance(sheet.get("name"), str) or sheet["name"] in seen:
                    raise Problem("INVALID_SHEETS", "시트 이름이 없거나 중복되었습니다.")
                seen.add(sheet["name"])
                insert(
                    conn,
                    "sheet",
                    sheet_id=uid(),
                    snapshot_id=sid,
                    sheet_name=sheet["name"],
                    ordinal=n,
                    native_sheet_key=sheet.get("native_sheet_key"),
                    visibility=str(sheet.get("visibility") or "visible"),
                    estimated_rows=sheet.get("estimated_rows"),
                    estimated_cols=sheet.get("estimated_cols"),
                )
            signature = _normalize_signature(metadata.get("signature"))
            if signature:
                insert(
                    conn,
                    "snapshot_signature",
                    snapshot_id=sid,
                    algorithm=STRUCTURE_ALGORITHM,
                    signature_json=dump(signature),
                    signature_sha256=digest(signature),
                    reader_revision=env("READER_REVISION", "unversioned-operator-adapter"),
                    computed_at=stamp,
                )
            conn.execute("UPDATE document SET current_snapshot_id=?,updated_at=? WHERE document_id=?", (sid, stamp, document_id))
        snapshot["unchanged"] = False
        return snapshot, current, doc

    # ---- 시트/영역 도우미 ---------------------------------------------------------------
    def _sheets(self, conn, snapshot_id):
        sheets = rows(conn, "SELECT * FROM sheet WHERE snapshot_id=? ORDER BY ordinal", (snapshot_id,))
        return {s["sheet_name"]: s for s in sheets}, {s["sheet_id"]: s for s in sheets}

    def _bindings_to_ids(self, bindings, by_name):
        out = {}
        for role, names in (bindings or {}).items():
            ids = []
            for name in names:
                if name not in by_name:
                    raise Problem("INVALID_SHEET_BINDING", f"시트 {name}이 이 snapshot에 없습니다.")
                ids.append(by_name[name]["sheet_id"])
            out[role] = ids
        return out

    def _regions_from_resolved(self, conn, snapshot_id, by_name, resolved, cache):
        """match resolved{role: locator|[locator]} → [(role, ordinal, region_id)]."""
        out = []
        for role in ROLES:
            for n, loc in enumerate(_locators((resolved or {}).get(role))):
                sheet, range_text = split_locator(loc)
                if sheet not in by_name:
                    continue
                out.append((role, n, ensure_region(conn, snapshot_id, by_name[sheet]["sheet_id"], range_text, cache)))
        return out

    # ---- application 생성(공통) ------------------------------------------------------
    def _insert_application(self, conn, snapshot, profile, bindings, origin, compatibility, signature, signature_json, by_name):
        app_id = uid()
        try:
            insert(
                conn,
                "parsing_application",
                application_id=app_id,
                snapshot_id=snapshot["snapshot_id"],
                profile_id=profile["profile_id"],
                schema_id=profile["schema_id"],
                scope_key="default",
                profile_rev=profile["current_rev"],
                schema_rev=profile["schema_rev"],
                origin=origin,
                match_signature=signature or "",
                match_signature_json=dump(signature_json) if signature_json is not None else None,
                compatibility=compatibility,
                created_at=now(),
            )
        except sqlite3.IntegrityError as exc:
            raise _integrity(exc) from None
        for role, ids in self._bindings_to_ids(bindings, by_name).items():
            for n, sheet_id in enumerate(ids):
                insert(conn, "application_sheet", application_id=app_id, snapshot_id=snapshot["snapshot_id"], role_key=role, ordinal=n, sheet_id=sheet_id)
        return app_id

    def _insert_mapping(self, conn, app_id, snapshot_id, rule_id, revision, regions):
        """mapping + 최초 리비전(revision_no=1) + mapping_region. revision: {field_id, observed_key, spec, status, origin, evidence, created_by, reason}."""
        mid, rid = uid(), uid()
        insert(conn, "mapping", mapping_id=mid, application_id=app_id, snapshot_id=snapshot_id, rule_id=rule_id, created_at=now())
        self._insert_revision(conn, mid, snapshot_id, 1, rid, revision, regions)
        return mid, rid

    def _insert_revision(self, conn, mapping_id, snapshot_id, revision_no, revision_id, revision, regions):
        try:
            insert(
                conn,
                "mapping_revision",
                mapping_revision_id=revision_id,
                mapping_id=mapping_id,
                revision_no=revision_no,
                snapshot_id=snapshot_id,
                field_id=revision.get("field_id"),
                observed_key=revision.get("observed_key"),
                effective_spec_json=dump(revision["spec"]),
                status=revision["status"],
                origin=revision["origin"],
                evidence_json=dump(revision["evidence"]) if revision.get("evidence") is not None else None,
                created_by=revision.get("created_by"),
                reason=revision.get("reason"),
                created_at=now(),
            )
            if regions:
                conn.executemany(
                    "INSERT INTO mapping_region (mapping_revision_id,snapshot_id,region_id,role,ordinal) VALUES (?,?,?,?,?)",
                    [(revision_id, snapshot_id, region_id, role, n) for role, n, region_id in regions],
                )
        except sqlite3.IntegrityError as exc:
            raise _integrity(exc) from None

    def _create_application(self, conn, snapshot, profile, match, origin, compatibility, principal, decide):
        """profile의 active 규칙마다 mapping/리비전 1개. decide(rule) → (status, origin, evidence, field_id)."""
        canonical, specs, rules = self._profile_specs(conn, profile)
        by_name, _ = self._sheets(conn, snapshot["snapshot_id"])
        app_id = self._insert_application(
            conn, snapshot, profile, match.get("bindings") or {}, origin, compatibility, match.get("match_signature"), match.get("match_signature_json"), by_name
        )
        cache, approved, total = {}, 0, 0
        for rule in rules:
            status, rev_origin, evidence, field_id = decide(rule)
            regions = self._regions_from_resolved(conn, snapshot["snapshot_id"], by_name, (match.get("resolved") or {}).get(rule["rule_key"]), cache)
            self._insert_mapping(
                conn,
                app_id,
                snapshot["snapshot_id"],
                rule["rule_id"],
                {"field_id": field_id, "spec": specs[rule["rule_key"]], "status": status, "origin": rev_origin, "evidence": evidence, "created_by": principal},
                regions,
            )
            total += 1
            approved += status == "approved"
        return app_id, approved, total

    def auto_apply(self, conn, snapshot, profile, match, principal):
        """§4.3 approved 프로파일 + identical/compatible 매치 → application(origin auto). 반환 {…, extract: bool} 또는 None."""
        if profile["status"] != "approved" or match.get("compatibility") not in ("identical", "compatible"):
            return None
        if conn.execute(
            "SELECT 1 FROM parsing_application WHERE snapshot_id=? AND profile_id=? AND scope_key='default'", (snapshot["snapshot_id"], profile["profile_id"])
        ).fetchone():
            return None
        identical = match["compatibility"] == "identical" and profile.get("reference_application_id")
        reference_heads = {}
        if identical:
            reference_heads = {
                r["rule_id"]: r["current_revision_id"]
                for r in conn.execute("SELECT rule_id,current_revision_id FROM mapping WHERE application_id=?", (profile["reference_application_id"],))
            }

        def decide(rule):
            if identical and rule["default_field_id"]:
                evidence = {"reference_revision_id": reference_heads.get(rule["rule_id"]), "profile_rev": profile["current_rev"], "match_signature": match["match_signature"]}
                return "approved", "auto", evidence, rule["default_field_id"]
            reason = "FIELD_REQUIRED" if not rule["default_field_id"] else match["compatibility"]
            return "proposed", "profile", {"reason": reason, "profile_rev": profile["current_rev"], "match_signature": match["match_signature"]}, rule["default_field_id"]

        app_id, approved, total = self._create_application(conn, snapshot, profile, match, "auto", match["compatibility"], principal, decide)
        return {
            "application_id": app_id,
            "profile_id": profile["profile_id"],
            "profile_name": profile["profile_name"],
            "compatibility": match["compatibility"],
            "state": "approved" if approved == total else "review",
            "extract": approved == total and total > 0,
        }

    # ---- §4.4 새 snapshot 승계 -----------------------------------------------------------
    def _inherit(self, document, previous, snapshot, principal, checkpoint):
        """이전 snapshot의 application마다 match_specs → inherited application(proposed) 또는 불일치 기록."""
        with self.db.connect() as conn:
            apps = rows(
                conn,
                "SELECT a.*, p.profile_name, p.status profile_status, p.schema_id sid FROM parsing_application a JOIN parsing_profile p ON p.profile_id=a.profile_id WHERE a.snapshot_id=? ORDER BY a.created_at",
                (previous["snapshot_id"],),
            )
            prev_by_name, prev_by_id = self._sheets(conn, previous["snapshot_id"])
            plans = [self._inherit_plan(conn, app, prev_by_id) for app in apps]
        inherited, incompatible = [], []
        for app, plan in zip(apps, plans):
            checkpoint(force=True)
            try:
                result = self._read(
                    document["provider"],
                    principal,
                    "match_specs",
                    {"source_ref": document["source_path"], "expected_token": snapshot["change_token"], "specs": plan["specs"], "bindings_hint": plan["bindings"]},
                    checkpoint,
                )
            except Cancelled:
                raise
            except Problem as exc:
                result = {"compatibility": "incompatible", "missing": ["*"], "error": exc.code, "bindings": {}, "resolved": {}, "match_signature": None, "match_signature_json": None}
            if result.get("compatibility") == "incompatible":
                incompatible.append(
                    {
                        "snapshot_id": snapshot["snapshot_id"],
                        "profile_id": app["profile_id"],
                        "profile_name": app["profile_name"],
                        "previous_application_id": app["application_id"],
                        "missing": result.get("missing") or [],
                        "error": result.get("error"),
                    }
                )
                continue
            compatibility = "identical" if result["match_signature"] == plan["signature"] else "compatible"
            with self.db.connect(write=True) as conn:
                app_id = self._inherit_application(conn, app, plan, snapshot, result, compatibility, principal)
            inherited.append(
                {"application_id": app_id, "profile_id": app["profile_id"], "profile_name": app["profile_name"], "compatibility": compatibility, "state": "changed"}
            )
        return inherited, incompatible

    def _inherit_plan(self, conn, app, prev_by_id):
        """이전 헤드들의 spec·field·regions와 그 위치로 만든 기준 서명."""
        heads = rows(
            conn,
            "SELECT m.mapping_id, m.rule_id, r.rule_key, r.ordinal, v.mapping_revision_id, v.field_id, v.observed_key, v.effective_spec_json, v.status FROM mapping m JOIN parsing_rule r ON r.rule_id=m.rule_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.application_id=? ORDER BY r.ordinal,r.rule_key",
            (app["application_id"],),
        )
        heads = [h for h in heads if h["mapping_revision_id"]]
        region_rows = rows(
            conn,
            "SELECT mr.mapping_revision_id, mr.role, mr.ordinal, sr.sheet_id, sr.locator_key FROM mapping_region mr JOIN source_region sr ON sr.region_id=mr.region_id WHERE mr.mapping_revision_id IN (%s) ORDER BY mr.mapping_revision_id, mr.role, mr.ordinal"
            % ",".join("?" for _ in heads),
            tuple(h["mapping_revision_id"] for h in heads),
        ) if heads else []
        located = {}
        for r in region_rows:
            sheet = prev_by_id.get(r["sheet_id"])
            if sheet:
                located.setdefault(r["mapping_revision_id"], {}).setdefault(r["role"], []).append(f"{sheet['sheet_name']}!{r['locator_key']}")
        signature_rows = []
        for h in heads:
            spec = load(h["effective_spec_json"])
            h["spec"] = spec
            locs = located.get(h["mapping_revision_id"], {})
            signature_rows.append([h["rule_key"], _primary_role(spec), *(_flatten(locs.get(role) or []) for role in ROLES)])
        signature_rows.sort(key=lambda row: row[0])
        bindings = {}
        for r in conn.execute(
            "SELECT a.role_key, s.sheet_name FROM application_sheet a JOIN sheet s ON s.sheet_id=a.sheet_id WHERE a.application_id=? ORDER BY a.role_key,a.ordinal",
            (app["application_id"],),
        ):
            bindings.setdefault(r["role_key"], []).append(r["sheet_name"])
        return {"heads": heads, "specs": [h["spec"] for h in heads], "bindings": bindings, "signature": signature_of(signature_rows)}

    def _inherit_application(self, conn, app, plan, snapshot, result, compatibility, principal):
        by_name, _ = self._sheets(conn, snapshot["snapshot_id"])
        profile = {"profile_id": app["profile_id"], "schema_id": app["schema_id"], "current_rev": app["profile_rev"], "schema_rev": app["schema_rev"]}
        app_id = self._insert_application(conn, snapshot, profile, result.get("bindings") or {}, "inherited", compatibility, result["match_signature"], result.get("match_signature_json"), by_name)
        cache = {}
        for head in plan["heads"]:
            regions = self._regions_from_resolved(conn, snapshot["snapshot_id"], by_name, (result.get("resolved") or {}).get(head["rule_key"]), cache)
            evidence = {
                "previous_application_id": app["application_id"],
                "previous_revision_id": head["mapping_revision_id"],
                "compatibility": compatibility,
                "previous_signature": plan["signature"],
                "new_signature": result["match_signature"],
            }
            self._insert_mapping(
                conn,
                app_id,
                snapshot["snapshot_id"],
                head["rule_id"],
                {"field_id": head["field_id"], "observed_key": head["observed_key"], "spec": head["spec"], "status": "proposed", "origin": "inherited", "evidence": evidence, "created_by": principal},
                regions,
            )
        return app_id

    # ---- 수동 적용(§6 POST /snapshots/{sid}/applications) -------------------------------------
    def apply_profile(self, snapshot_id, profile_id, sheet_bindings=None, principal=None, checkpoint=lambda *a, **k: None):
        """origin='manual', compatibility='manual', 리비전 proposed/origin profile. 바인딩 생략 시 Reader match. draft 허용."""
        principal = principal or self.principal
        with self.db.connect() as conn:
            snapshot = dict(one(conn, "SELECT s.*, d.provider, d.source_path, d.document_name FROM document_snapshot s JOIN document d ON d.document_id=s.document_id WHERE s.snapshot_id=?", (snapshot_id,), "snapshot을 찾을 수 없습니다."))
            profile = self._profile_row(conn, profile_id)
            if profile["status"] == "deprecated":
                raise Problem("PROFILE_DEPRECATED", "폐기된 프로파일은 적용할 수 없습니다.")
            if conn.execute("SELECT 1 FROM parsing_application WHERE snapshot_id=? AND profile_id=? AND scope_key='default'", (snapshot_id, profile_id)).fetchone():
                raise Problem("ALREADY_APPLIED", "이 프로파일은 이미 이 snapshot에 적용되어 있습니다.", 409)
            by_name, by_id = self._sheets(conn, snapshot_id)
            canonical, specs, rules = self._profile_specs(conn, profile)
        if sheet_bindings:
            bindings = self._validate_bindings(sheet_bindings, canonical["sheet_roles"], by_id)
            result = self._read(
                snapshot["provider"], principal, "match_specs",
                {"source_ref": snapshot["source_path"], "expected_token": snapshot["change_token"], "specs": list(specs.values()), "bindings_hint": bindings},
                checkpoint,
            )
            result["bindings"] = bindings
        else:
            matches = self._read(
                snapshot["provider"], principal, "match",
                {"source_ref": snapshot["source_path"], "expected_token": snapshot["change_token"], "profiles": [self._reader_profile(profile)]},
                checkpoint,
            )
            result = matches[0] if matches else {}
            unbound = [m for m in result.get("missing") or [] if isinstance(m, dict) and "rule_key" not in m]
            if unbound or set(canonical["sheet_roles"]) - set(result.get("bindings") or {}):
                raise Problem("SHEET_ROLE_UNBOUND", "시트 역할을 문서의 시트에 연결할 수 없습니다. sheet_bindings를 지정하세요.", 422, unbound or None)

        def decide(rule):
            evidence = {"compatibility": result.get("compatibility"), "profile_rev": profile["current_rev"], "match_signature": result.get("match_signature")}
            return "proposed", "profile", evidence, rule["default_field_id"]

        with self.db.connect(write=True) as conn:
            app_id, _, _ = self._create_application(conn, snapshot, profile, result, "manual", "manual", principal, decide)
        self.refresh_document_status(snapshot["document_id"])
        return self.application_summary(app_id)

    def _validate_bindings(self, sheet_bindings, sheet_roles, by_id):
        if set(sheet_bindings) != set(sheet_roles):
            raise Problem("SHEET_ROLE_MISMATCH", "프로파일의 모든 시트 역할을 연결하세요.", 422, sorted(set(sheet_roles) - set(sheet_bindings)))
        out = {}
        for role, ids in sheet_bindings.items():
            if not isinstance(ids, list) or not ids or len(ids) != len(set(ids)) or any(i not in by_id for i in ids):
                raise Problem("INVALID_SHEET_BINDING", "이 snapshot의 시트를 역할별로 선택하세요.")
            if sheet_roles[role].get("cardinality", "one") == "one" and len(ids) != 1:
                raise Problem("INVALID_SHEET_BINDING", f"시트 역할 {role}에는 한 시트만 연결할 수 있습니다.")
            out[role] = [by_id[i]["sheet_name"] for i in ids]
        return out

    # ---- 매핑 조회 ----------------------------------------------------------------------
    def _application_row(self, conn, application_id):
        return one(
            conn,
            "SELECT a.*, d.document_id, d.document_name, d.provider, d.source_path, s.revision_no, s.captured_at, s.change_token, p.profile_name, p.current_rev profile_current_rev, p.status profile_status, sc.schema_key, sc.schema_name FROM parsing_application a JOIN document_snapshot s ON s.snapshot_id=a.snapshot_id JOIN document d ON d.document_id=s.document_id JOIN parsing_profile p ON p.profile_id=a.profile_id JOIN parsing_schema sc ON sc.schema_id=a.schema_id WHERE a.application_id=?",
            (application_id,),
            "적용 건을 찾을 수 없습니다.",
        )

    def _value_run(self, conn, app):
        if app["published_run_id"]:
            return app["published_run_id"]
        row = conn.execute(
            "SELECT run_id FROM extraction_run WHERE application_id=? AND status='succeeded' ORDER BY started_at DESC, run_id DESC LIMIT 1", (app["application_id"],)
        ).fetchone()
        return row["run_id"] if row else None

    def _regions_of_revisions(self, conn, revision_ids):
        if not revision_ids:
            return {}
        out = {}
        for r in conn.execute(
            "SELECT mr.mapping_revision_id, mr.role, mr.ordinal, sr.region_id, sr.sheet_id, s.sheet_name, sr.locator_key range FROM mapping_region mr JOIN source_region sr ON sr.region_id=mr.region_id JOIN sheet s ON s.sheet_id=sr.sheet_id WHERE mr.mapping_revision_id IN (%s) ORDER BY mr.mapping_revision_id, CASE mr.role WHEN 'key' THEN 0 WHEN 'value' THEN 1 WHEN 'unit' THEN 2 WHEN 'context' THEN 3 WHEN 'record_key' THEN 4 ELSE 5 END, mr.ordinal"
            % ",".join("?" for _ in revision_ids),
            tuple(revision_ids),
        ):
            out.setdefault(r["mapping_revision_id"], []).append({"role": r["role"], "ordinal": r["ordinal"], "region_id": r["region_id"], "sheet_id": r["sheet_id"], "sheet_name": r["sheet_name"], "range": r["range"]})
        return out

    def _first_regions(self, conn, value_ids):
        """value_id → 첫 값 영역(role value 우선, 없으면 input)."""
        if not value_ids:
            return {}
        out = {}
        for r in conn.execute(
            "SELECT er.value_id, er.role, er.ordinal, sr.sheet_id, s.sheet_name, sr.locator_key range FROM extracted_value_region er JOIN source_region sr ON sr.region_id=er.region_id JOIN sheet s ON s.sheet_id=sr.sheet_id WHERE er.value_id IN (%s) AND er.role IN ('value','input') ORDER BY er.value_id, CASE er.role WHEN 'value' THEN 0 ELSE 1 END, er.ordinal"
            % ",".join("?" for _ in value_ids),
            tuple(value_ids),
        ):
            out.setdefault(r["value_id"], {"sheet_id": r["sheet_id"], "sheet_name": r["sheet_name"], "range": r["range"]})
        return out

    def _mapping_rows(self, conn, application_id, run_id, mapping_id=None):
        where, params = "m.application_id=?", [application_id]
        if mapping_id:
            where, params = where + " AND m.mapping_id=?", [application_id, mapping_id]
        heads = rows(
            conn,
            "SELECT m.mapping_id, m.edit_seq, m.current_revision_id, r.rule_key, r.rule_name, r.ordinal, v.mapping_revision_id, v.revision_no, v.status, v.origin, v.observed_key, v.effective_spec_json, v.field_id, f.field_key, f.field_name, f.value_type, f.canonical_unit "
            f"FROM mapping m JOIN parsing_rule r ON r.rule_id=m.rule_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id LEFT JOIN parsing_field f ON f.field_id=v.field_id WHERE {where} ORDER BY r.ordinal, r.rule_key",
            tuple(params),
        )
        regions = self._regions_of_revisions(conn, [h["mapping_revision_id"] for h in heads if h["mapping_revision_id"]])
        values = {}
        wanted = {h["mapping_revision_id"] for h in heads if h["mapping_revision_id"]}
        if run_id and wanted:
            # 실행당 두 문장: 리비전별 (개수, 첫 값 id) → 첫 값 행. 인덱스 value_by_run_revision로 O(리비전).
            stats = [
                s
                for s in rows(
                    conn,
                    "SELECT g.mapping_revision_id, count(*) n, "
                    "(SELECT v.value_id FROM extracted_value v WHERE v.run_id=g.run_id AND v.mapping_revision_id=g.mapping_revision_id ORDER BY v.group_key, v.item_index, v.value_id LIMIT 1) first_id "
                    "FROM extracted_value g WHERE g.run_id=? GROUP BY g.mapping_revision_id",
                    (run_id,),
                )
                if s["mapping_revision_id"] in wanted
            ]
            if stats:
                by_id = {
                    r["value_id"]: r
                    for r in rows(conn, "SELECT * FROM extracted_value WHERE value_id IN (%s)" % ",".join("?" for _ in stats), tuple(s["first_id"] for s in stats))
                }
                values = {s["mapping_revision_id"]: (by_id[s["first_id"]], s["n"]) for s in stats if s["first_id"] in by_id}
            firsts = self._first_regions(conn, [v[0]["value_id"] for v in values.values()])
        out = []
        for h in heads:
            summary = None
            if h["mapping_revision_id"] in values:
                first, count = values[h["mapping_revision_id"]]
                summary = {
                    "value_id": first["value_id"],
                    "value_text": first["value_text"],
                    "display_text": first["display_text"],
                    "unit_normalized": first["unit_normalized"],
                    "value_type": first["value_type"],
                    "value_state": first["value_state"],
                    "count": count,
                    "first_region": firsts.get(first["value_id"]),
                }
            out.append(
                {
                    "mapping_id": h["mapping_id"],
                    "rule_key": h["rule_key"],
                    "rule_name": h["rule_name"],
                    "field": _field_public(h),
                    "observed_key": h["observed_key"],
                    "status": h["status"],
                    "origin": h["origin"],
                    "effective_spec": load(h["effective_spec_json"]),
                    "regions": [{k: r[k] for k in ("role", "sheet_id", "sheet_name", "range")} for r in regions.get(h["mapping_revision_id"], [])],
                    "revision_no": h["revision_no"] or 0,
                    "edit_seq": h["edit_seq"],
                    "value": summary,
                }
            )
        return out

    def application_summary(self, application_id):
        """GET /applications/{aid}: Source Review 진입 집계(요청 1회)."""
        with self.db.connect() as conn:
            app = self._application_row(conn, application_id)
            run_id = self._value_run(conn, app)
            mappings = self._mapping_rows(conn, application_id, run_id)
            sheets = rows(
                conn,
                "SELECT s.sheet_id, s.sheet_name, s.ordinal, group_concat(a.role_key) roles FROM sheet s LEFT JOIN application_sheet a ON a.sheet_id=s.sheet_id AND a.application_id=? WHERE s.snapshot_id=? GROUP BY s.sheet_id ORDER BY s.ordinal",
                (application_id, app["snapshot_id"]),
            )
        return {
            "application_id": application_id,
            "origin": app["origin"],
            "compatibility": app["compatibility"],
            "published": bool(app["published_run_id"]),
            "heads_approved": sum(m["status"] == "approved" for m in mappings),
            "heads_total": len(mappings),
            "document": {"document_id": app["document_id"], "document_name": app["document_name"]},
            "snapshot": {"snapshot_id": app["snapshot_id"], "revision_no": app["revision_no"], "captured_at": app["captured_at"]},
            "profile": {"profile_id": app["profile_id"], "profile_name": app["profile_name"], "rev": app["profile_rev"], "current_rev": app["profile_current_rev"], "status": app["profile_status"]},
            # §7 스키마 표기 `{schema_name} v{rev}` — 이 application이 본 schema_rev를 함께 준다(프로파일 ref와 같은 모양).
            "schema": {"schema_key": app["schema_key"], "schema_name": app["schema_name"], "rev": app["schema_rev"]},
            "sheets": [{"sheet_id": s["sheet_id"], "sheet_name": s["sheet_name"], "ordinal": s["ordinal"], "roles": sorted(set((s["roles"] or "").split(","))) if s["roles"] else []} for s in sheets],
            "mappings": mappings,
        }

    def application_mappings(self, application_id):
        with self.db.connect() as conn:
            app = self._application_row(conn, application_id)
            return self._mapping_rows(conn, application_id, self._value_run(conn, app))

    def mapping(self, mapping_id):
        with self.db.connect() as conn:
            row = one(conn, "SELECT application_id FROM mapping WHERE mapping_id=?", (mapping_id,), "매핑을 찾을 수 없습니다.")
            app = self._application_row(conn, row["application_id"])
            items = self._mapping_rows(conn, app["application_id"], self._value_run(conn, app), mapping_id)
        return {**items[0], "application_id": app["application_id"]}

    def mapping_revisions(self, mapping_id):
        with self.db.connect() as conn:
            one(conn, "SELECT mapping_id FROM mapping WHERE mapping_id=?", (mapping_id,), "매핑을 찾을 수 없습니다.")
            revs = rows(
                conn,
                "SELECT v.*, r.rule_key, r.rule_name, f.field_key, f.field_name, f.value_type, f.canonical_unit FROM mapping_revision v JOIN mapping m ON m.mapping_id=v.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id LEFT JOIN parsing_field f ON f.field_id=v.field_id WHERE v.mapping_id=? ORDER BY v.revision_no DESC",
                (mapping_id,),
            )
            regions = self._regions_of_revisions(conn, [r["mapping_revision_id"] for r in revs])
        return [
            {
                "mapping_id": mapping_id,
                "mapping_revision_id": r["mapping_revision_id"],
                "rule_key": r["rule_key"],
                "rule_name": r["rule_name"],
                "field": _field_public(r),
                "observed_key": r["observed_key"],
                "status": r["status"],
                "origin": r["origin"],
                "effective_spec": load(r["effective_spec_json"]),
                "regions": [{k: x[k] for k in ("role", "sheet_id", "sheet_name", "range")} for x in regions.get(r["mapping_revision_id"], [])],
                "revision_no": r["revision_no"],
                "evidence": load(r["evidence_json"]),
                "reason": r["reason"],
                "created_by": r["created_by"],
                "created_at": r["created_at"],
            }
            for r in revs
        ]

    # ---- 검수(§4.5) ---------------------------------------------------------------------
    def _mapping_context(self, conn, mapping_id):
        row = one(
            conn,
            "SELECT m.*, r.rule_key, r.default_field_id, r.profile_id, a.snapshot_id snap, a.schema_id, a.profile_rev, a.published_run_id, s.document_id, v.mapping_revision_id head_id, v.status head_status, v.field_id head_field_id, v.observed_key head_observed_key, v.effective_spec_json head_spec FROM mapping m JOIN parsing_rule r ON r.rule_id=m.rule_id JOIN parsing_application a ON a.application_id=m.application_id JOIN document_snapshot s ON s.snapshot_id=a.snapshot_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.mapping_id=?",
            (mapping_id,),
            "매핑을 찾을 수 없습니다.",
        )
        return row

    def _resolve_field(self, conn, ctx, field_key, status):
        """§4.5 필드 결정 순서: 명시 field_key → 이전 헤드 field_id → rule default_field_id. approved면 필수."""
        if field_key is not None:
            field = conn.execute(
                "SELECT field_id,value_type,status FROM parsing_field WHERE schema_id=? AND field_key=?", (ctx["schema_id"], field_key)
            ).fetchone()
            if not field or field["status"] != "active":
                raise Problem("UNKNOWN_FIELD", f"스키마에 없는(또는 폐기된) 필드 {field_key!r}입니다.")
            if field["value_type"] == "group":
                raise Problem("GROUP_FIELD_TARGET", f"묶음 필드 {field_key!r}에는 값을 추출할 수 없습니다.")
            return field["field_id"]
        field_id = ctx["head_field_id"] or ctx["default_field_id"]
        if status == "approved" and not field_id:
            raise Problem("FIELD_REQUIRED", "승인하려면 이 규칙이 저장할 스키마 필드를 지정하세요.")
        return field_id

    def _effective_spec(self, conn, ctx, given, head_spec):
        """클라이언트가 준 effective_spec(앵커 인라인)을 이름 앵커로 되돌려 검증한 뒤 다시 compile한다."""
        if given is None:
            return copy.deepcopy(head_spec)
        if not isinstance(given, dict):
            raise Problem("INVALID_RULE", "effective_spec는 객체여야 합니다.")
        rule, anchors = copy.deepcopy(given), {}

        def register(area_like, hint):
            # 클라이언트 JSON은 형태를 보장하지 않으므로 여기서 422로 거른다(KeyError/TypeError → 500 금지).
            name = area_like.get("anchor_name") or hint
            if not isinstance(name, str) or not name:
                raise Problem("INVALID_RULE", f"{hint}: anchor_name은 문자열이어야 합니다.")
            if not isinstance(area_like.get("sheet_role"), str):
                raise Problem("INVALID_RULE", f"{hint}: 앵커 영역에 sheet_role이 필요합니다.")
            if "all_of" in area_like:
                members = []
                if not isinstance(area_like["all_of"], list) or not area_like["all_of"]:
                    raise Problem("INVALID_RULE", f"{hint}: all_of는 앵커 목록이어야 합니다.")
                for n, member in enumerate(area_like["all_of"]):
                    if not isinstance(member, dict):
                        raise Problem("INVALID_RULE", f"{hint}: all_of 항목은 객체여야 합니다.")
                    mname = f"{name}.{n}"
                    anchors[mname] = {"sheet_role": area_like["sheet_role"], "find": validate_find(member.get("find"), f"앵커 {mname}")}
                    members.append(mname)
                anchors[name] = {"sheet_role": area_like["sheet_role"], "all_of": members}
            else:
                anchors[name] = {"sheet_role": area_like["sheet_role"], "find": validate_find(area_like.get("find"), f"앵커 {name}")}
            return name

        selector = rule.get("selector") if isinstance(rule.get("selector"), dict) else {}
        try:
            for role, selection in selector.items():
                areas = selection.get("areas") if isinstance(selection, dict) else None
                if areas is not None and not isinstance(areas, list):
                    raise Problem("INVALID_RULE", f"{role}.areas는 배열이어야 합니다.")
                for n, area in enumerate(areas or []):
                    if not isinstance(area, dict):
                        continue
                    if "all_of" in area or ("find" in area and "anchor_name" in area):
                        name = register(area, f"{role}{n}")
                        areas[n] = {"sheet_role": area.get("sheet_role"), "anchor": name}
                    elif isinstance(area.get("relative"), dict) and isinstance(area["relative"].get("anchor"), dict):
                        inner = area["relative"]["anchor"]
                        inner.setdefault("sheet_role", area.get("sheet_role"))
                        area["relative"]["anchor"] = register(inner, f"{role}{n}.base")
        except (KeyError, TypeError, AttributeError):
            raise Problem("INVALID_RULE", "effective_spec의 selector 형태가 유효하지 않습니다.") from None
        rule.pop("anchor_name", None)
        rule["rule_key"] = ctx["rule_key"]
        rule["relations"] = head_spec.get("relations") or []
        if "field_key" in rule:
            rule.pop("field_key")
        roles = self.profile_canonical(ctx["profile_id"], ctx["profile_rev"])["sheet_roles"]
        fields = self.schema_fields(one(conn, "SELECT schema_key FROM parsing_schema WHERE schema_id=?", (ctx["schema_id"],))["schema_key"], conn)
        canonical = validate_rule(rule, roles, anchors, fields)
        canonical["relations"] = head_spec.get("relations") or []
        return compile_rule(canonical, anchors)

    def _regions_input(self, conn, ctx, regions):
        by_role = {}
        for item in regions:
            role, sheet_id, range_text = item["role"], item["sheet_id"], item["range"]
            if role not in ("key", "value", "unit", "context", "record_key"):
                raise Problem("INVALID_REGION", "영역 역할은 key/value/unit/context/record_key 중 하나여야 합니다.")
            if not conn.execute("SELECT 1 FROM sheet WHERE sheet_id=? AND snapshot_id=?", (sheet_id, ctx["snap"])).fetchone():
                raise Problem("INVALID_REGION", "이 snapshot의 시트를 지정하세요.")
            by_role.setdefault(role, []).append((sheet_id, range_text))
        out, cache = [], {}
        for role, items in by_role.items():
            for n, (sheet_id, range_text) in enumerate(items):
                out.append((role, n, ensure_region(conn, ctx["snap"], sheet_id, range_text, cache)))
        return out

    def _copy_regions(self, conn, revision_id):
        return [
            (r["role"], r["ordinal"], r["region_id"])
            for r in conn.execute("SELECT role,ordinal,region_id FROM mapping_region WHERE mapping_revision_id=? ORDER BY role,ordinal", (revision_id,))
        ]

    def revise(self, mapping_id, expected_seq, status, field_key=None, effective_spec=None, regions=None, reason=None, extract=True, principal=None, wait=DEFAULT_WAIT):
        """§4.5 새 리비전(revision_no = expected_seq + 1, CAS) + 헤드 갱신 + (전부 approved면) 추출."""
        principal = principal or self.principal
        if status not in ("proposed", "approved", "rejected"):
            raise Problem("INVALID_APPROVAL", "status는 proposed/approved/rejected 중 하나여야 합니다.")
        with self.db.connect(write=True) as conn:
            ctx = self._mapping_context(conn, mapping_id)
            if ctx["edit_seq"] != expected_seq:
                raise Problem("EDIT_CONFLICT", "다른 수정이 먼저 저장되었습니다. 최신 매핑을 다시 확인하세요.", 409)
            head_spec = load(ctx["head_spec"]) or {}
            field_id = self._resolve_field(conn, ctx, field_key, status)
            spec = self._effective_spec(conn, ctx, effective_spec, head_spec)
            region_rows = self._regions_input(conn, ctx, regions) if regions is not None else (self._copy_regions(conn, ctx["head_id"]) if ctx["head_id"] else [])
            new_id = uid()
            self._insert_revision(
                conn,
                mapping_id,
                ctx["snap"],
                expected_seq + 1,
                new_id,
                {"field_id": field_id, "observed_key": ctx["head_observed_key"], "spec": spec, "status": status, "origin": "manual", "evidence": {"previous_revision_id": ctx["head_id"]}, "created_by": principal, "reason": reason or "원본 영역/필드 검수"},
                region_rows,
            )
            application_id, document_id = ctx["application_id"], ctx["document_id"]
        self.refresh_document_status(document_id)
        result = self.mapping(mapping_id)
        result["extraction"] = self._extract_if_ready(application_id, principal, wait) if extract and status == "approved" else None
        return result

    def _all_heads_approved(self, conn, application_id):
        row = conn.execute(
            "SELECT count(*) total, sum(CASE WHEN v.status='approved' THEN 1 ELSE 0 END) approved FROM mapping m LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.application_id=?",
            (application_id,),
        ).fetchone()
        return row["total"] > 0 and row["approved"] == row["total"]

    def _extract_if_ready(self, application_id, principal, wait):
        with self.db.connect() as conn:
            ready = self._all_heads_approved(conn, application_id)
        return self.extract(application_id, principal, wait) if ready else None

    def approve_all(self, application_id, reason=None, extract=True, principal=None, wait=DEFAULT_WAIT):
        """proposed 헤드 전부를 approved 리비전으로 복제(같은 spec·field·regions, origin manual) 후 추출."""
        principal = principal or self.principal
        approved, skipped = 0, []
        with self.db.connect(write=True) as conn:
            app = self._application_row(conn, application_id)
            heads = rows(
                conn,
                "SELECT m.mapping_id, m.edit_seq, m.snapshot_id, r.rule_key, r.default_field_id, v.mapping_revision_id, v.status, v.field_id, v.observed_key, v.effective_spec_json FROM mapping m JOIN parsing_rule r ON r.rule_id=m.rule_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.application_id=? ORDER BY r.ordinal",
                (application_id,),
            )
            for h in heads:
                if h["status"] != "proposed":
                    if h["status"] != "approved":
                        skipped.append({"mapping_id": h["mapping_id"], "rule_key": h["rule_key"], "reason": h["status"] or "missing"})
                    continue
                field_id = h["field_id"] or h["default_field_id"]
                if not field_id:
                    skipped.append({"mapping_id": h["mapping_id"], "rule_key": h["rule_key"], "reason": "FIELD_REQUIRED"})
                    continue
                self._insert_revision(
                    conn,
                    h["mapping_id"],
                    h["snapshot_id"],
                    h["edit_seq"] + 1,
                    uid(),
                    {"field_id": field_id, "observed_key": h["observed_key"], "spec": load(h["effective_spec_json"]), "status": "approved", "origin": "manual", "evidence": {"previous_revision_id": h["mapping_revision_id"], "approve_all": True}, "created_by": principal, "reason": reason or "일괄 승인"},
                    self._copy_regions(conn, h["mapping_revision_id"]),
                )
                approved += 1
        self.refresh_document_status(app["document_id"])
        extraction = self._extract_if_ready(application_id, principal, wait) if extract else None
        return {"application_id": application_id, "approved": approved, "skipped": skipped, "extraction": extraction}

    def rollback(self, mapping_id, expected_seq, target_revision_id, reason=None, principal=None):
        """과거 리비전을 복제한 새 리비전(status·field·spec·regions 그대로, origin manual)."""
        principal = principal or self.principal
        with self.db.connect(write=True) as conn:
            ctx = self._mapping_context(conn, mapping_id)
            if ctx["edit_seq"] != expected_seq:
                raise Problem("EDIT_CONFLICT", "다른 수정이 먼저 저장되었습니다. 최신 매핑을 다시 확인하세요.", 409)
            target = one(conn, "SELECT * FROM mapping_revision WHERE mapping_revision_id=? AND mapping_id=?", (target_revision_id, mapping_id), "복원할 리비전을 찾을 수 없습니다.")
            self._insert_revision(
                conn,
                mapping_id,
                ctx["snap"],
                expected_seq + 1,
                uid(),
                {"field_id": target["field_id"], "observed_key": target["observed_key"], "spec": load(target["effective_spec_json"]), "status": target["status"], "origin": "manual", "evidence": {"rollback_of": target_revision_id, "previous_revision_id": ctx["head_id"]}, "created_by": principal, "reason": reason or f"리비전 #{target['revision_no']} 복원"},
                self._copy_regions(conn, target_revision_id),
            )
            document_id = ctx["document_id"]
        self.refresh_document_status(document_id)
        return self.mapping(mapping_id)

    # ---- 추출(§4.6) --------------------------------------------------------------------
    def prepare_extraction(self, conn, run_id, application_id, auto_approved=0):
        """extraction_run(queued) + manifest(mapping_id 키). 헤드가 전부 approved가 아니면 422 REVIEW_REQUIRED."""
        app = one(conn, "SELECT * FROM parsing_application WHERE application_id=?", (application_id,), "적용 건을 찾을 수 없습니다.")
        heads = rows(
            conn,
            "SELECT m.mapping_id, m.current_revision_id, r.rule_key, v.status FROM mapping m JOIN parsing_rule r ON r.rule_id=m.rule_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.application_id=? ORDER BY r.ordinal",
            (application_id,),
        )
        unapproved = [{"rule_key": h["rule_key"], "status": h["status"] or "missing"} for h in heads if h["status"] != "approved"]
        if unapproved or not heads:
            raise Problem("REVIEW_REQUIRED", "모든 규칙의 매핑을 승인한 뒤 추출하세요.", 422, unapproved)
        bindings = {}
        for r in conn.execute("SELECT role_key, sheet_id FROM application_sheet WHERE application_id=? ORDER BY role_key, ordinal", (application_id,)):
            bindings.setdefault(r["role_key"], []).append(r["sheet_id"])
        manifest = {
            "mappings": {h["mapping_id"]: {"revision_id": h["current_revision_id"], "rule_key": h["rule_key"]} for h in heads},
            "bindings": bindings,
            "engine": {
                "version": ENGINE_VERSION,
                "python": platform.python_version(),
                "openpyxl": package_version("openpyxl"),
                "reader_revision": env("READER_REVISION", "unversioned-operator-adapter"),
            },
        }
        insert(
            conn,
            "extraction_run",
            run_id=run_id,
            application_id=application_id,
            snapshot_id=app["snapshot_id"],
            schema_rev=app["schema_rev"],
            profile_rev=app["profile_rev"],
            engine_version=ENGINE_VERSION,
            input_manifest_json=dump(manifest),
            status="queued",
            started_at=now(),
            auto_approved=1 if auto_approved else 0,
        )
        return {"application_id": application_id, "run_id": run_id}

    def extract(self, application_id, principal=None, wait=DEFAULT_WAIT):
        """POST /applications/{aid}/extract: 작업 제출(+wait)."""
        principal = principal or self.principal
        with self.db.connect() as conn:
            app = self._application_row(conn, application_id)
        job = self.jobs.submit(
            "extract",
            {"application_id": application_id},
            principal,
            uid(),
            prepare=lambda conn, jid, payload: self.prepare_extraction(conn, jid, payload["application_id"]),
            target_kind="application",
            target_id=application_id,
            label=f"{app['document_name']} · {app['profile_name']} v{app['profile_rev']}",
        )
        return self.job_result(job, wait, principal)

    def _extract_now(self, application_id, principal, checkpoint, auto_approved=0):
        """같은 작업 안에서 즉시 추출(§4.3 자동 승인·§4.9). 실패는 실행 행에 남기고 작업은 계속한다."""
        run_id = uid()

        def heartbeat(*_, **kw):
            # 부모 작업(등록·재파싱)의 completed/total은 문서 단위이므로 값 개수로 덮어쓰지 않는다.
            checkpoint(force=kw.get("force", False))

        try:
            with self.db.connect(write=True) as conn:
                payload = self.prepare_extraction(conn, run_id, application_id, auto_approved)
            return self.execute_extraction(payload, principal, heartbeat)
        except Cancelled as exc:
            self._finish_run_failed(run_id, exc)
            raise
        except Problem as exc:
            self._finish_run_failed(run_id, exc)
            return {"run_id": run_id, "application_id": application_id, "error": {"code": exc.code, "message": exc.message}}

    def _finish_run_failed(self, run_id, exc):
        with self.db.connect(write=True) as conn:
            run = conn.execute("SELECT r.status, s.document_id FROM extraction_run r JOIN document_snapshot s ON s.snapshot_id=r.snapshot_id WHERE r.run_id=?", (run_id,)).fetchone()
            if not run or run["status"] not in ("queued", "running"):
                return
            conn.execute(
                "UPDATE extraction_run SET status=?,finished_at=?,error_summary=? WHERE run_id=?",
                ("cancelled" if exc.code == "CANCELLED" else "failed", now(), f"{exc.code}: {exc.message}", run_id),
            )
        self.refresh_document_status(run["document_id"])

    def execute_extraction(self, payload, principal, checkpoint):
        run_id = payload["run_id"]
        with self.db.connect() as conn:
            run = one(
                conn,
                "SELECT r.*, s.change_token, s.document_id, d.provider, d.source_path FROM extraction_run r JOIN document_snapshot s ON s.snapshot_id=r.snapshot_id JOIN document d ON d.document_id=s.document_id WHERE r.run_id=?",
                (run_id,),
                "파싱 실행을 찾을 수 없습니다.",
            )
            manifest = load(run["input_manifest_json"])
            revision_ids = [m["revision_id"] for m in manifest["mappings"].values()]
            revisions = rows(
                conn,
                "SELECT v.mapping_revision_id, v.field_id, v.effective_spec_json, r.rule_key FROM mapping_revision v JOIN mapping m ON m.mapping_id=v.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id WHERE v.mapping_revision_id IN (%s)"
                % ",".join("?" for _ in revision_ids),
                tuple(revision_ids),
            )
            by_name, by_id = self._sheets(conn, run["snapshot_id"])
        if run["status"] != "queued":
            raise Problem("INVALID_RUN_STATE", "이미 시작되었거나 끝난 파싱 실행입니다.", 409)
        by_rule = {r["rule_key"]: r for r in revisions}
        if len(by_rule) != len(revision_ids):
            raise Problem("MAPPING_CHANGED", "실행 입력의 리비전을 찾을 수 없습니다.", 409)
        bindings = {role: [by_id[s]["sheet_name"] for s in ids if s in by_id] for role, ids in manifest["bindings"].items()}
        specs = [load(r["effective_spec_json"]) for r in revisions]
        with self.db.connect(write=True) as conn:
            conn.execute("UPDATE extraction_run SET status='running',started_at=? WHERE run_id=?", (now(), run_id))
        groups, count, verified, cache = {}, 0, False, {}
        for event in self._stream(
            run["provider"],
            principal,
            "extract",
            {"source_ref": run["source_path"], "expected_token": run["change_token"], "specs": specs, "bindings": bindings},
            checkpoint,
        ):
            checkpoint(count)
            kind = event.get("type") if isinstance(event, dict) else None
            if kind == "verified":
                verified = event.get("token") == run["change_token"]
                continue
            if verified:
                raise Problem("INVALID_READER_CONTRACT", "검증 완료 뒤에 추출값이 추가되었습니다.")
            if kind == "group":
                revision = by_rule.get(event.get("rule_key"))
                sheet = by_name.get(event.get("primary_sheet"))
                if not revision or not sheet or event.get("group_key") in groups:
                    raise Problem("INVALID_READER_CONTRACT", "규칙/반복 블록이 유효하지 않습니다.")
                groups[event["group_key"]] = (revision, f"{event['rule_key']}|{sheet['sheet_id']}|{event.get('anchor_locator')}", event.get("regions") or {})
            elif kind == "values":
                if event.get("group_key") not in groups or not isinstance(event.get("items"), list) or len(event["items"]) > VALUE_BATCH:
                    raise Problem("INVALID_READER_CONTRACT", "추출 항목 배치가 유효하지 않습니다.")
                count += len(event["items"])
                if count > RUN_VALUE_LIMIT:
                    raise Problem("RUN_ITEM_LIMIT", "한 실행의 값 한도(1,000,000)를 초과했습니다.", 413)
                with self.db.connect(write=True) as conn:
                    self._store_values(conn, run, groups[event["group_key"]], event["items"], by_name, cache)
            else:
                raise Problem("INVALID_READER_CONTRACT", "알 수 없는 추출 이벤트입니다.")
        if not verified:
            raise Problem("UNVERIFIED_SOURCE", "읽기 종료 시 원본 snapshot이 확인되지 않았습니다.", 409)
        checkpoint(count, count, force=True)
        with self.db.connect(write=True) as conn:
            conn.execute("UPDATE extraction_run SET status='succeeded',finished_at=? WHERE run_id=?", (now(), run_id))
            try:
                conn.execute("UPDATE parsing_application SET published_run_id=? WHERE application_id=?", (run_id, run["application_id"]))
            except sqlite3.IntegrityError as exc:
                raise _integrity(exc) from None
        self.refresh_document_status(run["document_id"])
        return {"run_id": run_id, "application_id": run["application_id"], "snapshot_id": run["snapshot_id"], "group_count": len(groups), "value_count": count, "published": True}

    @staticmethod
    def _ensure_regions(conn, snapshot_id, pending, cache):
        """배치의 새 영역을 3문(INSERT OR IGNORE executemany + SELECT)으로 만든다(값마다 SELECT/INSERT 왕복 금지)."""
        stamp = now()
        conn.executemany(
            "INSERT OR IGNORE INTO source_region (region_id,snapshot_id,sheet_id,kind,locator_key,r1,c1,r2,c2,created_at) VALUES (?,?,?,'cells',?,?,?,?,?,?)",
            [(uid(), snapshot_id, sheet_id, key, r1, c1, r2, c2, stamp) for (sheet_id, key), (r1, c1, r2, c2) in pending.items()],
        )
        keys = list(pending)
        for start in range(0, len(keys), 400):
            chunk = keys[start : start + 400]
            for r in conn.execute(
                "SELECT sheet_id, locator_key, region_id FROM source_region WHERE kind='cells' AND sheet_id IN (%s) AND locator_key IN (%s)"
                % (",".join("?" for _ in {s for s, _ in chunk}), ",".join("?" for _ in chunk)),
                (*{s for s, _ in chunk}, *(k for _, k in chunk)),
            ):
                cache[(r["sheet_id"], r["locator_key"])] = r["region_id"]

    def _store_values(self, conn, run, group, items, by_name, cache):
        revision, group_key, _ = group
        spec = load(revision["effective_spec_json"])
        derivation_default = dump({"value_spec": spec.get("value_spec"), "combine": spec["selector"]["value"].get("combine", "ordered_union"), "record_spec": spec.get("record_spec")})
        value_rows, region_rows, stamp = [], [], now()
        located, pending = [], {}
        for item in items:
            regions = item.get("regions") or {}
            if sum(len(v) for v in regions.values()) > VALUE_REGION_LIMIT:
                raise Problem("ATOMIC_REGION_LIMIT", "한 값에 1,000개를 초과하는 출처가 있습니다. 결합을 나누세요.", 413)
            parts_of = []
            for role, parts in regions.items():
                for n, region in enumerate(parts):
                    sheet = by_name.get(region.get("sheet"))
                    if not sheet:
                        raise Problem("REGION_SHEET_MISMATCH", "원본 영역이 적용 건의 시트를 벗어났습니다.")
                    r1, c1, r2, c2 = bounds(region["range"])
                    key = (sheet["sheet_id"], address(r1, c1, r2, c2))
                    if key not in cache:
                        pending[key] = (r1, c1, r2, c2)
                    parts_of.append((role, n, key, [r1, c1, r2, c2]))
            located.append(parts_of)
        if pending:
            self._ensure_regions(conn, run["snapshot_id"], pending, cache)
        for item, parts_of in zip(items, located):
            vid, identities = uid(), []
            for role, n, key, box in parts_of:
                identities.append([role, n, key[0], box])
                region_rows.append((vid, run["snapshot_id"], cache[key], role, n))
            value_rows.append(
                (
                    vid, run["run_id"], run["snapshot_id"], revision["mapping_revision_id"], revision["field_id"], group_key,
                    item.get("record_key"), item.get("item_index"), item.get("raw_text"), item.get("display_text"), item.get("value_text"),
                    item.get("value_type") or spec.get("value_spec", {}).get("type", "text"), item.get("value_state") or "present",
                    item.get("unit_raw"), item.get("unit_normalized"), item.get("formula_state"),
                    dump([run["snapshot_id"], sorted(identities)]), item.get("derivation") or derivation_default, stamp,
                )
            )
        conn.executemany(
            "INSERT INTO extracted_value (value_id,run_id,snapshot_id,mapping_revision_id,field_id,group_key,record_key,item_index,raw_text,display_text,value_text,value_type,value_state,unit_raw,unit_normalized,formula_state,source_identity_key,derivation_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            value_rows,
        )
        conn.executemany("INSERT INTO extracted_value_region (value_id,snapshot_id,region_id,role,ordinal) VALUES (?,?,?,?,?)", region_rows)

    # ---- 프로파일 테스트(§4.7) --------------------------------------------------------------
    def test_profile(self, snapshot_id, profile_id=None, definition=None, schema_key=None, format="auto", principal=None, checkpoint=lambda *a, **k: None):
        """저장하지 않는 dry-run: match → compile → 엔진 → groups/errors. runtime_job kind='test' 행만 남긴다."""
        principal = principal or self.principal
        with self.db.connect() as conn:
            snapshot = dict(one(conn, "SELECT s.*, d.provider, d.source_path, d.document_name FROM document_snapshot s JOIN document d ON d.document_id=s.document_id WHERE s.snapshot_id=?", (snapshot_id,), "snapshot을 찾을 수 없습니다."))
            if profile_id:
                profile = self._profile_row(conn, profile_id)
                canonical = self.profile_canonical(profile_id, profile["current_rev"])
                fields = self.schema_fields(profile["schema_key"], conn)
                label, reference = f"{profile['profile_name']} r{profile['current_rev']} · {snapshot['document_name']}", self._reader_profile(profile)["reference"]
                rev = profile["current_rev"]
            else:
                fields = self.schema_fields(schema_key, conn)
                canonical, _ = to_canonical(definition, schema_key, fields, format or "auto")
                label, reference, rev = f"{canonical.get('profile_name') or '초안'} (미저장) · {snapshot['document_name']}", None, None
        jid = self.jobs.record_sync("test", principal, "profile" if profile_id else None, profile_id, label, {"snapshot_id": snapshot_id, "profile_id": profile_id})
        try:
            result = self._dry_run(snapshot, canonical, fields, reference, rev, principal, checkpoint)
        except Problem as exc:
            self.jobs.finish_sync(jid, error=exc)
            raise
        self.jobs.finish_sync(jid, {"errors": len(result["errors"]), "groups": len(result["groups"]), "compatibility": result["compatibility"]})
        return {**result, "job_id": jid}

    def _dry_run(self, snapshot, canonical, fields, reference, rev, principal, checkpoint):
        match = self._read(
            snapshot["provider"], principal, "match",
            {"source_ref": snapshot["source_path"], "expected_token": snapshot["change_token"], "profiles": [{"profile_id": None, "profile_rev": rev, "canonical": canonical, "reference": reference}]},
            checkpoint,
        )[0]
        out = {"bindings": match.get("bindings") or {}, "compatibility": match.get("compatibility"), "match_signature": match.get("match_signature"), "missing": match.get("missing") or [], "groups": [], "errors": []}
        if match.get("error"):
            out["errors"].append({"code": match["error"], "message": "문서를 읽는 동안 Reader 한도를 초과했습니다."})
        specs = compile_profile(canonical)
        by_rule = {r["rule_key"]: r for r in canonical["rules"]}
        if set(canonical["sheet_roles"]) - set(out["bindings"]):
            out["errors"].append({"code": "SHEET_NOT_FOUND", "message": "연결되지 않은 시트 역할이 있습니다: " + ", ".join(sorted(set(canonical["sheet_roles"]) - set(out["bindings"])))})
            return out
        groups, deadline = {}, time.monotonic() + TEST_TIMEOUT_SECONDS
        stream = self._stream(
            snapshot["provider"], principal, "extract",
            {"source_ref": snapshot["source_path"], "expected_token": snapshot["change_token"], "specs": list(specs.values()), "bindings": out["bindings"]},
            checkpoint,
        )
        try:
            for event in stream:
                if time.monotonic() > deadline:
                    out["errors"].append({"code": "TEST_TIMEOUT", "message": "20초 안에 끝나지 않아 지금까지의 결과만 보여 줍니다."})
                    break
                if event.get("type") == "group":
                    rule = by_rule.get(event["rule_key"], {})
                    field = fields.get(rule.get("field_key")) if rule.get("field_key") else None
                    groups[event["group_key"]] = {
                        "rule_key": event["rule_key"],
                        "field": {"key": rule["field_key"], "name": field.get("name"), "type": field.get("value_type"), "unit": field.get("unit")} if field else None,
                        "observed_key": event.get("observed_key"),
                        "primary_sheet": event.get("primary_sheet"),
                        "regions": {role: [{"sheet_name": r["sheet"], "range": r["range"]} for r in parts] for role, parts in (event.get("regions") or {}).items()},
                        "values": [],
                        "count": 0,
                    }
                elif event.get("type") == "values" and event.get("group_key") in groups:
                    group = groups[event["group_key"]]
                    for item in event["items"]:
                        group["count"] += 1
                        if len(group["values"]) < 50:
                            source = (item.get("regions") or {}).get("value") or (item.get("regions") or {}).get("input") or [{}]
                            group["values"].append({k: item.get(k) for k in ("item_index", "record_key", "raw_text", "display_text", "value_text", "value_type", "value_state", "unit_raw", "unit_normalized")} | {"sheet_name": source[0].get("sheet"), "range": source[0].get("range")})
        except Cancelled:
            raise
        except Problem as exc:
            out["errors"].append({"code": exc.code, "message": exc.message, "rule_key": _rule_key_of(exc.message, by_rule)})
        finally:
            stream.close()
        out["groups"] = list(groups.values())
        return out

    # ---- 프로파일 승인(§4.8) ---------------------------------------------------------------
    def approve_profile(self, profile_id, application_id, principal=None, checkpoint=lambda *a, **k: None):
        principal = principal or self.principal
        with self.db.connect() as conn:
            profile = self._profile_row(conn, profile_id)
            app = self._application_row(conn, application_id)
            if app["profile_id"] != profile_id or not conn.execute("SELECT 1 FROM document WHERE document_id=? AND current_snapshot_id=?", (app["document_id"], app["snapshot_id"])).fetchone():
                raise Problem("INVALID_APPLICATION", "이 프로파일이 적용된 문서의 현재 snapshot 적용 건을 지정하세요.")
            if not self._all_heads_approved(conn, application_id):
                raise Problem("REVIEW_REQUIRED", "대표 문서의 모든 규칙을 승인한 뒤 프로파일을 승인하세요.")
        signature = app["match_signature"]
        if app["profile_rev"] != profile["current_rev"]:
            # 참조 서명은 현재 rev로 계산돼야 하므로 대표 문서에서 match를 다시 돈다.
            profile_now = {**profile, "reference_signature": None}
            matches = self._read(app["provider"], principal, "match", {"source_ref": app["source_path"], "expected_token": app["change_token"], "profiles": [self._reader_profile(profile_now)]}, checkpoint)
            result = matches[0] if matches else {}
            if result.get("compatibility") not in ("identical", "compatible") or not result.get("match_signature"):
                raise Problem("REFERENCE_MISMATCH", "대표 문서가 현재 프로파일 리비전과 맞지 않습니다. 새 리비전으로 다시 검수하세요.", 422, result.get("missing"))
            signature = result["match_signature"]
        with self.db.connect(write=True) as conn:
            conn.execute(
                "UPDATE parsing_profile SET status='approved',reference_application_id=?,reference_profile_rev=?,reference_signature=?,updated_at=? WHERE profile_id=?",
                (application_id, profile["current_rev"], signature, now(), profile_id),
            )
        job = self.reparse(profile_id, "rematch", principal)
        return {"profile_id": profile_id, "status": "approved", "reference_application_id": application_id, "reference_profile_rev": profile["current_rev"], "reference_signature": signature, "reparse_job": job}

    # ---- 재파싱(§4.9) ------------------------------------------------------------------
    def reparse(self, profile_id, mode, principal=None, wait=0):
        principal = principal or self.principal
        if mode not in ("fill", "rematch"):
            raise Problem("INVALID_MODE", "mode는 fill/rematch 중 하나여야 합니다.")
        with self.db.connect() as conn:
            profile = self._profile_row(conn, profile_id)
        if profile["status"] != "approved":
            raise Problem("PROFILE_NOT_APPROVED", "승인된 프로파일만 재파싱할 수 있습니다.")
        job = self.jobs.submit(
            "reparse", {"profile_id": profile_id, "mode": mode}, principal, uid(), target_kind="profile", target_id=profile_id,
            label=f"{profile['profile_name']} v{profile['current_rev']} · {'재파싱(rematch)' if mode == 'rematch' else '재파싱(fill)'}",
        )
        return self.job_result(job, wait, principal)

    def execute_reparse(self, profile_id, mode, principal, checkpoint):
        app_where = "a.profile_id=? AND d.current_snapshot_id=a.snapshot_id"
        unmatched_where = "d.status='unmatched' AND NOT EXISTS (SELECT 1 FROM parsing_application a WHERE a.snapshot_id=d.current_snapshot_id AND a.profile_id=?)"
        with self.db.connect() as conn:
            profile = self._profile_row(conn, profile_id)
            if profile["status"] != "approved":
                raise Problem("PROFILE_NOT_APPROVED", "승인된 프로파일만 재파싱할 수 있습니다.")
            app_total = conn.execute("SELECT count(*) FROM parsing_application a JOIN document d ON d.current_snapshot_id=a.snapshot_id WHERE a.profile_id=?", (profile_id,)).fetchone()[0]
            unmatched_total = conn.execute(f"SELECT count(*) FROM document d WHERE {unmatched_where}", (profile_id,)).fetchone()[0] if mode == "rematch" else 0
        queued, skipped, total, n = 0, [], app_total + unmatched_total, 0
        # 적용 건은 (document_name, application_id) keyset으로 페이지마다 읽는다(메모리 O(페이지); 처리 중 정렬 키는 바뀌지 않는다).
        for agg in self._application_pages(app_where, (profile_id,)):
            checkpoint(n, total, force=True)
            n += 1
            outcome = self._reparse_application(profile, agg, mode, principal, checkpoint)
            if outcome is None:
                queued += 1
            else:
                skipped.append({"document_id": agg["document_id"], "document_name": agg["document_name"], "reason": outcome})
        if mode == "rematch":
            after = None
            while True:
                with self.db.connect() as conn:
                    batch = rows(
                        conn,
                        f"SELECT d.*, s.change_token FROM document d JOIN document_snapshot s ON s.snapshot_id=d.current_snapshot_id WHERE {unmatched_where}"
                        + (" AND (d.document_name, d.document_id) > (?,?)" if after else "")
                        + " ORDER BY d.document_name, d.document_id LIMIT ?",
                        (profile_id, *(after or ()), REPARSE_PAGE),
                    )
                for doc in batch:
                    checkpoint(n, total, force=True)
                    n += 1
                    outcome = self._reparse_unmatched(profile, doc, principal, checkpoint)
                    if outcome is None:
                        queued += 1
                    else:
                        skipped.append({"document_id": doc["document_id"], "document_name": doc["document_name"], "reason": outcome})
                if len(batch) < REPARSE_PAGE:
                    break
                after = (batch[-1]["document_name"], batch[-1]["document_id"])
        checkpoint(total, total, force=True)
        return {"queued": queued, "skipped": skipped}

    def _application_pages(self, where, params, size=REPARSE_PAGE):
        after = None
        while True:
            with self.db.connect() as conn:
                batch = self._application_aggregates(conn, where, params, after=after, limit=size)
            yield from batch
            if len(batch) < size:
                return
            after = (batch[-1]["document_name"], batch[-1]["application_id"])

    def _reparse_application(self, profile, agg, mode, principal, checkpoint):
        """반환 None = 처리(큐/추출/리비전), 문자열 = 건너뜀 사유."""
        all_approved = agg["heads_total"] and agg["unapproved"] == 0
        if (agg["inherited"] or 0) > 0:
            # §4.4 새 snapshot 승계는 사람이 approve_all로 검수한다. rematch가 대신 승인하지 않는다(decisions §1).
            return "review_required"
        if agg["published_run_id"] and all_approved and mode == "fill":
            return "published"
        if all_approved and not agg["published_run_id"] and (mode == "fill" or agg["profile_rev"] == profile["current_rev"]):
            # 헤드가 이미 현재 rev 스펙이면 재매치 없이 추출만 하면 된다. 오래된 rev는 rematch 경로에서 새 스펙을 받는다.
            self._extract_now(agg["application_id"], principal, checkpoint)
            return None
        if mode == "fill":
            return "review_required"
        if agg["published_run_id"] and all_approved and agg["profile_rev"] == profile["current_rev"]:
            return "up_to_date"
        with self.db.connect() as conn:
            app = self._application_row(conn, agg["application_id"])
        try:
            matches = self._read(app["provider"], principal, "match", {"source_ref": app["source_path"], "expected_token": app["change_token"], "profiles": [self._reader_profile(profile)]}, checkpoint)
        except Cancelled:
            raise
        except Problem as exc:
            return exc.code
        match = matches[0] if matches else {}
        if match.get("compatibility") not in ("identical", "compatible"):
            return "incompatible"
        with self.db.connect(write=True) as conn:
            changed = self._rematch_revisions(conn, profile, app, match, principal)
        self.refresh_document_status(app["document_id"])
        if changed is None:
            return "review_required"
        if match["compatibility"] == "identical":
            if changed == 0 and agg["published_run_id"]:
                return "up_to_date"
            # 자동 승인(origin auto) 뒤의 실행이므로 실패 큐가 '자동 승인 뒤 실패'로 표시할 수 있게 표시한다(§1.5).
            self._extract_now(agg["application_id"], principal, checkpoint, auto_approved=1)
            return None
        return None if changed else "review_required"

    def _rematch_revisions(self, conn, profile, app, match, principal):
        """identical → approved 리비전(새 rev 스펙, origin auto), compatible → proposed 리비전. 반환: 추가한 리비전 수(identical인데 필드 없음 = None)."""
        canonical, specs, rules = self._profile_specs(conn, profile)
        by_name, _ = self._sheets(conn, app["snapshot_id"])
        heads = {
            r["rule_id"]: dict(r)
            for r in conn.execute(
                "SELECT m.mapping_id, m.rule_id, m.edit_seq, v.mapping_revision_id, v.status, v.origin, v.field_id, v.observed_key, v.effective_spec_json FROM mapping m LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id WHERE m.application_id=?",
                (app["application_id"],),
            )
        }
        identical = match["compatibility"] == "identical"
        cache, added, blocked = {}, 0, False
        for rule in rules:
            head = heads.get(rule["rule_id"])
            if head is None:
                mid = uid()
                insert(conn, "mapping", mapping_id=mid, application_id=app["application_id"], snapshot_id=app["snapshot_id"], rule_id=rule["rule_id"], created_at=now())
                head = {"mapping_id": mid, "edit_seq": 0, "mapping_revision_id": None, "status": None, "origin": None, "field_id": None, "observed_key": None, "effective_spec_json": None}
            field_id = head["field_id"] or rule["default_field_id"]
            spec = specs[rule["rule_key"]]
            # identical은 승인 헤드(또는 사람 손을 거치지 않은 profile/auto 제안)를 새 rev 스펙으로 복제한다.
            # 승계(inherited)·수동 proposed·rejected 헤드는 검수 중이므로 proposed로만 올린다(§4.4·§4.9, decisions §1).
            auto_ok = head["status"] == "approved" or (head["status"] in (None, "proposed") and head.get("origin") in (None, "profile", "auto"))
            if identical and field_id and auto_ok:
                status, origin = "approved", "auto"
            else:
                status, origin = "proposed", "profile"
                if identical:
                    blocked = True
            if head["status"] == status and head["effective_spec_json"] and load(head["effective_spec_json"]) == spec and head["field_id"] == field_id:
                continue
            regions = self._regions_from_resolved(conn, app["snapshot_id"], by_name, (match.get("resolved") or {}).get(rule["rule_key"]), cache)
            evidence = {"rematch": True, "profile_rev": profile["current_rev"], "match_signature": match["match_signature"], "previous_revision_id": head["mapping_revision_id"], "reference_revision_id": None}
            if not identical or not field_id:
                evidence["reason"] = "FIELD_REQUIRED" if not field_id else match["compatibility"]
            self._insert_revision(
                conn, head["mapping_id"], app["snapshot_id"], head["edit_seq"] + 1, uid(),
                {"field_id": field_id, "observed_key": head["observed_key"], "spec": spec, "status": status, "origin": origin, "evidence": evidence, "created_by": principal, "reason": "프로파일 리비전 재매치"},
                regions,
            )
            added += 1
        return None if blocked else added

    def _reparse_unmatched(self, profile, doc, principal, checkpoint):
        try:
            matches = self._read(doc["provider"], principal, "match", {"source_ref": doc["source_path"], "expected_token": doc["change_token"], "profiles": [self._reader_profile(profile)]}, checkpoint)
        except Cancelled:
            raise
        except Problem as exc:
            return exc.code
        match = matches[0] if matches else {}
        if match.get("compatibility") not in ("identical", "compatible"):
            return "incompatible"
        with self.db.connect(write=True) as conn:
            snapshot = dict(one(conn, "SELECT * FROM document_snapshot WHERE snapshot_id=?", (doc["current_snapshot_id"],)))
            created = self.auto_apply(conn, snapshot, profile, match, principal)
        if created and created["extract"]:
            self._extract_now(created["application_id"], principal, checkpoint, auto_approved=1)
        self.refresh_document_status(doc["document_id"])
        return None if created else "already_applied"

    # ---- 문서 상태(§4.12) ------------------------------------------------------------------
    def _application_aggregates(self, conn, where, params, after=None, limit=None):
        """application별 헤드/실행 집계(문서 목록·상태·프로파일 문서 목록이 공유). after/limit는 (document_name, application_id) keyset."""
        order = "d.document_name, a.application_id" if (after or limit) else "d.document_name, a.created_at, a.application_id"
        if after:
            where, params = f"({where}) AND (d.document_name, a.application_id) > (?,?)", (*params, *after)
        tail = f" LIMIT {int(limit)}" if limit else ""
        return rows(
            conn,
            "SELECT a.application_id, a.snapshot_id, a.profile_id, a.compatibility, a.origin, a.published_run_id, a.profile_rev, a.created_at, "
            "p.profile_name, p.status profile_status, p.reference_application_id, ps.schema_key, ps.schema_name, d.document_id, d.document_name, d.status document_status, s.revision_no, s.captured_at, "
            "count(m.mapping_id) heads_total, "
            "sum(CASE WHEN v.status='approved' THEN 1 ELSE 0 END) heads_approved, "
            "sum(CASE WHEN v.status='proposed' AND v.origin='inherited' THEN 1 ELSE 0 END) inherited, "
            "sum(CASE WHEN m.current_revision_id IS NULL OR v.status<>'approved' THEN 1 ELSE 0 END) unapproved, "
            "(SELECT r.status FROM extraction_run r WHERE r.application_id=a.application_id ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1) last_run, "
            "(SELECT r.error_summary FROM extraction_run r WHERE r.application_id=a.application_id ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1) last_error, "
            "(SELECT max(r.finished_at) FROM extraction_run r WHERE r.application_id=a.application_id) last_finished "
            "FROM parsing_application a JOIN parsing_profile p ON p.profile_id=a.profile_id JOIN parsing_schema ps ON ps.schema_id=a.schema_id "
            "JOIN document_snapshot s ON s.snapshot_id=a.snapshot_id JOIN document d ON d.document_id=s.document_id "
            "LEFT JOIN mapping m ON m.application_id=a.application_id LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id "
            f"WHERE {where} GROUP BY a.application_id ORDER BY {order}{tail}",
            params,
        )

    def refresh_document_status(self, document_id):
        """§4.12 우선순위: locked → not_extracted(snapshot 없음) → unmatched → changed → review → failed → normal → (미추출) not_extracted."""
        with self.db.connect(write=True) as conn:
            doc = dict(one(conn, "SELECT * FROM document WHERE document_id=?", (document_id,), "문서를 찾을 수 없습니다."))
            detail = load(doc.get("status_detail_json"), {}) or {}
            apps = self._application_aggregates(conn, "a.snapshot_id=?", (doc["current_snapshot_id"],)) if doc["current_snapshot_id"] else []
            incompatible = [i for i in detail.get("incompatible") or [] if i.get("snapshot_id") == doc["current_snapshot_id"]]
            last_error, status = doc.get("last_error"), None
            if "locked" in detail:
                status = "locked"
            elif not doc["current_snapshot_id"]:
                status = "not_extracted"
            elif not apps and not incompatible:
                status = "unmatched"
            elif any((a["inherited"] or 0) > 0 for a in apps) or incompatible:
                status = "changed"
            elif any((a["unapproved"] or 0) > 0 or not a["heads_total"] for a in apps):
                status = "review"
            elif any(a["last_run"] in ("failed", "cancelled") for a in apps):
                status = "failed"
                last_error = next((a["last_error"] for a in apps if a["last_run"] in ("failed", "cancelled")), last_error)
            elif apps and all(a["published_run_id"] for a in apps):
                status = "normal"
            else:
                status = "not_extracted"
            finished = [a["last_finished"] for a in apps if a["last_finished"]]
            job_done = conn.execute(
                "SELECT max(finished_at) FROM runtime_job WHERE target_kind='document' AND target_id=? AND finished_at IS NOT NULL", (document_id,)
            ).fetchone()[0]
            stamps = [*finished, *([job_done] if job_done else []), *([doc["last_processed_at"]] if doc.get("last_processed_at") else [])]
            last_processed = max(stamps, default=None)
            new_detail = {
                "applications": len(apps),
                "unapproved": sum(a["unapproved"] or 0 for a in apps),
                "inherited": sum(a["inherited"] or 0 for a in apps),
                "failed": [a["application_id"] for a in apps if a["last_run"] in ("failed", "cancelled")],
                "incompatible": incompatible,
            }
            if "locked" in detail:
                new_detail["locked"] = detail["locked"]
            if status != "failed" and status != "locked":
                last_error = None
            conn.execute(
                "UPDATE document SET status=?,status_detail_json=?,last_processed_at=?,last_error=?,updated_at=? WHERE document_id=?",
                (status, dump(new_detail), last_processed, last_error, now(), document_id),
            )
        return {"document_id": document_id, "status": status, "detail": new_detail}

    # ---- 값 조회 ---------------------------------------------------------------------------
    def _value_public(self, r, regions, firsts):
        return {
            "value_id": r["value_id"],
            "application_id": r["application_id"],
            "profile_id": r["profile_id"],
            "rule_key": r["rule_key"],
            "rule_name": r["rule_name"] if "rule_name" in r.keys() else None,
            "field": {"key": r["field_key"], "name": r["field_name"], "type": r["field_type"], "unit": r["canonical_unit"]},
            "group_key": r["group_key"],
            "record_key": r["record_key"],
            "item_index": r["item_index"],
            "raw_text": r["raw_text"],
            "display_text": r["display_text"],
            "value_text": r["value_text"],
            "value_type": r["value_type"],
            "value_state": r["value_state"],
            "unit_raw": r["unit_raw"],
            "unit_normalized": r["unit_normalized"],
            "formula_state": r["formula_state"],
            "derivation_key": r["derivation_key"],
            "source": firsts.get(r["value_id"]),
            # 프런트(ValueRow.first_region)·매핑 행(value.first_region)과 같은 이름으로도 준다.
            "first_region": firsts.get(r["value_id"]),
            "regions": regions.get(r["value_id"], []),
        }

    def _value_regions(self, conn, value_ids):
        if not value_ids:
            return {}
        out = {}
        for r in conn.execute(
            "SELECT er.value_id, er.role, er.ordinal, sr.region_id, sr.sheet_id, s.sheet_name, sr.locator_key range FROM extracted_value_region er JOIN source_region sr ON sr.region_id=er.region_id JOIN sheet s ON s.sheet_id=sr.sheet_id WHERE er.value_id IN (%s) ORDER BY er.value_id, CASE er.role WHEN 'key' THEN 0 WHEN 'value' THEN 1 WHEN 'unit' THEN 2 WHEN 'context' THEN 3 WHEN 'record_key' THEN 4 ELSE 5 END, er.ordinal"
            % ",".join("?" for _ in value_ids),
            tuple(value_ids),
        ):
            out.setdefault(r["value_id"], []).append({"role": r["role"], "ordinal": r["ordinal"], "region_id": r["region_id"], "sheet_id": r["sheet_id"], "sheet_name": r["sheet_name"], "range": r["range"]})
        return out

    def _value_page(self, conn, run_ids, filters, params, cursor, limit, scope):
        """실행 목록 안의 값을 (run_id, group_key, item_index, value_id) keyset으로 넘긴다(인덱스 value_by_run_group)."""
        limit = max(1, min(int(limit or 50), 200))
        if not run_ids:
            return {"items": [], "has_more": False, "next_cursor": None}
        where = ["v.run_id IN (%s)" % ",".join("?" for _ in run_ids), *filters]
        args = [*run_ids, *params]
        after = decode_cursor(cursor, scope, 4)
        if after:
            where.append("(v.run_id, v.group_key, v.item_index, v.value_id) > (?,?,?,?)")
            args.extend(after)
        found = rows(
            conn,
            "SELECT v.*, a.application_id, a.profile_id, r.rule_key, r.rule_name, f.field_key, f.field_name, f.value_type field_type, f.canonical_unit "
            "FROM extracted_value v JOIN extraction_run x ON x.run_id=v.run_id JOIN parsing_application a ON a.application_id=x.application_id "
            "JOIN mapping_revision mr ON mr.mapping_revision_id=v.mapping_revision_id JOIN mapping m ON m.mapping_id=mr.mapping_id "
            "JOIN parsing_rule r ON r.rule_id=m.rule_id JOIN parsing_field f ON f.field_id=v.field_id "
            f"WHERE {' AND '.join(where)} ORDER BY v.run_id, v.group_key, v.item_index, v.value_id LIMIT ?",
            (*args, limit + 1),
        )
        result = page(found, limit, ("run_id", "group_key", "item_index", "value_id"), scope)
        ids = [r["value_id"] for r in result["items"]]
        regions, firsts = self._value_regions(conn, ids), {}
        for vid in ids:
            first = next((x for x in regions.get(vid, []) if x["role"] == "value"), None) or next((x for x in regions.get(vid, []) if x["role"] == "input"), None)
            if first:
                firsts[vid] = {k: first[k] for k in ("sheet_id", "sheet_name", "range")}
        result["items"] = [self._value_public(r, regions, firsts) for r in result["items"]]
        return result

    def snapshot_values(self, snapshot_id, field_key=None, rule_key=None, cursor=None, limit=50):
        """GET /snapshots/{sid}/values: 발행된 실행의 값(필드/규칙 필터, keyset)."""
        with self.db.connect() as conn:
            one(conn, "SELECT snapshot_id FROM document_snapshot WHERE snapshot_id=?", (snapshot_id,), "snapshot을 찾을 수 없습니다.")
            run_ids = [r["published_run_id"] for r in conn.execute("SELECT published_run_id FROM parsing_application WHERE snapshot_id=? AND published_run_id IS NOT NULL ORDER BY created_at", (snapshot_id,))]
            filters, params = [], []
            if field_key:
                filters.append("f.field_key=?")
                params.append(field_key)
            if rule_key:
                filters.append("r.rule_key=?")
                params.append(rule_key)
            return self._value_page(conn, run_ids, filters, params, cursor, limit, ["snapshot", snapshot_id, field_key, rule_key])

    def application_values(self, application_id, rule_key=None, cursor=None, limit=50):
        with self.db.connect() as conn:
            app = self._application_row(conn, application_id)
            run_id = self._value_run(conn, app)
            filters, params = ([], [])
            if rule_key:
                filters.append("r.rule_key=?")
                params.append(rule_key)
            return self._value_page(conn, [run_id] if run_id else [], filters, params, cursor, limit, ["application", application_id, rule_key])

    def value(self, value_id):
        with self.db.connect() as conn:
            row = one(
                conn,
                "SELECT v.*, m.mapping_id, a.application_id, a.profile_id, a.published_run_id, r.rule_key, r.rule_name, f.field_key, f.field_name, f.value_type field_type, f.canonical_unit, d.document_id, d.document_name, s.revision_no, s.captured_at "
                "FROM extracted_value v JOIN extraction_run x ON x.run_id=v.run_id JOIN parsing_application a ON a.application_id=x.application_id JOIN mapping_revision mr ON mr.mapping_revision_id=v.mapping_revision_id "
                "JOIN mapping m ON m.mapping_id=mr.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id JOIN parsing_field f ON f.field_id=v.field_id "
                "JOIN document_snapshot s ON s.snapshot_id=v.snapshot_id JOIN document d ON d.document_id=s.document_id WHERE v.value_id=?",
                (value_id,),
                "값을 찾을 수 없습니다.",
            )
            regions = self._value_regions(conn, [value_id])
            firsts = self._first_regions(conn, [value_id])
        out = self._value_public(row, regions, firsts)
        # 실행 ID는 사용자에게 보이지 않는다(§7); 매핑 ID는 '검수 열기'의 문서화된 핸들이라 남긴다.
        out.update(document={"document_id": row["document_id"], "document_name": row["document_name"]}, snapshot={"snapshot_id": row["snapshot_id"], "revision_no": row["revision_no"], "captured_at": row["captured_at"]}, mapping_id=row["mapping_id"], published=row["published_run_id"] == row["run_id"])
        return out

    def region_values(self, region_id, limit=200):
        """GET /regions/{rid}/values: 이 셀(영역)에서 나온 값과 이 영역을 참조하는 매핑(역방향 조회)."""
        limit = max(1, min(int(limit or 200), 500))
        with self.db.connect() as conn:
            region = one(conn, "SELECT sr.*, s.sheet_name FROM source_region sr JOIN sheet s ON s.sheet_id=sr.sheet_id WHERE sr.region_id=?", (region_id,), "원본 위치를 찾을 수 없습니다.")
            values = rows(
                conn,
                "SELECT v.value_id, er.role, (a.published_run_id = v.run_id) published, a.application_id, r.rule_key, f.field_key, f.field_name, v.value_text, v.display_text, v.value_state, v.record_key, v.item_index "
                "FROM extracted_value_region er JOIN extracted_value v ON v.value_id=er.value_id JOIN extraction_run x ON x.run_id=v.run_id JOIN parsing_application a ON a.application_id=x.application_id "
                "JOIN mapping_revision mr ON mr.mapping_revision_id=v.mapping_revision_id JOIN mapping m ON m.mapping_id=mr.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id JOIN parsing_field f ON f.field_id=v.field_id "
                "WHERE er.region_id=? ORDER BY (a.published_run_id = v.run_id) DESC, v.created_at DESC LIMIT ?",
                (region_id, limit),
            )
            # 매핑은 값보다 넓은 영역(C9:C73)을 참조하므로 "이 셀을 참조하는 매핑"은 같은 시트에서 교차하는 영역으로 찾는다.
            mappings = rows(
                conn,
                "SELECT mr.role, v.mapping_id, v.status, v.revision_no, (m.current_revision_id = v.mapping_revision_id) is_head, m.application_id, r.rule_key, r.rule_name, sr.locator_key range "
                "FROM source_region sr JOIN mapping_region mr ON mr.region_id=sr.region_id "
                "JOIN mapping_revision v ON v.mapping_revision_id=mr.mapping_revision_id JOIN mapping m ON m.mapping_id=v.mapping_id JOIN parsing_rule r ON r.rule_id=m.rule_id "
                "WHERE sr.sheet_id=? AND sr.kind='cells' AND sr.r1<=? AND sr.c1<=? AND sr.r2>=? AND sr.c2>=? ORDER BY is_head DESC, v.created_at DESC LIMIT ?",
                (region["sheet_id"], region["r2"], region["c2"], region["r1"], region["c1"], limit),
            )
        return {
            "region": {"region_id": region["region_id"], "snapshot_id": region["snapshot_id"], "sheet_id": region["sheet_id"], "sheet_name": region["sheet_name"], "kind": region["kind"], "range": region["locator_key"]},
            "values": [{**v, "published": bool(v["published"]), "field": {"key": v.pop("field_key"), "name": v.pop("field_name")}} for v in values],
            "mappings": [{**m, "is_head": bool(m["is_head"])} for m in mappings],
        }

    def sheet_regions(self, sheet_id, range_text=None, limit=500):
        """GET /sheets/{sheet_id}/regions?range=: 범위와 교차하는 원본 위치(+참조 매핑·값 수)."""
        limit = max(1, min(int(limit or 500), 2000))
        with self.db.connect() as conn:
            sheet = one(conn, "SELECT * FROM sheet WHERE sheet_id=?", (sheet_id,), "시트를 찾을 수 없습니다.")
            where, params = ["sr.sheet_id=?"], [sheet_id]
            if range_text:
                r1, c1, r2, c2 = bounds(range_text)
                where.append("sr.r1<=? AND sr.c1<=? AND sr.r2>=? AND sr.c2>=?")
                params.extend([r2, c2, r1, c1])
            found = rows(
                conn,
                "SELECT sr.region_id, sr.kind, sr.locator_key range, sr.r1, sr.c1, sr.r2, sr.c2, "
                "(SELECT count(*) FROM mapping_region mr JOIN mapping m ON m.current_revision_id=mr.mapping_revision_id WHERE mr.region_id=sr.region_id) mapping_count, "
                "(SELECT count(*) FROM extracted_value_region er WHERE er.region_id=sr.region_id) value_count "
                f"FROM source_region sr WHERE {' AND '.join(where)} ORDER BY sr.r1, sr.c1 LIMIT ?",
                (*params, limit),
            )
        return {"sheet": {"sheet_id": sheet_id, "sheet_name": sheet["sheet_name"], "snapshot_id": sheet["snapshot_id"]}, "range": range_text, "items": found}

    # ---- 문서 조회 ---------------------------------------------------------------------
    SORTS = {"document_name": "d.document_name", "status": "d.status", "last_processed_at": "coalesce(d.last_processed_at,'')"}

    def document_query(self, q=None, status=None, profile_id=None, schema_key=None, sort=None, cursor=None, limit=50):
        """GET /documents: 필터 + 정렬 + keyset + 페이지 범위 요약(SQL 2문)."""
        limit = max(1, min(int(limit or 50), 200))
        sort = sort or "-last_processed_at"
        desc = sort.startswith("-")
        column = self.SORTS.get(sort.lstrip("-+"))
        if column is None:
            raise Problem("INVALID_SORT", "정렬은 document_name/status/last_processed_at 중 하나입니다.")
        where, params = [], []
        if q:
            where.append("d.document_name LIKE ? ESCAPE '\\'")
            params.append("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if status:
            where.append("d.status=?")
            params.append(status)
        if profile_id:
            where.append("EXISTS (SELECT 1 FROM parsing_application a WHERE a.snapshot_id=d.current_snapshot_id AND a.profile_id=?)")
            params.append(profile_id)
        if schema_key:
            where.append("EXISTS (SELECT 1 FROM parsing_application a JOIN parsing_schema ps ON ps.schema_id=a.schema_id WHERE a.snapshot_id=d.current_snapshot_id AND ps.schema_key=?)")
            params.append(schema_key)
        scope = ["documents", q, status, profile_id, schema_key, sort]
        after = decode_cursor(cursor, scope, 2)
        if after:
            where.append(f"({column}, d.document_id) {'<' if desc else '>'} (?,?)")
            params.extend(after)
        direction = "DESC" if desc else "ASC"
        with self.db.connect() as conn:
            found = rows(
                conn,
                f"SELECT d.*, {column} sort_key, s.revision_no, s.captured_at, s.change_token, s.content_sha256 FROM document d LEFT JOIN document_snapshot s ON s.snapshot_id=d.current_snapshot_id "
                f"{'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {column} {direction}, d.document_id {direction} LIMIT ?",
                (*params, limit + 1),
            )
            result = page(found, limit, ("sort_key", "document_id"), scope)
            snapshot_ids = [d["current_snapshot_id"] for d in result["items"] if d["current_snapshot_id"]]
            aggs = self._application_aggregates(conn, "a.snapshot_id IN (%s)" % ",".join("?" for _ in snapshot_ids), tuple(snapshot_ids)) if snapshot_ids else []
        result["items"] = [self._document_public(d, [a for a in aggs if a["snapshot_id"] == d["current_snapshot_id"]]) for d in result["items"]]
        return result

    @staticmethod
    def _document_public(d, aggs):
        schemas = {}
        for a in aggs:
            schemas.setdefault(a["schema_key"], {"schema_key": a["schema_key"], "schema_name": a["schema_name"]})
        return {
            "document_id": d["document_id"],
            "document_name": d["document_name"],
            "provider": d["provider"],
            "source_path": d["source_path"],
            "file_type": d["file_type"],
            "status": d["status"],
            "status_detail": load(d.get("status_detail_json")),
            "current_snapshot": {"snapshot_id": d["current_snapshot_id"], "revision_no": d["revision_no"], "captured_at": d["captured_at"], "change_token": d["change_token"], "content_sha256": d["content_sha256"]} if d["current_snapshot_id"] else None,
            "profiles": [
                {"profile_id": a["profile_id"], "profile_name": a["profile_name"], "rev": a["profile_rev"], "application_id": a["application_id"], "state": _app_state(a), "compatibility": a["compatibility"], "origin": a["origin"]}
                for a in aggs
            ],
            "schemas": list(schemas.values()),
            "last_processed_at": d["last_processed_at"],
            "last_error": d["last_error"],
            "created_at": d["created_at"],
            "updated_at": d["updated_at"],
        }

    def document(self, document_id):
        with self.db.connect() as conn:
            d = one(conn, "SELECT d.*, s.revision_no, s.captured_at, s.change_token, s.content_sha256 FROM document d LEFT JOIN document_snapshot s ON s.snapshot_id=d.current_snapshot_id WHERE d.document_id=?", (document_id,), "문서를 찾을 수 없습니다.")
            aggs = self._application_aggregates(conn, "a.snapshot_id=?", (d["current_snapshot_id"],)) if d["current_snapshot_id"] else []
        return self._document_public(d, aggs)

    def document_snapshots(self, document_id):
        with self.db.connect() as conn:
            one(conn, "SELECT document_id FROM document WHERE document_id=?", (document_id,), "문서를 찾을 수 없습니다.")
            return rows(conn, "SELECT s.*, (SELECT count(*) FROM parsing_application a WHERE a.snapshot_id=s.snapshot_id) application_count FROM document_snapshot s WHERE s.document_id=? ORDER BY s.revision_no DESC", (document_id,))

    def snapshot_sheets(self, snapshot_id):
        with self.db.connect() as conn:
            one(conn, "SELECT snapshot_id FROM document_snapshot WHERE snapshot_id=?", (snapshot_id,), "snapshot을 찾을 수 없습니다.")
            return rows(conn, "SELECT * FROM sheet WHERE snapshot_id=? ORDER BY ordinal", (snapshot_id,))

    def snapshot_applications(self, snapshot_id):
        with self.db.connect() as conn:
            one(conn, "SELECT snapshot_id FROM document_snapshot WHERE snapshot_id=?", (snapshot_id,), "snapshot을 찾을 수 없습니다.")
            aggs = self._application_aggregates(conn, "a.snapshot_id=?", (snapshot_id,))
        return [{**a, "state": _app_state(a), "published": bool(a["published_run_id"])} for a in aggs]

    def profile_documents(self, profile_id, cursor=None, limit=50):
        """GET /profiles/{id}/documents: 현재 snapshot에 이 프로파일이 적용된 문서((document_name, application_id) keyset 페이지)."""
        limit = max(1, min(int(limit or 50), 200))
        scope = ["profile-documents", profile_id]
        after = decode_cursor(cursor, scope, 2)
        with self.db.connect() as conn:
            profile = self._profile_row(conn, profile_id)
            aggs = self._application_aggregates(conn, "a.profile_id=? AND d.current_snapshot_id=a.snapshot_id", (profile_id,), after=after, limit=limit + 1)
        result = page(aggs, limit, ("document_name", "application_id"), scope)
        result["items"] = [
            {
                "document_id": a["document_id"],
                "document_name": a["document_name"],
                "snapshot": {"snapshot_id": a["snapshot_id"], "revision_no": a["revision_no"], "captured_at": a["captured_at"]},
                "application_id": a["application_id"],
                "profile_rev": a["profile_rev"],
                "origin": a["origin"],
                "compatibility": a["compatibility"],
                "heads_approved": a["heads_approved"] or 0,
                "heads_total": a["heads_total"] or 0,
                "published": bool(a["published_run_id"]),
                "is_reference": a["application_id"] == profile["reference_application_id"],
                "state": _app_state(a),
                "document_status": a["document_status"],
            }
            for a in result["items"]
        ]
        return result

    # ---- 검색·상태 ---------------------------------------------------------------------
    def search(self, q, per_kind=5):
        """GET /search: 문서·프로파일·스키마·필드 각 최대 5건."""
        text = (q or "").strip()
        if not text:
            return {"items": []}
        like = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        nlike = "%" + norm(text).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        items = []
        with self.db.connect() as conn:
            for r in conn.execute("SELECT document_id,document_name,status FROM document WHERE document_name LIKE ? ESCAPE '\\' ORDER BY document_name LIMIT ?", (like, per_kind)):
                items.append({"kind": "document", "id": r["document_id"], "label": r["document_name"], "sublabel": r["status"], "route": f"?screen=documents&document={r['document_id']}"})
            for r in conn.execute("SELECT p.profile_id,p.profile_name,p.status,p.current_rev,s.schema_name FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.profile_name LIKE ? ESCAPE '\\' ORDER BY p.profile_name LIMIT ?", (like, per_kind)):
                items.append({"kind": "profile", "id": r["profile_id"], "label": f"{r['profile_name']} v{r['current_rev']}", "sublabel": f"{r['schema_name']} · {r['status']}", "route": f"?screen=profiles&profile={r['profile_id']}"})
            for r in conn.execute("SELECT schema_key,schema_name,current_rev FROM parsing_schema WHERE schema_name LIKE ? ESCAPE '\\' OR schema_key LIKE ? ESCAPE '\\' ORDER BY schema_name LIMIT ?", (like, like, per_kind)):
                items.append({"kind": "schema", "id": r["schema_key"], "label": f"{r['schema_name']} v{r['current_rev']}", "sublabel": r["schema_key"], "route": f"?screen=schema&schema={r['schema_key']}"})
            for r in conn.execute(
                "SELECT DISTINCT f.field_id,f.field_key,f.field_name,f.value_type,s.schema_key,s.schema_name FROM parsing_field f JOIN parsing_schema s ON s.schema_id=f.schema_id LEFT JOIN parsing_alias a ON a.field_id=f.field_id "
                "WHERE f.field_name LIKE ? ESCAPE '\\' OR f.field_key LIKE ? ESCAPE '\\' OR a.alias_norm LIKE ? ESCAPE '\\' ORDER BY f.field_name LIMIT ?",
                (like, like, nlike, per_kind),
            ):
                items.append({"kind": "field", "id": r["field_key"], "label": f"{r['field_name']} ({r['field_key']})", "sublabel": f"{r['schema_name']} · {r['value_type']}", "route": f"?screen=schema&schema={r['schema_key']}&field={r['field_key']}", "schema_key": r["schema_key"]})
        return {"items": items}

    def status(self):
        with self.db.connect() as conn:
            counts = {
                "documents": conn.execute("SELECT count(*) FROM document").fetchone()[0],
                "profiles": conn.execute("SELECT count(*) FROM parsing_profile").fetchone()[0],
                "schemas": conn.execute("SELECT count(*) FROM parsing_schema").fetchone()[0],
                "jobs_running": conn.execute("SELECT count(*) FROM runtime_job WHERE state IN ('queued','running')").fetchone()[0],
                "review": conn.execute("SELECT count(*) FROM document WHERE status IN ('review','changed')").fetchone()[0],
            }
        # 절대 경로는 서버 파일 배치를 드러내므로 작업 공간 이름만 준다.
        return {"version": "3", "workspace": self.root.name, "counts": counts}
