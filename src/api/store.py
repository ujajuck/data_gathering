"""API 조회 저장소 계층 — 페이지네이션·집계 SQL (WEB_PLAN §1.2).

원칙: 목록은 전부 SQL LIMIT/OFFSET + COUNT, projection은 단일 스캔 집계.
레코드 수 × 쿼리 1 형태의 N+1은 이 계층에 존재하지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3

# LOT/설비 식별자 패턴 — SQLite REGEXP 함수로 등록해 SQL에서 그대로 쓴다
ID_LIKE_SQL = "^[A-Za-z]{1,6}[-_]?[0-9]{3,}"
_ID_LIKE_RE = re.compile(ID_LIKE_SQL)

MAX_PAGE_SIZE = 500


def register_functions(conn: sqlite3.Connection) -> None:
    """X REGEXP Y == regexp(Y, X) — sqlite 규약에 맞춘 인자 순서."""
    conn.create_function(
        "REGEXP", 2,
        lambda pattern, value: 1 if value is not None and re.search(pattern, str(value)) else 0,
    )


def clamp_page(page: int, size: int) -> tuple[int, int]:
    page = max(1, int(page))
    size = min(MAX_PAGE_SIZE, max(1, int(size)))
    return page, size


def _page_env(items: list, page: int, size: int, total: int) -> dict:
    return {"items": items, "page": page, "size": size, "total": total}


# ------------------------------------------------------------------ stats ----

def stats(conn) -> dict:
    q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    obs = q("SELECT count(*) FROM v_current_observation")
    mapped = q("SELECT count(*) FROM v_current_observation WHERE concept_id IS NOT NULL")
    return {
        "documents": q("SELECT count(*) FROM source_document"),
        "document_versions": q("SELECT count(*) FROM document_version"),
        "records": q("SELECT count(*) FROM v_current_record"),
        "observations": obs,
        "mapped": mapped,
        "mapped_pct": round(100 * mapped / obs) if obs else 0,
        "pending_mappings": q("SELECT count(*) FROM mapping_decision WHERE decision='pending'"),
        "lots": q(f"SELECT count(DISTINCT business_key) FROM v_current_record "
                  f"WHERE business_key REGEXP '{ID_LIKE_SQL}'"),
    }


def freshness_key(conn, *extra: str) -> str:
    """projection 캐시/ETag 무효화 키 — 데이터·사전 버전·매핑 결정 상태가
    바뀌면 달라진다 (§5.4). 승인/반려는 UPDATE라 행 수가 안 변하므로
    pending 카운트를 반드시 포함한다."""
    row = conn.execute(
        """SELECT (SELECT count(*) FROM document_version),
                  (SELECT max(detected_at) FROM document_version),
                  (SELECT count(*) FROM mapping_decision),
                  (SELECT max(created_at) FROM mapping_decision),
                  (SELECT count(*) FROM mapping_decision WHERE decision='pending'),
                  (SELECT count(*) FROM mapping_decision WHERE decision='approved')"""
    ).fetchone()
    raw = "|".join([*(str(x) for x in row), *extra])
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def like_escape(q: str) -> str:
    r"""LIKE 패턴 메타문자(%/_/\)를 이스케이프 — 쿼리는 ESCAPE '\' 와 함께 쓴다."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ------------------------------------------------------------------- lots ----

