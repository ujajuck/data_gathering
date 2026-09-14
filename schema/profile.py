"""Parsing Profile DSL 3.0 검증기·컴파일러(계약 §2, §2.1).

validate_profile → 기본값을 채운 canonical dict. compile_rule → 앵커를 인라인한 자기완결 effective_spec.
임의 Python/SQL 표현식을 실행하지 않는다.
"""

from __future__ import annotations

import copy
import re

try:  # 3.11+: sre_parse는 폐기 경고를 낸다.
    from re import _parser as _sre
except ImportError:  # pragma: no cover
    import sre_parse as _sre


from .db import Problem, dump
from .normalization import validate_pipeline
from .spec import MAX_ITEMS, bounds
from .spec import decimal as _decimal

FORMAT, SCHEMA_VERSION = "parsing-profile", "3.0"
ROLES = ("key", "value", "unit", "context")
AREA_KINDS = ("range", "find", "relative", "anchor")
MATCHERS = ("name", "name_regex", "ordinal", "contains_text", "any_of")
VALUE_TYPES = ("text", "decimal", "boolean", "date", "datetime")
RELATION_KINDS = ("same_row", "same_column", "offset")
DEFAULT_WITHIN, DEFAULT_CONTAINS_WITHIN = "A1:AZ100", "A1:AD30"
FIND_CELL_LIMIT, REGEX_LIMIT = 10000, 256
# 이 횟수 이상 반복하는 양화사는 '무제한'으로 보고 그 안의 반복/선택을 거부한다(ReDoS).
REPEAT_NEST_LIMIT = 16
LIMITS = {
    "bytes": 512000,
    "roles": 16,
    "rules": 200,
    "areas": 32,
    "anchors": 64,
    "relations": 4,
    "composite": (2, 8),
    "texts": (1, 50),
    "contains_texts": (1, 20),
}


def _name(value, what, limit=128):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise Problem("INVALID_PROFILE", f"{what} 이름은 1~{limit}자 문자열이어야 합니다.")
    return value


def _unbounded(op, arg):
    return op in (_sre.MAX_REPEAT, _sre.MIN_REPEAT, getattr(_sre, "POSSESSIVE_REPEAT", None)) and arg[1] >= REPEAT_NEST_LIMIT


def _nested_repeat(items, inside):
    """재난적 역추적 후보: 무제한 반복 안의 또 다른 반복/선택(예: (a+)+, (a|a?)*). 파싱 트리를 재귀로 훑는다."""
    for op, arg in items:
        if op in (_sre.MAX_REPEAT, _sre.MIN_REPEAT, getattr(_sre, "POSSESSIVE_REPEAT", None)):
            if inside and arg[1] > 1:
                return True
            if _nested_repeat(arg[2], inside or _unbounded(op, arg)):
                return True
        elif op == _sre.BRANCH:
            if inside:
                return True
            if any(_nested_repeat(branch, inside) for branch in arg[1]):
                return True
        elif op == _sre.SUBPATTERN:
            if _nested_repeat(arg[3], inside):
                return True
        elif op in (_sre.ASSERT, _sre.ASSERT_NOT):
            if _nested_repeat(arg[1], inside):
                return True
    return False


def compile_regex(pattern):
    """`find.regex`·`name_regex` 공통 규칙: 256자 이하, re.compile 가능, 인라인 플래그만, 중첩 반복 금지(ReDoS)."""
    if not isinstance(pattern, str) or not 1 <= len(pattern) <= REGEX_LIMIT:
        raise Problem("INVALID_REGEX", "정규식은 1~256자 문자열이어야 합니다.")
    try:
        compiled = re.compile(pattern)
        parsed = _sre.parse(pattern)
    except (re.error, ValueError, OverflowError) as exc:
        raise Problem("INVALID_REGEX", f"정규식이 유효하지 않습니다: {exc}") from None
    # 사용자 정규식은 Reader 프로세스에서 셀 1만 개 × 1,024자에 대해 돌므로 지수 역추적 패턴은 저장 단계에서 거른다.
    if _nested_repeat(list(parsed), False):
        raise Problem("INVALID_REGEX", "무제한 반복 안에 반복이나 선택(|)을 겹쳐 쓸 수 없습니다(예: (a+)+, (a|b)*). 반복 횟수를 제한하거나 패턴을 나누세요.")
    return compiled


