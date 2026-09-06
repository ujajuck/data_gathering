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
import re
import sqlite3
from pathlib import Path

import yaml

from kg.integration.dag import BLOCKS, Frame, run_dag
from kg.search import reverse_lookup
from kg.store import KgStore, new_id, now_iso, stable_id

# SQL 식별자/파일명으로 쓰이는 이름 — YAML(신뢰 경계 밖)에서 오므로 화이트리스트
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _validate_config(store: KgStore, config: dict) -> None:
    errors: list[str] = []
    name = config.get("name")
    if not isinstance(name, str) or not _IDENT_RE.match(name):
        errors.append(f"name은 [A-Za-z_][A-Za-z0-9_]* 식별자여야 합니다: {name!r}")
    fields = config.get("fields")
    if not isinstance(fields, list) or not fields:
        errors.append("fields 목록이 비어 있습니다")
    seen: set[str] = set()
    for fdef in fields or []:
        fname = fdef.get("name") if isinstance(fdef, dict) else None
        if not isinstance(fname, str) or not _IDENT_RE.match(fname):
            errors.append(f"필드명은 식별자여야 합니다: {fname!r}")
            continue
        if fname in seen:
            errors.append(f"필드명 중복: {fname}")
        seen.add(fname)
        cid = fdef.get("concept")
        if cid and store.concept(cid) is None:
            errors.append(f"필드 {fname}: 존재하지 않는 concept {cid!r}")
    for i, step in enumerate(config.get("transform") or []):
        op = step.get("op") if isinstance(step, dict) else None
        if op not in BLOCKS:
            errors.append(f"transform[{i}]: 알 수 없는 op {op!r}")
        elif step.get("config") is not None and not isinstance(step["config"], dict):
            errors.append(f"transform[{i}]({op}): config는 매핑이어야 합니다")
        elif op == "value_normalize":
            from kg.normalize import NormalizeError, validate_steps
            for rule in (step.get("config") or {}).get("rules") or []:
                try:
                    validate_steps(rule.get("steps"))
                except NormalizeError as exc:
                    errors.append(f"transform[{i}](value_normalize): {exc}")
    # include_nodes 키는 필드명과 정확히 일치해야 한다 — 오타가 조용히
    # '해당 개념 전체 포함'으로 넘어가는 fail-open을 막는다
    includes = (config.get("sources") or {}).get("include_nodes") or {}
    for key in includes:
        if key not in seen:
            errors.append(f"sources.include_nodes의 키 {key!r}가 필드명과 일치하지 않습니다")
    if errors:
        raise ValueError("프로젝트 정의 오류:\n- " + "\n- ".join(errors))


# ------------------------------------------------------------- definition ---
def delete_project(store: KgStore, integration_id: str) -> None:
    """실패한 웹 빌드의 보상 삭제 — 버전만 쌓이는 유령 프로젝트를 남기지 않는다.
    (build_run/lineage가 이미 붙은 프로젝트는 이력 보존을 위해 지우지 않는다.)"""
    used = store.conn.execute(
        "SELECT 1 FROM build_run WHERE integration_id=? AND status='SUCCESS' LIMIT 1",
        (integration_id,)).fetchone()
    if used:
        return
    for sql in (
        "DELETE FROM lineage_edge WHERE build_id IN "
        "  (SELECT build_id FROM build_run WHERE integration_id=?)",
        "DELETE FROM build_run WHERE integration_id=?",
        "DELETE FROM transformation_edge WHERE integration_id=?",
        "DELETE FROM transformation_node WHERE integration_id=?",
        "DELETE FROM source_selection WHERE field_id IN "
        "  (SELECT field_id FROM integration_field WHERE integration_id=?)",
        "DELETE FROM integration_field WHERE integration_id=?",
        "DELETE FROM integration_project WHERE integration_id=?",
    ):
        store.conn.execute(sql, (integration_id,))
    store.commit()


