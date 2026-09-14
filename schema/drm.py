"""보호 문서(DRM) 접근 — 컨테이너 판별·해제 세션·감사·Excel COM 참조 구현(계약 §3.5).

전제가 뒤집혔다: 평문 OOXML이 예외고 **보호 문서가 기본**이다. 확장자가 아니라 원본 앞 32바이트로 컨테이너를
판별하고(§3.5(1)), 보호 문서는 잠금으로 끝내지 않고 `SCHEMA_READER_FACTORY`가 가리키는 Reader에게 넘긴다(§3.5(2)).
넘길 Reader가 없을 때만 `DRM_READER_REQUIRED`가 남고, 그 문구는 **무엇을 설정해야 하는지** 말한다.

해제본은 작업 공간 밖의 0700 폴더에만 만들고(§3.5(3)) snapshot(= `change_token`)당 한 번만 해제한다 —
같은 snapshot의 describe·match·match_specs·extract·render는 그 파일을 다시 쓴다. 모든 접근은 감사에 남는다(§3.5(4)).
"""

from __future__ import annotations

import atexit
import errno
import hashlib
import importlib
import os
import posixpath
import shutil
import signal
import stat
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .db import Problem, dump
from .jobs import env
from .readers import XlsxReader

# ---------------------------------------------------------------- (1) 컨테이너 판별

HEAD_BYTES = 32  # 판별에 쓰는 앞부분 크기. 이보다 더 읽지 않는다(내용을 보지 않는다).
MAGIC_OOXML = b"PK"
MAGIC_OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MAGIC_ITEM_BYTES = 32  # SCHEMA_DRM_MAGIC 항목 하나의 최대 길이

_magic_cache: dict[str, list[dict]] = {}
_magic_warned: set[str] = set()


def parse_magics(raw=None, stream=None):
    """`SCHEMA_DRM_MAGIC` → `[{raw, bytes}]`.

    쉼표로 나눈 목록이고 항목마다 `hex:<16진>` · `ascii:<문자열>`이며 접두가 없으면 ASCII로 본다(§3.5(1)).
    빈 항목·잘못된 16진·32바이트 초과는 stderr로 한 번 알리고 무시한다(설정 오타로 판별이 조용히 바뀌지 않게)."""
    raw = env("DRM_MAGIC", "") if raw is None else raw
    cached = _magic_cache.get(raw)
    if cached is not None:
        return cached
    items, bad = [], []
    for part in raw.split(","):
        text = part.strip()
        if not text:
            continue
        kind, sep, body = text.partition(":")
        kind, body = (kind.lower(), body) if sep else ("ascii", text)
        if kind not in ("hex", "ascii"):
            kind, body = "ascii", text
        try:
            value = bytes.fromhex(body.replace(" ", "")) if kind == "hex" else body.encode("utf-8")
        except ValueError:
            bad.append(text)
            continue
        if not value or len(value) > MAGIC_ITEM_BYTES:
            bad.append(text)
            continue
        items.append({"raw": text, "bytes": value})
    if bad and raw not in _magic_warned:
        _magic_warned.add(raw)
        print(
            f"[경고] SCHEMA_DRM_MAGIC 항목 {len(bad)}개를 읽을 수 없어 무시합니다: {', '.join(bad)}. "
            "항목은 hex:<16진> 또는 ascii:<문자열>이며 32바이트 이하여야 합니다.",
            file=sys.stderr if stream is None else stream,
        )
    _magic_cache[raw] = items
    return items


def sniff_container(head: bytes, magics=None) -> dict:
    """앞부분 바이트 → `{container, protected, magic}`(§3.5(1) 표 순서 그대로).

    "평문으로 바로 열 수 있는가"만 말한다. 암호화된 OOXML도 OLE2 컨테이너라 매직만으로 구형 `.xls`와
    구분되지 않는다 — 둘 다 `ole2`이고 둘 다 보호 문서로 보아 Reader에게 넘긴다."""
    head = bytes(head or b"")
    for item in parse_magics() if magics is None else magics:
        if item["bytes"] and head.startswith(item["bytes"]):
            # 운영자 시그니처가 PK보다 먼저다: 평문처럼 보이는 래퍼를 운영자가 선언할 수 있어야 한다.
            return {"container": "vendor", "protected": True, "magic": item["raw"]}
    if head.startswith(MAGIC_OOXML):
        return {"container": "ooxml", "protected": False, "magic": None}
    if head.startswith(MAGIC_OLE2):
        return {"container": "ole2", "protected": True, "magic": None}
    return {"container": "unknown", "protected": True, "magic": None}


MISSING = {"container": "missing", "protected": False, "magic": None}


def sniff_path(path) -> dict:
    """파일 앞 32바이트만 읽어 판별한다.

    열리지 않는 파일은 `missing`이다 — 보호 문서가 아니라 **판정 불가**다. 읽을 수 있는데 아는 매직이 아니면
    `unknown`(= 보호 문서 취급)이고, 이 둘을 섞으면 지워진 평문 문서가 DRM 실패로 집계된다(§3.5(4))."""
    try:
        with open(path, "rb") as source:
            head = source.read(HEAD_BYTES)
    except OSError:
        return dict(MISSING)
    return sniff_container(head)