def _texts(texts, limits, what, code="INVALID_SELECTOR"):
    low, high = limits
    if (
        not isinstance(texts, list)
        or not low <= len(texts) <= high
        or any(not isinstance(t, str) or not 1 <= len(t) <= 512 for t in texts)
    ):
        raise Problem(code, f"{what}: 검색할 텍스트를 {low}~{high}개 지정하세요.")
    return list(texts)


def validate_find(find, what="find"):
    """texts|regex 중 하나 + within(+occurrence). regex는 within 필수. 기본값을 채운 사본."""
    if not isinstance(find, dict) or ("texts" in find) == ("regex" in find):
        raise Problem("INVALID_SELECTOR", f"{what}: texts 또는 regex 중 하나를 지정하세요.")
    if not set(find) <= {"texts", "regex", "within", "occurrence"}:
        raise Problem("INVALID_SELECTOR", f"{what}: 알 수 없는 검색 속성이 있습니다.")
    out = {}
    if "texts" in find:
        out["texts"] = _texts(find["texts"], LIMITS["texts"], what)
        within = find.get("within", DEFAULT_WITHIN)
    else:
        compile_regex(find["regex"])
        out["regex"] = find["regex"]
        if "within" not in find:
            raise Problem("INVALID_SELECTOR", f"{what}: regex 검색에는 within이 필수입니다.")
        within = find["within"]
    r1, c1, r2, c2 = bounds(within)
    if (r2 - r1 + 1) * (c2 - c1 + 1) > FIND_CELL_LIMIT:
        raise Problem("RANGE_LIMIT", "키 검색 범위는 10,000셀 이하로 지정하세요.", 413)
    out["within"] = within
    if "occurrence" in find:
        if type(find["occurrence"]) is not int or find["occurrence"] < 0:
            raise Problem("INVALID_SELECTOR", "검색 일치 순서는 0 이상의 정수여야 합니다.")
        out["occurrence"] = find["occurrence"]
    return out


def validate_matcher(match, role):
    if not isinstance(match, dict) or len(match) != 1 or next(iter(match)) not in MATCHERS:
        raise Problem(
            "INVALID_SHEET_ROLE",
            f"시트 역할 {role}: match는 name/name_regex/ordinal/contains_text/any_of 중 하나여야 합니다.",
        )
    kind, value = next(iter(match.items()))
    if kind == "name":
        if not isinstance(value, str) or not value:
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: name은 비어 있지 않은 문자열이어야 합니다.")
        return {"name": value}
    if kind == "name_regex":
        compile_regex(value)
        return {"name_regex": value}
    if kind == "ordinal":
        if type(value) is not int or value < 0:
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: ordinal은 0 이상의 정수여야 합니다.")
        return {"ordinal": value}
    if kind == "contains_text":
        if not isinstance(value, dict) or not set(value) <= {"texts", "within", "mode"}:
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: contains_text 정의가 유효하지 않습니다.")
        texts = _texts(value.get("texts"), LIMITS["contains_texts"], f"시트 역할 {role}", "INVALID_SHEET_ROLE")
        within = value.get("within", DEFAULT_CONTAINS_WITHIN)
        r1, c1, r2, c2 = bounds(within)
        if (r2 - r1 + 1) * (c2 - c1 + 1) > FIND_CELL_LIMIT:
            raise Problem("RANGE_LIMIT", "시트 판별 검색 범위는 10,000셀 이하로 지정하세요.", 413)
        mode = value.get("mode", "any")
        if mode not in ("any", "all"):
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: mode는 any/all 중 하나여야 합니다.")
        return {"contains_text": {"texts": texts, "within": within, "mode": mode}}
    if not isinstance(value, list) or not 1 <= len(value) <= 16:
        raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: any_of는 1~16개의 판별자 목록이어야 합니다.")
    # any_of 안의 any_of는 의미가 없으므로 깊이 1로 제한한다.
    items = []
    for item in value:
        if isinstance(item, dict) and "any_of" in item:
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}: any_of는 중첩할 수 없습니다.")
        items.append(validate_matcher(item, role))
    return {"any_of": items}


