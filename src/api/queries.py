"""API projection queries (설계문서 §12) — 프레임워크 독립 구현.

FastAPI 등 웹 프레임워크는 이 함수들을 얇게 감싸면 된다. UI가 필요로 하는
Concept Map projection(§12.1)과 lineage 역추적(Concept → field → sheet →
document → version, §11.1)을 DB에서 만든다.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from src.loader.versioned_loader import DEFAULT_PROCESS_ID, VersionedLoader
from src.mapping.concepts import ConceptRegistry

_ID_LIKE_RE = re.compile(r"^[A-Za-z]{1,6}[-_]?\d{3,}")
_ROW_FALLBACK_RE = re.compile(r"^row\d+$")


def _hub_key_like(bk: str) -> bool:
    """허브 키 판정 — api/store.HUB_KEY_SQL과 동일 규칙.

    LOT형 ID 또는 레시피명 같은 짧은 단일 토큰 키를 허용하고,
    제목 fallback(stem:sheet)과 rowN 임시 키는 제외한다."""
    if _ID_LIKE_RE.match(bk):
        return True
    return (":" not in bk and " " not in bk and len(bk) <= 24
            and not _ROW_FALLBACK_RE.match(bk))


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


# =============================== LOT 허브 (이미지 패널 5 — 개념 기반 통합 모델) ===

def lot_hub_projection(loader: VersionedLoader, business_key: str | None = None) -> dict:
    """LOT(배치)를 허브로 문서 횡단 레코드/개념을 통합한다.

    서로 다른 문서(생산일보/MES/QC/공정실적)가 같은 LOT를 다른 record_type으로
    적재해도 business_key로 조인되어 하나의 LOT 아래 모인다.
    """
    lots: dict[str, dict] = {}
    for rec in loader.current_records():
        bk = rec["business_key"]
        if not bk or not _hub_key_like(bk):
            continue
        if business_key and bk != business_key:
            continue
        lot = lots.setdefault(bk, {"lot": bk, "records": [], "documents": set(),
                                   "concepts": {}, "statuses": []})
        lot["records"].append({
            "record_key": rec["record_key"],
            "record_type": rec["record_type"],
            "event_time": rec["event_time"],
            "overall_status": rec["overall_status"],
            "source_sheet": rec["source_sheet"],
        })
        if rec["overall_status"]:
            lot["statuses"].append(rec["overall_status"])
        for o in loader.current_observations(rec["record_key"]):
            doc = o["source_sheet"]
            lot["documents"].add(doc)
            if o["concept_id"]:
                value = (o["normalized_value_num"] if o["normalized_value_num"] is not None
                         else o["normalized_value_text"])
                lot["concepts"].setdefault(o["concept_id"], []).append({
                    "value": value,
                    "unit": o["canonical_unit"],
                    "source": f'{o["source_sheet"]}!{o["source_address"]}',
                })
    for lot in lots.values():
        lot["documents"] = sorted(lot["documents"])
        lot["record_count"] = len(lot["records"])
    return {"process_id": DEFAULT_PROCESS_ID, "lots": dict(sorted(lots.items()))}


# ====================== 온톨로지 계층 (이미지 패널 1 — 개념 계층 그래프) ===

def ontology_projection(registry: ConceptRegistry) -> dict:
    """domain → concept 트리 (parent_concept 계층 포함)."""
    tree: dict[str, dict] = {}
    for key, meta in registry.domains.items():
        tree[key] = {"name_ko": meta.get("name_ko", key),
                     "name_en": meta.get("name_en", key), "concepts": []}
    for c in registry.concepts.values():
        dom = c.domain if c.domain in tree else "misc"
        tree.setdefault(dom, {"name_ko": dom, "name_en": dom, "concepts": []})
        tree[dom]["concepts"].append({
            "concept_id": c.concept_id,
            "name_ko": c.canonical_name_ko,
            "parent_concept": c.parent_concept,
            "canonical_unit": c.canonical_unit,
            "value_type": c.value_type,
            "synonyms": c.synonyms,
        })
    for dom in tree.values():
        dom["concepts"].sort(key=lambda c: c["concept_id"])
    return {"domains": tree}


# ================= 지식 그래프 (이미지 패널 2 — 개념 간 관계 그래프) ===

def load_relations(config_dir: Path) -> dict:
    with open(Path(config_dir) / "relations.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def entity_class_of(concept_id: str, registry: ConceptRegistry, relations_cfg: dict) -> str | None:
    for cls, meta in (relations_cfg.get("entity_classes") or {}).items():
        if concept_id in (meta.get("concepts") or []):
            return cls
    c = registry.concepts.get(concept_id)
    if c and c.domain:
        return (relations_cfg.get("domain_fallback") or {}).get(c.domain)
    return None


def knowledge_graph_projection(loader: VersionedLoader, registry: ConceptRegistry,
                               relations_cfg: dict) -> dict:
    """엔티티 클래스 노드 + 관계 엣지. 엣지 가중치는 현재 레코드에서
    두 클래스가 동시에 등장한 횟수(co-occurrence)로 근거를 단다.

    관측치 전체를 한 번만 스캔한다 — 레코드별 재조회(N+1) 없음.
    """
    from src.api.store import graph_scan

    classes = relations_cfg.get("entity_classes") or {}
    obs_count: dict[str, int] = {c: 0 for c in classes}
    instances: dict[str, set] = {c: set() for c in classes}
    class_cache: dict[str, str | None] = {}
    per_record: dict[str, set] = {}

    for o in graph_scan(loader.conn):
        cid = o["concept_id"]
        cls = class_cache.get(cid)
        if cid not in class_cache:
            cls = entity_class_of(cid, registry, relations_cfg)
            class_cache[cid] = cls
        if cls is None:
            continue
        obs_count[cls] = obs_count.get(cls, 0) + 1
        per_record.setdefault(o["record_key"], {"document"}).add(cls)
        if cls in ("lot", "equipment") and o["normalized_value_text"]:
            instances[cls].add(o["normalized_value_text"])
    record_classes = list(per_record.values())

    nodes = []
    for cls, meta in classes.items():
        nodes.append({
            "class": cls,
            "name_ko": meta.get("name_ko", cls),
            "observation_count": obs_count.get(cls, 0),
            "instances": sorted(instances.get(cls, set()))[:12],
        })
    edges = []
    for rel in relations_cfg.get("relations") or []:
        s, o = rel["subject"], rel["object"]
        weight = sum(1 for present in record_classes if s in present and o in present)
        edges.append({**rel, "evidence_records": weight})
    return {"nodes": nodes, "edges": edges}