def source_path(root, source_ref):
    """`<root>/data/raw` 아래로만 해석한다(경로 탈출·심볼릭 링크 방어). 없으면 None."""
    raw = (Path(root) / "data/raw").resolve()
    try:
        path = (raw / str(source_ref)).resolve()
    except OSError:
        return None
    if not path.is_relative_to(raw) or not path.is_file():
        return None
    return path


def sniff_source(root, source_ref) -> dict:
    """등록된 원본 참조를 판별한다. 파일이 없으면 `missing`(보호 문서로 세지 않는다)."""
    path = source_path(root, source_ref)
    return sniff_path(path) if path else dict(MISSING)


def detect(path) -> str:
    """`"plain"`(평문 OOXML) 또는 `"protected"`. 편의 함수 — 세부는 `sniff_path`."""
    return "plain" if sniff_path(path)["container"] == "ooxml" else "protected"


READER_REQUIRED_MESSAGE = (
    "보호된 문서입니다. 서버에 보안 읽기 어댑터(SCHEMA_READER_FACTORY)를 설정하면 읽을 수 있습니다 "
    "— 설정 화면의 Reader 카드에서 연결 상태를 확인하세요."
)
READER_REQUIRED_XLS_MESSAGE = (
    "구형 .xls 형식이거나 보호된 문서입니다. .xlsx로 저장해 다시 등록하거나, "
    "보안 읽기 어댑터(SCHEMA_READER_FACTORY)를 설정하세요."
)


def reader_required(container="unknown", source_ref=""):
    """어댑터가 없을 때의 403. 문구는 잠겼다고만 말하지 않고 무엇을 설정해야 하는지 말한다(§3.5(2))."""
    legacy = container == "ole2" and str(source_ref or "").lower().endswith(".xls")
    return Problem(
        "DRM_READER_REQUIRED",
        READER_REQUIRED_XLS_MESSAGE if legacy else READER_REQUIRED_MESSAGE,
        403,
    )


# ---------------------------------------------------------------- (3) 해제본 임시 폴더


def _account() -> str:
    getuid = getattr(os, "getuid", None)
    return str(getuid()) if getuid else (os.environ.get("USERNAME") or "user")


def temp_dir(workspace=None, create=False) -> Path:
    """해제본 임시 폴더(`SCHEMA_DRM_TEMP_DIR`, 기본 `<OS 임시>/schema-drm-<uid>`).

    작업 공간 안을 가리키면 `DRM_TEMP_IN_WORKSPACE`로 멈춘다 — 해제본은 `<ws>`·`data/raw`·렌더 캐시·산출물
    어디에도 만들지 않는다(§3.5(3))."""
    configured = env("DRM_TEMP_DIR", "")
    folder = Path(configured).expanduser() if configured else Path(tempfile.gettempdir()) / f"schema-drm-{_account()}"
    folder = folder.absolute()
    if workspace is not None:
        root = Path(workspace).absolute()
        try:
            inside = folder.resolve().is_relative_to(root.resolve())
        except OSError:
            inside = str(folder).startswith(str(root))
        if inside:
            raise Problem(
                "DRM_TEMP_IN_WORKSPACE",
                "해제본 임시 폴더(SCHEMA_DRM_TEMP_DIR)가 작업 공간 안을 가리킵니다. 작업 공간 밖 경로로 바꾸세요.",
                500,
            )
    if create:
        _make_private(folder)
    return folder


def _make_private(folder: Path):
    """해제본 폴더를 **내 것으로** 만든다 — 남이 미리 만들어 둔 폴더·심볼릭 링크를 그대로 쓰지 않는다(§3.5(3)).

    `mkdir(exist_ok=True)`는 심볼릭 링크도 "이미 있는 디렉터리"로 보고 통과하고, 소유자가 아니면 `chmod`도 실패한다.
    그래서 0700으로 새로 만들고, 이미 있으면 `lstat`으로 (a) 링크가 아님 (b) 내 소유 (c) 남에게 열려 있지 않음을
    확인해 하나라도 어긋나면 `DRM_TEMP_UNSAFE`로 시작 자체를 막는다."""
    parent = folder.parent
    if parent != folder and not parent.is_dir():
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise Problem("DRM_TEMP_UNSAFE", f"해제본 임시 폴더의 상위 폴더를 만들 수 없습니다: {parent} ({exc.strerror}).", 500) from None
    try:
        os.mkdir(folder, 0o700)
        return
    except FileExistsError:
        pass
    except OSError as exc:
        raise Problem("DRM_TEMP_UNSAFE", f"해제본 임시 폴더를 만들 수 없습니다: {folder} ({exc.strerror}).", 500) from None
    _assert_private(folder)