def lots_page(conn, page: int = 1, size: int = 50, q: str | None = None) -> dict:
    page, size = clamp_page(page, size)
    where = f"business_key REGEXP '{ID_LIKE_SQL}'"
    args: list = []
    if q:
        where += " AND business_key LIKE ? ESCAPE '\\'"
        args.append(f"%{like_escape(q)}%")
    total = conn.execute(
        f"SELECT count(DISTINCT business_key) FROM v_current_record WHERE {where}", args
    ).fetchone()[0]
    rows = conn.execute(
        f"""SELECT r.business_key AS lot,
                   count(*) AS record_count,
                   count(DISTINCT r.source_sheet) AS sheet_count,
                   min(r.event_time) AS first_event,
                   group_concat(DISTINCT r.overall_status) AS statuses
            FROM v_current_record r WHERE {where}
            GROUP BY r.business_key ORDER BY r.business_key
            LIMIT ? OFFSET ?""",
        [*args, size, (page - 1) * size],
    ).fetchall()
    lots = [dict(r) for r in rows]
    if lots:
        keys = [r["lot"] for r in lots]
        ph = ",".join("?" * len(keys))
        cc = conn.execute(
            f"""SELECT r.business_key AS lot, count(DISTINCT o.concept_id) AS concept_count
                FROM v_current_observation o
                JOIN v_current_record r ON r.record_key = o.record_key
                WHERE o.concept_id IS NOT NULL AND r.business_key IN ({ph})
                GROUP BY r.business_key""",
            keys,
        ).fetchall()
        cmap = {r["lot"]: r["concept_count"] for r in cc}
        for lot in lots:
            lot["concept_count"] = cmap.get(lot["lot"], 0)
            lot["statuses"] = [s for s in (lot["statuses"] or "").split(",") if s]
    return _page_env(lots, page, size, total)


def lot_detail(conn, lot: str) -> dict | None:
    recs = conn.execute(
        "SELECT * FROM v_current_record WHERE business_key=? ORDER BY record_key", (lot,)
    ).fetchall()
    if not recs:
        return None
    keys = [r["record_key"] for r in recs]
    ph = ",".join("?" * len(keys))
    obs = conn.execute(
        f"""SELECT record_key, concept_id, raw_label, raw_value_num, raw_value_text,
                   normalized_value_num, normalized_value_text, raw_unit, canonical_unit,
                   value_role, status_code, source_sheet, source_address
            FROM v_current_observation WHERE record_key IN ({ph})
            ORDER BY concept_id, record_key""",
        keys,
    ).fetchall()
    concepts: dict[str, list] = {}
    documents: set[str] = set()
    for o in obs:
        documents.add(o["source_sheet"])
        if not o["concept_id"]:
            continue
        value = o["normalized_value_num"] if o["normalized_value_num"] is not None else o["normalized_value_text"]
        raw = o["raw_value_num"] if o["raw_value_num"] is not None else o["raw_value_text"]
        concepts.setdefault(o["concept_id"], []).append({
            "value": value, "unit": o["canonical_unit"],
            "raw": raw, "raw_unit": o["raw_unit"],
            "role": o["value_role"], "status": o["status_code"],
            "source": f'{o["source_sheet"]}!{o["source_address"]}',
        })
    return {
        "lot": lot,
        "documents": sorted(documents),
        "records": [
            {"record_key": r["record_key"], "record_type": r["record_type"],
             "event_time": r["event_time"], "overall_status": r["overall_status"],
             "source_sheet": r["source_sheet"], "version": r["version"]}
            for r in recs
        ],
        "concepts": concepts,
    }


# ---------------------------------------------------------------- records ----

def records_page(conn, page: int = 1, size: int = 50, *, record_type: str | None = None,
                 lot: str | None = None, sheet: str | None = None,
                 q: str | None = None, status: str | None = None) -> dict:
    page, size = clamp_page(page, size)
    where, args = ["1=1"], []
    if record_type:
        where.append("record_type LIKE ? ESCAPE '\\'"); args.append(f"%{like_escape(record_type)}%")
    if lot:
        where.append("business_key = ?"); args.append(lot)
    if sheet:
        where.append("source_sheet = ?"); args.append(sheet)
    if q:
        where.append("record_key LIKE ? ESCAPE '\\'"); args.append(f"%{like_escape(q)}%")
    if status:
        where.append("overall_status = ?"); args.append(status)
    cond = " AND ".join(where)
    total = conn.execute(f"SELECT count(*) FROM v_current_record WHERE {cond}", args).fetchone()[0]
    rows = conn.execute(
        f"""SELECT record_key, record_type, business_key, event_time, overall_status,
                   source_sheet, version, semantic_hash
            FROM v_current_record WHERE {cond}
            ORDER BY record_key LIMIT ? OFFSET ?""",
        [*args, size, (page - 1) * size],
    ).fetchall()
    return _page_env([dict(r) for r in rows], page, size, total)


