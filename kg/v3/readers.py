"""v3 Reader 계약(§3.2). `XlsxReader`는 v2를 상속해 region/area/_check/describe/signature를 재사용하고
`extract`를 v3 엔진으로 바꾸며 `match`·`match_specs`·`render`를 더한다. 경로는 Reader 안에서만 해석한다."""

from __future__ import annotations

import importlib
from pathlib import Path

from openpyxl import load_workbook

from kg.v2.db import Problem as V2Problem
from kg.v2.readers import XlsxReader as V2XlsxReader
from kg.v2.readers import file_hash  # noqa: F401  (v2 계약 테스트·서비스가 같은 이름을 쓴다)

from . import engine
from .db import Problem
from .jobs import env


def make_reader(root, provider, principal):
    if provider == "local-xlsx":
        return XlsxReader(Path(root), principal)
    factory = env("READER_FACTORY", "")
    if not factory or ":" not in factory:
        raise Problem("DRM_READER_REQUIRED", "이 문서의 보안 읽기 어댑터가 연결되지 않았습니다.", 403)
    module, function = factory.split(":", 1)
    # factory는 서버 설정만 읽는다. 요청 본문에서 모듈/함수 이름을 받지 않는다.
    return getattr(importlib.import_module(module), function)(root=Path(root), provider=provider, principal=principal)


def _sheets_of(wb):
    return [{"name": ws.title, "ordinal": n} for n, ws in enumerate(wb.worksheets)]


class XlsxReader(V2XlsxReader):
    def _check(self, source_ref, expected_token=None):
        try:
            return super()._check(source_ref, expected_token)
        except V2Problem as exc:
            # v2 Problem은 별개 클래스라 v3 서비스/격리 프로세스가 잡지 못한다.
            raise Problem(exc.code, exc.message, exc.status) from None

    def authorize(self, source_ref, required="view"):
        try:
            return super().authorize(source_ref, required)
        except V2Problem as exc:
            raise Problem(exc.code, exc.message, exc.status) from None

    def describe(self, source_ref, profiles=()):
        """v2 describe 결과 + (profiles가 있으면 같은 프로세스에서) matches[]."""
        try:
            result = super().describe(source_ref)
        except V2Problem as exc:
            raise Problem(exc.code, exc.message, exc.status) from None
        if profiles:
            path, token = self._check(source_ref, result["token"])
            result["matches"] = self._matches(path, profiles)
            self._check(source_ref, token)
        return result

    @staticmethod
    def _matches(path, profiles):
        wb = load_workbook(path, data_only=True, keep_links=False)
        try:
            sheets = _sheets_of(wb)
            out = []
            for profile in profiles:
                item = {"profile_id": profile.get("profile_id"), "profile_rev": profile.get("profile_rev")}
                try:
                    item.update(
                        engine.match_profile(
                            profile["canonical"], wb, sheets, profile.get("reference"), profile.get("profile_rev")
                        )
                    )
                except Problem as exc:
                    item.update(
                        bindings={},
                        compatibility="incompatible",
                        match_signature=None,
                        match_signature_json=None,
                        missing=["*"],
                        resolved={},
                        error=exc.code,
                    )
                out.append(item)
            return out
        finally:
            wb.close()

    def match(self, source_ref, expected_token, profiles):
        path, token = self._check(source_ref, expected_token)
        matches = self._matches(path, profiles)
        self._check(source_ref, token)
        return matches

    def match_specs(self, source_ref, expected_token, specs, bindings_hint):
        path, token = self._check(source_ref, expected_token)
        wb = load_workbook(path, data_only=True, keep_links=False)
        try:
            result = engine.match_specs(specs, wb, _sheets_of(wb), bindings_hint)
        finally:
            wb.close()
        self._check(source_ref, token)
        return result

    def extract(self, source_ref, expected_token, specs, bindings):
        path, token = self._check(source_ref, expected_token)
        raw = load_workbook(path, data_only=False, keep_links=False)
        cached = load_workbook(path, data_only=True, keep_links=False)
        try:
            yield from engine.extract(raw, cached, bindings, specs)
        finally:
            raw.close()
            cached.close()
        self._check(source_ref, token)
        yield {"type": "verified", "token": token}

    def render(self, source_ref, expected_token, sheet_name, r1=1, c1=1, rows=2000, cols=200):
        path, token = self._check(source_ref, expected_token)
        # 렌더러는 별도 모듈(kg/v3/render/renderer.py)이며 여기서 경로를 넘긴다(호출자는 경로를 모른다).
        from .render.renderer import render_events

        yield from render_events(path, sheet_name, token, r1, c1, rows, cols)
        self._check(source_ref, token)
        yield {"type": "verified", "token": token}
