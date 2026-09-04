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
_META_KEY = "__frame_meta__"    # union이 심는 행별 소스 메타 — 모든 블록이 보존해야 한다


@_each_frame
def _select(f: Frame, cfg: dict, env: dict) -> Frame:
    cols = [c for c in (cfg.get("columns") or f.columns) if c in f.columns]
    f.rows = [{c: r.get(c) for c in cols} for r in f.rows]
    f.lineage = [{**({_META_KEY: ln[_META_KEY]} if _META_KEY in ln else {}),
                  **{c: ln.get(c) for c in cols}} for ln in f.lineage]
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
    """각 셀의 원본 노드 단위 → 필드 target_unit 변환 (units.yaml 기준, §10).

    변환 후 lineage의 unit을 target으로 갱신한다 — 블록 재적용 시 이중 변환
    금지. 파생/집계 셀(derived/aggregated)은 원본 단위 개념이 없으므로 건드리지
    않는다. 비호환·미등록 단위는 원본 보존(§15)하되 env['warnings']에 집계해
    빌드 로그로 드러낸다 — 침묵 혼입 방지.
    """
    units = env.get("units")
    targets: dict[str, str] = cfg.get("targets") or env.get("field_units") or {}
    node_units: dict[str, str] = env.get("node_units") or {}
    # 양식별 '원값 유지' 전처리 — 이 노드들에서 온 셀은 단위 변환을 생략한다
    skip_nodes: set = set(cfg.get("skip_nodes") or [])
    if units is None:
        return f
    warn: dict[tuple, int] = {}
    for i, r in enumerate(f.rows):
        for col, tgt in targets.items():
            v = r.get(col)
            if v is None or not isinstance(v, (int, float)) or not tgt:
                continue
            ln = f.lineage[i].get(col) or {}
            if ln.get("derived") or ln.get("aggregated"):
                continue
            if ln.get("node_id") in skip_nodes:
                continue
            src_unit = ln.get("unit") or node_units.get(ln.get("node_id") or "", None)
            if not src_unit or src_unit == tgt:
                continue
            try:
                r[col] = round(units.convert(float(v), src_unit, tgt), 6)
                ln["unit"] = tgt              # 변환 완료 표식 — 이중 변환 방지
            except (ValueError, KeyError):
                # 비호환/미등록 — 원본 보존, 자동 변환 금지 (§15). 단, 드러낸다.
                warn[(col, src_unit, tgt)] = warn.get((col, src_unit, tgt), 0) + 1
    if warn:
        env.setdefault("warnings", []).extend(
            {"op": "unit_convert", "column": c, "from": s, "to": t, "cells": n}
            for (c, s, t), n in warn.items())
    return f


@_each_frame
def _value_normalize(f: Frame, cfg: dict, env: dict) -> Frame:
    """선언적 값 정규화 — 원자 연산은 kg.normalize 카탈로그, 조합은 데이터.

    cfg.rules: [{steps:[{op,params}], node_ids?:[...], columns?:[...]}]
    node_ids/columns가 없으면 프레임 전체. 분리된 단위는 lineage.unit에
    실어 뒤따르는 unit_convert가 이어받는다. 적용 이력(normalized)도
    lineage에 남는다 — 출력 셀에서 어떤 정규화를 거쳤는지 추적된다.
    """
    from kg.normalize import apply_steps, validate_steps
    changed: dict[str, int] = {}
    for rule in cfg.get("rules") or []:
        steps = rule.get("steps") or []
        validate_steps(steps)
        node_ids = set(rule.get("node_ids") or [])
        columns = [c for c in (rule.get("columns") or f.columns) if c in f.columns]
        for r, ln_row in zip(f.rows, f.lineage):
            for col in columns:
                v = r.get(col)
                if v is None:
                    continue
                ln = ln_row.get(col) or {}
                if node_ids and ln.get("node_id") not in node_ids:
                    continue
                nv, meta = apply_steps(v, steps, env)
                if nv is v or nv == v:
                    continue
                r[col] = nv
                if isinstance(ln, dict) and ln:
                    if meta.get("unit") and not ln.get("unit"):
                        ln["unit"] = meta["unit"]   # unit_convert로 전달
                    ln["normalized"] = [s["op"] for s in steps]
                changed[col] = changed.get(col, 0) + 1
    if changed:
        env.setdefault("normalized", []).extend(
            {"op": "value_normalize", "column": c, "cells": n}
            for c, n in changed.items())
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
        # 숫자 키는 config JSON 왕복에서 문자열이 되므로 str 표기로도 조회한다
        # (payload 숫자는 float라 180.0 → '180'까지 시도)
        cands = [v, str(v)]
        if isinstance(v, float) and v.is_integer():
            cands.append(str(int(v)))
        key = next((k for k in cands if k in mapping), None)
        if key is not None:
            r[col] = mapping[key]
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
            merged[_META_KEY] = ln.get(_META_KEY) or f.meta
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
            if _META_KEY in ln and _META_KEY not in lnk:
                lnk[_META_KEY] = ln[_META_KEY]
            elif _META_KEY not in lnk and f.meta:
                lnk[_META_KEY] = f.meta
            for c in f.columns:
                if r.get(c) is not None:
                    row[c] = r.get(c)
                    lnk[c] = ln.get(c)      # 값과 계보는 항상 같은 셀에서 온다
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
            first_meta = next((f.lineage[i][_META_KEY] for i in idxs
                               if _META_KEY in f.lineage[i]), None)
            ln: dict = {_META_KEY: first_meta} if first_meta else {}
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
    "value_normalize": _value_normalize,
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
