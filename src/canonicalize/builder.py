"""RecordBuilder / ObservationBuilder / package writer (설계문서 §6, §13).

Block → Record, Field → Observation 변환. 원본값과 정규화값을 모두 보존하고
(§1, §6.3), semantic hash로 의미 변경만 감지한다 (§9).

Grain 교정: 반복 카드형 문서는 Block=Record지만, 표형 문서(행=LOT)와
전치 표형 문서(열=LOT)는 식별자 행/열 단위로 Record를 분할한다.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from pathlib import Path

import json

from src.common.models import (
    BlockInfo,
    FieldInfo,
    MappingDecision,
    ObservationData,
    RecordData,
    Region,
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

# 행/열 분할 기준이 되는 식별자 패턴 (BT26821, LOT-A240818, R-201 …)
_ID_LIKE_RE = re.compile(r"^[A-Za-z]{1,6}[-_]?\d{3,}")

# Excel date serial (1899-12-30 기준) 판별 구간: 1954~2079년
_SERIAL_MIN, _SERIAL_MAX = 20000.0, 65500.0
_SERIAL_EPOCH = datetime(1899, 12, 30)

# business key 우선순위: LOT 계열 > 설비
_BK_PRIORITY = ["lot_no", "batch_no", "equipment_no"]


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


def serial_to_datetime(v: float) -> str | None:
    if isinstance(v, (int, float)) and _SERIAL_MIN <= float(v) <= _SERIAL_MAX:
        return (_SERIAL_EPOCH + timedelta(days=float(v))).isoformat(timespec="seconds")
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
        self._bk_concepts = {c.concept_id for c in registry.concepts.values() if c.is_business_key}

    # ------------------------------------------------------------ records ----
    def build_records(
        self,
        structure: WorkbookStructure,
        segmentations: list[SheetSegmentation],
        doc_synonyms: dict[str, str] | None = None,
    ) -> tuple[list[RecordData], list[MappingDecision]]:
        records: list[RecordData] = []
        decisions: dict[str, MappingDecision] = {}
        for seg in segmentations:
            for block in seg.blocks:
                records.extend(
                    self._build_records_for_block(structure, seg, block, decisions, doc_synonyms)
                )
        # record_key 충돌은 결정론적 suffix로 유일화 (동일 설비 반복 이벤트 등)
        seen: dict[str, int] = {}
        for rec in records:
            n = seen.get(rec.record_key, 0)
            seen[rec.record_key] = n + 1
            if n:
                rec.record_key = f"{rec.record_key}#{n + 1}"
        return records, list(decisions.values())

    # ----------------------------------------------------------- helpers ----
    def _decide(self, f: FieldInfo, doc: str, sheet: str, decisions, doc_synonyms) -> MappingDecision:
        d = self.mapper.decide(f, doc, sheet, doc_synonyms=doc_synonyms)
        return decisions.setdefault(d.field_signature, d)

    def _record_type(self, title: str, structure: WorkbookStructure, seg: SheetSegmentation) -> str:
        m = _TITLE_TYPE_RE.match(title)
        if m and m.group(1).strip():
            return m.group(1).strip()
        if title and title != seg.sheet_name:
            cleaned = re.split(r"[—–]", title)[0].strip()
            if 0 < len(cleaned) <= 40:
                return cleaned
        return f"{Path(structure.file_name).stem}:{seg.sheet_name}"

    def _obs_from_field(self, f: FieldInfo, decision: MappingDecision,
                        seg: SheetSegmentation) -> ObservationData:
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
        if concept is not None and concept.value_type == "datetime":
            iso = serial_to_datetime(raw_num) if raw_num is not None else None
            if iso:
                norm_text = iso
                norm_num = None
                raw_text = raw_text or str(value)
        if concept is not None and concept.value_type == "time":
            tm = _TIME_RE.match(str(value or ""))
            if tm:
                norm_text = f"{int(tm.group(1)):02d}:{tm.group(2)}"

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
        return ObservationData(
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

    # ------------------------------------------------------ split planning ----
    def _split_plan(self, block: BlockInfo, field_decisions: dict[str, MappingDecision]):
        """분할 대상 region과 방식 결정.

        by_row:     col_concept 표에 unique한 business-key 열이 있으면 행=Record
        by_row_key: row_concept(전치) 표의 인스턴스 열 이름이 식별자면 열=Record
        """
        for region in block.regions:
            if region.region_type not in ("TABLE", "PROFILE") or not region.fields:
                continue
            if region.orientation == "col_concept":
                rows: dict[int, list[FieldInfo]] = {}
                for f in region.fields:
                    r = int(re.match(r"[A-Z]+(\d+)", f.address).group(1))
                    rows.setdefault(r, []).append(f)
                if len(rows) < 2:
                    continue
                # 1순위: key 열 값(row_key)이 식별자면 그것이 business key
                #        (예: LOT 열이 표의 첫 열 = key 열인 경우)
                row_keys = {r: next((f.row_key for f in fs if f.row_key), None)
                            for r, fs in rows.items()}
                rk_vals = [v for v in row_keys.values() if v and _ID_LIKE_RE.match(v)]
                if len(rk_vals) == len(rows) and len(set(rk_vals)) == len(rk_vals):
                    return region, "by_row", rows, row_keys
                # 2순위: LOT/BATCH 개념으로 매핑된 열의 unique 값
                bk_vals: dict[int, str] = {}
                for f in region.fields:
                    d = field_decisions.get(f.field_id)
                    if d and d.decision == "auto" and d.concept_id in ("lot_no", "batch_no"):
                        r = int(re.match(r"[A-Z]+(\d+)", f.address).group(1))
                        bk_vals[r] = str(f.raw_value)
                if len(bk_vals) >= 2 and len(set(bk_vals.values())) == len(bk_vals):
                    return region, "by_row", rows, bk_vals
                # 3순위: equipment 등 식별자 열이 행마다 존재하면 분할 (중복 허용)
                for f in region.fields:
                    d = field_decisions.get(f.field_id)
                    if d and d.decision == "auto" and d.concept_id == "equipment_no":
                        r = int(re.match(r"[A-Z]+(\d+)", f.address).group(1))
                        bk_vals.setdefault(r, str(f.raw_value))
                if len(bk_vals) == len(rows) and len(bk_vals) >= 2:
                    return region, "by_row", rows, bk_vals
            elif region.orientation == "row_concept":
                groups: dict[str, list[FieldInfo]] = {}
                for f in region.fields:
                    groups.setdefault(f.row_key or "", []).append(f)
                id_groups = {k: v for k, v in groups.items() if _ID_LIKE_RE.match(k)}
                if len(id_groups) >= 2:
                    return region, "by_row_key", id_groups, None
        return None, None, None, None

    # ------------------------------------------------------------- blocks ----
    def _build_records_for_block(self, structure, seg, block: BlockInfo,
                                 decisions, doc_synonyms) -> list[RecordData]:
        doc = structure.file_name
        field_decisions: dict[str, MappingDecision] = {}
        note_parts: list[str] = []
        for region in block.regions:
            if region.region_type == "NOTE" and region.note_text:
                note_parts.append(region.note_text)
                continue
            for f in region.fields:
                field_decisions[f.field_id] = self._decide(f, doc, seg.sheet_name,
                                                           decisions, doc_synonyms)

        split_region, mode, groups, bk_vals = self._split_plan(block, field_decisions)

        if split_region is None:
            rec = self._assemble_record(
                structure, seg, block,
                fields=[f for r in block.regions for f in r.fields],
                field_decisions=field_decisions,
                note=" / ".join(note_parts) if note_parts else None,
                title_key_fallback=True,
                attachments=block.images,
            )
            return [rec]

        # 분할: 나머지 region(KV/SUMMARY 등)은 공통 문맥으로 각 레코드에 복제
        context_fields = [f for r in block.regions if r is not split_region for f in r.fields]
        records: list[RecordData] = []
        note = " / ".join(note_parts) if note_parts else None
        items = sorted(groups.items()) if mode == "by_row_key" else sorted(groups.items())
        for idx, (key, fields) in enumerate(items):
            bkey_hint = bk_vals.get(key) if (mode == "by_row" and bk_vals) else (
                key if mode == "by_row_key" else None)
            attach = block.images if idx == 0 else []
            rec = self._assemble_record(
                structure, seg, block,
                fields=list(fields) + context_fields,
                field_decisions=field_decisions,
                note=note,
                title_key_fallback=False,
                attachments=attach,
                bkey_hint=str(bkey_hint) if bkey_hint is not None else None,
                ordinal=idx,
            )
            records.append(rec)
        return records

    def _assemble_record(self, structure, seg, block: BlockInfo, *, fields, field_decisions,
                         note, title_key_fallback, attachments,
                         bkey_hint: str | None = None, ordinal: int = 0) -> RecordData:
        observations: list[ObservationData] = []
        obs_keys: dict[str, int] = {}
        overall_status: str | None = None
        result_status: str | None = None
        event_time: str | None = None
        bkey_by_concept: dict[str, str] = {}

        for f in fields:
            decision = field_decisions[f.field_id]
            obs = self._obs_from_field(f, decision, seg)
            n = obs_keys.get(obs.observation_key, 0)
            obs_keys[obs.observation_key] = n + 1
            if n:
                obs.observation_key = f"{obs.observation_key}#{n + 1}"
            observations.append(obs)

            concept = self.registry.concepts.get(decision.concept_id) if decision.concept_id else None
            value = f.cached_value if f.is_formula else f.raw_value
            if concept is not None and decision.decision == "auto":
                if concept.is_business_key and value is not None:
                    bkey_by_concept.setdefault(concept.concept_id, str(value))
                if concept.is_event_time and event_time is None and value is not None:
                    event_time = (parse_date(value)
                                  or serial_to_datetime(parse_number(value) or -1)
                                  or str(value))
                if concept.concept_id == "overall_judgment" and value is not None:
                    overall_status = str(value)
                if concept.concept_id == "judgment" and value is not None and obs.value_role == "result":
                    result_status = result_status or str(value)

        business_key = bkey_hint
        if business_key is None:
            for cid in _BK_PRIORITY:
                if cid in bkey_by_concept:
                    business_key = bkey_by_concept[cid]
                    break
        if business_key is None and title_key_fallback:
            m = _TITLE_KEY_RE.search(block.title)
            business_key = m.group(1) if m else block.title
        if business_key is None:
            business_key = f"row{ordinal + 1}"

        record_type = self._record_type(block.title, structure, seg)
        record_key = f"{record_type}|{business_key}|{event_time or ''}"

        return RecordData(
            record_key=record_key,
            record_type=record_type,
            business_key=business_key,
            event_time=event_time,
            overall_status=overall_status or result_status,
            note=note,
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
                for im in attachments
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
