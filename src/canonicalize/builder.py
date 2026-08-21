"""RecordBuilder / ObservationBuilder / package writer (설계문서 §6, §13).

Block → Record, Field → Observation 변환. 원본값과 정규화값을 모두 보존하고
(§1, §6.3), semantic hash로 의미 변경만 감지한다 (§9).
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

from src.common.models import (
    BlockInfo,
    MappingDecision,
    ObservationData,
    RecordData,
    SheetSegmentation,
    WorkbookStructure,
    to_jsonable,
)
from src.mapping.concepts import ConceptMapper, ConceptRegistry
from src.units.converter import UnitRegistry

_DATE_RE = re.compile(r"^\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*$")
_TIME_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$")
_NUM_RE = re.compile(r"^\s*[-+]?\d+(\.\d+)?\s*$")
_TITLE_KEY_RE = re.compile(r"[|/]\s*([A-Za-z0-9\-_.#]+)\s*$")
_TITLE_TYPE_RE = re.compile(r"^\s*([^#|/]*?)\s*#?\d*\s*[|/#]")


def parse_date(v) -> str | None:
    if isinstance(v, (datetime, date)):
        return v.isoformat()[:10]
    m = _DATE_RE.match(str(v or ""))
    if m:
        y, mo, d = (int(g) for g in m.groups())
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            return None
    return None


def parse_number(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and _NUM_RE.match(v):
        return float(v)
    return None


class RecordBuilder:
    def __init__(self, registry: ConceptRegistry, units: UnitRegistry, mapper: ConceptMapper):
        self.registry = registry
        self.units = units
        self.mapper = mapper

    # ------------------------------------------------------------ records ----
    def build_records(
        self,
        structure: WorkbookStructure,
        segmentations: list[SheetSegmentation],
    ) -> tuple[list[RecordData], list[MappingDecision]]:
        records: list[RecordData] = []
        decisions: dict[str, MappingDecision] = {}
        for seg in segmentations:
            for block in seg.blocks:
                rec = self._build_record(structure, seg, block, decisions)
                records.append(rec)
        return records, list(decisions.values())

    def _record_type(self, title: str, structure: WorkbookStructure, seg: SheetSegmentation) -> str:
        m = _TITLE_TYPE_RE.match(title)
        if m and m.group(1).strip():
            return m.group(1).strip()
        return f"{Path(structure.file_name).stem}:{seg.sheet_name}"

    def _build_record(self, structure, seg, block: BlockInfo, decisions) -> RecordData:
        doc = structure.file_name
        observations: list[ObservationData] = []
        note_parts: list[str] = []
        overall_status: str | None = None
        event_time: str | None = None
        business_key: str | None = None

        for region in block.regions:
            if region.region_type == "NOTE" and region.note_text:
                note_parts.append(region.note_text)
                continue
            for f in region.fields:
                decision = self.mapper.decide(f, doc, seg.sheet_name)
                decisions.setdefault(decision.field_signature, decision)
                concept = self.registry.concepts.get(decision.concept_id) if decision.concept_id else None

                value = f.cached_value if f.is_formula else f.raw_value
                raw_num = parse_number(value)
                raw_text = None if raw_num is not None else (str(value) if value is not None else None)

                # 결정론적 정규화: 단위 변환 (§5.1 canonical_unit 기준)
                norm_num, canonical_unit = raw_num, f.raw_unit
                if concept is not None and concept.canonical_unit and raw_num is not None:
                    canonical_unit = concept.canonical_unit
                    if f.raw_unit and self.units.compatible(f.raw_unit, concept.canonical_unit):
                        norm_num = self.units.convert(raw_num, f.raw_unit, concept.canonical_unit)
                norm_text = raw_text
                d = parse_date(value)
                if concept is not None and concept.value_type == "date" and d:
                    norm_text = d
                if concept is not None and concept.value_type == "time":
                    tm = _TIME_RE.match(str(value or ""))
                    if tm:
                        norm_text = f"{int(tm.group(1)):02d}:{tm.group(2)}"

                # value role 결정: 수식 → calculated, 판정 → result, 스타일 → input
                if f.style_role == "result":
                    role = "result"
                elif f.is_formula:
                    role = "calculated"
                elif f.style_role == "input":
                    role = "input"
                else:
                    role = "measured"

                status_code = str(value) if role == "result" and value is not None else None

                obs_key = ".".join(x for x in [">".join(f.header_path), f.row_key] if x)
                observations.append(
                    ObservationData(
                        observation_key=obs_key,
                        concept_id=decision.concept_id if decision.decision == "auto" else None,
                        raw_label=f.raw_label,
                        header_path=f.header_path,
                        raw_value_text=raw_text,
                        raw_value_num=raw_num,
                        normalized_value_text=norm_text,
                        normalized_value_num=norm_num,
                        raw_unit=f.raw_unit,
                        canonical_unit=canonical_unit,
                        value_role=role,
                        status_code=status_code,
                        source_sheet=seg.sheet_name,
                        source_address=f.address,
                        row_key=f.row_key,
                        mapping_confidence=decision.confidence,
                        mapping_decision=decision.decision,
                    )
                )

                # business key / event time / overall status 추출
                if concept is not None and decision.decision == "auto":
                    if concept.is_business_key and business_key is None and value is not None:
                        business_key = str(value)
                    if concept.is_event_time and event_time is None:
                        event_time = d or (str(value) if value else None)
                    if concept.concept_id == "overall_judgment" and value is not None:
                        overall_status = str(value)

        if business_key is None:
            m = _TITLE_KEY_RE.search(block.title)
            business_key = m.group(1) if m else block.title
        record_type = self._record_type(block.title, structure, seg)
        # 위치가 아니라 업무 키 기반의 안정 키 — 행 이동/서식 변경에 불변 (§8.6)
        record_key = f"{record_type}|{business_key}|{event_time or ''}"

        return RecordData(
            record_key=record_key,
            record_type=record_type,
            business_key=business_key,
            event_time=event_time,
            overall_status=overall_status,
            note=" / ".join(note_parts) if note_parts else None,
            source_sheet=seg.sheet_name,
            source_block_bbox=f"{block.min_row}:{block.max_row}",
            block_fingerprint=block.layout_fingerprint,
            block_content_hash=block.content_hash(),
            observations=observations,
            attachments=[
                {
                    "image_hash": im.image_hash,
                    "source_anchor": f"{seg.sheet_name}!R{im.anchor_row + 1}C{im.anchor_col + 1}",
                    "media_path": im.media_path,
                    "ext": im.ext,
                }
                for im in block.images
            ],
        )


class PackageWriter:
    """Canonical package = records.jsonl + mapping_log.jsonl + manifest.json (§8.5).

    JSONL은 결정론적이고 diff 가능한 산출물이다. (Parquet은 pyarrow가 있을 때
    추가 export로 확장 가능 — 계약은 manifest가 정의한다.)
    """

    def write(self, out_dir: Path, structure: WorkbookStructure,
              records: list[RecordData], decisions: list[MappingDecision],
              versions: dict) -> dict:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        with open(out_dir / "records.jsonl", "w", encoding="utf-8") as fh:
            for r in sorted(records, key=lambda r: r.record_key):
                row = to_jsonable(r)
                row["semantic_hash"] = r.semantic_hash()
                fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

        with open(out_dir / "mapping_log.jsonl", "w", encoding="utf-8") as fh:
            for d in sorted(decisions, key=lambda d: d.field_signature):
                fh.write(json.dumps(to_jsonable(d), ensure_ascii=False, sort_keys=True) + "\n")

        manifest = {
            "document": structure.file_name,
            "relative_path": structure.relative_path,
            "sha256": structure.sha256,
            "structure_hash": structure.structure_hash(),
            "record_count": len(records),
            "pending_mappings": sum(1 for d in decisions if d.decision == "pending"),
            "record_semantic_hashes": {r.record_key: r.semantic_hash() for r in records},
            **versions,
        }
        with open(out_dir / "manifest.json", "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, sort_keys=True, indent=2)
        return manifest
