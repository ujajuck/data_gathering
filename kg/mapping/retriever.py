"""Domain Retriever — Tree Node Context → Top-K Domain Concept 후보 (§7.3, §14).

3단 검색을 합산한다:
  1) alias 정규화 완전 일치 (가장 강한 신호)
  2) lexical embedding: 문자 2-gram 벡터 코사인 (오탈자/부분 표기 대응, 외부 의존성 없음)
  3) rule 보정: 단위 차원 일치/충돌, 데이터 타입 일치/충돌, 인접 헤더 문맥

후보는 점수순 Top-K로 반환하고, 판정(auto/review)은 Judge가 맡는다 — 검색과
판정의 분리 (§7.1: LLM은 후보 중 판별자다).
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field as dc_field

from src.mapping.concepts import normalize_label

from kg.store import KgStore

_WORD_RE = re.compile(r"[0-9a-z가-힣%℃°]+")


def _ngrams(text: str, n: int = 2) -> Counter:
    t = normalize_label(text)
    t = "".join(_WORD_RE.findall(t))
    if not t:
        return Counter()
    if len(t) < n:
        return Counter({t: 1})
    return Counter(t[i:i + n] for i in range(len(t) - n + 1))


def _cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


@dataclass
class Candidate:
    concept_id: str
    canonical_name: str
    score: float
    signals: dict = dc_field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"concept_id": self.concept_id, "canonical_name": self.canonical_name,
                "score": round(self.score, 4), "signals": self.signals}


@dataclass
class NodeContext:
    """§7.2 입력 Context — Tree Node에서 조립한 매핑 판단 재료."""
    document: str
    sheet: str
    node_name: str
    tree_path: str
    parent_headers: list[str]
    adjacent_headers: list[str]
    unit: str | None
    data_type: str | None
    value_samples: list
    locator: str | None

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in
                ("document", "sheet", "node_name", "tree_path", "parent_headers",
                 "adjacent_headers", "unit", "data_type", "value_samples", "locator")}


def build_context(store: KgStore, node) -> NodeContext:
    meta = json.loads(node["metadata"] or "{}")
    doc = store.conn.execute(
        "SELECT filename FROM document WHERE document_id=?",
        (node["document_id"],)).fetchone()
    parts = (node["tree_path"] or "").split("/")
    sheet = parts[1] if len(parts) > 1 else ""
    reprs = json.loads(node["representative_values"] or "[]")
    return NodeContext(
        document=doc["filename"] if doc else node["document_id"],
        sheet=sheet,
        node_name=node["node_name"],
        tree_path=node["tree_path"],
        parent_headers=(meta.get("header_path") or [])[:-1],
        adjacent_headers=meta.get("adjacent_headers") or [],
        unit=node["unit"],
        data_type=node["data_type"],
        value_samples=reprs,
        locator=node["locator"])


class DomainRetriever:
    def __init__(self, store: KgStore, units=None, top_k: int = 5):
        self.store = store
        self.units = units          # UnitRegistry (단위 차원 판단용, optional)
        self.top_k = top_k
        self._aliases: dict[str, list[str]] = {}          # norm → concept_ids
        self._alias_vecs: list[tuple[str, str, Counter]] = []  # (concept, alias, vec)
        self._concepts: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        for row in self.store.conn.execute(
                "SELECT concept_id, alias_text, alias_norm FROM domain_alias"):
            self._aliases.setdefault(row["alias_norm"], [])
            if row["concept_id"] not in self._aliases[row["alias_norm"]]:
                self._aliases[row["alias_norm"]].append(row["concept_id"])
            self._alias_vecs.append(
                (row["concept_id"], row["alias_text"], _ngrams(row["alias_text"])))
        for row in self.store.concepts():
            self._concepts[row["concept_id"]] = dict(row)

    # ---------------------------------------------------------------------
    def retrieve(self, ctx: NodeContext) -> list[Candidate]:
        scores: dict[str, Candidate] = {}

        def bump(cid: str, delta: float, signal: str, detail) -> None:
            c = self._concepts.get(cid)
            if c is None or c.get("status") != "ACTIVE":
                return
            cand = scores.setdefault(
                cid, Candidate(cid, c["canonical_name"], 0.0, {}))
            cand.score += delta
            cand.signals[signal] = detail

        # 1) alias 완전 일치
        norm = normalize_label(ctx.node_name)
        for cid in self._aliases.get(norm, []):
            bump(cid, 1.0, "alias_exact", ctx.node_name)
        # 상위 헤더로도 검색 (leaf가 무의미한 경우: 'PV', '실측' 등)
        for ph in reversed(ctx.parent_headers):
            for cid in self._aliases.get(normalize_label(ph), []):
                bump(cid, 0.55, "alias_parent", ph)

        # 2) lexical embedding (문자 2-gram 코사인) — 상위만 반영
        qv = _ngrams(ctx.node_name)
        best_lex: dict[str, tuple[float, str]] = {}
        for cid, alias, vec in self._alias_vecs:
            sim = _cosine(qv, vec)
            if sim >= 0.45 and sim > best_lex.get(cid, (0.0, ""))[0]:
                best_lex[cid] = (sim, alias)
        for cid, (sim, alias) in best_lex.items():
            bump(cid, 0.65 * sim, "lexical", {"alias": alias, "cos": round(sim, 3)})

        # 3) rule 보정: 단위 차원 / 데이터 타입
        for cand in scores.values():
            c = self._concepts[cand.concept_id]
            cdim = c.get("unit_dimension")
            if ctx.unit and cdim and self.units is not None:
                if cdim in self.units.dimensions_of(ctx.unit):
                    cand.score += 0.15
                    cand.signals["unit_match"] = ctx.unit
                else:
                    cand.score -= 0.45
                    cand.signals["unit_conflict"] = {"node": ctx.unit, "concept": cdim}
            cdt = c.get("data_type")
            if cdt and ctx.data_type and ctx.data_type != "empty":
                if (cdt == "numeric") == (ctx.data_type == "numeric") or \
                        ctx.data_type == "mixed":
                    cand.score += 0.05
                else:
                    cand.score -= 0.3
                    cand.signals["type_conflict"] = {"node": ctx.data_type, "concept": cdt}

        out = sorted(scores.values(), key=lambda c: -c.score)
        return [c for c in out if c.score > 0.2][: self.top_k]
