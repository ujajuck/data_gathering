"""프론트 단일화 가드 — React(frontend/)가 유일한 웹 UI다.

바닐라 web_kg는 React 포트 완료 후 제거됐다(2026-09). 이 테스트는
병렬 프론트가 되살아나거나 4탭 구조가 무너지는 회귀를 막는다.
"""
from __future__ import annotations

from tests.conftest import REPO_ROOT


def test_react_frontend_is_the_only_frontend():
    assert not (REPO_ROOT / "kg" / "web_kg").exists(), \
        "web_kg는 제거됐다 — 프론트는 frontend/ 하나만 유지한다"
    app_tsx = (REPO_ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")
    for text in ("1. 파일 분석", "2. 개념 탐색", "3. 원본 데이터", "4. 통합 DB",
                 "5. 템플릿 관리"):
        assert text in app_tsx
    for screen in ("FilesScreen", "KgScreen", "SourceScreen", "DbScreen",
                   "TemplatesScreen"):
        assert (REPO_ROOT / "frontend" / "src" / "screens" / f"{screen}.tsx").exists()


def test_core_features_live_inside_the_four_tab_flow():
    src_dir = REPO_ROOT / "frontend" / "src"
    read = lambda p: (src_dir / p).read_text(encoding="utf-8")  # noqa: E731
    source = read("screens/SourceScreen.tsx")
    inspector = read("screens/source/InspectorPanel.tsx")
    dkg = read("screens/kg/DkgDetailPanel.tsx")
    assert "Semantic Overlay" in source and "PDF Preview" in source
    assert "저하 렌더" in source                     # degraded 경고 배너
    assert "추출된 키 → 값" in inspector
    assert "Template Source:" in inspector
    assert "templateGroups" in dkg                   # 문서군→템플릿→문서 계층
    templates = read("screens/TemplatesScreen.tsx")  # 템플릿 관리 (N:M 배정)
    assert "배정" in templates and "해제" in templates and "새 템플릿" in templates


def test_webapp_serves_react_build_at_root():
    src = (REPO_ROOT / "kg" / "webapp.py").read_text(encoding="utf-8")
    assert "web_kg" not in src
    assert 'app.mount("/", StaticFiles(directory=react_dist' in src
    assert 'app.mount("/app"' in src                 # 구 경로 호환
    # 빌드 산출물이 커밋되어 서버가 노드 없이도 UI를 서빙한다
    assert (REPO_ROOT / "frontend" / "dist" / "index.html").exists()
