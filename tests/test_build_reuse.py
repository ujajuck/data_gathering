"""증분 빌드 — 구성·선택·원본이 그대로면 이전 산출물을 즉시 재사용한다.

서명 = 구성(필드/변환/include_nodes) + 선택 노드들의 현재 payload_id.
문서 재적재(payload 교체)·구성 변경은 서명을 바꿔 재계산을 강제한다.
"""
from __future__ import annotations

import copy
from pathlib import Path

from kg.integration.builder import build, define_project, find_reusable_build
from kg.store import KgStore, now_iso

N_DOCS, ROWS = 3, 10


def _ws(tmp_path) -> KgStore:
    store = KgStore(tmp_path / "kg.db")
    store.conn.execute(
        "INSERT INTO domain_concept (concept_id, canonical_name, data_type,"
        " canonical_unit, status) VALUES ('temp','온도','numeric','℃','ACTIVE')")
    for d in range(N_DOCS):
        doc, ver, nid, pid = f"doc{d}", f"v{d}", f"n{d}", f"p{d}"
        store.conn.execute("INSERT INTO document VALUES (?,?,NULL,'xlsx',?)",
                           (doc, f"{doc}.xlsx", ver))
        store.conn.execute("INSERT INTO document_version VALUES (?,?,?,NULL,?)",
                           (ver, doc, f"h{d}", now_iso()))
        store.conn.execute(
            """INSERT INTO tree_node (node_id, document_id, node_type, node_name,
                 tree_path, locator, data_type, unit, semantic_fingerprint,
                 content_fingerprint, status)
               VALUES (?,?,'HEADER','h',?,?,'numeric','℃',?,?,'ACTIVE')""",
            (nid, doc, f"{doc}/s/t/h", "s!A1", f"sf{d}", f"cf{d}"))
        store.conn.execute(
            "INSERT INTO semantic_mapping (mapping_id, tree_node_id, concept_id,"
            " confidence, status, is_active, created_at)"
            " VALUES (?,?,'temp',0.9,'AUTO_APPROVED',1,?)", (f"MAP-{d}", nid, now_iso()))
        store.conn.execute("INSERT INTO data_payload VALUES (?,?,?,?, 'ck', 1)",
                           (pid, nid, ver, ROWS))
        store.conn.executemany(
            "INSERT INTO payload_value VALUES (?,?,?,?,?,?)",
            [(pid, r, f"k{r}", d * 100.0 + r, None, f"A{r}") for r in range(ROWS)])
    store.conn.commit()
    return store


CONFIG = {
    "name": "reuse_out",
    "fields": [{"name": "temp", "concept": "temp", "type": "numeric", "unit": "℃"}],
    "sources": {"include_nodes": {"temp": [f"n{d}" for d in range(N_DOCS)]}},
    "transform": [{"op": "unit_convert"}, {"op": "union"}],
}


def test_unchanged_build_is_reused_and_changes_invalidate(tmp_path):
    store = _ws(tmp_path)
    out = tmp_path / "builds"
    first = build(store, define_project(store, CONFIG), out)
    assert first["rows"] == N_DOCS * ROWS

    # 무변경 재빌드 → 같은 산출물 즉시 재사용 (재계산·새 버전 없음)
    hit = find_reusable_build(store, CONFIG)
    assert hit is not None and hit["reused"]
    assert hit["build_id"] == first["build_id"]
    assert hit["output_db"] == first["output_db"]
    assert hit["rows"] == first["rows"]

    # 변환 구성이 바뀌면 재사용 불가
    changed = copy.deepcopy(CONFIG)
    changed["transform"].append({"op": "deduplicate"})
    assert find_reusable_build(store, changed) is None

    # 문서 재적재(payload 교체)면 재사용 불가 — 원본이 바뀌었다
    store.conn.execute("UPDATE data_payload SET is_current=0 WHERE payload_id='p0'")
    store.conn.execute("INSERT INTO data_payload VALUES ('p0b','n0','v0',1,'ck2',1)")
    store.conn.execute("INSERT INTO payload_value VALUES ('p0b',0,'k0',999.0,NULL,'A0')")
    store.conn.commit()
    assert find_reusable_build(store, CONFIG) is None

    # 산출 파일이 지워졌으면 재사용 불가 (다시 만든다)
    second = build(store, define_project(store, CONFIG), out)
    assert find_reusable_build(store, CONFIG)["build_id"] == second["build_id"]
    Path(second["output_db"]).unlink()
    assert find_reusable_build(store, CONFIG) is None

    # include_nodes 없는 구성(자동 역탐색)은 재사용하지 않는다 — 안전측
    auto = {k: v for k, v in CONFIG.items() if k != "sources"}
    build(store, define_project(store, auto), out)
    assert find_reusable_build(store, auto) is None
    store.close()
