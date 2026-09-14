"""v3 전처리 파이프라인: split_delimiter 단독·혼합·version, v2 op 위임, 검증 오류."""

import pytest

from schema.db import Problem
from schema.normalization import prepare, presets, validate_pipeline


def pipeline(*steps):
    return {"operation": "pipeline", "steps": list(steps)}


def test_split_delimiter_alone_text():
    normal = pipeline({"op": "split_delimiter", "delimiter": "/", "index": 1})
    assert prepare("10.5 / 3", normal, "text") == ("3", None, False)
    assert prepare("a/b/c", pipeline({"op": "split_delimiter", "delimiter": "/", "index": -1}), "text") == ("c", None, False)
    # strip=false는 조각의 공백을 남긴다.
    assert prepare("a / b", pipeline({"op": "split_delimiter", "delimiter": "/", "index": 0, "strip": False}), "text")[0] == "a "


def test_split_delimiter_no_fragment_is_null_and_non_string_passes():
    normal = pipeline({"op": "split_delimiter", "delimiter": "/", "index": 2})
    assert prepare("a/b", normal, "text") == (None, None, False)
    assert prepare("a/b", pipeline({"op": "split_delimiter", "delimiter": "/", "index": -3}), "text")[0] is None
    assert prepare(12.5, normal, "decimal") == (12.5, None, False)


def test_split_delimiter_mixed_with_v2_ops_keeps_last_unit():
    normal = pipeline(
        {"op": "trim_text"},
        {"op": "split_delimiter", "delimiter": "/", "index": 0},
        {"op": "split_unit_suffix"},
    )
    assert prepare("  12.5 °C / 3 °C ", normal, "decimal") == ("12.5", "°C", False)
    # split_delimiter 뒤 구간이 단위를 만들지 않으면 앞 구간의 단위가 남는다.
    normal = pipeline({"op": "split_unit_suffix"}, {"op": "split_delimiter", "delimiter": ".", "index": 0}, {"op": "trim_text"})
    assert prepare("10.5 kg", normal, "decimal") == ("10", "kg", False)
    normal = pipeline({"op": "split_delimiter", "delimiter": "|", "index": 1}, {"op": "trim_text"}, {"op": "percent_to_ratio"})
    assert prepare("x | 50%", normal, "decimal") == ("0.5", "%", True)


def test_v2_ops_delegate_and_errors_are_v3_problems():
    assert prepare("1,234.5", pipeline({"op": "strip_thousands"}), "decimal") == ("1234.5", None, False)
    assert prepare(" a ", {"operation": "identity"}, "text") == (" a ", None, False)
    with pytest.raises(Problem) as exc:
        prepare("1,23", pipeline({"op": "strip_thousands"}), "decimal")
    assert exc.value.code == "INVALID_THOUSANDS"


def test_validate_pipeline_version_and_defaults():
    out = validate_pipeline(pipeline({"op": "trim_text"}, {"op": "split_delimiter", "delimiter": ";", "index": -1}), "text")
    assert out["version"] == "2"
    assert out["steps"][1] == {"op": "split_delimiter", "delimiter": ";", "index": -1, "strip": True}
    assert validate_pipeline(pipeline({"op": "trim_text"}), "text")["version"] == "1"
    assert validate_pipeline({"operation": "pipeline", "version": "1", "steps": [{"op": "automatic"}]}, "decimal")["version"] == "1"


@pytest.mark.parametrize(
    "steps,target,code",
    [
        ([{"op": "split_delimiter", "delimiter": "", "index": 0}], "text", "INVALID_PRESET"),
        ([{"op": "split_delimiter", "delimiter": "123456789", "index": 0}], "text", "INVALID_PRESET"),
        ([{"op": "split_delimiter", "delimiter": "/", "index": "0"}], "text", "INVALID_PRESET"),
        ([{"op": "split_delimiter", "delimiter": "/", "index": True}], "text", "INVALID_PRESET"),
        ([{"op": "split_delimiter", "delimiter": "/", "index": 0, "strip": "yes"}], "text", "INVALID_PRESET"),
        ([{"op": "split_delimiter", "delimiter": "/", "index": 0, "extra": 1}], "text", "UNSUPPORTED_NORMALIZER"),
        ([{"op": "split_delimiter", "delimiter": "/", "index": 0}], "date", "NORMALIZER_TYPE_MISMATCH"),
        ([{"op": "trim_text", "delimiter": "/"}], "text", "UNSUPPORTED_NORMALIZER"),
        ([{"op": "strip_thousands"}], "text", "NORMALIZER_TYPE_MISMATCH"),
        ([{"op": "unknown"}], "text", "UNSUPPORTED_NORMALIZER"),
        ([], "text", "INVALID_PRESET"),
        ([{"op": "trim_text"}] * 17, "text", "INVALID_PRESET"),
    ],
)
def test_validate_pipeline_errors(steps, target, code):
    with pytest.raises(Problem) as exc:
        validate_pipeline({"operation": "pipeline", "steps": steps}, target)
    assert exc.value.code == code


def test_presets_delegate(tmp_path):
    items = presets(tmp_path)["items"]
    assert {i["id"] for i in items} >= {"identity", "automatic", "split_unit"}
