"""`.env` 자동 로드: 이미 있는 환경 변수는 덮어쓰지 않고, 없는 키만 채운다."""

from kg.env import load_env, parse_env


def test_parse_env_handles_comments_quotes_and_export():
    text = """
# comment
KG_V2_READER_TIMEOUT_SECONDS=120
KG_V2_PRINCIPAL= # 비어 있음
export KG_V2_ACCESS_TOKEN="secret # not a comment"
KG_DRM_MAGIC='ab,cd'
BAD LINE
1BAD=x
"""
    assert parse_env(text) == {
        "KG_V2_READER_TIMEOUT_SECONDS": "120",
        "KG_V2_PRINCIPAL": "",
        "KG_V2_ACCESS_TOKEN": "secret # not a comment",
        "KG_DRM_MAGIC": "ab,cd",
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
