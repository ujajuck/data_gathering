"""§4.11 검수 큐 — 같은 원인·같은 서명을 묶은 행과 묶음 쓰기 작업(kind='queue_action').

큐 다섯 종류(현재 snapshot 기준, 문서 단위 나열 금지):
- unmatched: document.status='unmatched'를 구조 서명 sha256으로 묶는다 → create_profile · assign_profile
- review: proposed/rejected/NULL 헤드가 있는 application(승계 proposed 제외)을 profile_id로 묶는다 → open_review · approve_all
- failed: 마지막 실행 failed/cancelled인 미발행 application을 error_code로, 잠긴 문서를 'locked'로 묶는다 → open_review · reparse
- changed: 승계(inherited proposed) application을 profile_id로, §4.4 불일치 문서를 'incompatible'로 묶는다 → open_review · approve_all(identical만) · assign_profile
- conflict: 발행 값의 unit_normalized가 필드 canonical_unit과 다른 것을 field_key로 묶는다 → open_review
모든 묶음/멤버 조회는 SQL 한두 문으로 끝난다(문서마다 반복 조회하지 않는다).
"""

from __future__ import annotations

from .db import Problem, decode_cursor, encode_cursor, load, one, page, uid
from .jobs import Cancelled

KINDS = ("unmatched", "review", "failed", "changed", "conflict")
WRITE_ACTIONS = ("assign_profile", "approve_all", "reparse")
KIND_LABELS = {"unmatched": "신규 양식", "review": "매핑 검수", "failed": "파싱 실패", "changed": "변경 감지", "conflict": "충돌"}
ACTION_LABELS = {"assign_profile": "프로파일 지정", "approve_all": "일괄 승인", "reparse": "재파싱"}
SEP = "\x1f"

# 현재 snapshot의 application별 헤드·마지막 실행 집계. document.status로 미리 걸러 큐와 무관한 문서는 읽지 않는다.
APP_CTE = (
    "WITH app AS ("
    " SELECT a.application_id, a.snapshot_id, a.profile_id, a.compatibility, a.origin, a.published_run_id, a.profile_rev,"
    " d.document_id, d.document_name, d.status document_status, p.profile_name, p.current_rev profile_current_rev,"
    " count(m.mapping_id) heads_total,"
    " sum(CASE WHEN m.current_revision_id IS NULL OR v.status<>'approved' THEN 1 ELSE 0 END) unapproved,"
    " sum(CASE WHEN v.status='proposed' AND v.origin='inherited' THEN 1 ELSE 0 END) inherited,"
    " sum(CASE WHEN v.status='rejected' THEN 1 ELSE 0 END) rejected,"
    " sum(CASE WHEN v.status='proposed' AND v.field_id IS NULL AND r.default_field_id IS NULL THEN 1 ELSE 0 END) field_required,"
    " group_concat(CASE WHEN m.current_revision_id IS NULL OR v.status<>'approved' THEN r.rule_key END, char(31)) pending_rules,"
    " (SELECT x.status FROM extraction_run x WHERE x.application_id=a.application_id ORDER BY x.started_at DESC, x.run_id DESC LIMIT 1) last_status,"
    " (SELECT x.error_summary FROM extraction_run x WHERE x.application_id=a.application_id ORDER BY x.started_at DESC, x.run_id DESC LIMIT 1) last_error,"
    " (SELECT x.auto_approved FROM extraction_run x WHERE x.application_id=a.application_id ORDER BY x.started_at DESC, x.run_id DESC LIMIT 1) last_auto"
    " FROM document d JOIN parsing_application a ON a.snapshot_id=d.current_snapshot_id JOIN parsing_profile p ON p.profile_id=a.profile_id"
    " LEFT JOIN mapping m ON m.application_id=a.application_id LEFT JOIN parsing_rule r ON r.rule_id=m.rule_id"
    " LEFT JOIN mapping_revision v ON v.mapping_revision_id=m.current_revision_id"
    " WHERE d.status IN ('review','changed','failed')"
    " GROUP BY a.application_id) "
)
REVIEW_WHERE = "inherited=0 AND (unapproved>0 OR heads_total=0)"
CHANGED_WHERE = "inherited>0"
FAILED_CODE = "CASE WHEN instr(coalesce(last_error,''),':')>0 THEN substr(last_error,1,instr(last_error,':')-1) ELSE coalesce(nullif(last_error,''),'UNKNOWN') END"
FAILED_WHERE = "last_status IN ('failed','cancelled') AND published_run_id IS NULL"
# §4.4 불일치 기록(document.status_detail_json.incompatible) 중 현재 snapshot 것이고 아직 그 프로파일이 적용되지 않은 문서.
INCOMPATIBLE_FROM = (
    "FROM document d, json_each(d.status_detail_json, '$.incompatible') j"
    " WHERE d.status='changed' AND json_extract(j.value,'$.snapshot_id')=d.current_snapshot_id"
    " AND NOT EXISTS (SELECT 1 FROM parsing_application a WHERE a.snapshot_id=d.current_snapshot_id AND a.profile_id=json_extract(j.value,'$.profile_id'))"
)
CONFLICT_FROM = (
    "FROM current_value cv JOIN parsing_field f ON f.field_id=cv.field_id JOIN document d ON d.document_id=cv.document_id"
    " WHERE f.canonical_unit IS NOT NULL AND cv.unit_normalized IS NOT NULL AND cv.unit_normalized<>f.canonical_unit"
)


