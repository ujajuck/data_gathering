"""v2 애플리케이션 서비스: 실제 원본 등록, 사람이 정의한 KG, 템플릿·검수·작업 연결."""

from __future__ import annotations

import copy
from contextlib import nullcontext
import json
import os
import re
from pathlib import Path
from datetime import datetime, timezone

import yaml

from .db import Database, Problem, digest, dump, insert, norm, now, one, uid
from .jobs import Jobs, reader_events
from .spec import validate_rule, validate_template

ENGINE_VERSION = "data-gathering-v2.0"


class Service:
    def __init__(self, root, start_worker=False):
        self.db = Database(Path(root))
        self.root = self.db.root
        self.jobs = Jobs(self.db, self.handle_job, self.fail_job)
        if start_worker:
            self.jobs.start()

    def read(self, provider, principal, operation, payload, checkpoint=lambda: None):
        return next(
            iter(
                list(
                    reader_events(
                        self.root, provider, principal, operation, payload, checkpoint
                    )
                )
            )
        )

    def version(self, version_id):
        with self.db.connect() as conn:
            result = one(
                conn,
                "SELECT v.*,d.provider,d.source_ref,d.display_name,a.storage_ref version_locator FROM document_version v JOIN document d USING(document_id) LEFT JOIN artifact a ON a.artifact_id=v.source_artifact_id WHERE document_version_id=?",
                (version_id,),
            )
        if result.pop("version_locator", None):
            with self.db.connect() as conn:
                locator = json.loads(
                    one(
                        conn,
                        "SELECT storage_ref FROM artifact WHERE artifact_id=?",
                        (result["source_artifact_id"],),
                    )["storage_ref"]
                )
            result["source_ref"] = locator["source_ref"]
        return result

    def authorize(
        self, version_id, principal, required="view", checkpoint=lambda: None
    ):
        version = self.version(version_id)
        caps = self.read(
            version["provider"],
            principal,
            "authorize",
            {"source_ref": version["source_ref"], "required": required},
            checkpoint,
        )
        from .features import record_access

        record_access(self, version, principal, caps)
        key = {
            "view": "can_view",
            "extract": "can_extract",
            "render": "can_render_web",
        }[required]
        if not caps.get(key) or not caps.get("can_view"):
            raise Problem(
                "ACCESS_DENIED", "이 작업에 필요한 원본 접근 권한이 없습니다.", 403
            )
        try:
            if datetime.fromisoformat(caps["expires_at"]) <= datetime.now(timezone.utc):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise Problem(
                "ACCESS_EXPIRED", "제공자의 접근 권한이 만료되었습니다.", 403
            ) from None
        return version, caps

    def handle_job(self, kind, payload, principal, checkpoint):
        if kind == "register":
            results = []
            for n, ref in enumerate(payload["source_refs"]):
                checkpoint(n, len(payload["source_refs"]), force=True)
                results.append(
                    self.register(
                        ref,
                        payload.get("provider", "local-xlsx"),
                        principal,
                        payload.get("document_id"),
                        checkpoint,
                    )
                )
            return {"documents": results}
        if kind == "extract":
            from .extract import execute_extraction

            return execute_extraction(self, payload, principal, checkpoint)
        if kind == "viewport":
            version, caps = self.authorize(
                payload["version_id"], principal, "render", checkpoint
            )
            with self.db.connect() as conn:
                sheet = one(
                    conn,
                    "SELECT * FROM sheet WHERE sheet_id=? AND document_version_id=?",
                    (payload["sheet_id"], payload["version_id"]),
                )
            result = self.read(
                version["provider"],
                principal,
                "viewport",
                {
                    "source_ref": version["source_ref"],
                    "expected_token": version["provider_version_token"],
                    "sheet": sheet["name"],
                    "r1": payload.get("r1", 1),
                    "c1": payload.get("c1", 1),
                    "rows": payload.get("rows", 40),
                    "cols": payload.get("cols", 12),
                },
                checkpoint,
            )
            _, caps = self.authorize(
                payload["version_id"], principal, "render", checkpoint
            )
            if result.get("mode") == "native" and not caps.get("native_render"):
                raise Problem(
                    "INVALID_RENDER_CONTRACT",
                    "제공자가 원본 렌더 기능을 확인하지 않았습니다.",
                )
            from .render import validate_viewport

            validate_viewport(result, payload, version["provider_version_token"])
            result["access_expires_at"] = caps["expires_at"]
            result.update(
                version_id=payload["version_id"],
                sheet_id=payload["sheet_id"],
                _volatile=not caps.get("can_cache_derivative", False),
            )
            return result
        if kind == "build":
            from .build import execute_build

            return execute_build(self, payload, principal, checkpoint)
        raise Problem("UNKNOWN_JOB", "지원하지 않는 작업입니다.")

    def fail_job(self, kind, payload, exc):
        table, column, identity = (
            ("extraction_run", "run_id", payload.get("run_id"))
            if kind == "extract"
            else ("build_run", "build_id", payload.get("build_id"))
        )
        if kind not in ("extract", "build") or not identity:
            return
        with self.db.connect(write=True) as conn:
            if conn.execute(
                f"SELECT 1 FROM {table} WHERE {column}=? AND status IN ('queued','running')",
                (identity,),
            ).fetchone():
                conn.execute(
                    f"UPDATE {table} SET status=?,finished_at=? WHERE {column}=?",
                    (
                        "cancelled" if exc.code == "CANCELLED" else "failed",
                        now(),
                        identity,
                    ),
                )

    def register(
        self,
        source_ref,
        provider,
        principal,
        document_id=None,
        checkpoint=lambda **kw: None,
    ):
        if not isinstance(source_ref, str) or not source_ref or len(source_ref) > 2048:
            raise Problem("INVALID_SOURCE", "원본 참조가 유효하지 않습니다.")
        metadata = self.read(
            provider, principal, "describe", {"source_ref": source_ref}, checkpoint
        )
        if not metadata.get("token") or not isinstance(metadata.get("sheets"), list):
            raise Problem(
                "INVALID_READER_CONTRACT",
                "제공자의 문서 버전/시트 정보가 유효하지 않습니다.",
            )
        checkpoint(force=True)
        with self.db.connect(write=True) as conn:
            location_changed = False
            if document_id:
                doc = one(
                    conn, "SELECT * FROM document WHERE document_id=?", (document_id,)
                )
                if doc["provider"] != provider:
                    raise Problem(
                        "PROVIDER_MISMATCH", "기존 문서와 원본 제공자가 다릅니다.", 409
                    )
                location_changed = doc["source_ref"] != source_ref
                # 이름/위치 변경은 사용자가 기존 문서 ID를 지정할 때만 같은 문서로 처리한다.
                conn.execute(
                    "UPDATE document SET source_ref=?,display_name=? WHERE document_id=?",
                    (source_ref, metadata["filename"], document_id),
                )
            else:
                found = conn.execute(
                    "SELECT * FROM document WHERE provider=? AND source_ref=?",
                    (provider, source_ref),
                ).fetchone()
                document_id = found["document_id"] if found else uid()
                if not found:
                    insert(
                        conn,
                        "document",
                        document_id=document_id,
                        display_name=metadata["filename"],
                        provider=provider,
                        source_ref=source_ref,
                        file_type=Path(metadata["filename"]).suffix.lstrip(".")
                        or "xlsx",
                        registered_at=now(),
                    )
            old = conn.execute(
                "SELECT * FROM document_version WHERE document_id=? ORDER BY revision_no DESC LIMIT 1",
                (document_id,),
            ).fetchone()
            if (
                old
                and old["provider_version_token"] == metadata["token"]
                and not location_changed
            ):
                return {
                    "document_id": document_id,
                    "version_id": old["document_version_id"],
                    "unchanged": True,
                }
            version_id = uid()
            source_artifact = uid()
            insert(
                conn,
                "artifact",
                artifact_id=source_artifact,
                kind="protected_source",
                storage_ref=dump(
                    {
                        "provider": provider,
                        "source_ref": metadata.get("version_source_ref", source_ref),
                    }
                ),
                policy_ref="provider-owned-original-reference",
                created_at=now(),
            )
            insert(
                conn,
                "document_version",
                document_version_id=version_id,
                document_id=document_id,
                source_artifact_id=source_artifact,
                file_type=Path(metadata["filename"]).suffix.lstrip(".") or "xlsx",
                revision_no=(old["revision_no"] + 1) if old else 1,
                provider_version_token=metadata["token"],
                content_sha256=metadata["token"] if provider == "local-xlsx" else None,
                filename=metadata["filename"],
                author=metadata.get("author"),
                authored_at=metadata.get("authored_at"),
                excel_date_system=metadata.get("excel_date_system"),
                byte_size=metadata.get("byte_size"),
                captured_at=now(),
            )
            seen = set()
            for n, sheet in enumerate(metadata["sheets"]):
                if sheet["name"] in seen:
                    raise Problem("INVALID_SHEETS", "중복 시트 이름이 반환되었습니다.")
                seen.add(sheet["name"])
                insert(
                    conn,
                    "sheet",
                    sheet_id=uid(),
                    document_version_id=version_id,
                    name=sheet["name"],
                    ordinal=n,
                    visibility=sheet.get("visibility", "visible"),
                    native_sheet_key=sheet.get("native_sheet_key"),
                    estimated_rows=sheet.get("estimated_rows"),
                    estimated_cols=sheet.get("estimated_cols"),
                )
            conn.execute(
                "UPDATE document SET current_version_id=? WHERE document_id=?",
                (version_id, document_id),
            )
        return {
            "document_id": document_id,
            "version_id": version_id,
            "unchanged": False,
            "sheets": len(seen),
        }

    def import_kg(self, definition, principal, connection=None):
        if (
            not isinstance(definition, dict)
            or not 1 <= len(definition.get("concepts", [])) <= 10000
        ):
            raise Problem("INVALID_KG", "사람이 정의한 개념을 1~10,000개 지정하세요.")
        with (
            nullcontext(connection)
            if connection is not None
            else self.db.connect(write=True)
        ) as conn:
            hashed = digest(definition)
            exists = conn.execute(
                "SELECT * FROM kg_revision WHERE content_sha256=?", (hashed,)
            ).fetchone()
            if exists:
                return dict(exists)
            revision_id = uid()
            revision_no = conn.execute(
                "SELECT coalesce(max(revision_no),0)+1 FROM kg_revision"
            ).fetchone()[0]
            insert(
                conn,
                "kg_revision",
                kg_revision_id=revision_id,
                revision_no=revision_no,
                content_sha256=hashed,
                created_by=principal,
                created_at=now(),
            )
            for concept in definition["concepts"]:
                name = concept.get("name") or concept.get("canonical_name")
                level = concept.get("level", concept.get("domain_level", "L1")) or "L1"
                try:
                    level = int(str(level).removeprefix("L"))
                except ValueError:
                    raise Problem(
                        "INVALID_LEVEL",
                        "도메인 레벨은 양의 정수 또는 L1 같은 표현이어야 합니다.",
                    ) from None
                if not name or not concept.get("concept_id"):
                    raise Problem("INVALID_CONCEPT", "개념 ID와 이름이 필요합니다.")
                insert(
                    conn,
                    "domain_concept",
                    kg_revision_id=revision_id,
                    concept_id=concept["concept_id"],
                    name=name,
                    definition=concept.get("definition", concept.get("description"))
                    or name,
                    level=level,
                    value_type=concept.get("value_type", concept.get("data_type")),
                    canonical_unit=concept.get("canonical_unit"),
                    status=(
                        "deprecated"
                        if str(concept.get("status", "active")).lower()
                        in ("deprecated", "inactive")
                        else "active"
                    ),
                )
                seen = set()
                for alias in [name, *concept.get("aliases", [])]:
                    text = alias.get("text") if isinstance(alias, dict) else str(alias)
                    context = (
                        alias.get("context", {}) if isinstance(alias, dict) else {}
                    )
                    key = (norm(text), dump(context))
                    if key in seen:
                        continue
                    seen.add(key)
                    insert(
                        conn,
                        "domain_alias",
                        kg_revision_id=revision_id,
                        concept_id=concept["concept_id"],
                        alias_norm=key[0],
                        alias_text=text,
                        context_key=key[1],
                        context_json=key[1],
                    )
            for edge in definition.get("relations", []):
                source, target, kind = (
                    (edge["from"], edge["to"], edge["type"])
                    if isinstance(edge, dict)
                    else edge
                )
                insert(
                    conn,
                    "domain_edge",
                    kg_revision_id=revision_id,
                    from_concept_id=source,
                    to_concept_id=target,
                    relation_type=kind,
                )
        return {"kg_revision_id": revision_id, "revision_no": revision_no}

    def import_current_kg(self, principal):
        # 현재 사용자가 편집한 v1 KG가 있으면 그 상태를 읽고, 없으면 워크스페이스의 수동 YAML을 읽는다.
        import sqlite3

        legacy = self.root / "data/kg/kg.db"
        if legacy.exists():
            conn = sqlite3.connect(f"file:{legacy.as_posix()}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            try:
                concepts = [
                    dict(r) for r in conn.execute("SELECT * FROM domain_concept")
                ]
                if concepts:
                    for c in concepts:
                        c["aliases"] = [
                            r[0]
                            for r in conn.execute(
                                "SELECT alias_text FROM domain_alias WHERE concept_id=?",
                                (c["concept_id"],),
                            )
                        ]
                    relations = [
                        list(r)
                        for r in conn.execute(
                            "SELECT source_concept_id,target_concept_id,relation_type FROM domain_relation"
                        )
                    ]
                    return self.import_kg(
                        {"concepts": concepts, "relations": relations}, principal
                    )
            finally:
                conn.close()
        path = self.root / "config/domain_kg.yaml"
        if not path.exists():
            path = self.root / "config/concepts.yaml"
        if not path.exists():
            raise Problem(
                "KG_SOURCE_MISSING",
                "기존 도메인 정의가 없습니다. KG JSON을 등록하세요.",
                404,
            )
        definition = yaml.safe_load(path.read_text(encoding="utf-8"))
        return self.import_kg(definition, principal)

    def create_template(self, name, definition, principal, template_id=None):
        spec = validate_template(definition)
        with self.db.connect(write=True) as conn:
            kg = spec.get("kg_revision_id")
            one(conn, "SELECT * FROM kg_revision WHERE kg_revision_id=?", (kg,))
            if not name or len(name) > 200:
                raise Problem("INVALID_NAME", "템플릿 이름을 지정하세요.")
            if template_id:
                one(conn, "SELECT * FROM template WHERE template_id=?", (template_id,))
            else:
                template_id = uid()
                insert(
                    conn,
                    "template",
                    template_id=template_id,
                    name=name,
                    created_by=principal,
                    created_at=now(),
                )
            number = conn.execute(
                "SELECT coalesce(max(revision_no),0)+1 FROM template_version WHERE template_id=?",
                (template_id,),
            ).fetchone()[0]
            tid = uid()
            insert(
                conn,
                "template_version",
                template_version_id=tid,
                template_id=template_id,
                revision_no=number,
                kg_revision_id=kg,
                format="json",
                definition_json=dump(spec),
                definition_sha256=digest(spec),
                engine_contract_version="2.0",
                environment_json=dump({"engine": ENGINE_VERSION}),
                created_by=principal,
                created_at=now(),
            )
            for n, rule in enumerate(spec["rules"]):
                if rule.get("concept_id"):
                    one(
                        conn,
                        "SELECT * FROM domain_concept WHERE kg_revision_id=? AND concept_id=? AND status='active'",
                        (kg, rule["concept_id"]),
                    )
                insert(
                    conn,
                    "template_rule",
                    template_version_id=tid,
                    rule_key=rule["rule_key"],
                    kg_revision_id=kg,
                    concept_id=rule.get("concept_id"),
                    ordinal=n,
                    selector_json=dump(rule["selector"]),
                    record_spec_json=dump(rule["record_spec"]),
                    value_spec_json=dump(rule["value_spec"]),
                )
        return {
            "template_id": template_id,
            "template_version_id": tid,
            "revision_no": number,
        }

    def apply_template(
        self, version_id, template_version_id, bindings, scope_key, approved, principal
    ):
        with self.db.connect(write=True) as conn:
            one(
                conn,
                "SELECT * FROM document_version WHERE document_version_id=?",
                (version_id,),
            )
            tv = one(
                conn,
                "SELECT * FROM template_version WHERE template_version_id=?",
                (template_version_id,),
            )
            spec = json.loads(tv["definition_json"])
            sheets = {
                r["sheet_id"]: dict(r)
                for r in conn.execute(
                    "SELECT * FROM sheet WHERE document_version_id=?", (version_id,)
                )
            }
            if set(bindings) != set(spec["sheet_roles"]):
                raise Problem(
                    "SHEET_ROLE_MISMATCH", "템플릿의 모든 시트 역할을 연결하세요."
                )
            for role, ids in bindings.items():
                if (
                    not isinstance(ids, list)
                    or not ids
                    or len(ids) != len(set(ids))
                    or any(i not in sheets for i in ids)
                ):
                    raise Problem(
                        "INVALID_SHEET_BINDING",
                        "현재 문서 버전의 시트를 역할별로 선택하세요.",
                    )
                if (
                    spec["sheet_roles"][role].get("cardinality", "one") == "one"
                    and len(ids) != 1
                ):
                    raise Problem(
                        "INVALID_SHEET_BINDING",
                        "이 시트 역할에는 한 시트만 연결할 수 있습니다.",
                    )
            app_id = uid()
            insert(
                conn,
                "template_application",
                application_id=app_id,
                document_version_id=version_id,
                template_version_id=template_version_id,
                scope_key=scope_key or app_id,
                created_at=now(),
            )
            for role, ids in bindings.items():
                for n, sid in enumerate(ids):
                    insert(
                        conn,
                        "application_sheet",
                        application_id=app_id,
                        document_version_id=version_id,
                        role_key=role,
                        ordinal=n,
                        sheet_id=sid,
                    )
            for rule in spec["rules"]:
                mid = uid()
                status = (
                    "approved" if approved and rule.get("concept_id") else "proposed"
                )
                insert(
                    conn,
                    "mapping_revision",
                    mapping_revision_id=mid,
                    application_id=app_id,
                    document_version_id=version_id,
                    template_version_id=template_version_id,
                    rule_key=rule["rule_key"],
                    revision_no=1,
                    kg_revision_id=tv["kg_revision_id"],
                    concept_id=rule.get("concept_id"),
                    origin="template",
                    status=status,
                    effective_spec_json=dump(rule),
                    evidence_json=dump({"approved_on_assignment": bool(approved)}),
                    created_by=principal,
                    reason="사용자의 템플릿 배정",
                    created_at=now(),
                )
                if status == "approved":
                    insert(
                        conn,
                        "mapping_head",
                        application_id=app_id,
                        rule_key=rule["rule_key"],
                        mapping_revision_id=mid,
                    )
        return {"application_id": app_id}

    def mapping(self, mapping_id):
        with self.db.connect() as conn:
            row = one(
                conn,
                "SELECT m.*,coalesce(h.edit_seq,0) edit_seq FROM mapping_revision m LEFT JOIN mapping_head h ON h.application_id=m.application_id AND h.rule_key=m.rule_key WHERE m.mapping_revision_id=?",
                (mapping_id,),
            )
        row["effective_spec"] = json.loads(row.pop("effective_spec_json"))
        row["evidence"] = json.loads(row.pop("evidence_json"))
        return row

    def revise(
        self,
        application_id,
        mapping_id,
        expected_seq,
        spec,
        concept_id,
        status,
        reason,
        principal,
    ):
        with self.db.connect(write=True) as conn:
            old = one(
                conn,
                "SELECT m.*,tv.definition_json FROM mapping_revision m JOIN template_version tv USING(template_version_id) WHERE mapping_revision_id=? AND application_id=?",
                (mapping_id, application_id),
            )
            head = conn.execute(
                "SELECT * FROM mapping_head WHERE application_id=? AND rule_key=?",
                (application_id, old["rule_key"]),
            ).fetchone()
            latest = conn.execute(
                "SELECT mapping_revision_id FROM mapping_revision WHERE application_id=? AND rule_key=? ORDER BY revision_no DESC LIMIT 1",
                (application_id, old["rule_key"]),
            ).fetchone()[0]
            if (
                expected_seq != (head["edit_seq"] if head else 0)
                or mapping_id != latest
            ):
                raise Problem(
                    "EDIT_CONFLICT",
                    "다른 수정이 먼저 저장되었습니다. 최신 매핑을 다시 확인하세요.",
                    409,
                )
            effective = copy.deepcopy(spec)
            effective["rule_key"], effective["concept_id"] = old["rule_key"], concept_id
            validate_rule(effective, json.loads(old["definition_json"])["sheet_roles"])
            if concept_id:
                one(
                    conn,
                    "SELECT * FROM domain_concept WHERE kg_revision_id=? AND concept_id=? AND status='active'",
                    (old["kg_revision_id"], concept_id),
                )
            if (
                status not in ("approved", "rejected", "proposed")
                or status == "approved"
                and not concept_id
            ):
                raise Problem("INVALID_APPROVAL", "승인하려면 연결 개념이 필요합니다.")
            new_id = uid()
            insert(
                conn,
                "mapping_revision",
                mapping_revision_id=new_id,
                application_id=application_id,
                document_version_id=old["document_version_id"],
                template_version_id=old["template_version_id"],
                rule_key=old["rule_key"],
                revision_no=old["revision_no"] + 1,
                kg_revision_id=old["kg_revision_id"],
                concept_id=concept_id,
                origin="manual",
                status=status,
                effective_spec_json=dump(effective),
                supersedes_id=mapping_id,
                created_by=principal,
                reason=reason or "원본 영역/개념 검수",
                created_at=now(),
            )
            if status == "approved":
                if head:
                    changed = conn.execute(
                        "UPDATE mapping_head SET mapping_revision_id=?,edit_seq=edit_seq+1 WHERE application_id=? AND rule_key=? AND edit_seq=?",
                        (new_id, application_id, old["rule_key"], expected_seq),
                    ).rowcount
                    if changed != 1:
                        raise Problem("EDIT_CONFLICT", "수정 충돌이 발생했습니다.", 409)
                else:
                    insert(
                        conn,
                        "mapping_head",
                        application_id=application_id,
                        rule_key=old["rule_key"],
                        mapping_revision_id=new_id,
                        edit_seq=old["revision_no"] + 1,
                    )
            elif head:
                conn.execute(
                    "DELETE FROM mapping_head WHERE application_id=? AND rule_key=?",
                    (application_id, old["rule_key"]),
                )
        return self.mapping(new_id)

    def prepare_extraction(self, conn, job_id, payload):
        import platform
        from importlib.metadata import version as package_version

        app = one(
            conn,
            "SELECT a.*,tv.definition_sha256,tv.kg_revision_id FROM template_application a JOIN template_version tv USING(template_version_id) WHERE application_id=?",
            (payload["application_id"],),
        )
        mappings = [
            dict(r)
            for r in conn.execute(
                "SELECT m.* FROM mapping_head h JOIN mapping_revision m USING(mapping_revision_id) WHERE h.application_id=? ORDER BY h.rule_key",
                (app["application_id"],),
            )
        ]
        count = conn.execute(
            "SELECT count(*) FROM template_rule WHERE template_version_id=?",
            (app["template_version_id"],),
        ).fetchone()[0]
        if not mappings or len(mappings) != count:
            raise Problem(
                "REVIEW_REQUIRED",
                "모든 규칙의 키·값 영역과 연결 개념을 승인한 뒤 추출하세요.",
                409,
            )
        binding_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT a.*,s.name FROM application_sheet a JOIN sheet s USING(sheet_id) WHERE application_id=? ORDER BY role_key,ordinal",
                (app["application_id"],),
            )
        ]
        manifest = {
            "version": app["document_version_id"],
            "template": app["template_version_id"],
            "kg": app["kg_revision_id"],
            "mappings": [r["mapping_revision_id"] for r in mappings],
            "bindings": binding_rows,
            "engine": ENGINE_VERSION,
            "runtime": {
                "python": platform.python_version(),
                "openpyxl": package_version("openpyxl"),
                "reader_revision": os.environ.get(
                    "KG_V2_READER_REVISION", "unversioned-operator-adapter"
                ),
            },
        }
        insert(
            conn,
            "extraction_run",
            run_id=job_id,
            application_id=app["application_id"],
            document_version_id=app["document_version_id"],
            template_version_id=app["template_version_id"],
            request_key=job_id,
            input_fingerprint=digest(manifest),
            engine_version=ENGINE_VERSION,
            environment_json=dump(manifest),
            status="queued",
            created_at=now(),
        )
        for m in mappings:
            insert(
                conn,
                "run_mapping",
                run_id=job_id,
                application_id=app["application_id"],
                rule_key=m["rule_key"],
                mapping_revision_id=m["mapping_revision_id"],
            )
        return {**payload, "run_id": job_id}
