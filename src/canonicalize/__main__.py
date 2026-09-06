"""DVC stage: canonicalize — 재현 가능한 canonical package 생성 (설계문서 §8.5).

python -m src.canonicalize --raw data/raw --out data/canonical
"""
from __future__ import annotations

import argparse
from pathlib import Path

from src.canonicalize.builder import PackageWriter, RecordBuilder
from src.inspect.inspector import PARSER_VERSION, WorkbookInspector
from src.mapping.concepts import ConceptMapper, ConceptRegistry
from src.segment.detector import segment_workbook
from src.units.converter import UnitRegistry


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--config", type=Path, default=Path("config"))
    args = ap.parse_args()

    registry = ConceptRegistry.load(args.config / "concepts.yaml")
    units = UnitRegistry.load(args.config / "units.yaml")
    mapper = ConceptMapper(registry, units)
    inspector = WorkbookInspector()
    builder = RecordBuilder(registry, units, mapper)
    writer = PackageWriter()
    versions = {
        "parser_version": PARSER_VERSION,
        "concept_dictionary_version": registry.version,
        "unit_rule_version": units.version,
        "mapping_version": mapper.mapping_version,
    }
    for p in sorted(Path(args.raw).glob("*.xlsx")):
        if p.name.startswith("~$"):
            continue
        structure = inspector.inspect(p)
        segs = segment_workbook(structure)
        records, decisions = builder.build_records(structure, segs)
        writer.write(args.out / p.stem, structure, records, decisions, versions)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
