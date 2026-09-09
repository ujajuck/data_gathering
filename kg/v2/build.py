"""고정 실행을 읽어 사용자 SQLite DB를 만들고 모든 기여 항목의 출처를 남긴다."""

from __future__ import annotations

import json
import re
import sqlite3
from decimal import localcontext
from pathlib import Path

from .db import Problem, digest, dump, insert, now, one, uid
from .jobs import Cancelled
from .readers import file_hash
from .spec import decimal, decimal_text


def create_integration(service, name, spec, principal, project_id=None):
    if (
        not name
        or len(name) > 200
        or not isinstance(spec, dict)
        or len(dump(spec)) > 512000
    ):
        raise Problem(
            "INVALID_INTEGRATION", "DB 이름과 512KB 이하의 통합 명세를 지정하세요."
        )
    fields = spec.get("fields", [])
    if not isinstance(fields, list) or not 1 <= len(fields) <= 100:
        raise Problem("INVALID_FIELDS", "출력 필드를 1~100개 선택하세요.")
    mode = spec.setdefault("row_mode", "record_scope")
    if mode not in ("record_scope", "business_key", "aggregate"):
        raise Problem(
            "INVALID_ROW_MODE",
            "행 결합은 record_scope/business_key/aggregate를 지원합니다.",
        )
    if mode == "business_key" and not spec.get("business_key_confirmed"):
        raise Problem(
            "BUSINESS_KEY_REQUIRED", "업무키의 문서 간 동일한 의미를 확인하세요."
        )
    output_names = [f.get("output_name", "").casefold() for f in fields]
    if len(set(output_names)) != len(output_names):
        raise Problem(
            "DUPLICATE_OUTPUT_NAME",
            "출력 열 이름은 대소문자를 구분하지 않고 서로 달라야 합니다.",
        )
    with service.db.connect(write=True) as conn:
        kg = spec.get("kg_revision_id")
        one(conn, "SELECT * FROM kg_revision WHERE kg_revision_id=?", (kg,))
        if project_id:
            one(
                conn,
                "SELECT * FROM integration_project WHERE project_id=?",
                (project_id,),
            )
        else:
            project_id = uid()
            insert(
                conn,
                "integration_project",
                project_id=project_id,
                name=name,
                created_by=principal,
                created_at=now(),
            )
        vid = uid()
        rev = conn.execute(
            "SELECT coalesce(max(revision_no),0)+1 FROM integration_version WHERE project_id=?",
            (project_id,),
        ).fetchone()[0]
        insert(
            conn,
            "integration_version",
            integration_version_id=vid,
            project_id=project_id,
            revision_no=rev,
            kg_revision_id=kg,
            spec_json=dump(spec),
            spec_sha256=digest(spec),
            created_at=now(),
        )
        for n, field in enumerate(fields):
            key, output = field.get("field_key"), field.get("output_name")
            if (
                not isinstance(key, str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key)
                or not isinstance(output, str)
                or not 1 <= len(output) <= 100
                or output.startswith("_")
                or "\0" in output
            ):
                raise Problem(
                    "INVALID_FIELD_NAME",
                    "필드 ID는 영문·숫자·밑줄, 출력 이름은 밑줄로 시작하지 않는 이름을 지정하세요.",
                )
            target = field.get("target_type", "text")
            if target not in ("decimal", "text", "boolean", "date", "datetime"):
                raise Problem(
                    "INVALID_FIELD_TYPE", "출력 값의 타입이 유효하지 않습니다."
                )
            if mode == "aggregate" and (
                field.get("aggregate", "sum") not in ("sum", "min", "max", "count")
                or target != "decimal"
            ):
                raise Problem(
                    "INVALID_AGGREGATE",
                    "집계는 decimal 필드의 sum/min/max/count를 지원합니다.",
                )
            if (
                mode == "aggregate"
                and field.get("aggregate") == "count"
                and field.get("target_unit")
            ):
                raise Problem(
                    "COUNT_UNIT", "count 결과는 개수입니다. 목표 단위를 비우세요."
                )
            insert(
                conn,
                "integration_field",
                integration_version_id=vid,
                field_key=key,
                kg_revision_id=kg,
                concept_id=field.get("concept_id"),
                output_name=output,
                ordinal=n,
                target_type=target,
                target_unit=field.get("target_unit"),
            )
            sources = field.get("sources", [])
            if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
                raise Problem(
                    "INVALID_SOURCES", "필드마다 추출 소스를 1~100개 선택하세요."
                )
            for source in sources:
                app = one(
                    conn,
                    "SELECT * FROM template_application WHERE application_id=?",
                    (source.get("application_id"),),
                )
                insert(
                    conn,
                    "integration_source",
                    integration_version_id=vid,
                    field_key=key,
                    application_id=app["application_id"],
                    template_version_id=app["template_version_id"],
                    rule_key=source.get("rule_key"),
                    pinned_run_id=source.get("pinned_run_id"),
                )
    return {"project_id": project_id, "integration_version_id": vid, "revision_no": rev}


