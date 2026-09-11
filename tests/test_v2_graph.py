"""GET /kg/{kg}/graph — 발행·현재 버전·활성 개념만 세는 커버리지 그래프 검증."""

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook

from kg.v2.api import create_app
from kg.v2.db import uid


@pytest.fixture
def workspace(tmp_path):
    raw = tmp_path / "data/raw"
    raw.mkdir(parents=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "세로"
    ws["B2"], ws["D2"] = "공정", "온도"
    ws.merge_cells("B2:C2")
    ws["A3"], ws["A4"], ws["A5"] = "lot-1", "lot-2", "lot-3"
    ws["B3"], ws["B4"], ws["B5"] = "10.5", "20.5", "30"
    wb.create_sheet("단위")["A1"] = "°C"
    path = raw / "sample.xlsx"
    wb.save(path)
    app = create_app(tmp_path, start_worker=False)
    with TestClient(app) as client:
        service = app.state.v2

        def request(method, url, body=None, code=200):
            response = client.request(method, "/api/v2" + url, json=body)
            assert response.status_code == code, response.text
            return response.json()

        def work(url, body):
            job = request("POST", url, {**body, "request_key": uid()}, 202)
            service.jobs.run_one()
            return request("GET", "/jobs/" + job["job_id"])

        job = work("/documents/register", {"source_refs": ["sample.xlsx"]})
        assert job["state"] == "succeeded", job
        doc = job["result"]["documents"][0]
        sheets = request("GET", "/versions/" + doc["version_id"] + "/sheets")["items"]
        kg = request(
            "POST",
            "/kg/import",
            {
                "concepts": [
                    {"concept_id": "plant", "name": "공정", "level": 1},
                    {"concept_id": "quality", "name": "품질", "level": 1},
                    {
                        "concept_id": "temperature",
                        "name": "공정온도",
                        "level": 2,
                        "canonical_unit": "°C",
                    },
                    {"concept_id": "ambient", "name": "주위온도", "level": 2},
                    {"concept_id": "peak", "name": "최고온도", "level": 3},
                    {
                        "concept_id": "old",
                        "name": "폐기온도",
                        "level": 2,
                        "status": "deprecated",
                    },
                ],
                "relations": [
                    ["plant", "temperature", "parent_of"],
                    ["plant", "ambient", "parent_of"],
                    ["temperature", "peak", "parent_of"],
                    ["plant", "old", "parent_of"],
                    ["temperature", "ambient", "related"],
                ],
            },
        )
        definition = {
            "kg_revision_id": kg["kg_revision_id"],
            "sheet_roles": {
                "main": {"cardinality": "one"},
                "units": {"cardinality": "one"},
            },
            "rules": [
                {
                    "rule_key": "temperature",
                    "concept_id": "temperature",
                    "record_spec": {"scope": ["process"], "key": {"column": "A"}},
                    "selector": {
                        "key": {
                            "areas": [
                                {"sheet_role": "main", "range": "B2:C2"},
                                {"sheet_role": "main", "range": "D2"},
                            ]
                        },
                        "value": {
                            "areas": [{"sheet_role": "main", "range": "B3:C5"}],
                            "cardinality": "list",
                            "axis": "down",
                            "element_layout": "one_per_row",
                        },
                        "unit": {"areas": [{"sheet_role": "units", "range": "A1"}]},
                    },
                    "value_spec": {"type": "decimal", "unit": "°C"},
                }
            ],
        }
        template = request(
            "POST", "/templates", {"name": "공정온도", "definition": definition}
        )
        application = request(
            "POST",
            "/applications",
            {
                "version_id": doc["version_id"],
                "template_version_id": template["template_version_id"],
                "bindings": {
                    "main": [sheets[0]["sheet_id"]],
                    "units": [sheets[1]["sheet_id"]],
                },
                "approved": True,
            },
        )
        yield {
            "api": request,
            "work": work,
            "service": service,
            "doc": doc,
            "kg": kg["kg_revision_id"],
            "application": application,
            "path": path,
            "root": tmp_path,
        }


def graph(s, kg=None):
    return s["api"]("GET", "/kg/" + (kg or s["kg"]) + "/graph")


def by_id(g):
    return {n["concept_id"]: n for n in g["nodes"]}


def group_counts(g):
    return {x["root_concept_id"]: x["member_document_count"] for x in g["groups"]}


def publish(s):
    job = s["work"](
        "/applications/" + s["application"]["application_id"] + "/extract", {}
    )
    assert job["state"] == "succeeded", job
    return job


def test_graph_nodes_parent_root_edges_exclude_deprecated(workspace):
    s = workspace
    g = graph(s)
    nodes = by_id(g)
    assert set(nodes) == {"plant", "quality", "temperature", "ambient", "peak"}
    assert nodes["peak"]["parent"] == "temperature"
    assert nodes["peak"]["root"] == "plant"
    assert nodes["temperature"]["parent"] == "plant"
    assert nodes["plant"]["parent"] is None and nodes["plant"]["root"] == "plant"
    assert nodes["quality"]["root"] == "quality"
    assert sorted((e["from_concept_id"], e["to_concept_id"]) for e in g["edges"]) == [
        ("plant", "ambient"),
        ("plant", "temperature"),
        ("temperature", "peak"),
    ]
    assert [x["root_concept_id"] for x in g["groups"]] == ["plant", "quality"]
    assert group_counts(g) == {"plant": 0, "quality": 0}
    assert g["truncated"] is False and g["node_cap"] == 2000
    assert all(n["sources"] == 0 for n in g["nodes"])
    assert g["domain"] == s["root"].name


def test_sources_count_only_published_current_runs(workspace):
    s = workspace
    assert by_id(graph(s))["temperature"]["sources"] == 0
    publish(s)
    g = graph(s)
    nodes = by_id(g)
    assert nodes["temperature"]["sources"] == 1
    assert nodes["ambient"]["sources"] == 0 and nodes["peak"]["sources"] == 0
    assert group_counts(g) == {"plant": 1, "quality": 0}
    assert [x["root_concept_id"] for x in g["groups"]] == ["plant", "quality"]
    # 사람이 매핑을 고치면 head가 바뀌어 발행이 해제되고, 그래프도 즉시 0으로 돌아간다.
    aid = s["application"]["application_id"]
    mapping = s["api"]("GET", "/applications/" + aid + "/mappings")["items"][0]
    original = s["api"]("GET", "/mappings/" + mapping["mapping_revision_id"])
    s["api"](
        "POST",
        f"/applications/{aid}/mappings/{original['mapping_revision_id']}/revisions",
        {
            "expected_seq": original["edit_seq"],
            "effective_spec": original["effective_spec"],
            "concept_id": "temperature",
            "status": "approved",
            "reason": "재검수",
        },
    )
    assert s["api"]("GET", "/applications/" + aid)["published_run_id"] is None
    g = graph(s)
    assert by_id(g)["temperature"]["sources"] == 0
    assert group_counts(g) == {"plant": 0, "quality": 0}


def test_sources_follow_current_document_version(workspace):
    s = workspace
    publish(s)
    assert by_id(graph(s))["temperature"]["sources"] == 1
    wb = load_workbook(s["path"])
    second = s["path"].with_name("second.xlsx")
    wb.active["B5"] = "45"
    wb.save(second)
    job = s["work"](
        "/documents/register",
        {"source_refs": [second.name], "document_id": s["doc"]["document_id"]},
    )
    assert job["state"] == "succeeded", job
    g = graph(s)
    assert by_id(g)["temperature"]["sources"] == 0
    assert group_counts(g) == {"plant": 0, "quality": 0}


def test_deprecating_concept_publishes_revision_without_node(workspace):
    s = workspace
    publish(s)
    revised = s["api"](
        "POST",
        "/kg/" + s["kg"] + "/concepts/ambient/revisions",
        {"expected_revision_id": s["kg"], "status": "deprecated"},
    )
    new_kg = revised["kg_revision_id"]
    assert new_kg != s["kg"]
    g2 = graph(s, new_kg)
    nodes = by_id(g2)
    assert "ambient" not in nodes
    assert set(nodes) == {"plant", "quality", "temperature", "peak"}
    assert ("plant", "ambient") not in {
        (e["from_concept_id"], e["to_concept_id"]) for e in g2["edges"]
    }
    # 매핑은 이전 리비전에 고정되어 있으므로 새 리비전의 출처 수는 /series와 같이 0이다.
    assert nodes["temperature"]["sources"] == 0
    assert (
        s["api"](
            "GET", f"/series?kg_revision_id={new_kg}&concept_id=temperature"
        )["items"]
        == []
    )
    old = by_id(graph(s))
    assert "ambient" in old and old["temperature"]["sources"] == 1


def test_truncation_returns_partial_payload(workspace):
    s = workspace
    concepts = [
        {"concept_id": f"c{i}", "name": f"개념 {i}", "level": 1 if i < 5 else 2}
        for i in range(2001)
    ]
    relations = [[f"c{i % 5}", f"c{i}", "parent_of"] for i in range(5, 2001)]
    kg = s["api"]("POST", "/kg/import", {"concepts": concepts, "relations": relations})
    g = graph(s, kg["kg_revision_id"])
    assert g["truncated"] is True
    assert g["node_cap"] == 2000 and len(g["nodes"]) == 2000
    ids = {n["concept_id"] for n in g["nodes"]}
    assert {"c0", "c1", "c2", "c3", "c4"} <= ids
    assert all(
        e["from_concept_id"] in ids and e["to_concept_id"] in ids for e in g["edges"]
    )
    assert len(g["edges"]) == 2000 - 5
    assert len(g["groups"]) == 5
    assert all(n["root"] == f"c{int(n['concept_id'][1:]) % 5}" for n in g["nodes"])


def test_unknown_kg_is_not_found(workspace):
    body = workspace["api"]("GET", "/kg/missing/graph", code=404)
    assert body["error"]["code"] == "NOT_FOUND"


def test_graph_does_not_open_sources(workspace):
    s = workspace
    publish(s)
    original = s["service"].read

    def no_read(*args, **kwargs):
        raise AssertionError("graph opened source")

    s["service"].read = no_read
    try:
        assert by_id(graph(s))["temperature"]["sources"] == 1
    finally:
        s["service"].read = original


def test_concepts_exact_id_lookup(workspace):
    # 그래프에서 고른 개념이 검색 첫 페이지에 없을 때 편집기가 쓰는 정확 일치 조회.
    s = workspace
    page = s["api"]("GET", "/kg/" + s["kg"] + "/concepts?id=temperature")
    assert [c["concept_id"] for c in page["items"]] == ["temperature"]
    assert s["api"]("GET", "/kg/" + s["kg"] + "/concepts?id=nope")["items"] == []
    assert s["api"]("GET", "/kg/" + s["kg"] + "/concepts?q=온도&id=peak")["items"][0]["concept_id"] == "peak"


def test_multi_parent_picks_smallest_parent_and_orphan_has_no_root(workspace):
    # §4.9는 다부모 parent_of를 허용한다: 표시 부모는 concept_id 오름차순 첫 부모이고 root는 그 부모를 따른다.
    # parent_of 들어오는 엣지가 없는 L2는 parent/root 없이 남는다(문서군에 포함되지 않는다).
    s = workspace
    kg = s["api"](
        "POST",
        "/kg/import",
        {
            "concepts": [
                {"concept_id": "b", "name": "B", "level": 1},
                {"concept_id": "a", "name": "A", "level": 1},
                {"concept_id": "x", "name": "X", "level": 2},
                {"concept_id": "orphan", "name": "O", "level": 2},
                {"concept_id": "y", "name": "Y", "level": 3},
            ],
            "relations": [["b", "x", "parent_of"], ["a", "x", "parent_of"], ["x", "y", "parent_of"]],
        },
    )
    g = graph(s, kg["kg_revision_id"])
    n = by_id(g)
    assert n["x"]["parent"] == "a" and n["x"]["root"] == "a"
    assert n["y"]["parent"] == "x" and n["y"]["root"] == "a"
    assert n["orphan"]["parent"] is None and n["orphan"]["root"] is None
    assert len(g["edges"]) == 3
    assert [x["root_concept_id"] for x in g["groups"]] == ["a", "b"]


def test_graph_cache_invalidates_on_publish_and_new_version(workspace, monkeypatch):
    # 같은 발행 상태에서는 캐시된 그래프를 돌려주고, 발행·현재 버전이 바뀌면 다시 계산한다.
    from kg.v2 import graph as module

    s = workspace
    module._cache.clear()
    calls = []
    original = module._build_graph

    def counting(conn, kg, cap):
        calls.append(kg)
        return original(conn, kg, cap)

    monkeypatch.setattr(module, "_build_graph", counting)
    before = graph(s)
    assert graph(s) == before and len(calls) == 1
    publish(s)
    after = graph(s)
    assert len(calls) == 2 and after != before
    assert by_id(after)["temperature"]["sources"] == 1
    assert graph(s) == after and len(calls) == 2
    # 다른 상한(cap)은 별도 항목이며, 캐시는 도메인 이름을 요청마다 새로 붙인다.
    assert after["domain"] == s["root"].name
