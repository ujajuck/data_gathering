"""요청/작업마다 연결을 분리하고 짧은 트랜잭션으로 쓰는 SQLite 저장소."""

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


class Problem(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def uid() -> str:
    return str(uuid4())


def dump(value) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


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


def one(conn, sql, params=()):
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
    return dict(row)


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
        data = json.loads(
            base64.b64decode(value.encode(), altchars=b"-_", validate=True)
        )
        if (
            data["scope"] != digest(scope)
            or not isinstance(data["values"], list)
            or len(data["values"]) != length
        ):
            raise ValueError()
        if any(
            type(v) not in (str, int)
            or isinstance(v, int)
            and not -(2**63) <= v < 2**63
            for v in data["values"]
        ):
            raise ValueError()
        return data["values"]
    except (ValueError, KeyError, TypeError):
        raise Problem(
            "INVALID_CURSOR", "필터가 바뀌었거나 페이지 위치가 유효하지 않습니다."
        ) from None


def page(rows, limit, keys, scope):
    rows = [dict(r) for r in rows]
    more = len(rows) > limit
    items = rows[:limit]
    return {
        "items": items,
        "has_more": more,
        "next_cursor": (
            encode_cursor([items[-1][k] for k in keys], scope) if more else None
        ),
    }


class Database:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.path = self.root / "data/kg/v2.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        schema = Path(__file__).resolve().parents[2] / "db/v2/schema_sqlite.sql"
        with self.connect() as conn:
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if not tables:
                conn.executescript(
                    "BEGIN IMMEDIATE;\n"
                    + schema.read_text(encoding="utf-8")
                    + "\nCOMMIT;"
                )
            elif (
                "schema_meta" not in tables
                or conn.execute("SELECT version FROM schema_meta").fetchone()[0] != 2
            ):
                raise Problem(
                    "WRONG_DATABASE",
                    "v2 전용 DB가 아닙니다. 기존 DB를 자동 변경하지 않습니다.",
                )
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS runtime_job (
                  job_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL,
                  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
                  principal TEXT NOT NULL, payload_json TEXT NOT NULL,
                  result_json TEXT, error_code TEXT, error_message TEXT,
                  completed INTEGER NOT NULL DEFAULT 0, total INTEGER,
                  cancel_requested INTEGER NOT NULL DEFAULT 0,
                  request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                  created_at TEXT NOT NULL, heartbeat_at TEXT, finished_at TEXT,
                  UNIQUE(principal,kind,request_key)
                );
                CREATE INDEX IF NOT EXISTS runtime_job_queue ON runtime_job(state,created_at,job_id);
                CREATE INDEX IF NOT EXISTS access_latest ON access_observation(document_version_id,principal_ref,checked_at DESC,access_id DESC);
                CREATE INDEX IF NOT EXISTS app_source ON template_application(document_version_id,application_id);
                CREATE INDEX IF NOT EXISTS version_provider ON document(provider,source_ref);
                CREATE INDEX IF NOT EXISTS series_by_mapping ON extracted_series(mapping_revision_id,run_id,series_id);
                CREATE INDEX IF NOT EXISTS items_by_series ON extracted_item(series_id,item_index,item_id);
            """)
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
