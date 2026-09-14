"""`.env` 자동 로드 — 의존성 없이 KEY=VALUE 줄만 읽는다.

이미 설정된 환경 변수는 덮어쓰지 않는다(운영 환경의 export가 우선). 값은 저장소에 두지 않고
`.env`(git 미추적)에 두며, `.env.sample`이 키 목록의 기준이다.
"""

from __future__ import annotations

import os
from pathlib import Path


def parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key[0].isdigit() or not all(ch.isalnum() or ch == "_" for ch in key):
            continue
        value = value.strip()
        if value.startswith("#"):
            value = ""
        if value[:1] in ("'", '"') and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        else:
            # 따옴표 없는 값의 뒤쪽 ' # 주석'은 버린다 (.env.sample의 표기 방식).
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def load_env(*directories: os.PathLike[str] | str, environ: dict[str, str] | None = None) -> list[str]:
    """주어진 폴더들의 `.env`를 순서대로 읽어 아직 없는 키만 환경에 넣는다. 적용한 키 목록을 돌려준다."""
    env = os.environ if environ is None else environ
    applied: list[str] = []
    seen: set[Path] = set()
    for directory in directories:
        path = Path(directory).resolve() / ".env"
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        for key, value in parse_env(path.read_text(encoding="utf-8")).items():
            if key not in env or env[key] == "":
                env[key] = value
                applied.append(key)
    return applied