def define_project(store: KgStore, config: dict | str | Path) -> str:
    """프로젝트 정의 저장 (idempotent: 같은 이름은 새 버전으로 대체)."""
    if not isinstance(config, dict):
        config = yaml.safe_load(Path(config).read_text(encoding="utf-8"))
    _validate_config(store, config)
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
def _row_join_key(row) -> str:
    if row["row_key"]:
        return str(row["row_key"])
    addr = row["cell_address"] or ""
    digits = "".join(ch for ch in addr if ch.isdigit())
    return f"@r{digits or row['row_idx']}"


def assemble_sources(store: KgStore, integration_id: str) -> tuple[list[Frame], dict]:
    """source_selection → Region 단위 Frame 목록 + env(단위/필드 메타).

    수백 문서 규모 대비: 노드당 개별 조회(N×3+ 쿼리, TABLE 조상 탐색까지
    노드당 최대 10쿼리) 대신 벌크 쿼리 몇 번으로 같은 결과를 만든다.
    조립 의미론(발생 순서 #n, scope 브로드캐스트)은 그대로다.
    """
    fields = store.conn.execute(
        "SELECT * FROM integration_field WHERE integration_id=?",
        (integration_id,)).fetchall()
    field_units = {f["field_name"]: f["target_unit"] for f in fields
                   if f["target_unit"]}
    node_units: dict[str, str] = {}

    # 선택 노드 + 현재 payload를 한 번에 (필드 정의 순서 보존)
    sel_rows = store.conn.execute(
        """SELECT f.field_name, n.node_id, n.document_id, n.parent_node_id,
                  n.unit, n.tree_path, n.locator, p.payload_id, p.version_id
             FROM integration_field f
             JOIN source_selection s ON s.field_id=f.field_id AND s.enabled=1
             JOIN tree_node n ON n.node_id=s.tree_node_id AND n.status='ACTIVE'
             JOIN data_payload p ON p.tree_node_id=n.node_id AND p.is_current=1
            WHERE f.integration_id=?
            ORDER BY f.rowid, n.node_id""", (integration_id,)).fetchall()

    # TABLE 조상 탐색을 메모리에서 — 관련 문서의 노드 골격만 한 번에 적재
    doc_ids = sorted({r["document_id"] for r in sel_rows})
    skeleton: dict[str, tuple[str | None, str, str | None]] = {}
    for i in range(0, len(doc_ids), 500):
        chunk = doc_ids[i:i + 500]
        for n in store.conn.execute(
                f"""SELECT node_id, parent_node_id, node_type, locator
                      FROM tree_node
                     WHERE document_id IN ({",".join("?" * len(chunk))})""",
                chunk):
            skeleton[n["node_id"]] = (n["parent_node_id"], n["node_type"],
                                      n["locator"])

    def table_ancestor(nid: str) -> str | None:
        cur, seen = nid, 0
        while cur in skeleton and seen < 10:
            parent, ntype, _ = skeleton[cur]
            if ntype == "TABLE":
                return cur
            if parent is None:
                return None
            cur, seen = parent, seen + 1
        return None

    filenames = {}
    for i in range(0, len(doc_ids), 500):
        chunk = doc_ids[i:i + 500]
        filenames.update({r["document_id"]: r["filename"] for r in store.conn.execute(
            f"SELECT document_id, filename FROM document "
            f"WHERE document_id IN ({','.join('?' * len(chunk))})", chunk)})

    # payload_value 전체를 payload별로 한 번에 프리페치 — 셀 수가 수십만이라
    # Row 객체 대신 튜플로 받는다 (문자열 키 인덱싱 비용 제거)
    payload_ids = sorted({r["payload_id"] for r in sel_rows})
    by_payload: dict[str, list[tuple]] = {p: [] for p in payload_ids}
    raw = store.conn.cursor()
    raw.row_factory = None
    for i in range(0, len(payload_ids), 500):
        chunk = payload_ids[i:i + 500]
        for t in raw.execute(
                f"""SELECT payload_id, row_idx, row_key, value_num, value_text,
                           cell_address
                      FROM payload_value
                     WHERE payload_id IN ({",".join("?" * len(chunk))})
                     ORDER BY payload_id, row_idx""", chunk):
            by_payload[t[0]].append(t)

    # region_id → field_name → [(node, payload)]  — 기존과 같은 구조/순서
    regions: dict[str, dict[str, list]] = {}
    region_meta: dict[str, dict] = {}
    for r in sel_rows:
        if r["unit"]:
            node_units[r["node_id"]] = r["unit"]
        region = table_ancestor(r["node_id"]) or r["node_id"]
        regions.setdefault(region, {}).setdefault(r["field_name"], []).append(r)
        if region not in region_meta:
            reg_locator = skeleton.get(region, (None, None, None))[2]
            region_meta[region] = {
                "document_id": r["document_id"],
                "document": filenames.get(r["document_id"], r["document_id"]),
                "version_id": r["version_id"],
                "sheet": (r["tree_path"].split("/") + [""])[1],
                "locator": (reg_locator or r["locator"]) or "",
            }

    frames: list[Frame] = []
    for region, by_field in regions.items():
        cols = list(by_field.keys())
        keys: list[str] = []
        cells: dict[str, dict[str, tuple]] = {}      # key → col → (value, lineage)
        # 같은 (열, 키)가 다시 나오면 발생 순서(#n)로 새 행을 만든다 — 반복
        # row_key/같은 필드의 복수 노드가 서로의 값을 침묵 폐기하지 않도록.
        occ: dict[tuple[str, str], int] = {}
        for col, node_pays in by_field.items():
            for pay in node_pays:       # 벌크 행이 노드+payload 정보를 함께 갖는다
                pid, nid = pay["payload_id"], pay["node_id"]
                unit, ver = pay["unit"], pay["version_id"]
                for _p, row_idx, row_key, vnum, vtext, cell in by_payload[pid]:
                    if row_key:
                        base = str(row_key)
                    else:               # _row_join_key와 동일 — 핫루프 인라인
                        digits = "".join(ch for ch in (cell or "") if ch.isdigit())
                        base = f"@r{digits or row_idx}"
                    n = occ.get((col, base), 0)
                    occ[(col, base)] = n + 1
                    k = base if n == 0 else f"{base}#{n}"
                    if k not in cells:
                        cells[k] = {}
                        keys.append(k)
                    cells[k][col] = (
                        vnum if vnum is not None else vtext,
                        {"payload_id": pid, "row_idx": row_idx, "node_id": nid,
                         "unit": unit, "version_id": ver, "cell": cell})

        # 전치(rescue/caption) 표의 scope 정합: 값 셀 키가 'base@0' 꼴이고
        # 'base' 키를 가진 라벨/속성 셀(variant 등)이 따로 있으면, 그 값을
        # scope('base')를 공유하는 모든 행에 브로드캐스트한다 — 라벨 행과 값
        # 행이 영영 조인되지 않는 키 불일치를 해소한다.
        scoped = {k: k.split("@", 1)[0] for k in keys if "@" in k}
        if scoped:
            scope_rows: dict[str, list[str]] = {}
            for k, sc in scoped.items():
                scope_rows.setdefault(sc, []).append(k)
            drop: set[str] = set()
            for k in list(keys):
                if "@" in k or k.split("#", 1)[0] not in scope_rows:
                    continue
                sc = k.split("#", 1)[0]
                for target in scope_rows[sc]:
                    for col, cell in cells[k].items():
                        cells[target].setdefault(col, cell)
                drop.add(k)                       # scope 라벨 전용 행은 흡수 후 제거
            keys = [k for k in keys if k not in drop]

        fr = Frame(cols, meta=region_meta[region])
        for k in keys:
            fr.rows.append({c: cells[k].get(c, (None, None))[0] for c in cols})
            fr.lineage.append({c: cells[k].get(c, (None, None))[1] for c in cols})
        frames.append(fr)
    env = {"field_units": field_units, "node_units": node_units}
    return frames, env


