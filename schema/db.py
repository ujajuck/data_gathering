"""요청/작업마다 연결을 분리하고 짧은 트랜잭션으로 쓰는 SQLite 저장소(`<ws>/workspace.db`).

계약 §1. 코어 DDL은 db/schema_sqlite.sql, 런타임 테이블(runtime_job·snapshot_signature·source_digest)은 여기서 만든다.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 3
REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "db/schema_sqlite.sql"
# 런타임 경로가 아니다 — 옛 배치의 DB를 새 위치로 옮기지 않은 작업 공간에서 빈 DB를 만들지 않으려고만 본다.
PREVIOUS_DB_PATH = "data/kg/v3.db"

# runtime_job만 따로 둔다 — 옛 작업 공간의 kind CHECK 이관(_migrate_runtime_job)이 이 정의를 그대로 다시 쓴다.
RUNTIME_JOB_DDL = """
CREATE TABLE IF NOT EXISTS runtime_job (
  job_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register','extract','reparse','build','test','queue_action','delete')),
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
"""

RUNTIME_DDL = RUNTIME_JOB_DDL + """
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
-- §1.6 source_digest: 로컬 원본 (byte_size, mtime_ns) → 내용 SHA-256 캐시. §4.1.1 스캔이 같은 stat이면 파일을 읽지 않는다.
-- 진실은 document_snapshot.change_token이며 이 표는 언제 지워도 된다(다음 스캔이 다시 계산).
CREATE TABLE IF NOT EXISTS source_digest (
  provider TEXT NOT NULL,
  source_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, source_path)
);
-- 값 목록 keyset(§6 /values): 실행 안에서 group_key·item_index 순으로 O(페이지) 탐색.
CREATE INDEX IF NOT EXISTS value_by_run_group ON extracted_value(run_id, group_key, item_index, value_id);
-- 아래는 코어 DDL(db/schema_sqlite.sql)에도 있는 인덱스다. 이전 DDL로 만든 DB에도 붙도록 IF NOT EXISTS로 한 번 더 선언한다.
CREATE INDEX IF NOT EXISTS value_by_run_revision ON extracted_value(run_id, mapping_revision_id, group_key, item_index, value_id);
CREATE INDEX IF NOT EXISTS value_by_field_created ON extracted_value(field_id, created_at DESC, value_id);
CREATE INDEX IF NOT EXISTS value_unit_by_run ON extracted_value(run_id, field_id, unit_normalized) WHERE unit_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS mapping_by_head ON mapping(current_revision_id);
CREATE INDEX IF NOT EXISTS document_by_processed ON document(coalesce(last_processed_at,'') DESC, document_id DESC);
CREATE INDEX IF NOT EXISTS document_by_name ON document(document_name, document_id);
CREATE INDEX IF NOT EXISTS document_by_status ON document(status, document_id);
"""


class Problem(Exception):
    """API 오류. code는 안정 식별자, status는 HTTP 상태.

    detail은 §6의 구조화 본문(SCHEMA_IN_USE·FIELD_IN_USE·FIELD_HAS_CHILDREN에서만 쓴다).
    화면은 detail 없이 message만으로도 뜻이 통해야 한다.
    """

    def __init__(self, code: str, message: str, status: int = 422, fields=None, detail=None):
        super().__init__(message)
        self.code, self.message, self.status, self.fields, self.detail = code, message, status, fields, detail


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



def _migrate_runtime_job(conn) -> bool:
    """§1.6 `runtime_job.kind` CHECK에 'delete'가 없는 옛 작업 공간을 이관한다(표 재작성).

    `CREATE TABLE IF NOT EXISTS`는 이미 있는 표의 CHECK를 고치지 않으므로, 이관하지 않으면 옛 DB에서
    문서 삭제(§4.13)가 `CHECK constraint failed`로 죽는다. `runtime_job`은 다른 표가 FK로 가리키지 않아
    교체가 안전하다. 이관했으면 True(호출자가 인덱스를 다시 만든다)."""
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_job'").fetchone()
    if row is None or "'delete'" in (row[0] or ""):
        return False
    columns = ",".join(r[1] for r in conn.execute("PRAGMA table_info(runtime_job)"))
    conn.executescript(
        "BEGIN IMMEDIATE;\n"
        + RUNTIME_JOB_DDL.replace("CREATE TABLE IF NOT EXISTS runtime_job", "CREATE TABLE runtime_job_new")
        + f"\nINSERT INTO runtime_job_new ({columns}) SELECT {columns} FROM runtime_job;\n"
        "DROP TABLE runtime_job;\n"
        "ALTER TABLE runtime_job_new RENAME TO runtime_job;\nCOMMIT;"
    )
    return True


def _core_statements(schema_text, pattern):
    return [m.group(0) for m in re.finditer(pattern, schema_text, re.S)]


def _migrate_purge_guard(conn, schema_path: Path) -> bool:
    """§1.10 삭제 가드가 없는 옛 작업 공간에 `purge_guard`와 DELETE 거부 트리거 여덟 개를 넣는다.

    문구가 어긋나지 않도록 표·트리거 정의를 코어 DDL 파일에서 그대로 읽어 쓴다(UPDATE 거부 트리거는 건드리지 않는다)."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purge_guard'").fetchone():
        return False
    text = Path(schema_path).read_text(encoding="utf-8")
    table = _core_statements(text, r"CREATE TABLE purge_guard \(.*?\);")
    triggers = {
        m.group(1): m.group(0)
        for m in re.finditer(r"CREATE TRIGGER (\w+_no_delete)\b.*?\bEND;", text, re.S)
        if "purge_guard" in m.group(0)
    }
    if not table or len(triggers) != 8:
        raise Problem("WRONG_DATABASE", "코어 DDL에서 삭제 가드 정의를 찾을 수 없습니다.", 409)
    script = "".join(f"DROP TRIGGER IF EXISTS {name};\n{sql}\n" for name, sql in triggers.items())
    conn.executescript("BEGIN IMMEDIATE;\n" + table[0] + "\n" + script + "COMMIT;")
    return True


