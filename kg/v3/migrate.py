"""v2 워크스페이스(`data/kg/v2.db`) → v3 워크스페이스 이관 (계약 §9).

v2는 읽기 전용(mode=ro)으로만 열고, v3 정의(스키마·프로파일)는 Service를 통해 파일+projection으로 쓴다.
문서·snapshot·시트·영역·리비전·실행·값은 v2의 ID를 그대로 써서(모두 UUID) 보고서 없이도 대응이 드러난다.
값(extracted_value)은 옮긴 뒤에도 불변이며, 새 snapshot·재추출은 v3 런타임이 맡는다.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from contextlib import closing, nullcontext
from pathlib import Path

from kg.v2.spec import address

from .adapters import to_canonical
from .db import Problem, digest, dump, load, norm, now, uid
from .profile import ROLES, compile_rule, validate_rule
from .service import (
    FIELD_TYPES,
    KEY_RE,
    STRUCTURE_ALGORITHM,
    TYPE_ALIASES,
    _normalize_signature,
    ensure_region,
    validate_schema_definition,
)

V2_DB = "data/kg/v2.db"
SCHEMA_KEY = "migrated_kg"
SCHEMA_NAME = "이관 KG (v2)"
REPORT_FORMAT = "v2-migration-report/1"
SIGNATURE_MIGRATED = "migrated"
VALUE_BATCH = 500
LIST_LIMIT = 2000
VALUE_STATES = {"present": "present", "blank": "empty", "missing": "null", "excel_error": "error", "unavailable": "error"}
FORMULA_STATES = {"missing_cache": "cached_missing"}
SERIES_ROLES = ("key", "value", "unit", "context", "record_key")
TABLES = (
    "document", "document_snapshot", "sheet", "source_region", "snapshot_signature",
    "parsing_schema", "parsing_field", "parsing_alias", "parsing_field_edge",
    "parsing_profile", "parsing_rule", "template_version",
    "parsing_application", "application_sheet", "mapping", "mapping_revision", "mapping_region",
    "extraction_run", "extracted_value", "extracted_value_region", "published_run", "build_manifest",
)
REQUIRED_TABLES = {
    "kg_revision", "domain_concept", "domain_alias", "domain_edge", "document", "document_version", "sheet",
    "source_region", "template", "template_version", "template_rule", "template_application", "application_sheet",
    "mapping_revision", "mapping_head", "extraction_run", "run_mapping", "extracted_series", "series_region",
    "extracted_item", "item_region", "integration_project", "integration_version", "integration_field",
    "integration_source", "build_run", "build_input",
}


def _readonly(path):
    conn = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def field_key_of(concept_id, taken):
    """concept_id → field_key. 계약의 키 문법(영문·숫자·_.-, 64자)에 맞지 않으면 치환 + 해시 접미사."""
    if KEY_RE.match(concept_id) and concept_id not in taken:
        return concept_id
    base = re.sub(r"[^A-Za-z0-9_.\-]+", "_", concept_id).strip("_") or "field"
    suffix = hashlib.sha256(concept_id.encode()).hexdigest()[:8]
    key = f"{base[:64 - 9]}_{suffix}"
    n = 2
    while key in taken:
        key = f"{base[:64 - 12]}_{suffix}_{n}"
        n += 1
    return key


class Migration:
    def __init__(self, ws, from_ws, raw=None, dry_run=False, principal="v2-migration"):
        self.ws = Path(ws).resolve()
        self.from_ws = Path(from_ws).resolve()
        self.v2_path = self.from_ws / V2_DB
        self.raw = Path(raw).resolve() if raw else self.from_ws / "data/raw"
        self.v3_raw = self.ws / "data/raw"
        self.dry = dry_run
        self.principal = principal
        self.service = None
        self.v2 = None
        # 계획 상태(dry-run에서도 채운다)
        self.fields = None  # {field_key: {field_id, value_type, status, name, unit, aliases}}
        self.concept_field = {}  # concept_id → field_key
        self.templates = {}  # template_id → {profile_id, profile_name, rules{rule_key: rule_id}, canonical, roles, latest}
        self.docs = {}  # document_id → {row, versions{vid: row}, sheets{sheet_id: name}, available}
        self.region_alias = {}  # v2 region_id → v3 region_id (중복 병합 시 대표 영역)
        self.revisions = {}  # v2 mapping_revision_id → {field_id, mapping_id, rule_key}
        self.mappings = {}  # (application_id, rule_key) → mapping_id
        self.applications = {}  # application_id → {document_id, snapshot_id, profile_id, v2_published_run_id}
        self.runs = set()
        self.report = {
            "format": REPORT_FORMAT,
            "source_db": str(self.v2_path),
            "workspace": str(self.ws),
            "raw_dir": str(self.raw),
            "dry_run": dry_run,
            "principal": principal,
            "started_at": now(),
            "finished_at": None,
            "schema": None,
            "profiles": [],
            "counts": {t: {"migrated": 0, "skipped": 0} for t in TABLES},
            "skipped": [],
            "review_required": [],
            "re_extract_required": [],
            "asset_values": {"count": 0, "value_ids": []},
            "raw": {"checked": 0, "available": 0, "changed": 0, "missing": 0, "copied": 0, "reader_errors": 0},
            "documents": {},
            "warnings": [],
            "truncated": {},
        }

    # ------------------------------------------------------------------ 보고서 도우미
    def _count(self, table, status="migrated", n=1):
        self.report["counts"][table][status] += n

    def _append(self, key, item):
        items = self.report[key]
        if len(items) >= LIST_LIMIT:
            self.report["truncated"][key] = self.report["truncated"].get(key, 0) + 1
            return
        items.append(item)

    def _skip(self, table, ident, reason, n=1):
        self._count(table, "skipped", n)
        self._append("skipped", {"table": table, "id": ident, "reason": reason})

    def _warn(self, code, message):
        self._append("warnings", {"code": code, "message": message})

    # ------------------------------------------------------------------ v3 접근
    def _v3(self, write=False):
        if self.service is not None:
            return self.service.db.connect(write=write)
        path = self.ws / "data/kg/v3.db"
        if not path.is_file():
            return nullcontext(None)
        return closing(_readonly(path))

    def _exists(self, table, column, value):
        with self._v3() as conn:
            if conn is None:
                return False
            return conn.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (value,)).fetchone() is not None

    def _reader(self, provider, operation, payload):
        """격리 Reader 호출. 실패는 이관을 멈추지 않고 보고서에만 남긴다."""
        from .jobs import reader_result

        try:
            return reader_result(self.service.root, provider, self.principal, operation, payload)
        except Problem as exc:
            self.report["raw"]["reader_errors"] += 1
            self._warn("READER_" + exc.code, f"{operation}: {exc.message}")
            return None

    # ------------------------------------------------------------------ 실행
    def run(self):
        if not self.v2_path.is_file():
            raise Problem("V2_DATABASE_MISSING", f"v2 데이터베이스가 없습니다: {self.v2_path}", 404)
        self.v2 = _readonly(self.v2_path)
        try:
            tables = {r[0] for r in self.v2.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            missing = REQUIRED_TABLES - tables
            if missing:
                raise Problem("V2_DATABASE_INVALID", f"v2 스키마가 아닙니다(없는 테이블: {', '.join(sorted(missing))}): {self.v2_path}")
            if not self.dry:
                from .service import Service

                self.service = Service(self.ws)
            try:
                self._schema()
                self._profiles()
                self._documents()
                self._applications()
                self._builds()
                self._statuses()
            finally:
                if self.service is not None:
                    self.service.close()
        finally:
            self.v2.close()
        self.report["finished_at"] = now()
        return self.report

    # ------------------------------------------------------------------ §9 KG → parsing_schema
    def _schema(self):
        revisions = [dict(r) for r in self.v2.execute("SELECT * FROM kg_revision ORDER BY revision_no")]
        if not revisions:
            self._warn("NO_KG", "v2에 KG 리비전이 없어 스키마·프로파일·적용 건을 이관하지 않습니다.")
            return
        latest = revisions[-1]["kg_revision_id"]
        chosen = {}  # concept_id → (row, kg_revision_id) : 최고 revision_no 행
        for row in self.v2.execute(
            "SELECT c.*, k.revision_no FROM domain_concept c JOIN kg_revision k USING(kg_revision_id) ORDER BY k.revision_no"
        ):
            chosen[row["concept_id"]] = dict(row)
        in_latest = {r[0] for r in self.v2.execute("SELECT concept_id FROM domain_concept WHERE kg_revision_id=?", (latest,))}
        aliases = {}
        for row in self.v2.execute("SELECT kg_revision_id, concept_id, alias_text FROM domain_alias ORDER BY rowid"):
            picked = chosen.get(row["concept_id"])
            if picked and picked["kg_revision_id"] == row["kg_revision_id"]:
                aliases.setdefault(row["concept_id"], []).append(row["alias_text"])
        taken = set()
        for concept_id in chosen:
            key = field_key_of(concept_id, taken)
            taken.add(key)
            self.concept_field[concept_id] = key
        fields = []
        for concept_id, row in chosen.items():
            vtype = row.get("value_type") or "text"
            vtype = TYPE_ALIASES.get(str(vtype).lower(), str(vtype).lower())
            if vtype not in FIELD_TYPES:
                self._warn("FIELD_TYPE", f"개념 {concept_id}의 value_type {row.get('value_type')!r}를 text로 옮겼습니다.")
                vtype = "text"
            item = {
                "field_key": self.concept_field[concept_id],
                "name": row["name"],
                "type": vtype,
                "level": row["level"],
                "parents": [],
                "related": [],
                "aliases": [a for a in aliases.get(concept_id, []) if norm(a) != norm(row["name"])],
                "status": "deprecated" if (row["status"] != "active" or concept_id not in in_latest) else "active",
            }
            if row.get("definition") and row["definition"] != row["name"]:
                item["description"] = row["definition"]
            if row.get("canonical_unit"):
                item["unit"] = row["canonical_unit"]
            fields.append(item)
        by_key = {f["field_key"]: f for f in fields}
        for edge in self.v2.execute("SELECT * FROM domain_edge WHERE kg_revision_id=?", (latest,)):
            src, dst = self.concept_field.get(edge["from_concept_id"]), self.concept_field.get(edge["to_concept_id"])
            ident = f"{edge['from_concept_id']}->{edge['to_concept_id']}:{edge['relation_type']}"
            if not src or not dst or src == dst:
                self._skip("parsing_field_edge", ident, "UNKNOWN_CONCEPT")
                continue
            if edge["relation_type"] == "parent_of":
                # 계약 §1.2: parent_of는 자식 레벨 = 부모 레벨 + 1이어야 projection이 받아준다.
                if by_key[dst]["level"] != by_key[src]["level"] + 1:
                    self._skip("parsing_field_edge", ident, "LEVEL_MISMATCH")
                    continue
                by_key[dst]["parents"].append(src)
            elif edge["relation_type"] in ("related", "related_to"):
                by_key[src]["related"].append(dst)
            else:
                self._skip("parsing_field_edge", ident, "UNSUPPORTED_RELATION")
        definition = {
            "format": "parsing-schema",
            "schema_version": "3.0",
            "schema_key": SCHEMA_KEY,
            "schema_name": SCHEMA_NAME,
            "description": f"v2 KG 리비전 {len(revisions)}개의 합집합 (최신 r{revisions[-1]['revision_no']})",
            "fields": fields,
        }
        canonical = validate_schema_definition(definition)
        renamed = {c: k for c, k in self.concept_field.items() if c != k}
        summary = {
            "schema_key": SCHEMA_KEY,
            "fields": len(canonical["fields"]),
            "deprecated": sum(f["status"] == "deprecated" for f in canonical["fields"]),
            "kg_revisions": len(revisions),
            "field_keys": renamed,
        }
        if self.dry:
            self.fields = {
                f["field_key"]: {"field_id": None, "value_type": f["type"], "status": f["status"], "name": f["name"], "unit": f.get("unit"), "aliases": f["aliases"]}
                for f in canonical["fields"]
            }
        else:
            try:
                result = self.service.import_schema(canonical, self.principal)
            except Problem as exc:
                if exc.code != "SCHEMA_NAME_CONFLICT":
                    raise
                canonical["schema_name"] = f"{SCHEMA_NAME} [{SCHEMA_KEY}]"
                result = self.service.import_schema(canonical, self.principal)
            summary.update(schema_id=result["schema_id"], current_rev=result["current_rev"], unchanged=result["unchanged"])
            self.fields = self.service.schema_fields(SCHEMA_KEY)
        self.report["schema"] = summary
        self._count("parsing_schema")
        self._count("parsing_field", n=len(canonical["fields"]))
        self._count("parsing_alias", n=sum(len(f["aliases"]) for f in canonical["fields"]))
        self._count("parsing_field_edge", n=sum(len(f["parents"]) + len(f["related"]) for f in canonical["fields"]))

    # ------------------------------------------------------------------ §9 template → parsing_profile
    def _profiles(self):
        if self.fields is None:
            return
        names, existing = set(), {}
        with self._v3() as conn:
            if conn is not None:
                for r in conn.execute("SELECT p.profile_id, p.profile_name, s.schema_key FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id"):
                    names.add(r["profile_name"])
                    if r["schema_key"] == SCHEMA_KEY:
                        existing[r["profile_name"]] = r["profile_id"]
        for template in self.v2.execute("SELECT * FROM template ORDER BY created_at, template_id"):
            versions = [dict(r) for r in self.v2.execute(
                "SELECT * FROM template_version WHERE template_id=? ORDER BY revision_no", (template["template_id"],)
            )]
            if not versions:
                self._skip("parsing_profile", template["template_id"], "NO_VERSION")
                continue
            latest = versions[-1]
            for old in versions[:-1]:
                self._skip("template_version", old["template_version_id"], "NOT_LATEST_TEMPLATE_VERSION")
            self._count("template_version")
            definition = load(latest["definition_json"], {}) or {}
            for rule in definition.get("rules") or []:
                if isinstance(rule, dict):
                    concept = rule.pop("concept_id", None)
                    rule.pop("field_key", None)
                    if concept and concept in self.concept_field:
                        rule["field_key"] = self.concept_field[concept]
            name = template["name"]
            reuse = existing.get(name)  # 같은 v3 작업 공간에 다시 실행: 이미 이관된 프로파일은 새로 만들지 않는다.
            n = 2
            while name in names and not reuse:
                name = f"{template['name']} ({n})"
                n += 1
            names.add(name)
            try:
                canonical, report = to_canonical(definition, SCHEMA_KEY, self.fields, "v2-template")
                if reuse:
                    profile_id = reuse
                    with self._v3() as conn:
                        rule_ids = {r["rule_key"]: r["rule_id"] for r in conn.execute("SELECT rule_id, rule_key FROM parsing_rule WHERE profile_id=?", (profile_id,))}
                        revs = dict(conn.execute(
                            "SELECT p.schema_id, p.current_rev profile_rev, s.current_rev schema_rev FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.profile_id=?",
                            (profile_id,),
                        ).fetchone())
                        canonical = self.service.profile_canonical(profile_id, revs["profile_rev"]) if self.service else canonical
                elif self.dry:
                    profile_id, rule_ids = None, {r["rule_key"]: None for r in canonical["rules"]}
                    revs = {"schema_id": None, "profile_rev": 1, "schema_rev": 1}
                else:
                    result = self.service.import_profile(SCHEMA_KEY, definition, "v2-template", name=name, principal=self.principal)
                    profile_id = result["profile_id"]
                    canonical = self.service.profile_canonical(profile_id, result["current_rev"])
                    with self.service.db.connect() as conn:
                        rule_ids = {r["rule_key"]: r["rule_id"] for r in conn.execute("SELECT rule_id, rule_key FROM parsing_rule WHERE profile_id=?", (profile_id,))}
                        revs = conn.execute(
                            "SELECT p.schema_id, p.current_rev profile_rev, s.current_rev schema_rev FROM parsing_profile p JOIN parsing_schema s ON s.schema_id=p.schema_id WHERE p.profile_id=?",
                            (profile_id,),
                        ).fetchone()
            except Problem as exc:
                self._skip("parsing_profile", template["template_id"], f"{exc.code}: {exc.message}")
                continue
            self.templates[template["template_id"]] = {
                "profile_id": profile_id,
                "profile_name": name,
                "schema_id": revs["schema_id"],
                "profile_rev": revs["profile_rev"],
                "schema_rev": revs["schema_rev"],
                "rules": rule_ids,
                "canonical": canonical,
                "roles": canonical["sheet_roles"],
                "latest": latest["template_version_id"],
                "versions": {v["template_version_id"]: v["revision_no"] for v in versions},
            }
            if reuse:
                self._skip("parsing_profile", template["template_id"], "EXISTS")
            else:
                self._count("parsing_profile")
                self._count("parsing_rule", n=len(rule_ids))
            self.report["profiles"].append(
                {
                    "template_id": template["template_id"],
                    "template_version_id": latest["template_version_id"],
                    "template_revision_no": latest["revision_no"],
                    "profile_id": profile_id,
                    "profile_name": name,
                    "rules": sorted(rule_ids),
                    "warnings": report["warnings"],
                }
            )

    # ------------------------------------------------------------------ §9 document/version/sheet/region
    def _documents(self):
        for doc in self.v2.execute("SELECT * FROM document ORDER BY registered_at, document_id"):
            doc = dict(doc)
            did = doc["document_id"]
            versions = [dict(r) for r in self.v2.execute(
                "SELECT * FROM document_version WHERE document_id=? ORDER BY revision_no", (did,)
            )]
            if not versions:
                self._skip("document", did, "NO_VERSION")
                continue
            if self._exists("document", "document_id", did):
                self._skip("document", did, "EXISTS")
                self._count("document_snapshot", "skipped", len(versions))
                continue
            plan = self._plan_document(doc, versions)
            if plan is None:
                continue
            if not self.dry:
                try:
                    with self.service.db.connect(write=True) as conn:
                        self._write_document(conn, plan)
                except sqlite3.IntegrityError as exc:
                    self._skip("document", did, "INTEGRITY: " + str(exc))
                    continue
            self.docs[did] = plan
            self._count("document")
            self._count("document_snapshot", n=len(plan["snapshots"]))
            self._count("sheet", n=len(plan["sheet_rows"]))
            self._count("source_region", n=len(plan["region_rows"]))
            self._raw_file(plan)

    def _plan_document(self, doc, versions):
        did = doc["document_id"]
        snapshots, sheet_rows, region_rows, sheets = [], [], [], {}
        for v in versions:
            token = v["provider_version_token"] or v["content_sha256"]
            if not token:
                self._skip("document_snapshot", v["document_version_id"], "NO_TOKEN")
                continue
            content = v["content_sha256"]
            provider_version = v["provider_version_token"] if (doc["provider"] != "local-xlsx" or content is None) else None
            if content is None and provider_version is None and v["ciphertext_sha256"] is None:
                provider_version = token
            snapshots.append(
                dict(
                    snapshot_id=v["document_version_id"],
                    document_id=did,
                    revision_no=v["revision_no"],
                    change_token=token,
                    content_sha256=content,
                    ciphertext_sha256=v["ciphertext_sha256"],
                    provider_version=provider_version,
                    dvc_rev=None,
                    author=v["author"],
                    authored_at=v["authored_at"],
                    filename=v["filename"],
                    byte_size=v["byte_size"],
                    excel_date_system=v["excel_date_system"],
                    captured_at=v["captured_at"],
                )
            )
            for s in self.v2.execute("SELECT * FROM sheet WHERE document_version_id=? ORDER BY ordinal", (v["document_version_id"],)):
                sheet_rows.append((s["sheet_id"], v["document_version_id"], s["name"], s["ordinal"], s["native_sheet_key"], s["visibility"], s["estimated_rows"], s["estimated_cols"]))
                sheets[s["sheet_id"]] = s["name"]
            seen = {}
            for r in self.v2.execute("SELECT * FROM source_region WHERE document_version_id=? ORDER BY rowid", (v["document_version_id"],)):
                locator = address(r["r1"], r["c1"], r["r2"], r["c2"]) if r["kind"] == "cells" else (r["object_key"] or r["locator_key"])
                key = (r["sheet_id"], r["kind"], locator)
                if key in seen:
                    # v2는 병합 앵커/object_key까지 키에 넣었지만 v3는 (sheet, kind, locator)가 유일하다: 대표 영역으로 합친다.
                    self.region_alias[r["region_id"]] = seen[key]
                    self._skip("source_region", r["region_id"], "MERGED_DUPLICATE")
                    continue
                seen[key] = r["region_id"]
                self.region_alias[r["region_id"]] = r["region_id"]
                geometry = load(r["geometry_json"], None)
                if r["merge_anchor_r"] is not None:
                    geometry = {**(geometry if isinstance(geometry, dict) else {"geometry": geometry} if geometry is not None else {}), "merge_anchor": [r["merge_anchor_r"], r["merge_anchor_c"]]}
                region_rows.append((r["region_id"], v["document_version_id"], r["sheet_id"], r["kind"], locator, r["r1"], r["c1"], r["r2"], r["c2"], dump(geometry) if geometry is not None else None))
        if not snapshots:
            self._skip("document", did, "NO_SNAPSHOT")
            return None
        current = doc["current_version_id"] if any(s["snapshot_id"] == doc["current_version_id"] for s in snapshots) else snapshots[-1]["snapshot_id"]
        return {
            "row": doc,
            "current": current,
            "snapshots": snapshots,
            "sheet_rows": sheet_rows,
            "region_rows": region_rows,
            "sheets": sheets,
            "available": False,
            "token": next(s["change_token"] for s in snapshots if s["snapshot_id"] == current),
        }

    def _write_document(self, conn, plan):
        doc, stamp = plan["row"], now()
        conn.execute(
            "INSERT INTO document (document_id,document_name,provider,source_path,file_type,current_snapshot_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (doc["document_id"], doc["display_name"], doc["provider"], doc["source_ref"], doc["file_type"] or "xlsx", plan["current"], "not_extracted", doc["registered_at"], stamp),
        )
        conn.executemany(
            "INSERT INTO document_snapshot (snapshot_id,document_id,revision_no,change_token,content_sha256,ciphertext_sha256,provider_version,dvc_rev,author,authored_at,filename,byte_size,excel_date_system,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [tuple(s.values()) for s in plan["snapshots"]],
        )
        conn.executemany(
            "INSERT INTO sheet (sheet_id,snapshot_id,sheet_name,ordinal,native_sheet_key,visibility,estimated_rows,estimated_cols) VALUES (?,?,?,?,?,?,?,?)",
            plan["sheet_rows"],
        )
        conn.executemany(
            "INSERT INTO source_region (region_id,snapshot_id,sheet_id,kind,locator_key,r1,c1,r2,c2,geometry_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [(*row, stamp) for row in plan["region_rows"]],
        )

    def _raw_file(self, plan):
        """현재 snapshot의 원본이 있으면 v3 raw로 가져오고(같은 폴더면 그대로) Reader describe로 서명·토큰을 확인한다."""
        doc = plan["row"]
        raw = self.report["raw"]
        if doc["provider"] != "local-xlsx":
            return
        raw["checked"] += 1
        source = self.raw / doc["source_ref"]
        target = self.v3_raw / doc["source_ref"]
        if not source.is_file() and not target.is_file():
            raw["missing"] += 1
            return
        if not target.is_file():
            if self.dry:
                raw["copied"] += 1
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.link(source, target)
                except OSError:
                    shutil.copy2(source, target)
                raw["copied"] += 1
        if self.dry:
            from kg.v2.readers import file_hash

            path = target if target.is_file() else source
            if file_hash(path) == plan["token"]:
                raw["available"] += 1
                plan["available"] = True
            else:
                raw["changed"] += 1
            return
        described = self._reader(doc["provider"], "describe", {"source_ref": doc["source_ref"], "profiles": []})
        if not described:
            return
        if described.get("token") != plan["token"]:
            raw["changed"] += 1
            self._warn("RAW_CHANGED", f"{doc['display_name']}: 원본이 v2 snapshot과 달라 서명·매치를 계산하지 않았습니다.")
            return
        raw["available"] += 1
        plan["available"] = True
        signature = _normalize_signature(described.get("signature"))
        if signature:
            with self.service.db.connect(write=True) as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO snapshot_signature (snapshot_id,algorithm,signature_json,signature_sha256,reader_revision,computed_at) VALUES (?,?,?,?,?,?)",
                    (plan["current"], STRUCTURE_ALGORITHM, dump(signature), digest(signature), "v2-migration", now()),
                )
            self._count("snapshot_signature")

    # ------------------------------------------------------------------ §9 application/mapping/run/value
    def _applications(self):
        apps = self.v2.execute(
            "SELECT a.*, tv.template_id, tv.revision_no template_revision_no, dv.document_id FROM template_application a "
            "JOIN template_version tv USING(template_version_id) JOIN document_version dv USING(document_version_id) ORDER BY a.created_at, a.application_id"
        ).fetchall()
        used_scopes = set()
        with self._v3() as conn:
            if conn is not None:
                used_scopes = {tuple(r) for r in conn.execute("SELECT snapshot_id, profile_id, scope_key FROM parsing_application")}
        for app in apps:
            app = dict(app)
            aid = app["application_id"]
            template, doc = self.templates.get(app["template_id"]), self.docs.get(app["document_id"])
            if self._exists("parsing_application", "application_id", aid):
                self._skip("parsing_application", aid, "EXISTS")
                continue
            if template is None:
                self._skip("parsing_application", aid, "TEMPLATE_NOT_MIGRATED")
                continue
            if doc is None or not any(s["snapshot_id"] == app["document_version_id"] for s in doc["snapshots"]):
                self._skip("parsing_application", aid, "SNAPSHOT_NOT_MIGRATED")
                continue
            snapshot_id = app["document_version_id"]
            scope = "default"
            if (snapshot_id, template["profile_id"], scope) in used_scopes:
                scope = app["scope_key"]
                if (snapshot_id, template["profile_id"], scope) in used_scopes:
                    self._skip("parsing_application", aid, "SCOPE_CONFLICT")
                    continue
            used_scopes.add((snapshot_id, template["profile_id"], scope))
            if app["template_version_id"] != template["latest"]:
                self._warn("OLD_TEMPLATE_VERSION", f"적용 건 {aid}는 템플릿 r{app['template_revision_no']}를 썼습니다. 최신 리비전(profile_rev 1)의 규칙만 옮깁니다.")
            plan = self._plan_application(app, template, doc, snapshot_id, scope)
            # Reader(match_specs)는 쓰기 트랜잭션 밖에서 돈다.
            plan["match"] = self._match(plan, doc, template)
            if not self.dry:
                try:
                    with self.service.db.connect(write=True) as conn:
                        self._write_application(conn, plan, template, doc)
                except sqlite3.IntegrityError as exc:
                    self._skip("parsing_application", aid, "INTEGRITY: " + str(exc))
                    for m in plan["mappings"]:
                        for r in m["revisions"]:
                            self.revisions.pop(r["v2"]["mapping_revision_id"], None)
                    continue
            self._record_application(plan, app, doc, template)
            self._runs(app, plan, doc, template)

    def _plan_application(self, app, template, doc, snapshot_id, scope):
        aid = app["application_id"]
        sheets = [
            (aid, snapshot_id, r["role_key"], r["ordinal"], r["sheet_id"])
            for r in self.v2.execute("SELECT * FROM application_sheet WHERE application_id=? ORDER BY role_key, ordinal", (aid,))
            if r["sheet_id"] in doc["sheets"]
        ]
        bindings = {}
        for _, _, role, _, sheet_id in sheets:
            bindings.setdefault(role, []).append(doc["sheets"][sheet_id])
        observed = {}
        for r in self.v2.execute(
            "SELECT s.mapping_revision_id, s.observed_key FROM extracted_series s JOIN extraction_run r USING(run_id) WHERE r.application_id=? ORDER BY r.created_at, s.rowid",
            (aid,),
        ):
            if r["observed_key"]:
                observed[r["mapping_revision_id"]] = r["observed_key"]
        # 실제 위치(mapping_region): 리비전마다 가장 최근 성공 실행의 series_region을 role별로 모은다.
        regions_of, run_of = {}, {}
        for r in self.v2.execute(
            "SELECT s.mapping_revision_id, s.run_id, sr.role, sr.ordinal, sr.region_id FROM series_region sr "
            "JOIN extracted_series s USING(series_id) JOIN extraction_run r ON r.run_id=s.run_id "
            "WHERE r.application_id=? AND r.status='succeeded' ORDER BY r.created_at DESC, r.run_id, s.instance_key, sr.role, sr.ordinal",
            (aid,),
        ):
            rid = r["mapping_revision_id"]
            if run_of.setdefault(rid, r["run_id"]) != r["run_id"]:
                continue
            region = self.region_alias.get(r["region_id"])
            if region:
                bucket = regions_of.setdefault(rid, {})
                if region not in bucket.setdefault(r["role"], []):
                    bucket[r["role"]].append(region)
        mappings, by_rule = [], {}
        for r in self.v2.execute("SELECT * FROM mapping_revision WHERE application_id=? ORDER BY rule_key, revision_no", (aid,)):
            by_rule.setdefault(r["rule_key"], []).append(dict(r))
        for rule_key, revs in by_rule.items():
            if rule_key not in template["rules"]:
                self._skip("mapping", f"{aid}:{rule_key}", "RULE_NOT_IN_PROFILE")
                self._count("mapping_revision", "skipped", len(revs))
                continue
            mid = uid()
            items = []
            for n, rev in enumerate(revs, start=1):
                field_key = self.concept_field.get(rev["concept_id"]) if rev["concept_id"] else None
                field = self.fields.get(field_key) if field_key else None
                spec, spec_ok = self._effective_spec(rev, template)
                items.append(
                    {
                        "mapping_revision_id": rev["mapping_revision_id"],
                        "revision_no": n,
                        "field_id": field["field_id"] if field else None,
                        "field_key": field_key if field else None,
                        "observed_key": observed.get(rev["mapping_revision_id"]),
                        "spec": spec,
                        "spec_ok": spec_ok,
                        "status": rev["status"],
                        "created_by": rev["created_by"],
                        "reason": rev["reason"],
                        "created_at": rev["created_at"],
                        "regions": regions_of.get(rev["mapping_revision_id"], {}),
                        "v2": {
                            "mapping_revision_id": rev["mapping_revision_id"],
                            "revision_no": rev["revision_no"],
                            "origin": rev["origin"],
                            "kg_revision_id": rev["kg_revision_id"],
                            "concept_id": rev["concept_id"],
                            "template_version_id": rev["template_version_id"],
                            "supersedes_id": rev["supersedes_id"],
                            "evidence": load(rev["evidence_json"], {}),
                        },
                    }
                )
            mappings.append({"mapping_id": mid, "rule_key": rule_key, "rule_id": template["rules"][rule_key], "created_at": revs[0]["created_at"], "revisions": items})
        return {
            "application_id": aid,
            "snapshot_id": snapshot_id,
            "scope_key": scope,
            "sheets": sheets,
            "bindings": bindings,
            "mappings": mappings,
            "created_at": app["created_at"],
            "match": None,
        }

    def _effective_spec(self, rev, template):
        """v2 effective_spec(rule) → v3 effective_spec. v3 DSL은 v2의 상위 호환이므로 검증·compile만 거친다."""
        spec = load(rev["effective_spec_json"], {}) or {}
        rule = {k: copy.deepcopy(v) for k, v in spec.items() if k not in ("concept_id", "field_key", "kg_revision_id")}
        rule["rule_key"] = rev["rule_key"]
        try:
            return compile_rule(validate_rule(rule, template["roles"], {}, self.fields), {}), True
        except Problem as exc:
            self._append("review_required", {"application_id": rev["application_id"], "rule_key": rev["rule_key"], "mapping_revision_id": rev["mapping_revision_id"], "reason": f"INVALID_SPEC {exc.code}: {exc.message}"})
            return spec, False

    def _match(self, plan, doc, template):
        """현재 snapshot이고 원본이 확인되면 Reader match_specs로 매치 서명을 계산한다(§3.4)."""
        heads = [m["revisions"][-1] for m in plan["mappings"] if m["revisions"]]
        if self.dry or not doc["available"] or plan["snapshot_id"] != doc["current"] or not heads or not all(h["spec_ok"] for h in heads):
            return None
        return self._reader(
            doc["row"]["provider"],
            "match_specs",
            {"source_ref": doc["row"]["source_ref"], "expected_token": doc["token"], "specs": [h["spec"] for h in heads], "bindings_hint": plan["bindings"]},
        )

    def _write_application(self, conn, plan, template, doc):
        match = plan["match"]
        compatibility, signature, signature_json = "manual", SIGNATURE_MIGRATED, None
        if match and match.get("compatibility") == "compatible":
            compatibility, signature, signature_json = "compatible", match["match_signature"], dump(match.get("match_signature_json"))
        elif match:
            signature_json = dump({"compatibility": match.get("compatibility"), "missing": match.get("missing")})
        conn.execute(
            "INSERT INTO parsing_application (application_id,snapshot_id,profile_id,schema_id,scope_key,profile_rev,schema_rev,origin,match_signature,match_signature_json,compatibility,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (plan["application_id"], plan["snapshot_id"], template["profile_id"], template["schema_id"], plan["scope_key"], template["profile_rev"], template["schema_rev"], "manual", signature, signature_json, compatibility, plan["created_at"]),
        )
        conn.executemany("INSERT INTO application_sheet (application_id,snapshot_id,role_key,ordinal,sheet_id) VALUES (?,?,?,?,?)", plan["sheets"])
        by_name = {name: sid for sid, name in doc["sheets"].items()}
        resolved = (match or {}).get("resolved") or {}
        cache = {}
        for mapping in plan["mappings"]:
            conn.execute(
                "INSERT INTO mapping (mapping_id,application_id,snapshot_id,rule_id,created_at) VALUES (?,?,?,?,?)",
                (mapping["mapping_id"], plan["application_id"], plan["snapshot_id"], mapping["rule_id"], mapping["created_at"]),
            )
            for rev in mapping["revisions"]:
                conn.execute(
                    "INSERT INTO mapping_revision (mapping_revision_id,mapping_id,revision_no,snapshot_id,field_id,observed_key,effective_spec_json,status,origin,evidence_json,created_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rev["mapping_revision_id"], mapping["mapping_id"], rev["revision_no"], plan["snapshot_id"], rev["field_id"], rev["observed_key"], dump(rev["spec"]), rev["status"], "import", dump({"v2": rev["v2"]}), rev["created_by"], rev["reason"], rev["created_at"]),
                )
                regions = rev["regions"]
                if not regions and rev is mapping["revisions"][-1] and resolved.get(mapping["rule_key"]):
                    regions = {}
                    for role in ROLES:
                        locs = resolved[mapping["rule_key"]].get(role)
                        for loc in (locs if isinstance(locs, list) else [locs] if locs else []):
                            sheet, range_text = loc.rsplit("!", 1)
                            if sheet in by_name:
                                regions.setdefault(role, []).append(ensure_region(conn, plan["snapshot_id"], by_name[sheet], range_text, cache))
                rows = [(rev["mapping_revision_id"], plan["snapshot_id"], region_id, role, n) for role in SERIES_ROLES for n, region_id in enumerate(regions.get(role, []))]
                if rows:
                    conn.executemany("INSERT INTO mapping_region (mapping_revision_id,snapshot_id,region_id,role,ordinal) VALUES (?,?,?,?,?)", rows)
                rev["region_count"] = len(rows)

    def _record_application(self, plan, app, doc, template):
        aid = plan["application_id"]
        self.applications[aid] = {"document_id": doc["row"]["document_id"], "snapshot_id": plan["snapshot_id"], "profile_id": template["profile_id"], "v2_published_run_id": app["published_run_id"]}
        self._count("parsing_application")
        self._count("application_sheet", n=len(plan["sheets"]))
        for mapping in plan["mappings"]:
            self.mappings[(aid, mapping["rule_key"])] = mapping["mapping_id"]
            self._count("mapping")
            for rev in mapping["revisions"]:
                self.revisions[rev["mapping_revision_id"]] = {"field_id": rev["field_id"], "field_key": rev["field_key"], "mapping_id": mapping["mapping_id"], "rule_key": mapping["rule_key"]}
                self._count("mapping_revision")
                self._count("mapping_region", n=rev.get("region_count", sum(len(v) for v in rev["regions"].values())))
                if rev["field_key"] is None:  # dry-run에는 field_id가 없으므로 field_key로 판정한다
                    self._append("review_required", {"application_id": aid, "document_id": doc["row"]["document_id"], "document_name": doc["row"]["display_name"], "rule_key": mapping["rule_key"], "mapping_id": mapping["mapping_id"], "mapping_revision_id": rev["mapping_revision_id"], "status": rev["status"], "reason": "FIELD_REQUIRED"})
        self.report["documents"].setdefault(doc["row"]["document_id"], {"document_name": doc["row"]["display_name"], "applications": []})["applications"].append(
            {"application_id": aid, "profile_id": template["profile_id"], "profile_name": template["profile_name"], "compatibility": (plan["match"] or {}).get("compatibility", "manual")}
        )

    # ------------------------------------------------------------------ 실행·값
    def _runs(self, app, plan, doc, template):
        aid = plan["application_id"]
        published_migrated = False
        for run in self.v2.execute("SELECT * FROM extraction_run WHERE application_id=? ORDER BY created_at, run_id", (aid,)):
            run = dict(run)
            if run["status"] not in ("succeeded", "failed", "cancelled"):
                self._skip("extraction_run", run["run_id"], "NOT_FINISHED")
                continue
            if self._exists("extraction_run", "run_id", run["run_id"]):
                self._skip("extraction_run", run["run_id"], "EXISTS")
                continue
            manifest_mappings, complete = {}, True
            for rm in self.v2.execute("SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id=? ORDER BY rule_key", (run["run_id"],)):
                mid = self.mappings.get((aid, rm["rule_key"]))
                if mid is None or rm["mapping_revision_id"] not in self.revisions:
                    complete = False
                    continue
                manifest_mappings[mid] = {"revision_id": rm["mapping_revision_id"], "rule_key": rm["rule_key"]}
            bindings = {}
            for _, _, role, _, sheet_id in plan["sheets"]:
                bindings.setdefault(role, []).append(sheet_id)
            environment = load(run["environment_json"], {}) or {}
            manifest = {"mappings": manifest_mappings, "bindings": bindings, "engine": {"version": run["engine_version"], "v2": environment}, "migrated_from": "v2", "v2_input_fingerprint": run["input_fingerprint"]}
            counts = {"values": 0, "regions": 0, "skipped_values": 0, "skipped_regions": 0, "assets": 0}
            if not self.dry:
                try:
                    with self.service.db.connect(write=True) as conn:
                        conn.execute(
                            "INSERT INTO extraction_run (run_id,application_id,snapshot_id,schema_rev,profile_rev,engine_version,input_manifest_json,status,started_at,finished_at,error_summary,auto_approved) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)",
                            (run["run_id"], aid, plan["snapshot_id"], 1, 1, run["engine_version"], dump(manifest), run["status"], run["created_at"], run["finished_at"], run["error_summary"]),
                        )
                        self._values(conn, run, plan, counts)
                except sqlite3.IntegrityError as exc:
                    self._skip("extraction_run", run["run_id"], "INTEGRITY: " + str(exc))
                    continue
            else:
                self._count_values(run, counts)
            self.runs.add(run["run_id"])
            self._count("extraction_run")
            self._count("extracted_value", n=counts["values"])
            self._count("extracted_value", "skipped", counts["skipped_values"])
            self._count("extracted_value_region", n=counts["regions"])
            self._count("extracted_value_region", "skipped", counts["skipped_regions"])
            if run["run_id"] == app["published_run_id"]:
                published_migrated = complete and run["status"] == "succeeded"
        self._publish(app, plan, doc, template, published_migrated)

    def _publish(self, app, plan, doc, template, migrated):
        """발행 실행 유지: 헤드 집합·manifest·승인 상태가 맞아야 트리거가 받는다. 아니면 재추출 필요 목록에."""
        if not app["published_run_id"]:
            return
        entry = {"application_id": plan["application_id"], "document_id": doc["row"]["document_id"], "document_name": doc["row"]["display_name"], "profile_id": template["profile_id"], "profile_name": template["profile_name"], "run_id": app["published_run_id"]}
        if not migrated:
            self._append("re_extract_required", {**entry, "reason": "PUBLISHED_RUN_NOT_MIGRATED"})
            self._count("published_run", "skipped")
            return
        if self.dry:
            heads_ok = all(m["revisions"][-1]["status"] == "approved" for m in plan["mappings"])
            if heads_ok:
                self._count("published_run")
            else:
                self._append("re_extract_required", {**entry, "reason": "HEAD_NOT_APPROVED"})
                self._count("published_run", "skipped")
            return
        try:
            with self.service.db.connect(write=True) as conn:
                conn.execute("UPDATE parsing_application SET published_run_id=? WHERE application_id=?", (app["published_run_id"], plan["application_id"]))
            self._count("published_run")
        except sqlite3.IntegrityError as exc:
            self._append("re_extract_required", {**entry, "reason": "PUBLISH_REJECTED: " + str(exc)})
            self._count("published_run", "skipped")

    def _count_values(self, run, counts):
        counts["values"] = self.v2.execute(
            "SELECT count(*) FROM extracted_item i JOIN extracted_series s USING(series_id) WHERE s.run_id=?", (run["run_id"],)
        ).fetchone()[0]
        counts["regions"] = self.v2.execute(
            "SELECT count(*) FROM item_region ir JOIN extracted_item i USING(item_id) JOIN extracted_series s USING(series_id) WHERE s.run_id=?", (run["run_id"],)
        ).fetchone()[0] + self.v2.execute(
            "SELECT count(*) FROM series_region sr JOIN extracted_series s USING(series_id) JOIN extracted_item i USING(series_id) WHERE s.run_id=?", (run["run_id"],)
        ).fetchone()[0]

    def _values(self, conn, run, plan, counts):
        """extracted_item → extracted_value(500개 배치). series_region은 같은 role 뒤에 ordinal을 이어 붙인다."""
        series_regions = {}
        for r in self.v2.execute(
            "SELECT sr.series_id, sr.role, sr.ordinal, sr.region_id FROM series_region sr JOIN extracted_series s USING(series_id) WHERE s.run_id=? ORDER BY sr.series_id, sr.role, sr.ordinal",
            (run["run_id"],),
        ):
            series_regions.setdefault(r["series_id"], []).append((r["role"], r["ordinal"], r["region_id"]))
        cursor = self.v2.execute(
            "SELECT i.*, s.instance_key, s.mapping_revision_id FROM extracted_item i JOIN extracted_series s USING(series_id) WHERE s.run_id=? ORDER BY i.series_id, i.item_index",
            (run["run_id"],),
        )
        stamp = run["finished_at"] or run["created_at"] or now()
        while batch := cursor.fetchmany(VALUE_BATCH):
            ids = [r["item_id"] for r in batch]
            item_regions = {}
            for r in self.v2.execute(
                f"SELECT item_id, role, ordinal, region_id FROM item_region WHERE item_id IN ({','.join('?' for _ in ids)}) ORDER BY item_id, role, ordinal", ids
            ):
                item_regions.setdefault(r["item_id"], []).append((r["role"], r["ordinal"], r["region_id"]))
            value_rows, region_rows = [], []
            for item in batch:
                revision = self.revisions.get(item["mapping_revision_id"])
                if not revision or revision["field_id"] is None:
                    counts["skipped_values"] += 1
                    continue
                vtype = item["value_type"]
                if vtype == "null":
                    field = self.fields.get(revision["field_key"]) or {}
                    vtype = field.get("value_type") if field.get("value_type") in ("text", "decimal", "boolean", "date", "datetime") else "text"
                elif vtype == "asset":
                    vtype = "text"
                    counts["assets"] += 1
                    self.report["asset_values"]["count"] += 1
                    if len(self.report["asset_values"]["value_ids"]) < 100:
                        self.report["asset_values"]["value_ids"].append(item["item_id"])
                value_rows.append(
                    (
                        item["item_id"], run["run_id"], plan["snapshot_id"], item["mapping_revision_id"], revision["field_id"], item["instance_key"],
                        item["record_key"], item["item_index"], item["raw_text"], item["display_text"], item["value_text"], vtype,
                        VALUE_STATES.get(item["value_state"], "error"), item["unit_raw"], item["unit_normalized"],
                        FORMULA_STATES.get(item["formula_state"], item["formula_state"]), item["source_identity_key"], item["derivation_key"], stamp,
                    )
                )
                own = item_regions.get(item["item_id"], [])
                max_ordinal = {}
                for role, ordinal, region_id in own:
                    max_ordinal[role] = max(max_ordinal.get(role, -1), ordinal)
                merged = list(own)
                for role, ordinal, region_id in series_regions.get(item["series_id"], []):
                    merged.append((role, max_ordinal.get(role, -1) + 1 + ordinal, region_id))
                for role, ordinal, region_id in merged:
                    target = self.region_alias.get(region_id)
                    if target is None:
                        counts["skipped_regions"] += 1
                        continue
                    region_rows.append((item["item_id"], plan["snapshot_id"], target, role, ordinal))
            conn.executemany(
                "INSERT INTO extracted_value (value_id,run_id,snapshot_id,mapping_revision_id,field_id,group_key,record_key,item_index,raw_text,display_text,value_text,value_type,value_state,unit_raw,unit_normalized,formula_state,source_identity_key,derivation_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                value_rows,
            )
            conn.executemany("INSERT OR IGNORE INTO extracted_value_region (value_id,snapshot_id,region_id,role,ordinal) VALUES (?,?,?,?,?)", region_rows)
            counts["values"] += len(value_rows)
            counts["regions"] += len(region_rows)

    # ------------------------------------------------------------------ §9 integration/build → manifest 파일
    def _builds(self):
        for build in self.v2.execute("SELECT * FROM build_run ORDER BY created_at, build_id"):
            build = dict(build)
            version = self.v2.execute("SELECT * FROM integration_version WHERE integration_version_id=?", (build["integration_version_id"],)).fetchone()
            project = self.v2.execute("SELECT * FROM integration_project WHERE project_id=?", (version["project_id"],)).fetchone() if version else None
            fields = [dict(r) for r in self.v2.execute("SELECT * FROM integration_field WHERE integration_version_id=? ORDER BY ordinal", (build["integration_version_id"],))]
            sources = [dict(r) for r in self.v2.execute("SELECT * FROM integration_source WHERE integration_version_id=? ORDER BY field_key, application_id, rule_key", (build["integration_version_id"],))]
            inputs = [
                {"run_id": r["run_id"], "selection": load(r["selection_json"], []), "migrated": r["run_id"] in self.runs}
                for r in self.v2.execute("SELECT * FROM build_input WHERE build_id=? ORDER BY run_id", (build["build_id"],))
            ]
            concept_of = {f["field_key"]: f.get("concept_id") for f in fields}
            for source in sources:
                source["profile_id"] = self.templates.get(self._template_of(source["template_version_id"]), {}).get("profile_id")
                concept = concept_of.get(source["field_key"])
                source["field_key_v3"] = self.concept_field.get(concept) if concept else None
            output = self.from_ws / "data/v2-builds" / (build["build_id"] + ".sqlite")
            manifest = {
                "format": "v2-build-manifest/1",
                "build_id": build["build_id"],
                "status": build["status"],
                "row_count": build["row_count"],
                "created_at": build["created_at"],
                "finished_at": build["finished_at"],
                "input_fingerprint": build["input_fingerprint"],
                "input_manifest": load(build["input_manifest_json"], {}),
                "integration": {
                    "project_id": version["project_id"] if version else None,
                    "name": project["name"] if project else None,
                    "integration_version_id": build["integration_version_id"],
                    "revision_no": version["revision_no"] if version else None,
                    "kg_revision_id": version["kg_revision_id"] if version else None,
                    "spec": load(version["spec_json"], {}) if version else None,
                    "fields": [{**f, "field_key_v3": self.concept_field.get(f["concept_id"]) if f.get("concept_id") else None} for f in fields],
                    "sources": sources,
                },
                "inputs": inputs,
                "schema_key": SCHEMA_KEY,
                "v2_output": str(output.relative_to(self.from_ws)) if output.is_file() else None,
                "migrated_at": now(),
            }
            if not self.dry:
                folder = self.ws / "data/exports" / f"migrated-{build['build_id']}"
                folder.mkdir(parents=True, exist_ok=True)
                (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
            self._count("build_manifest")

    def _template_of(self, template_version_id):
        row = self.v2.execute("SELECT template_id FROM template_version WHERE template_version_id=?", (template_version_id,)).fetchone()
        return row["template_id"] if row else None

    # ------------------------------------------------------------------ 상태 재계산
    def _statuses(self):
        statuses = {}
        for did in self.docs:
            if self.dry:
                continue
            status = self.service.refresh_document_status(did)["status"]
            statuses[status] = statuses.get(status, 0) + 1
            self.report["documents"].setdefault(did, {"document_name": self.docs[did]["row"]["display_name"], "applications": []})["status"] = status
        self.report["statuses"] = statuses


def run(ws, from_ws, raw=None, dry_run=False, principal="v2-migration"):
    """v2 워크스페이스를 v3 워크스페이스로 옮기고 보고서(dict)를 돌려준다. dry_run이면 아무것도 쓰지 않는다."""
    return Migration(ws, from_ws, raw, dry_run, principal).run()


migrate = run


def run_cli(args):
    try:
        report = run(args.ws, args.from_ws, getattr(args, "raw", None), args.dry_run, getattr(args, "principal", "v2-migration"))
    except Problem as exc:
        print(f"{exc.code}: {exc.message}", file=sys.stderr)
        return 2
    except sqlite3.Error as exc:
        print(f"V2_DATABASE_ERROR: {exc}", file=sys.stderr)
        return 2
    if getattr(args, "report", None):
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "dry_run": report["dry_run"],
                "counts": report["counts"],
                "skipped": len(report["skipped"]),
                "review_required": len(report["review_required"]),
                "re_extract_required": len(report["re_extract_required"]),
                "statuses": report.get("statuses"),
                "report": str(args.report) if getattr(args, "report", None) else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0