def _load_transform_chain(store: KgStore, integration_id: str) -> list[dict]:
    """transformation_node/edge에서 선형 체인을 복원한다 — 실행의 단일 원천."""
    nodes = {r["node_id"]: r for r in store.conn.execute(
        "SELECT * FROM transformation_node WHERE integration_id=?", (integration_id,))}
    if not nodes:
        return []
    targets = {r["to_node_id"] for r in store.conn.execute(
        "SELECT to_node_id FROM transformation_edge WHERE integration_id=?",
        (integration_id,))}
    nexts = {r["from_node_id"]: r["to_node_id"] for r in store.conn.execute(
        "SELECT from_node_id, to_node_id FROM transformation_edge "
        "WHERE integration_id=?", (integration_id,))}
    heads = [nid for nid in nodes if nid not in targets]
    if len(heads) != 1 and len(nodes) > 1:
        raise ValueError("transformation DAG가 선형 체인이 아닙니다")
    chain: list[dict] = []
    cur = heads[0] if heads else None
    seen: set[str] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        n = nodes[cur]
        chain.append({"op": n["operation_type"], "config": json.loads(n["config"])})
        cur = nexts.get(cur)
    if len(chain) != len(nodes):
        raise ValueError("transformation DAG에 도달 불가 노드가 있습니다")
    return chain


