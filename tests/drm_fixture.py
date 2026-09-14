"""테스트용 가짜 보호 문서 어댑터 — 실제 DRM SDK가 아니다.

앞에 붙인 봉투 바이트(OLE2 매직 + 표식)를 떼면 평문 xlsx가 나오는 파일을 "보호 문서"로 쓴다.
해제 호출은 파일에 한 줄씩 남긴다: Reader는 연산마다 별도 프로세스라 메모리 카운터로는 셀 수 없다.
"""

from __future__ import annotations

import os
from pathlib import Path

from schema import drm
from schema.db import Problem
from schema.readers import XlsxReader

ENVELOPE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"FAKE-DRM-ENVELOPE"
COUNTER_ENV = "SCHEMA_TEST_DRM_COUNTER"  # SCHEMA_ 접두여야 격리 프로세스로 전달된다(§3.2)
FAIL_ENV = "SCHEMA_TEST_DRM_FAIL"


def wrap(plain: Path, target: Path) -> Path:
    """평문 xlsx를 보호 문서 모양으로 감싼다."""
    target.write_bytes(ENVELOPE + Path(plain).read_bytes())
    return target


def unlock_count(counter=None) -> int:
    path = Path(counter or os.environ.get(COUNTER_ENV, ""))
    return len(path.read_text(encoding="utf-8").splitlines()) if path.is_file() else 0


def factory(*, root, provider, principal):
    """`SCHEMA_READER_FACTORY`가 가리키는 팩토리 계약(§3.5(5))."""
    return FakeDrmReader(Path(root), principal, provider)


class FakeDrmReader(XlsxReader):
    """§3.5(5) 권장 구현 그대로: 해제본을 한 번 만들고 나머지 연산은 XlsxReader에 맡긴다."""

    def __init__(self, root, principal, provider="fake-drm"):
        super().__init__(Path(root), principal)
        self.workspace, self.provider = Path(root), provider

    def authorize(self, source_ref, required="view"):
        capabilities = super().authorize(source_ref, required)
        capabilities["provider"] = self.provider
        return capabilities

    def plain_path(self, source_ref, token):
        origin = self.path(source_ref)

        def unlock(destination):
            counter = os.environ.get(COUNTER_ENV)
            if counter:
                with open(counter, "a", encoding="utf-8") as log:
                    log.write(f"{source_ref}\n")
            if os.environ.get(FAIL_ENV):
                raise Problem("DRM_OPEN_FAILED", "가짜 어댑터가 해제에 실패했습니다.", 422)
            destination.write_bytes(origin.read_bytes()[len(ENVELOPE) :])

        return drm.SESSIONS.acquire(
            workspace=self.workspace,
            provider=self.provider,
            source_ref=source_ref,
            expected_token=token,
            unlock=unlock,
        ).path