def _assert_private(folder: Path):
    try:
        info = os.lstat(folder)
    except OSError as exc:
        raise Problem("DRM_TEMP_UNSAFE", f"해제본 임시 폴더를 확인할 수 없습니다: {folder} ({exc.strerror}).", 500) from None
    reason = None
    if stat.S_ISLNK(info.st_mode):
        reason = "심볼릭 링크입니다"
    elif not stat.S_ISDIR(info.st_mode):
        reason = "디렉터리가 아닙니다"
    elif getattr(os, "geteuid", None) and info.st_uid != os.geteuid():
        reason = "다른 사용자 소유입니다"
    elif info.st_mode & 0o077:
        try:
            os.chmod(folder, 0o700)
            if os.lstat(folder).st_mode & 0o077:
                reason = "다른 사용자에게 열려 있습니다"
        except OSError:
            reason = "다른 사용자에게 열려 있고 권한을 좁힐 수 없습니다"
    if reason:
        raise Problem(
            "DRM_TEMP_UNSAFE",
            f"해제본 임시 폴더가 안전하지 않습니다({reason}): {folder}. "
            "SCHEMA_DRM_TEMP_DIR을 이 서버 계정만 쓰는 빈 폴더로 바꾸세요.",
            500,
        )


def ttl_seconds() -> int:
    """마지막 사용 뒤 해제본을 남겨 두는 시간. 0이면 재사용 없이 연산이 끝나는 즉시 지운다(보안 우선 배치)."""
    try:
        return max(0, int(env("DRM_CACHE_TTL_SECONDS", "900")))
    except ValueError:
        return 900


def cache_mb() -> int:
    try:
        return max(1, int(env("DRM_CACHE_MB", "2048")))
    except ValueError:
        return 2048


def max_sessions() -> int:
    try:
        return max(1, int(env("DRM_CACHE_MAX_SESSIONS", "64")))
    except ValueError:
        return 64


def open_timeout() -> float:
    try:
        return max(1.0, float(env("DRM_OPEN_TIMEOUT_SECONDS", "60")))
    except ValueError:
        return 60.0


def session_name(provider, source_ref, expected_token) -> str:
    """세션 파일 이름 — 원본 이름·경로·사용자 이름을 담지 않는다(§3.5(3))."""
    key = f"{provider}|{source_ref}|{expected_token}".encode()
    return hashlib.sha256(key).hexdigest()[:32]


def lock_owner(lock_path: Path):
    """잠금 파일에 적힌 소유 PID. 읽을 수 없거나 형식이 다르면 None."""
    try:
        text = lock_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