def record_detail(conn, record_key: str) -> dict | None:
    rec = conn.execute(
        "SELECT * FROM v_current_record WHERE record_key=?", (record_key,)
    ).fetchone()
    if rec is None:
        return None
    obs = conn.execute(
        """SELECT observation_key, concept_id, raw_label, header_path,
                  raw_value_num, raw_value_text, normalized_value_num, normalized_value_text,
                  raw_unit, canonical_unit, value_role, status_code,
                  source_sheet, source_address, row_key, mapping_confidence, mapping_decision
           FROM v_current_observation WHERE record_key=? ORDER BY observation_key""",
        (record_key,),
    ).fetchall()
    att = conn.execute(
        "SELECT image_hash, source_anchor, uri FROM attachment WHERE record_key=? AND is_current=1",
        (record_key,),
    ).fetchall()
    out = dict(rec)
    out["observations"] = [dict(o) for o in obs]
    out["attachments"] = [dict(a) for a in att]
    return out


def record_sheets(conn) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT source_sheet FROM v_current_record ORDER BY source_sheet")]


# --------------------------------------------------------------- concepts ----

def concept_usage(conn) -> dict[str, dict]:
    """concept_id → {source_count, document_count} 단일 집계."""
    rows = conn.execute(
        """SELECT o.concept_id, count(*) AS source_count,
                  count(DISTINCT dv.document_id) AS document_count
           FROM v_current_observation o
           JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
           WHERE o.concept_id IS NOT NULL GROUP BY o.concept_id"""
    ).fetchall()
    return {r["concept_id"]: dict(r) for r in rows}


def concept_sources_page(conn, concept_id: str, page: int = 1, size: int = 50) -> dict:
    page, size = clamp_page(page, size)
    total = conn.execute(
        "SELECT count(*) FROM v_current_observation WHERE concept_id=?", (concept_id,)
    ).fetchone()[0]
    rows = conn.execute(
        """SELECT o.record_key, o.raw_label, o.header_path, o.source_sheet, o.source_address,
                  o.raw_value_num, o.raw_value_text, o.normalized_value_num,
                  o.normalized_value_text, o.raw_unit, o.canonical_unit, o.value_role,
                  sd.logical_name AS document, dv.dvc_hash, dv.detected_at
           FROM v_current_observation o
           JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
           JOIN source_document sd ON sd.document_id = dv.document_id
           WHERE o.concept_id = ?
           ORDER BY o.record_key LIMIT ? OFFSET ?""",
        (concept_id, size, (page - 1) * size),
    ).fetchall()
    return _page_env([dict(r) for r in rows], page, size, total)


def lineage(conn, concept_id: str, lot: str | None = None) -> list[dict]:
    where, args = ["o.concept_id = ?"], [concept_id]
    if lot:
        where.append("r.business_key = ?"); args.append(lot)
    rows = conn.execute(
        f"""SELECT r.business_key AS lot, sd.logical_name AS document, o.source_sheet,
                   o.source_address, o.raw_value_num, o.raw_value_text, o.raw_unit,
                   o.normalized_value_num, o.normalized_value_text, o.canonical_unit,
                   o.value_role, dv.dvc_hash
            FROM v_current_observation o
            JOIN v_current_record r ON r.record_key = o.record_key
            JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
            JOIN source_document sd ON sd.document_id = dv.document_id
            WHERE {' AND '.join(where)}
            ORDER BY sd.logical_name, o.source_address LIMIT 200""",
        args,
    ).fetchall()
    return [dict(r) for r in rows]


# -------------------------------------------------------------- documents ----

