"""Fixed Domain KG 로더 — domain_kg.yaml + units.yaml → DB 시드 (§5, §13.1).

Domain KG는 문서보다 안정적인 고정 의미축이다. YAML이 원본(source of truth)이고
DB 테이블은 조회/조인용 미러다. 재시드는 idempotent하다.
"""
from __future__ import annotations

from pathlib import Path

import yaml

from src.mapping.concepts import normalize_label
from src.units.converter import UnitRegistry

from kg.store import KgStore

VALID_RELATIONS = {"IS_A", "PART_OF", "AFFECTS", "MEASURED_BY", "RELATED_TO"}


def load_domain_kg(store: KgStore, kg_yaml: Path, units_yaml: Path | None = None) -> dict:
    cfg = yaml.safe_load(Path(kg_yaml).read_text(encoding="utf-8")) or {}
    n_alias = 0
    for c in cfg.get("concepts") or []:
        store.upsert_concept({
            "concept_id": c["concept_id"],
            "canonical_name": c["canonical_name"],
            "canonical_name_en": c.get("canonical_name_en"),
            "description": c.get("description"),
            "concept_type": c.get("concept_type"),
            "data_type": c.get("data_type"),
            "domain_level": c.get("domain_level"),
            "canonical_unit": c.get("canonical_unit"),
            "unit_dimension": c.get("unit_dimension"),
            "status": c.get("status", "ACTIVE"),
        })
        names = [c["canonical_name"], c.get("canonical_name_en") or "",
                 *(c.get("aliases") or [])]
        for a in names:
            if not a:
                continue
            store.add_alias(c["concept_id"], a, normalize_label(a))
            n_alias += 1

    n_rel = 0
    for src, dst, rel in cfg.get("relations") or []:
        if rel not in VALID_RELATIONS:
            raise ValueError(f"unknown relation type: {rel} ({src}->{dst})")
        store.add_relation(src, dst, rel)
        n_rel += 1

    units = None
    if units_yaml and Path(units_yaml).exists():
        units = UnitRegistry.load(Path(units_yaml))
        for (dim, symbol), (factor, offset) in units._params.items():
            store.upsert_unit(symbol, dim, factor, offset)
    store.commit()
    return {"concepts": len(cfg.get("concepts") or []), "aliases": n_alias,
            "relations": n_rel, "kg_version": str(cfg.get("version", "0")),
            "units": units}