def _split(joined):
    return sorted({p for p in (joined or "").split(SEP) if p})


def _representative(r, **extra):
    out = {"document_id": r["document_id"], "document_name": r["document_name"], "snapshot_id": r["snapshot_id"]}
    for key in ("application_id", "profile_id"):
        if r.get(key):
            out[key] = r[key]
    out.update({k: v for k, v in extra.items() if v})
    return out


# ---------------------------------------------------------------------------- 묶음


def _unmatched_groups(conn):
    out = []
    for r in conn.execute(
        "SELECT coalesce(ss.signature_sha256,'unknown') group_key, count(*) n, min(d.document_name) document_name, d.document_id, d.current_snapshot_id snapshot_id, ss.signature_json"
        " FROM document d LEFT JOIN snapshot_signature ss ON ss.snapshot_id=d.current_snapshot_id WHERE d.status='unmatched' GROUP BY 1"
    ):
        signature = load(r["signature_json"], {}) or {}
        sheets = [s.get("name") for s in signature.get("sheets") or [] if isinstance(s, dict)]
        out.append(
            {
                "group_key": r["group_key"],
                "kind": "unmatched",
                "cause": "프로파일 없음" + (" · 시트: " + ", ".join(sheets[:3]) if sheets else ""),
                "label": f"신규 양식 후보 · {r['n']}문서",
                "count": r["n"],
                "impact": {"documents": r["n"], "rules": [], "sheets": sheets},
                "representative": _representative(dict(r)),
                "actions": ["create_profile", "assign_profile"],
            }
        )
    return out


def _review_groups(conn):
    out = []
    for r in conn.execute(
        APP_CTE + "SELECT profile_id, profile_name, profile_current_rev, count(*) n, min(document_name) document_name, document_id, snapshot_id, application_id,"
        " sum(rejected>0) rejected_n, sum(field_required>0) field_required_n, sum(compatibility='compatible') compatible_n, sum(heads_total=0) empty_n,"
        f" group_concat(pending_rules, char(31)) rules FROM app WHERE {REVIEW_WHERE} GROUP BY profile_id"
    ):
        causes = [f"{name} {n}" for name, n in (("compatible", r["compatible_n"]), ("FIELD_REQUIRED", r["field_required_n"]), ("반려됨 · 수정 필요", r["rejected_n"]), ("규칙 없음", r["empty_n"])) if n]
        out.append(
            {
                "group_key": r["profile_id"],
                "kind": "review",
                "cause": "매핑 검수 필요" + (" (" + " · ".join(causes) + ")" if causes else ""),
                "label": f"{r['profile_name']} v{r['profile_current_rev']} · 매핑 검수 · {r['n']}문서",
                "count": r["n"],
                "impact": {"documents": r["n"], "rules": _split(r["rules"]), "rejected": r["rejected_n"], "field_required": r["field_required_n"]},
                "representative": _representative(dict(r)),
                "actions": ["open_review", "approve_all"],
                "profile": {"profile_id": r["profile_id"], "profile_name": r["profile_name"], "rev": r["profile_current_rev"]},
            }
        )
    return out