def _validate_sheet_roles(roles):
    if not isinstance(roles, dict) or not 1 <= len(roles) <= LIMITS["roles"]:
        raise Problem("INVALID_PROFILE", "시트 역할을 1~16개 지정하세요.")
    out = {}
    for role, definition in roles.items():
        _name(role, "시트 역할")
        if not isinstance(definition, dict):
            raise Problem("INVALID_SHEET_ROLE", f"시트 역할 {role}의 정의가 유효하지 않습니다.")
        cardinality = definition.get("cardinality", "one")
        if cardinality not in ("one", "many"):
            raise Problem("INVALID_SHEET_ROLE", "시트 역할은 one/many 중 하나여야 합니다.")
        item = {"cardinality": cardinality}
        if "match" in definition and definition["match"] is not None:
            item["match"] = validate_matcher(definition["match"], role)
        if definition.get("description") is not None:
            item["description"] = str(definition["description"])[:1000]
        out[role] = item
    return out


def _validate_anchors(anchors, roles):
    if anchors is None:
        return {}
    if not isinstance(anchors, dict) or len(anchors) > LIMITS["anchors"]:
        raise Problem("INVALID_ANCHOR", "앵커는 64개 이하의 이름 → 정의 객체여야 합니다.")
    out, composites = {}, {}
    for name, definition in anchors.items():
        _name(name, "앵커")
        if not isinstance(definition, dict):
            raise Problem("INVALID_ANCHOR", f"앵커 {name}의 정의가 유효하지 않습니다.")
        if "all_of" in definition:
            if set(definition) != {"all_of"}:
                raise Problem("INVALID_ANCHOR", f"앵커 {name}: composite 앵커는 all_of만 가집니다.")
            composites[name] = definition["all_of"]
            continue
        if set(definition) != {"sheet_role", "find"}:
            raise Problem("INVALID_ANCHOR", f"앵커 {name}: {{sheet_role, find}} 또는 {{all_of}}여야 합니다.")
        if definition["sheet_role"] not in roles:
            raise Problem("INVALID_SHEET_ROLE", f"앵커 {name}이 선언되지 않은 시트 역할을 참조합니다.")
        out[name] = {
            "sheet_role": definition["sheet_role"],
            "find": validate_find(definition["find"], f"앵커 {name}"),
        }
    low, high = LIMITS["composite"]
    for name, members in composites.items():
        if (
            not isinstance(members, list)
            or not low <= len(members) <= high
            or len(set(members)) != len(members)
        ):
            raise Problem("INVALID_ANCHOR", f"앵커 {name}: all_of는 서로 다른 단일 앵커 2~8개여야 합니다.")
        for member in members:
            if member in composites or member not in out:
                # 깊이 1: composite의 멤버는 모두 단일 앵커여야 한다.
                raise Problem("INVALID_ANCHOR", f"앵커 {name}: 멤버 {member}는 존재하는 단일 앵커여야 합니다.")
        role = {out[m]["sheet_role"] for m in members}
        if len(role) != 1:
            raise Problem("INVALID_ANCHOR", f"앵커 {name}: 멤버는 같은 시트 역할이어야 합니다.")
        out[name] = {"sheet_role": role.pop(), "all_of": list(members)}
    return out