class Database:
    """WAL·foreign_keys·busy_timeout을 연결마다 설정한다. 새 DB는 DDL로 만들고, 다른 버전은 거부한다."""

    def __init__(self, root: Path, schema_path: Path | None = None):
        self.root = Path(root).resolve()
        self.path = self.root / "workspace.db"
        if not self.path.exists() and (self.root / PREVIOUS_DB_PATH).exists():
            # 옛 배치의 DB가 있는데 새 위치가 비어 있다 — 빈 DB를 만들면 문서·승인·발행이 사라진 것처럼 보인다.
            raise Problem(
                "WORKSPACE_DB_MOVED",
                f"DB 파일 위치가 <작업 공간>/workspace.db로 바뀌었습니다. "
                f"`mv {self.root / PREVIOUS_DB_PATH} {self.path}` 후 다시 실행하세요.",
                409,
            )
        self.root.mkdir(parents=True, exist_ok=True)
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
                    "이 런타임이 만든 DB가 아닙니다. 기존 DB를 자동 변경하지 않습니다.",
                    409,
                )
            conn.executescript(RUNTIME_DDL)
            if _migrate_runtime_job(conn):
                conn.executescript(RUNTIME_DDL)  # 표를 다시 만들었으므로 인덱스를 되살린다
            _migrate_purge_guard(conn, schema)
            # WAL은 트랜잭션 밖에서만 바뀐다 — 아래 DELETE보다 먼저 친다.
            conn.execute("PRAGMA journal_mode=WAL")
            # §1.10 방어: 커밋된 DB에 가드 행이 남는 상태는 없지만, 있으면 여기서 회수한다.
            conn.execute("DELETE FROM purge_guard")

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
