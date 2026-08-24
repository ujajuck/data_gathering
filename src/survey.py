"""적재 전 어휘 조사(survey) 패스 — 온톨로지/사전을 먼저 성장시키는 선행 단계.

신규 문서 묶음을 DB에 적재하기 전에 dry-run으로 구조 해석 + 개념 매핑만 수행해서

1. 사전이 모르는 라벨 (후보 개념 없음 → 신규 개념 또는 동의어 추가 필요)
2. 모호한 라벨 (후보는 있으나 auto 확정 실패 → 동의어 승인 필요)
3. 미등록 단위 (units.yaml에 차원이 없어 정규화 불가)

를 발생 빈도·출처·표본 값·후보 개념과 함께 보고한다. 여기서 사전을 보강한 뒤
적재하면 '적재 → pending 확인 → 사전 수정 → 재적재' 사이클이 한 번으로 줄어든다
(§5 학습 루프의 선행 단계). DB/캐시/quarantine 등 어떤 상태도 변경하지 않는다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from src.canonicalize.builder import RecordBuilder
from src.inspect.inspector import WorkbookInspector
from src.mapping.concepts import ConceptMapper, ConceptRegistry, normalize_label
from src.mapping.doc_dictionary import extract_document_dictionary
from src.segment.detector import _FALLBACK_UNITS, RegionDetector, segment_workbook
from src.units.converter import UnitRegistry

_SAMPLE_LIMIT = 3          # 라벨당 보존할 표본 값 수
_VALUE_TRUNC = 40          # 표본 값 문자열 절단 길이


def _load_parser_rules(config_dir: Path) -> dict:
    rules_path = config_dir / "parser_rules.yaml"
    if not rules_path.exists():
        return {}
    with open(rules_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    return cfg.get("documents") or {}


def _clean(text) -> str:
    """리포트/주석에 끼워 넣는 자유 텍스트 정리 — 개행이 YAML 주석을 깨지 않게."""
    return re.sub(r"\s+", " ", str(text)).strip()[:_VALUE_TRUNC]


def _yaml_str(text: str) -> str:
    """YAML 이중따옴표 스칼라 (JSON 문자열은 유효한 YAML) — repr()는 YAML이 아니다."""
    return json.dumps(str(text), ensure_ascii=False)


class VocabularySurveyor:
    """설정(config/)만 읽는 독립 컴포넌트 — Pipeline과 달리 DB를 만들지 않는다."""

    def __init__(self, repo_root: Path):
        self.repo_root = Path(repo_root)
        config_dir = self.repo_root / "config"
        self.registry = ConceptRegistry.load(config_dir / "concepts.yaml")
        self.units = UnitRegistry.load(config_dir / "units.yaml")
        self.parser_rules = _load_parser_rules(config_dir)
        self.mapper = ConceptMapper(self.registry, self.units)
        self.builder = RecordBuilder(self.registry, self.units, self.mapper)
        self.inspector = WorkbookInspector()
        self._concept_names = {normalize_label(n)
                               for c in self.registry.concepts.values()
                               for n in c.all_names()}

    def _suspected_unit_token(self, token: str) -> bool:
        """라벨/헤더 경로에 남은 '단위처럼 생긴' 미등록 토큰 탐지.

        미등록 단위는 파서가 단위로 인정하지 못해 라벨로 흡수되고, 값이
        무단위로 (변환 없이) 적재되는 침묵 오염을 만든다 — 예: °F 미등록 시
        화씨 값이 그대로 ℃ 개념에 실린다. 적재 전에 잡아야 하는 1순위 격차."""
        t = (token or "").strip()
        if not t or len(t) > 14 or t[0].isdigit():
            return False                      # '1%' 같은 값+단위 합성은 제외
        if t.lower() in RegionDetector.PSEUDO_UNIT_TOKENS:
            return False                      # text/enum/timestamp 등 스키마 서술 토큰
        if self.units.dimensions_of(self.units.normalize_unit(t)):
            return False                      # 등록 단위 — 문제 없음
        if normalize_label(t) in self._concept_names:
            return False                      # 사전이 개념으로 아는 표기 (예: 't'=측정시점)
        if t in _FALLBACK_UNITS:
            return True                       # 파서 공용 단위 어휘에는 있으나 도메인 미등록
        return len(t) <= 3 and any(ch in t for ch in "°℃℉%‰₩€$Ω")

    # ------------------------------------------------------------ survey ----
    def survey(self, paths: list[Path]) -> dict:
        labels: dict[str, dict] = {}       # normalize_label → 집계
        units_unknown: dict[str, dict] = {}
        files: list[dict] = []
        errors: list[dict] = []
        total_obs = 0
        total_mapped = 0

        root = self.repo_root.resolve()
        uniq = sorted({Path(p).resolve() for p in paths})
        for path in uniq:
            if path.name.startswith("~$"):
                continue
            try:
                # 적재 전 파일은 워크스페이스 밖(incoming/ 등)에 있는 게 보통이다.
                # 판정과 inspect에 같은(resolve된) 경로를 써야 relative_to가 안전하다.
                rel = root if path.is_relative_to(root) else None
                structure = self.inspector.inspect(path, relative_to=rel)
                doc_dict = extract_document_dictionary(structure, self.registry)
                segs = segment_workbook(structure, self.parser_rules, units=self.units,
                                        skip_sheets=doc_dict.sheet_names)
                records, decisions = self.builder.build_records(
                    structure, segs, doc_synonyms=doc_dict.synonyms())
            except Exception as e:
                # 파일 하나가 깨져도 나머지 조사는 계속한다 (전수 조사가 목적)
                errors.append({"file": path.name, "error": repr(e)})
                continue

            # 결정(필드 시그니처 단위) → 라벨별 pending 후보 집계용 색인.
            # auto 문맥의 결정을 섞으면 신뢰도가 0.85+로 부풀어 오해를 낳는다.
            dec_by_label: dict[str, list] = {}
            for d in decisions:
                if d.decision == "pending" and d.concept_id:
                    dec_by_label.setdefault(normalize_label(d.raw_label), []).append(d)

            f_obs = 0
            f_mapped = 0
            for rec in records:
                for o in rec.observations:
                    f_obs += 1
                    auto_ok = bool(o.concept_id) and o.mapping_decision == "auto"
                    if o.concept_id:
                        f_mapped += 1
                    key = normalize_label(o.raw_label)
                    st = labels.setdefault(key, {
                        "label": o.raw_label, "observations": 0, "problem_observations": 0,
                        "documents": set(), "sheets": set(),
                        "sample_values": [], "units": set(),
                        "decisions": set(), "candidate": None, "confidence": 0.0,
                    })
                    st["observations"] += 1
                    if not auto_ok:
                        st["problem_observations"] += 1
                    st["documents"].add(structure.file_name)
                    st["sheets"].add(f"{structure.file_name}/{o.source_sheet}")
                    st["decisions"].add(o.mapping_decision if o.concept_id or
                                        o.mapping_decision == "pending" else "unmapped")
                    if o.raw_unit:
                        st["units"].add(o.raw_unit)
                        norm = self.units.normalize_unit(o.raw_unit)
                        if not self.units.dimensions_of(norm):
                            uu = units_unknown.setdefault(o.raw_unit, {
                                "unit": o.raw_unit, "observations": 0, "labels": set()})
                            uu["observations"] += 1
                            uu["labels"].add(_clean(o.raw_label))
                    # 미등록 단위가 라벨/경로로 흡수된 경우 (예: °F 미등록 →
                    # 화씨 값이 무단위로 적재되는 침묵 오염) — 적재 전에 보고
                    for tok in {o.raw_label, *o.header_path}:
                        if self._suspected_unit_token(tok):
                            uu = units_unknown.setdefault(tok, {
                                "unit": tok, "observations": 0, "labels": set()})
                            uu["observations"] += 1
                            uu["labels"].add(_clean(f"{o.source_sheet}: {o.raw_label}"))
                    v = o.raw_value_num if o.raw_value_num is not None else o.raw_value_text
                    if v is not None and len(st["sample_values"]) < _SAMPLE_LIMIT:
                        sv = _clean(v)
                        if sv and sv not in st["sample_values"]:
                            st["sample_values"].append(sv)
                    # 이 라벨의 최고 pending 후보 (auto 임계 미달이어도 개념은 실려 온다)
                    for d in dec_by_label.get(key, []):
                        if d.confidence > st["confidence"]:
                            st["candidate"] = d.concept_id
                            st["confidence"] = round(d.confidence, 4)

            total_obs += f_obs
            total_mapped += f_mapped
            files.append({
                "file": structure.file_name,
                "sheets": len(structure.sheets),
                "observations": f_obs,
                "mapped": f_mapped,
                "coverage_pct": round(100 * f_mapped / f_obs, 1) if f_obs else None,
            })

        return self._build_report(files, errors, labels, units_unknown,
                                  total_obs, total_mapped)

    # ------------------------------------------------------------ report ----
    def _build_report(self, files, errors, labels, units_unknown,
                      total_obs, total_mapped) -> dict:
        unknown: list[dict] = []
        ambiguous: list[dict] = []
        for st in labels.values():
            if st["decisions"] <= {"auto"}:
                continue                      # 전부 auto 매핑 — 보고 불필요
            row = {
                "label": st["label"],
                "observations": st["problem_observations"],   # pending/미매핑 관측치
                "observations_total": st["observations"],     # auto 문맥 포함 전체
                "documents": sorted(st["documents"]),
                "sheets": sorted(st["sheets"])[:8],
                "sample_values": st["sample_values"],
                "units": sorted(st["units"]),
                "candidate": st["candidate"],
                "confidence": st["confidence"],
                "statuses": sorted(st["decisions"]),
            }
            (ambiguous if st["candidate"] else unknown).append(row)
        unknown.sort(key=lambda r: -r["observations"])
        ambiguous.sort(key=lambda r: -r["observations"])

        unknown_units = sorted(
            ({**u, "labels": sorted(u["labels"])[:6]} for u in units_unknown.values()),
            key=lambda u: -u["observations"])

        report = {
            "dictionary": {
                "concept_version": self.registry.version,
                "unit_version": self.units.version,
                "concept_count": len(self.registry.concepts),
            },
            "files": files,
            "errors": errors,
            "totals": {
                "files": len(files),
                "failed_files": len(errors),
                "observations": total_obs,
                "auto_mapped": total_mapped,
                "expected_coverage_pct": round(100 * total_mapped / total_obs, 1)
                                         if total_obs else None,
                "unknown_labels": len(unknown),
                "ambiguous_labels": len(ambiguous),
                "unknown_units": len(unknown_units),
            },
            "unknown_labels": unknown,
            "ambiguous_labels": ambiguous,
            "unknown_units": unknown_units,
        }
        report["proposal_yaml"] = self._proposal_yaml(unknown, ambiguous, unknown_units)
        return report

    def _proposal_yaml(self, unknown, ambiguous, unknown_units) -> str:
        """검토용 사전 패치 초안 — 사람이 확인 후 concepts/units.yaml에 반영한다."""
        lines = ["# survey가 제안하는 사전 패치 초안 — 검토 후 반영하세요.",
                 "# (자동 적용되지 않습니다. 후보/신뢰도는 참고용입니다.)"]
        by_concept: dict[str, list] = {}
        for row in ambiguous:
            by_concept.setdefault(row["candidate"], []).append(row)
        if by_concept:
            lines.append("add_synonyms:")
            for cid, rows in sorted(by_concept.items()):
                lines.append(f"  {cid}:")
                for r in sorted(rows, key=lambda r: -r["confidence"]):
                    lines.append(f"  - {_yaml_str(r['label'])}"
                                 f"    # 신뢰도 {r['confidence']}, 관측 {r['observations']}건")
        if unknown:
            lines.append("new_concepts:  # 표준 개념이 없는 라벨 — 개념 정의 필요")
            for r in unknown:
                units = f", 단위 {'/'.join(_clean(u) for u in r['units'])}" \
                    if r["units"] else ""
                samples = ", ".join(r["sample_values"][:2])
                lines.append(f"- label: {_yaml_str(r['label'])}"
                             f"    # 관측 {r['observations']}건{units}, 예: {samples}")
        if unknown_units:
            lines.append("new_units:  # units.yaml dimensions/aliases에 등록 필요")
            for u in unknown_units:
                lines.append(f"- unit: {_yaml_str(u['unit'])}"
                             f"    # 관측 {u['observations']}건, "
                             f"라벨: {', '.join(u['labels'][:3])}")
        return "\n".join(lines)


def survey_paths(repo_root: Path, paths: list[Path]) -> dict:
    return VocabularySurveyor(repo_root).survey(paths)


def survey_dir(repo_root: Path, raw_dir: Path) -> dict:
    raw_dir = Path(raw_dir)
    if not raw_dir.is_dir():
        raise FileNotFoundError(f"survey 대상 디렉터리가 없습니다: {raw_dir}")
    paths = [p for p in sorted(raw_dir.glob("*.xlsx")) if not p.name.startswith("~$")]
    return survey_paths(repo_root, paths)