def _validate_area(area, roles, anchors, where, rule_key):
    if not isinstance(area, dict) or area.get("sheet_role") not in roles:
        raise Problem("INVALID_SHEET_ROLE", f"{rule_key}: {where} 영역이 선언되지 않은 시트 역할을 참조합니다.")
    kinds = [k for k in AREA_KINDS if k in area]
    if len(kinds) != 1 or not set(area) <= {"sheet_role", *AREA_KINDS}:
        raise Problem("INVALID_SELECTOR", f"{rule_key}: {where} 영역은 range/find/relative/anchor 중 하나로 지정하세요.")
    role, kind = area["sheet_role"], kinds[0]
    out = {"sheet_role": role}
    if kind == "range":
        r1, c1, r2, c2 = bounds(area["range"])
        if (r2 - r1 + 1) * (c2 - c1 + 1) > MAX_ITEMS:
            raise Problem("RANGE_LIMIT", "영역당 100,000셀 이하로 나누어 지정하세요.", 413)
        out["range"] = area["range"]
    elif kind == "find":
        out["find"] = validate_find(area["find"], f"{rule_key} {where}")
    elif kind == "relative":
        relative = area["relative"]
        if not isinstance(relative, dict) or not set(relative) <= {"row", "col", "rows", "cols", "anchor"}:
            raise Problem("INVALID_SELECTOR", f"{rule_key}: 상대 위치 정의가 유효하지 않습니다.")
        if any(type(relative.get(k, d)) is not int for k, d in (("row", 0), ("col", 0), ("rows", 1), ("cols", 1))):
            raise Problem("INVALID_SELECTOR", "상대 위치는 정수여야 합니다.")
        rows, cols = relative.get("rows", 1), relative.get("cols", 1)
        if not (1 <= rows <= MAX_ITEMS and 1 <= cols <= 16384) or rows * cols > MAX_ITEMS:
            raise Problem("RANGE_LIMIT", "상대 범위가 너무 큽니다.", 413)
        if abs(relative.get("row", 0)) > 1048576 or abs(relative.get("col", 0)) > 16384:
            raise Problem("INVALID_SELECTOR", "상대 위치가 Excel 범위를 벗어납니다.")
        out["relative"] = {"row": relative.get("row", 0), "col": relative.get("col", 0), "rows": rows, "cols": cols}
        if "anchor" in relative:
            _anchor_ref(relative["anchor"], role, anchors, rule_key, where)
            out["relative"]["anchor"] = relative["anchor"]
    else:
        _anchor_ref(area["anchor"], role, anchors, rule_key, where)
        out["anchor"] = area["anchor"]
    return out


def _anchor_ref(name, role, anchors, rule_key, where):
    if not isinstance(name, str) or name not in anchors:
        raise Problem("INVALID_ANCHOR", f"{rule_key}: {where} 영역이 선언되지 않은 앵커 {name!r}를 참조합니다.")
    if anchors[name]["sheet_role"] != role:
        raise Problem(
            "INVALID_ANCHOR",
            f"{rule_key}: 앵커 {name}의 시트 역할({anchors[name]['sheet_role']})과 영역의 시트 역할({role})이 다릅니다.",
        )


def _validate_value_spec(spec, rule_key):
    spec = copy.deepcopy(spec) if spec is not None else {}
    if not isinstance(spec, dict):
        raise Problem("INVALID_TYPE", f"{rule_key}: value_spec은 객체여야 합니다.")
    target = spec.setdefault("type", "text")
    if target not in VALUE_TYPES:
        raise Problem("INVALID_TYPE", "지원하는 값 타입은 decimal/text/boolean/date/datetime입니다.")
    if spec.setdefault("formula_policy", "cached_only") != "cached_only":
        raise Problem("UNSUPPORTED_FORMULA", "원본 수정 없이 저장된 수식 결과만 읽습니다.")
    for key in ("unit", "source_unit"):
        if spec.get(key) is not None and (not isinstance(spec[key], str) or len(spec[key]) > 64):
            raise Problem("INVALID_TYPE", f"{rule_key}: {key}는 64자 이하 문자열이어야 합니다.")
        spec.setdefault(key, None)
    normal = spec.get("normalization")
    if normal is None:
        normal = {"operation": "identity", "version": "1"}
    if not isinstance(normal, dict) or normal.get("operation", "identity") not in ("identity", "trim", "affine", "pipeline"):
        raise Problem("UNSUPPORTED_NORMALIZER", "등록되지 않은 변환입니다.")
    operation = normal.setdefault("operation", "identity")
    if operation == "pipeline":
        normal = validate_pipeline(normal, target)
    elif (operation == "affine" and target != "decimal") or (operation == "trim" and target != "text"):
        raise Problem("NORMALIZER_TYPE_MISMATCH", "affine은 decimal, trim은 text에 적용하세요.")
    if operation == "affine":
        _decimal(normal.get("factor", "1"))
        _decimal(normal.get("offset", "0"))
        normal.setdefault("factor", "1")
        normal.setdefault("offset", "0")
    normal.setdefault("version", "1")
    spec["normalization"] = normal
    return spec


