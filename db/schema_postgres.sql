-- Canonical DB schema (PostgreSQL 운영용) — 설계문서 §6.3 DDL 기준
-- SQLite 스키마와 논리 동일; 타입만 PG 네이티브.

CREATE TABLE IF NOT EXISTS process (
    process_id UUID PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_document (
    document_id UUID PRIMARY KEY,
    process_id UUID NOT NULL REFERENCES process(process_id),
    logical_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    UNIQUE (process_id, relative_path)
);

CREATE TABLE IF NOT EXISTS document_version (
    document_version_id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES source_document(document_id),
    dvc_hash TEXT NOT NULL,
    git_rev TEXT,
    sha256 TEXT NOT NULL,
    structure_hash TEXT,
    semantic_hash TEXT,
    parser_version TEXT NOT NULL,
    mapping_version TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    supersedes_version_id UUID REFERENCES document_version(document_version_id),
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    is_tombstone BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS record (
    record_row_id UUID PRIMARY KEY,
    process_id UUID NOT NULL,
    record_key TEXT NOT NULL,
    record_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    event_time TIMESTAMPTZ,
    overall_status TEXT,
    note TEXT,
    source_sheet TEXT NOT NULL,
    source_block_bbox TEXT,
    block_fingerprint TEXT,
    semantic_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    source_document_version_id UUID NOT NULL REFERENCES document_version(document_version_id),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    is_tombstone BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_record_key ON record(record_key, is_current);

CREATE TABLE IF NOT EXISTS observation (
    observation_id UUID PRIMARY KEY,
    record_row_id UUID NOT NULL REFERENCES record(record_row_id),
    record_key TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    concept_id TEXT,
    raw_label TEXT,
    header_path JSONB,
    raw_value_text TEXT,
    raw_value_num DOUBLE PRECISION,
    normalized_value_text TEXT,
    normalized_value_num DOUBLE PRECISION,
    raw_unit TEXT,
    canonical_unit TEXT,
    value_role TEXT NOT NULL,
    status_code TEXT,
    source_sheet TEXT,
    source_address TEXT,
    row_key TEXT,
    mapping_confidence DOUBLE PRECISION,
    mapping_decision TEXT,
    source_document_version_id UUID NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    is_current BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_obs_key ON observation(record_key, observation_key, is_current);
CREATE INDEX IF NOT EXISTS idx_obs_concept ON observation(concept_id, is_current);

CREATE TABLE IF NOT EXISTS attachment (
    attachment_id UUID PRIMARY KEY,
    record_row_id UUID NOT NULL,
    record_key TEXT NOT NULL,
    image_hash TEXT NOT NULL,
    source_anchor TEXT,
    uri TEXT,
    source_document_version_id UUID NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    is_current BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS mapping_decision (
    mapping_id UUID PRIMARY KEY,
    field_signature TEXT NOT NULL,
    raw_label TEXT,
    context TEXT,
    concept_id TEXT,
    confidence DOUBLE PRECISION,
    reasons JSONB,
    decision TEXT NOT NULL,
    approved_by TEXT,
    mapping_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (field_signature, mapping_version)
);

CREATE TABLE IF NOT EXISTS ingestion_job (
    job_id UUID PRIMARY KEY,
    trigger_kind TEXT NOT NULL,
    source_path TEXT,
    source_version_id UUID,
    status TEXT NOT NULL,
    detail TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE OR REPLACE VIEW v_current_record AS
    SELECT * FROM record WHERE is_current AND NOT is_tombstone;

CREATE OR REPLACE VIEW v_current_observation AS
    SELECT * FROM observation WHERE is_current;