# ---------------------------------------------------------- 증분(서명) ----
def build_signature(store: KgStore, config: dict, units_version: str = "") -> str:
    """빌드 입력의 내용 서명 — 같은 서명이면 같은 산출물이 나온다.

    구성(필드/변환/선택 노드) + 선택 노드들의 '현재 payload_id'(문서 버전이
    바뀌면 payload가 바뀐다) + 단위 사전 버전으로 만든다. 템플릿/선택/원본이
    안 바뀐 재빌드는 이 서명이 같아 이전 산출물을 즉시 재사용할 수 있다.
    """
    node_ids = sorted({nid for ids in
                       ((config.get("sources") or {}).get("include_nodes")
                        or {}).values() for nid in ids})
    payloads: list[str] = []
    for i in range(0, len(node_ids), 500):
        chunk = node_ids[i:i + 500]
        payloads.extend(r[0] for r in store.conn.execute(
            f"""SELECT payload_id FROM data_payload
                 WHERE is_current=1 AND tree_node_id IN
                       ({",".join("?" * len(chunk))})""", chunk))
    basis = json.dumps({
        "name": config.get("name"), "fields": config.get("fields"),
        "sources": config.get("sources"), "transform": config.get("transform"),
        "payloads": sorted(payloads), "units": units_version,
    }, ensure_ascii=False, sort_keys=True)
    return stable_id(basis)


def find_reusable_build(store: KgStore, config: dict,
                        units_version: str = "") -> dict | None:
    """같은 서명의 최근 SUCCESS 빌드 — 산출 파일이 남아 있으면 재사용.

    include_nodes가 없는 구성(역탐색 자동 선택)은 서명이 데이터 상태를
    포착하지 못하므로 재사용하지 않는다 — 잘못된 재사용보다 재계산이 낫다.
    """
    if not ((config.get("sources") or {}).get("include_nodes") or {}):
        return None
    sig = build_signature(store, config, units_version)
    rows = store.conn.execute(
        """SELECT b.* FROM build_run b
             JOIN integration_project p ON p.integration_id=b.integration_id
            WHERE b.status='SUCCESS' AND p.name=?
            ORDER BY b.finished_at DESC LIMIT 25""",
        (config.get("name"),)).fetchall()
    for b in rows:
        try:
            log = json.loads(b["log"] or "{}")
        except ValueError:
            continue
        if log.get("signature") != sig:
            continue
        if not b["output_db"] or not Path(b["output_db"]).exists():
            continue
        return {"build_id": b["build_id"], "status": "SUCCESS",
                "output_db": b["output_db"], "table": b["output_table"],
                "rows": b["row_count"], "lineage_edges": log.get("lineage_edges", 0),
                "frames": log.get("frames", 0),
                "warnings": log.get("warnings") or [], "reused": True}
    return None


