"""Core dataclasses shared across the pipeline.

The pipeline stages exchange plain dataclasses that serialize to JSON so that
every intermediate artifact (structure, mapped, canonical package) is a
reproducible, diffable file (설계문서 §8.5).
"""
from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from typing import Any, Optional


def to_jsonable(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: to_jsonable(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj


def dumps(obj: Any) -> str:
    return json.dumps(to_jsonable(obj), ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------- inspect ----

@dataclass
class CellInfo:
    """One physical cell with everything downstream stages may need."""
    address: str                     # "B9"
    row: int
    col: int
    value: Any = None                # raw stored value (formula text if formula)
    cached_value: Any = None         # last calculated value for formulas
    is_formula: bool = False
    formula: Optional[str] = None
    formula_refs: list[str] = field(default_factory=list)
    fill_rgb: Optional[str] = None   # "FFFFF2CC"
    bold: bool = False
    number_format: Optional[str] = None
    merged_range: Optional[str] = None   # "A1:H2" if this is a merge master
    merged_into: Optional[str] = None    # range if covered by another master


@dataclass
class ImageInfo:
    image_hash: str                  # sha256 of binary
    anchor_row: int                  # 0-based top-left anchor
    anchor_col: int
    media_path: str                  # e.g. "xl/media/image2.png"
    ext: str = "png"


@dataclass
class SheetStructure:
    sheet_name: str
    sheet_index: int
    max_row: int
    max_col: int
    cells: list[CellInfo] = field(default_factory=list)
    merged_ranges: list[str] = field(default_factory=list)
    images: list[ImageInfo] = field(default_factory=list)


@dataclass
class WorkbookStructure:
    file_name: str
    relative_path: str
    sha256: str
    file_size: int
    modified_time: float
    parser_version: str
    sheets: list[SheetStructure] = field(default_factory=list)

    def structure_hash(self) -> str:
        """Hash of layout-level facts (addresses, merges, formulas, styles)."""
        import hashlib
        parts = []
        for s in self.sheets:
            parts.append(s.sheet_name)
            parts.append(",".join(sorted(s.merged_ranges)))
            for c in sorted(s.cells, key=lambda c: (c.row, c.col)):
                parts.append(f"{c.address}|{c.is_formula}|{c.formula or ''}|{c.fill_rgb or ''}|{c.bold}")
        return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- segment ----

REGION_TYPES = ("TABLE", "KEY_VALUE", "PROFILE", "SUMMARY", "NOTE", "IMAGE_ZONE", "LEGEND", "TITLE")


@dataclass
class FieldInfo:
    """A source field: one labelled value cell inside a region (설계문서 §6.2)."""
    field_id: str
    address: str                     # value cell address
    label_address: Optional[str]
    raw_label: str
    header_path: list[str] = field(default_factory=list)
    raw_value: Any = None
    cached_value: Any = None
    is_formula: bool = False
    formula: Optional[str] = None
    formula_refs: list[str] = field(default_factory=list)
    raw_unit: Optional[str] = None   # unit as written next to/inside the label
    style_role: str = "unknown"      # input/calculated/warning/error/header/unknown
    fill_rgb: Optional[str] = None
    row_key: Optional[str] = None    # e.g. sample id "S1" for table rows


@dataclass
class Region:
    region_id: str
    region_type: str                 # one of REGION_TYPES
    bbox: str                        # "A7:E11"
    min_row: int
    max_row: int
    min_col: int
    max_col: int
    layout_fingerprint: str = ""
    orientation: str = ""            # col_concept(개념=열) / row_concept(개념=행)
    fields: list[FieldInfo] = field(default_factory=list)
    note_text: Optional[str] = None


@dataclass
class BlockInfo:
    """One repeated card/report block == one business Record (설계문서 §4.3)."""
    block_id: str
    sheet_name: str
    title: str
    title_address: str
    min_row: int
    max_row: int
    layout_fingerprint: str = ""
    regions: list[Region] = field(default_factory=list)
    images: list[ImageInfo] = field(default_factory=list)

    def content_hash(self) -> str:
        import hashlib
        parts = [self.title]
        for r in self.regions:
            for f in sorted(r.fields, key=lambda f: f.address):
                parts.append(f"{f.raw_label}|{f.raw_value!r}|{f.cached_value!r}")
        for im in self.images:
            parts.append(im.image_hash)
        return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


@dataclass
class SheetSegmentation:
    sheet_name: str
    sheet_index: int
    blocks: list[BlockInfo] = field(default_factory=list)
    style_semantics: dict[str, str] = field(default_factory=dict)  # fill rgb -> meaning text
    legend_bbox: Optional[str] = None


# ---------------------------------------------------------------- mapping ----

@dataclass
class MappingCandidate:
    concept_id: str
    confidence: float
    reasons: dict[str, Any] = field(default_factory=dict)


@dataclass
class MappingDecision:
    field_signature: str             # doc-type/sheet/header_path signature
    raw_label: str
    context: str
    concept_id: Optional[str]
    confidence: float
    reasons: dict[str, Any] = field(default_factory=dict)
    decision: str = "auto"           # auto / pending / approved / rejected
    mapping_version: str = ""


# ----------------------------------------------------------- canonicalize ----

@dataclass
class ObservationData:
    observation_key: str             # stable within record
    concept_id: Optional[str]
    raw_label: str
    header_path: list[str]
    raw_value_text: Optional[str]
    raw_value_num: Optional[float]
    normalized_value_text: Optional[str]
    normalized_value_num: Optional[float]
    raw_unit: Optional[str]
    canonical_unit: Optional[str]
    value_role: str                  # input/measured/calculated/result
    status_code: Optional[str]
    source_sheet: str
    source_address: str
    row_key: Optional[str] = None
    mapping_confidence: float = 0.0
    mapping_decision: str = "auto"


@dataclass
class RecordData:
    record_key: str                  # stable business key
    record_type: str
    business_key: str
    event_time: Optional[str]
    overall_status: Optional[str]
    note: Optional[str]
    source_sheet: str
    source_block_bbox: str
    block_fingerprint: str
    block_content_hash: str
    observations: list[ObservationData] = field(default_factory=list)
    attachments: list[dict] = field(default_factory=list)

    def semantic_hash(self) -> str:
        """Hash of business meaning only — layout/style independent (§9)."""
        import hashlib
        parts = [self.record_type, self.business_key, str(self.event_time)]
        for o in sorted(self.observations, key=lambda o: o.observation_key):
            parts.append(
                f"{o.observation_key}|{o.concept_id}|{o.normalized_value_text!r}|"
                f"{o.normalized_value_num!r}|{o.canonical_unit}|{o.value_role}|{o.status_code}"
            )
        for a in sorted(self.attachments, key=lambda a: a.get("image_hash", "")):
            parts.append(a.get("image_hash", ""))
        return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
