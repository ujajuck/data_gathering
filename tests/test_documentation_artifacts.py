"""Ensure review evidence is text-only and can pass through the PR transport."""
from __future__ import annotations

import xml.etree.ElementTree as ET

from tests.conftest import REPO_ROOT


def test_drm_e2e_screenshot_is_a_text_svg_documented_by_path():
    screenshot = REPO_ROOT / "docs" / "screenshots" / "drm-documents-e2e-result.svg"
    documentation = (REPO_ROOT / "docs" / "e2e-results.md").read_text(encoding="utf-8")

    content = screenshot.read_text(encoding="utf-8")  # no binary PR payload
    root = ET.fromstring(content)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert "PASSED [100%]" in content
    assert "1 passed, 2 warnings" in content
    assert "screenshots/drm-documents-e2e-result.svg" in documentation
    assert "drm-documents-e2e-result.png" not in documentation
