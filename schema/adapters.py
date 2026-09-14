"""가져오기 어댑터(계약 §2.1 'Import Adapter'): 3.0·v2 템플릿·v1 파싱 템플릿·generic key-value → canonical 3.0.

변환 결과는 validate_profile을 거친 canonical이며, 표현이 달라진 곳은 report.warnings[{code, path, message}]에 남긴다.
"""

from __future__ import annotations

import copy
import re

from .db import Problem
from .spec import bounds
from .profile import DEFAULT_CONTAINS_WITHIN, DEFAULT_WITHIN, FORMAT, SCHEMA_VERSION, validate_profile

FORMAT_30, FORMAT_V2, FORMAT_V1, FORMAT_GENERIC = "parsing-profile-3.0", "v2-template", "v1-parsing-template", "generic-keyvalue"
V1_TYPES = {"number": "decimal", "decimal": "decimal", "text": "text", "boolean": "boolean", "date": "date", "datetime": "datetime"}


def _unwrap(obj):
    # v1 export(`kg.parsing.export_template`)는 {"format": "kg-parsing-template/1", "spec": {...}}로 감싼다.
    if isinstance(obj, dict) and isinstance(obj.get("spec"), dict) and "sheet_templates" in obj["spec"]:
        return obj["spec"]
    return obj


def detect_format(obj):
    obj = _unwrap(obj)
    if not isinstance(obj, dict):
        raise Problem("UNSUPPORTED_PROFILE_FORMAT", "프로파일 정의는 JSON 객체여야 합니다.")
    if obj.get("format") == FORMAT or str(obj.get("schema_version", "")) == SCHEMA_VERSION:
        return FORMAT_30
    if isinstance(obj.get("sheet_templates"), list):
        return FORMAT_V1
    if isinstance(obj.get("sheet_roles"), dict) and isinstance(obj.get("rules"), list):
        return FORMAT_V2
    if isinstance(obj.get("fields"), list):
        return FORMAT_GENERIC
    raise Problem("UNSUPPORTED_PROFILE_FORMAT", "알 수 없는 프로파일 형식입니다. parsing-profile 3.0, v2 템플릿, v1 파싱 템플릿, key-value 목록을 지원합니다.")


class Report:
    def __init__(self, detected):
        self.detected, self.warnings = detected, []

    def warn(self, code, path, message):
        self.warnings.append({"code": code, "path": path, "message": message})

    def as_dict(self):
        return {"format_detected": self.detected, "warnings": self.warnings}


def _field_key(concept, schema_fields, report, path):
    """concept_id/필드명 → field_key. 스키마에 없으면 생략하고 MISSING_FIELD 경고(리비전은 proposed까지)."""
    if concept is None or concept == "":
        report.warn("MISSING_FIELD", path, "필드가 지정되지 않아 검수에서 필드를 골라야 합니다.")
        return None
    field = schema_fields.get(concept) if isinstance(concept, str) else None
    if field is None or field.get("status", "active") != "active" or field.get("value_type") == "group":
        report.warn("MISSING_FIELD", path, f"스키마에 없는(또는 group/폐기된) 필드 {concept!r}를 생략했습니다. 검수에서 필드를 고르세요.")
        return None
    return concept


def _dedupe(texts):
    seen, out = set(), []
    for text in texts:
        if isinstance(text, str) and text.strip() and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _shape(range_text):
    r1, c1, r2, c2 = bounds(range_text)
    rows, cols = r2 - r1 + 1, c2 - c1 + 1
    if rows == 1 and cols == 1:
        return {"cardinality": "scalar", "axis": "none"}
    if rows == 1:
        return {"cardinality": "list", "axis": "right", "element_layout": "one_per_column"}
    if cols == 1:
        return {"cardinality": "list", "axis": "down", "element_layout": "one_per_row"}
    return {"cardinality": "matrix", "axis": "row_major", "element_layout": "each_cell"}


# ---------------------------------------------------------------------------- 3.0 / v2