def _validate_record_spec(records, rule_key):
    if records is None:
        return {"scope": [rule_key], "key": "coordinate"}
    if not isinstance(records, dict):
        raise Problem("INVALID_RECORD_SCOPE", f"{rule_key}: record_spec은 객체여야 합니다.")
    scope = records.get("scope", [rule_key])
    if (
        not isinstance(scope, list)
        or not 1 <= len(scope) <= 8
        or any(not isinstance(s, str) or not 1 <= len(s) <= 128 for s in scope)
    ):
        raise Problem("INVALID_RECORD_SCOPE", "표/반복 블록을 구분할 레코드 범위를 지정하세요.")
    key = records.get("key", "coordinate")
    if key is None:
        # 명시적 null: relations 짝이 없으면 record_key NULL(실패 아님).
        return {"scope": list(scope), "key": None}
    if not (
        key in ("coordinate", "physical_row", "physical_column")
        if isinstance(key, str)
        else isinstance(key, dict) and ("column" in key or "row" in key)
    ):
        raise Problem("INVALID_RECORD_KEY", "물리 행/열/좌표 또는 업무키 행/열을 지정하세요.")
    if isinstance(key, dict):
        if len(key) != 1 or ("row" in key and (type(key["row"]) is not int or not 1 <= key["row"] <= 1048576)):
            raise Problem("INVALID_RECORD_KEY", "업무키 행/열 하나를 지정하세요.")
        if "column" in key:
            bounds(str(key["column"]) + "1")
        key = dict(key)
    return {"scope": list(scope), "key": key}


