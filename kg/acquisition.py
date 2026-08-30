"""문서 획득 게이트 — 잠긴 파일(암호화/DRM) 감지와 정식 해제 요청 추적 (KG2).

원칙: 시스템은 보호를 우회하지 않는다. 할 일은 세 가지뿐이다.
  1) 매직 바이트로 파일이 읽을 수 있는 상태인지 판별한다 (sniff)
  2) 잠긴 파일에 대한 정식 해제 요청을 기록하고 요청서 텍스트를 만들어 준다
  3) 해제본(같은 파일명, 읽기 가능)이 도착하면 자동 감지해 등록 흐름에 넘긴다

컨테이너 판별:
  xlsx_zip : PK\\x03\\x04     — 일반 xlsx, 그대로 처리 가능
  ole_cfb  : D0 CF 11 E0    — 표준 오피스 암호화(비밀번호), MIP/AIP 라벨,
                              구형 .xls, 일부 국산 DRM의 CFB 래퍼
  unknown  : 그 외           — 벤더 전용 DRM 컨테이너 등
"""
from __future__ import annotations

from pathlib import Path

from kg.store import KgStore, new_id, now_iso

_MAGIC_ZIP = b"PK\x03\x04"
_MAGIC_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_CONTAINER_LABEL = {
    "ole_cfb": "OLE/CFB — 암호화된 Office 문서 또는 DRM 래퍼",
    "unknown": "알 수 없는 컨테이너 — 벤더 전용 DRM 추정",
}


def sniff_container(path: Path) -> dict:
    """확장자가 아니라 실제 바이트로 판별한다. locked=True면 파싱 불가."""
    try:
        head = Path(path).open("rb").read(8)
    except OSError as e:
        return {"container": "unreadable", "locked": True, "detail": str(e)}
    if head.startswith(_MAGIC_ZIP):
        return {"container": "xlsx_zip", "locked": False}
    if head.startswith(_MAGIC_OLE):
        return {"container": "ole_cfb", "locked": True,
                "detail": _CONTAINER_LABEL["ole_cfb"]}
    return {"container": "unknown", "locked": True,
            "detail": _CONTAINER_LABEL["unknown"]}


def request_row(store: KgStore, filename: str):
    return store.conn.execute(
        "SELECT * FROM drm_request WHERE filename=?", (filename,)).fetchone()


def create_request(store: KgStore, raw_dir: Path, filename: str,
                   note: str = "") -> dict:
    """잠긴 파일에 대한 해제 요청을 기록한다 (파일당 1건, 재요청은 갱신)."""
    from src.common.hashing import sha256_file
    path = Path(raw_dir) / filename
    if not path.exists():
        raise FileNotFoundError(filename)
    sniff = sniff_container(path)
    if not sniff["locked"]:
        raise ValueError("이 파일은 잠겨 있지 않습니다 — 바로 등록할 수 있습니다")
    locked_hash = sha256_file(path)
    prev = request_row(store, filename)
    rid = prev["request_id"] if prev is not None else new_id("DRM")
    store.conn.execute(
        """INSERT INTO drm_request (request_id, filename, locked_hash, container,
             status, note, requested_at, updated_at)
           VALUES (?,?,?,?, 'REQUESTED', ?, ?, ?)
           ON CONFLICT(filename) DO UPDATE SET
             locked_hash=excluded.locked_hash, container=excluded.container,
             status='REQUESTED', note=excluded.note, released_at=NULL,
             requested_at=excluded.requested_at, updated_at=excluded.updated_at""",
        (rid, filename, locked_hash, sniff["container"], note,
         now_iso(), now_iso()))
    store.commit()
    return {"request_id": rid, "filename": filename,
            "request_text": build_request_text(rid, filename, locked_hash,
                                               sniff, note)}


def build_request_text(request_id: str, filename: str, locked_hash: str,
                       sniff: dict, note: str) -> str:
    """결재/그룹웨어에 붙여 넣을 정식 요청서 본문."""
    return "\n".join([
        "[DRM 해제 요청서]",
        f"요청 ID     : {request_id}",
        f"요청일      : {now_iso()}",
        "요청자      : (담당자 기입)",
        f"대상 파일   : {filename}",
        f"파일 SHA-256: {locked_hash}",
        f"컨테이너    : {sniff.get('detail') or sniff.get('container')}",
        "사용 목적   : Excel 데이터 통합 시스템(Fixed Domain KG) 적재·분석",
        f"사유        : {note or '(미기재)'}",
        "요청 내용   : 위 파일의 DRM 해제(또는 반출용 평문 사본 발급)를 요청합니다.",
        "             해제본을 data/raw 폴더에 같은 파일명으로 두면",
        "             시스템이 자동 감지해 등록 가능 상태로 전환합니다.",
    ])


def refresh_release_states(store: KgStore, raw_dir: Path) -> int:
    """REQUESTED 상태의 파일이 읽기 가능해졌으면 RELEASED로 전환한다.

    감지 기준은 '같은 파일명이 이제 열린다'이다 — 해제본 교체가 규약.
    """
    n = 0
    for r in store.conn.execute(
            "SELECT filename FROM drm_request WHERE status='REQUESTED'").fetchall():
        p = Path(raw_dir) / r["filename"]
        if p.exists() and not sniff_container(p)["locked"]:
            store.conn.execute(
                "UPDATE drm_request SET status='RELEASED', released_at=?, "
                "updated_at=? WHERE filename=?",
                (now_iso(), now_iso(), r["filename"]))
            n += 1
    if n:
        store.commit()
    return n


def mark_ingested(store: KgStore, filename: str) -> None:
    """등록 성공 후 호출 — 요청 이력을 완결 상태로 닫는다."""
    store.conn.execute(
        "UPDATE drm_request SET status='INGESTED', updated_at=? "
        "WHERE filename=? AND status IN ('REQUESTED','RELEASED')",
        (now_iso(), filename))


def list_requests(store: KgStore) -> list[dict]:
    return [dict(r) for r in store.conn.execute(
        "SELECT * FROM drm_request ORDER BY updated_at DESC")]
