"""DSL 3.0 검증·기본값·compile·오류 코드, 가져오기 어댑터(v1/v2/generic)."""

import copy

import pytest

from kg.v3.adapters import detect_format, to_canonical
from kg.v3.db import Problem
from kg.v3.profile import compile_profile, compile_rule, validate_profile

FIELDS = {
    "process": {"field_id": "f0", "value_type": "group", "status": "active"},
    "lot": {"field_id": "f1", "value_type": "text", "status": "active"},
    "temperature": {"field_id": "f2", "value_type": "decimal", "status": "active", "name": "온도", "aliases": ["온도값", "Temp"]},
    "pressure": {"field_id": "f3", "value_type": "decimal", "status": "active"},
    "old": {"field_id": "f4", "value_type": "text", "status": "deprecated"},
}


def area(role="main", **kw):
    return {"sheet_role": role, **kw}


def rule(key, field=None, **extra):
    out = {
        "rule_key": key,
        "selector": {
            "key": {"areas": [area(find={"texts": [key]})]},
            "value": {"areas": [area(relative={"row": 0, "col": 1})]},
        },
    }
    if field:
        out["field_key"] = field
    out.update(extra)
    return out


def profile(**over):
    base = {
        "format": "parsing-profile",
        "schema_version": "3.0",
        "profile_name": "테스트",
        "schema_key": "ps",
        "sheet_roles": {"main": {"cardinality": "one", "match": {"name": "공정 기록"}}},
        "anchors": {
            "hdr_temp": {"sheet_role": "main", "find": {"texts": ["온도"], "within": "A1:Z60"}},
            "hdr_lot": {"sheet_role": "main", "find": {"regex": "^(배치|LOT)$", "within": "A1:Z60"}},
            "table": {"all_of": ["hdr_lot", "hdr_temp"]},
        },
        "rules": [rule("lot", "lot"), rule("temperature", "temperature")],
    }
    base.update(over)
    return base


def failing(definition, code, fields=FIELDS, schema_key=None):
    with pytest.raises(Problem) as exc:
        validate_profile(definition, fields, schema_key)
    assert exc.value.code == code, (exc.value.code, exc.value.message)
    return exc.value


# ---------------------------------------------------------------------------- defaults


def test_defaults_match_v2_runtime():
    canonical = validate_profile(profile(), FIELDS)
    lot = canonical["rules"][0]
    assert lot["selector"]["key"]["repeat"] == "once"
    assert lot["selector"]["key"]["separator"] == " "
    assert lot["selector"]["key"]["areas"][0]["find"]["within"] == "A1:AZ100"
    value = lot["selector"]["value"]
    assert (value["cardinality"], value["axis"], value["element_layout"]) == ("scalar", "none", "each_cell")
    assert value["stop"] == {"kind": "explicit_areas", "max_items": 10000}
    assert value["combine"] == "ordered_union"
    assert value["areas"][0]["relative"] == {"row": 0, "col": 1, "rows": 1, "cols": 1}
    assert lot["value_spec"] == {
        "type": "text",
        "formula_policy": "cached_only",
        "normalization": {"operation": "identity", "version": "1"},
        "unit": None,
        "source_unit": None,
    }
    assert lot["record_spec"] == {"scope": ["lot"], "key": "coordinate"}
    assert lot["relations"] == []
    assert canonical["format"], canonical["schema_version"] == ("parsing-profile", "3.0")