def _validate_selection(source, role, roles, anchors, rule_key):
    if not isinstance(source, dict) or not isinstance(source.get("areas"), list) or not 1 <= len(source["areas"]) <= LIMITS["areas"]:
        raise Problem("INVALID_SELECTOR", f"{rule_key}: {role} 영역은 1~32개여야 합니다.")
    out = {"areas": [_validate_area(a, roles, anchors, role, rule_key) for a in source["areas"]]}
    if role == "key":
        first = out["areas"][0]
        if "relative" in first and "anchor" not in first["relative"]:
            raise Problem("INVALID_SELECTOR", f"{rule_key}: 키의 첫 영역이 relative이면 relative.anchor가 필요합니다.")
        repeat = source.get("repeat", "once")
        if repeat not in ("once", "each"):
            raise Problem("INVALID_REPEAT", "키 반복은 once/each 중 하나여야 합니다.")
        out["repeat"] = repeat
    separator = source.get("separator", " ")
    if not isinstance(separator, str) or len(separator) > 64:
        raise Problem("INVALID_SELECTOR", f"{rule_key}: separator는 64자 이하 문자열이어야 합니다.")
    out["separator"] = separator
    if role != "value":
        return out
    if source.get("merge_policy", "anchor_once") != "anchor_once" or source.get("blank_policy", "preserve") != "preserve":
        raise Problem("UNSUPPORTED_POLICY", "병합 셀은 anchor_once, 빈칸은 preserve 정책을 지원합니다.")
    out["merge_policy"], out["blank_policy"] = "anchor_once", "preserve"
    cardinality, axis = source.get("cardinality", "scalar"), source.get("axis", "none")
    allowed = {"scalar": {"none"}, "list": {"down", "right"}, "matrix": {"row_major", "column_major"}}
    if cardinality not in allowed or axis not in allowed[cardinality]:
        raise Problem("INVALID_DIRECTION", "값 모양과 가로/세로 방향이 일치하지 않습니다.")
    # engine.extract의 런타임 기본값: list+down → one_per_row, list+right → one_per_column, 그 외 each_cell.
    layout = source.get(
        "element_layout",
        "one_per_row" if (cardinality, axis) == ("list", "down") else "one_per_column" if (cardinality, axis) == ("list", "right") else "each_cell",
    )
    if layout not in ("each_cell", "one_per_row", "one_per_column"):
        raise Problem("INVALID_LAYOUT", "리스트 항목은 each_cell/one_per_row/one_per_column 중 하나여야 합니다.")
    if cardinality == "list" and ((layout == "one_per_row" and axis != "down") or (layout == "one_per_column" and axis != "right")):
        raise Problem("INVALID_LAYOUT", "행별 값은 down, 열별 값은 right 방향으로 지정하세요.")
    combine = source.get("combine", "ordered_union")
    if combine not in ("ordered_union", "concat", "sum"):
        raise Problem("UNSUPPORTED_COMBINE", "현재 결합은 ordered_union/concat/sum을 지원합니다. 시트 간 조인은 통합 DB에서 지정하세요.")
    if cardinality != "scalar" and combine != "ordered_union":
        raise Problem("UNSUPPORTED_COMBINE", "concat/sum 결합은 단일 값에서 지정하세요.")
    stop = source.get("stop") or {"kind": "explicit_areas", "max_items": 10000}
    if not isinstance(stop, dict) or stop.get("kind", "explicit_areas") not in ("explicit_areas", "blank_run"):
        raise Problem("INVALID_STOP", "종료 조건과 최대 항목 수를 지정하세요.")
    max_items = stop.get("max_items", 10000)
    if type(max_items) is not int or not 1 <= max_items <= MAX_ITEMS:
        raise Problem("INVALID_STOP", "종료 조건과 최대 항목 수를 지정하세요.")
    canonical_stop = {"kind": stop.get("kind", "explicit_areas"), "max_items": max_items}
    if canonical_stop["kind"] == "blank_run":
        count = stop.get("count", 1)
        if type(count) is not int or not 1 <= count <= 100:
            raise Problem("INVALID_STOP", "빈칸 종료 수는 1~100이어야 합니다.")
        canonical_stop["count"] = count
    out.update(cardinality=cardinality, axis=axis, element_layout=layout, combine=combine, stop=canonical_stop)
    return out


def _validate_relations(rule, rules_by_key):
    relations = rule.get("relations") or []
    key = rule["rule_key"]
    if not isinstance(relations, list) or len(relations) > LIMITS["relations"]:
        raise Problem("INVALID_RELATION", f"{key}: relations는 4개 이하 목록이어야 합니다.")
    out = []
    primary = rule["selector"]["key"]["areas"][0]["sheet_role"]
    for relation in relations:
        if not isinstance(relation, dict) or not set(relation) <= {"to_rule", "kind", "row", "col"}:
            raise Problem("INVALID_RELATION", f"{key}: relation 정의가 유효하지 않습니다.")
        to_rule, kind = relation.get("to_rule"), relation.get("kind")
        if kind not in RELATION_KINDS:
            raise Problem("INVALID_RELATION", f"{key}: relation kind는 same_row/same_column/offset 중 하나여야 합니다.")
        if to_rule not in rules_by_key:
            raise Problem("INVALID_RELATION", f"{key}: relation의 to_rule {to_rule!r}이 없습니다.")
        if to_rule == key:
            raise Problem("INVALID_RELATION", f"{key}: relation은 자기 자신을 가리킬 수 없습니다.")
        target = rules_by_key[to_rule]
        if target["selector"]["key"]["areas"][0]["sheet_role"] != primary:
            raise Problem("INVALID_RELATION", f"{key}: relation 대상 {to_rule}의 기본 시트 역할이 다릅니다.")
        if "scalar" in (rule["selector"]["value"]["cardinality"], target["selector"]["value"]["cardinality"]):
            raise Problem("INVALID_RELATION", f"{key}: relation의 양쪽 값은 list/matrix여야 합니다.")
        item = {"to_rule": to_rule, "kind": kind}
        if kind == "offset":
            if type(relation.get("row")) is not int or type(relation.get("col")) is not int:
                raise Problem("INVALID_RELATION", f"{key}: offset relation에는 row·col 정수가 필요합니다.")
            item["row"], item["col"] = relation["row"], relation["col"]
        out.append(item)
    return out


