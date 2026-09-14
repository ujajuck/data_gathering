"""v3 E2E 러너 — 임시 작업 공간에 가상 문서·스키마·프로파일을 만들고 두 서버를 띄운다.

- 렌더 서버: `python -m kg.v3 render-serve` 별도 프로세스, 127.0.0.1:8032
- 메인 API/UI: kg.v3.api.create_app, 127.0.0.1:8031 (KG_V3_RENDER_URL로 렌더 서버 사용)

작업 공간 경로는 `e2e/v3/.workspace`에 기록한다. 스펙은 이 경로로 새 snapshot 시나리오
(`examples.schema_v3.demo.mutate_first_document`)를 실행한다. 실제 도메인 DB·사용자 원본은 열지 않는다.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

MAIN_PORT = int(os.environ.get("KG_E2E_V3_PORT", "8031"))
RENDER_PORT = int(os.environ.get("KG_E2E_V3_RENDER_PORT", "8032"))
MARKER = Path(__file__).resolve().parent / ".workspace"


def wait_for(url: str, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:  # noqa: S310 - local loopback only
                if response.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.2)
    raise SystemExit(f"render server did not start: {url}")


def main() -> None:
    import uvicorn

    from examples.schema_v3.demo import seed
    from kg.v3.api import create_app

    with tempfile.TemporaryDirectory(prefix="kg-v3-e2e-") as directory:
        root = Path(directory)
        seed(root)
        MARKER.write_text(str(root), encoding="utf-8")
        render = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "kg.v3",
                "render-serve",
                "--ws",
                str(root),
                "--port",
                str(RENDER_PORT),
            ]
        )
        try:
            wait_for(f"http://127.0.0.1:{RENDER_PORT}/render/status")
            os.environ["KG_V3_RENDER_URL"] = f"http://127.0.0.1:{RENDER_PORT}"
            uvicorn.run(create_app(root), host="127.0.0.1", port=MAIN_PORT)
        finally:
            render.terminate()
            try:
                render.wait(timeout=10)
            except subprocess.TimeoutExpired:
                render.kill()
            MARKER.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
