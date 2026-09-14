"""`.env` 자동 로드 — 의존성 없이 KEY=VALUE 줄만 읽는다.

이미 설정된 환경 변수는 덮어쓰지 않는다(운영 환경의 export가 우선). 값은 저장소에 두지 않고
`.env`(git 미추적)에 두며, `.env.sample`이 키 목록의 기준이다.

읽는 접두는 `SCHEMA_` 하나뿐이다. 옛 접두는 폴백하지 않고 `warn_legacy_env()`가 시작할 때 한 번 짚어 준다
(옛 이름만 설정돼 있으면 렌더 주소·Reader 어댑터가 조용히 기본값으로 내려가므로).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 더 이상 읽지 않는 옛 접두 — 값이 남아 있으면 기본값으로 떨어지는 것을 알린다.
LEGACY_PREFIXES = ("KG_V3_", "KG_V2_", "KG_E2E_", "KG_DRM_")

# 접두는 그대로인데 **이름이 바뀐** SCHEMA_* 키: 옛 이름 → 지금 이름.
# 한 릴리스 동안은 지금 이름이 비어 있을 때만 옛 값을 그대로 쓰고 경고를 남긴다(업그레이드하자마자 렌더 서버
# 인증이 조용히 꺼지지 않게). `SCHEMA_ACCESS_TOKEN`은 메인 API의 사용자 인증이 사라지면서 렌더 서버 내부
# bearer 전용으로 좁아졌고 이름도 그에 맞게 바뀌었다(§5).
RENAMED_KEYS = {"SCHEMA_ACCESS_TOKEN": "SCHEMA_RENDER_TOKEN"}


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


def legacy_env_keys(environ: dict[str, str] | None = None) -> list[str]:
    """설정돼 있지만 이제 읽지 않는 옛 접두 환경변수 이름(정렬)."""
    env = os.environ if environ is None else environ
    return sorted(k for k in env if k.startswith(LEGACY_PREFIXES))


def renamed_key(key: str) -> str:
    """옛 이름 → 지금 이름. `KG_V3_X`·`KG_V2_X` → `SCHEMA_X`, `KG_E2E_X`·`KG_DRM_X` → `SCHEMA_E2E_X`·`SCHEMA_DRM_X`."""
    for prefix in ("KG_V3_", "KG_V2_"):
        if key.startswith(prefix):
            return "SCHEMA_" + key[len(prefix) :]
    return "SCHEMA_" + key[len("KG_") :]


def renamed_env_keys(environ: dict[str, str] | None = None) -> list[tuple[str, str]]:
    """설정돼 있는 옛 이름 → 지금 이름 쌍(정렬). 지금 이름이 이미 있으면 알리지 않는다."""
    env = os.environ if environ is None else environ
    return sorted((old, new) for old, new in RENAMED_KEYS.items() if env.get(old) and not env.get(new))


def apply_renamed_env(environ: dict[str, str] | None = None, stream=None) -> list[tuple[str, str]]:
    """이름이 바뀐 키의 옛 값을 지금 이름으로 옮기고 경고한다(한 릴리스 동안의 폴백). 옮긴 쌍을 돌려준다."""
    env = os.environ if environ is None else environ
    moved = renamed_env_keys(env)
    for old, new in moved:
        env[new] = env[old]
    if moved:
        pairs = ", ".join(f"{old} → {new}" for old, new in moved)
        print(
            f"[경고] 이름이 바뀐 환경변수 {len(moved)}개를 옛 이름으로 읽었습니다: {pairs}. "
            "이번 릴리스까지만 옛 이름을 받습니다 — `.env`의 키 이름을 바꾸세요.",
            file=sys.stderr if stream is None else stream,
        )
    return moved


def warn_legacy_env(environ: dict[str, str] | None = None, stream=None) -> list[str]:
    """옛 접두 환경변수가 남아 있으면 stderr로 알리고(폴백 없음), 이름만 바뀐 키는 옮겨 준다(폴백 + 경고)."""
    apply_renamed_env(environ, stream)
    keys = legacy_env_keys(environ)
    if keys:
        renamed = ", ".join(f"{k} → {renamed_key(k)}" for k in keys)
        print(
            f"[경고] 더 이상 읽지 않는 환경변수 {len(keys)}개가 설정돼 있습니다: {renamed}. "
            "값은 무시되고 기본값이 쓰입니다 — 렌더 주소는 같은 프로세스 렌더로, Reader 어댑터는 평문 전용으로 내려갑니다. "
            "`SCHEMA_` 접두로 바꾸세요.",
            file=sys.stderr if stream is None else stream,
        )
    return keys