def _failed_groups(conn):
    out = []
    for r in conn.execute(
        APP_CTE + f"SELECT {FAILED_CODE} code, count(*) n, min(document_name) document_name, document_id, snapshot_id, application_id, profile_id, last_error,"
        f" sum(coalesce(last_auto,0)) auto_n, count(DISTINCT profile_id) profiles FROM app WHERE {FAILED_WHERE} GROUP BY 1"
    ):
        message = (r["last_error"] or "").split(":", 1)[-1].strip() if r["last_error"] else "파싱 실행이 실패했습니다."
        out.append(
            {
                "group_key": r["code"],
                "kind": "failed",
                "cause": message,
                "label": f"파싱 실패 · {r['code']} · {r['n']}문서",
                "count": r["n"],
                "impact": {"documents": r["n"], "rules": [], "auto_approved": r["auto_n"] or 0, "profiles": r["profiles"]},
                "representative": _representative(dict(r)),
                "actions": ["open_review", "reparse"],
            }
        )
    locked = conn.execute("SELECT count(*) n, min(document_name) document_name, document_id, current_snapshot_id snapshot_id, last_error FROM document WHERE status='locked'").fetchone()
    if locked and locked["n"]:
        out.append(
            {
                "group_key": "locked",
                "kind": "failed",
                "cause": locked["last_error"] or "잠긴 파일(DRM)입니다. DRM Reader를 등록한 뒤 다시 등록하세요.",
                "label": f"잠김(DRM) · {locked['n']}문서",
                "count": locked["n"],
                "impact": {"documents": locked["n"], "rules": [], "auto_approved": 0, "profiles": 0},
                "representative": _representative(dict(locked)),
                "actions": [],
            }
        )
    return out


def _changed_groups(conn):
    out = []
    for r in conn.execute(
        APP_CTE + "SELECT profile_id, profile_name, profile_current_rev, count(*) n, min(document_name) document_name, document_id, snapshot_id, application_id,"
        " sum(compatibility='identical') identical_n, sum(compatibility='compatible') compatible_n, group_concat(pending_rules, char(31)) rules"
        f" FROM app WHERE {CHANGED_WHERE} GROUP BY profile_id"
    ):
        actions = ["open_review"] + (["approve_all"] if r["identical_n"] else []) + ["assign_profile"]
        out.append(
            {
                "group_key": r["profile_id"],
                "kind": "changed",
                "cause": f"새 snapshot 승계 (identical {r['identical_n']} · compatible {r['compatible_n']})",
                "label": f"{r['profile_name']} v{r['profile_current_rev']} · 변경 감지 · {r['n']}문서",
                "count": r["n"],
                "impact": {"documents": r["n"], "rules": _split(r["rules"]), "identical": r["identical_n"], "compatible": r["compatible_n"]},
                "representative": _representative(dict(r)),
                "actions": actions,
                "profile": {"profile_id": r["profile_id"], "profile_name": r["profile_name"], "rev": r["profile_current_rev"]},
            }
        )
    r = conn.execute(
        "SELECT count(DISTINCT d.document_id) n, min(d.document_name) document_name, d.document_id, d.current_snapshot_id snapshot_id,"
        " json_extract(j.value,'$.profile_id') profile_id, json_extract(j.value,'$.profile_name') profile_name " + INCOMPATIBLE_FROM
    ).fetchone()
    if r and r["n"]:
        out.append(
            {
                "group_key": "incompatible",
                "kind": "changed",
                "cause": "새 snapshot이 이전 프로파일과 맞지 않습니다",
                "label": f"변경 감지 · 프로파일 불일치 · {r['n']}문서",
                "count": r["n"],
                "impact": {"documents": r["n"], "rules": [], "identical": 0, "compatible": 0},
                "representative": _representative(dict(r), profile_name=r["profile_name"]),
                "actions": ["assign_profile"],
            }
        )
    return out


