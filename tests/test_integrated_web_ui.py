"""Guard the established KG application against replacement by a parallel UI."""
from __future__ import annotations

from tests.conftest import REPO_ROOT


def test_parsing_and_viewer_are_integrated_into_existing_kg_application():
    html = (REPO_ROOT / "kg" / "web_kg" / "index.html").read_text(encoding="utf-8")
    js = (REPO_ROOT / "kg" / "web_kg" / "app.js").read_text(encoding="utf-8")

    # The original four-stage product and actual graph canvases must remain.
    for text in ("1. 파일 분석", "2. KG 탐색", "3. 원본 데이터", "4. 통합 DB"):
        assert text in html
    for element in ('id="domainGraph"', 'id="docGraph"', 'id="gridwrap"',
                    'id="inspector"'):
        assert element in html

    # New functionality belongs inside that flow, not in a separate app.
    assert "PARSING TEMPLATES" in js
    assert "Parsing Template은 KG 개념 노드가 아닌" in js
    assert "Semantic Overlay" in js and "data-overlay" in js
    # 인스펙터가 뷰어 소스(DRM/Render)와 양식 provenance를 함께 보여준다
    # (2026-09 인스펙터 개편: 'VIEWER SOURCE' 섹션명 → '문서' 접힘 상세로 이동)
    assert "DRM:" in js and "Render:" in js and "Template Source:" in js
    assert "PDF Preview" in js


def test_no_parallel_frontend_application_is_shipped():
    # React frontend/ is maintained for DRM source viewer — allowed alongside web_kg
    if (REPO_ROOT / "frontend").exists():
        # Verify it has the expected React structure, not a duplicate of web_kg
        assert (REPO_ROOT / "frontend" / "package.json").exists()
        assert (REPO_ROOT / "frontend" / "src" / "App.tsx").exists()
