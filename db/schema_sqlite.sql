-- Canonical DB schema (SQLite 개발/테스트용) — 설계문서 §6.2/§6.3
-- UPDATE 대신 '버전 종료 + INSERT' (SCD2, §9.1)

CREATE TABLE IF NOT EXISTS process (
    process_id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_document (
    document_id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES process(process_id),
    logical_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    UNIQUE (process_id, relative_path)
);

CREATE TABLE IF NOT EXISTS document_version (
    document_version_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES source_document(document_id),
    dvc_hash TEXT NOT NULL,
    git_rev TEXT,
    sha256 TEXT NOT NULL,
    structure_hash TEXT,
    semantic_hash TEXT,
    parser_version TEXT NOT NULL,
    mapping_version TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    supersedes_version_id TEXT REFERENCES document_version(document_version_id),
    is_current INTEGER NOT NULL DEFAULT 1,
    is_tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS record (
    record_row_id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    record_key TEXT NOT NULL,           -- 안정 업무 키 (record_type|business_key|event_time)
    record_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    event_time TEXT,
    overall_status TEXT,
    note TEXT,
    source_sheet TEXT NOT NULL,
    source_block_bbox TEXT,
    block_fingerprint TEXT,
    semantic_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    source_document_version_id TEXT NOT NULL REFERENCES document_version(document_version_id),
    valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    valid_to TEXT,
    is_current INTEGER NOT NULL DEFAULT 1,
    is_tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_record_key ON record(record_key, is_current);

CREATE TABLE IF NOT EXISTS observation (
    observation_id TEXT PRIMARY KEY,
    record_row_id TEXT NOT NULL REFERENCES record(record_row_id),
    record_key TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    concept_id TEXT,
    raw_label TEXT,
    header_path TEXT,                   -- JSON array (§4.3 header_path)
    raw_value_text TEXT,
    raw_value_num REAL,
    normalized_value_text TEXT,
    normalized_value_num REAL,
    raw_unit TEXT,
    canonical_unit TEXT,
    value_role TEXT NOT NULL,           -- input/measured/calculated/result
    status_code TEXT,
    source_sheet TEXT,
    source_address TEXT,
    row_key TEXT,
    mapping_confidence REAL,
    mapping_decision TEXT,
    source_document_version_id TEXT NOT NULL,
    valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    valid_to TEXT,
    is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_obs_key ON observation(record_key, observation_key, is_current);
CREATE INDEX IF NOT EXISTS idx_obs_concept ON observation(concept_id, is_current);

CREATE TABLE IF NOT EXISTS attachment (
    attachment_id TEXT PRIMARY KEY,
    record_row_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    image_hash TEXT NOT NULL,
    source_anchor TEXT,
    uri TEXT,
    source_document_version_id TEXT NOT NULL,
    valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    valid_to TEXT,
    is_current INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mapping_decision (
    mapping_id TEXT PRIMARY KEY,
    field_signature TEXT NOT NULL,
    raw_label TEXT,
    context TEXT,
    concept_id TEXT,
    confidence REAL,
    reasons TEXT,                       -- JSON (§5.3 분해된 근거)
    decision TEXT NOT NULL,
    approved_by TEXT,
    mapping_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    UNIQUE (field_signature, mapping_version)
);

CREATE TABLE IF NOT EXISTS ingestion_job (
    job_id TEXT PRIMARY KEY,
    trigger_kind TEXT NOT NULL,
    source_path TEXT,
    source_version_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    finished_at TEXT
);

CREATE VIEW IF NOT EXISTS v_current_record AS
    SELECT * FROM record WHERE is_current = 1 AND is_tombstone = 0;

CREATE VIEW IF NOT EXISTS v_current_observation AS
    SELECT * FROM observation WHERE is_current = 1;
