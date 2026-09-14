"""영속 작업 상태(runtime_job) + 단일 워커. 큰 Reader 작업은 취소 가능한 별도 프로세스로 격리한다.

v2 `kg/v2/jobs.py`를 v3 계약(§1.6 runtime_job 컬럼, §3.2 모든 Reader 연산의 스트림 처리, KG_V3_* 환경변수)에 맞게 옮긴 것.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from .db import Problem, digest, dump, insert, now, one, uid

STREAM_OPERATIONS = ("extract", "render")
READER_PRELOAD = ("kg.v3.readers",)
_context_lock = threading.Lock()
_context = None


def env(name: str, default: str) -> str:
    """KG_V3_<name> → KG_V2_<name> → default 순으로 읽는다."""
    return os.environ.get("KG_V3_" + name) or os.environ.get("KG_V2_" + name) or default


def reader_context():
    """Reader 프로세스 시작 방식. 기본은 forkserver(+readers 미리 import)라 연산마다 인터프리터를 새로 띄우지 않는다.

    KG_V3_READER_CONTEXT=spawn 으로 되돌릴 수 있다. forkserver가 없는 플랫폼은 spawn."""
    global _context
    if _context is None:
        with _context_lock:
            if _context is None:
                wanted = env("READER_CONTEXT", "forkserver")
                if wanted not in multiprocessing.get_all_start_methods():
                    wanted = "spawn"
                context = multiprocessing.get_context(wanted)
                if wanted == "forkserver":
                    context.set_forkserver_preload(list(READER_PRELOAD))
                _context = context
    return _context


def _reader_environment():
    # forkserver 자식은 서버 프로세스의 환경을 물려받으므로 호출 시점의 KG_* 설정을 명시적으로 넘긴다.
    return {k: v for k, v in os.environ.items() if k.startswith("KG_")}


class Cancelled(Problem):
    def __init__(self):
        super().__init__("CANCELLED", "작업을 취소했습니다.", 409)


def _reader_child(pipe, environ, root, provider, principal, operation, payload):
    try:
        for key in [k for k in os.environ if k.startswith("KG_") and k not in environ]:
            del os.environ[key]
        os.environ.update(environ)
        if os.name == "posix":
            import resource

            ceiling = int(env("READER_MEMORY_MB", "1536")) * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
        from .readers import make_reader

        reader = make_reader(root, provider, principal)
        result = getattr(reader, operation)(**payload)
        events = result if operation in STREAM_OPERATIONS else iter([result])
        for event in events:
            if len(dump(event).encode()) > 8 * 1024 * 1024:
                raise Problem(
                    "READER_OUTPUT_LIMIT",
                    "한 번의 읽기 결과가 너무 큽니다. 범위를 나누세요.",
                    413,
                )
            pipe.send(("data", event))
        pipe.send(("done", None))
    except Problem as exc:
        pipe.send(("error", (exc.code, exc.message, exc.status)))
    except MemoryError:
        pipe.send(
            ("error", ("READER_MEMORY_LIMIT", "문서 읽기 메모리 한도를 초과했습니다.", 413))
        )
    except Exception:
        # 제공자 예외의 파일 경로/자격 증명을 API 응답에 노출하지 않는다.
        pipe.send(
            (
                "error",
                (
                    "READER_FAILED",
                    "문서 읽기에 실패했습니다. 제공자 설정과 문서 형식을 확인하세요.",
                    422,
                ),
            )
        )
    finally:
        pipe.close()


def reader_events(root, provider, principal, operation, payload, checkpoint=lambda: None):
    """격리 프로세스에서 Reader 연산을 실행하고 이벤트를 순서대로 돌려준다(시간·메모리·출력 한도)."""
    context = reader_context()
    parent, child = context.Pipe(duplex=False)
    process = context.Process(
        target=_reader_child,
        args=(child, _reader_environment(), str(root), provider, principal, operation, payload),
        daemon=True,
    )
    process.start()
    child.close()
    deadline = time.monotonic() + int(env("READER_TIMEOUT_SECONDS", "120"))
    done = False
    try:
        while not done:
            checkpoint()
            if time.monotonic() > deadline:
                raise Problem(
                    "READER_TIMEOUT",
                    "문서 읽기 제한 시간을 초과했습니다. 범위를 줄이거나 제공자 설정을 확인하세요.",
                    408,
                )
            if parent.poll(0.1):
                try:
                    kind, value = parent.recv()
                except EOFError:
                    raise Problem(
                        "READER_STOPPED", "문서 읽기 프로세스가 종료되었습니다.", 422
                    ) from None
                if kind == "error":
                    raise Problem(*value)
                if kind == "done":
                    done = True
                else:
                    yield value
            elif not process.is_alive():
                raise Problem("READER_STOPPED", "문서 읽기 프로세스가 종료되었습니다.", 422)
    finally:
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)


def reader_result(root, provider, principal, operation, payload, checkpoint=lambda: None):
    """단일 결과 연산(describe/match/match_specs/authorize/signature)을 격리 실행한다."""
    result = None
    for event in reader_events(root, provider, principal, operation, payload, checkpoint):
        result = event
    if result is None:
        raise Problem("READER_STOPPED", "문서 읽기 결과가 없습니다.", 422)
    return result


class Jobs:
    """runtime_job 큐. handler(kind, payload, principal, checkpoint) → result dict."""

    PUBLIC = (
        "job_id",
        "kind",
        "state",
        "completed",
        "total",
        "target_kind",
        "target_id",
        "label",
        "created_at",
        "started_at",
        "finished_at",
        "error_code",
        "error_message",
    )

    def __init__(self, db, handler, failure_handler=None):
        self.db, self.handler = db, handler
        self.failure_handler = failure_handler or (lambda kind, payload, exc: None)
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        # 완료 알림: wait()는 폴링 대신 이 조건 변수를 기다린다(세대 번호로 잃어버린 알림을 막는다).
        self.done = threading.Condition()
        self.done_seq = 0

    def _notify_done(self):
        with self.done:
            self.done_seq += 1
            self.done.notify_all()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._loop, name="kg-v3-worker", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=3)

    def submit(
        self,
        kind,
        payload,
        principal,
        request_key,
        prepare=None,
        target_kind=None,
        target_id=None,
        label=None,
    ):
        if not isinstance(request_key, str) or not request_key or len(request_key) > 128:
            raise Problem("REQUEST_KEY_REQUIRED", "요청 식별자가 필요합니다.")
        hashed = digest(payload)
        with self.db.connect(write=True) as conn:
            existing = conn.execute(
                "SELECT * FROM runtime_job WHERE principal=? AND kind=? AND request_key=?",
                (principal, kind, request_key),
            ).fetchone()
            if existing:
                if existing["request_hash"] != hashed:
                    raise Problem(
                        "IDEMPOTENCY_CONFLICT",
                        "같은 요청 식별자에 다른 내용이 전달되었습니다.",
                        409,
                    )
                return self.public(dict(existing))
            if (
                conn.execute(
                    "SELECT count(*) FROM runtime_job WHERE state IN ('queued','running')"
                ).fetchone()[0]
                >= 64
            ):
                raise Problem(
                    "QUEUE_FULL",
                    "대기 작업이 많습니다. 진행 중 작업이 끝나면 다시 시도하세요.",
                    503,
                )
            jid = uid()
            if prepare:
                payload = prepare(conn, jid, payload)
            insert(
                conn,
                "runtime_job",
                job_id=jid,
                kind=kind,
                state="queued",
                principal=principal,
                payload_json=dump(payload),
                request_key=request_key,
                request_hash=hashed,
                target_kind=target_kind,
                target_id=target_id,
                label=label,
                created_at=now(),
            )
            result = self.public(one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (jid,)))
        self.wake.set()
        return result

    def record_sync(self, kind, principal, target_kind, target_id, label, payload=None):
        """동기 실행(프로파일 테스트·작은 빌드)의 이력 행. finish_sync로 닫는다."""
        jid = uid()
        with self.db.connect(write=True) as conn:
            insert(
                conn,
                "runtime_job",
                job_id=jid,
                kind=kind,
                state="running",
                principal=principal,
                payload_json=dump(payload or {}),
                request_key=jid,
                request_hash=digest(payload or {}),
                target_kind=target_kind,
                target_id=target_id,
                label=label,
                created_at=now(),
                started_at=now(),
                heartbeat_at=now(),
            )
        return jid

    def finish_sync(self, jid, result=None, error: Problem | None = None):
        with self.db.connect(write=True) as conn:
            if error is None:
                conn.execute(
                    "UPDATE runtime_job SET state='succeeded',result_json=?,finished_at=?,completed=coalesce(total,completed) WHERE job_id=?",
                    (dump(result or {}), now(), jid),
                )
            else:
                conn.execute(
                    "UPDATE runtime_job SET state='failed',error_code=?,error_message=?,finished_at=? WHERE job_id=?",
                    (error.code, error.message, now(), jid),
                )
        self._notify_done()

    @classmethod
    def public(cls, row):
        return {
            **{k: row.get(k) for k in cls.PUBLIC},
            "result": json.loads(row["result_json"]) if row.get("result_json") else None,
        }

    def get(self, jid, principal=None):
        with self.db.connect() as conn:
            row = one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (jid,))
        if principal is not None and row["principal"] != principal:
            raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
        return self.public(row)

    def wait(self, jid, seconds, principal=None):
        """워커 스레드가 작업을 끝낼 때까지(최대 seconds) 기다린다. 워커가 없으면 직접 실행한다.

        50ms 폴링 대신 완료 조건 변수를 기다린다: 대기 중인 요청 스레드가 SQLite 연결을 반복해 열지 않는다."""
        deadline = time.monotonic() + max(0.0, float(seconds))
        self.wake.set()
        while True:
            with self.done:
                seen = self.done_seq
            current = self.get(jid, principal)
            if current["state"] not in ("queued", "running"):
                return current
            if not (self.thread and self.thread.is_alive()):
                if not self.run_one():
                    return self.get(jid, principal)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return current
            with self.done:
                if self.done_seq == seen:
                    # 상한 1초: 워커가 죽는 등 알림이 오지 않는 경우에도 행 상태를 다시 읽는다.
                    self.done.wait(min(remaining, 1.0))

    def cancel(self, jid, principal=None):
        with self.db.connect(write=True) as conn:
            row = one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (jid,))
            if principal is not None and row["principal"] != principal:
                raise Problem("NOT_FOUND", "요청한 항목을 찾을 수 없습니다.", 404)
            conn.execute(
                "UPDATE runtime_job SET cancel_requested=1 WHERE job_id=? AND state IN ('queued','running')",
                (jid,),
            )
        self.wake.set()

    def _loop(self):
        while not self.stop.is_set():
            try:
                if not self.run_one():
                    self.wake.wait(0.5)
                    self.wake.clear()
            except Exception:
                self.wake.wait(0.5)
                self.wake.clear()

    def run_one(self):
        """큐에서 하나를 꺼내 실행한다. 실행했으면 True. 단일 서버 프로세스 PoC; 끊긴 작업은 heartbeat 만료 뒤 실패."""
        expired = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat(
            timespec="milliseconds"
        )
        with self.db.connect() as conn:
            stale = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM runtime_job WHERE state='running' AND heartbeat_at<? AND request_key<>job_id",
                    (expired,),
                )
            ]
        for job in stale:
            self._fail(
                job,
                Problem("INTERRUPTED", "서버 중단으로 작업이 완료되지 않았습니다. 다시 실행하세요.", 409),
            )
        with self.lock:
            # 대기 행이 있는지는 읽기 연결로 먼저 본다: 유휴 워커가 0.5초마다 쓰기 잠금을 잡지 않게.
            with self.db.connect() as conn:
                if not conn.execute("SELECT 1 FROM runtime_job WHERE state='queued' LIMIT 1").fetchone():
                    return False
            with self.db.connect(write=True) as conn:
                row = conn.execute(
                    "SELECT * FROM runtime_job WHERE state='queued' ORDER BY created_at,job_id LIMIT 1"
                ).fetchone()
                if not row:
                    return False
                job = dict(row)
                conn.execute(
                    "UPDATE runtime_job SET state='running',started_at=?,heartbeat_at=? WHERE job_id=?",
                    (now(), now(), job["job_id"]),
                )
            last_check = [0.0]

            def checkpoint(completed=None, total=None, force=False):
                if self.stop.is_set():
                    raise Cancelled()
                if not force and time.monotonic() - last_check[0] < 0.25:
                    return
                last_check[0] = time.monotonic()
                with self.db.connect(write=True) as conn:
                    state = one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (job["job_id"],))
                    if state["cancel_requested"] or state["state"] != "running":
                        raise Cancelled()
                    conn.execute(
                        "UPDATE runtime_job SET heartbeat_at=?,completed=coalesce(?,completed),total=coalesce(?,total) WHERE job_id=?",
                        (now(), completed, total, job["job_id"]),
                    )

            try:
                checkpoint(force=True)
                result = self.handler(
                    job["kind"], json.loads(job["payload_json"]), job["principal"], checkpoint
                )
                with self.db.connect(write=True) as conn:
                    conn.execute(
                        "UPDATE runtime_job SET state='succeeded',result_json=?,finished_at=?,completed=coalesce(total,completed) WHERE job_id=?",
                        (dump(result if result is not None else {}), now(), job["job_id"]),
                    )
                self._notify_done()
            except Problem as exc:
                self._fail(job, exc)
            except Exception:
                import logging

                logging.getLogger(__name__).exception("v3 job failed: %s", job["job_id"])
                self._fail(
                    job,
                    Problem("JOB_FAILED", "작업 처리에 실패했습니다. 서버 기록을 확인하세요.", 500),
                )
            return True

    def _fail(self, job, exc):
        try:
            self.failure_handler(job["kind"], json.loads(job["payload_json"]), exc)
        except Exception:
            pass
        with self.db.connect(write=True) as conn:
            conn.execute(
                "UPDATE runtime_job SET state=?,error_code=?,error_message=?,finished_at=? WHERE job_id=? AND state IN ('queued','running')",
                (
                    "cancelled" if exc.code == "CANCELLED" else "failed",
                    exc.code,
                    exc.message,
                    now(),
                    job["job_id"],
                ),
            )
        self._notify_done()
