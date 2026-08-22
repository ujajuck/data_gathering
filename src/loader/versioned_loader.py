"""VersionedLoader — idempotent versioned upsert into the canonical DB.

설계문서 §6, §9: UPDATE 대신 '이전 current 종료 + 새 row INSERT'를 한
transaction으로 수행한다. document_version_id + record stable key 기준으로
idempotent 하다 (§8.6). SQLite가 기본이며 스키마는 PostgreSQL과 논리 동일.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from src.common.models import RecordData

DEFAULT_PROCESS_ID = "P-001"
_SCHEMA = Path(__file__).resolve().parents[2] / "db" / "schema_sqlite.sql"


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class VersionedLoader:
    def __init__(self, db_path: Path | str, process_name: str = "단일 공정"):
        # check_same_thread=False: API 서버(스레드풀)에서 공유 — 접근은 서버의
        # 단일 lock으로 직렬화한다 (§15 동시성 원칙과 동일).
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA.read_text(encoding="utf-8"))
        self.conn.execute(
            "INSERT OR IGNORE INTO process(process_id, name) VALUES (?, ?)",
            (DEFAULT_PROCESS_ID, process_name),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # -------------------------------------------------------- doc version ----
    def ensure_document(self, logical_name: str, relative_path: str) -> str:
        row = self.conn.execute(
            "SELECT document_id FROM source_document WHERE process_id=? AND relative_path=?",
            (DEFAULT_PROCESS_ID, relative_path),
        ).fetchone()
        if row:
            return row["document_id"]
        doc_id = _uuid()
        self.conn.execute(
            "INSERT INTO source_document(document_id, process_id, logical_name, relative_path) VALUES (?,?,?,?)",
            (doc_id, DEFAULT_PROCESS_ID, logical_name, relative_path),
        )
        return doc_id

    def new_document_version(self, document_id: str, *, dvc_hash: str, sha256: str,
                             structure_hash: str, semantic_hash: str,
                             parser_version: str, mapping_version: str,
                             git_rev: str | None = None) -> str:
        cur = self.conn.execute(
            "SELECT document_version_id, sha256 FROM document_version WHERE document_id=? AND is_current=1",
            (document_id,),
        ).fetchone()
        if cur and cur["sha256"] == sha256:
            return cur["document_version_id"]  # idempotent: 동일 바이너리 재적재
        version_id = _uuid()
        now = _now()
        if cur:
            self.conn.execute(
                "UPDATE document_version SET is_current=0 WHERE document_version_id=?",
                (cur["document_version_id"],),
            )
        self.conn.execute(
            """INSERT INTO document_version(document_version_id, document_id, dvc_hash, git_rev,
                   sha256, structure_hash, semantic_hash, parser_version, mapping_version,
                   detected_at, supersedes_version_id, is_current)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1)""",
            (version_id, document_id, dvc_hash, git_rev, sha256, structure_hash,
             semantic_hash, parser_version, mapping_version, now,
             cur["document_version_id"] if cur else None),
        )
        return version_id

    # ------------------------------------------------------------ loading ----
    def apply_package(self, records: list[RecordData], document_version_id: str,
                      mapping_decisions: list | None = None,
                      mapping_version: str = "") -> dict:
        """Versioned delta upsert; returns counts for the ingestion job log."""
        stats = {"inserted": 0, "updated": 0, "unchanged": 0, "tombstoned": 0}
        now = _now()
        conn = self.conn
        try:
            seen_keys = set()
            for rec in records:
                seen_keys.add(rec.record_key)
                sem = rec.semantic_hash()
                cur = conn.execute(
                    "SELECT * FROM record WHERE record_key=? AND is_current=1", (rec.record_key,)
                ).fetchone()
                if cur and cur["semantic_hash"] == sem:
                    stats["unchanged"] += 1
                    continue
                if cur:
                    conn.execute(
                        "UPDATE record SET is_current=0, valid_to=? WHERE record_row_id=?",
                        (now, cur["record_row_id"]),
                    )
                row_id = _uuid()
                version = (cur["version"] + 1) if cur else 1
                conn.execute(
                    """INSERT INTO record(record_row_id, process_id, record_key, record_type,
                          business_key, event_time, overall_status, note, source_sheet,
                          source_block_bbox, block_fingerprint, semantic_hash, version,
                          source_document_version_id, valid_from, is_current)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                    (row_id, DEFAULT_PROCESS_ID, rec.record_key, rec.record_type,
                     rec.business_key, rec.event_time, rec.overall_status, rec.note,
                     rec.source_sheet, rec.source_block_bbox, rec.block_fingerprint,
                     sem, version, document_version_id, now),
                )
                self._apply_observations(rec, row_id, document_version_id, now)
                self._apply_attachments(rec, row_id, document_version_id, now)
                stats["updated" if cur else "inserted"] += 1

            # 원본에서 사라진 record는 tombstone (§15: 즉시 delete 금지)
            doc_row = conn.execute(
                "SELECT document_id FROM document_version WHERE document_version_id=?",
                (document_version_id,),
            ).fetchone()
            if doc_row and records:
                prior = conn.execute(
                    """SELECT r.record_row_id, r.record_key FROM record r
                       JOIN document_version dv ON dv.document_version_id = r.source_document_version_id
                       WHERE dv.document_id=? AND r.is_current=1""",
                    (doc_row["document_id"],),
                ).fetchall()
                for p in prior:
                    if p["record_key"] not in seen_keys:
                        conn.execute(
                            "UPDATE record SET is_current=0, is_tombstone=1, valid_to=? WHERE record_row_id=?",
                            (now, p["record_row_id"]),
                        )
                        conn.execute(
                            "UPDATE observation SET is_current=0, valid_to=? WHERE record_key=? AND is_current=1",
                            (now, p["record_key"]),
                        )
                        stats["tombstoned"] += 1

            for d in mapping_decisions or []:
                conn.execute(
                    """INSERT OR IGNORE INTO mapping_decision(mapping_id, field_signature, raw_label,
                           context, concept_id, confidence, reasons, decision, mapping_version)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (_uuid(), d.field_signature, d.raw_label, d.context, d.concept_id,
                     d.confidence, json.dumps(d.reasons, ensure_ascii=False), d.decision,
                     d.mapping_version or mapping_version),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return stats

    def _apply_observations(self, rec: RecordData, record_row_id: str,
                            document_version_id: str, now: str) -> None:
        conn = self.conn
        current = {
            r["observation_key"]: r
            for r in conn.execute(
                "SELECT * FROM observation WHERE record_key=? AND is_current=1", (rec.record_key,)
            ).fetchall()
        }
        seen = set()
        for o in rec.observations:
            seen.add(o.observation_key)
            prev = current.get(o.observation_key)
            same = prev is not None and (
                prev["normalized_value_text"] == o.normalized_value_text
                and prev["normalized_value_num"] == o.normalized_value_num
                and prev["canonical_unit"] == o.canonical_unit
                and prev["value_role"] == o.value_role
                and prev["status_code"] == o.status_code
                and prev["concept_id"] == o.concept_id
            )
            if same:
                # 변경 없는 observation은 기존 버전 유지 (§8.6 영향 row만 갱신)
                conn.execute(
                    "UPDATE observation SET record_row_id=? WHERE observation_id=?",
                    (record_row_id, prev["observation_id"]),
                )
                continue
            if prev is not None:
                conn.execute(
                    "UPDATE observation SET is_current=0, valid_to=? WHERE observation_id=?",
                    (now, prev["observation_id"]),
                )
            conn.execute(
                """INSERT INTO observation(observation_id, record_row_id, record_key, observation_key,
                       concept_id, raw_label, header_path, raw_value_text, raw_value_num,
                       normalized_value_text, normalized_value_num, raw_unit, canonical_unit,
                       value_role, status_code, source_sheet, source_address, row_key,
                       mapping_confidence, mapping_decision, source_document_version_id,
                       valid_from, is_current)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                (_uuid(), record_row_id, rec.record_key, o.observation_key, o.concept_id,
                 o.raw_label, json.dumps(o.header_path, ensure_ascii=False), o.raw_value_text,
                 o.raw_value_num, o.normalized_value_text, o.normalized_value_num, o.raw_unit,
                 o.canonical_unit, o.value_role, o.status_code, o.source_sheet,
                 o.source_address, o.row_key, o.mapping_confidence, o.mapping_decision,
                 document_version_id, now),
            )
        for key, prev in current.items():
            if key not in seen:
                conn.execute(
                    "UPDATE observation SET is_current=0, valid_to=? WHERE observation_id=?",
                    (now, prev["observation_id"]),
                )

    def _apply_attachments(self, rec: RecordData, record_row_id: str,
                           document_version_id: str, now: str) -> None:
        conn = self.conn
        current = {
            r["image_hash"]: r
            for r in conn.execute(
                "SELECT * FROM attachment WHERE record_key=? AND is_current=1", (rec.record_key,)
            ).fetchall()
        }
        seen = set()
        for a in rec.attachments:
            h = a["image_hash"]
            seen.add(h)
            if h in current:
                conn.execute(
                    "UPDATE attachment SET record_row_id=? WHERE attachment_id=?",
                    (record_row_id, current[h]["attachment_id"]),
                )
                continue
            conn.execute(
                """INSERT INTO attachment(attachment_id, record_row_id, record_key, image_hash,
                       source_anchor, uri, source_document_version_id, valid_from, is_current)
                   VALUES (?,?,?,?,?,?,?,?,1)""",
                (_uuid(), record_row_id, rec.record_key, h, a.get("source_anchor"),
                 a.get("media_path"), document_version_id, now),
            )
        for h, prev in current.items():
            if h not in seen:
                conn.execute(
                    "UPDATE attachment SET is_current=0, valid_to=? WHERE attachment_id=?",
                    (now, prev["attachment_id"]),
                )

    # ---------------------------------------------------------- job / query ----
    def log_job(self, trigger_kind: str, source_path: str, version_id: str | None,
                status: str, detail: str = "") -> str:
        job_id = _uuid()
        self.conn.execute(
            """INSERT INTO ingestion_job(job_id, trigger_kind, source_path, source_version_id,
                   status, detail, finished_at) VALUES (?,?,?,?,?,?,?)""",
            (job_id, trigger_kind, source_path, version_id, status, detail, _now()),
        )
        self.conn.commit()
        return job_id

    def current_records(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM v_current_record ORDER BY record_key").fetchall()

    def current_observations(self, record_key: str | None = None) -> list[sqlite3.Row]:
        if record_key:
            return self.conn.execute(
                "SELECT * FROM v_current_observation WHERE record_key=? ORDER BY observation_key",
                (record_key,),
            ).fetchall()
        return self.conn.execute(
            "SELECT * FROM v_current_observation ORDER BY record_key, observation_key"
        ).fetchall()

    def records_as_of(self, ts: str) -> list[sqlite3.Row]:
        """과거 시점의 current view 재구성 (§14 Rollback 합격 기준)."""
        return self.conn.execute(
            """SELECT * FROM record
               WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND is_tombstone=0
               ORDER BY record_key""",
            (ts, ts),
        ).fetchall()

    def observations_as_of(self, ts: str, record_key: str | None = None) -> list[sqlite3.Row]:
        q = """SELECT * FROM observation
               WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)"""
        args: list = [ts, ts]
        if record_key:
            q += " AND record_key=?"
            args.append(record_key)
        return self.conn.execute(q + " ORDER BY record_key, observation_key", args).fetchall()
