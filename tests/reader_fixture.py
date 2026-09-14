"""DRM SDK가 아닌 계약 테스트용 제공자. 원본 복사/복호화/저장은 구현하지 않는다."""

from schema.db import Problem
from schema.readers import XlsxReader


def factory(root, provider, principal):
    """`SCHEMA_READER_FACTORY`가 가리키는 factory 계약(root/provider/principal 키워드 호출)."""

    class Revocable(XlsxReader):
        def authorize(self, source_ref, required="view"):
            if (root / "revoked").exists():
                raise Problem("ACCESS_DENIED", "추출값의 원본 권한이 철회되었습니다.", 403)
            return super().authorize(source_ref, required)

    return Revocable(root, principal)
