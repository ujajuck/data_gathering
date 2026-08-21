"""Pipeline orchestration — 설계문서 §13.1 pseudo-code의 구현.

process_file() 한 번이 하나의 ingest transaction이다:
안정화 → raw 버전 → semantic cache key 검사 → 구조 해석 → 분해 →
매핑 → review 분리 → canonical package → versioned DB 반영 → cache 저장.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from src.canonicalize.builder import PackageWriter, RecordBuilder
from src.common.hashing import semantic_cache_key
from src.dvc_adapter.repository import make_dvc
from src.inspect.inspector import PARSER_VERSION, WorkbookInspector
from src.loader.versioned_loader import VersionedLoader
from src.mapping.concepts import ConceptMapper, ConceptRegistry
from src.segment.detector import segment_workbook
from src.units.converter import UnitRegistry
from src.watch.watcher import wait_until_stable

import yaml


class Pipeline:
    def __init__(self, repo_root: Path, db_path: Path | None = None):
        self.repo_root = Path(repo_root)
        self.config_dir = self.repo_root / "config"
        self.registry = ConceptRegistry.load(self.config_dir / "concepts.yaml")
        self.units = UnitRegistry.load(self.config_dir / "units.yaml")
        rules_path = self.config_dir / "parser_rules.yaml"
        self.parser_rules = {}
        if rules_path.exists():
            with open(rules_path, encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            self.parser_rules = cfg.get("documents") or {}
        self.mapper = ConceptMapper(self.registry, self.units)
        self.inspector = WorkbookInspector()
        self.builder = RecordBuilder(self.registry, self.units, self.mapper)
        self.writer = PackageWriter()
        self.dvc = make_dvc(self.repo_root)
        self.loader = VersionedLoader(db_path or (self.repo_root / "data" / "canonical.db"))
        self.cache_dir = self.repo_root / "data" / "staging" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.quarantine_dir = self.repo_root / "data" / "quarantine"

    # ------------------------------------------------------------ helpers ----
    def _versions(self) -> dict:
        return {
            "parser_version": PARSER_VERSION,
            "concept_dictionary_version": self.registry.version,
            "unit_rule_version": self.units.version,
            "mapping_version": self.mapper.mapping_version,
        }

    def cache_key_for(self, source_hash: str) -> str:
        v = self._versions()
        return semantic_cache_key(source_hash, v["parser_version"],
                                  v["concept_dictionary_version"], v["unit_rule_version"])

    # ----------------------------------------------------------- pipeline ----
    def process_file(self, path: Path, trigger: str = "manual", force: bool = False) -> dict:
        path = Path(path)
        result = {"path": str(path), "status": "SKIPPED", "cache_hit": False}
        try:
            # 1) 저장 중인 파일을 읽지 않도록 안정화 확인
            wait_until_stable(path, interval=0.05, timeout=10.0)

            # 2) raw version 반영 (DVC 또는 sha256 fallback)
            raw_version = self.dvc.update_path(path)

            # 3) 동일 semantic cache key면 중복 처리 종료 (§5.4)
            cache_key = self.cache_key_for(raw_version.sha256)
            cache_file = self.cache_dir / f"{cache_key}.json"
            if cache_file.exists() and not force:
                result.update(status="SUCCESS", cache_hit=True,
                              detail="semantic cache hit — no reprocessing")
                return result

            # 4) 구조 해석 + region/block 분해
            structure = self.inspector.inspect(path, relative_to=self.repo_root)
            segmentations = segment_workbook(structure, self.parser_rules)

            # 5-6) concept 매핑 + review 분리 (§5.2: 낮은 신뢰도는 auto 확정 금지)
            records, decisions = self.builder.build_records(structure, segmentations)
            pending = [d for d in decisions if d.decision == "pending"]

            # 7) canonical package (재현 가능 산출물, §8.5)
            pkg_dir = self.repo_root / "data" / "canonical" / Path(structure.file_name).stem
            manifest = self.writer.write(pkg_dir, structure, records, decisions, self._versions())
            if pending:
                self._save_pending_review(structure.file_name, pending)

            # 8) versioned delta upsert (§9.1)
            doc_id = self.loader.ensure_document(structure.file_name, structure.relative_path)
            version_id = self.loader.new_document_version(
                doc_id,
                dvc_hash=raw_version.hash,
                sha256=structure.sha256,
                structure_hash=manifest["structure_hash"],
                semantic_hash=self._package_semantic_hash(manifest),
                parser_version=PARSER_VERSION,
                mapping_version=self.mapper.mapping_version,
            )
            stats = self.loader.apply_package(records, version_id, decisions,
                                              self.mapper.mapping_version)

            # 9) cache 저장 + remote push (best effort)
            cache_file.write_text(json.dumps({"manifest": manifest, "stats": stats},
                                             ensure_ascii=False), encoding="utf-8")
            try:
                self.dvc.push()
            except Exception as e:  # push 실패는 load 성공과 분리 기록 (§15)
                self.loader.log_job(trigger, str(path), version_id, "PUSH_FAILED", str(e))
            self.loader.log_job(trigger, str(path), version_id, "SUCCESS", json.dumps(stats))
            result.update(status="SUCCESS", stats=stats, version_id=version_id,
                          records=len(records), pending_mappings=len(pending))
            return result
        except Exception as e:
            self.loader.log_job(trigger, str(path), None, "FAILED", repr(e))
            self._quarantine(path, repr(e))
            result.update(status="FAILED", error=repr(e))
            return result

    @staticmethod
    def _package_semantic_hash(manifest: dict) -> str:
        import hashlib
        blob = json.dumps(manifest["record_semantic_hashes"], sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()

    def _save_pending_review(self, document: str, pending) -> None:
        out = self.quarantine_dir / "pending_review.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        from src.common.models import to_jsonable
        with open(out, "a", encoding="utf-8") as f:
            for d in pending:
                f.write(json.dumps({"document": document, **to_jsonable(d)}, ensure_ascii=False) + "\n")

    def _quarantine(self, path: Path, reason: str) -> None:
        try:
            self.quarantine_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, self.quarantine_dir / Path(path).name)
            (self.quarantine_dir / (Path(path).name + ".error.txt")).write_text(reason, encoding="utf-8")
        except Exception:
            pass

    def process_dir(self, raw_dir: Path, trigger: str = "batch") -> list[dict]:
        results = []
        for p in sorted(Path(raw_dir).glob("*.xlsx")):
            if p.name.startswith("~$"):
                continue
            results.append(self.process_file(p, trigger=trigger))
        return results
