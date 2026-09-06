"""재크롤링 러너 — DKG/KG 편집 후 멤버 문서 재수집+재매핑 (KG2).

절차(문서별, 실패 격리):
    parse(lock 밖) → apply_tree(lock 안, 해시+파서버전 동일이면 스킵)
    → 모드별 초기화(fill/reset_auto, status 기반) → 활성 레시피 적용
    → map_nodes_staged(judge는 lock 밖) → run summary 갱신(폴링 가시화)

사람 결정(APPROVED/REJECTED)은 어느 단계도 건드리지 않는다.
웹앱은 이 함수를 백그라운드 스레드에서 돌리고 run_id로 폴링한다.
"""
from __future__ import annotations

import json
import traceback
from pathlib import Path

from kg.ingest import apply_parsed, parse_workbook
from kg.mapping.mapper import map_nodes_staged, reset_document_mappings
from kg.mapping.recipe import apply_recipe
from kg.store import KgStore, new_id, now_iso

MODES = ("fill", "reset_auto")


def start_run(store: KgStore, root: str, recipe_id: str | None, mode: str) -> str:
    run_id = new_id("RCL")
    store.conn.execute(
        "INSERT INTO recrawl_run (run_id, root_concept_id, recipe_id, mode, "
        "status, started_at) VALUES (?,?,?,?, 'RUNNING', ?)",
        (run_id, root, recipe_id, mode, now_iso()))
    store.commit()
    return run_id


def recover_interrupted_runs(store: KgStore) -> int:
    """기동 시 RUNNING 잔류 run을 FAILED로 마감 — 전역 직렬화가 영구히
    걸리는 것을 막는다."""
    cur = store.conn.execute(
        "UPDATE recrawl_run SET status='FAILED', finished_at=?, "
        "summary_json=COALESCE(summary_json, '[]') "
        "WHERE status='RUNNING'", (now_iso(),))
    store.commit()
    return cur.rowcount


def _resolve_path(store: KgStore, ws_root: Path, document_id: str) -> Path | None:
    row = store.conn.execute(
        "SELECT filepath, filename FROM document WHERE document_id=?",
        (document_id,)).fetchone()
    if row is None:
        return None
    p = Path(row["filepath"] or "")
    if p.exists() and p.suffix.lower() == ".xlsx":
        return p
    fallback = Path(ws_root) / "data" / "raw" / row["filename"]
    return fallback if fallback.exists() else None


def run_recrawl(store: KgStore, lock, ws, root: str, mode: str,
                document_ids: list[str], run_id: str,
                retriever, judge) -> dict:
    """멤버 문서를 순회하며 재수집+재매핑한다. 동기 실행 (호출측이 스레드 결정).

    ws: parser_rules/units/registry/root 속성을 가진 Workspace(공유 store).
    retriever: 호출측이 lock 안에서 갓 만든 DomainRetriever — KG 편집이 반영된
    최신 사전 스냅샷이다 (생성 시점 캐시).
    """
    from src.inspect.inspector import PARSER_VERSION

    with lock:
        recipe = store.conn.execute(
            "SELECT * FROM extraction_recipe WHERE root_concept_id=? "
            "AND status='ACTIVE'", (root,)).fetchone()
    summary: list[dict] = []

    def _flush(status: str | None = None) -> None:
        with lock:
            try:
                if status:
                    store.conn.execute(
                        "UPDATE recrawl_run SET status=?, finished_at=?, "
                        "summary_json=? WHERE run_id=?",
                        (status, now_iso(), json.dumps(summary, ensure_ascii=False),
                         run_id))
                else:
                    store.conn.execute(
                        "UPDATE recrawl_run SET summary_json=? WHERE run_id=?",
                        (json.dumps(summary, ensure_ascii=False), run_id))
                store.commit()
            except Exception:
                # rollback은 반드시 lock 보유 상태에서 — 미커밋 쓰기가 다른
                # 요청의 commit에 편승하는 창을 만들지 않는다
                store.conn.rollback()
                raise

    errors = 0
    for doc_id in document_ids:
        with lock:
            path = _resolve_path(store, ws.root, doc_id)
            fn = store.conn.execute(
                "SELECT filename FROM document WHERE document_id=?",
                (doc_id,)).fetchone()
        entry: dict = {"document_id": doc_id,
                       "filename": fn["filename"] if fn else doc_id,
                       "ingest": None, "reset": 0, "recipe": None,
                       "map": None, "error": None}
        summary.append(entry)
        try:
            if path is None:
                raise FileNotFoundError("원본 파일을 찾을 수 없습니다 "
                                        "(filepath/data/raw 모두 부재)")
            parsed_id, drafts, file_hash = parse_workbook(   # lock 밖 — 파싱
                store, ws.root, path, ws.parser_rules, ws.units, ws.registry)
            if parsed_id != doc_id:
                # 경로 기반 논리 ID가 달라졌다 = 파일 이동/개명 — 조용히 새
                # 문서를 만들지 않고 오류로 드러낸다
                raise RuntimeError(
                    f"문서 ID 불일치(파일 이동/개명 추정): {parsed_id[:8]}…")
            with lock:
                # rollback은 lock을 쥔 채로 — with 블록을 예외로 탈출하면
                # lock이 먼저 풀려 부분 쓰기가 경쟁 요청의 commit에 편승한다
                try:
                    entry["ingest"] = apply_parsed(
                        store, parsed_id, path, file_hash, PARSER_VERSION, drafts)
                    entry["reset"] = reset_document_mappings(
                        store, doc_id, mode, note=f"recrawl {mode} @ {run_id}")
                    store.commit()
                    if recipe is not None:
                        entry["recipe"] = apply_recipe(store, recipe, doc_id)
                except Exception:
                    store.conn.rollback()
                    raise
            entry["map"] = map_nodes_staged(store, lock, retriever, judge, doc_id)
        except Exception as e:
            errors += 1
            entry["error"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
            with lock:
                store.conn.rollback()      # 2차 방어 (이미 각 단계에서 rollback)
        _flush()

    status = ("FAILED" if errors == len(document_ids) and document_ids
              else "PARTIAL" if errors else "SUCCESS")
    _flush(status)
    return {"run_id": run_id, "status": status, "documents": len(document_ids),
            "errors": errors}