def _conflict_groups(conn):
    fields = {}
    for r in conn.execute(
        "SELECT f.field_key, f.field_name, f.canonical_unit, f.ordinal, cv.unit_normalized unit, cv.document_id, min(d.document_name) document_name, cv.snapshot_id, cv.application_id, cv.profile_id, count(*) values_n "
        + CONFLICT_FROM
        + " GROUP BY f.field_key, cv.unit_normalized, cv.document_id ORDER BY f.ordinal, f.field_key, 7, cv.document_id"
    ):
        entry = fields.setdefault(r["field_key"], {"name": r["field_name"], "unit": r["canonical_unit"], "units": set(), "documents": set(), "values": 0, "representative": None})
        entry["units"].add(r["unit"])
        entry["documents"].add(r["document_id"])
        entry["values"] += r["values_n"]
        if entry["representative"] is None:
            entry["representative"] = _representative(dict(r))
    out = []
    for key, entry in fields.items():
        n, units = len(entry["documents"]), sorted(entry["units"])
        out.append(
            {
                "group_key": key,
                "kind": "conflict",
                "cause": f"{entry['unit']} 기대 · {', '.join(units)} 관측",
                "label": f"{entry['name']} · 단위 불일치 · {n}문서",
                "count": n,
                "impact": {"documents": n, "fields": [key], "units": units, "values": entry["values"]},
                "representative": entry["representative"],
                "actions": ["open_review"],
            }
        )
    return out


GROUPERS = {"unmatched": _unmatched_groups, "review": _review_groups, "failed": _failed_groups, "changed": _changed_groups, "conflict": _conflict_groups}


def _groups(conn, kind):
    if kind not in GROUPERS:
        raise Problem("GROUP_NOT_FOUND", "그런 검수 큐가 없습니다.", 404)
    groups = GROUPERS[kind](conn)
    groups.sort(key=lambda g: (-g["count"], g["group_key"]))
    return groups


def queues(service):
    """GET /queues → {summary{kind: 문서 수}, groups{kind: [묶음 행]}}."""
    with service.db.connect() as conn:
        groups = {kind: _groups(conn, kind) for kind in KINDS}
    summary = {kind: sum(g["count"] for g in items) for kind, items in groups.items()}
    return {"summary": summary, "groups": groups}


def queue(service, kind, cursor=None, limit=50):
    """GET /queues/{kind}?cursor= → 묶음 행 페이지(count 내림차순, group_key 오름차순 keyset)."""
    limit = max(1, min(int(limit or 50), 200))
    scope = ["queue", kind]
    after = decode_cursor(cursor, scope, 2)
    with service.db.connect() as conn:
        groups = _groups(conn, kind)
    if after:
        groups = [g for g in groups if (g["count"], g["group_key"]) != tuple(after) and (-g["count"], g["group_key"]) > (-after[0], after[1])]
    items = groups[: limit + 1]
    more = len(items) > limit
    items = items[:limit]
    return {"kind": kind, "items": items, "has_more": more, "next_cursor": encode_cursor([items[-1]["count"], items[-1]["group_key"]], scope) if more else None}


def group(service, kind, group_key):
    with service.db.connect() as conn:
        found = next((g for g in _groups(conn, kind) if g["group_key"] == group_key), None)
    if found is None:
        raise Problem("GROUP_NOT_FOUND", "검수 큐 묶음을 찾을 수 없습니다(이미 처리되었을 수 있습니다).", 404)
    return found


# ---------------------------------------------------------------------------- 멤버


MEMBER_COLUMNS = "document_id, document_name, snapshot_id, application_id, profile_id, profile_name, compatibility, state, detail"