def relation_order(rules):
    """to_rule을 먼저 실행하는 위상 정렬(rule_key 목록). 순환이면 INVALID_RELATION."""
    by_key = {r["rule_key"]: r for r in rules}
    state, order = {}, []

    def visit(key, stack):
        if state.get(key) == "done":
            return
        if state.get(key) == "active":
            raise Problem("INVALID_RELATION", f"relation이 순환합니다: {' → '.join([*stack, key])}")
        state[key] = "active"
        for relation in by_key[key].get("relations") or []:
            if relation.get("to_rule") not in by_key:
                raise Problem("INVALID_RELATION", f"{key}: relation의 to_rule {relation.get('to_rule')!r}이 없습니다.")
            visit(relation["to_rule"], [*stack, key])
        state[key] = "done"
        order.append(key)

    for rule in rules:
        visit(rule["rule_key"], [])
    return order


def validate_rule(rule, roles, anchors, schema_fields):
    if not isinstance(rule, dict):
        raise Problem("INVALID_RULE", "규칙은 객체여야 합니다.")
    key = rule.get("rule_key")
    if not isinstance(key, str) or not key or len(key) > 128:
        raise Problem("INVALID_RULE", "규칙 이름은 비어 있지 않고 서로 달라야 합니다.")
    out = {"rule_key": key}
    if rule.get("rule_name") is not None:
        out["rule_name"] = str(rule["rule_name"])[:200]
    field_key = rule.get("field_key")
    if field_key is not None:
        field = schema_fields.get(field_key) if isinstance(field_key, str) else None
        if field is None or field.get("status", "active") != "active":
            raise Problem("UNKNOWN_FIELD", f"{key}: 스키마에 없는(또는 폐기된) 필드 {field_key!r}입니다.")
        if field.get("value_type") == "group":
            raise Problem("GROUP_FIELD_TARGET", f"{key}: 묶음 필드 {field_key!r}에는 값을 추출할 수 없습니다.")
        out["field_key"] = field_key
    selectors = rule.get("selector")
    if not isinstance(selectors, dict) or not set(selectors) <= set(ROLES) or "key" not in selectors or "value" not in selectors:
        raise Problem("INVALID_SELECTOR", f"{key}: 키와 값의 영역 정의가 필요합니다.")
    out["selector"] = {
        role: _validate_selection(selectors[role], role, roles, anchors, key)
        for role in ROLES
        if role in selectors
    }
    out["value_spec"] = _validate_value_spec(rule.get("value_spec"), key)
    out["record_spec"] = _validate_record_spec(rule.get("record_spec"), key)
    out["relations"] = rule.get("relations") or []
    return out


