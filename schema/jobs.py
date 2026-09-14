"""영속 작업 상태(runtime_job) + 단일 워커. 큰 Reader 작업은 취소 가능한 별도 프로세스로 격리한다.

계약 §1.6 runtime_job 컬럼, §3.2 모든 Reader 연산의 스트림 처리, `SCHEMA_*` 환경변수.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import signal
import threading
import time
from datetime import datetime, timedelta, timezone

from .db import Problem, digest, dump, insert, now, one, uid

STREAM_OPERATIONS = ("extract", "render")
READER_PRELOAD = ("schema.readers",)
_context_lock = threading.Lock()
_context = None


def env(name: str, default: str) -> str:
    """`SCHEMA_<name>` 환경변수를 읽고 없으면 default."""
    return os.environ.get("SCHEMA_" + name) or default


def reader_context():
    """Reader 프로세스 시작 방식. 기본은 forkserver(+readers 미리 import)라 연산마다 인터프리터를 새로 띄우지 않는다.

    SCHEMA_READER_CONTEXT=spawn 으로 되돌릴 수 있다. forkserver가 없는 플랫폼은 spawn."""
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
    # forkserver 자식은 서버 프로세스의 환경을 물려받으므로 호출 시점의 SCHEMA_* 설정을 명시적으로 넘긴다.
    return {k: v for k, v in os.environ.items() if k.startswith("SCHEMA_")}


# 이 작업(스레드) 하나가 친 보호 문서 해제 비용. Reader는 연산마다 별도 프로세스라 자식이 보내 준 값을 여기서 모은다.
_drm_local = threading.local()


def _add_drm(counts):
    total = getattr(_drm_local, "counts", None)
    if total is None:
        total = _drm_local.counts = {"unlocked": 0, "reused": 0, "failed": 0}
    for key in total:
        total[key] += int(counts.get(key) or 0)


def drm_counts(reset=False):
    """작업 하나가 친 해제 비용 `{unlocked, reused, failed}`. 보호 문서를 만나지 않았으면 None."""
    total = getattr(_drm_local, "counts", None)
    if reset:
        _drm_local.counts = None
    return total if total and any(total.values()) else None


class Cancelled(Problem):
    def __init__(self):
        super().__init__("CANCELLED", "작업을 취소했습니다.", 409)


class _Terminated(BaseException):
    """부모가 SIGTERM으로 이 자식을 끊었다(타임아웃·취소·스트림 중단). 감사와 해제본 정리를 마치고 끝낸다."""


def _reader_child(pipe, environ, root, provider, principal, operation, payload):
    """격리 프로세스 본체. 끝날 때 보호 문서 접근을 감사에 남기고(§3.5(4)) 해제 통계를 부모에게 보낸다.

    강제 종료 경로(부모의 `terminate()`)도 그냥 죽지 않는다 — SIGTERM을 예외로 바꿔 `finally`에서 감사와
    해제본 삭제가 반드시 돌게 한다. 이 처리가 없으면 '해제까지 갔다가 잘린' 접근이 기록에 남지 않고 평문이 남는다."""
    outcome, error_code, completion = "ok", None, ("done", None)
    try:
        signal.signal(signal.SIGTERM, _raise_terminated)
    except (ValueError, OSError, AttributeError):
        pass
    try:
        for key in [k for k in os.environ if k.startswith("SCHEMA_") and k not in environ]:
            del os.environ[key]
        os.environ.update(environ)
        if os.name == "posix":
            import resource

            ceiling = int(env("READER_MEMORY_MB", "1536")) * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
        from .readers import make_reader

        # 연산마다 원본은 하나다 — Reader 선택이 컨테이너를 보려면 source_ref가 필요하다(§3.2).
        reader = make_reader(root, provider, principal, payload.get("source_ref"))
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
    except _Terminated:
        outcome, error_code = "failed", "READER_STOPPED"
        completion = ("error", ("READER_STOPPED", "문서 읽기 프로세스가 종료되었습니다.", 422))
    except Problem as exc:
        outcome, error_code = "failed", exc.code
        completion = ("error", (exc.code, exc.message, exc.status))
    except MemoryError:
        outcome, error_code = "failed", "READER_MEMORY_LIMIT"
        completion = ("error", ("READER_MEMORY_LIMIT", "문서 읽기 메모리 한도를 초과했습니다.", 413))
    except Exception:
        # 제공자 예외의 파일 경로/자격 증명을 API 응답에 노출하지 않는다.
        outcome, error_code = "failed", "READER_FAILED"
        completion = (
            "error",
            ("READER_FAILED", "문서 읽기에 실패했습니다. 제공자 설정과 문서 형식을 확인하세요.", 422),
        )
    try:
        # 정리 구간에서는 SIGTERM을 무시한다 — 여기서 또 예외로 바뀌면 감사·삭제가 중간에 끊기고
        # 부모가 닫은 파이프에 쓰다 죽은 트레이스백만 stderr에 남는다(부모는 2초 뒤 SIGKILL을 보낸다).
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    except (ValueError, OSError, AttributeError):
        pass
    try:
        # 해제본부터 지운다 — 감사 줄의 temp_removed가 "실제로 지운 수"여야 한다.
        from .readers import release_sessions

        release_sessions()
    except Exception:
        pass
    try:
        counts = _audit_access(root, provider, principal, payload.get("source_ref"), operation, outcome, error_code)
        if counts:
            pipe.send(("drm", counts))
    except Exception:
        pass  # 감사 기록 실패가 읽기 결과를 바꾸지 않는다
    try:
        pipe.send(completion)
    except Exception:
        pass  # 부모가 이미 파이프를 닫았다(중단 경로)
    finally:
        pipe.close()


def _raise_terminated(signum, frame):
    raise _Terminated()


def _audit_access(root, provider, principal, source_ref, operation, outcome, error_code):
    """보호 문서 접근 한 줄을 남기고 `{unlocked, reused, failed}`를 돌려준다. 평문 문서면 None."""
    if not source_ref:
        return None
    from . import drm

    return drm.record_access(
        root,
        provider=provider,
        principal=principal,
        source_ref=source_ref,
        operation=operation,
        outcome=outcome,
        error_code=error_code,
        reader="local-xlsx" if provider == "local-xlsx" and not drm.sniff_source(root, source_ref)["protected"] else "drm",
    )


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
    done, audited, cut = False, False, None
    try:
        while not done:
            checkpoint()
            if time.monotonic() > deadline:
                cut = "READER_TIMEOUT"
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
                if kind == "drm":
                    audited = True
                    _add_drm(value)  # 이 작업이 친 보호 문서 해제 비용(§3.5(4))
                elif kind == "done":
                    done = True
                else:
                    yield value
            elif not process.is_alive():
                raise Problem("READER_STOPPED", "문서 읽기 프로세스가 종료되었습니다.", 422)
    except GeneratorExit:  # 소비자가 스트림을 중간에 닫았다
        cut = cut or "STREAM_CLOSED"
        raise
    except BaseException as exc:
        cut = cut or (exc.code if isinstance(exc, Problem) else type(exc).__name__)
        raise
    finally:
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)
        if not audited and not done:
            # 자식이 감사를 남기지 못하고 끊긴 경로(타임아웃·취소·스트림 중단). 부모가 보완 기록을 남긴다(§3.5(4)).
            _audit_cut(root, provider, principal, payload.get("source_ref"), operation, cut or "READER_STOPPED")


def _audit_cut(root, provider, principal, source_ref, operation, error_code):
    """자식이 죽어 감사를 남기지 못한 보호 문서 접근을 부모가 대신 남긴다. 평문·없는 파일은 아무것도 남기지 않는다."""
    if not source_ref:
        return
    try:
        from . import drm

        if not drm.sniff_source(root, source_ref)["protected"]:
            return
        drm.audit(
            root,
            principal=principal,
            provider=provider,
            source_ref=str(source_ref),
            operation=operation,
            container=drm.sniff_source(root, source_ref)["container"],
            reader="drm",
            outcome="failed",
            error_code=error_code,
            note="reader-process-terminated",
        )
    except Exception:
        pass


def reader_result(root, provider, principal, operation, payload, checkpoint=lambda: None):
    """단일 결과 연산(describe/match/match_specs/authorize/signature)을 격리 실행한다."""
    result = None
    for event in reader_events(root, provider, principal, operation, payload, checkpoint):
        result = event
    if result is None:
        raise Problem("READER_STOPPED", "문서 읽기 결과가 없습니다.", 422)
    return result


BRIEF_ROWS = 20  # 목록(GET /jobs) 응답에 그대로 싣는 배열 길이 상한(§6)


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
        self.thread = threading.Thread(target=self._loop, name="schema-worker", daemon=True)
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

    @staticmethod
    def brief_result(result):
        """목록(GET /jobs)용 축약 결과(§6): BRIEF_ROWS를 넘는 배열만 본문을 빼고 `<key>_count`로 대신한다.

        폴더 일괄 등록 결과의 documents[]는 최대 500행(수백 KB)이라 목록 한 페이지(50건)가 수 MB가 된다.
        짧은 배열(묶음 처리의 skipped[] 등)은 그대로 둬 화면이 곧바로 쓸 수 있게 한다. 전문은 GET /jobs/{id}가 준다."""
        if not isinstance(result, dict):
            return result
        brief = {}
        for key, value in result.items():
            if isinstance(value, list) and len(value) > BRIEF_ROWS:
                brief[f"{key}_count"] = len(value)
            else:
                brief[key] = value
        return brief

    @classmethod
    def public(cls, row, brief=False):
        result = json.loads(row["result_json"]) if row.get("result_json") else None
        return {
            **{k: row.get(k) for k in cls.PUBLIC},
            "result": cls.brief_result(result) if brief else result,
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
                drm_counts(reset=True)
                result = self.handler(
                    job["kind"], json.loads(job["payload_json"]), job["principal"], checkpoint
                )
                drm = drm_counts(reset=True)
                if drm and isinstance(result, dict):
                    result = {**result, "drm": drm}  # §3.5(4) 작업 내역에 해제 비용을 남긴다
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

                logging.getLogger(__name__).exception("job failed: %s", job["job_id"])
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
