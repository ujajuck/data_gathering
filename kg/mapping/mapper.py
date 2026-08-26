"""Semantic Mapping 오케스트레이션 — 미매핑 노드에 검색+판정을 수행한다 (§7).

대상: HEADER / SUB_HEADER 노드 (의미를 가질 수 있는 노드).
활성 매핑이 이미 있는 노드는 건너뛴다 — Tree Diff가 changed 노드의 매핑을
비활성화하므로, 재실행하면 변경분만 재평가된다 (§12.1 incremental mapping).
"""
from __future__ import annotations

from kg.mapping.judge import JudgeDecision, RuleJudge
from kg.mapping.retriever import DomainRetriever, build_context
from kg.store import KgStore

MAPPABLE_TYPES = ("HEADER", "SUB_HEADER")


def map_document(store: KgStore, retriever: DomainRetriever, judge,
                 document_id: str | None = None,
                 retry_unmapped: bool = False) -> dict:
    if not store.concepts():
        raise RuntimeError("Domain KG가 비어 있습니다 — 먼저 seed를 실행하세요. "
                           "(빈 KG로 매핑하면 전 노드가 UNMAPPED로 고착됩니다)")
    if retry_unmapped:
        # 사전이 자란 뒤 재평가: 활성 UNMAPPED 매핑을 비활성화해 재판정 대상으로
        # 되돌린다 (REJECTED는 사람의 결정이므로 자동 재평가하지 않는다 — §15)
        for m in store.conn.execute(
                "SELECT mapping_id FROM semantic_mapping "
                "WHERE is_active=1 AND status='UNMAPPED'").fetchall():
            store.deactivate_mapping(m["mapping_id"], action="REMAP",
                                     note="retry_unmapped")
    where = "n.node_type IN (?,?) AND n.status='ACTIVE'"
    params: list = list(MAPPABLE_TYPES)
    if document_id:
        where += " AND n.document_id=?"
        params.append(document_id)
    nodes = store.conn.execute(
        f"""SELECT n.* FROM tree_node n
            LEFT JOIN semantic_mapping m
              ON m.tree_node_id = n.node_id AND m.is_active=1
            WHERE {where} AND m.mapping_id IS NULL""", params).fetchall()

    stats = {"nodes": 0, "AUTO_APPROVED": 0, "REVIEW_REQUIRED": 0, "UNMAPPED": 0}
    for node in nodes:
        ctx = build_context(store, node)
        candidates = retriever.retrieve(ctx)
        d: JudgeDecision = judge.judge(ctx, candidates)
        store.save_mapping(
            node["node_id"], d.concept_id, d.confidence, d.method, d.status,
            context=ctx.as_dict(),
            candidates=[c.as_dict() for c in candidates],
            reason=d.reason)
        stats["nodes"] += 1
        stats[d.status] = stats.get(d.status, 0) + 1
    store.commit()
    return stats


def remap_reviewed(store: KgStore, mapping_id: str, concept_id: str,
                   reviewer: str) -> None:
    """검수자가 다른 개념으로 확정 — 기존 매핑 비활성화 + APPROVED 매핑 생성."""
    old = store.conn.execute(
        "SELECT * FROM semantic_mapping WHERE mapping_id=?", (mapping_id,)).fetchone()
    if old is None:
        raise KeyError(mapping_id)
    store.deactivate_mapping(mapping_id, action="REMAP", note=f"→ {concept_id}")
    store.save_mapping(old["tree_node_id"], concept_id, 1.0, "human", "APPROVED",
                       context={}, candidates=[], reason=f"reviewer={reviewer}")
    store.review(mapping_id, "REMAP", reviewer, f"→ {concept_id}")
    store.commit()
