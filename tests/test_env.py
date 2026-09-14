"""`.env` 자동 로드: 이미 있는 환경 변수는 덮어쓰지 않고, 없는 키만 채운다. 옛 접두는 폴백하지 않고 경고한다."""

import io

from schema.env import load_env, parse_env, warn_legacy_env


def test_parse_env_handles_comments_quotes_and_export():
    text = """
# comment
SCHEMA_READER_TIMEOUT_SECONDS=120
SCHEMA_PRINCIPAL= # 비어 있음
export SCHEMA_ACCESS_TOKEN="secret # not a comment"
SCHEMA_READER_FACTORY='pkg.reader:factory'
BAD LINE
1BAD=x
"""
    assert parse_env(text) == {
        "SCHEMA_READER_TIMEOUT_SECONDS": "120",
        "SCHEMA_PRINCIPAL": "",
        "SCHEMA_ACCESS_TOKEN": "secret # not a comment",
        "SCHEMA_READER_FACTORY": "pkg.reader:factory",
    }


def test_load_env_prefers_existing_values_and_workspace_first(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / ".env").write_text("A=ws\nB=ws\n", encoding="utf-8")
    (tmp_path / ".env").write_text("B=cwd\nC=cwd\n", encoding="utf-8")
    env = {"A": "exported"}
    applied = load_env(ws, tmp_path, environ=env)
    assert env == {"A": "exported", "B": "ws", "C": "cwd"}
    assert applied == ["B", "C"]
    # 같은 파일을 두 번 주어도 한 번만 읽고, 없는 폴더는 무시한다.
    assert load_env(ws, ws, tmp_path / "missing", environ=env) == []


def test_legacy_env_prefixes_are_reported_not_used():
    """옛 이름만 설정돼 있으면 조용히 기본값으로 떨어지지 않게 시작 시 한 번 알린다(폴백은 없다)."""
    out = io.StringIO()
    env = {"KG_V3_ACCESS_TOKEN": "s3cret", "KG_E2E_PORT": "8031", "SCHEMA_PRINCIPAL": "local"}
    assert warn_legacy_env(env, stream=out) == ["KG_E2E_PORT", "KG_V3_ACCESS_TOKEN"]
    message = out.getvalue()
    assert "KG_V3_ACCESS_TOKEN → SCHEMA_ACCESS_TOKEN" in message
    assert "KG_E2E_PORT → SCHEMA_E2E_PORT" in message
    assert "s3cret" not in message  # 값은 출력하지 않는다
    # 옛 이름만 있는 상태에서 SCHEMA_ 조회는 여전히 비어 있다 — 폴백을 만들지 않았다.
    assert env.get("SCHEMA_ACCESS_TOKEN") is None
    quiet = io.StringIO()
    assert warn_legacy_env({"SCHEMA_ACCESS_TOKEN": "s3cret"}, stream=quiet) == []
    assert quiet.getvalue() == ""
