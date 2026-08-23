"""Concept Registry + candidate generation (설계문서 §5).

후보 생성 순서 (§5.2):
1. 정규명/승인 동의어 exact match
2. 문자 정규화 후 match
3. 문맥(문서명·시트명·header_path 상위·단위) 가중 fuzzy 후보
4. 단위 차원·값 타입 constraint filter
5. (LLM re-rank는 훅만 남기고 기본 비활성)
6. confidence 미달은 pending — canonical DB current에 확정 반영하지 않음
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from src.common.models import FieldInfo, MappingCandidate, MappingDecision
from src.units.converter import UnitRegistry

_NORM_DROP_RE = re.compile(r"[\s\(\)\[\]\{\}\.\-_/·:#]+")


def normalize_label(text: str) -> str:
    t = unicodedata.normalize("NFKC", str(text or "")).lower().strip()
    return _NORM_DROP_RE.sub("", t)


@dataclass
class Concept:
    concept_id: str
    canonical_name_ko: str
    canonical_name_en: str = ""
    domain: str | None = None          # 온톨로지 최상위 계층 (공정/품질/설비/…)
    parent_concept: str | None = None
    value_type: str = "string"
    canonical_unit: str | None = None
    unit_dimension: str | None = None
    allowed_roles: list[str] = field(default_factory=list)
    synonyms: list[str] = field(default_factory=list)
    context_keywords: list[str] = field(default_factory=list)
    is_business_key: bool = False
    is_event_time: bool = False

    def all_names(self) -> list[str]:
        return [self.canonical_name_ko, self.canonical_name_en, *self.synonyms]


class ConceptRegistry:
    def __init__(self, config: dict):
        self.version = str(config.get("version", "0"))
        self.domains: dict[str, dict] = config.get("domains") or {}
        self.concepts: dict[str, Concept] = {}
        for row in config.get("concepts") or []:
            c = Concept(**{k: v for k, v in row.items() if k in Concept.__dataclass_fields__})
            self.concepts[c.concept_id] = c
        self._exact: dict[str, str] = {}
        self._normalized: dict[str, str] = {}
        for c in self.concepts.values():
            for name in c.all_names():
                if not name:
                    continue
                self._exact.setdefault(str(name), c.concept_id)
                self._normalized.setdefault(normalize_label(name), c.concept_id)

    @classmethod
    def load(cls, path: Path) -> "ConceptRegistry":
        with open(path, encoding="utf-8") as f:
            return cls(yaml.safe_load(f) or {})

    def add_synonym(self, concept_id: str, text: str) -> None:
        """승인된 매핑을 동의어로 승격 (§5 Synonym Dictionary 갱신)."""
        c = self.concepts[concept_id]
        if text not in c.synonyms:
            c.synonyms.append(text)
        self._exact.setdefault(text, concept_id)
        self._normalized.setdefault(normalize_label(text), concept_id)


class ConceptMapper:
    """Scores candidates with a decomposed reason dict (§5.3)."""

    AUTO_THRESHOLD = 0.85

    def __init__(self, registry: ConceptRegistry, units: UnitRegistry,
                 mapping_version: str | None = None):
        self.registry = registry
        self.units = units
        self.mapping_version = mapping_version or f"c{registry.version}-u{units.version}"

    # ------------------------------------------------------------ scoring ----
    def candidates(self, f: FieldInfo, document_name: str, sheet_name: str) -> list[MappingCandidate]:
        label = f.raw_label
        norm = normalize_label(label)
        context_text = " ".join([document_name, sheet_name, *f.header_path[:-1]])
        out: list[MappingCandidate] = []

        for c in self.registry.concepts.values():
            reasons: dict = {}
            # 1) exact / approved synonym
            if label in c.all_names():
                reasons["exact"] = label
                base = 1.0
            elif norm and normalize_label(c.canonical_name_ko) == norm or any(
                normalize_label(n) == norm for n in c.all_names() if n
            ):
                reasons["normalized"] = norm
                base = 0.95
            else:
                # 3) fuzzy over all names
                best = 0.0
                best_name = None
                for n in c.all_names():
                    if not n:
                        continue
                    r = difflib.SequenceMatcher(None, norm, normalize_label(n)).ratio()
                    if r > best:
                        best, best_name = r, n
                if best < 0.55:
                    continue
                reasons["fuzzy"] = {"against": best_name, "ratio": round(best, 3)}
                base = best * 0.8

            # 4) constraint filter: 단위 차원
            if f.raw_unit and c.unit_dimension:
                if self.units.in_dimension(f.raw_unit, c.unit_dimension):
                    reasons["unit"] = f"{f.raw_unit} ~ {c.unit_dimension}"
                    base = min(1.0, base + 0.05)
                else:
                    reasons["unit_conflict"] = f"{f.raw_unit} !~ {c.unit_dimension}"
                    continue  # 불가능한 후보 제거 (§5.2-4)
            elif f.raw_unit is None and c.unit_dimension and c.unit_dimension != "time_of_day":
                # 단위 없는 필드 vs 단위 개념: 값이 숫자가 아니면 제외.
                # 단, '180 ℃'처럼 값에 단위가 내장된 표기는 분해해 판단한다.
                if f.raw_value is not None and not isinstance(f.raw_value, (int, float)) and not f.is_formula:
                    txt = str(f.raw_value)
                    embedded = self.units.parse_value(txt)
                    if embedded is not None:
                        if self.units.in_dimension(embedded[1], c.unit_dimension):
                            reasons["unit"] = f"embedded {embedded[1]} ~ {c.unit_dimension}"
                            base = min(1.0, base + 0.05)
                        else:
                            reasons["unit_conflict"] = f"embedded {embedded[1]} !~ {c.unit_dimension}"
                            continue
                    elif not re.match(r"^[\d\.\-+~≥≤<> ]+$", txt):
                        reasons["type_conflict"] = "non-numeric for unit concept"
                        continue

            # context keywords (동일 표기 다른 개념 구분: '종료' 시각 vs 종료온도)
            if c.context_keywords:
                hits = [k for k in c.context_keywords if k in context_text]
                if hits:
                    reasons["context"] = hits
                    base = min(1.0, base + 0.05)
                else:
                    base -= 0.25
                    reasons["context_miss"] = c.context_keywords

            # allowed_roles constraint
            if c.allowed_roles and f.style_role not in ("unknown", *c.allowed_roles):
                base -= 0.1
                reasons["role_mismatch"] = f.style_role

            if base > 0.3:
                out.append(MappingCandidate(concept_id=c.concept_id, confidence=round(base, 4), reasons=reasons))

        out.sort(key=lambda c: -c.confidence)
        return out

    # ----------------------------------------------------------- decision ----
    def field_signature(self, f: FieldInfo, document_name: str, sheet_name: str) -> str:
        return f"{document_name}|{sheet_name}|{'>'.join(f.header_path)}|{f.raw_unit or ''}"

    def decide(self, f: FieldInfo, document_name: str, sheet_name: str,
               doc_synonyms: dict[str, str] | None = None) -> MappingDecision:
        # 0) 문서 내장 사전(MASTER_코드표/Tag_Dictionary 등)이 제공한 용어 우선
        #    — 단, 단위 차원이 어긋나면 사전 매칭도 기각한다.
        if doc_synonyms:
            hit = doc_synonyms.get(normalize_label(f.raw_label))
            if hit:
                c = self.registry.concepts.get(hit)
                unit_ok = (
                    c is None or not c.unit_dimension or not f.raw_unit
                    or self.units.in_dimension(f.raw_unit, c.unit_dimension)
                )
                if c is not None and unit_ok:
                    return MappingDecision(
                        field_signature=self.field_signature(f, document_name, sheet_name),
                        raw_label=f.raw_label,
                        context=f"{document_name}/{sheet_name}/{'>'.join(f.header_path)}",
                        concept_id=hit,
                        confidence=0.97,
                        reasons={"top": {"document_dictionary": f.raw_label}, "runner_up": {}},
                        decision="auto",
                        mapping_version=self.mapping_version,
                    )
        decision = self._decide_label(f, document_name, sheet_name)
        # leaf가 모호하면 상위 헤더로 fallback (예: '반응온도 > PV (℃)'의 PV)
        if decision.decision == "pending" and len(f.header_path) > 1:
            for parent in reversed(f.header_path[:-1]):
                pf = FieldInfo(
                    field_id=f.field_id, address=f.address, label_address=f.label_address,
                    raw_label=parent, header_path=f.header_path[:-1],
                    raw_value=f.raw_value, cached_value=f.cached_value,
                    is_formula=f.is_formula, raw_unit=f.raw_unit, style_role=f.style_role,
                )
                pd = self._decide_label(pf, document_name, sheet_name)
                if pd.decision == "auto":
                    pd.field_signature = decision.field_signature
                    pd.raw_label = f.raw_label
                    pd.context = decision.context
                    pd.confidence = round(pd.confidence * 0.95, 4)
                    pd.reasons["top"]["via_parent"] = parent
                    if pd.confidence >= self.AUTO_THRESHOLD:
                        return pd
        return decision

    def _decide_label(self, f: FieldInfo, document_name: str, sheet_name: str) -> MappingDecision:
        cands = self.candidates(f, document_name, sheet_name)
        top = cands[0] if cands else None
        # 동률에 가까운 2위가 있으면 모호 → pending (§5.2-5/6)
        ambiguous = len(cands) > 1 and cands[1].confidence >= (top.confidence - 0.05 if top else 0)
        decision = "auto"
        if top is None or top.confidence < self.AUTO_THRESHOLD or ambiguous:
            decision = "pending"
        return MappingDecision(
            field_signature=self.field_signature(f, document_name, sheet_name),
            raw_label=f.raw_label,
            context=f"{document_name}/{sheet_name}/{'>'.join(f.header_path)}",
            concept_id=top.concept_id if top else None,
            confidence=top.confidence if top else 0.0,
            reasons={"top": top.reasons if top else {},
                     "runner_up": {cands[1].concept_id: cands[1].confidence} if len(cands) > 1 else {}},
            decision=decision,
            mapping_version=self.mapping_version,
        )