def prepare_build(conn, job_id, payload):
    version = one(
        conn,
        "SELECT * FROM integration_version WHERE integration_version_id=?",
        (payload["integration_version_id"],),
    )
    spec = json.loads(version["spec_json"])
    selections = []
    for source in conn.execute(
        "SELECT f.*,a.published_run_id,a.document_version_id,d.current_version_id FROM integration_source f JOIN template_application a USING(application_id) JOIN document_version v ON v.document_version_id=a.document_version_id JOIN document d USING(document_id) WHERE integration_version_id=? ORDER BY field_key,application_id,rule_key",
        (version["integration_version_id"],),
    ):
        run_id = source["pinned_run_id"] or source["published_run_id"]
        if (
            not run_id
            or not source["pinned_run_id"]
            and source["current_version_id"] != source["document_version_id"]
        ):
            raise Problem(
                "SOURCE_NOT_CURRENT",
                "현재 문서 버전의 발행 결과가 없습니다. 추출하거나 과거 실행을 명시적으로 고정하세요.",
                409,
            )
        mapping = one(
            conn,
            "SELECT m.* FROM run_mapping r JOIN extraction_run e USING(run_id) JOIN mapping_revision m USING(mapping_revision_id) WHERE r.run_id=? AND r.rule_key=? AND e.status='succeeded'",
            (run_id, source["rule_key"]),
        )
        field = next(f for f in spec["fields"] if f["field_key"] == source["field_key"])
        if mapping["kg_revision_id"] != version["kg_revision_id"] or mapping[
            "concept_id"
        ] != field.get("concept_id"):
            raise Problem(
                "CONCEPT_MISMATCH",
                "출력 필드와 추출 소스의 KG 버전/개념이 다릅니다.",
                409,
            )
        effective = json.loads(mapping["effective_spec_json"])
        if spec["row_mode"] == "business_key" and not isinstance(
            effective["record_spec"]["key"], dict
        ):
            raise Problem(
                "BUSINESS_KEY_REQUIRED",
                "문서 간 결합에는 모든 소스에 업무키 행/열을 지정해야 합니다.",
            )
        selections.append(
            {
                "field_key": source["field_key"],
                "run_id": run_id,
                "rule_key": source["rule_key"],
                "version_id": source["document_version_id"],
            }
        )
    manifest = {
        "selections": selections,
        "spec_sha256": version["spec_sha256"],
        "engine": "sqlite-build-v2.0",
        "decimal_precision": 4096,
    }
    insert(
        conn,
        "build_run",
        build_id=job_id,
        integration_version_id=version["integration_version_id"],
        status="queued",
        input_fingerprint=digest(manifest),
        input_manifest_json=dump(manifest),
        created_at=now(),
    )
    for run_id in sorted({s["run_id"] for s in selections}):
        insert(
            conn,
            "build_input",
            build_id=job_id,
            run_id=run_id,
            selection_json=dump([s for s in selections if s["run_id"] == run_id]),
        )
    return {**payload, "build_id": job_id}


