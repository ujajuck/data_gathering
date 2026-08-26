"""Semantic Judge — Top-K 후보 중 개념 판별 (§7.1, §7.3).

LLM의 역할은 새 개념 생성이 아니라 '후보 중 판별'이다. 판정기는 교체 가능하다:

  RuleJudge : 결정론적 점수/격차 규칙 (오프라인 기본값 — 재현 가능)
  LLMJudge  : Claude API로 Tree Context + 후보를 판정 (ANTHROPIC_API_KEY 필요)

get_judge()는 환경에 따라 자동 선택한다. LLM 판정도 후보 밖의 concept_id를
반환하면 기각한다 (§1.2 비목표: 임의 개념 생성 금지).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from kg.mapping.retriever import Candidate, NodeContext

AUTO_CONFIDENCE = 0.85     # §7.4 자동 승인 임계
AMBIGUITY_GAP = 0.12       # 1·2위 격차가 이보다 작으면 REVIEW_REQUIRED


@dataclass
class JudgeDecision:
    concept_id: str | None
    confidence: float
    status: str               # AUTO_APPROVED / REVIEW_REQUIRED / UNMAPPED
    method: str
    reason: str


def _normalize(score: float) -> float:
    """검색 점수(alias 1.0 + 보정 ±)를 0~1 confidence로 사상."""
    return round(max(0.0, min(1.0, score / 1.15)), 4)


class RuleJudge:
    """결정론적 판정 — alias/lexical 점수와 후보 간 격차 규칙."""

    name = "rule"

    def judge(self, ctx: NodeContext, candidates: list[Candidate]) -> JudgeDecision:
        if not candidates:
            return JudgeDecision(None, 0.0, "UNMAPPED", "rule",
                                 "Domain KG에 적절한 후보 없음")
        top = candidates[0]
        conf = _normalize(top.score)
        gap = top.score - (candidates[1].score if len(candidates) > 1 else 0.0)
        if "unit_conflict" in top.signals:
            return JudgeDecision(top.concept_id, conf, "REVIEW_REQUIRED", "rule",
                                 f"단위 차원 충돌: {top.signals['unit_conflict']}")
        if conf >= AUTO_CONFIDENCE and gap >= AMBIGUITY_GAP:
            return JudgeDecision(top.concept_id, conf, "AUTO_APPROVED", "rule",
                                 f"후보 1위 {top.canonical_name} "
                                 f"(신호: {', '.join(top.signals)})")
        why = "후보 간 격차 부족" if gap < AMBIGUITY_GAP else "confidence 임계 미달"
        return JudgeDecision(top.concept_id, conf, "REVIEW_REQUIRED", "rule", why)


class LLMJudge:
    """Claude API 판정 — Tree Context와 후보를 주고 concept_id를 고르게 한다.

    후보 목록 밖의 답·API 오류는 RuleJudge 결과로 안전하게 폴백한다.
    """

    name = "llm"

    _PROMPT = """반정형 Excel 문서의 한 노드를 도메인 지식 그래프 개념에 연결하려 한다.

[노드 문맥]
{context}

[후보 개념]
{candidates}

후보 중 이 노드가 가리키는 개념 하나를 고르거나, 어느 것도 아니면 UNMAPPED로 답하라.
새로운 개념을 만들지 마라. JSON 하나만 출력하라:
{{"concept_id": "<후보 id 또는 UNMAPPED>", "confidence": 0.0~1.0, "reason": "근거 한 문장"}}"""

    def __init__(self, model: str | None = None):
        import anthropic
        self.client = anthropic.Anthropic()
        self.model = model or os.environ.get("KG_LLM_MODEL", "claude-opus-5")
        self.fallback = RuleJudge()

    def judge(self, ctx: NodeContext, candidates: list[Candidate]) -> JudgeDecision:
        if not candidates:
            return JudgeDecision(None, 0.0, "UNMAPPED", "llm", "후보 없음")
        cand_lines = "\n".join(
            f"- {c.concept_id}: {c.canonical_name} (검색점수 {c.score:.2f}, "
            f"신호 {list(c.signals)})" for c in candidates)
        try:
            resp = self.client.messages.create(
                model=self.model, max_tokens=1024,
                messages=[{"role": "user", "content": self._PROMPT.format(
                    context=json.dumps(ctx.as_dict(), ensure_ascii=False, indent=1),
                    candidates=cand_lines)}])
            if resp.stop_reason == "refusal":
                raise RuntimeError("model refused")
            text = "".join(b.text for b in resp.content if b.type == "text")
            m = re.search(r"\{.*\}", text, re.S)
            data = json.loads(m.group(0)) if m else {}
        except Exception as e:            # API 실패는 규칙 판정으로 폴백
            d = self.fallback.judge(ctx, candidates)
            d.method = "rule(llm_error)"
            d.reason = f"LLM 실패({type(e).__name__}) → 규칙 폴백: {d.reason}"
            return d

        cid = data.get("concept_id")
        try:
            conf = max(0.0, min(1.0, float(data.get("confidence") or 0.0)))
        except (TypeError, ValueError):
            conf = 0.0
        reason = str(data.get("reason") or "")
        valid_ids = {c.concept_id for c in candidates}
        if cid == "UNMAPPED" or cid not in valid_ids:
            if cid not in (None, "UNMAPPED"):
                reason = f"후보 밖 응답({cid}) 기각. {reason}"
            return JudgeDecision(None, conf, "UNMAPPED", "llm", reason or "LLM: 해당 없음")
        status = "AUTO_APPROVED" if conf >= AUTO_CONFIDENCE else "REVIEW_REQUIRED"
        return JudgeDecision(cid, round(conf, 4), status, "llm", reason)


def get_judge() -> RuleJudge | LLMJudge:
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return LLMJudge()
        except Exception:
            pass
    return RuleJudge()