# ------------------------------------------------------------------ build ---
# 3단계로 나뉜다 — 웹 서버가 CPU 구간(execute_dag) 동안 전역 락을 놓을 수
# 있도록. prepare/finalize만 DB를 만지고, execute_dag는 순수 계산이다.

def prepare_build(store: KgStore, integration_id: str, units=None) -> dict:
    """소스 조립 + RUNNING 레코드 생성 (DB 읽기/쓰기 — 락 안에서 호출)."""
    proj = store.conn.execute(
        "SELECT * FROM integration_project WHERE integration_id=?",
        (integration_id,)).fetchone()
    if proj is None:
        raise KeyError(integration_id)
    signature = build_signature(store, json.loads(proj["config_json"]),
                                getattr(units, "version", "") or "")
    frames, env = assemble_sources(store, integration_id)
    env["units"] = units
    # 저장된 transformation_node/edge 체인이 실행의 단일 원천이다 (§13.4) —
    # config_json은 정의 원본 보존용. 체인이 없으면(빈 transform) 그대로 통과.
    transform = _load_transform_chain(store, integration_id)
    field_order = [f["field_name"] for f in store.conn.execute(
        "SELECT field_name FROM integration_field WHERE integration_id=?",
        (integration_id,))]
    build_id = new_id("BLD")
    # lineage_edge가 build_id를 FK로 참조하므로 finalize 전에 레코드를 만든다.
    # 조립이 다 성공한 뒤에 만들어야 실패 시 유령 RUNNING 행이 남지 않는다.
    store.conn.execute(
        "INSERT INTO build_run VALUES (?,?,?,?,?,?,?,?,?)",
        (build_id, integration_id, "RUNNING", now_iso(), None, None, None, 0, None))
    store.commit()
    return {"build_id": build_id, "integration_id": integration_id,
            "name": proj["name"], "version": proj["version"],
            "frames": frames, "env": env, "transform": transform,
            "field_order": field_order, "n_frames": len(frames),
            "signature": signature}


def execute_dag(prep: dict) -> list[Frame]:
    """변환 DAG 실행 — 순수 CPU 작업. DB 락 없이 호출해도 된다."""
    return run_dag(prep["frames"], prep["transform"], prep["env"])


