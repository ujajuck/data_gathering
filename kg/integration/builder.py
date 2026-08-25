"""Integration Builder — 사용자 목적별 Custom RDBMS 생성 (§9) + 계보 (§11).

프로젝트 정의(YAML):

    name: experiment_result
    fields:
      - name: recipe_type        # 출력 필드명
        concept: recipe_name     # Domain Concept
        type: text
      - name: core_temp
        concept: core_temperature
        type: numeric
        unit: ℃                  # target unit → unit_convert 블록이 사용
    sources:                     # 선택 (생략 시 역탐색 자동 선택: AUTO/APPROVED 전체)
      exclude_documents: [...]   # 문서 단위 제외
      include_nodes:             # 필드별 명시 선택 (역탐색 결과의 node_id)
        core_temp: [abc123...]
    transform:                   # §10 블록의 선형 DAG
      - op: unit_convert
      - op: null_handling
        config: {columns: [core_temp], mode: drop}
      - op: union
      - op: deduplicate

Source 조립 규칙: 같은 TABLE(Region)에 속한 소스 노드들의 payload를 행 키
(row_key, 없으면 원본 셀 행 번호)로 정렬(join)해 프레임 하나를 만든다 —
문서마다 표 모양이 달라도 Region 단위 행 정합은 원본 구조가 보장한다.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import yaml

from kg.integration.dag import Frame, run_dag
from kg.search import reverse_lookup
from kg.store import KgStore, new_id, now_iso, stable_id


# ------------------------------------------------------------- definition ---
def define_project(store: KgStore, config: dict | str | Path) -> str:
    """프로젝트 정의 저장 (idempotent: 같은 이름은 새 버전으로 대체)."""
    if not isinstance(config, dict):
        config = yaml.safe_load(Path(config).read_text(encoding="utf-8"))
    name = config["name"]
    prev = store.conn.execute(
        "SELECT integration_id, version FROM integration_project WHERE name=? "
        "ORDER BY version DESC LIMIT 1", (name,)).fetchone()
    version = (prev["version"] + 1) if prev else 1
    iid = new_id("INT")
    store.conn.execute(
        "INSERT INTO integration_project VALUES (?,?,?,?,?)",
        (iid, name, version, json.dumps(config, ensure_ascii=False), now_iso()))

    excludes = set((config.get("sources") or {}).get("exclude_documents") or [])
    includes = (config.get("sources") or {}).get("include_nodes") or {}
    for fdef in config.get("fields") or []:
        fid = stable_id(iid, fdef["name"])
        store.conn.execute(
            "INSERT INTO integration_field VALUES (?,?,?,?,?,?)",
            (fid, iid, fdef["name"], fdef.get("concept"), fdef.get("type"),
             fdef.get("unit")))
        if not fdef.get("concept"):
            continue
        picked = includes.get(fdef["name"])
        found = reverse_lookup(store, fdef["concept"])
        for s in found["sources"]:
            if s["document"] in excludes:
                continue
            if picked is not None and s["node_id"] not in picked:
                continue
            store.conn.execute(
                "INSERT OR REPLACE INTO source_selection VALUES (?,?,1,?)",
                (fid, s["node_id"], json.dumps({"mapping": s["mapping"]})))

    for i, step in enumerate(config.get("transform") or []):
        nid = stable_id(iid, f"t{i}")
        store.conn.execute(
            "INSERT INTO transformation_node VALUES (?,?,?,?)",
            (nid, iid, step.get("op"), json.dumps(step.get("config") or {},
                                                  ensure_ascii=False)))
        if i:
            store.conn.execute(
                "INSERT INTO transformation_edge VALUES (?,?,?)",
                (iid, stable_id(iid, f"t{i-1}"), nid))
    store.commit()
    return iid


# --------------------------------------------------------------- assembly ---
def _table_ancestor(store: KgStore, node_id: str) -> str | None:
    seen = 0
    cur = store.node(node_id)
    while cur is not None and seen < 10:
        if cur["node_type"] == "TABLE":
            return cur["node_id"]
        if cur["parent_node_id"] is None:
            return None
        cur = store.node(cur["parent_node_id"])
        seen += 1
    return None


def _row_join_key(row) -> str:
    if row["row_key"]:
        return str(row["row_key"])
    addr = row["cell_address"] or ""
    digits = "".join(ch for ch in addr if ch.isdigit())
    return f"@r{digits or row['row_idx']}"


def assemble_sources(store: KgStore, integration_id: str) -> tuple[list[Frame], dict]:
    """source_selection → Region 단위 Frame 목록 + env(단위/필드 메타)."""
    fields = store.conn.execute(
        "SELECT * FROM integration_field WHERE integration_id=?",
        (integration_id,)).fetchall()
    field_units = {f["field_name"]: f["target_unit"] for f in fields
                   if f["target_unit"]}
    node_units: dict[str, str] = {}
    # region_id → field_name → [(node, payload_id)]
    regions: dict[str, dict[str, list]] = {}
    region_meta: dict[str, dict] = {}
    for f in fields:
        sels = store.conn.execute(
            "SELECT tree_node_id FROM source_selection WHERE field_id=? AND enabled=1",
            (f["field_id"],)).fetchall()
        for sel in sels:
            node = store.node(sel["tree_node_id"])
            if node is None or node["status"] != "ACTIVE":
                continue
            pay = store.conn.execute(
                "SELECT payload_id, version_id FROM data_payload "
                "WHERE tree_node_id=? AND is_current=1", (node["node_id"],)).fetchone()
            if pay is None:
                continue
            if node["unit"]:
                node_units[node["node_id"]] = node["unit"]
            region = _table_ancestor(store, node["node_id"]) or node["node_id"]
            regions.setdefault(region, {}).setdefault(f["field_name"], []).append(
                (node, pay))
            if region not in region_meta:
                doc = store.conn.execute(
                    "SELECT d.document_id, d.filename FROM document d WHERE d.document_id=?",
                    (node["document_id"],)).fetchone()
                tnode = store.node(region)
                region_meta[region] = {
                    "document_id": node["document_id"],
                    "document": doc["filename"] if doc else node["document_id"],
                    "version_id": pay["version_id"],
                    "sheet": (node["tree_path"].split("/") + [""])[1],
                    "locator": (tnode["locator"] if tnode else node["locator"]) or "",
                }

    frames: list[Frame] = []
    for region, by_field in regions.items():
        cols = list(by_field.keys())
        keys: list[str] = []
        cells: dict[str, dict[str, tuple]] = {}      # key → col → (value, lineage)
        for col, node_pays in by_field.items():
            for node, pay in node_pays:
                rows = store.conn.execute(
                    "SELECT * FROM payload_value WHERE payload_id=? ORDER BY row_idx",
                    (pay["payload_id"],)).fetchall()
                for r in rows:
                    k = _row_join_key(r)
                    if k not in cells:
                        cells[k] = {}
                        keys.append(k)
                    v = r["value_num"] if r["value_num"] is not None else r["value_text"]
                    cells[k].setdefault(col, (v, {
                        "payload_id": pay["payload_id"], "row_idx": r["row_idx"],
                        "node_id": node["node_id"], "unit": node["unit"],
                        "cell": r["cell_address"]}))
        fr = Frame(cols, meta=region_meta[region])
        for k in keys:
            fr.rows.append({c: cells[k].get(c, (None, None))[0] for c in cols})
            fr.lineage.append({c: cells[k].get(c, (None, None))[1] for c in cols})
        frames.append(fr)
    env = {"field_units": field_units, "node_units": node_units}
    return frames, env


# ------------------------------------------------------------------ build ---
def build(store: KgStore, integration_id: str, out_dir: Path, units=None) -> dict:
    proj = store.conn.execute(
        "SELECT * FROM integration_project WHERE integration_id=?",
        (integration_id,)).fetchone()
    if proj is None:
        raise KeyError(integration_id)
    config = json.loads(proj["config_json"])
    build_id = new_id("BLD")
    started = now_iso()
    # lineage_edge가 build_id를 FK로 참조하므로 실행 레코드를 먼저 만든다
    store.conn.execute(
        "INSERT INTO build_run VALUES (?,?,?,?,?,?,?,?,?)",
        (build_id, integration_id, "RUNNING", started, None, None, None, 0, None))
    try:
        frames, env = assemble_sources(store, integration_id)
        env["units"] = units
        transform = config.get("transform") or []
        result = run_dag(frames, transform, env)
        tnames = [s.get("op") for s in transform]

        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_db = out_dir / f"{proj['name']}_v{proj['version']}.db"
        table = proj["name"]
        field_order = [f["field_name"] for f in store.conn.execute(
            "SELECT field_name FROM integration_field WHERE integration_id=?",
            (integration_id,))]
        cols: list[str] = [c for c in field_order
                           if any(c in fr.columns for fr in result)]
        for fr in result:
            for c in fr.columns:
                if c not in cols:
                    cols.append(c)

        con = sqlite3.connect(out_db)
        try:
            con.execute(f'DROP TABLE IF EXISTS "{table}"')
            col_sql = ", ".join(f'"{c}"' for c in cols)
            con.execute(
                f'CREATE TABLE "{table}" (_row_id INTEGER PRIMARY KEY, {col_sql}, '
                f'_source_document_id TEXT, _source_version_id TEXT, '
                f'_source_sheet TEXT, _source_locator TEXT)')
            row_id = 0
            n_lineage = 0
            for fr in result:
                for r, ln in zip(fr.rows, fr.lineage):
                    row_id += 1
                    meta = (ln.get("__frame_meta__") or fr.meta) if isinstance(ln, dict) \
                        else fr.meta
                    con.execute(
                        f'INSERT INTO "{table}" VALUES ({",".join("?" * (len(cols) + 5))})',
                        (row_id, *[r.get(c) for c in cols],
                         meta.get("document_id"), meta.get("version_id"),
                         meta.get("sheet"), meta.get("locator")))
                    for c in cols:
                        e = ln.get(c) if isinstance(ln, dict) else None
                        if not e:
                            continue
                        store.conn.execute(
                            "INSERT OR REPLACE INTO lineage_edge VALUES (?,?,?,?,?,?,?)",
                            (build_id, row_id, c, e.get("payload_id"), e.get("row_idx"),
                             e.get("node_id"), json.dumps(tnames)))
                        n_lineage += 1
            con.commit()
        finally:
            con.close()

        store.conn.execute(
            """UPDATE build_run SET status='SUCCESS', finished_at=?, output_db=?,
                 output_table=?, row_count=?, log=? WHERE build_id=?""",
            (now_iso(), str(out_db), table, row_id,
             json.dumps({"lineage_edges": n_lineage}), build_id))
        store.commit()
        return {"build_id": build_id, "status": "SUCCESS", "output_db": str(out_db),
                "table": table, "rows": row_id, "lineage_edges": n_lineage,
                "frames": len(frames)}
    except Exception as e:
        store.conn.execute(
            "UPDATE build_run SET status='FAILED', finished_at=?, log=? WHERE build_id=?",
            (now_iso(), repr(e), build_id))
        store.commit()
        raise
