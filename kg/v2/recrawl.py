"""템플릿 버전의 현재 적용 건을 다시 추출한다. 매핑 리비전·head는 읽기만 하고 절대 쓰지 않는다."""

from __future__ import annotations

from .db import Problem, one

POPULATION = """SELECT a.application_id, a.published_run_id,
  d.current_version_id=a.document_version_id AS is_current,
  (SELECT count(*) FROM template_rule r WHERE r.template_version_id=a.template_version_id) rule_count,
  (SELECT count(*) FROM mapping_head h WHERE h.application_id=a.application_id) head_count,
  EXISTS(SELECT 1 FROM extraction_run e WHERE e.application_id=a.application_id AND e.status IN ('queued','running')) in_progress
FROM template_application a
JOIN document_version v ON v.document_version_id=a.document_version_id
JOIN document d ON d.document_id=v.document_id
WHERE a.template_version_id=?
ORDER BY a.created_at, a.application_id LIMIT 1001"""

POPULATION_LIMIT = 1000

STATUS_WHERE = """FROM runtime_job j WHERE j.principal=? AND j.kind='extract'
  AND substr(j.request_key,1,length(?))=?
  AND EXISTS(SELECT 1 FROM template_application a
             WHERE a.application_id=json_extract(j.payload_json,'$.application_id') AND a.template_version_id=?)"""


def derived_key(request_key, application_id, mode="fill"):
    # 같은 request_key라도 mode가 다르면 다른 배치다 (fill 뒤 reset_auto는 발행된 건을 추가로 큐잉한다).
    return f"{request_key}:{mode}:{application_id}"


def require_template_version(conn, tid):
    one(
        conn,
        "SELECT template_version_id FROM template_version WHERE template_version_id=?",
        (tid,),
    )


def recrawl(service, tid, mode, request_key, principal):
    with service.db.connect() as conn:
        require_template_version(conn, tid)
        rows = [dict(r) for r in conn.execute(POPULATION, (tid,))]
    truncated = len(rows) > POPULATION_LIMIT
    rows = rows[:POPULATION_LIMIT]
    queued, skipped = [], []
    for row in rows:
        aid = row["application_id"]
        key = derived_key(request_key, aid, mode)
        with service.db.connect() as conn:
            # 같은 파생 키(request_key+mode+적용 건)의 재전송은 기존 작업을 그대로 돌려준다.
            existing = conn.execute(
                "SELECT job_id FROM runtime_job WHERE principal=? AND kind='extract' AND request_key=?",
                (principal, key),
            ).fetchone()
        if existing:
            queued.append({"application_id": aid, "job_id": existing["job_id"]})
            continue
        if not row["is_current"]:
            skipped.append({"application_id": aid, "reason": "stale_version"})
            continue
        if not row["rule_count"] or row["head_count"] != row["rule_count"]:
            skipped.append({"application_id": aid, "reason": "review_required"})
            continue
        if mode == "fill" and row["published_run_id"]:
            skipped.append({"application_id": aid, "reason": "published"})
            continue
        if row["in_progress"]:
            skipped.append({"application_id": aid, "reason": "in_progress"})
            continue
        try:
            # /applications/{aid}/extract와 같은 kind·payload·prepare로 같은 handler에 합류한다.
            job = service.jobs.submit(
                "extract",
                {"application_id": aid},
                principal,
                key,
                service.prepare_extraction,
            )
        except Problem as exc:
            if exc.code == "QUEUE_FULL":
                skipped.append({"application_id": aid, "reason": "queue_full"})
                continue
            if exc.code == "REVIEW_REQUIRED":  # 조회와 제출 사이에 head가 바뀐 경우
                skipped.append({"application_id": aid, "reason": "review_required"})
                continue
            raise
        queued.append({"application_id": aid, "job_id": job["job_id"]})
    return {
        "template_version_id": tid,
        "mode": mode,
        "request_key": request_key,
        "queued": queued,
        "skipped": skipped,
        # 적용 건이 상한(1000)을 넘으면 나머지는 처리하지 않았음을 알린다. 같은 request_key로 다시 호출하면 이어서 큐잉된다.
        "truncated": truncated,
        "population_limit": POPULATION_LIMIT,
    }


def status_query(tid, request_key, principal):
    prefix = request_key + ":"
    params = (principal, prefix, prefix, tid)
    return (
        "SELECT j.job_id,j.state,j.error_code,j.created_at,j.finished_at,"
        "json_extract(j.payload_json,'$.application_id') application_id "
        + STATUS_WHERE,
        params,
    )


def status_summary(service, tid, request_key, principal):
    _, params = status_query(tid, request_key, principal)
    with service.db.connect() as conn:
        return {
            r["state"]: r["n"]
            for r in conn.execute(
                "SELECT j.state,count(*) n " + STATUS_WHERE + " GROUP BY j.state",
                params,
            )
        }