def authorize_build(service, build_id, principal, checkpoint=lambda: None):
    with service.db.connect() as conn:
        row = one(conn, "SELECT * FROM build_run WHERE build_id=?", (build_id,))
    for version in sorted(
        {s["version_id"] for s in json.loads(row["input_manifest_json"])["selections"]}
    ):
        service.authorize(version, principal, "extract", checkpoint)
    return row


def output_path(service, build_id):
    # 외부 경로를 받지 않고 DB에 등록된 build UUID로만 출력 경로를 결정한다.
    with service.db.connect() as conn:
        row = one(
            conn,
            "SELECT * FROM build_run WHERE build_id=? AND status='succeeded'",
            (build_id,),
        )
    return service.root / "data/v2-builds" / (row["build_id"] + ".sqlite")


def execute_build(service, payload, principal, checkpoint):
    build_id = payload["build_id"]
    build = authorize_build(service, build_id, principal, checkpoint)
    with service.db.connect(write=True) as conn:
        version = one(
            conn,
            "SELECT * FROM integration_version WHERE integration_version_id=?",
            (build["integration_version_id"],),
        )
        conn.execute(
            "UPDATE build_run SET status='running' WHERE build_id=?", (build_id,)
        )
    spec, manifest = json.loads(version["spec_json"]), json.loads(
        build["input_manifest_json"]
    )
    fields = {f["field_key"]: f for f in spec["fields"]}
    folder = service.root / "data/v2-builds"
    folder.mkdir(parents=True, exist_ok=True)
    staging, target = folder / (build_id + ".work"), folder / (build_id + ".sqlite")
    if staging.exists() or target.exists():
        raise Problem(
            "BUILD_FILE_EXISTS", "동일 실행의 출력 파일이 이미 있습니다.", 409
        )
    disk = sqlite3.connect(staging)
    disk.row_factory = sqlite3.Row
    finished = False
    try:
        disk.executescript(
            """CREATE TABLE observations(field TEXT,row_key TEXT,identity TEXT,item_id TEXT,value_json TEXT,PRIMARY KEY(field,row_key,item_id));
          CREATE INDEX observation_group ON observations(row_key,field,identity);
          CREATE TABLE unique_values(field TEXT,row_key TEXT,identity TEXT,value_json TEXT,PRIMARY KEY(field,row_key,identity));
          CREATE TABLE _field_schema(field_key TEXT,output_name TEXT,value_type TEXT,unit TEXT);
          CREATE TABLE _manifest(json TEXT);
          CREATE TABLE _lineage(row_key TEXT,field_key TEXT,item_id TEXT,contribution_role TEXT,source_json TEXT);
          CREATE INDEX exported_lineage ON _lineage(row_key,field_key);
        """
        )
        columns = [f["output_name"] for f in fields.values()]
        quote = lambda name: '"' + name.replace('"', '""') + '"'
        disk.execute(
            "CREATE TABLE data(_row_no INTEGER PRIMARY KEY,_row_key TEXT UNIQUE,"
            + ",".join(quote(c) + " TEXT" for c in columns)
            + ")"
        )
        disk.execute(
            "INSERT INTO _manifest VALUES (?)",
            (
                dump(
                    {
                        **manifest,
                        "build_id": build_id,
                        "integration_version_id": version["integration_version_id"],
                    }
                ),
            ),
        )
        for field in fields.values():
            disk.execute(
                "INSERT INTO _field_schema VALUES (?,?,?,?)",
                (
                    field["field_key"],
                    field["output_name"],
                    field.get("target_type", "text"),
                    field.get("target_unit"),
                ),
            )
        count = 0
        for selected in manifest["selections"]:
            field = fields[selected["field_key"]]
            with service.db.connect() as conn:
                rows = conn.execute(
                    "SELECT i.*,s.record_scope_key FROM extracted_item i JOIN extracted_series s USING(series_id) JOIN mapping_revision m USING(mapping_revision_id) WHERE s.run_id=? AND m.rule_key=? ORDER BY i.series_id,i.item_index",
                    (selected["run_id"], selected["rule_key"]),
                )
                for item in rows:
                    checkpoint(count)
                    count_mode = (
                        spec["row_mode"] == "aggregate"
                        and field.get("aggregate") == "count"
                    )
                    if (
                        item["value_state"] == "present"
                        and not count_mode
                        and (
                            item["value_type"] != field.get("target_type", "text")
                            or (item["unit_normalized"] or None)
                            != (field.get("target_unit") or None)
                        )
                    ):
                        raise Problem(
                            "OUTPUT_TYPE_UNIT_MISMATCH",
                            "출력 필드와 값의 타입/단위가 다릅니다. 추출 정규화 설정을 확인하세요.",
                        )
                    row_key = (
                        "all"
                        if spec["row_mode"] == "aggregate"
                        else (
                            dump([item["record_key"]])
                            if spec["row_mode"] == "business_key"
                            else dump([item["record_scope_key"], item["record_key"]])
                        )
                    )
                    identity = digest(
                        [item["source_identity_key"], item["derivation_key"]]
                    )
                    value = dump(
                        [
                            item["value_type"],
                            item["value_text"],
                            item["value_state"],
                            item["unit_normalized"],
                        ]
                    )
                    previous = disk.execute(
                        "SELECT value_json FROM unique_values WHERE field=? AND row_key=? AND identity=?",
                        (selected["field_key"], row_key, identity),
                    ).fetchone()
                    if previous and previous[0] != value:
                        raise Problem(
                            "SOURCE_VALUE_CONFLICT",
                            "동일 원본·변환의 값이 서로 다릅니다. 추출 실행을 확인하세요.",
                            409,
                        )
                    disk.execute(
                        "INSERT OR IGNORE INTO unique_values VALUES (?,?,?,?)",
                        (selected["field_key"], row_key, identity, value),
                    )
                    disk.execute(
                        "INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?)",
                        (
                            selected["field_key"],
                            row_key,
                            identity,
                            item["item_id"],
                            value,
                        ),
                    )
                    count += 1
                    if count > 1000000:
                        raise Problem(
                            "BUILD_ITEM_LIMIT",
                            "통합 작업당 1,000,000개 항목을 초과했습니다. 소스를 나누세요.",
                            413,
                        )
                    if count % 500 == 0:
                        disk.commit()
        disk.commit()
        row_count = 0
        for group in disk.execute(
            "SELECT DISTINCT row_key FROM unique_values ORDER BY row_key"
        ):
            row_key, output = group[0], []
            for key, field in fields.items():
                values = disk.execute(
                    "SELECT identity,value_json FROM unique_values WHERE row_key=? AND field=? ORDER BY identity",
                    (row_key, key),
                )
                value_count, present_count, result = 0, 0, None
                operation = field.get("aggregate", "sum")
                with localcontext() as ctx:
                    ctx.prec = 4096
                    for value in values:
                        value_count += 1
                        if spec["row_mode"] != "aggregate" and value_count > 1:
                            raise Problem(
                                "OUTPUT_ROW_CONFLICT",
                                "같은 업무 행·필드에 서로 다른 원본 항목이 있습니다. 행 범위 또는 집계를 명시하세요.",
                                409,
                            )
                        parsed = json.loads(value["value_json"])
                        if parsed[2] != "present":
                            continue
                        present_count += 1
                        if spec["row_mode"] != "aggregate":
                            result = parsed[1]
                        else:
                            number = (
                                decimal(parsed[1]) if operation != "count" else None
                            )
                            if operation == "sum":
                                result = (result or decimal(0)) + number
                            elif operation == "min":
                                result = (
                                    number if result is None else min(result, number)
                                )
                            elif operation == "max":
                                result = (
                                    number if result is None else max(result, number)
                                )
                        if present_count % 100 == 0:
                            checkpoint(count + row_count)
                if spec["row_mode"] == "aggregate":
                    result = (
                        decimal_text(present_count)
                        if operation == "count"
                        else decimal_text(result) if result is not None else None
                    )
                output.append(result)
            disk.execute(
                "INSERT INTO data VALUES ("
                + ",".join("?" for _ in range(len(output) + 2))
                + ")",
                (row_count + 1, row_key, *output),
            )
            for key, field in fields.items():
                observations = disk.execute(
                    "SELECT item_id,identity FROM observations WHERE row_key=? AND field=? ORDER BY identity,item_id",
                    (row_key, key),
                )
                ordinal, previous = 0, None
                while batch := observations.fetchmany(100):
                    checkpoint(count + row_count, force=True)
                    with service.db.connect(write=True) as conn:
                        for observation in batch:
                            item_id = observation["item_id"]
                            role = (
                                "deduplicated"
                                if observation["identity"] == previous
                                else (
                                    "aggregate_input"
                                    if spec["row_mode"] == "aggregate"
                                    else "value"
                                )
                            )
                            previous = observation["identity"]
                            path = {
                                "row_mode": spec["row_mode"],
                                "aggregate": field.get("aggregate"),
                                "dedup": "source-and-derivation-v1",
                            }
                            insert(
                                conn,
                                "build_lineage",
                                build_id=build_id,
                                integration_version_id=version[
                                    "integration_version_id"
                                ],
                                output_table="data",
                                output_row_key=row_key,
                                field_key=key,
                                ordinal=ordinal,
                                item_id=item_id,
                                contribution_role=role,
                                transform_path_json=dump(path),
                            )
                            sources = [
                                dict(r)
                                for r in conn.execute(
                                    "SELECT ir.role,r.document_version_id,r.sheet_id,s.name,r.r1,r.c1,r.r2,r.c2 FROM item_region ir JOIN source_region r USING(region_id) JOIN sheet s USING(sheet_id) WHERE ir.item_id=? ORDER BY ir.role,ir.ordinal",
                                    (item_id,),
                                )
                            ]
                            disk.execute(
                                "INSERT INTO _lineage VALUES (?,?,?,?,?)",
                                (row_key, key, item_id, role, dump(sources)),
                            )
                            ordinal += 1
            row_count += 1
            if row_count % 100 == 0:
                disk.commit()
        if not row_count:
            raise Problem("EMPTY_BUILD", "선택한 소스에 결과 항목이 없습니다.")
        disk.executescript("DROP TABLE observations; DROP TABLE unique_values;")
        disk.commit()
        disk.close()
        authorize_build(service, build_id, principal, checkpoint)
        checkpoint(count, count, force=True)
        hashed, size = file_hash(staging), staging.stat().st_size
        with service.db.connect(write=True) as conn:
            job = one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (build_id,))
            if job["cancel_requested"] or job["state"] != "running":
                raise Cancelled()
            artifact_id = uid()
            insert(
                conn,
                "artifact",
                artifact_id=artifact_id,
                kind="dataset",
                storage_ref="v2-build:" + build_id,
                sha256=hashed,
                byte_size=size,
                media_type="application/vnd.sqlite3",
                policy_ref="reauthorize-all-inputs",
                created_at=now(),
            )
            staging.rename(target)
            conn.execute(
                "UPDATE build_run SET status='succeeded',output_artifact_id=?,row_count=?,finished_at=? WHERE build_id=?",
                (artifact_id, row_count, now(), build_id),
            )
        finished = True
        return {
            "build_id": build_id,
            "row_count": row_count,
            "integration_version_id": version["integration_version_id"],
            "sha256": hashed,
        }
    finally:
        disk.close()
        if not finished:
            staging.unlink(missing_ok=True)
            target.unlink(missing_ok=True)
