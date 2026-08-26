"""Knowledge Tree Builder — Parser 출력을 영속 Document Knowledge Tree로 (§6, §14).

기존 파서(WorkbookInspector + RegionDetector)를 §14.1 Parser 계약의 구현체로
재사용한다. 이 계층은 파서 산출물(WorkbookStructure/SheetSegmentation)만 알고
파서 내부 기술에는 종속되지 않는다.

Tree 구조 (§3.2):
    DOCUMENT → SHEET → TABLE(block/region) → [SUB_HEADER…] → HEADER → payload
이미지 등 Asset은 SHEET/TABLE 하위 IMAGE 노드로 보존한다 (§6.4).

node_id는 (document_id, tree_path)의 안정 해시다 — 행이 밀려도 경로가 같으면
같은 노드이며(§12.1 unchanged→Mapping 재사용), 헤더 텍스트가 바뀌면 다른
노드가 된다(removed+added).
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field as dc_field
from pathlib import Path

from src.common.models import FieldInfo, SheetSegmentation, WorkbookStructure

from kg.store import KgStore, stable_id

_ADDR_RE = re.compile(r"([A-Z]+)(\d+)")
_REPR_LIMIT = 4


def _cell_row(address: str | None) -> int:
    m = _ADDR_RE.match(address or "")
    return int(m.group(2)) if m else 0


def _fp(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True,
                                     default=str).encode()).hexdigest()[:16]


@dataclass
class NodeDraft:
    """DB 반영 전의 트리 노드 초안 (payload 포함)."""
    node_id: str
    parent_node_id: str | None
    node_type: str
    node_name: str
    tree_path: str
    locator: str | None = None
    data_type: str | None = None
    unit: str | None = None
    representative_values: list = dc_field(default_factory=list)
    metadata: dict = dc_field(default_factory=dict)
    # payload rows: (row_key|None, value_num|None, value_text|None, cell_address)
    payload_rows: list[tuple] = dc_field(default_factory=list)
    semantic_fingerprint: str = ""
    content_fingerprint: str = ""

    def finalize(self) -> None:
        # 값에서 유도되는 것(대표값, 관찰 data_type)은 content 지문에만 넣는다 —
        # 값 수정이 의미 재매핑을 유발하지 않도록 semantic/content를 분리한다
        # (§12.2 권장: semantic fingerprint와 content fingerprint의 분리).
        self.semantic_fingerprint = _fp([
            self.node_type, self.tree_path, self.node_name, self.unit])
        self.content_fingerprint = _fp([
            self.semantic_fingerprint, self.data_type, self.representative_values,
            [(r[0], r[1], r[2]) for r in self.payload_rows]])


def _value_of(f: FieldInfo) -> tuple[float | None, str | None]:
    v = f.cached_value if f.is_formula and f.cached_value is not None else f.raw_value
    if isinstance(v, bool):
        return None, str(v)
    if isinstance(v, (int, float)):
        return float(v), None
    if v is None:
        return None, None
    return None, str(v)


def _infer_dtype(rows: list[tuple]) -> str:
    nums = sum(1 for r in rows if r[1] is not None)
    texts = sum(1 for r in rows if r[2] is not None)
    total = nums + texts
    if not total:
        return "empty"
    if nums >= total * 0.8:
        return "numeric"
    if texts >= total * 0.8:
        return "text"
    return "mixed"


class KnowledgeTreeBuilder:
    """Parse 결과 → NodeDraft 트리. DB 반영은 tree.diff.apply_tree가 맡는다."""

    def build(self, document_id: str, structure: WorkbookStructure,
              segmentations: list[SheetSegmentation]) -> list[NodeDraft]:
        drafts: list[NodeDraft] = []
        root = NodeDraft(
            node_id=stable_id(document_id, "doc"),
            parent_node_id=None, node_type="DOCUMENT",
            node_name=structure.file_name, tree_path="doc",
            metadata={"relative_path": structure.relative_path,
                      "sheet_count": len(structure.sheets)})
        drafts.append(root)

        for seg in segmentations:
            sheet_path = f"doc/{seg.sheet_name}"
            sheet = NodeDraft(
                node_id=stable_id(document_id, sheet_path),
                parent_node_id=root.node_id, node_type="SHEET",
                node_name=seg.sheet_name, tree_path=sheet_path,
                locator=seg.sheet_name,
                metadata={"style_semantics": seg.style_semantics or {}})
            drafts.append(sheet)

            title_occ: Counter = Counter()
            for block in seg.blocks:
                title = block.title or seg.sheet_name
                occ = title_occ[title]
                title_occ[title] += 1
                block_path = f"{sheet_path}/{title}#{occ}"
                first_table: NodeDraft | None = None
                sig_occ: Counter = Counter()
                for region in block.regions:
                    # Region 정체성은 위치 인덱스가 아니라 구조 시그니처로 잡는다 —
                    # 앞 Region이 삭제돼도 살아남은 Region이 남의 node_id를
                    # 물려받지 않는다 (같은 구조 반복만 발생 순서로 구분).
                    sig = f"{region.region_type}:{(region.layout_fingerprint or '')[:10]}"
                    table_path = f"{block_path}/{sig}#{sig_occ[sig]}"
                    sig_occ[sig] += 1
                    table = NodeDraft(
                        node_id=stable_id(document_id, table_path),
                        parent_node_id=sheet.node_id, node_type="TABLE",
                        node_name=title, tree_path=table_path,
                        locator=f"{seg.sheet_name}!{region.bbox}",
                        metadata={"region_type": region.region_type,
                                  "orientation": region.orientation,
                                  "note": getattr(region, "note_text", None)})
                    drafts.append(table)
                    if first_table is None:
                        first_table = table
                    drafts.extend(self._header_nodes(document_id, table, region))
                img_seen: Counter = Counter()
                for img in block.images:
                    k = img_seen[img.image_hash]
                    img_seen[img.image_hash] += 1
                    ipath = f"{block_path}/img/{img.image_hash[:12]}#{k}"
                    anchor_parent = first_table or sheet
                    drafts.append(NodeDraft(
                        node_id=stable_id(document_id, ipath),
                        parent_node_id=anchor_parent.node_id, node_type="IMAGE",
                        node_name=f"image:{img.image_hash[:8]}", tree_path=ipath,
                        locator=f"{seg.sheet_name}!R{img.anchor_row}C{img.anchor_col}",
                        metadata={"image_hash": img.image_hash, "ext": img.ext}))

        for d in drafts:
            d.finalize()
        return drafts

    # -------------------------------------------------------------------------
    def _header_nodes(self, document_id: str, table: NodeDraft, region) -> list[NodeDraft]:
        """Region의 필드를 (header_path, raw_label) 단위 HEADER 노드로 묶는다."""
        groups: dict[tuple, list[FieldInfo]] = {}
        for f in region.fields:
            key = (tuple(f.header_path or [f.raw_label]), f.raw_label)
            groups.setdefault(key, []).append(f)

        out: list[NodeDraft] = []
        sub_cache: dict[tuple, NodeDraft] = {}
        sheet_prefix = table.locator.split("!")[0] if table.locator else ""
        sibling_names = [k[1] for k in groups]

        for (path, label), fields in groups.items():
            # 중간 경로 요소는 SUB_HEADER 체인으로 보존 (§6.2 SubHeader)
            parent = table
            prefix: tuple = ()
            for el in path[:-1]:
                prefix = (*prefix, el)
                if prefix not in sub_cache:
                    sp = f"{table.tree_path}/{'/'.join(prefix)}"
                    sub = NodeDraft(
                        node_id=stable_id(document_id, sp),
                        parent_node_id=parent.node_id, node_type="SUB_HEADER",
                        node_name=el, tree_path=sp)
                    sub_cache[prefix] = sub
                    out.append(sub)
                parent = sub_cache[prefix]

            fields_sorted = sorted(fields, key=lambda f: (_cell_row(f.address), f.address))
            rows = []
            for f in fields_sorted:
                num, text = _value_of(f)
                if num is None and text is None:
                    continue
                rows.append((f.row_key, num, text, f.address))
            units = Counter(f.raw_unit for f in fields if f.raw_unit)
            unit = units.most_common(1)[0][0] if units else None
            reprs: list = []
            for r in rows:
                v = r[1] if r[1] is not None else r[2]
                if v not in reprs:
                    reprs.append(v)
                if len(reprs) >= _REPR_LIMIT:
                    break
            hpath = f"{table.tree_path}/{'/'.join(path)}" if path else \
                f"{table.tree_path}/{label}"
            addrs = [f.address for f in fields_sorted]
            label_addr = next((f.label_address for f in fields_sorted if f.label_address), None)
            # locator는 값 구간 전체 — 역탐색/뷰어에서 이 범위를 하이라이트한다
            loc = f"{addrs[0]}:{addrs[-1]}" if addrs else (label_addr or "")
            node = NodeDraft(
                node_id=stable_id(document_id, hpath, label),
                parent_node_id=parent.node_id, node_type="HEADER",
                node_name=label, tree_path=hpath,
                locator=f"{sheet_prefix}!{loc}",
                data_type=_infer_dtype(rows), unit=unit,
                representative_values=reprs,
                metadata={
                    "header_path": list(path),
                    "adjacent_headers": [n for n in sibling_names if n != label][:8],
                    "value_range": f"{addrs[0]}:{addrs[-1]}" if addrs else None,
                    "style_roles": sorted({f.style_role for f in fields
                                           if f.style_role and f.style_role != "unknown"}),
                    "has_formula": any(f.is_formula for f in fields),
                },
                payload_rows=rows)
            out.append(node)
        return out


def load_workbook_tree(store: KgStore, repo_root: Path, path: Path,
                       parser_rules: dict, units, registry) -> tuple[str, list[NodeDraft], str]:
    """파일 하나를 파싱해 (document_id, drafts, file_hash)를 만든다. DB 미반영."""
    from src.common.hashing import sha256_file
    from src.inspect.inspector import WorkbookInspector
    from src.mapping.doc_dictionary import extract_document_dictionary
    from src.segment.detector import segment_workbook

    path = Path(path).resolve()
    root = Path(repo_root).resolve()
    rel = root if path.is_relative_to(root) else None
    inspector = WorkbookInspector()
    structure = inspector.inspect(path, relative_to=rel)
    doc_dict = extract_document_dictionary(structure, registry) if registry else None
    segs = segment_workbook(structure, parser_rules, units=units,
                            skip_sheets=doc_dict.sheet_names if doc_dict else None)
    # 논리 문서 ID는 경로 기반 — 다른 디렉터리의 동명 파일이 병합되지 않는다
    logical_path = structure.relative_path if rel is not None else str(path)
    document_id = stable_id(logical_path)
    drafts = KnowledgeTreeBuilder().build(document_id, structure, segs)
    return document_id, drafts, sha256_file(path)
