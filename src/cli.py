"""CLI — ingest / watch / export / status / reprocess (설계문서 §12 API의 최소 대응).

사용 예:
    python -m src.cli ingest                 # data/raw 전체 증분 처리
    python -m src.cli ingest --file data/raw/01_설비점검일지_반복블록.xlsx
    python -m src.cli watch --interval 2     # polling watcher 루프
    python -m src.cli export                 # 표준 5-sheet workbook 생성
    python -m src.cli status                 # 문서/버전/레코드 현황
    python -m src.cli reprocess --force      # 캐시 무시 전체 재처리
    python -m src.cli survey --raw incoming/ # 적재 전 어휘 조사 (사전 격차 리포트)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.export.workbook import CanonicalWorkbookExporter
from src.pipeline import Pipeline
from src.watch.watcher import FileEventWatcher


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="excel-canonical")
    parser.add_argument("--repo-root", default=".", type=Path)
    parser.add_argument("--db", default=None, type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ingest = sub.add_parser("ingest", help="raw 디렉터리/파일 증분 처리")
    p_ingest.add_argument("--raw", default="data/raw", type=Path)
    p_ingest.add_argument("--file", default=None, type=Path)
    p_ingest.add_argument("--force", action="store_true")

    p_watch = sub.add_parser("watch", help="polling watcher 루프")
    p_watch.add_argument("--raw", default="data/raw", type=Path)
    p_watch.add_argument("--interval", default=2.0, type=float)
    p_watch.add_argument("--loops", default=None, type=int)

    p_export = sub.add_parser("export", help="표준 통합 workbook 생성")
    p_export.add_argument("--out", default="data/canonical/canonical.xlsx", type=Path)

    sub.add_parser("status", help="문서/버전/레코드 현황")

    p_hub = sub.add_parser("hub", help="LOT 허브: 문서 횡단 통합 뷰")
    p_hub.add_argument("--lot", default=None)

    sub.add_parser("graph", help="지식 그래프 projection (엔티티/관계)")
    sub.add_parser("ontology", help="개념 온톨로지 계층")

    p_re = sub.add_parser("reprocess", help="캐시 무시 재처리")
    p_re.add_argument("--raw", default="data/raw", type=Path)
    p_re.add_argument("--force", action="store_true", default=True)

    p_sv = sub.add_parser("survey", help="적재 전 어휘 조사 (dry-run 매핑 — DB/캐시 미변경)")
    p_sv.add_argument("--raw", default="data/raw", type=Path)
    p_sv.add_argument("--file", action="append", type=Path,
                      help="개별 파일 지정 (반복 가능). 지정 시 --raw 무시")
    p_sv.add_argument("--out", default=None, type=Path, help="JSON 리포트 저장 경로(선택)")

    args = parser.parse_args(argv)

    if args.cmd == "survey":
        # 적재 전 단계 — Pipeline(DB 생성)을 만들지 않는다
        from src.survey import survey_dir, survey_paths
        if args.file:
            report = survey_paths(args.repo_root, args.file)
        else:
            report = survey_dir(args.repo_root, args.raw)
        text = json.dumps(report, ensure_ascii=False, indent=2)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(text, encoding="utf-8")
            print(f"survey report: {args.out}")
        else:
            print(text)
        return 0

    pipe = Pipeline(args.repo_root, db_path=args.db)

    if args.cmd == "ingest":
        if args.file:
            results = [pipe.process_file(args.file, trigger="cli", force=args.force)]
        else:
            results = pipe.process_dir(args.raw, trigger="cli")
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0 if all(r["status"] != "FAILED" for r in results) else 1

    if args.cmd == "watch":
        watcher = FileEventWatcher(raw_dir=args.raw)

        def handle(ev):
            if ev.kind in ("created", "modified"):
                r = pipe.process_file(Path(ev.path), trigger=f"watch:{ev.kind}")
                print(json.dumps(r, ensure_ascii=False))

        watcher.run(handle, interval=args.interval, stop_after=args.loops)
        return 0

    if args.cmd == "export":
        out = CanonicalWorkbookExporter(pipe.loader).export(args.out)
        print(f"exported: {out}")
        return 0

    if args.cmd == "status":
        conn = pipe.loader.conn
        docs = conn.execute(
            """SELECT sd.logical_name, count(dv.document_version_id) versions,
                      max(dv.detected_at) last_seen
               FROM source_document sd LEFT JOIN document_version dv USING (document_id)
               GROUP BY sd.document_id"""
        ).fetchall()
        recs = conn.execute("SELECT count(*) n FROM v_current_record").fetchone()["n"]
        obs = conn.execute("SELECT count(*) n FROM v_current_observation").fetchone()["n"]
        pend = conn.execute(
            "SELECT count(*) n FROM mapping_decision WHERE decision='pending'"
        ).fetchone()["n"]
        print(json.dumps({
            "documents": [dict(d) for d in docs],
            "current_records": recs,
            "current_observations": obs,
            "pending_mappings": pend,
        }, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "hub":
        from src.api.queries import lot_hub_projection
        print(json.dumps(lot_hub_projection(pipe.loader, business_key=args.lot),
                         ensure_ascii=False, indent=2, default=str))
        return 0

    if args.cmd == "graph":
        from src.api.queries import knowledge_graph_projection, load_relations
        rel = load_relations(args.repo_root / "config")
        print(json.dumps(knowledge_graph_projection(pipe.loader, pipe.registry, rel),
                         ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "ontology":
        from src.api.queries import ontology_projection
        print(json.dumps(ontology_projection(pipe.registry), ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "reprocess":
        results = [pipe.process_file(p, trigger="reprocess", force=True)
                   for p in sorted(Path(args.raw).glob("*.xlsx")) if not p.name.startswith("~$")]
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
