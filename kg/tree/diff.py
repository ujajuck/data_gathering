"""Tree 버전 반영 + Diff — §12 문서 버전 및 변경 추적.

새 파싱 결과(NodeDraft 목록)를 기존 ACTIVE 트리와 node_id 기준으로 비교한다:

    unchanged : semantic_fingerprint 동일 → Mapping 재사용
                (content_fingerprint만 다르면 payload만 새 버전으로 교체)
    changed   : semantic_fingerprint 상이 → 노드 갱신 + Mapping 재평가 대상
    added     : 신규 노드 → 신규 Mapping 대상
    removed   : 사라진 노드 → REMOVED 처리 + Mapping 비활성화
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field as dc_field

from kg.store import KgStore, new_id, now_iso
from kg.tree.builder import NodeDraft


@dataclass
class TreeDiff:
    version_id: str
    unchanged: list[str] = dc_field(default_factory=list)
    changed: list[str] = dc_field(default_factory=list)
    added: list[str] = dc_field(default_factory=list)
    removed: list[str] = dc_field(default_factory=list)

    def summary(self) -> dict:
        return {"version_id": self.version_id,
                "unchanged": len(self.unchanged), "changed": len(self.changed),
                "added": len(self.added), "removed": len(self.removed)}


def _insert_node(store: KgStore, d: NodeDraft, document_id: str, version_id: str) -> None:
    store.conn.execute(
        """INSERT INTO tree_node (node_id, document_id, parent_node_id, node_type,
             node_name, tree_path, locator, data_type, unit, semantic_fingerprint,
             content_fingerprint, representative_values, metadata, status,
             created_version_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?)""",
        (d.node_id, document_id, d.parent_node_id, d.node_type, d.node_name,
         d.tree_path, d.locator, d.data_type, d.unit, d.semantic_fingerprint,
         d.content_fingerprint,
         json.dumps(d.representative_values, ensure_ascii=False, default=str),
         json.dumps(d.metadata, ensure_ascii=False, default=str), version_id))


def _update_node(store: KgStore, d: NodeDraft) -> None:
    store.conn.execute(
        """UPDATE tree_node SET parent_node_id=?, node_type=?, node_name=?, locator=?,
             data_type=?, unit=?, semantic_fingerprint=?, content_fingerprint=?,
             representative_values=?, metadata=?, status='ACTIVE', removed_version_id=NULL
           WHERE node_id=?""",
        (d.parent_node_id, d.node_type, d.node_name, d.locator, d.data_type, d.unit,
         d.semantic_fingerprint, d.content_fingerprint,
         json.dumps(d.representative_values, ensure_ascii=False, default=str),
         json.dumps(d.metadata, ensure_ascii=False, default=str), d.node_id))


def _write_payload(store: KgStore, d: NodeDraft, version_id: str) -> None:
    if not d.payload_rows:
        return
    store.conn.execute(
        "UPDATE data_payload SET is_current=0 WHERE tree_node_id=? AND is_current=1",
        (d.node_id,))
    pid = new_id("PAY")
    store.conn.execute(
        "INSERT INTO data_payload VALUES (?,?,?,?,?,1)",
        (pid, d.node_id, version_id, len(d.payload_rows), d.content_fingerprint))
    store.conn.executemany(
        "INSERT INTO payload_value VALUES (?,?,?,?,?,?)",
        [(pid, i, rk, num, text, addr)
         for i, (rk, num, text, addr) in enumerate(d.payload_rows)])


def apply_tree(store: KgStore, document_id: str, filename: str, filepath: str,
               file_hash: str, parser_version: str, drafts: list[NodeDraft]) -> TreeDiff:
    """새 트리를 DB에 반영하고 diff를 돌려준다 (idempotent: 같은 내용이면 전부 unchanged)."""
    store.upsert_document(document_id, filename, filepath)
    old = store.active_nodes(document_id)
    version_id = store.add_version(document_id, file_hash, parser_version)
    diff = TreeDiff(version_id=version_id)
    new_ids = {d.node_id for d in drafts}

    for d in drafts:
        prev = old.get(d.node_id)
        if prev is None:
            _insert_node(store, d, document_id, version_id)
            _write_payload(store, d, version_id)
            diff.added.append(d.node_id)
        elif prev["semantic_fingerprint"] == d.semantic_fingerprint:
            diff.unchanged.append(d.node_id)
            if prev["content_fingerprint"] != d.content_fingerprint:
                _update_node(store, d)          # 값만 변경 — 의미 지문은 유지
                _write_payload(store, d, version_id)
        else:
            _update_node(store, d)
            _write_payload(store, d, version_id)
            diff.changed.append(d.node_id)
            m = store.active_mapping(d.node_id)
            if m is not None:
                store.deactivate_mapping(m["mapping_id"], action="REMAP",
                                         note=f"semantic fingerprint changed @ {version_id}")

    for node_id, prev in old.items():
        if node_id in new_ids:
            continue
        store.conn.execute(
            "UPDATE tree_node SET status='REMOVED', removed_version_id=? WHERE node_id=?",
            (version_id, node_id))
        store.conn.execute(
            "UPDATE data_payload SET is_current=0 WHERE tree_node_id=?", (node_id,))
        diff.removed.append(node_id)
        m = store.active_mapping(node_id)
        if m is not None:
            store.deactivate_mapping(m["mapping_id"], action="DEACTIVATE",
                                     note=f"node removed @ {version_id}")

    store.commit()
    return diff
