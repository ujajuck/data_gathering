"""Reader 스트림을 불변 series/item/원자 출처로 저장하고 성공 결과만 발행한다."""

from __future__ import annotations

import json

from .db import Problem, digest, dump, insert, now, one, uid
from .jobs import Cancelled, reader_events
from .spec import bounds


def ensure_region(conn, version_id, sheets, region):
    if region.get("sheet") not in sheets:
        raise Problem(
            "REGION_SHEET_MISMATCH", "원본 영역이 적용 건의 시트를 벗어났습니다."
        )
    sid = sheets[region["sheet"]]
    r1, c1, r2, c2 = bounds(region["range"])
    key = dump([region.get("kind", "cells"), r1, c1, r2, c2, region.get("object_key")])
    existing = conn.execute(
        "SELECT region_id FROM source_region WHERE sheet_id=? AND locator_key=?",
        (sid, key),
    ).fetchone()
    if existing:
        return existing[0]
    rid = uid()
    insert(
        conn,
        "source_region",
        region_id=rid,
        document_version_id=version_id,
        sheet_id=sid,
        locator_key=key,
        kind=region.get("kind", "cells"),
        r1=r1,
        c1=c1,
        r2=r2,
        c2=c2,
        merge_anchor_r=region.get("merge_anchor_r"),
        merge_anchor_c=region.get("merge_anchor_c"),
        object_key=region.get("object_key"),
        geometry_json=dump(region.get("geometry")) if region.get("geometry") else None,
    )
    return rid