def _from_30(obj, schema_key, schema_fields, report):
    declared = obj.get("schema_key")
    if declared is not None and declared != schema_key:
        raise Problem("SCHEMA_MISMATCH", f"정의의 스키마({declared})가 대상 스키마({schema_key})와 다릅니다.")
    out = copy.deepcopy(obj)
    out["schema_key"] = schema_key
    return out


def _from_v2(obj, schema_key, schema_fields, report):
    out = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "schema_key": schema_key}
    for key in ("kg_revision_id", "format", "schema_version"):
        if key in obj:
            report.warn("DROPPED_FIELD", key, f"v2 템플릿의 {key}는 3.0에서 쓰지 않아 버렸습니다.")
    for key in ("profile_name", "name", "description"):
        if obj.get(key) is not None:
            out["profile_name" if key == "name" else key] = obj[key]
    out["sheet_roles"] = {
        role: {k: v for k, v in (definition or {}).items() if k in ("cardinality", "match", "description")}
        for role, definition in obj["sheet_roles"].items()
    }
    rules = []
    for n, rule in enumerate(obj["rules"]):
        if not isinstance(rule, dict):
            raise Problem("INVALID_RULE", "규칙은 객체여야 합니다.")
        item = {k: copy.deepcopy(v) for k, v in rule.items() if k not in ("concept_id", "field_key")}
        field = rule.get("field_key", rule.get("concept_id"))
        field_key = _field_key(field, schema_fields, report, f"rules[{n}].concept_id")
        if field_key:
            item["field_key"] = field_key
        rules.append(item)
    out["rules"] = rules
    return out


# ---------------------------------------------------------------------------- v1


def _v1_matcher(matcher, role, report):
    names = matcher.get("names")
    if isinstance(names, str):
        names = [names]
    names = [n for n in (names or []) if isinstance(n, str) and n]
    headers = [h for h in (matcher.get("headers") or []) if isinstance(h, str) and h.strip()]
    regex = matcher.get("name_regex")
    by_name = None
    if len(names) == 1 and not regex:
        by_name = {"name": names[0]}
    elif names or regex:
        pattern = regex if regex and not names else "^(?:" + "|".join(re.escape(n) for n in names) + ")$"
        if regex and names:
            pattern = f"(?:{regex})|" + pattern
        by_name = {"name_regex": pattern}
    by_header = {"contains_text": {"texts": headers[:20], "within": DEFAULT_CONTAINS_WITHIN, "mode": "any"}} if headers else None
    if by_name and by_header:
        match = {"any_of": [by_name, by_header]}
    else:
        match = by_name or by_header
    if match is None:
        raise Problem("INVALID_SHEET_ROLE", f"시트 템플릿 {role}에 names/name_regex/headers 판별자가 없습니다.")
    if headers:
        report.warn("CASEFOLD_MATCH", f"sheet_templates[{role}].match.headers", "v1은 공백만 제거해 비교했지만 3.0은 NFKC·대소문자 무시로 비교합니다.")
    cardinality = "one" if (len(names) == 1 and not regex and not headers) else "many"
    return match, cardinality


