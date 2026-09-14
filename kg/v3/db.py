"""요청/작업마다 연결을 분리하고 짧은 트랜잭션으로 쓰는 v3 SQLite 저장소(`<ws>/data/kg/v3.db`).

계약 §1. 코어 DDL은 db/v3/schema_sqlite.sql, 런타임 테이블(runtime_job·snapshot_signature)은 여기서 만든다.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 3
REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "db/v3/schema_sqlite.sql"

RUNTIME_DDL = """
CREATE TABLE IF NOT EXISTS runtime_job (
  job_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register','extract','reparse','build','test','queue_action','migrate')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  principal TEXT NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT, error_message TEXT,
  completed INTEGER NOT NULL DEFAULT 0, total INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('document','profile','application','build','queue_group','workspace')),
  target_id TEXT, label TEXT,
  created_at TEXT NOT NULL, started_at TEXT, heartbeat_at TEXT, finished_at TEXT,
  UNIQUE (principal, kind, request_key)
);
CREATE INDEX IF NOT EXISTS runtime_job_queue ON runtime_job(state, created_at, job_id);
CREATE INDEX IF NOT EXISTS runtime_job_target ON runtime_job(target_kind, target_id);
CREATE INDEX IF NOT EXISTS runtime_job_recent ON runtime_job(created_at DESC, job_id DESC);
CREATE TABLE IF NOT EXISTS snapshot_signature (
  snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES document_snapshot,
  algorithm TEXT NOT NULL,
  signature_json TEXT NOT NULL CHECK (json_valid(signature_json)),
  signature_sha256 TEXT NOT NULL,
  reader_revision TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_signature_sha ON snapshot_signature(signature_sha256);
"""


class Problem(Exception):
    """API 오류. code는 안정 식별자, status는 HTTP 상태."""

    def __init__(self, code: str, message: str, status: int = 422, fields=None):
        super().__init__(message)
        self.code, self.message, self.status, self.fields = code, message, status, fields


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def uid() -> str:
    return str(uuid4())


def dump(value) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def load(text, default=None):
    return json.loads(text) if text else default


def digest(value) -> str:
    return hashlib.sha256(dump(value).encode()).hexdigest()


def norm(value) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value)).casefold().split())


def insert(conn, table: str, **values):
    # 테이블/컬럼은 내부 코드 상수이며 외부 값은 바인딩한다.
    conn.execute(
        f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
        tuple(values.values()),
    )


def upsert(conn, table: str, keys: tuple, **values):
    """UNIQUE(keys)로 존재하면 나머지 컬럼을 갱신하고 없으면 삽입한다."""
    where = " AND ".join(f"{k}=?" for k in keys)
    row = conn.execute(
        f"SELECT * FROM {table} WHERE {where}", tuple(values[k] for k in keys)
    ).fetchone()
    if row is None:
        insert(conn, table, **values)
        return dict(conn.execute(f"SELECT * FROM {table} WHERE {where}", tuple(values[k] for k in keys)).fetchone())
    updates = {k: v for k, v in values.items() if k not in keys}
    if updates:
        conn.execute(
            f"UPDATE {table} SET {','.join(f'{k}=?' for k in updates)} WHERE {where}",
            (*updates.values(), *(values[k] for k in keys)),
        )
    return dict(conn.execute(f"SELECT * FROM {table} WHERE {where}", tuple(values[k] for k in keys)).fetchone())


def one(conn, sql, params=(), missing="요청한 항목을 찾을 수 없습니다."):
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise Problem("NOT_FOUND", missing, 404)
    return dict(row)


def rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params)]


def encode_cursor(values, scope) -> str:
    return base64.urlsafe_b64encode(
        dump({"scope": digest(scope), "values": values}).encode()
    ).decode()


def decode_cursor(value, scope, length):
    if not value:
        return None
    try:
        if len(value) > 4096:
            raise ValueError()
        data = json.loads(base64.b64decode(value.encode(), altchars=b"-_", validate=True))
        if (
            data["scope"] != digest(scope)
            or not isinstance(data["values"], list)
            or len(data["values"]) != length
        ):
            raise ValueError()
        if any(
            type(v) not in (str, int) or isinstance(v, int) and not -(2**63) <= v < 2**63
            for v in data["values"]
        ):
            raise ValueError()
        return data["values"]
    except (ValueError, KeyError, TypeError):
        raise Problem(
            "INVALID_CURSOR", "필터가 바뀌었거나 페이지 위치가 유효하지 않습니다."
        ) from None


def page(rows_, limit, keys, scope):
    items = [dict(r) for r in rows_]
    more = len(items) > limit
    items = items[:limit]
    return {
        "items": items,
        "has_more": more,
        "next_cursor": encode_cursor([items[-1][k] for k in keys], scope) if more else None,
    }


class Database:
    """WAL·foreign_keys·busy_timeout을 연결마다 설정한다. 새 DB는 DDL로 만들고, 다른 버전은 거부한다."""

    def __init__(self, root: Path, schema_path: Path | None = None):
        self.root = Path(root).resolve()
        self.path = self.root / "data/kg/v3.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        schema = Path(schema_path) if schema_path else SCHEMA_PATH
        with self.connect() as conn:
            tables = {
                r[0]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if not tables:
                conn.executescript(
                    "BEGIN IMMEDIATE;\n" + schema.read_text(encoding="utf-8") + "\nCOMMIT;"
                )
            elif (
                "schema_meta" not in tables
                or conn.execute("SELECT version FROM schema_meta").fetchone()[0]
                != SCHEMA_VERSION
            ):
                raise Problem(
                    "WRONG_DATABASE",
                    "v3 전용 DB가 아닙니다. 기존 DB를 자동 변경하지 않습니다.",
                    409,
                )
            conn.executescript(RUNTIME_DDL)
            conn.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def connect(self, write=False):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