def documents_summary(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT sd.logical_name, sd.relative_path,
                  count(DISTINCT dv.document_version_id) AS versions,
                  max(dv.detected_at) AS last_seen,
                  (SELECT dvc_hash FROM document_version WHERE document_id=sd.document_id
                     AND is_current=1) AS current_hash
           FROM source_document sd
           LEFT JOIN document_version dv ON dv.document_id = sd.document_id
           GROUP BY sd.document_id ORDER BY sd.logical_name"""
    ).fetchall()
    docs = [dict(r) for r in rows]
    agg = {
        r["logical_name"]: r
        for r in conn.execute(
            """SELECT sd.logical_name,
                      count(DISTINCT rec.record_key) AS record_count,
                      count(DISTINCT o.concept_id) AS concept_count,
                      count(DISTINCT o.source_sheet) AS sheet_count
               FROM source_document sd
               JOIN document_version dv ON dv.document_id = sd.document_id
               JOIN observation o ON o.source_document_version_id = dv.document_version_id
                    AND o.is_current = 1
               JOIN v_current_record rec ON rec.record_key = o.record_key
               GROUP BY sd.document_id"""
        ).fetchall()
    }
    pend = {
        r[0]: r[1]
        for r in conn.execute(
            """SELECT substr(context, 1, instr(context, '/') - 1), count(*)
               FROM mapping_decision WHERE decision='pending'
               GROUP BY substr(context, 1, instr(context, '/') - 1)"""
        ).fetchall()
    }
    for d in docs:
        a = agg.get(d["logical_name"], {})
        d["record_count"] = a["record_count"] if a else 0
        d["concept_count"] = a["concept_count"] if a else 0
        d["sheet_count"] = a["sheet_count"] if a else 0
        d["pending_mappings"] = pend.get(d["logical_name"], 0)
    return docs


def document_concepts(conn) -> dict[str, list[str]]:
    rows = conn.execute(
        """SELECT DISTINCT sd.logical_name, o.concept_id
           FROM v_current_observation o
           JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
           JOIN source_document sd ON sd.document_id = dv.document_id
           WHERE o.concept_id IS NOT NULL ORDER BY sd.logical_name, o.concept_id"""
    ).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["logical_name"], []).append(r["concept_id"])
    return out


# ------------------------------------------------------------------ graph ----

def graph_scan(conn) -> list[sqlite3.Row]:
    """KG projection용 단일 스캔 — record_key × concept × 대표값."""
    return conn.execute(
        """SELECT record_key, concept_id, normalized_value_text
           FROM v_current_observation WHERE concept_id IS NOT NULL"""
    ).fetchall()


# -------------------------------------------------------- mapping / jobs ----

def pending_page(conn, page: int = 1, size: int = 50) -> dict:
    page, size = clamp_page(page, size)
    total = conn.execute(
        "SELECT count(*) FROM mapping_decision WHERE decision='pending'"
    ).fetchone()[0]
    rows = conn.execute(
        """SELECT mapping_id, field_signature, raw_label, context, concept_id,
                  confidence, reasons, mapping_version, created_at
           FROM mapping_decision WHERE decision='pending'
           ORDER BY confidence DESC, field_signature LIMIT ? OFFSET ?""",
        (size, (page - 1) * size),
    ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        try:
            d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else {}
        except json.JSONDecodeError:
            pass
        items.append(d)
    return _page_env(items, page, size, total)


def jobs_page(conn, page: int = 1, size: int = 50) -> dict:
    page, size = clamp_page(page, size)
    total = conn.execute("SELECT count(*) FROM ingestion_job").fetchone()[0]
    rows = conn.execute(
        """SELECT job_id, trigger_kind, source_path, source_version_id, status, detail,
                  started_at, finished_at
           FROM ingestion_job ORDER BY started_at DESC LIMIT ? OFFSET ?""",
        (size, (page - 1) * size),
    ).fetchall()
    return _page_env([dict(r) for r in rows], page, size, total)