def _from_v1(obj, schema_key, schema_fields, report):
    sheets = obj.get("sheet_templates")
    if not isinstance(sheets, list) or not sheets:
        raise Problem("INVALID_PROFILE", "v1 템플릿의 sheet_templates가 비어 있습니다.")
    out = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "schema_key": schema_key, "sheet_roles": {}, "rules": []}
    for key in ("name", "profile_name"):
        if obj.get(key):
            out["profile_name"] = obj[key]
    keys = [m.get("key") for s in sheets if isinstance(s, dict) for m in (s.get("mappings") or []) if isinstance(m, dict)]
    unique = len(keys) == len(set(keys))
    for sheet in sheets:
        if not isinstance(sheet, dict) or not isinstance(sheet.get("name"), str) or not sheet["name"]:
            raise Problem("INVALID_SHEET_ROLE", "시트 템플릿 이름이 비어 있습니다.")
        role = sheet["name"]
        matcher = sheet.get("match") or sheet.get("matcher") or {}
        if not isinstance(matcher, dict):
            raise Problem("INVALID_SHEET_ROLE", f"시트 템플릿 {role}의 match가 객체가 아닙니다.")
        match, cardinality = _v1_matcher(matcher, role, report)
        out["sheet_roles"][role] = {"cardinality": cardinality, "match": match}
        for mapping in sheet.get("mappings") or []:
            if not isinstance(mapping, dict) or not isinstance(mapping.get("key"), str) or not mapping["key"]:
                raise Problem("INVALID_RULE", f"시트 템플릿 {role}의 매핑 key가 비어 있습니다.")
            key = mapping["key"]
            rule_key = key if unique else f"{role}.{key}"
            path = f"sheet_templates[{role}].mappings[{key}]"
            source = mapping.get("source")
            if not isinstance(source, dict):
                raise Problem("INVALID_SELECTOR", f"{path}: source가 객체가 아닙니다.")
            field_key = _field_key(mapping.get("concept_id"), schema_fields, report, path + ".concept_id")
            if source.get("key_search"):
                terms = source["key_search"]
                texts = _dedupe(terms if isinstance(terms, list) else [terms])
                if not texts:
                    raise Problem("INVALID_SELECTOR", f"{path}: key_search가 비어 있습니다.")
                offset = source.get("offset") or {}
                if not isinstance(offset, dict):
                    raise Problem("INVALID_SELECTOR", f"{path}: offset은 객체여야 합니다.")
                try:
                    row, col = int(offset.get("row", 0)), int(offset.get("col", 1))
                except (TypeError, ValueError):
                    raise Problem("INVALID_SELECTOR", f"{path}: offset은 정수여야 합니다.") from None
                selector = {
                    "key": {"areas": [{"sheet_role": role, "find": {"texts": texts, "within": DEFAULT_WITHIN, "occurrence": 0}}]},
                    "value": {"areas": [{"sheet_role": role, "relative": {"row": row, "col": col, "rows": 1, "cols": 1}}], "cardinality": "scalar", "axis": "none"},
                }
                report.warn("KEY_SEARCH_WINDOW", path + ".source.key_search", "v1은 시트 전체를 검색했지만 3.0은 A1:AZ100 안에서 검색합니다. 필요하면 within을 넓히세요.")
                report.warn("CASEFOLD_MATCH", path + ".source.key_search", "v1은 공백만 제거해 비교했지만 3.0은 NFKC·대소문자 무시로 비교합니다.")
            elif source.get("range"):
                field = schema_fields.get(field_key) if field_key else {}
                texts = _dedupe([key, (field or {}).get("name"), *((field or {}).get("aliases") or [])])
                selector = {
                    "key": {"areas": [{"sheet_role": role, "find": {"texts": texts, "within": DEFAULT_WITHIN, "occurrence": 0}}]},
                    "value": {"areas": [{"sheet_role": role, "range": source["range"]}], **_shape(source["range"])},
                }
                report.warn("KEY_INFERRED", path + ".source.range", f"v1 고정 범위에는 키가 없어 {texts}를 키 검색어로 추정했습니다. 검수에서 확인하세요.")
            else:
                raise Problem("INVALID_SELECTOR", f"{path}: source에 range 또는 key_search가 필요합니다.")
            value_type = mapping.get("value_type", mapping.get("type"))
            value_spec = {"type": V1_TYPES.get(value_type, "text")}
            target_unit = (mapping.get("normalization") or {}).get("target_unit") if isinstance(mapping.get("normalization"), dict) else None
            unit = mapping.get("unit") or target_unit
            if unit:
                value_spec["unit"] = str(unit)
            if target_unit and mapping.get("unit") and target_unit != mapping.get("unit"):
                report.warn("UNIT_CONVERSION", path + ".normalization.target_unit", f"단위 변환 {mapping.get('unit')}→{target_unit}은 빌드의 target_unit으로 수행합니다.")
            rule = {"rule_key": rule_key, "rule_name": key, "selector": selector, "value_spec": value_spec}
            if field_key:
                rule["field_key"] = field_key
            out["rules"].append(rule)
    if not out["rules"]:
        raise Problem("INVALID_PROFILE", "v1 템플릿에 매핑이 없습니다.")
    return out


# ---------------------------------------------------------------------------- generic key-value