def _member_sql(kind, group_key):
    """(cte, inner_sql, params). inner는 MEMBER_COLUMNS 열을 내고, 바깥에서 keyset·정렬·LIMIT를 붙인다."""
    if kind == "unmatched":
        return (
            "",
            "SELECT d.document_id, d.document_name, d.current_snapshot_id snapshot_id, NULL application_id, NULL profile_id, NULL profile_name, NULL compatibility, 'unmatched' state, NULL detail"
            " FROM document d LEFT JOIN snapshot_signature ss ON ss.snapshot_id=d.current_snapshot_id WHERE d.status='unmatched' AND coalesce(ss.signature_sha256,'unknown')=?",
            (group_key,),
        )
    if kind == "review":
        return (
            APP_CTE,
            "SELECT document_id, document_name, snapshot_id, application_id, profile_id, profile_name, compatibility, 'review' state,"
            " json_object('rules', pending_rules, 'unapproved', unapproved, 'heads_total', heads_total, 'rejected', rejected, 'field_required', field_required, 'origin', origin) detail"
            f" FROM app WHERE profile_id=? AND {REVIEW_WHERE}",
            (group_key,),
        )
    if kind == "failed" and group_key == "locked":
        return (
            "",
            "SELECT d.document_id, d.document_name, d.current_snapshot_id snapshot_id, NULL application_id, NULL profile_id, NULL profile_name, NULL compatibility, 'locked' state, json_object('error', d.last_error) detail"
            " FROM document d WHERE d.status='locked'",
            (),
        )
    if kind == "failed":
        return (
            APP_CTE,
            "SELECT document_id, document_name, snapshot_id, application_id, profile_id, profile_name, compatibility, 'failed' state,"
            " json_object('error', last_error, 'auto_approved', coalesce(last_auto,0), 'unapproved', unapproved, 'heads_total', heads_total) detail"
            f" FROM app WHERE {FAILED_WHERE} AND {FAILED_CODE}=?",
            (group_key,),
        )
    if kind == "changed" and group_key == "incompatible":
        return (
            "",
            "SELECT d.document_id, d.document_name, d.current_snapshot_id snapshot_id, NULL application_id, json_extract(j.value,'$.profile_id') profile_id, json_extract(j.value,'$.profile_name') profile_name,"
            " 'incompatible' compatibility, 'changed' state,"
            " json_object('missing', json_extract(j.value,'$.missing'), 'error', json_extract(j.value,'$.error'), 'previous_application_id', json_extract(j.value,'$.previous_application_id')) detail "
            + INCOMPATIBLE_FROM,
            (),
        )
    if kind == "changed":
        return (
            APP_CTE,
            "SELECT document_id, document_name, snapshot_id, application_id, profile_id, profile_name, compatibility, 'changed' state,"
            " json_object('rules', pending_rules, 'unapproved', unapproved, 'heads_total', heads_total, 'inherited', inherited) detail"
            f" FROM app WHERE profile_id=? AND {CHANGED_WHERE}",
            (group_key,),
        )
    if kind == "conflict":
        return (
            "",
            "SELECT cv.document_id, min(d.document_name) document_name, cv.snapshot_id, min(cv.application_id) application_id, min(cv.profile_id) profile_id, min(p.profile_name) profile_name,"
            " NULL compatibility, 'conflict' state,"
            " json_object('units', group_concat(DISTINCT cv.unit_normalized), 'expected', min(f.canonical_unit), 'values', count(*)) detail "
            + CONFLICT_FROM.replace("JOIN document d", "JOIN parsing_profile p ON p.profile_id=cv.profile_id JOIN document d")
            + " AND f.field_key=? GROUP BY cv.document_id",
            (group_key,),
        )
    raise Problem("GROUP_NOT_FOUND", "그런 검수 큐가 없습니다.", 404)


