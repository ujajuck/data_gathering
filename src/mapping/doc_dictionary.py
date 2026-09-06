"""문서 내장 사전(용어/코드표 시트) 자동 인식·흡수.

실데이터 workbook에는 MASTER_코드표, Tag_Dictionary, 현장코드, 계산근거처럼
'용어 → 표준 개념/단위/변환'을 스스로 설명하는 시트가 함께 들어 있다.
이 시트들은 업무 레코드가 아니라 **매핑 지식**이므로:
  1) 레코드 생성에서 제외하고
  2) 행별 용어들을 registry 개념으로 해소해 doc-scoped 동의어로 쓴다.
승인 시 config/concepts.yaml의 전역 synonym으로 승격하는 것이 설계문서 §5의
Synonym Dictionary 학습 루프에 해당한다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from src.common.models import SheetStructure, WorkbookStructure
from src.mapping.concepts import ConceptRegistry, normalize_label

# 사전 시트 판별: 헤더 행 키워드
_TERM_HEADER_RE = re.compile(
    r"용어|개념|concept|tag|column|동의어|표현|alias|symbol|label", re.I)
_MEANING_HEADER_RE = re.compile(r"의미|meaning", re.I)
_UNIT_HEADER_RE = re.compile(r"단위|unit", re.I)
_SKIP_HEADER_RE = re.compile(
    r"비고|note|하한|상한|data\s*type|공정영역|conversion|example|주의", re.I)
_SHEET_NAME_RE = re.compile(r"코드|사전|dictionary|근거|master|code", re.I)

# 동의어 나열 구분자: "Temp / T-Reactor / 반응온도(℃)"
_SPLIT_RE = re.compile(r"\s*/\s*")


@dataclass
class DictionaryEntry:
    terms: list[str]
    unit: str | None = None
    concept_id: str | None = None


@dataclass
class DocumentDictionary:
    sheet_names: set[str] = field(default_factory=set)
    entries: list[DictionaryEntry] = field(default_factory=list)

    def synonyms(self) -> dict[str, str]:
        """normalized term -> concept_id (해소된 항목만)."""
        out: dict[str, str] = {}
        for e in self.entries:
            if not e.concept_id:
                continue
            for t in e.terms:
                key = normalize_label(t)
                if key:
                    out.setdefault(key, e.concept_id)
        return out


def _header_row(sheet: SheetStructure) -> tuple[int, dict[int, str]] | None:
    """첫 번째 '텍스트가 2개 이상인 행'을 헤더 후보로 본다."""
    by_row: dict[int, dict[int, str]] = {}
    for c in sheet.cells:
        if isinstance(c.value, str) and c.value.strip():
            by_row.setdefault(c.row, {})[c.col] = c.value.strip()
    for row in sorted(by_row):
        if len(by_row[row]) >= 2:
            return row, by_row[row]
    return None


def is_dictionary_sheet(sheet: SheetStructure) -> bool:
    hdr = _header_row(sheet)
    if hdr is None:
        return False
    _, cells = hdr
    texts = list(cells.values())
    term_cols = sum(1 for t in texts if _TERM_HEADER_RE.search(t))
    unit_cols = sum(1 for t in texts if _UNIT_HEADER_RE.search(t))
    meaning_cols = sum(1 for t in texts if _MEANING_HEADER_RE.search(t))
    score = term_cols + unit_cols + meaning_cols
    if _SHEET_NAME_RE.search(sheet.sheet_name):
        score += 1
    # 용어 열이 있고 단위/의미 열이 동반되면 사전으로 판단
    return term_cols >= 1 and score >= 3


def extract_document_dictionary(structure: WorkbookStructure,
                                registry: ConceptRegistry) -> DocumentDictionary:
    doc_dict = DocumentDictionary()
    for sheet in structure.sheets:
        if not is_dictionary_sheet(sheet):
            continue
        doc_dict.sheet_names.add(sheet.sheet_name)
        hdr = _header_row(sheet)
        if hdr is None:
            continue
        hdr_row, hdr_cells = hdr
        term_cols = [c for c, t in hdr_cells.items()
                     if _TERM_HEADER_RE.search(t) or _MEANING_HEADER_RE.search(t)]
        unit_cols = [c for c, t in hdr_cells.items() if _UNIT_HEADER_RE.search(t)]
        skip_cols = {c for c, t in hdr_cells.items() if _SKIP_HEADER_RE.search(t)}

        rows: dict[int, dict[int, object]] = {}
        for c in sheet.cells:
            if c.row > hdr_row and c.value is not None:
                rows.setdefault(c.row, {})[c.col] = c.value

        for row in sorted(rows):
            cells = rows[row]
            terms: list[str] = []
            for col in term_cols:
                v = cells.get(col)
                if isinstance(v, str) and v.strip() and v.strip() not in ("-",):
                    terms.extend(t for t in _SPLIT_RE.split(v.strip()) if t and t != "-")
            if not terms:
                continue
            unit = None
            for col in unit_cols:
                v = cells.get(col)
                if isinstance(v, str) and v.strip() not in ("", "-"):
                    unit = v.strip()
                    break
            concept_id = _resolve_concept(terms, registry)
            doc_dict.entries.append(DictionaryEntry(terms=terms, unit=unit, concept_id=concept_id))
    return doc_dict


def _resolve_concept(terms: list[str], registry: ConceptRegistry) -> str | None:
    """용어들 중 하나라도 registry 정규명/동의어와 일치하면 그 concept으로 해소."""
    for t in terms:
        cid = registry._exact.get(t)
        if cid:
            return cid
    for t in terms:
        cid = registry._normalized.get(normalize_label(t))
        if cid:
            return cid
    # 괄호 단위 제거 후 재시도: "반응온도(℃)" → "반응온도"
    for t in terms:
        base = re.sub(r"\s*\([^)]*\)\s*$", "", t).strip()
        if base and base != t:
            cid = registry._exact.get(base) or registry._normalized.get(normalize_label(base))
            if cid:
                return cid
    return None