@pytest.mark.parametrize(
    "cardinality,axis,layout",
    [("list", "down", "one_per_row"), ("list", "right", "one_per_column"), ("matrix", "row_major", "each_cell"), ("matrix", "column_major", "each_cell")],
)
def test_element_layout_default_depends_on_axis(cardinality, axis, layout):
    definition = profile(rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["value"].update(cardinality=cardinality, axis=axis, stop={"kind": "blank_run", "count": 2})
    value = validate_profile(definition, FIELDS)["rules"][0]["selector"]["value"]
    assert value["element_layout"] == layout
    assert value["stop"] == {"kind": "blank_run", "count": 2, "max_items": 10000}


def test_sheet_role_matchers_and_contains_text_defaults():
    definition = profile(
        sheet_roles={
            "main": {"match": {"name": "공정 기록"}},
            "common": {"cardinality": "one", "match": {"any_of": [{"name_regex": "^공통"}, {"contains_text": {"texts": ["온도 단위"]}}]}},
            "exp": {"cardinality": "many", "match": {"name_regex": "^\\d+C$"}},
            "third": {"cardinality": "one", "match": {"ordinal": 2}},
            "manual": {"cardinality": "one"},
        }
    )
    roles = validate_profile(definition, FIELDS)["sheet_roles"]
    assert roles["main"]["cardinality"] == "one"
    assert roles["common"]["match"]["any_of"][1] == {"contains_text": {"texts": ["온도 단위"], "within": "A1:AD30", "mode": "any"}}
    assert "match" not in roles["manual"]
    for bad in ({"name": ""}, {"ordinal": -1}, {"name": "a", "ordinal": 0}, {"contains_text": {"texts": [], "mode": "any"}}, {"contains_text": {"texts": ["a"], "mode": "some"}}, {"any_of": [{"any_of": [{"name": "a"}]}]}, {"unknown": 1}):
        failing(profile(sheet_roles={"main": {"match": bad}}), "INVALID_SHEET_ROLE")
    failing(profile(sheet_roles={"main": {"match": {"name_regex": "("}}}), "INVALID_REGEX")
    failing(profile(sheet_roles={"main": {"cardinality": "some"}}), "INVALID_SHEET_ROLE")
    failing(profile(sheet_roles={}), "INVALID_PROFILE")


# ---------------------------------------------------------------------------- errors


def test_find_regex_rules():
    ok = profile(rules=[rule("lot", "lot")])
    ok["rules"][0]["selector"]["key"]["areas"][0] = area(find={"regex": "^(배치|LOT)$", "within": "A1:Z60"})
    validate_profile(ok, FIELDS)
    for bad, code in (
        ({"regex": "(", "within": "A1:B2"}, "INVALID_REGEX"),
        ({"regex": "a" * 257, "within": "A1:B2"}, "INVALID_REGEX"),
        ({"regex": "^a$"}, "INVALID_SELECTOR"),
        ({"regex": "^a$", "texts": ["a"], "within": "A1:B2"}, "INVALID_SELECTOR"),
        ({"texts": ["a"], "within": "A1:ZZ1000"}, "RANGE_LIMIT"),
        ({"texts": ["a"], "within": "A1:B"}, "INVALID_RANGE"),
        ({"texts": ["a"], "occurrence": -1}, "INVALID_SELECTOR"),
        ({"texts": []}, "INVALID_SELECTOR"),
    ):
        definition = copy.deepcopy(ok)
        definition["rules"][0]["selector"]["key"]["areas"][0] = area(find=bad)
        failing(definition, code)


def test_anchor_validation():
    for anchors, code in (
        ({"a": {"sheet_role": "main"}}, "INVALID_ANCHOR"),
        ({"a": {"sheet_role": "nope", "find": {"texts": ["x"]}}}, "INVALID_SHEET_ROLE"),
        ({"a": {"sheet_role": "main", "find": {"regex": "x"}}}, "INVALID_SELECTOR"),
        ({"a": {"sheet_role": "main", "find": {"texts": ["x"]}}, "c": {"all_of": ["a"]}}, "INVALID_ANCHOR"),
        ({"a": {"sheet_role": "main", "find": {"texts": ["x"]}}, "c": {"all_of": ["a", "missing"]}}, "INVALID_ANCHOR"),
        ({"a": {"sheet_role": "main", "find": {"texts": ["x"]}}, "b": {"sheet_role": "main", "find": {"texts": ["y"]}}, "c": {"all_of": ["a", "b"]}, "d": {"all_of": ["c", "a"]}}, "INVALID_ANCHOR"),
        ({"a": {"sheet_role": "main", "find": {"texts": ["x"]}}, "b": {"sheet_role": "other", "find": {"texts": ["y"]}}, "c": {"all_of": ["a", "b"]}}, "INVALID_ANCHOR"),
        ({"a": {"sheet_role": "main", "find": {"texts": ["x"]}}, "c": {"all_of": ["a", "a"]}}, "INVALID_ANCHOR"),
        ({"a": {"all_of": ["b"], "sheet_role": "main"}}, "INVALID_ANCHOR"),
    ):
        definition = profile(anchors=anchors, sheet_roles={"main": {"match": {"name": "m"}}, "other": {"match": {"name": "o"}}})
        failing(definition, code)
    # 참조 검증: 없는 앵커, 시트 역할 불일치, relative 키에는 anchor 필수.
    definition = profile(rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["value"]["areas"][0] = area(anchor="nope")
    failing(definition, "INVALID_ANCHOR")
    definition = profile(sheet_roles={"main": {"match": {"name": "m"}}, "other": {"match": {"name": "o"}}}, rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["value"]["areas"][0] = area("other", anchor="hdr_temp")
    failing(definition, "INVALID_ANCHOR")
    definition["rules"][0]["selector"]["value"]["areas"][0] = area("other", relative={"row": 1, "col": 0, "anchor": "hdr_temp"})
    failing(definition, "INVALID_ANCHOR")
    definition = profile(rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["key"]["areas"][0] = area(relative={"row": 1, "col": 0})
    failing(definition, "INVALID_SELECTOR")
    definition["rules"][0]["selector"]["key"]["areas"][0] = area(relative={"row": 1, "col": 0, "anchor": "hdr_temp"})
    validate_profile(definition, FIELDS)
    definition["rules"][0]["selector"]["key"]["areas"][0] = area(range="A1", anchor="hdr_temp")
    failing(definition, "INVALID_SELECTOR")


def test_field_and_schema_errors():
    failing(profile(rules=[rule("x", "unknown")]), "UNKNOWN_FIELD")
    failing(profile(rules=[rule("x", "old")]), "UNKNOWN_FIELD")
    failing(profile(rules=[rule("x", "process")]), "GROUP_FIELD_TARGET")
    failing(profile(), "UNKNOWN_SCHEMA", fields=None)
    failing(profile(), "SCHEMA_MISMATCH", schema_key="other")
    assert validate_profile(profile(), FIELDS, "ps")["schema_key"] == "ps"
    failing(profile(format="json"), "UNSUPPORTED_PROFILE_FORMAT")
    failing(profile(rules=[]), "INVALID_PROFILE")
    failing(profile(rules=[rule("a", "lot"), rule("a", "lot")]), "INVALID_RULE")
    failing("not a dict", "INVALID_PROFILE")
    # 규칙이 field_key 없이도 검증을 통과한다(proposed까지).
    assert "field_key" not in validate_profile(profile(rules=[rule("nofield")]), FIELDS)["rules"][0]


def test_value_and_record_spec_errors():
    checks = [
        ({"value": {"cardinality": "list", "axis": "none"}}, "INVALID_DIRECTION"),
        ({"value": {"cardinality": "list", "axis": "down", "element_layout": "one_per_column"}}, "INVALID_LAYOUT"),
        ({"value": {"cardinality": "list", "axis": "down", "combine": "sum"}}, "UNSUPPORTED_COMBINE"),
        ({"value": {"combine": "join"}}, "UNSUPPORTED_COMBINE"),
        ({"value": {"merge_policy": "split"}}, "UNSUPPORTED_POLICY"),
        ({"value": {"stop": {"kind": "blank_run", "count": 0}}}, "INVALID_STOP"),
        ({"value": {"stop": {"kind": "never"}}}, "INVALID_STOP"),
        ({"key": {"repeat": "twice"}}, "INVALID_REPEAT"),
    ]
    for patch, code in checks:
        definition = profile(rules=[rule("lot", "lot")])
        for role, values in patch.items():
            definition["rules"][0]["selector"][role].update(values)
        failing(definition, code)
    for spec, code in (
        ({"type": "float"}, "INVALID_TYPE"),
        ({"formula_policy": "recalculate"}, "UNSUPPORTED_FORMULA"),
        ({"type": "text", "normalization": {"operation": "affine"}}, "NORMALIZER_TYPE_MISMATCH"),
        ({"type": "decimal", "normalization": {"operation": "affine", "factor": "x"}}, "INVALID_DECIMAL"),
        ({"type": "decimal", "normalization": {"operation": "magic"}}, "UNSUPPORTED_NORMALIZER"),
        ({"type": "date", "normalization": {"operation": "pipeline", "steps": [{"op": "split_delimiter", "delimiter": "/", "index": 0}]}}, "NORMALIZER_TYPE_MISMATCH"),
    ):
        failing(profile(rules=[rule("lot", "lot", value_spec=spec)]), code)
    for records, code in (({"scope": []}, "INVALID_RECORD_SCOPE"), ({"scope": ["t"], "key": "cell"}, "INVALID_RECORD_KEY"), ({"scope": ["t"], "key": {"row": 0}}, "INVALID_RECORD_KEY")):
        failing(profile(rules=[rule("lot", "lot", record_spec=records)]), code)
    canonical = validate_profile(profile(rules=[rule("lot", "lot", record_spec={"scope": ["t"], "key": None})]), FIELDS)
    assert canonical["rules"][0]["record_spec"] == {"scope": ["t"], "key": None}
    spec = {"type": "decimal", "normalization": {"operation": "pipeline", "steps": [{"op": "trim_text"}, {"op": "split_delimiter", "delimiter": "/", "index": 0}]}}
    canonical = validate_profile(profile(rules=[rule("t", "temperature", value_spec=spec)]), FIELDS)
    assert canonical["rules"][0]["value_spec"]["normalization"]["version"] == "2"


def listed(key, field="temperature", relations=None):
    out = rule(key, field, relations=relations or [])
    out["selector"]["value"].update(cardinality="list", axis="down", areas=[area(relative={"row": 1, "col": 0, "rows": 10})])
    return out


def test_relation_validation():
    ok = profile(rules=[listed("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "same_row"}, {"to_rule": "lot", "kind": "offset", "row": 0, "col": -1}])])
    canonical = validate_profile(ok, FIELDS)
    assert canonical["rules"][1]["relations"] == [{"to_rule": "lot", "kind": "same_row"}, {"to_rule": "lot", "kind": "offset", "row": 0, "col": -1}]
    cases = [
        ([listed("t", relations=[{"to_rule": "nope", "kind": "same_row"}])], "to_rule 없음"),
        ([listed("t", relations=[{"to_rule": "t", "kind": "same_row"}])], "자기 참조"),
        ([listed("a", "lot", relations=[{"to_rule": "b", "kind": "same_row"}]), listed("b", relations=[{"to_rule": "a", "kind": "same_column"}])], "순환"),
        ([listed("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "offset", "row": 1}])], "offset row/col"),
        ([listed("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "near"}])], "kind"),
        ([rule("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "same_row"}])], "scalar"),
        ([listed("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "same_row"}] * 5)], "한도"),
    ]
    for rules, _ in cases:
        failing(profile(rules=rules), "INVALID_RELATION")
    other = profile(sheet_roles={"main": {"match": {"name": "m"}}, "other": {"match": {"name": "o"}}}, rules=[listed("lot", "lot"), listed("t", relations=[{"to_rule": "lot", "kind": "same_row"}])])
    other["rules"][0]["selector"]["key"]["areas"][0]["sheet_role"] = "other"
    other["rules"][0]["selector"]["value"]["areas"][0]["sheet_role"] = "other"
    failing(other, "INVALID_RELATION")


def test_limits():
    failing(profile(rules=[rule(f"r{i}") for i in range(201)]), "INVALID_PROFILE")
    failing(profile(anchors={f"a{i}": {"sheet_role": "main", "find": {"texts": ["x"]}} for i in range(65)}), "INVALID_ANCHOR")
    definition = profile(rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["value"]["areas"] = [area(range="A1")] * 33
    failing(definition, "INVALID_SELECTOR")
    definition = profile(rules=[rule("lot", "lot")])
    definition["rules"][0]["selector"]["value"]["areas"] = [area(range="A1:ZZ10000")]
    failing(definition, "RANGE_LIMIT")
    big = profile(description="x" * 520000)
    failing(big, "INVALID_PROFILE")


# ---------------------------------------------------------------------------- compile


def test_compile_rule_inlines_anchors_and_keeps_relations():
    definition = profile(
        rules=[
            listed("lot", "lot"),
            {
                "rule_key": "temperature",
                "field_key": "temperature",
                "selector": {
                    "key": {"areas": [area(anchor="hdr_temp")]},
                    "value": {"areas": [area(relative={"row": 1, "col": 0, "rows": 65})], "cardinality": "list", "axis": "down"},
                    "unit": {"areas": [area(relative={"row": 0, "col": 1, "anchor": "hdr_temp"})]},
                    "context": {"areas": [area(anchor="table")]},
                },
                "value_spec": {"type": "decimal", "unit": "°C"},
                "relations": [{"to_rule": "lot", "kind": "same_row"}],
            },
        ]
    )
    canonical = validate_profile(definition, FIELDS)
    compiled = compile_profile(canonical)
    assert set(compiled) == {"lot", "temperature"}
    spec = compiled["temperature"]
    key_area = spec["selector"]["key"]["areas"][0]
    assert key_area == {"sheet_role": "main", "find": {"texts": ["온도"], "within": "A1:Z60"}, "anchor_name": "hdr_temp"}
    assert spec["anchor_name"] == "hdr_temp"
    unit_anchor = spec["selector"]["unit"]["areas"][0]["relative"]["anchor"]
    assert unit_anchor == {"sheet_role": "main", "find": {"texts": ["온도"], "within": "A1:Z60"}, "anchor_name": "hdr_temp"}
    context = spec["selector"]["context"]["areas"][0]
    assert context["anchor_name"] == "table" and "anchor" not in context
    assert context["all_of"] == [{"find": {"regex": "^(배치|LOT)$", "within": "A1:Z60"}}, {"find": {"texts": ["온도"], "within": "A1:Z60"}}]
    assert spec["relations"] == [{"to_rule": "lot", "kind": "same_row"}]
    assert spec["record_spec"] == {"scope": ["temperature"], "key": "coordinate"}
    assert compiled["lot"]["anchor_name"] is None
    # 원본 canonical은 바뀌지 않는다(effective_spec은 사본).
    assert canonical["rules"][1]["selector"]["key"]["areas"][0] == {"sheet_role": "main", "anchor": "hdr_temp"}
    with pytest.raises(Problem) as exc:
        compile_rule(canonical["rules"][1], {})
    assert exc.value.code == "INVALID_ANCHOR"


# ---------------------------------------------------------------------------- adapters


def test_detect_format():
    assert detect_format(profile()) == "parsing-profile-3.0"
    assert detect_format({"kg_revision_id": "k", "sheet_roles": {}, "rules": []}) == "v2-template"
    assert detect_format({"sheet_templates": []}) == "v1-parsing-template"
    assert detect_format({"format": "kg-parsing-template/1", "spec": {"sheet_templates": []}}) == "v1-parsing-template"
    assert detect_format({"fields": []}) == "generic-keyvalue"
    with pytest.raises(Problem) as exc:
        detect_format({"hello": 1})
    assert exc.value.code == "UNSUPPORTED_PROFILE_FORMAT"


def test_to_canonical_30_checks_schema_key():
    canonical, report = to_canonical(profile(), "ps", FIELDS)
    assert report == {"format_detected": "parsing-profile-3.0", "warnings": []}
    assert canonical["schema_key"] == "ps"
    with pytest.raises(Problem) as exc:
        to_canonical(profile(), "other", FIELDS)
    assert exc.value.code == "SCHEMA_MISMATCH"
    with pytest.raises(Problem) as exc:
        to_canonical(profile(), "ps", None)
    assert exc.value.code == "UNKNOWN_SCHEMA"


def test_v2_template_adapter():
    v2 = {
        "kg_revision_id": "kg-1",
        "format": "json",
        "schema_version": "2.0",
        "sheet_roles": {"main": {"cardinality": "one"}, "units": {"cardinality": "one", "description": "단위"}},
        "rules": [
            {
                "rule_key": "temperature",
                "concept_id": "temperature",
                "record_spec": {"scope": ["process"], "key": {"column": "A"}},
                "selector": {
                    "key": {"areas": [{"sheet_role": "main", "range": "B2:C2"}, {"sheet_role": "main", "range": "D2"}]},
                    "value": {"areas": [{"sheet_role": "main", "range": "B3:C5"}], "cardinality": "list", "axis": "down", "element_layout": "one_per_row"},
                    "unit": {"areas": [{"sheet_role": "units", "range": "A1"}]},
                },
                "value_spec": {"type": "decimal", "unit": "°C"},
            },
            {"rule_key": "free", "concept_id": None, "selector": {"key": {"areas": [{"sheet_role": "main", "find": {"texts": ["비고"]}}]}, "value": {"areas": [{"sheet_role": "main", "relative": {"col": 1}}]}}},
            {"rule_key": "gone", "concept_id": "vanished", "selector": {"key": {"areas": [{"sheet_role": "main", "find": {"texts": ["x"]}}]}, "value": {"areas": [{"sheet_role": "main", "relative": {"col": 1}}]}}},
        ],
    }
    canonical, report = to_canonical(v2, "ps", FIELDS)
    assert report["format_detected"] == "v2-template"
    codes = {(w["code"], w["path"]) for w in report["warnings"]}
    assert {("DROPPED_FIELD", "kg_revision_id"), ("MISSING_FIELD", "rules[1].concept_id"), ("MISSING_FIELD", "rules[2].concept_id")} <= codes
    assert canonical["schema_key"] == "ps"
    assert canonical["sheet_roles"] == {"main": {"cardinality": "one"}, "units": {"cardinality": "one", "description": "단위"}}
    first, free, gone = canonical["rules"]
    assert first["field_key"] == "temperature" and "concept_id" not in first
    assert first["record_spec"] == {"scope": ["process"], "key": {"column": "A"}}
    assert first["selector"]["value"]["element_layout"] == "one_per_row"
    assert "field_key" not in free and "field_key" not in gone


def test_v1_template_adapter():
    v1 = {
        "format": "kg-parsing-template/1",
        "spec": {
            "sheet_templates": [
                {
                    "name": "본문",
                    "match": {"names": ["공정 기록"]},
                    "mappings": [
                        {"key": "temp", "concept_id": "temperature", "source": {"key_search": ["온도", "Temp"], "offset": {"row": 0, "col": 2}}, "type": "number", "unit": "°C", "normalization": {"target_unit": "K"}},
                        {"key": "lot", "concept_id": "lot", "source": {"range": "B4:B10"}, "type": "text"},
                        {"key": "pressure", "concept_id": "pressure", "source": {"range": "C4"}, "type": "number"},
                    ],
                },
                {"name": "실험", "match": {"names": ["10C", "20C"], "headers": ["실험 번호"]}, "mappings": [{"key": "temp", "concept_id": "temperature", "source": {"key_search": "온도"}, "type": "number"}]},
                {"name": "헤더만", "match": {"headers": ["요약"]}, "mappings": [{"key": "grid", "source": {"range": "A1:C3"}}]},
            ]
        },
    }
    canonical, report = to_canonical(v1, "ps", FIELDS)
    assert report["format_detected"] == "v1-parsing-template"
    roles = canonical["sheet_roles"]
    assert roles["본문"] == {"cardinality": "one", "match": {"name": "공정 기록"}}
    assert roles["실험"]["cardinality"] == "many"
    assert roles["실험"]["match"]["any_of"][0] == {"name_regex": "^(?:10C|20C)$"}
    assert roles["실험"]["match"]["any_of"][1] == {"contains_text": {"texts": ["실험 번호"], "within": "A1:AD30", "mode": "any"}}
    assert roles["헤더만"] == {"cardinality": "many", "match": {"contains_text": {"texts": ["요약"], "within": "A1:AD30", "mode": "any"}}}
    rules = {r["rule_key"]: r for r in canonical["rules"]}
    # key가 시트 사이에서 겹치므로 rule_key는 "<시트>.<key>"다.
    assert set(rules) == {"본문.temp", "본문.lot", "본문.pressure", "실험.temp", "헤더만.grid"}
    temp = rules["본문.temp"]
    assert temp["field_key"] == "temperature"
    assert temp["selector"]["key"]["areas"][0] == {"sheet_role": "본문", "find": {"texts": ["온도", "Temp"], "within": "A1:AZ100", "occurrence": 0}}
    assert temp["selector"]["value"]["areas"][0] == {"sheet_role": "본문", "relative": {"row": 0, "col": 2, "rows": 1, "cols": 1}}
    assert temp["value_spec"]["type"] == "decimal" and temp["value_spec"]["unit"] == "°C"
    lot = rules["본문.lot"]
    assert lot["selector"]["key"]["areas"][0]["find"]["texts"] == ["lot"]
    assert lot["selector"]["value"]["areas"][0] == {"sheet_role": "본문", "range": "B4:B10"}
    assert (lot["selector"]["value"]["cardinality"], lot["selector"]["value"]["axis"], lot["selector"]["value"]["element_layout"]) == ("list", "down", "one_per_row")
    pressure = rules["본문.pressure"]
    assert pressure["selector"]["value"]["cardinality"] == "scalar"
    grid = rules["헤더만.grid"]
    assert (grid["selector"]["value"]["cardinality"], grid["selector"]["value"]["axis"]) == ("matrix", "row_major")
    assert "field_key" not in grid
    # 스키마의 필드 이름·별칭을 키 추정에 쓴다.
    assert rules["실험.temp"]["selector"]["value"]["areas"][0]["relative"] == {"row": 0, "col": 1, "rows": 1, "cols": 1}
    codes = {}
    for w in report["warnings"]:
        codes.setdefault(w["code"], []).append(w["path"])
    assert "sheet_templates[본문].mappings[temp].source.key_search" in codes["KEY_SEARCH_WINDOW"]
    assert any(p.endswith("mappings[temp].source.key_search") for p in codes["CASEFOLD_MATCH"])
    assert "sheet_templates[실험].match.headers" in codes["CASEFOLD_MATCH"]
    assert {"sheet_templates[본문].mappings[lot].source.range", "sheet_templates[본문].mappings[pressure].source.range"} <= set(codes["KEY_INFERRED"])
    assert "sheet_templates[헤더만].mappings[grid].concept_id" in codes["MISSING_FIELD"]
    assert "sheet_templates[본문].mappings[temp].normalization.target_unit" in codes["UNIT_CONVERSION"]
    # 필드 이름·별칭이 있으면 키 추정 목록에 더한다.
    v1b = {"sheet_templates": [{"name": "s", "match": {"names": ["s"]}, "mappings": [{"key": "temp", "concept_id": "temperature", "source": {"range": "B2"}}]}]}
    canonical, _ = to_canonical(v1b, "ps", FIELDS)
    assert canonical["rules"][0]["selector"]["key"]["areas"][0]["find"]["texts"] == ["temp", "온도", "온도값", "Temp"]
    with pytest.raises(Problem) as exc:
        to_canonical({"sheet_templates": [{"name": "s", "match": {}, "mappings": []}]}, "ps", FIELDS)
    assert exc.value.code == "INVALID_SHEET_ROLE"
    with pytest.raises(Problem) as exc:
        to_canonical({"sheet_templates": [{"name": "s", "match": {"names": ["s"]}, "mappings": [{"key": "k", "source": {}}]}]}, "ps", FIELDS)
    assert exc.value.code == "INVALID_SELECTOR"


def test_generic_keyvalue_adapter():
    generic = {
        "fields": [
            {"name": "temperature", "sheet": "공정 기록", "cell": "C4", "type": "number", "unit": "°C"},
            {"name": "lot", "sheet": "공정 기록", "label": "LOT", "offset": {"row": 1, "col": 0}, "type": "text"},
            {"name": "note", "label": "비고"},
        ]
    }
    canonical, report = to_canonical(generic, "ps", FIELDS)
    assert report["format_detected"] == "generic-keyvalue"
    assert canonical["sheet_roles"] == {"공정 기록": {"cardinality": "one", "match": {"name": "공정 기록"}}, "main": {"cardinality": "one", "match": {"ordinal": 0}}}
    temp, lot, note = canonical["rules"]
    assert temp["field_key"] == "temperature"
    assert temp["selector"]["value"]["areas"][0] == {"sheet_role": "공정 기록", "range": "C4"}
    assert temp["selector"]["key"]["areas"][0]["find"]["texts"] == ["temperature"]
    assert temp["value_spec"]["type"] == "decimal" and temp["value_spec"]["unit"] == "°C"
    assert lot["selector"]["key"]["areas"][0]["find"] == {"texts": ["LOT"], "within": "A1:AZ100", "occurrence": 0}
    assert lot["selector"]["value"]["areas"][0]["relative"] == {"row": 1, "col": 0, "rows": 1, "cols": 1}
    assert note["selector"]["key"]["areas"][0]["sheet_role"] == "main" and "field_key" not in note
    codes = {(w["code"], w["path"]) for w in report["warnings"]}
    assert {("KEY_INFERRED", "fields[0].cell"), ("SHEET_INFERRED", "fields[2].sheet"), ("MISSING_FIELD", "fields[2].name")} <= codes
    with pytest.raises(Problem) as exc:
        to_canonical({"fields": [{"name": "a", "sheet": "s"}]}, "ps", FIELDS)
    assert exc.value.code == "INVALID_SELECTOR"
