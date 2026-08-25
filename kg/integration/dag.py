"""Transformation DAG 엔진 — §10의 13종 전처리 블록.

블록은 Frame 목록을 받아 Frame 목록을 돌려주는 순수 변환이다. 프로젝트 정의의
transform 목록(선형 DAG)을 순서대로 적용하며, 각 셀의 lineage(payload/행/노드)를
변환을 통과시키며 보존한다 — 통합 결과의 모든 값은 원본 셀까지 역추적된다 (§11).
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field as dc_field

_OPS = {
    "==": lambda a, b: a == b, "!=": lambda a, b: a != b,
    ">": lambda a, b: a is not None and b is not None and a > b,
    ">=": lambda a, b: a is not None and b is not None and a >= b,
    "<": lambda a, b: a is not None and b is not None and a < b,
    "<=": lambda a, b: a is not None and b is not None and a <= b,
    "contains": lambda a, b: b is not None and a is not None and str(b) in str(a),
}


@dataclass
class Frame:
    """행 지향 중간 데이터 + 셀 단위 lineage.

    rows[i][col] = 값
    lineage[i][col] = {"payload_id","row_idx","node_id"} (원본 셀 참조; 파생값은 None)
    meta = 프레임의 출처 (document/version/sheet/locator)
    """
    columns: list[str]
    rows: list[dict] = dc_field(default_factory=list)
    lineage: list[dict] = dc_field(default_factory=list)
    meta: dict = dc_field(default_factory=dict)

    def clone(self) -> "Frame":
        return Frame(list(self.columns), copy.deepcopy(self.rows),
                     copy.deepcopy(self.lineage), dict(self.meta))


class DagError(ValueError):
    pass


def _each_frame(fn):
    def wrapper(frames: list[Frame], config: dict, env: dict) -> list[Frame]:
        return [fn(f.clone(), config or {}, env) for f in frames]
    return wrapper


# ------------------------------------------------------------------ blocks --
@_each_frame
def _select(f: Frame, cfg: dict, env: dict) -> Frame:
    cols = [c for c in (cfg.get("columns") or f.columns) if c in f.columns]
    f.rows = [{c: r.get(c) for c in cols} for r in f.rows]
    f.lineage = [{c: ln.get(c) for c in cols} for ln in f.lineage]
    f.columns = cols
    return f


@_each_frame
def _rename(f: Frame, cfg: dict, env: dict) -> Frame:
    mapping = cfg.get("map") or {}
    f.columns = [mapping.get(c, c) for c in f.columns]
    f.rows = [{mapping.get(c, c): v for c, v in r.items()} for r in f.rows]
    f.lineage = [{mapping.get(c, c): v for c, v in ln.items()} for ln in f.lineage]
    return f


@_each_frame
def _type_cast(f: Frame, cfg: dict, env: dict) -> Frame:
    for col, target in (cfg.get("types") or {}).items():
        for r in f.rows:
            v = r.get(col)
            if v is None:
                continue
            if target == "numeric":
                try:
                    r[col] = float(v)
                except (TypeError, ValueError):
                    r[col] = None
            elif target == "text":
                r[col] = str(v)
    return f


@_each_frame
def _unit_convert(f: Frame, cfg: dict, env: dict) -> Frame:
    """각 셀의 원본 노드 단위 → 필드 target_unit 변환 (units.yaml 기준, §10)."""
    units = env.get("units")
    targets: dict[str, str] = cfg.get("targets") or env.get("field_units") or {}
    node_units: dict[str, str] = env.get("node_units") or {}
    if units is None:
        return f
    for i, r in enumerate(f.rows):
        for col, tgt in targets.items():
            v = r.get(col)
            if v is None or not isinstance(v, (int, float)) or not tgt:
                continue
            ln = f.lineage[i].get(col) or {}
            src_unit = ln.get("unit") or node_units.get(ln.get("node_id") or "", None)
            if not src_unit:
                continue
            try:
                r[col] = round(units.convert(float(v), src_unit, tgt), 6)
            except (ValueError, KeyError):
                pass                # 비호환/미등록 단위 — 원본 보존, 자동 변환 금지 (§15)
    return f


@_each_frame
def _filter(f: Frame, cfg: dict, env: dict) -> Frame:
    col, op, val = cfg.get("column"), cfg.get("op", "=="), cfg.get("value")
    if col is None or op not in _OPS:
        raise DagError(f"filter config invalid: {cfg}")
    keep = [i for i, r in enumerate(f.rows) if _OPS[op](r.get(col), val)]
    f.rows = [f.rows[i] for i in keep]
    f.lineage = [f.lineage[i] for i in keep]
    return f


@_each_frame
def _value_mapping(f: Frame, cfg: dict, env: dict) -> Frame:
    col, mapping = cfg.get("column"), cfg.get("map") or {}
    default = cfg.get("default", "__keep__")
    for r in f.rows:
        v = r.get(col)
        if v in mapping:
            r[col] = mapping[v]
        elif default != "__keep__":
            r[col] = default
    return f


@_each_frame
def _null_handling(f: Frame, cfg: dict, env: dict) -> Frame:
    cols = cfg.get("columns") or f.columns
    mode = cfg.get("mode", "drop")
    if mode == "fill":
        fill = cfg.get("fill_value")
        for r in f.rows:
            for c in cols:
                if r.get(c) is None:
                    r[c] = fill
        return f
    keep = [i for i, r in enumerate(f.rows) if all(r.get(c) is not None for c in cols)]
    f.rows = [f.rows[i] for i in keep]
    f.lineage = [f.lineage[i] for i in keep]
    return f


@_each_frame
def _deduplicate(f: Frame, cfg: dict, env: dict) -> Frame:
    keys = cfg.get("keys") or f.columns
    seen: set = set()
    keep: list[int] = []
    for i, r in enumerate(f.rows):
        k = tuple(r.get(c) for c in keys)
        if k not in seen:
            seen.add(k)
            keep.append(i)
    f.rows = [f.rows[i] for i in keep]
    f.lineage = [f.lineage[i] for i in keep]
    return f


def _union(frames: list[Frame], cfg: dict, env: dict) -> list[Frame]:
    if not frames:
        return frames
    cols: list[str] = []
    for f in frames:
        for c in f.columns:
            if c not in cols:
                cols.append(c)
    out = Frame(cols, meta={"union_of": len(frames)})
    for f in frames:
        for r, ln in zip(f.rows, f.lineage):
            out.rows.append({c: r.get(c) for c in cols})
            merged = {c: ln.get(c) for c in cols}
            merged["__frame_meta__"] = f.meta
            out.lineage.append(merged)
    return [out]


def _join(frames: list[Frame], cfg: dict, env: dict) -> list[Frame]:
    """키 열 기반 full outer join — 같은 키를 공유하는 프레임들을 병합한다."""
    on = cfg.get("on") or []
    if not on:
        raise DagError("join needs config.on")
    joinable = [f for f in frames if all(c in f.columns for c in on)]
    rest = [f for f in frames if f not in joinable]
    if len(joinable) < 2:
        return frames
    cols: list[str] = list(on)
    for f in joinable:
        for c in f.columns:
            if c not in cols:
                cols.append(c)
    by_key: dict[tuple, tuple[dict, dict]] = {}
    order: list[tuple] = []
    for f in joinable:
        for r, ln in zip(f.rows, f.lineage):
            k = tuple(r.get(c) for c in on)
            if k not in by_key:
                by_key[k] = ({c: None for c in cols}, {})
                order.append(k)
            row, lnk = by_key[k]
            for c in f.columns:
                if r.get(c) is not None:
                    row[c] = r.get(c)
                    if ln.get(c) is not None:
                        lnk[c] = ln.get(c)
    out = Frame(cols, [by_key[k][0] for k in order], [by_key[k][1] for k in order],
                meta={"join_on": on})
    return [out, *rest]


def _aggregate(frames: list[Frame], cfg: dict, env: dict) -> list[Frame]:
    group_by = cfg.get("group_by") or []
    aggs: dict[str, str] = cfg.get("aggs") or {}
    out_frames = []
    for f in frames:
        groups: dict[tuple, list[int]] = {}
        for i, r in enumerate(f.rows):
            groups.setdefault(tuple(r.get(c) for c in group_by), []).append(i)
        cols = [*group_by, *aggs.keys()]
        nf = Frame(cols, meta={**f.meta, "aggregated": True})
        for key, idxs in groups.items():
            row = dict(zip(group_by, key))
            ln: dict = {}
            for col, how in aggs.items():
                vals = [f.rows[i].get(col) for i in idxs
                        if isinstance(f.rows[i].get(col), (int, float))]
                if how == "count":
                    row[col] = len(idxs)
                elif not vals:
                    row[col] = None
                elif how == "sum":
                    row[col] = sum(vals)
                elif how == "avg":
                    row[col] = sum(vals) / len(vals)
                elif how == "min":
                    row[col] = min(vals)
                elif how == "max":
                    row[col] = max(vals)
                else:
                    raise DagError(f"unknown agg: {how}")
                first = next((f.lineage[i].get(col) for i in idxs
                              if f.lineage[i].get(col)), None)
                ln[col] = {**first, "aggregated": how} if first else None
            for c in group_by:
                ln.setdefault(c, next((f.lineage[i].get(c) for i in idxs
                                       if f.lineage[i].get(c)), None))
            nf.rows.append(row)
            nf.lineage.append(ln)
        out_frames.append(nf)
    return out_frames


@_each_frame
def _derived_column(f: Frame, cfg: dict, env: dict) -> Frame:
    name, expr = cfg.get("name"), cfg.get("expr") or {}
    op = expr.get("op")
    fns = {"add": lambda a, b: a + b, "sub": lambda a, b: a - b,
           "mul": lambda a, b: a * b, "div": lambda a, b: (a / b) if b else None}
    if not name or op not in fns:
        raise DagError(f"derived_column config invalid: {cfg}")

    def operand(r: dict, side):
        v = expr.get(side)
        if isinstance(v, (int, float)):
            return v
        return r.get(v)

    if name not in f.columns:
        f.columns.append(name)
    for r, ln in zip(f.rows, f.lineage):
        a, b = operand(r, "left"), operand(r, "right")
        r[name] = fns[op](a, b) if isinstance(a, (int, float)) and \
            isinstance(b, (int, float)) else None
        src = expr.get("left") if isinstance(expr.get("left"), str) else expr.get("right")
        base = ln.get(src) if isinstance(src, str) else None
        ln[name] = {**base, "derived": op} if base else None
    return f


@_each_frame
def _validation(f: Frame, cfg: dict, env: dict) -> Frame:
    rules = cfg.get("rules") or []
    mode = cfg.get("mode", "flag")            # flag: _valid 열 추가 / drop: 위반 행 제거
    def ok(r):
        for rule in rules:
            op = rule.get("op", "==")
            if op not in _OPS:
                raise DagError(f"validation op invalid: {rule}")
            if r.get(rule.get("column")) is None:
                continue                       # 결측은 null_handling의 몫
            if not _OPS[op](r.get(rule.get("column")), rule.get("value")):
                return False
        return True
    if mode == "drop":
        keep = [i for i, r in enumerate(f.rows) if ok(r)]
        f.rows = [f.rows[i] for i in keep]
        f.lineage = [f.lineage[i] for i in keep]
        return f
    if "_valid" not in f.columns:
        f.columns.append("_valid")
    for r, ln in zip(f.rows, f.lineage):
        r["_valid"] = 1 if ok(r) else 0
        ln.setdefault("_valid", None)
    return f


BLOCKS = {
    "select": _select, "rename": _rename, "type_cast": _type_cast,
    "unit_convert": _unit_convert, "filter": _filter, "value_mapping": _value_mapping,
    "null_handling": _null_handling, "deduplicate": _deduplicate, "join": _join,
    "union": _union, "aggregate": _aggregate, "derived_column": _derived_column,
    "validation": _validation,
}


def run_dag(frames: list[Frame], transform: list[dict], env: dict) -> list[Frame]:
    """선형 DAG 실행 — 각 단계는 (op, config). 알 수 없는 op는 즉시 오류."""
    for step in transform:
        op = step.get("op")
        if op not in BLOCKS:
            raise DagError(f"unknown transformation op: {op}")
        frames = BLOCKS[op](frames, step.get("config") or {}, env)
    return frames
