-- PostgreSQL translation of db/dvc/schema_sqlite.sql.
-- Git/DVC owns file history; PostgreSQL owns stable identity, semantic relations,
-- current mappings, and extraction execution/result data.

CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY CHECK (version = 3),
    profile TEXT NOT NULL CHECK (profile = 'dvc_minimal'),
    description TEXT NOT NULL
);
INSERT INTO schema_meta VALUES (
    3,
    'dvc_minimal',
    'DVC owns file versions; DB owns identity, relationships, mappings and extracted values'
);

CREATE TABLE document (
    document_id TEXT PRIMARY KEY NOT NULL,
    document_name TEXT NOT NULL,
    author TEXT,
    authored_at TEXT,
    source_path TEXT NOT NULL,
    file_type TEXT NOT NULL DEFAULT 'xlsx',
    dvc_rev TEXT,
    content_sha256 TEXT,
    registered_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX document_name_idx ON document(document_name, document_id);
CREATE INDEX document_path_idx ON document(source_path, document_id);

CREATE TABLE sheet (
    sheet_id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
    sheet_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    native_sheet_key TEXT,
    UNIQUE (document_id, ordinal),
    UNIQUE (document_id, sheet_name)
);
CREATE INDEX sheet_document_idx ON sheet(document_id, ordinal);

CREATE TABLE source_region (
    region_id TEXT PRIMARY KEY NOT NULL,
    sheet_id TEXT NOT NULL REFERENCES sheet(sheet_id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'cells' CHECK (kind IN ('cells','image','chart','shape','text')),
    locator_key TEXT NOT NULL,
    r1 INTEGER CHECK (r1 IS NULL OR r1 >= 1),
    c1 INTEGER CHECK (c1 IS NULL OR c1 >= 1),
    r2 INTEGER CHECK (r2 IS NULL OR r2 >= r1),
    c2 INTEGER CHECK (c2 IS NULL OR c2 >= c1),
    geometry_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (sheet_id, locator_key)
);
CREATE INDEX source_region_sheet_idx ON source_region(sheet_id, r1, c1, r2, c2);

CREATE TABLE domain_concept (
    domain_id TEXT PRIMARY KEY NOT NULL,
    domain_name TEXT NOT NULL,
    definition TEXT,
    domain_level INTEGER NOT NULL CHECK (domain_level > 0),
    value_type TEXT,
    canonical_unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX domain_name_idx ON domain_concept(domain_name, domain_id);

CREATE TABLE domain_alias (
    domain_id TEXT NOT NULL REFERENCES domain_concept(domain_id) ON DELETE CASCADE,
    alias_norm TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (domain_id, alias_norm, context_key)
);
CREATE INDEX domain_alias_lookup_idx ON domain_alias(alias_norm, context_key, domain_id);

CREATE TABLE domain_edge (
    edge_id TEXT PRIMARY KEY NOT NULL,
    domain_from TEXT NOT NULL REFERENCES domain_concept(domain_id),
    domain_to TEXT NOT NULL REFERENCES domain_concept(domain_id),
    relation TEXT NOT NULL,
    CHECK (domain_from <> domain_to),
    UNIQUE (domain_from, domain_to, relation)
);
CREATE INDEX domain_edge_from_idx ON domain_edge(domain_from, relation, domain_to);
CREATE INDEX domain_edge_to_idx ON domain_edge(domain_to, relation, domain_from);

CREATE TABLE template (
    template_id TEXT PRIMARY KEY NOT NULL,
    template_name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dvc_rev TEXT,
    definition_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX template_name_idx ON template(template_name, template_id);

CREATE TABLE template_rule (
    rule_id TEXT PRIMARY KEY NOT NULL,
    template_id TEXT NOT NULL REFERENCES template(template_id) ON DELETE CASCADE,
    rule_key TEXT NOT NULL,
    default_domain_id TEXT REFERENCES domain_concept(domain_id),
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    selector_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    value_spec_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (template_id, rule_key),
    UNIQUE (template_id, ordinal)
);
CREATE INDEX template_rule_domain_idx ON template_rule(default_domain_id, template_id);

CREATE TABLE template_application (
    application_id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES template(template_id),
    scope_key TEXT NOT NULL DEFAULT 'default',
    document_dvc_rev TEXT,
    template_dvc_rev TEXT,
    kg_dvc_rev TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (document_id, template_id, scope_key)
);
CREATE INDEX application_document_idx ON template_application(document_id, application_id);

CREATE TABLE mapping (
    mapping_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES template_application(application_id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL REFERENCES template_rule(rule_id),
    sheet_id TEXT NOT NULL REFERENCES sheet(sheet_id),
    domain_id TEXT NOT NULL REFERENCES domain_concept(domain_id),
    instance_key TEXT NOT NULL DEFAULT 'default',
    observed_key TEXT,
    key_region_id TEXT REFERENCES source_region(region_id),
    value_region_id TEXT REFERENCES source_region(region_id),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (application_id, rule_id, sheet_id, instance_key)
);
CREATE INDEX mapping_domain_idx ON mapping(domain_id, status, mapping_id);
CREATE INDEX mapping_sheet_idx ON mapping(sheet_id, application_id, mapping_id);

CREATE TABLE extraction_run (
    run_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES template_application(application_id) ON DELETE CASCADE,
    document_dvc_rev TEXT,
    template_dvc_rev TEXT,
    kg_dvc_rev TEXT,
    engine_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    error_summary TEXT
);
CREATE INDEX extraction_run_application_idx ON extraction_run(application_id, started_at, run_id);

CREATE TABLE extracted_value (
    value_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES extraction_run(run_id) ON DELETE CASCADE,
    mapping_id TEXT NOT NULL REFERENCES mapping(mapping_id),
    value_index INTEGER NOT NULL DEFAULT 0 CHECK (value_index >= 0),
    record_key TEXT,
    raw_text TEXT,
    value_text TEXT,
    value_type TEXT NOT NULL DEFAULT 'text' CHECK (value_type IN ('decimal','text','boolean','date','datetime','asset','null')),
    unit_raw TEXT,
    unit_normalized TEXT,
    source_region_id TEXT REFERENCES source_region(region_id),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (run_id, mapping_id, value_index)
);
CREATE INDEX extracted_value_mapping_idx ON extracted_value(mapping_id, run_id, value_index);
CREATE INDEX extracted_value_run_idx ON extracted_value(run_id, value_index, value_id);

CREATE VIEW approved_mapping AS
SELECT * FROM mapping WHERE status = 'approved';

CREATE VIEW successful_extracted_value AS
SELECT v.*
FROM extracted_value v
JOIN extraction_run r ON r.run_id = v.run_id
WHERE r.status = 'succeeded';