def pid_alive(pid) -> bool:
    """그 PID가 아직 살아 있는가. 확인할 수 없으면 살아 있다고 본다(남의 잠금을 함부로 뺏지 않는다)."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (OSError, ValueError):
        return True
    return True


@contextmanager
def _exclusive(lock_path: Path, timeout: float):
    """같은 키를 동시에 열면 한 프로세스만 해제하고 나머지는 기다렸다 재사용한다(§3.5(3)).

    잠금 파일에는 소유 PID를 적는다. 기다리는 쪽은 **그 PID가 죽었을 때만** 잠금을 치운다 — 예전처럼 나이(만료 기준
    timeout×2)로만 판정하면 그 기준이 자기 대기 마감(timeout)보다 커서 죽은 프로세스의 잠금을 아무도 치우지 못했다.
    PID를 읽을 수 없는 옛 형식의 잠금만 나이로 판정한다(기준도 대기 마감보다 짧게).
    푸는 쪽은 **자기가 만든 잠금인지 확인한 뒤에만** 지운다(남의 잠금을 지워 상호 배제를 깨지 않게)."""
    deadline = time.monotonic() + timeout
    stale = min(timeout, 15.0)
    handle = None
    while handle is None:
        try:
            handle = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
            owner = lock_owner(lock_path)
            try:
                age = time.time() - lock_path.stat().st_mtime
            except OSError:
                continue  # 그 사이에 사라졌다 — 바로 다시 잡아 본다
            if (owner is not None and not pid_alive(owner)) or (owner is None and age > stale):
                lock_path.unlink(missing_ok=True)
                continue
            if time.monotonic() > deadline:
                raise Problem("DRM_OPEN_TIMEOUT", "다른 요청의 보호 문서 해제를 기다리다 제한 시간을 넘었습니다.", 408) from None
            time.sleep(0.05)
    try:
        os.write(handle, str(os.getpid()).encode())
        mine = os.fstat(handle).st_ino
    except OSError:
        mine = None
    try:
        yield
    finally:
        os.close(handle)
        try:  # 내가 만든 그 파일일 때만 지운다(같은 이름의 남의 잠금을 지우지 않게)
            if mine is None or os.stat(lock_path).st_ino == mine:
                lock_path.unlink(missing_ok=True)
        except OSError:
            pass


class DecryptedSession:
    """해제본 하나. `path`는 평문 워크북 경로이고 작업 공간 밖에 있다."""

    __slots__ = ("key", "path", "reused", "unlock_ms", "ephemeral", "_released")

    def __init__(self, key, path, reused, unlock_ms, ephemeral):
        self.key, self.path, self.reused, self.unlock_ms, self.ephemeral = key, Path(path), reused, unlock_ms, ephemeral
        self._released = False

    def release(self):
        """TTL 0(재사용 안 함)이면 즉시 지운다. 그 밖에는 다음 연산이 다시 쓰도록 남긴다."""
        if self._released:
            return False
        self._released = True
        if not self.ephemeral:
            return False
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            return False
        return True


class SessionCache:
    """`(provider, source_ref, expected_token)`당 해제 1회. 키의 토큰이 `document_snapshot.change_token`이므로 snapshot당 1회다.

    Reader는 연산마다 별도 프로세스에서 돌기 때문에(§3.2 격리) 재사용은 메모리가 아니라 **파일**로 이뤄진다:
    같은 키의 세션 파일이 임시 폴더에 살아 있으면 다음 프로세스가 해제 없이 그 파일을 연다."""

    def __init__(self):
        self.unlocked = self.reused = self.failed = self.released = 0
        self.last_unlock_ms = None
        self._active: list[DecryptedSession] = []
        self._lock = threading.Lock()

    # -- 통계(감사·작업 결과용) ---------------------------------------------------
    def counts(self):
        return {"unlocked": self.unlocked, "reused": self.reused, "failed": self.failed}

    def reset(self):
        self.unlocked = self.reused = self.failed = self.released = 0
        self.last_unlock_ms = None

    # -- 세션 ---------------------------------------------------------------------
    def acquire(self, *, workspace, provider, source_ref, expected_token, unlock) -> DecryptedSession:
        """평문 파일을 얻는다. `unlock(destination: Path)`은 평문을 그 경로에 쓰는 호출자(어댑터)의 함수다."""
        folder = temp_dir(workspace, create=True)
        ttl, name = ttl_seconds(), session_name(provider, source_ref, expected_token)
        target = folder / f"{name}.xlsx"
        if ttl and self._fresh(target, ttl):
            self.reused += 1
            return self._track(DecryptedSession(name, target, True, None, False))
        with _exclusive(folder / f"{name}.lock", open_timeout()):
            if ttl and self._fresh(target, ttl):
                self.reused += 1
                return self._track(DecryptedSession(name, target, True, None, False))
            part = folder / f"{name}.{os.getpid()}.part"
            started = time.monotonic()
            try:
                part.unlink(missing_ok=True)
                unlock(part)
                if not part.is_file() or not part.stat().st_size:
                    raise Problem("DRM_OPEN_FAILED", "보호 문서 해제 결과가 비어 있습니다.", 422)
                try:
                    part.chmod(0o600)
                except OSError:
                    pass
                # TTL 0(재사용 안 함)이어도 확장자는 .xlsx여야 한다 — openpyxl이 확장자로 형식을 먼저 거른다.
                final = target if ttl else folder / f"{name}.{os.getpid()}.{self.unlocked}.tmp.xlsx"
                os.replace(part, final)  # 부분 파일을 다른 프로세스가 읽지 않게 완성 뒤에만 이름을 붙인다
            except Exception:
                part.unlink(missing_ok=True)
                self.failed += 1
                raise
            self.unlocked += 1
            self.last_unlock_ms = round((time.monotonic() - started) * 1000)
        self.prune(folder, keep=final)
        return self._track(DecryptedSession(name, final, False, self.last_unlock_ms, not ttl))

    def _track(self, session):
        with self._lock:
            self._active.append(session)
        return session

    @staticmethod
    def _fresh(path: Path, ttl: int) -> bool:
        try:
            stat = path.stat()
        except OSError:
            return False
        if not stat.st_size or time.time() - stat.st_mtime > ttl:
            return False
        try:
            os.utime(path)  # 수명은 "마지막 사용 뒤" 기준이다
        except OSError:
            pass
        return True

    # -- 정리 ---------------------------------------------------------------------
    def drop(self, provider, source_ref, expected_token, workspace=None) -> bool:
        """한 세션을 즉시 지운다(새 snapshot·drm-probe). 이미 없으면 True."""
        try:
            folder = temp_dir(workspace)
        except Problem:
            return False
        path = folder / f"{session_name(provider, source_ref, expected_token)}.xlsx"
        try:
            path.unlink(missing_ok=True)
        except OSError:
            return False
        return not path.exists()

    def prune(self, folder=None, keep=None):
        """만료·부분 파일을 치우고, 총량(MB)과 세션 수 상한을 넘으면 오래된 것부터 지운다(`keep`은 남긴다)."""
        try:
            folder = Path(folder) if folder is not None else temp_dir()
            entries = sorted(folder.glob("*"), key=lambda p: p.name)
        except (OSError, Problem):
            return
        ttl, sessions = ttl_seconds(), []
        for path in entries:
            try:
                info = path.stat()
                age = time.time() - info.st_mtime
                if path.name.endswith(".tmp.xlsx") or path.suffix in (".part", ".lock"):
                    # 재사용하지 않는 해제본(TTL 0)과 부분·잠금 파일: 만든 프로세스가 끝났을 때만 치운다.
                    # 이름에 PID가 있으면 그 PID로, 없으면(잠금 파일) 안의 PID로 판정하고, 둘 다 없을 때만 나이로 본다.
                    if not pid_alive(_owner_of(path)) or age > max(open_timeout(), 60):
                        path.unlink(missing_ok=True)
                    continue
                if path.suffix != ".xlsx":
                    continue
                if ttl and age > ttl:
                    path.unlink(missing_ok=True)
                    continue
            except OSError:
                continue  # 다른 프로세스가 그 사이에 치웠다 — 해제 자체를 실패시키지 않는다
            sessions.append((info.st_mtime, info.st_size, path))
        sessions.sort()
        total, limit, cap = sum(s[1] for s in sessions), cache_mb() * 1024 * 1024, max_sessions()
        while sessions and (total > limit or len(sessions) > cap):
            _, size, path = sessions.pop(0)
            if keep is not None and path == Path(keep):
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError:
                continue
            total -= size

    def release_all(self):
        """**연산 하나가 끝나는 자리**에서 부른다: TTL 0 세션과 이 프로세스가 남긴 부분 파일을 지운다.

        재사용 가능한 세션(TTL > 0)은 남긴다 — Reader는 연산마다 프로세스가 바뀌므로 여기서 지우면 snapshot당
        1회 해제가 깨진다. `atexit`에만 맡기지 않는다: forkserver 자식은 `os._exit()`로 끝나고 SIGTERM으로
        죽는 경로(타임아웃·취소·스트림 중단)도 atexit을 돌리지 않아 평문이 그대로 남았다."""
        with self._lock:
            active, self._active = self._active, []
        for session in active:
            if session.release():
                self.released += 1
        try:
            folder = temp_dir()
        except Problem:
            return
        for path in folder.glob(f"*.{os.getpid()}.*"):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


SESSIONS = SessionCache()
atexit.register(SESSIONS.release_all)


def _owner_of(path: Path):
    """그 파일을 만든 프로세스의 PID. 이름(`<키>.<pid>.part`·`<키>.<pid>.<n>.tmp.xlsx`)에서 먼저 찾고,
    잠금 파일은 내용에서 읽는다. 알 수 없으면 None."""
    if path.suffix == ".lock":
        return lock_owner(path)
    parts = path.name.split(".")
    for part in parts[1:]:
        if part.isdigit():
            return int(part)
    return None


def purge_all(workspace=None) -> int:
    """임시 폴더에서 **아무도 쓰고 있지 않은** 항목을 지운다(서버 시작 시). 지운 파일 수.

    임시 폴더는 메인 서버·렌더 서버·CLI가 함께 쓴다. 통째로 비우면 다른 프로세스가 진행 중인 해제의 부분 파일과
    잠금 파일(`com.lock` 포함)까지 지워 상호 배제가 깨진다 — 살아 있는 PID가 남긴 항목은 건드리지 않는다."""
    try:
        folder = temp_dir(workspace)
    except Problem:
        return 0
    removed = 0
    if not folder.is_dir():
        return 0
    for path in folder.iterdir():
        try:
            if pid_alive(_owner_of(path)):
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
            removed += 1
        except OSError:
            pass
    return removed


# ---------------------------------------------------------------- (4) 감사


def audit(workspace, **record) -> bool:
    """보호 문서 접근 한 건을 `<ws>/data/audit/drm-<YYYYMMDD>.jsonl`에 한 줄 남긴다(성공·실패 모두).

    해제본 경로·자격 증명·파일 내용은 쓰지 않는다(§3.5(4))."""
    try:
        folder = Path(workspace) / "data/audit"
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc)
        path = folder / f"drm-{stamp:%Y%m%d}.jsonl"
        line = dump({"at": stamp.isoformat(timespec="milliseconds"), **record})
        with open(os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600), "w", encoding="utf-8") as out:
            out.write(line + "\n")
        return True
    except (OSError, ValueError, TypeError):
        return False  # 감사 기록 실패가 읽기 자체를 막지는 않는다(호출자가 이미 오류를 올린다)


def record_access(workspace, *, provider, principal, source_ref, operation, outcome, error_code=None, reader=None, snapshot_id=None):
    """§3.5(4) 한 줄을 남기고 해제 비용 `{unlocked, reused, failed}`를 돌려준다. 평문 문서면 아무것도 남기지 않는다.

    `unlocked` 새로 해제한 횟수 · `reused` 살아 있는 해제본을 다시 쓴 횟수 ·
    `failed` 보호 문서 접근이 실패한 횟수(해제 실패와 어댑터 없음을 함께 센다 — 운영자가 볼 값은 "몇 건을 못 열었나"다)."""
    sniff = sniff_source(workspace, source_ref)
    counts = dict(SESSIONS.counts())
    # 파일을 열 수 없는 경우(`missing`)는 보호 문서가 아니다 — 지워진 평문 문서·권한 오류·마운트 끊김을
    # DRM 실패로 세면 "못 연 보호 문서 건수"를 믿을 수 없게 된다(§3.5(4)).
    if not sniff["protected"] and not any(counts.values()):
        return None
    if sniff["protected"] and outcome == "failed":
        counts["failed"] = max(counts["failed"], 1)
    audit(
        workspace,
        principal=principal,
        provider=provider,
        source_ref=str(source_ref),
        snapshot_id=snapshot_id,
        operation=operation,
        container=sniff["container"],
        magic=sniff["magic"],
        reader=reader,
        unlock="new" if counts["unlocked"] else ("reused" if counts["reused"] else "none"),
        unlock_ms=SESSIONS.last_unlock_ms,
        outcome=outcome,
        error_code=error_code,
        # 설정값이 아니라 이 연산이 실제로 지운 해제본 수다(0이면 남겨 재사용한다는 뜻).
        temp_removed=SESSIONS.released,
    )
    return counts


# ---------------------------------------------------------------- (5) 어댑터 선택


def factory_setting() -> str:
    return env("READER_FACTORY", "")


def available() -> bool:
    """보안 읽기 어댑터가 연결돼 있는가(값의 모양만 본다 — import는 실제 사용 시점에)."""
    factory = factory_setting()
    return bool(factory) and ":" in factory


def load_factory():
    """`<모듈>:<함수>`를 불러온다. 값은 서버 설정에서만 읽는다(요청 본문에서 받지 않는다)."""
    factory = factory_setting()
    if not available():
        raise reader_required()
    module, function = factory.split(":", 1)
    try:
        return getattr(importlib.import_module(module), function)
    except (ImportError, AttributeError) as exc:
        raise Problem(
            "DRM_READER_REQUIRED",
            f"보안 읽기 어댑터(SCHEMA_READER_FACTORY={factory})를 불러오지 못했습니다: {type(exc).__name__}. "
            "설정 화면의 Reader 카드에서 연결 상태를 확인하세요.",
            403,
        ) from None


def settings_snapshot(workspace=None) -> dict:
    """`GET /settings`의 `reader.drm` 블록(§6 B). 절대 경로 대신 작업 공간 안/밖 판정만 노출한다."""
    try:
        temp_dir(workspace)
        temp_ok = True
    except Problem:
        temp_ok = False
    return {
        "available": available(),
        "temp_dir_ok": temp_ok,
        "ttl_seconds": ttl_seconds(),
        "cache_mb": cache_mb(),
        # 계약 §6은 개수(`magics: n`)다 — 화면은 "등록된 보호 문서 시그니처 N개"로 쓴다.
        # 원문 목록이 필요하면 `python -m schema drm-probe --json`이 돌려준다.
        "magics": len(parse_magics()),
    }


# ---------------------------------------------------------------- (6) 윈도우 Excel COM 참조 구현

COM_UNSUPPORTED = (
    "윈도우 Excel COM 참조 구현은 Windows + Excel + 대화형 로그인 세션에서만 동작합니다 "
    "(pywin32 필요). 다른 환경에서는 벤더 복호화 API 어댑터를 SCHEMA_READER_FACTORY에 연결하세요."
)
XL_OPEN_XML_WORKBOOK = 51  # xlOpenXMLWorkbook


def _com_lock_path() -> Path:
    configured = env("DRM_COM_LOCK", "")
    return Path(configured) if configured else temp_dir(create=True) / "com.lock"


def excel_com_unlock(origin: Path, destination: Path):
    """Open → SaveAs(51) → (막히면) 시트 Copy → SaveAs → Quit. 이전 세대 구현의 검증된 경로다(§3.5(6)).

    COM은 지연·선택 import다 — 비윈도우에서 이 모듈을 import하는 것만으로 죽지 않는다. 실제로 부르면 명확한 오류."""
    if os.name != "nt":
        raise Problem("DRM_OPEN_FAILED", COM_UNSUPPORTED, 422)
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        raise Problem("DRM_OPEN_FAILED", COM_UNSUPPORTED, 422) from None

    try:
        pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
    except Exception:
        pass
    excel = win32com.client.DispatchEx("Excel.Application")
    pid = _excel_pid(excel)
    try:
        for name, value in (("Visible", False), ("DisplayAlerts", False), ("EnableEvents", False), ("AskToUpdateLinks", False)):
            try:
                setattr(excel, name, value)
            except Exception:
                pass
        book = excel.Workbooks.Open(str(Path(origin).resolve()), 0, True)  # UpdateLinks=0, ReadOnly=True
        try:
            try:
                # 워크북 전체를 한 번에 저장한다 — 시트 단위로 나누어 열지 않는다(snapshot당 1회 해제).
                book.SaveAs(str(destination), XL_OPEN_XML_WORKBOOK)
                return
            except Exception as exc:
                blocked = str(exc).strip()[:160] or type(exc).__name__
            # 정책이 다른 이름 저장을 막으면 시트 복사로 내려간다(옛 구현의 폴백 경로).
            try:
                book.Sheets(1).Copy()
                copied = excel.ActiveWorkbook
                try:
                    copied.SaveAs(str(destination), XL_OPEN_XML_WORKBOOK)
                finally:
                    copied.Close(SaveChanges=False)
                return
            except Exception:
                raise Problem(
                    "DRM_EXPORT_BLOCKED",
                    f"보호 정책이 평문 저장을 막았습니다({blocked}). 값만 긁어 원본 충실인 척 보여주지 않습니다.",
                    422,
                ) from None
        finally:
            try:
                book.Close(SaveChanges=False)
            except Exception:
                pass
    finally:
        try:
            excel.Quit()
        except Exception:
            pass
        del excel
        _kill_excel(pid)


def _excel_pid(excel):
    try:
        import win32process

        return win32process.GetWindowThreadProcessId(excel.Hwnd)[1]
    except Exception:
        return None


def _kill_excel(pid):
    """Quit()으로 사라지지 않은 전용 인스턴스는 PID로 정리한다(대화형 세션에 창이 쌓이지 않게)."""
    if not pid:
        return
    try:
        import subprocess

        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, check=False, timeout=10)
    except Exception:
        pass


def excel_com_reader(*, root, provider, principal):
    """`SCHEMA_READER_FACTORY=schema.drm:excel_com_reader`로 연결하는 참조 어댑터 팩토리(§3.5(5))."""
    return ExcelComReader(Path(root), principal, provider)


class ExcelComReader(XlsxReader):
    """윈도우 Excel COM 참조 구현. 해제본을 한 번 만드는 `plain_path`만 덮어쓰고 **모든 읽기는 `XlsxReader` 그대로**다.

    기본으로 연결되지 않는다 — 운영자가 `SCHEMA_READER_FACTORY`를 이 모듈로 가리켰을 때만 쓰인다.
    COM 구간은 프로세스 간 잠금 파일(`SCHEMA_DRM_COM_LOCK`)로 동시 실행 1로 직렬화한다."""

    def __init__(self, root, principal, provider="protected-excel-com", unlock=excel_com_unlock):
        super().__init__(Path(root), principal)
        self.workspace, self.provider, self._unlock = Path(root), provider, unlock

    def authorize(self, source_ref, required="view"):
        """COM 경로에는 별도 권한 API가 없다 — Excel이 문서를 열 수 있으면 열람·추출·렌더가 모두 가능하다."""
        return {
            **super().authorize(source_ref, required),
            "provider": self.provider,
            "policy_revision": env("READER_REVISION", "excel-com-reference"),
            "can_cache_derivative": bool(ttl_seconds()),
        }

    def plain_path(self, source_ref, token):
        """snapshot당 한 번만 해제하고 같은 세션 파일을 재사용한다."""
        origin = self.path(source_ref)

        def unlock(destination):
            with _exclusive(_com_lock_path(), open_timeout()):
                _with_timeout(self._unlock, open_timeout(), origin, destination)

        return SESSIONS.acquire(
            workspace=self.workspace,
            provider=self.provider,
            source_ref=source_ref,
            expected_token=token,
            unlock=unlock,
        ).path


def _with_timeout(function, seconds, *args):
    """COM 호출은 중단할 수 없다 — 별도 스레드에서 돌리고 제한 시간을 넘으면 DRM_OPEN_TIMEOUT을 올린다."""
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(function, *args)
        try:
            return future.result(timeout=seconds)
        except FutureTimeout:
            raise Problem("DRM_OPEN_TIMEOUT", f"보호 문서 해제가 {int(seconds)}초를 넘겨 중단했습니다.", 408) from None
    finally:
        pool.shutdown(wait=False)


# ---------------------------------------------------------------- (7) 점검 명령


def probe(workspace, source=None, directory=None, unlock=False, principal="local-user", provider="local-xlsx"):
    """`python -m schema drm-probe`의 본체(§3.5(7)). 원본 내용·셀 값·자격 증명·해제본 경로를 출력하지 않는다."""
    workspace = Path(workspace).absolute()
    factory = factory_setting()
    reader_info = {"factory": factory or None, "revision": env("READER_REVISION", "unversioned-operator-adapter"), "available": available(), "error": None}
    if available():
        try:
            load_factory()
        except Problem as exc:
            reader_info["available"] = False
            reader_info["error"] = {"code": exc.code, "message": exc.message}
    try:
        folder = temp_dir(workspace)
        inside, temp_error = False, None
    except Problem as exc:
        folder, inside, temp_error = temp_dir(), True, exc
    sources = [_probe_source(workspace, ref, unlock, principal, provider, reader_info) for ref in _probe_refs(workspace, source, directory)]
    # 임시 폴더 상태는 해제를 마친 뒤에 본다(--unlock이 폴더를 만든다 — "없음"이라고 잘못 말하지 않게).
    temp_info = {
        "directory": str(folder),
        "exists": folder.is_dir(),
        "writable": os.access(folder, os.W_OK) if folder.is_dir() else os.access(folder.parent, os.W_OK),
        "mode": f"{folder.stat().st_mode & 0o777:04o}" if folder.is_dir() else None,
        "inside_workspace": inside,
        "ttl_seconds": ttl_seconds(),
        "cache_mb": cache_mb(),
    }
    summary = {
        "checked": len(sources),
        "plain": sum(1 for s in sources if not s["protected"]),
        "protected": sum(1 for s in sources if s["protected"]),
        "unlockable": sum(1 for s in sources if s["protected"] and s["status"] == "ok"),
        "blocked": sum(1 for s in sources if s["status"] != "ok"),
    }
    report = {
        "reader": reader_info,
        "temp": temp_info,
        "magics": [{"raw": m["raw"], "bytes_hex": m["bytes"].hex()} for m in parse_magics()],
        "sources": sources,
        "summary": summary,
    }
    if temp_error is not None:
        report["temp"]["error"] = {"code": temp_error.code, "message": temp_error.message}
    return report


def _probe_refs(workspace, source, directory):
    if source:
        return [posixpath.normpath(str(source).replace("\\", "/"))]
    from .service import Service  # §4.1.1 스캔 규칙(재귀·심볼릭 링크 제외·'.' 폴더 제외)을 그대로 쓴다

    service = Service(workspace)
    try:
        return [item["source_ref"] for item in service._scan_files(directory or "")["files"]]
    except Problem:
        return []
    finally:
        service.close()


def _probe_source(workspace, source_ref, unlock, principal, provider, reader_info):
    path = source_path(workspace, source_ref)
    row = {"source_ref": source_ref, "container": None, "protected": True, "magic": None, "reader": None, "status": "failed"}
    if path is None:
        row["error_code"] = "SOURCE_NOT_FOUND"
        return row
    row.update(sniff_path(path))
    if not row["protected"]:
        row.update(reader="local-xlsx", status="ok")
        return row
    if not reader_info["available"]:
        row.update(reader=None, status="reader_required", error_code="DRM_READER_REQUIRED")
        return row
    row["reader"] = "drm"
    row["status"] = "ok"
    if not unlock:
        return row
    from .readers import make_reader

    SESSIONS.reset()
    try:
        reader = make_reader(workspace, provider, principal, source_ref)
        described = reader.describe(source_ref)
        row["unlock_ms"] = SESSIONS.last_unlock_ms
        row["sheet_count"] = len(described.get("sheets") or [])  # 시트 이름은 출력하지 않는다(원본 내용)
        row["temp_removed"] = SESSIONS.drop(provider, source_ref, described.get("token"), workspace)
    except Problem as exc:
        row.update(status="failed", error_code=exc.code)
    except Exception as exc:
        row.update(status="failed", error_code=type(exc).__name__)
    return row


PROBE_STATUS_TEXT = {"ok": "읽을 수 있음", "reader_required": "어댑터 없음", "failed": "실패"}


def probe_lines(report) -> list[str]:
    """`--json` 없이 쓰는 한국어 표. 같은 내용만 담는다."""
    reader, temp, summary = report["reader"], report["temp"], report["summary"]
    lines = [
        f"보안 읽기 어댑터: {reader['factory'] or '연결 안 됨'} ({'연결됨' if reader['available'] else '연결 안 됨'}) · 버전 {reader['revision']}",
    ]
    if reader["error"]:
        lines.append(f"  어댑터 오류: {reader['error']['code']} — {reader['error']['message']}")
    lines.append(
        f"해제본 임시 폴더: {temp['directory']} · {'있음' if temp['exists'] else '없음'}"
        f" · {'쓰기 가능' if temp['writable'] else '쓰기 불가'} · 권한 {temp['mode'] or '-'}"
        f" · {'작업 공간 안(위험)' if temp['inside_workspace'] else '작업 공간 밖(정상)'}"
        f" · 유지 {temp['ttl_seconds']}초 · 상한 {temp['cache_mb']}MB"
    )
    lines.append(f"등록된 보호 문서 시그니처: {len(report['magics'])}개" + (f" ({', '.join(m['raw'] for m in report['magics'])})" if report["magics"] else ""))
    for row in report["sources"]:
        detail = [row["container"] or "?", "보호" if row["protected"] else "평문", f"Reader {row['reader'] or '-'}", PROBE_STATUS_TEXT.get(row["status"], row["status"])]
        if row.get("error_code"):
            detail.append(row["error_code"])
        if row.get("unlock_ms") is not None:
            detail.append(f"해제 {row['unlock_ms']}ms")
        if row.get("sheet_count") is not None:
            detail.append(f"시트 {row['sheet_count']}개")
        if row.get("temp_removed") is not None:
            detail.append("임시 파일 삭제됨" if row["temp_removed"] else "임시 파일 남음")
        lines.append(f"  {row['source_ref']}: " + " · ".join(detail))
    lines.append(
        f"합계: 검사 {summary['checked']}건 · 평문 {summary['plain']} · 보호 {summary['protected']}"
        f" · 읽기 가능 {summary['unlockable']} · 막힘 {summary['blocked']}"
    )
    return lines


def probe_exit_code(report) -> int:
    """0 전부 ok · 1 해제 실패 · 2 어댑터 설정 없음(둘 다면 실패가 앞선다)."""
    states = {row["status"] for row in report["sources"]}
    if "failed" in states:
        return 1
    if "reader_required" in states:
        return 2
    return 0
