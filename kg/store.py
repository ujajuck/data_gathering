"""KG 시스템 저장 계층 — schema.sql 기반 SQLite 접근자.

설계서 §13의 4개 영역(Domain / Tree / Mapping / Integration)을 하나의
워크스페이스 DB(kg.db)에 담는다. Custom RDBMS 산출물은 별도 파일이다 (§9).
"""
from __future__ import annotations

import datetime
import hashlib
import json
import sqlite3
import uuid
from pathlib import Path

_SCHEMA = Path(__file__).parent / "schema.sql"


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def stable_id(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


class KgStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(_SCHEMA.read_text(encoding="utf-8"))
        self.conn.commit()

    # ------------------------------------------------------------- domain ----
    def upsert_concept(self, c: dict) -> None:
        self.conn.execute(
            """INSERT INTO domain_concept (concept_id, canonical_name, canonical_name_en,
                 description, concept_type, data_type, domain_level, canonical_unit,
                 unit_dimension, status)
               VALUES (:concept_id, :canonical_name, :canonical_name_en, :description,
                 :concept_type, :data_type, :domain_level, :canonical_unit,
                 :unit_dimension, :status)
               ON CONFLICT(concept_id) DO UPDATE SET
                 canonical_name=excluded.canonical_name,
                 canonical_name_en=excluded.canonical_name_en,
                 description=excluded.description,
                 concept_type=excluded.concept_type,
                 data_type=excluded.data_type,
                 domain_level=excluded.domain_level,
                 canonical_unit=excluded.canonical_unit,
                 unit_dimension=excluded.unit_dimension,
                 status=excluded.status""",
            {"canonical_name_en": None, "description": None, "concept_type": None,
             "data_type": None, "domain_level": None, "canonical_unit": None,
             "unit_dimension": None, "status": "ACTIVE", **c})

    def add_relation(self, src: str, dst: str, rel: str) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO domain_relation VALUES (?,?,?)", (src, dst, rel))

    def add_alias(self, concept_id: str, alias: str, norm: str) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO domain_alias VALUES (?,?,?)", (concept_id, alias, norm))

    def upsert_unit(self, symbol: str, dimension: str, factor: float, offset: float) -> None:
        self.conn.execute(
            """INSERT INTO unit VALUES (?,?,?,?)
               ON CONFLICT(symbol) DO UPDATE SET dimension=excluded.dimension,
                 factor=excluded.factor, offset=excluded.offset""",
            (symbol, dimension, factor, offset))

    def concept(self, concept_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM domain_concept WHERE concept_id=?", (concept_id,)).fetchone()

    def concepts(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM domain_concept WHERE status='ACTIVE' ORDER BY concept_id").fetchall()

    # --------------------------------------------------------------- tree ----
    def upsert_document(self, document_id: str, filename: str, filepath: str) -> None:
        self.conn.execute(
            """INSERT INTO document (document_id, filename, filepath)
               VALUES (?,?,?)
               ON CONFLICT(document_id) DO UPDATE SET filepath=excluded.filepath""",
            (document_id, filename, filepath))

    def latest_version(self, document_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            """SELECT * FROM document_version WHERE document_id=?
               ORDER BY parsed_at DESC, version_id DESC LIMIT 1""", (document_id,)).fetchone()

    def add_version(self, document_id: str, file_hash: str, parser_version: str) -> str:
        vid = new_id("VER")
        self.conn.execute(
            "INSERT INTO document_version VALUES (?,?,?,?,?)",
            (vid, document_id, file_hash, parser_version, now_iso()))
        self.conn.execute(
            "UPDATE document SET current_version=? WHERE document_id=?", (vid, document_id))
        return vid

    def active_nodes(self, document_id: str) -> dict[str, sqlite3.Row]:
        rows = self.conn.execute(
            "SELECT * FROM tree_node WHERE document_id=? AND status='ACTIVE'",
            (document_id,)).fetchall()
        return {r["node_id"]: r for r in rows}

    def node(self, node_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM tree_node WHERE node_id=?", (node_id,)).fetchone()

    # ------------------------------------------------------------ mapping ----
    def active_mapping(self, node_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            """SELECT * FROM semantic_mapping WHERE tree_node_id=? AND is_active=1
               ORDER BY created_at DESC LIMIT 1""", (node_id,)).fetchone()

    def deactivate_mapping(self, mapping_id: str, action: str = "DEACTIVATE",
                           note: str | None = None) -> None:
        self.conn.execute(
            "UPDATE semantic_mapping SET is_active=0, deactivated_at=? WHERE mapping_id=?",
            (now_iso(), mapping_id))
        self.conn.execute(
            "INSERT INTO review_history (mapping_id, action, reviewer, note, at) "
            "VALUES (?,?,?,?,?)", (mapping_id, action, "system", note, now_iso()))

    def save_mapping(self, node_id: str, concept_id: str | None, confidence: float,
                     method: str, status: str, context: dict, candidates: list,
                     reason: str) -> str:
        mid = new_id("MAP")
        self.conn.execute(
            """INSERT INTO semantic_mapping (mapping_id, tree_node_id, concept_id,
                 confidence, method, status, is_active, created_at)
               VALUES (?,?,?,?,?,?,1,?)""",
            (mid, node_id, concept_id, confidence, method, status, now_iso()))
        self.conn.execute(
            "INSERT INTO mapping_evidence VALUES (?,?,?,?)",
            (mid, json.dumps(context, ensure_ascii=False),
             json.dumps(candidates, ensure_ascii=False), reason))
        return mid

    def review(self, mapping_id: str, action: str, reviewer: str,
               note: str | None = None) -> None:
        status = {"APPROVE": "APPROVED", "REJECT": "REJECTED"}.get(action)
        if status:
            self.conn.execute(
                "UPDATE semantic_mapping SET status=? WHERE mapping_id=?",
                (status, mapping_id))
        self.conn.execute(
            "INSERT INTO review_history (mapping_id, action, reviewer, note, at) "
            "VALUES (?,?,?,?,?)", (mapping_id, action, reviewer, note, now_iso()))

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