def validate_profile(definition, schema_fields, schema_key=None):
    """DSL 3.0 정의 → canonical dict. schema_fields: {field_key: {field_id, value_type, status}}."""
    if not isinstance(definition, dict):
        raise Problem("INVALID_PROFILE", "프로파일은 JSON 객체여야 합니다.")
    if len(dump(definition).encode()) > LIMITS["bytes"]:
        raise Problem("INVALID_PROFILE", "프로파일은 512KB 이하여야 합니다.", 413)
    if definition.get("format", FORMAT) != FORMAT or str(definition.get("schema_version", SCHEMA_VERSION)) != SCHEMA_VERSION:
        raise Problem("UNSUPPORTED_PROFILE_FORMAT", "parsing-profile 3.0 형식만 검증합니다. 다른 형식은 가져오기 어댑터를 거치세요.")
    if schema_fields is None:
        raise Problem("UNKNOWN_SCHEMA", "프로파일이 대상으로 하는 파싱 스키마를 찾을 수 없습니다.", 404)
    declared = definition.get("schema_key")
    if declared is not None and (not isinstance(declared, str) or not declared):
        raise Problem("INVALID_PROFILE", "schema_key는 비어 있지 않은 문자열이어야 합니다.")
    if schema_key is not None and declared is not None and declared != schema_key:
        raise Problem("SCHEMA_MISMATCH", f"정의의 스키마({declared})가 대상 스키마({schema_key})와 다릅니다.")
    roles = _validate_sheet_roles(definition.get("sheet_roles"))
    anchors = _validate_anchors(definition.get("anchors"), roles)
    rules = definition.get("rules")
    if not isinstance(rules, list) or not 1 <= len(rules) <= LIMITS["rules"]:
        raise Problem("INVALID_PROFILE", "파싱 규칙을 1~200개 지정하세요.")
    canonical_rules, seen = [], set()
    for rule in rules:
        item = validate_rule(rule, roles, anchors, schema_fields)
        if item["rule_key"] in seen:
            raise Problem("INVALID_RULE", "규칙 이름은 비어 있지 않고 서로 달라야 합니다.")
        seen.add(item["rule_key"])
        canonical_rules.append(item)
    by_key = {r["rule_key"]: r for r in canonical_rules}
    for rule in canonical_rules:
        rule["relations"] = _validate_relations(rule, by_key)
    relation_order(canonical_rules)
    out = {"format": FORMAT, "schema_version": SCHEMA_VERSION}
    if declared is not None or schema_key is not None:
        out["schema_key"] = declared if declared is not None else schema_key
    if definition.get("profile_name") is not None:
        out["profile_name"] = _name(definition["profile_name"], "프로파일", 200)
    if definition.get("description") is not None:
        out["description"] = str(definition["description"])[:4000]
    out.update(sheet_roles=roles, anchors=anchors, rules=canonical_rules)
    return out


def inline_anchor(name, anchors):
    """앵커 이름 → 자기완결 정의. composite는 {sheet_role, all_of: [{find}, ...]}."""
    anchor = anchors[name]
    if "all_of" in anchor:
        return {
            "sheet_role": anchor["sheet_role"],
            "all_of": [{"find": copy.deepcopy(anchors[m]["find"])} for m in anchor["all_of"]],
            "anchor_name": name,
        }
    return {"sheet_role": anchor["sheet_role"], "find": copy.deepcopy(anchor["find"]), "anchor_name": name}


def compile_rule(rule, anchors):
    """canonical rule → effective_spec(앵커 인라인, relations 보존). mapping_revision.effective_spec_json에 고정된다."""
    anchors = anchors or {}
    out = copy.deepcopy(rule)
    out.setdefault("relations", [])
    out.setdefault("record_spec", {"scope": [rule["rule_key"]], "key": "coordinate"})
    primary_anchor = None
    for role, selection in out["selector"].items():
        for n, area in enumerate(selection["areas"]):
            if "anchor" in area:
                if area["anchor"] not in anchors:
                    raise Problem("INVALID_ANCHOR", f"{rule['rule_key']}: 앵커 {area['anchor']!r}가 없습니다.")
                inlined = inline_anchor(area["anchor"], anchors)
                selection["areas"][n] = {"sheet_role": area["sheet_role"], **{k: v for k, v in inlined.items() if k != "sheet_role"}}
                if role == "key" and n == 0:
                    primary_anchor = area["anchor"]
            elif "relative" in area and isinstance(area["relative"].get("anchor"), str):
                name = area["relative"]["anchor"]
                if name not in anchors:
                    raise Problem("INVALID_ANCHOR", f"{rule['rule_key']}: 앵커 {name!r}가 없습니다.")
                area["relative"]["anchor"] = inline_anchor(name, anchors)
                if role == "key" and n == 0:
                    primary_anchor = name
    out["anchor_name"] = primary_anchor
    return out


def compile_profile(canonical):
    return {rule["rule_key"]: compile_rule(rule, canonical.get("anchors") or {}) for rule in canonical["rules"]}

