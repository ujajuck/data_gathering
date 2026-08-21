"""API projection queries (설계문서 §12) — 프레임워크 독립 구현.

FastAPI 등 웹 프레임워크는 이 함수들을 얇게 감싸면 된다. UI가 필요로 하는
Concept Map projection(§12.1)과 lineage 역추적(Concept → field → sheet →
document → version, §11.1)을 DB에서 만든다.
"""
from __future__ import annotations

from src.loader.versioned_loader import DEFAULT_PROCESS_ID, VersionedLoader
from src.mapping.concepts import ConceptRegistry


def concept_map_projection(loader: VersionedLoader, registry: ConceptRegistry) -> dict:
    """GET /processes/{id}/concepts 응답 (§12.1)."""
    conn = loader.conn
    counts = {
        r["concept_id"]: r
        for r in conn.execute(
            """SELECT concept_id, count(*) source_count
               FROM v_current_observation WHERE concept_id IS NOT NULL
               GROUP BY concept_id"""
        )
    }
    unresolved = {
        r["concept_id"]: r["n"]
        for r in conn.execute(
            """SELECT concept_id, count(*) n FROM mapping_decision
               WHERE decision='pending' GROUP BY concept_id"""
        )
    }
    concepts = []
    for cid, row in counts.items():
        c = registry.concepts.get(cid)
        concepts.append({
            "concept_id": cid,
            "name": c.canonical_name_ko if c else cid,
            "canonical_unit": c.canonical_unit if c else None,
            "source_count": row["source_count"],
            "unresolved_count": unresolved.get(cid, 0),
        })
    edges = [
        {
            "concept_id": r["concept_id"],
            "document": r["logical_name"],
            "sheet_name": r["source_sheet"],
            "address": r["source_address"],
            "line_style": "dotted",   # Data pin overlay (§11.1)
        }
        for r in loader.conn.execute(
            """SELECT DISTINCT o.concept_id, o.source_sheet, o.source_address, sd.logical_name
               FROM v_current_observation o
               JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
               JOIN source_document sd ON sd.document_id = dv.document_id
               WHERE o.concept_id IS NOT NULL"""
        )
    ]
    return {"process_id": DEFAULT_PROCESS_ID, "concepts": sorted(concepts, key=lambda c: c["concept_id"]),
            "source_edges": edges}


def concept_sources(loader: VersionedLoader, concept_id: str) -> list[dict]:
    """GET /concepts/{id}/sources — concept → field → sheet → document → 버전 역추적."""
    return [
        dict(r)
        for r in loader.conn.execute(
            """SELECT o.record_key, o.raw_label, o.header_path, o.source_sheet,
                      o.source_address, sd.logical_name AS document,
                      dv.dvc_hash, dv.sha256, dv.detected_at
               FROM v_current_observation o
               JOIN document_version dv ON dv.document_version_id = o.source_document_version_id
               JOIN source_document sd ON sd.document_id = dv.document_id
               WHERE o.concept_id = ?
               ORDER BY o.record_key""",
            (concept_id,),
        )
    ]


def document_versions(loader: VersionedLoader, logical_name: str) -> list[dict]:
    """GET /documents/{id}/versions — DVC/semantic 버전 이력 (§11.4)."""
    return [
        dict(r)
        for r in loader.conn.execute(
            """SELECT dv.document_version_id, dv.dvc_hash, dv.sha256, dv.structure_hash,
                      dv.semantic_hash, dv.parser_version, dv.mapping_version,
                      dv.detected_at, dv.is_current
               FROM document_version dv
               JOIN source_document sd ON sd.document_id = dv.document_id
               WHERE sd.logical_name = ?
               ORDER BY dv.detected_at""",
            (logical_name,),
        )
    ]