def _member_rows(conn, kind, group_key, after=None, limit=None):
    cte, inner, params = _member_sql(kind, group_key)
    sql = f"{cte}SELECT {MEMBER_COLUMNS} FROM ({inner}) x"
    args = list(params)
    if after:
        sql += " WHERE (x.document_name, x.document_id) > (?,?)"
        args.extend(after)
    sql += " ORDER BY x.document_name, x.document_id"
    if limit:
        sql += " LIMIT ?"
        args.append(limit)
    out = []
    for r in conn.execute(sql, args):
        row = dict(r)
        row["detail"] = load(row.pop("detail"), {}) or {}
        if isinstance(row["detail"].get("rules"), str):
            row["detail"]["rules"] = _split(row["detail"]["rules"])
        if isinstance(row["detail"].get("units"), str):
            row["detail"]["units"] = sorted({u for u in row["detail"]["units"].split(",") if u})
        if isinstance(row["detail"].get("missing"), str):
            row["detail"]["missing"] = load(row["detail"]["missing"], [])
        out.append(row)
    return out


def members(service, kind, group_key, cursor=None, limit=50):
    """GET /queues/{kind}/groups/{group_key}/members?cursor= → 멤버 페이지(document_name, document_id keyset)."""
    if kind not in KINDS:
        raise Problem("GROUP_NOT_FOUND", "그런 검수 큐가 없습니다.", 404)
    limit = max(1, min(int(limit or 50), 200))
    scope = ["members", kind, group_key]
    after = decode_cursor(cursor, scope, 2)
    with service.db.connect() as conn:
        found = _member_rows(conn, kind, group_key, after, limit + 1)
    if not found and not after:
        raise Problem("GROUP_NOT_FOUND", "검수 큐 묶음을 찾을 수 없습니다(이미 처리되었을 수 있습니다).", 404)
    result = page(found, limit, ("document_name", "document_id"), scope)
    result["kind"], result["group_key"] = kind, group_key
    return result


# ---------------------------------------------------------------------------- 묶음 쓰기(작업)


def queue_action(service, kind, group_key, action, profile_id=None, sheet_bindings=None, extract=True, mode=None, principal=None, wait=0):
    """POST /queues/{kind}/groups/{group_key}/actions → 작업 1개(kind='queue_action', total=count). 404 GROUP_NOT_FOUND · 422 ACTION_NOT_ALLOWED."""
    principal = principal or service.principal
    found = group(service, kind, group_key)
    if action not in WRITE_ACTIONS or action not in found["actions"]:
        raise Problem("ACTION_NOT_ALLOWED", f"이 묶음에는 {action!r} 처리를 적용할 수 없습니다.", 422, {"allowed": [a for a in found["actions"] if a in WRITE_ACTIONS]})
    if action == "assign_profile":
        if not profile_id:
            raise Problem("ACTION_NOT_ALLOWED", "지정할 프로파일(profile_id)을 선택하세요.", 422)
        with service.db.connect() as conn:
            profile = service._profile_row(conn, profile_id)
        if profile["status"] == "deprecated":
            raise Problem("PROFILE_DEPRECATED", "폐기된 프로파일은 적용할 수 없습니다.")
    if action == "reparse" and mode not in (None, "fill", "rematch"):
        raise Problem("INVALID_MODE", "mode는 fill/rematch 중 하나여야 합니다.")
    payload = {"kind": kind, "group_key": group_key, "action": action, "profile_id": profile_id, "sheet_bindings": sheet_bindings, "extract": bool(extract), "mode": mode, "count": found["count"]}
    job = service.jobs.submit(
        "queue_action", payload, principal, uid(), target_kind="queue_group", target_id=f"{kind}/{group_key}", label=f"{found['label']} · {ACTION_LABELS[action]}"
    )
    return service.job_result(job, wait, principal)


def _heartbeat(checkpoint):
    # 하위 호출(추출·재파싱)의 completed/total은 값·문서 수라 이 작업의 문서 단위 진행률을 덮어쓰지 않게 한다.
    return lambda *a, **k: checkpoint(force=k.get("force", False))


