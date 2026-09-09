"""영속 작업 상태 + 단일 워커. 큰 Reader 작업은 취소 가능한 별도 프로세스로 격리한다."""

from __future__ import annotations

import json
import multiprocessing
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from .db import Problem, digest, dump, insert, now, one, uid


class Cancelled(Problem):
    def __init__(self):
        super().__init__("CANCELLED", "작업을 취소했습니다.", 409)


def _reader_child(pipe, root, provider, principal, operation, payload):
    try:
        # Linux에서는 비정상적으로 큰 workbook의 메모리 사용을 프로세스에 한정한다.
        if os.name == "posix":
            import resource

            ceiling = (
                int(os.environ.get("KG_V2_READER_MEMORY_MB", "1536")) * 1024 * 1024
            )
            resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
        from .readers import make_reader

        reader = make_reader(root, provider, principal)
        result = getattr(reader, operation)(**payload)
        events = result if operation == "extract" else iter([result])
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
            (
                "error",
                ("READER_MEMORY_LIMIT", "문서 읽기 메모리 한도를 초과했습니다.", 413),
            )
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


def reader_events(
    root, provider, principal, operation, payload, checkpoint=lambda: None
):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(
        target=_reader_child,
        args=(child, str(root), provider, principal, operation, payload),
        daemon=True,
    )
    process.start()
    child.close()
    deadline = time.monotonic() + int(
        os.environ.get("KG_V2_READER_TIMEOUT_SECONDS", "120")
    )
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
                raise Problem(
                    "READER_STOPPED", "문서 읽기 프로세스가 종료되었습니다.", 422
                )
    finally:
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)


class Jobs:
    def __init__(self, db, handler, failure_handler):
        self.db, self.handler, self.failure_handler = db, handler, failure_handler
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.volatile = {}
        self.cache_lock = threading.Lock()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(
            target=self._loop, name="kg-v2-worker", daemon=True
        )
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=3)

    def submit(self, kind, payload, principal, request_key, prepare=None):
        if (
            not isinstance(request_key, str)
            or not request_key
            or len(request_key) > 128
        ):
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
                >= 32
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
                created_at=now(),
            )
            result = self.public(
                one(conn, "SELECT * FROM runtime_job WHERE job_id=?", (jid,))
            )
        self.wake.set()
        return result

    @staticmethod
    def public(row):
        keys = (
            "job_id",
            "kind",
            "state",
            "completed",
            "total",
            "created_at",
            "finished_at",
            "error_code",
            "error_message",
        )
        return {
            **{k: row.get(k) for k in keys},
            "result": (
                json.loads(row["result_json"]) if row.get("result_json") else None
            ),
        }

    def get(self, jid, principal):
        with self.db.connect() as conn:
            result = self.public(
                one(
                    conn,
                    "SELECT * FROM runtime_job WHERE job_id=? AND principal=?",
                    (jid, principal),
                )
            )
        if result["result"] and result["result"].get("volatile"):
            with self.cache_lock:
                cached = self.volatile.get((jid, principal))
                if cached and cached[0] > time.monotonic():
                    result["result"] = cached[1]
                else:
                    self.volatile.pop((jid, principal), None)
                    result["result"] = {**result["result"], "expired": True}
        return result

    def cancel(self, jid, principal):
        with self.db.connect(write=True) as conn:
            one(
                conn,
                "SELECT * FROM runtime_job WHERE job_id=? AND principal=?",
                (jid, principal),
            )
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
        # 단일 서버 프로세스 PoC. 중단된 작업은 heartbeat 만료 뒤 실패로 정리한다.
        expired = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat(
            timespec="milliseconds"
        )
        with self.db.connect() as conn:
            stale = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM runtime_job WHERE state='running' AND heartbeat_at<?",
                    (expired,),
                )
            ]
        for job in stale:
            error = Problem(
                "INTERRUPTED",
                "서버 중단으로 작업이 완료되지 않았습니다. 다시 실행하세요.",
                409,
            )
            self._fail(job, error)
        with self.db.connect(write=True) as conn:
            row = conn.execute(
                "SELECT * FROM runtime_job WHERE state='queued' ORDER BY created_at,job_id LIMIT 1"
            ).fetchone()
            if not row:
                return False
            job = dict(row)
            conn.execute(
                "UPDATE runtime_job SET state='running',heartbeat_at=? WHERE job_id=?",
                (now(), job["job_id"]),
            )
        last_check = [0.0]

        def checkpoint(completed=None, total=None, force=False):
            if self.stop.is_set():
                raise Cancelled()
            if not force and time.monotonic() - last_check[0] < 0.25:
                return
            last_check[0] = time.monotonic()
            with self.db.connect(write=True) as conn:
                state = one(
                    conn, "SELECT * FROM runtime_job WHERE job_id=?", (job["job_id"],)
                )
                if state["cancel_requested"] or state["state"] != "running":
                    raise Cancelled()
                conn.execute(
                    "UPDATE runtime_job SET heartbeat_at=?,completed=coalesce(?,completed),total=coalesce(?,total) WHERE job_id=?",
                    (now(), completed, total, job["job_id"]),
                )

        try:
            checkpoint(force=True)
            result = self.handler(
                job["kind"],
                json.loads(job["payload_json"]),
                job["principal"],
                checkpoint,
            )
            # 렌더 결과는 권한과 관계없이 디스크에 저장하지 않는다. 최대 8개, 60초.
            if job["kind"] == "viewport":
                result.pop("_volatile", None)
                with self.cache_lock:
                    self.volatile = {
                        k: v
                        for k, v in self.volatile.items()
                        if v[0] > time.monotonic()
                    }
                    while len(self.volatile) >= 8:
                        self.volatile.pop(next(iter(self.volatile)))
                    self.volatile[(job["job_id"], job["principal"])] = (
                        time.monotonic() + 60,
                        result,
                    )
                result = {
                    "volatile": True,
                    "version_id": result["version_id"],
                    "sheet_id": result["sheet_id"],
                }
            with self.db.connect(write=True) as conn:
                conn.execute(
                    "UPDATE runtime_job SET state='succeeded',result_json=?,finished_at=? WHERE job_id=?",
                    (dump(result), now(), job["job_id"]),
                )
        except Problem as exc:
            self._fail(job, exc)
        except Exception:
            import logging

            logging.getLogger(__name__).exception("v2 job failed: %s", job["job_id"])
            self._fail(
                job,
                Problem(
                    "JOB_FAILED",
                    "작업 처리에 실패했습니다. 서버 기록을 확인하세요.",
                    500,
                ),
            )
        return True

    def _fail(self, job, exc):
        self.failure_handler(job["kind"], json.loads(job["payload_json"]), exc)
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
