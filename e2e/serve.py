"""E2E 러너(감독 프로세스) — 임시 작업 공간에 가상 문서·스키마·프로파일을 만들고 두 서버를 자식 프로세스로 띄운다.

- 렌더 서버: `python -m schema render-serve` 별도 프로세스, 127.0.0.1:8032 (SCHEMA_E2E_RENDER_PORT)
- 메인 API/UI: `python serve.py --main`(schema.api.create_app) 별도 프로세스, 127.0.0.1:8031 (SCHEMA_E2E_PORT, SCHEMA_RENDER_URL로 렌더 서버 사용)
- 제어 서버: 127.0.0.1:18031 (SCHEMA_E2E_CONTROL_PORT, 기본 메인 포트+10000). `POST /reset`은 새 임시 작업 공간을 시드하고
  두 서버를 다시 띄운다 — 스펙 파일마다 `helpers.resetWorkspace()`가 호출해 이전 스펙이 남긴 상태(등록·승인·빌드)와 격리한다.
  `GET /status`는 현재 작업 공간과 세대(generation)를 돌려준다.

작업 공간 경로는 `e2e/.workspace`(기본 포트가 아니면 `.workspace-<port>`)에 기록한다(리셋마다 갱신). 스펙은 이 경로로 새 snapshot 시나리오
(`examples.demo.demo.mutate_first_document`)를 실행한다. 실제 사용자 작업 공간·원본은 열지 않는다.
SIGTERM/SIGINT(Playwright의 gracefulShutdown)에서도 자식 프로세스·표식·임시 폴더를 정리한다.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

MAIN_PORT = int(os.environ.get("SCHEMA_E2E_PORT", "8031"))
RENDER_PORT = int(os.environ.get("SCHEMA_E2E_RENDER_PORT", "8032"))
CONTROL_PORT = int(os.environ.get("SCHEMA_E2E_CONTROL_PORT", str(MAIN_PORT + 10000)))
MARKER = Path(__file__).resolve().parent / (".workspace" if MAIN_PORT == 8031 else f".workspace-{MAIN_PORT}")
CHILD_ENV = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(REPO), os.environ.get("PYTHONPATH")]))}


def wait_for(url: str, timeout: float = 60.0, process: subprocess.Popen | None = None) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise SystemExit(f"server exited with {process.returncode} before answering: {url}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:  # noqa: S310 - local loopback only
                if response.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.2)
    raise SystemExit(f"server did not start: {url}")


def stop(process: subprocess.Popen | None, timeout: float = 10.0) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def forward_stderr(process: subprocess.Popen, tag: str) -> None:
    """자식의 stderr를 그대로 흘리되 uvicorn INFO 줄(시작/종료/접근 로그)은 버린다 — list reporter 출력이 서버 로그에 묻히지 않게."""

    def pump() -> None:
        assert process.stderr is not None
        for raw in process.stderr:
            line = raw.decode("utf-8", "replace")
            if line.startswith("INFO:"):
                continue
            sys.stderr.write(f"[{tag}] {line}")
            sys.stderr.flush()

    threading.Thread(target=pump, name=f"stderr-{tag}", daemon=True).start()


def run_main(root: Path) -> None:
    """자식 모드: 메인 API/UI 서버(기존 러너와 같은 create_app 경로)."""
    import uvicorn

    from schema.api import create_app

    uvicorn.run(create_app(root), host="127.0.0.1", port=MAIN_PORT)


class Runner:
    """작업 공간 1개 + 렌더/메인 자식 프로세스 2개. reset()은 모두 새로 만든다."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.root: Path | None = None
        self.render: subprocess.Popen | None = None
        self.main: subprocess.Popen | None = None
        self.generation = 0

    def start(self) -> Path:
        from examples.demo.demo import seed

        root = Path(tempfile.mkdtemp(prefix="schema-e2e-"))
        seed(root)
        self.render = subprocess.Popen(
            [sys.executable, "-m", "schema", "render-serve", "--ws", str(root), "--port", str(RENDER_PORT)],
            # 하위 프로세스는 cwd(e2e/)에서 `schema`를 찾지 못하므로 저장소 루트를 PYTHONPATH로 넘긴다.
            env=CHILD_ENV,
            stderr=subprocess.PIPE,
        )
        forward_stderr(self.render, "render")
        wait_for(f"http://127.0.0.1:{RENDER_PORT}/render/status", process=self.render)
        self.main = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--main", str(root)],
            env={**CHILD_ENV, "SCHEMA_RENDER_URL": f"http://127.0.0.1:{RENDER_PORT}"},
            stderr=subprocess.PIPE,
        )
        forward_stderr(self.main, "main")
        wait_for(f"http://127.0.0.1:{MAIN_PORT}/api/status", process=self.main)
        self.root = root
        self.generation += 1
        MARKER.write_text(str(root), encoding="utf-8")
        return root

    def stop(self) -> None:
        stop(self.main)
        stop(self.render)
        self.main = self.render = None
        MARKER.unlink(missing_ok=True)
        if self.root is not None:
            shutil.rmtree(self.root, ignore_errors=True)
            self.root = None

    def reset(self) -> Path:
        with self.lock:
            self.stop()
            return self.start()

    def status(self) -> dict:
        return {
            "workspace": str(self.root) if self.root else None,
            "generation": self.generation,
            "main_port": MAIN_PORT,
            "render_port": RENDER_PORT,
            "main_alive": self.main is not None and self.main.poll() is None,
            "render_alive": self.render is not None and self.render.poll() is None,
        }


def control_handler(runner: Runner):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path.split("?")[0] == "/status":
                self._send(200, runner.status())
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - http.server API
            if self.path.split("?")[0] != "/reset":
                self._send(404, {"error": "not found"})
                return
            try:
                started = time.monotonic()
                root = runner.reset()
                elapsed_ms = round((time.monotonic() - started) * 1000)
                sys.stderr.write(f"[e2e-control] reset → generation {runner.generation} · workspace {root.name} · {elapsed_ms} ms\n")
                self._send(200, {**runner.status(), "workspace": str(root), "elapsed_ms": elapsed_ms})
            except BaseException as exc:  # noqa: BLE001 - 스펙에 원인을 돌려준다
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002, ARG002 - http.server API; 요청 로그는 reset 줄로 대신한다
            return

    return Handler


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--main":
        run_main(Path(sys.argv[2]))
        return

    runner = Runner()

    def terminate(signum, frame):  # noqa: ARG001 - signal API
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    server = ThreadingHTTPServer(("127.0.0.1", CONTROL_PORT), control_handler(runner))
    server.daemon_threads = True
    try:
        with runner.lock:
            runner.start()
        sys.stderr.write(f"[e2e-control] generation 1 · workspace {runner.root.name} · main {MAIN_PORT} · render {RENDER_PORT} · control {CONTROL_PORT}\n")
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        # 리셋 도중 종료 신호가 오면 잠금을 오래 기다리지 않고 정리한다.
        acquired = runner.lock.acquire(timeout=30)
        try:
            runner.stop()
        finally:
            if acquired:
                runner.lock.release()


if __name__ == "__main__":
    main()