def _assign(service, member, profile, sheet_bindings, principal, checkpoint):
    """approved 프로파일은 match → auto_apply(identical이면 승인·추출), 그 외/불일치는 수동 적용(proposed). None = 처리, 문자열 = 건너뜀 사유."""
    if not member["snapshot_id"]:
        return "not_extracted"
    if profile["status"] == "approved" and not sheet_bindings:
        with service.db.connect() as conn:
            doc = dict(one(conn, "SELECT d.*, s.change_token FROM document d JOIN document_snapshot s ON s.snapshot_id=d.current_snapshot_id WHERE d.document_id=?", (member["document_id"],), "문서를 찾을 수 없습니다."))
        outcome = service._reparse_unmatched(profile, doc, principal, checkpoint)
        if outcome != "incompatible":
            return outcome
    service.apply_profile(member["snapshot_id"], profile["profile_id"], sheet_bindings, principal, checkpoint)
    return None


def _approve(service, member, kind, extract, principal, checkpoint):
    if kind == "changed" and member.get("compatibility") != "identical":
        return "review_required"
    if not member.get("application_id"):
        return "review_required"
    result = service.approve_all(member["application_id"], reason=f"검수 큐 일괄 승인({KIND_LABELS[kind]})", extract=False, principal=principal)
    if result["skipped"]:
        return result["skipped"][0]["reason"] if result["approved"] == 0 else "review_required"
    if not extract:
        return None
    with service.db.connect() as conn:
        ready = service._all_heads_approved(conn, member["application_id"])
    if not ready:
        return "review_required"
    outcome = service._extract_now(member["application_id"], principal, checkpoint)
    return outcome["error"]["code"] if outcome.get("error") else None


def execute_queue_action(service, payload, principal, checkpoint):
    """작업 handler(kind='queue_action') → {queued, skipped[{document_id, document_name, reason}]}."""
    kind, group_key, action = payload["kind"], payload["group_key"], payload["action"]
    with service.db.connect() as conn:
        found = _member_rows(conn, kind, group_key)
        profile = service._profile_row(conn, payload["profile_id"]) if action == "assign_profile" else None
    if action not in WRITE_ACTIONS:
        raise Problem("ACTION_NOT_ALLOWED", f"이 묶음에는 {action!r} 처리를 적용할 수 없습니다.")
    if kind == "failed" and group_key == "locked":
        raise Problem("ACTION_NOT_ALLOWED", "잠긴 문서는 DRM Reader를 등록한 뒤 다시 등록해야 합니다.")
    total = len(found)
    checkpoint(0, total, force=True)
    queued, skipped = 0, []
    heartbeat = _heartbeat(checkpoint)
    if action == "reparse":
        # 재파싱은 프로파일 단위 작업(§4.9)이므로 묶음의 프로파일마다 한 번씩 위임한다.
        for profile_id in sorted({m["profile_id"] for m in found if m.get("profile_id")}):
            try:
                result = service.execute_reparse(profile_id, payload.get("mode") or "fill", principal, heartbeat)
            except Cancelled:
                raise
            except Problem as exc:
                skipped.extend({"document_id": m["document_id"], "document_name": m["document_name"], "reason": exc.code} for m in found if m.get("profile_id") == profile_id)
                continue
            queued += result["queued"]
            skipped.extend(result["skipped"])
        checkpoint(total, total, force=True)
        return {"queued": queued, "skipped": skipped}
    seen = set()
    for n, member in enumerate(found):
        checkpoint(n, total, force=True)
        if member["document_id"] in seen and action == "assign_profile":
            continue
        seen.add(member["document_id"])
        try:
            if action == "assign_profile":
                outcome = _assign(service, member, profile, payload.get("sheet_bindings"), principal, heartbeat)
            else:
                outcome = _approve(service, member, kind, payload.get("extract", True), principal, heartbeat)
        except Cancelled:
            raise
        except Problem as exc:
            outcome = exc.code
        if outcome is None:
            queued += 1
        else:
            skipped.append({"document_id": member["document_id"], "document_name": member["document_name"], "reason": outcome})
    checkpoint(total, total, force=True)
    return {"queued": queued, "skipped": skipped}


run_queue_action = execute_queue_action
