"""KG 시스템 CLI — Fixed Domain KG 기반 Excel 통합 (설계서 v0.1).

워크스페이스 규약 (예: domains/financier):
    {ws}/config/domain_kg.yaml     고정 Domain KG (개념/관계/alias)
    {ws}/config/units.yaml         단위 기준
    {ws}/data/kg/kg.db             Tree/Mapping/Integration 저장소
    {ws}/data/kg/builds/           Custom RDBMS 산출물

사용 예:
    python -m kg.cli --ws domains/financier seed
    python -m kg.cli --ws domains/financier ingest --raw domains/financier/data/raw
    python -m kg.cli --ws domains/financier map
    python -m kg.cli --ws domains/financier search core_temperature
    python -m kg.cli --ws domains/financier project --config examples/experiment_result.yaml
    python -m kg.cli --ws domains/financier build --name experiment_result
    python -m kg.cli --ws domains/financier trace --build BLD-.. --row 1 --field core_temp
    python -m kg.cli --ws domains/financier metrics
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from kg.store import KgStore


class Workspace:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.config = self.root / "config"
        self.db_path = self.root / "data" / "kg" / "kg.db"
        self.builds = self.root / "data" / "kg" / "builds"
        self.store = KgStore(self.db_path)
        self._units = None
        self._registry = None
        self._rules = None

    @property
    def units(self):
        if self._units is None:
            from src.units.converter import UnitRegistry
            p = self.config / "units.yaml"
            self._units = UnitRegistry.load(p) if p.exists() else UnitRegistry({})
        return self._units

    @property
    def registry(self):
        """문서 내장 사전 흡수용 (선택) — concepts.yaml이 있으면 사용."""
        if self._registry is None:
            from src.mapping.concepts import ConceptRegistry
            p = self.config / "concepts.yaml"
            self._registry = ConceptRegistry.load(p) if p.exists() else None
        return self._registry

    @property
    def parser_rules(self) -> dict:
        if self._rules is None:
            import yaml
            p = self.config / "parser_rules.yaml"
            self._rules = {}
            if p.exists():
                cfg = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
                self._rules = cfg.get("documents") or {}
        return self._rules


def _emit(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def cmd_seed(ws: Workspace, args) -> int:
    from kg.domain.loader import load_domain_kg
    info = load_domain_kg(ws.store, ws.config / "domain_kg.yaml",
                          ws.config / "units.yaml")
    _emit({k: v for k, v in info.items() if k != "units"})
    return 0


def _ingest_file(ws: Workspace, path: Path) -> dict:
    from src.inspect.inspector import PARSER_VERSION
    from kg.tree.builder import load_workbook_tree
    from kg.tree.diff import apply_tree
    document_id, drafts, file_hash = load_workbook_tree(
        ws.store, ws.root, path, ws.parser_rules, ws.units, ws.registry)
    prev = ws.store.latest_version(document_id)
    if prev is not None and prev["file_hash"] == file_hash:
        return {"file": path.name, "skipped": "unchanged file hash"}
    diff = apply_tree(ws.store, document_id, Path(path).name, str(path),
                      file_hash, PARSER_VERSION, drafts)
    return {"file": path.name, **diff.summary()}


def cmd_ingest(ws: Workspace, args) -> int:
    paths = [args.file] if args.file else sorted(
        p for p in Path(args.raw).glob("*.xlsx") if not p.name.startswith("~$"))
    if not paths:
        print(f"ingest: no xlsx under {args.raw}", file=sys.stderr)
        return 1
    results = []
    for p in paths:
        try:
            results.append(_ingest_file(ws, Path(p)))
        except Exception as e:
            results.append({"file": Path(p).name, "error": repr(e)})
    _emit(results)
    if args.map:
        return cmd_map(ws, args)
    return 0 if not any("error" in r for r in results) else 1


def cmd_map(ws: Workspace, args) -> int:
    from kg.mapping.judge import get_judge
    from kg.mapping.mapper import map_document
    from kg.mapping.retriever import DomainRetriever
    judge = get_judge()
    retriever = DomainRetriever(ws.store, units=ws.units)
    try:
        stats = map_document(ws.store, retriever, judge,
                             retry_unmapped=getattr(args, "retry_unmapped", False))
    except RuntimeError as e:
        print(f"map: {e}", file=sys.stderr)
        return 2
    _emit({"judge": judge.name, **stats})
    return 0


def cmd_search(ws: Workspace, args) -> int:
    from kg.search import concept_neighbors, reverse_lookup
    res = reverse_lookup(ws.store, args.concept, include_review=args.review)
    res["neighbors"] = concept_neighbors(ws.store, args.concept)
    for s in res["sources"]:
        s.pop("payload_id", None)
    _emit(res)
    return 0


def cmd_review(ws: Workspace, args) -> int:
    if args.list:
        rows = ws.store.conn.execute(
            """SELECT m.mapping_id, n.node_name, n.tree_path, m.concept_id,
                      m.confidence, e.reason
               FROM semantic_mapping m JOIN tree_node n ON n.node_id=m.tree_node_id
               LEFT JOIN mapping_evidence e ON e.mapping_id=m.mapping_id
               WHERE m.status='REVIEW_REQUIRED' AND m.is_active=1
               ORDER BY m.confidence DESC LIMIT ?""", (args.limit,)).fetchall()
        _emit([dict(r) for r in rows])
        return 0
    if not args.mapping or not args.action:
        print("review: --mapping과 --action(approve/reject) 필요", file=sys.stderr)
        return 2
    if args.action == "remap":
        if not args.concept:
            print("review: remap은 --concept 필요", file=sys.stderr)
            return 2
        from kg.mapping.mapper import remap_reviewed
        remap_reviewed(ws.store, args.mapping, args.concept, args.reviewer)
    else:
        ws.store.review(args.mapping, args.action.upper(), args.reviewer)
        ws.store.commit()
    _emit({"mapping": args.mapping, "action": args.action})
    return 0


def cmd_project(ws: Workspace, args) -> int:
    from kg.integration.builder import define_project
    iid = define_project(ws.store, Path(args.config))
    n_src = ws.store.conn.execute(
        """SELECT count(*) c FROM source_selection s
           JOIN integration_field f ON f.field_id=s.field_id
           WHERE f.integration_id=?""", (iid,)).fetchone()["c"]
    _emit({"integration_id": iid, "sources_selected": n_src})
    return 0


def cmd_build(ws: Workspace, args) -> int:
    from kg.integration.builder import build
    row = ws.store.conn.execute(
        "SELECT integration_id FROM integration_project WHERE name=? OR integration_id=? "
        "ORDER BY version DESC LIMIT 1", (args.name, args.name)).fetchone()
    if row is None:
        print(f"build: unknown project {args.name}", file=sys.stderr)
        return 1
    result = build(ws.store, row["integration_id"], ws.builds, units=ws.units)
    _emit(result)
    return 0


def cmd_trace(ws: Workspace, args) -> int:
    from kg.search import lineage_of
    _emit(lineage_of(ws.store, args.build, args.row, args.field))
    return 0


def cmd_status(ws: Workspace, args) -> int:
    q = lambda s, *p: ws.store.conn.execute(s, p).fetchone()[0]  # noqa: E731
    _emit({
        "documents": q("SELECT count(*) FROM document"),
        "versions": q("SELECT count(*) FROM document_version"),
        "active_nodes": q("SELECT count(*) FROM tree_node WHERE status='ACTIVE'"),
        "payload_values": q("SELECT count(*) FROM payload_value pv "
                            "JOIN data_payload p ON p.payload_id=pv.payload_id "
                            "WHERE p.is_current=1"),
        "mappings": {r["status"]: r["c"] for r in ws.store.conn.execute(
            "SELECT status, count(*) c FROM semantic_mapping WHERE is_active=1 "
            "GROUP BY status")},
        "projects": q("SELECT count(*) FROM integration_project"),
        "builds": q("SELECT count(*) FROM build_run WHERE status='SUCCESS'"),
    })
    return 0


def cmd_metrics(ws: Workspace, args) -> int:
    """§16.1 Phase 1 정량 검증 항목."""
    c = ws.store.conn
    n_header = c.execute(
        "SELECT count(*) FROM tree_node WHERE status='ACTIVE' "
        "AND node_type IN ('HEADER','SUB_HEADER')").fetchone()[0]
    by_status = {r[0]: r[1] for r in c.execute(
        "SELECT status, count(*) FROM semantic_mapping WHERE is_active=1 GROUP BY status")}
    mapped = by_status.get("AUTO_APPROVED", 0) + by_status.get("APPROVED", 0)
    review = by_status.get("REVIEW_REQUIRED", 0)
    total = sum(by_status.values())
    # 역추적 성공률: 현재 payload가 있는 HEADER 노드 중 locator 보존 비율
    locs = c.execute(
        "SELECT count(*) FROM tree_node WHERE status='ACTIVE' AND node_type='HEADER' "
        "AND locator IS NOT NULL AND locator != ''").fetchone()[0]
    headers_only = c.execute(
        "SELECT count(*) FROM tree_node WHERE status='ACTIVE' "
        "AND node_type='HEADER'").fetchone()[0]
    _emit({
        "structure_extraction": {
            "active_header_nodes": n_header,
            "documents": c.execute("SELECT count(*) FROM document").fetchone()[0],
        },
        "mapping": {
            "total_judged": total,
            "auto_or_approved": mapped,
            "auto_precision_proxy_pct": round(100 * mapped / total, 1) if total else None,
            "review_required": review,
            "review_ratio_pct": round(100 * review / total, 1) if total else None,
            "unmapped": by_status.get("UNMAPPED", 0),
        },
        "traceability": {
            "headers_with_locator_pct": round(100 * locs / headers_only, 1)
                                        if headers_only else None,
        },
    })
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="kg")
    p.add_argument("--ws", default=".", type=Path, help="워크스페이스 루트")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("seed", help="Domain KG YAML → DB 시드")

    pi = sub.add_parser("ingest", help="Excel → Knowledge Tree (버전/diff 반영)")
    pi.add_argument("--raw", default="data/raw", type=Path)
    pi.add_argument("--file", default=None, type=Path)
    pi.add_argument("--map", action="store_true", help="적재 후 바로 매핑")

    pm = sub.add_parser("map", help="미매핑 노드 Semantic Mapping")
    pm.add_argument("--retry-unmapped", action="store_true",
                    help="사전 보강 후 UNMAPPED 노드 재평가")

    ps = sub.add_parser("search", help="Domain Concept 역탐색 (§8.1)")
    ps.add_argument("concept")
    ps.add_argument("--review", action="store_true", help="REVIEW_REQUIRED 포함")

    pr = sub.add_parser("review", help="매핑 검수 (approve/reject/remap)")
    pr.add_argument("--list", action="store_true")
    pr.add_argument("--limit", type=int, default=30)
    pr.add_argument("--mapping")
    pr.add_argument("--action", choices=["approve", "reject", "remap"])
    pr.add_argument("--concept")
    pr.add_argument("--reviewer", default="cli")

    pp = sub.add_parser("project", help="Integration Project 정의 (YAML)")
    pp.add_argument("--config", required=True, type=Path)

    pb = sub.add_parser("build", help="Transformation DAG 실행 → Custom RDBMS")
    pb.add_argument("--name", required=True)

    pt = sub.add_parser("trace", help="계보 역추적 (§11)")
    pt.add_argument("--build", required=True)
    pt.add_argument("--row", required=True, type=int)
    pt.add_argument("--field", required=True)

    sub.add_parser("status", help="저장소 현황")
    sub.add_parser("metrics", help="Phase 1 정량 지표 (§16.1)")

    args = p.parse_args(argv)
    ws = Workspace(args.ws)
    return {"seed": cmd_seed, "ingest": cmd_ingest, "map": cmd_map,
            "search": cmd_search, "review": cmd_review, "project": cmd_project,
            "build": cmd_build, "trace": cmd_trace, "status": cmd_status,
            "metrics": cmd_metrics}[args.cmd](ws, args)


if __name__ == "__main__":
    raise SystemExit(main())