def execute_extraction(service, payload, principal, checkpoint):
    db, run_id = service.db, payload["run_id"]
    with db.connect() as conn:
        run = one(conn, "SELECT * FROM extraction_run WHERE run_id=?", (run_id,))
        mappings = {
            r["rule_key"]: dict(r)
            for r in conn.execute(
                "SELECT m.* FROM run_mapping r JOIN mapping_revision m USING(mapping_revision_id) WHERE run_id=?",
                (run_id,),
            )
        }
        binding_rows = list(
            conn.execute(
                "SELECT a.role_key,a.sheet_id,s.name FROM application_sheet a JOIN sheet s USING(sheet_id) WHERE application_id=? ORDER BY a.role_key,a.ordinal",
                (run["application_id"],),
            )
        )
    bindings, sheets = {}, {}
    for r in binding_rows:
        bindings.setdefault(r["role_key"], []).append(r["name"])
        sheets[r["name"]] = r["sheet_id"]
    version, _ = service.authorize(
        run["document_version_id"], principal, "extract", checkpoint
    )
    if not version["provider_version_token"]:
        raise Problem(
            "VERSION_REQUIRED", "제공자가 고정 원본 버전을 지원해야 추출할 수 있습니다."
        )
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE extraction_run SET status='running' WHERE run_id=?", (run_id,)
        )
    rules = [json.loads(m["effective_spec_json"]) for m in mappings.values()]
    series, count, verified = {}, 0, False
    for event in reader_events(
        service.root,
        version["provider"],
        principal,
        "extract",
        {
            "source_ref": version["source_ref"],
            "expected_token": version["provider_version_token"],
            "rules": rules,
            "bindings": bindings,
        },
        checkpoint,
    ):
        checkpoint(count)
        if event.get("type") == "verified":
            verified = event.get("token") == version["provider_version_token"]
            continue
        if verified:
            raise Problem(
                "INVALID_READER_CONTRACT", "검증 완료 뒤에 추출값이 추가되었습니다."
            )
        with db.connect(write=True) as conn:
            if event.get("type") == "series":
                mapping = mappings.get(event["rule_key"])
                if (
                    not mapping
                    or event["key"] in series
                    or event["primary_sheet"] not in sheets
                ):
                    raise Problem(
                        "INVALID_READER_CONTRACT", "규칙/반복 블록이 유효하지 않습니다."
                    )
                if len(series) >= 10000:
                    raise Problem(
                        "SERIES_LIMIT",
                        "한 실행의 반복 블록이 10,000개를 초과했습니다.",
                        413,
                    )
                sid = uid()
                effective = json.loads(mapping["effective_spec_json"])
                scope = dump(
                    [
                        run["document_version_id"],
                        sheets[event["primary_sheet"]],
                        effective["record_spec"]["scope"],
                    ]
                )
                if effective["selector"]["key"].get("repeat") == "each":
                    scope = dump([scope, event["regions"]["key"][0]["range"]])
                insert(
                    conn,
                    "extracted_series",
                    series_id=sid,
                    run_id=run_id,
                    mapping_revision_id=mapping["mapping_revision_id"],
                    document_version_id=run["document_version_id"],
                    instance_key=event["key"],
                    record_scope_key=scope,
                    observed_key=event.get("observed_key"),
                    cardinality=event["cardinality"],
                    axis=event["axis"],
                    status=event.get("status", "ready"),
                )
                for role, regions in event["regions"].items():
                    if len(regions) > 1000:
                        raise Problem(
                            "REGION_LIMIT", "한 규칙의 영역이 너무 많습니다.", 413
                        )
                    for n, region in enumerate(regions):
                        rid = ensure_region(
                            conn, run["document_version_id"], sheets, region
                        )
                        insert(
                            conn,
                            "series_region",
                            series_id=sid,
                            document_version_id=run["document_version_id"],
                            role=role,
                            ordinal=n,
                            region_id=rid,
                        )
                derivation = dump(
                    {
                        "value_spec": effective["value_spec"],
                        "combine": effective["selector"]["value"].get(
                            "combine", "ordered_union"
                        ),
                        "context": effective.get("meaning_context", {}),
                        "record_spec": effective["record_spec"],
                    }
                )
                series[event["key"]] = (sid, derivation)
            elif event.get("type") == "items":
                if (
                    event["series"] not in series
                    or not isinstance(event.get("items"), list)
                    or len(event["items"]) > 200
                ):
                    raise Problem(
                        "INVALID_READER_CONTRACT", "추출 항목 배치가 유효하지 않습니다."
                    )
                sid, derivation = series[event["series"]]
                for item in event["items"]:
                    iid, identities, links = uid(), [], []
                    if item.get("value_state") not in ("present", "blank"):
                        raise Problem(
                            "UNRESOLVED_VALUE",
                            "해결되지 않은 값이 있어 발행할 수 없습니다.",
                        )
                    if sum(len(r) for r in item["regions"].values()) > 1000:
                        raise Problem(
                            "ATOMIC_REGION_LIMIT",
                            "한 항목에 1,000개를 초과하는 출처가 있습니다. 결합을 나누세요.",
                            413,
                        )
                    for role, regions in item["regions"].items():
                        for n, region in enumerate(regions):
                            rid = ensure_region(
                                conn, run["document_version_id"], sheets, region
                            )
                            identities.append(
                                [
                                    role,
                                    n,
                                    sheets[region["sheet"]],
                                    list(bounds(region["range"])),
                                    region.get("object_key"),
                                ]
                            )
                            links.append((role, n, rid))
                    fields = {
                        k: item.get(k)
                        for k in (
                            "item_index",
                            "record_key",
                            "row_ordinal",
                            "col_ordinal",
                            "raw_type",
                            "raw_text",
                            "display_text",
                            "value_type",
                            "value_text",
                            "value_state",
                            "formula_text",
                            "formula_state",
                            "unit_raw",
                            "unit_normalized",
                        )
                    }
                    insert(
                        conn,
                        "extracted_item",
                        item_id=iid,
                        series_id=sid,
                        document_version_id=run["document_version_id"],
                        **fields,
                        source_identity_key=dump(
                            [run["document_version_id"], sorted(identities)]
                        ),
                        derivation_key=derivation,
                    )
                    for role, n, rid in links:
                        insert(
                            conn,
                            "item_region",
                            item_id=iid,
                            document_version_id=run["document_version_id"],
                            role=role,
                            ordinal=n,
                            region_id=rid,
                        )
                    count += 1
                    if count > 1000000:
                        raise Problem(
                            "RUN_ITEM_LIMIT", "한 실행의 항목 한도를 초과했습니다.", 413
                        )
            else:
                raise Problem(
                    "INVALID_READER_CONTRACT", "알 수 없는 추출 이벤트입니다."
                )
    if not verified:
        raise Problem(
            "UNVERIFIED_SOURCE", "읽기 종료 시 원본 버전이 확인되지 않았습니다.", 409
        )
    service.authorize(run["document_version_id"], principal, "extract", checkpoint)
    checkpoint(count, count, force=True)
    with db.connect(write=True) as conn:
        job = conn.execute(
            "SELECT cancel_requested,state FROM runtime_job WHERE job_id=?", (run_id,)
        ).fetchone()
        if job and (job["cancel_requested"] or job["state"] != "running"):
            raise Cancelled()
        conn.execute(
            "UPDATE extraction_run SET status='succeeded',finished_at=? WHERE run_id=?",
            (now(), run_id),
        )
        try:
            conn.execute(
                "UPDATE template_application SET published_run_id=? WHERE application_id=?",
                (run_id, run["application_id"]),
            )
        except Exception:
            raise Problem(
                "MAPPING_CHANGED",
                "추출 중 매핑이 바뀌었거나 출처가 불완전합니다. 현재 규칙으로 다시 추출하세요.",
                409,
            ) from None
    return {
        "run_id": run_id,
        "application_id": run["application_id"],
        "version_id": run["document_version_id"],
        "series_count": len(series),
        "item_count": count,
    }