def _from_generic(obj, schema_key, schema_fields, report):
    fields = obj.get("fields")
    if not isinstance(fields, list) or not fields:
        raise Problem("INVALID_PROFILE", "fields 목록이 비어 있습니다.")
    out = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "schema_key": schema_key, "sheet_roles": {}, "rules": []}
    if obj.get("name") or obj.get("profile_name"):
        out["profile_name"] = obj.get("profile_name") or obj.get("name")
    seen = set()
    for n, field in enumerate(fields):
        path = f"fields[{n}]"
        if not isinstance(field, dict) or not isinstance(field.get("name"), str) or not field["name"]:
            raise Problem("INVALID_RULE", f"{path}: name이 비어 있습니다.")
        name = field["name"]
        if name in seen:
            raise Problem("INVALID_RULE", f"{path}: name {name!r}이 중복됩니다.")
        seen.add(name)
        sheet = field.get("sheet")
        if sheet:
            role = str(sheet)
            out["sheet_roles"].setdefault(role, {"cardinality": "one", "match": {"name": role}})
        else:
            role = "main"
            if role not in out["sheet_roles"]:
                out["sheet_roles"][role] = {"cardinality": "one", "match": {"ordinal": 0}}
                report.warn("SHEET_INFERRED", path + ".sheet", "시트가 없어 첫 번째 시트로 추정했습니다.")
        if field.get("cell"):
            selector = {
                "key": {"areas": [{"sheet_role": role, "find": {"texts": _dedupe([field.get("label"), name]), "within": DEFAULT_WITHIN, "occurrence": 0}}]},
                "value": {"areas": [{"sheet_role": role, "range": str(field["cell"])}], **_shape(str(field["cell"]))},
            }
            report.warn("KEY_INFERRED", path + ".cell", f"고정 셀에는 키가 없어 {name!r}를 키 검색어로 추정했습니다.")
        elif field.get("label"):
            offset = field.get("offset") or {}
            if not isinstance(offset, dict):
                raise Problem("INVALID_SELECTOR", f"{path}: offset은 객체여야 합니다.")
            try:
                row, col = int(offset.get("row", 0)), int(offset.get("col", 1))
            except (TypeError, ValueError):
                raise Problem("INVALID_SELECTOR", f"{path}: offset은 정수여야 합니다.") from None
            selector = {
                "key": {"areas": [{"sheet_role": role, "find": {"texts": [str(field["label"])], "within": DEFAULT_WITHIN, "occurrence": 0}}]},
                "value": {"areas": [{"sheet_role": role, "relative": {"row": row, "col": col, "rows": 1, "cols": 1}}], "cardinality": "scalar", "axis": "none"},
            }
        else:
            raise Problem("INVALID_SELECTOR", f"{path}: cell 또는 label이 필요합니다.")
        value_spec = {"type": V1_TYPES.get(field.get("type"), "text")}
        if field.get("unit"):
            value_spec["unit"] = str(field["unit"])
        rule = {"rule_key": name, "rule_name": name, "selector": selector, "value_spec": value_spec}
        field_key = _field_key(field.get("field_key", name), schema_fields, report, path + ".name")
        if field_key:
            rule["field_key"] = field_key
        out["rules"].append(rule)
    return out


CONVERTERS = {FORMAT_30: _from_30, FORMAT_V2: _from_v2, FORMAT_V1: _from_v1, FORMAT_GENERIC: _from_generic}


def to_canonical(obj, schema_key, schema_fields, format="auto"):
    """(canonical, report). format='auto'면 detect_format. canonical은 validate_profile을 거친 값이다."""
    obj = _unwrap(obj)
    detected = detect_format(obj) if format in (None, "auto") else format
    if detected not in CONVERTERS:
        raise Problem("UNSUPPORTED_PROFILE_FORMAT", f"지원하지 않는 형식 {detected!r}입니다.")
    if schema_fields is None:
        raise Problem("UNKNOWN_SCHEMA", f"파싱 스키마 {schema_key!r}를 찾을 수 없습니다.", 404)
    report = Report(detected)
    converted = CONVERTERS[detected](obj, schema_key, schema_fields, report)
    canonical = validate_profile(converted, schema_fields, schema_key)
    return canonical, report.as_dict()