def serialize_result(prep: dict, result: list[Frame]):
    """결과 Frame → (cols, 산출 행, lineage 행) 직렬화 — 순수 CPU 작업.

    finalize가 락 안에서 하던 일 중 가장 무거운 구간이라 따로 뗐다. 웹은
    이 함수를 락 밖에서 호출해 prep['_serialized']에 실어 finalize에 넘긴다.
    """
    build_id = prep["build_id"]
    tnames_json = json.dumps([s.get("op") for s in prep["transform"]])
    cols: list[str] = [c for c in prep["field_order"]
                       if any(c in fr.columns for fr in result)]
    for fr in result:
        for c in fr.columns:
            if c not in cols:
                cols.append(c)
    if not cols:
        raise ValueError(
            "빌드할 컬럼이 없습니다 — 소스가 선택되지 않았거나(매핑/역탐색 확인) "
            "transform이 모든 컬럼을 제거했습니다")
    cols = [c for c in cols if _IDENT_RE.match(c) or c == "_valid"]

    out_rows: list[tuple] = []
    lineage_rows: list[tuple] = []
    row_id = 0
    for fr in result:
        for r, ln in zip(fr.rows, fr.lineage):
            row_id += 1
            meta = (ln.get("__frame_meta__") or fr.meta) if isinstance(ln, dict) \
                else fr.meta
            # _source_version_id는 행의 실제 셀 계보에서 취한다 — region
            # 대표 메타와 어긋나지 않게 (§9.2). 계보가 없으면 메타 폴백.
            cell_ver = next((e.get("version_id") for e in
                             (ln.get(c) for c in cols) if e), None) \
                if isinstance(ln, dict) else None
            out_rows.append((row_id, *[r.get(c) for c in cols],
                             meta.get("document_id"),
                             cell_ver or meta.get("version_id"),
                             meta.get("sheet"), meta.get("locator")))
            for c in cols:
                e = ln.get(c) if isinstance(ln, dict) else None
                if e:
                    lineage_rows.append(
                        (build_id, row_id, c, e.get("payload_id"),
                         e.get("row_idx"), e.get("node_id"), tnames_json))
    return cols, out_rows, lineage_rows, row_id


def finalize_build(store: KgStore, prep: dict, result: list[Frame],
                   out_dir: Path) -> dict:
    """산출 DB + lineage 기록 (DB 쓰기 — 락 안에서 호출). 배치 INSERT."""
    env, build_id = prep["env"], prep["build_id"]
    serialized = prep.get("_serialized") or serialize_result(prep, result)
    cols, out_rows, lineage_rows, row_id = serialized

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_db = out_dir / f"{prep['name']}_v{prep['version']}.db"
    table = prep["name"]
    con = sqlite3.connect(out_db)
    try:
        con.execute(f'DROP TABLE IF EXISTS "{table}"')
        col_sql = ", ".join(f'"{c}"' for c in cols)
        con.execute(
            f'CREATE TABLE "{table}" (_row_id INTEGER PRIMARY KEY, {col_sql}, '
            f'_source_document_id TEXT, _source_version_id TEXT, '
            f'_source_sheet TEXT, _source_locator TEXT)')
        con.executemany(
            f'INSERT INTO "{table}" VALUES ({",".join("?" * (len(cols) + 5))})',
            out_rows)
        con.commit()
    finally:
        con.close()
    store.conn.executemany(
        "INSERT OR REPLACE INTO lineage_edge VALUES (?,?,?,?,?,?,?)",
        lineage_rows)

    store.conn.execute(
        """UPDATE build_run SET status='SUCCESS', finished_at=?, output_db=?,
             output_table=?, row_count=?, log=? WHERE build_id=?""",
        (now_iso(), str(out_db), table, row_id,
         json.dumps({"lineage_edges": len(lineage_rows),
                     "warnings": env.get("warnings") or [],
                     "frames": prep["n_frames"],
                     "signature": prep.get("signature")},
                    ensure_ascii=False), build_id))
    store.commit()
    return {"build_id": build_id, "status": "SUCCESS", "output_db": str(out_db),
            "table": table, "rows": row_id, "lineage_edges": len(lineage_rows),
            "frames": prep["n_frames"], "warnings": env.get("warnings") or []}


def mark_build_failed(store: KgStore, build_id: str, error: Exception) -> None:
    store.conn.execute(
        "UPDATE build_run SET status='FAILED', finished_at=?, log=? WHERE build_id=?",
        (now_iso(), repr(error), build_id))
    store.commit()


def build(store: KgStore, integration_id: str, out_dir: Path, units=None) -> dict:
    """단일 호출 편의 래퍼 (CLI/테스트) — 3단계를 순서대로 실행한다."""
    prep = prepare_build(store, integration_id, units)
    try:
        return finalize_build(store, prep, execute_dag(prep), out_dir)
    except Exception as e:
        mark_build_failed(store, prep["build_id"], e)
        raise
