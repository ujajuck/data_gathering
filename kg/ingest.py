"""문서 획득/적재 파이프라인 — parse와 apply의 분리 (KG2).

CLI(_ingest_file)와 웹(/api/ingest, 재크롤링)이 같은 코드를 공유한다.
파싱(parse_workbook)은 DB를 건드리지 않으므로 웹에서는 lock 밖에서 실행하고,
반영(apply_parsed)만 lock 안에서 실행한다.
"""
from __future__ import annotations

from pathlib import Path

from kg.store import KgStore, stable_id
from kg.tree.builder import NodeDraft, load_workbook_tree
from kg.tree.diff import TreeDiff, apply_tree


def document_id_for(ws_root: Path, path: Path) -> str:
    """load_workbook_tree와 동일한 논리 문서 ID — 규약을 한 곳에서 공유한다.

    (inspector.relative_path = str(path.relative_to(root)), 밖이면 절대경로)
    """
    path = Path(path).resolve()
    root = Path(ws_root).resolve()
    logical = str(path.relative_to(root)) if path.is_relative_to(root) else str(path)
    return stable_id(logical)


def parse_workbook(store: KgStore, ws_root: Path, path: Path, parser_rules: dict,
                   units, registry) -> tuple[str, list[NodeDraft], str]:
    """파일 하나를 파싱한다. DB 미반영 — 웹에서는 lock 밖에서 호출한다."""
    return load_workbook_tree(store, ws_root, path, parser_rules, units, registry)


def apply_parsed(store: KgStore, document_id: str, path: Path, file_hash: str,
                 parser_version: str, drafts: list[NodeDraft],
                 force: bool = False) -> dict:
    """파싱 결과를 트리에 반영한다(diff). 해시·파서버전이 같으면 스킵.

    스킵 기준에 parser_version을 포함한다 — 파일이 그대로여도 파서가 바뀌면
    재반영해야 하고, 재크롤링 반복 시 document_version 행 증식은 막아야 한다.
    """
    prev = store.latest_version(document_id)
    if (prev is not None and prev["file_hash"] == file_hash
            and prev["parser_version"] == parser_version and not force):
        return {"skipped": "unchanged file hash"}
    diff: TreeDiff = apply_tree(store, document_id, Path(path).name, str(path),
                                file_hash, parser_version, drafts)
    return diff.summary()


def ingest_file(store: KgStore, ws_root: Path, path: Path, parser_rules: dict,
                units, registry, force: bool = False) -> dict:
    """parse + apply 일괄 (CLI 경로). 잠긴(암호화/DRM) 파일은 우회하지 않고
    명시적으로 건너뛴다 — 웹 파일 탭에서 해제 요청을 만들 수 있다."""
    from kg.acquisition import sniff_container
    from src.inspect.inspector import PARSER_VERSION
    sniff = sniff_container(Path(path))
    if sniff["locked"]:
        return {"file": Path(path).name, "locked": True,
                "error": f"잠긴 파일({sniff.get('detail') or sniff['container']}) "
                         "— DRM 해제 요청 필요"}
    document_id, drafts, file_hash = parse_workbook(
        store, ws_root, path, parser_rules, units, registry)
    res = apply_parsed(store, document_id, path, file_hash, PARSER_VERSION,
                       drafts, force=force)
    return {"file": Path(path).name, "document_id": document_id, **res}
