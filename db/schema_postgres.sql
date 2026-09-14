-- data_gathering 코어 스키마의 PostgreSQL 번역본(계약 §1.8). schema_sqlite.sql과 테이블·컬럼·트리거·뷰 이름이 1:1이다.
-- 변환 규칙: 애플리케이션 발급 uuid4 TEXT id → UUID, ISO TEXT 시각 → TIMESTAMPTZ, 0/1 → BOOLEAN,
--   json_valid() TEXT → JSONB, byte_size → BIGINT, IS NOT → IS DISTINCT FROM, RAISE(ABORT) → RAISE EXCEPTION.
--   제공자가 보고한 naive 시각(document_snapshot.authored_at)은 시간대를 추정하지 않기 위해 TEXT를 유지한다.
--   논리 키(schema_key/field_key/rule_key/role_key/scope_key)와 해시·토큰·서명 문자열은 TEXT를 유지한다.
-- 순환 FK(document.current_snapshot_id, parsing_profile.reference_application_id, parsing_application.published_run_id,
--   mapping.current_revision_id)는 두 테이블 생성 뒤 ALTER TABLE ... DEFERRABLE INITIALLY DEFERRED로 건다.
-- 포함하지 않는 것: schema/db.py가 런타임에 만드는 SQLite 전용 runtime_job·snapshot_signature.
-- 검증 범위: pglast 구문 검증(tests/test_schema_postgres.py)만 수행했다. 실제 PostgreSQL 서버에서 실행 검증하지 않았다.
-- JSONB는 키 순서/공백을 정규화하므로 definition_sha256 등은 항상 애플리케이션의 dump() 결과로 계산한다.

CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY CHECK (version = 3),
    description TEXT NOT NULL
);
INSERT INTO schema_meta VALUES (3, 'Parsing Schema / Parsing Profile runtime; schema revision 3; PostgreSQL translation of schema_sqlite.sql');

-- §1.1 문서. current_snapshot_id FK는 document_snapshot 생성 뒤 ALTER TABLE로 붙인다(상호 참조).
CREATE TABLE document (
    document_id UUID PRIMARY KEY NOT NULL,
    document_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    current_snapshot_id UUID,
    status TEXT NOT NULL DEFAULT 'not_extracted'
        CHECK (status IN ('not_extracted','locked','unmatched','review','changed','failed','normal')),
    status_detail_json JSONB,
    last_processed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, source_path)
);
CREATE INDEX document_by_status_name ON document(status, document_name);
CREATE INDEX document_by_status_updated ON document(status, updated_at DESC);
CREATE INDEX document_current_snapshot ON document(current_snapshot_id);
CREATE INDEX document_by_processed ON document((coalesce(last_processed_at, to_timestamp(0))) DESC, document_id DESC);
CREATE INDEX document_by_name ON document(document_name, document_id);
CREATE INDEX document_by_status ON document(status, document_id);

CREATE TABLE document_snapshot (
    snapshot_id UUID PRIMARY KEY NOT NULL,
    document_id UUID NOT NULL REFERENCES document,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    change_token TEXT NOT NULL,
    content_sha256 TEXT,
    ciphertext_sha256 TEXT,
    provider_version TEXT,
    dvc_rev TEXT,
    author TEXT,
    authored_at TEXT,
    filename TEXT NOT NULL,
    byte_size BIGINT,
    excel_date_system TEXT,
    captured_at TIMESTAMPTZ NOT NULL,
    CHECK (content_sha256 IS NOT NULL OR provider_version IS NOT NULL OR ciphertext_sha256 IS NOT NULL),
    UNIQUE (document_id, revision_no),
    UNIQUE (document_id, snapshot_id)
);
ALTER TABLE document ADD CONSTRAINT document_current_snapshot_fk
    FOREIGN KEY (document_id, current_snapshot_id)
    REFERENCES document_snapshot(document_id, snapshot_id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX snapshot_by_document_revision ON document_snapshot(document_id, revision_no DESC);
CREATE INDEX snapshot_by_document_token ON document_snapshot(document_id, change_token);

CREATE TABLE sheet (
    sheet_id UUID PRIMARY KEY NOT NULL,
    snapshot_id UUID NOT NULL REFERENCES document_snapshot,
    sheet_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    native_sheet_key TEXT,
    visibility TEXT NOT NULL DEFAULT 'visible',
    estimated_rows INTEGER,
    estimated_cols INTEGER,
    UNIQUE (snapshot_id, ordinal),
    UNIQUE (snapshot_id, sheet_name),
    UNIQUE (sheet_id, snapshot_id)
);

CREATE TABLE source_region (
    region_id UUID PRIMARY KEY NOT NULL,
    snapshot_id UUID NOT NULL,
    sheet_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cells','image','chart','shape','text')),
    locator_key TEXT NOT NULL,
    r1 INTEGER,
    c1 INTEGER,
    r2 INTEGER,
    c2 INTEGER,
    geometry_json JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id),
    UNIQUE (sheet_id, kind, locator_key),
    UNIQUE (region_id, snapshot_id)
);
CREATE INDEX region_by_sheet_position ON source_region(sheet_id, r1, c1);

-- §1.2 Parsing Schema(projection).
CREATE TABLE parsing_schema (
    schema_id UUID PRIMARY KEY NOT NULL,
    schema_key TEXT NOT NULL UNIQUE,
    schema_name TEXT NOT NULL UNIQUE,
    description TEXT,
    definition_path TEXT,
    current_rev INTEGER NOT NULL DEFAULT 0,
    definition_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE parsing_field (
    field_id UUID PRIMARY KEY NOT NULL,
    schema_id UUID NOT NULL REFERENCES parsing_schema,
    field_key TEXT NOT NULL,
    field_name TEXT NOT NULL,
    description TEXT,
    field_level INTEGER CHECK (field_level IS NULL OR field_level > 0),
    value_type TEXT NOT NULL CHECK (value_type IN ('text','decimal','boolean','date','datetime','group')),
    canonical_unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (schema_id, field_key)
);
CREATE INDEX field_by_schema_status ON parsing_field(schema_id, status, ordinal);

CREATE TABLE parsing_alias (
    alias_id UUID PRIMARY KEY NOT NULL,
    field_id UUID NOT NULL REFERENCES parsing_field,
    alias_text TEXT NOT NULL,
    alias_norm TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    UNIQUE (field_id, alias_norm, context_key)
);
CREATE INDEX alias_by_norm ON parsing_alias(alias_norm);

CREATE TABLE parsing_field_edge (
    edge_id UUID PRIMARY KEY NOT NULL,
    schema_id UUID NOT NULL REFERENCES parsing_schema,
    from_field_id UUID NOT NULL REFERENCES parsing_field,
    to_field_id UUID NOT NULL REFERENCES parsing_field,
    relation TEXT NOT NULL CHECK (relation IN ('parent_of','related_to')),
    ordinal INTEGER,
    UNIQUE (schema_id, from_field_id, to_field_id, relation),
    CHECK (from_field_id <> to_field_id)
);
CREATE INDEX edge_by_from ON parsing_field_edge(from_field_id);
CREATE INDEX edge_by_to ON parsing_field_edge(to_field_id);

-- §1.3 Parsing Profile. reference_application_id FK는 parsing_application 생성 뒤 ALTER TABLE로 붙인다(상호 참조).
CREATE TABLE parsing_profile (
    profile_id UUID PRIMARY KEY NOT NULL,
    profile_name TEXT NOT NULL UNIQUE,
    description TEXT,
    schema_id UUID NOT NULL REFERENCES parsing_schema,
    definition_path TEXT,
    current_rev INTEGER NOT NULL DEFAULT 0,
    definition_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','deprecated')),
    reference_application_id UUID,
    reference_profile_rev INTEGER,
    reference_signature TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX profile_by_schema ON parsing_profile(schema_id);
CREATE INDEX profile_by_reference ON parsing_profile(reference_application_id);

CREATE TABLE parsing_rule (
    rule_id UUID PRIMARY KEY NOT NULL,
    profile_id UUID NOT NULL REFERENCES parsing_profile,
    rule_key TEXT NOT NULL,
    rule_name TEXT,
    default_field_id UUID REFERENCES parsing_field,
    ordinal INTEGER NOT NULL,
    selector_json JSONB NOT NULL,
    value_spec_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (profile_id, rule_key)
);
CREATE INDEX rule_by_field ON parsing_rule(default_field_id);

-- §1.4 Application / Mapping. published_run_id FK는 extraction_run 생성 뒤 ALTER TABLE로 붙인다(상호 참조).
CREATE TABLE parsing_application (
    application_id UUID PRIMARY KEY NOT NULL,
    snapshot_id UUID NOT NULL REFERENCES document_snapshot,
    profile_id UUID NOT NULL REFERENCES parsing_profile,
    schema_id UUID NOT NULL REFERENCES parsing_schema,
    scope_key TEXT NOT NULL DEFAULT 'default',
    profile_rev INTEGER NOT NULL,
    schema_rev INTEGER NOT NULL,
    published_run_id UUID,
    origin TEXT NOT NULL CHECK (origin IN ('auto','manual','inherited')),
    match_signature TEXT NOT NULL,
    match_signature_json JSONB,
    compatibility TEXT NOT NULL CHECK (compatibility IN ('identical','compatible','manual')),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (snapshot_id, profile_id, scope_key),
    UNIQUE (application_id, snapshot_id)
);
ALTER TABLE parsing_profile ADD CONSTRAINT profile_reference_application_fk
    FOREIGN KEY (reference_application_id) REFERENCES parsing_application(application_id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX application_by_snapshot_profile ON parsing_application(snapshot_id, profile_id);
CREATE INDEX application_by_profile ON parsing_application(profile_id);
CREATE INDEX application_by_schema ON parsing_application(schema_id);
CREATE INDEX application_by_published_run ON parsing_application(published_run_id);

CREATE TABLE application_sheet (
    application_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    role_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sheet_id UUID NOT NULL,
    PRIMARY KEY (application_id, role_key, ordinal),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id),
    FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id)
);
CREATE INDEX application_sheet_by_sheet ON application_sheet(sheet_id);

-- 헤드(current_revision_id)는 항상 마지막 리비전이며 edit_seq = 헤드의 revision_no. FK는 mapping_revision 생성 뒤 ALTER TABLE로 붙인다.
CREATE TABLE mapping (
    mapping_id UUID PRIMARY KEY NOT NULL,
    application_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    rule_id UUID NOT NULL REFERENCES parsing_rule,
    current_revision_id UUID,
    edit_seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (application_id, rule_id),
    UNIQUE (mapping_id, snapshot_id),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id)
);
CREATE INDEX mapping_by_rule ON mapping(rule_id);
CREATE INDEX mapping_by_head ON mapping(current_revision_id);

CREATE TABLE mapping_revision (
    mapping_revision_id UUID PRIMARY KEY NOT NULL,
    mapping_id UUID NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    snapshot_id UUID NOT NULL,
    field_id UUID REFERENCES parsing_field,
    observed_key TEXT,
    effective_spec_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
    origin TEXT NOT NULL CHECK (origin IN ('profile','inherited','manual','import','auto')),
    evidence_json JSONB,
    created_by TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (status <> 'approved' OR field_id IS NOT NULL),
    UNIQUE (mapping_id, revision_no),
    UNIQUE (mapping_id, mapping_revision_id),
    UNIQUE (mapping_revision_id, snapshot_id),
    FOREIGN KEY (mapping_id, snapshot_id) REFERENCES mapping(mapping_id, snapshot_id)
);
ALTER TABLE mapping ADD CONSTRAINT mapping_current_revision_fk
    FOREIGN KEY (mapping_id, current_revision_id)
    REFERENCES mapping_revision(mapping_id, mapping_revision_id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX revision_by_mapping ON mapping_revision(mapping_id, revision_no DESC);
CREATE INDEX revision_by_field ON mapping_revision(field_id);

CREATE TABLE mapping_region (
    mapping_revision_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    region_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (mapping_revision_id, role, ordinal),
    FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
    FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id)
);
CREATE INDEX mapping_region_by_region ON mapping_region(region_id);

-- §1.5 Extraction.
CREATE TABLE extraction_run (
    run_id UUID PRIMARY KEY NOT NULL,
    application_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    schema_rev INTEGER,
    profile_rev INTEGER,
    engine_version TEXT NOT NULL,
    input_manifest_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_summary TEXT,
    auto_approved BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (run_id, application_id),
    UNIQUE (run_id, snapshot_id),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id)
);
ALTER TABLE parsing_application ADD CONSTRAINT application_published_run_fk
    FOREIGN KEY (published_run_id, application_id) REFERENCES extraction_run(run_id, application_id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX run_by_application_started ON extraction_run(application_id, started_at DESC);

CREATE TABLE extracted_value (
    value_id UUID PRIMARY KEY NOT NULL,
    run_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    mapping_revision_id UUID NOT NULL,
    field_id UUID NOT NULL REFERENCES parsing_field,
    group_key TEXT NOT NULL,
    record_key TEXT,
    item_index INTEGER,
    raw_text TEXT,
    display_text TEXT,
    value_text TEXT,
    value_type TEXT NOT NULL,
    value_state TEXT NOT NULL CHECK (value_state IN ('present','null','empty','error')),
    unit_raw TEXT,
    unit_normalized TEXT,
    formula_state TEXT,
    source_identity_key TEXT NOT NULL,
    derivation_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (run_id, snapshot_id) REFERENCES extraction_run(run_id, snapshot_id),
    FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
    UNIQUE (value_id, snapshot_id)
);
CREATE INDEX value_by_run_field_record ON extracted_value(run_id, field_id, record_key);
CREATE INDEX value_by_revision ON extracted_value(mapping_revision_id);
CREATE INDEX value_by_field ON extracted_value(field_id);
CREATE INDEX value_by_run_revision ON extracted_value(run_id, mapping_revision_id, group_key, item_index, value_id);
CREATE INDEX value_by_field_created ON extracted_value(field_id, created_at DESC, value_id);
CREATE INDEX value_unit_by_run ON extracted_value(run_id, field_id, unit_normalized) WHERE unit_normalized IS NOT NULL;

CREATE TABLE extracted_value_region (
    value_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    region_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key','input')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (value_id, role, ordinal),
    FOREIGN KEY (value_id, snapshot_id) REFERENCES extracted_value(value_id, snapshot_id),
    FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id)
);
CREATE INDEX value_region_by_region ON extracted_value_region(region_id);

-- §1.7 뷰: 현재 snapshot의 발행된 실행 값만.
CREATE VIEW current_value AS
SELECT d.document_id, a.application_id, a.profile_id, v.*
FROM extracted_value v
JOIN parsing_application a ON a.published_run_id = v.run_id
JOIN document d ON d.current_snapshot_id = a.snapshot_id;

-- ---------------------------------------------------------------------------
-- 트리거 함수. 메시지 문자열은 schema_sqlite.sql의 RAISE(ABORT, ...)와 동일하다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION v3_reject() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION '%', TG_ARGV[0];
END
$fn$;

-- 완료된 실행만 거부하는 불변 트리거(INSERT 뒤 queued/running 동안은 갱신 가능).
CREATE OR REPLACE FUNCTION v3_reject_finished_run() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF OLD.status IN ('succeeded','failed','cancelled') THEN
        RAISE EXCEPTION 'extraction_run is immutable after completion';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_field_edge_level() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    from_level INTEGER;
    to_level INTEGER;
BEGIN
    IF NEW.relation = 'parent_of' THEN
        SELECT field_level INTO from_level FROM parsing_field WHERE field_id = NEW.from_field_id;
        SELECT field_level INTO to_level FROM parsing_field WHERE field_id = NEW.to_field_id;
        IF from_level IS NULL OR to_level IS NULL OR to_level <> from_level + 1 THEN
            RAISE EXCEPTION 'parent_of requires child level = parent level + 1';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_field_edge_same_schema() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF (SELECT schema_id FROM parsing_field WHERE field_id = NEW.from_field_id) IS DISTINCT FROM NEW.schema_id OR
       (SELECT schema_id FROM parsing_field WHERE field_id = NEW.to_field_id) IS DISTINCT FROM NEW.schema_id THEN
        RAISE EXCEPTION 'edge fields must belong to the edge schema';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_field_level_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM parsing_field_edge e JOIN parsing_field child ON child.field_id = e.to_field_id
               WHERE e.relation = 'parent_of' AND e.from_field_id = NEW.field_id
                 AND (NEW.field_level IS NULL OR child.field_level IS DISTINCT FROM NEW.field_level + 1))
       OR EXISTS (SELECT 1 FROM parsing_field_edge e JOIN parsing_field parent ON parent.field_id = e.from_field_id
                  WHERE e.relation = 'parent_of' AND e.to_field_id = NEW.field_id
                    AND (NEW.field_level IS NULL OR NEW.field_level IS DISTINCT FROM parent.field_level + 1)) THEN
        RAISE EXCEPTION 'field level change breaks a parent_of edge';
    END IF;
    RETURN NEW;
END
$fn$;

-- group 필드는 값이 추출되지 않으므로 규칙·리비전의 대상이 될 수 없다. 검사할 컬럼명은 TG_ARGV[0]로 받는다.
CREATE OR REPLACE FUNCTION v3_field_group_not_target() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    target UUID;
BEGIN
    IF TG_ARGV[0] = 'default_field_id' THEN
        target := NEW.default_field_id;
    ELSE
        target := NEW.field_id;
    END IF;
    IF target IS NOT NULL AND EXISTS (SELECT 1 FROM parsing_field WHERE field_id = target AND value_type = 'group') THEN
        RAISE EXCEPTION 'group field cannot be a mapping target';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_field_group_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.value_type = 'group' AND OLD.value_type <> 'group' AND (
        EXISTS (SELECT 1 FROM parsing_rule WHERE default_field_id = NEW.field_id) OR
        EXISTS (SELECT 1 FROM mapping_revision WHERE field_id = NEW.field_id)) THEN
        RAISE EXCEPTION 'group field cannot be a mapping target';
    END IF;
    RETURN NEW;
END
$fn$;

-- projection 삭제는 §4.2.1 스키마·프로파일 삭제와 §4.2.2 필드 삭제에서만 일어나고, 그때도 참조가 하나도 없어야 한다.
CREATE OR REPLACE FUNCTION v3_parsing_field_in_use() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM parsing_field_edge WHERE relation = 'parent_of' AND from_field_id = OLD.field_id)
       OR EXISTS (SELECT 1 FROM parsing_rule WHERE default_field_id = OLD.field_id)
       OR EXISTS (SELECT 1 FROM mapping_revision WHERE field_id = OLD.field_id)
       OR EXISTS (SELECT 1 FROM extracted_value WHERE field_id = OLD.field_id) THEN
        RAISE EXCEPTION 'parsing_field is in use; deprecate instead of delete';
    END IF;
    RETURN OLD;
END
$fn$;

-- 규칙 DELETE도 참조(mapping)가 남아 있을 때만 거부한다 — 실제 삭제는 §4.2.1 프로파일 삭제뿐이다.
CREATE OR REPLACE FUNCTION v3_parsing_rule_in_use() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM mapping WHERE rule_id = OLD.rule_id) THEN
        RAISE EXCEPTION 'parsing_rule is in use; deprecate instead of delete';
    END IF;
    RETURN OLD;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_mapping_edit_seq() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.revision_no IS DISTINCT FROM (SELECT edit_seq + 1 FROM mapping WHERE mapping_id = NEW.mapping_id) THEN
        RAISE EXCEPTION 'mapping edit conflict: revision_no must equal edit_seq + 1';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_mapping_edit_seq_advance() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE mapping SET edit_seq = NEW.revision_no, current_revision_id = NEW.mapping_revision_id
     WHERE mapping_id = NEW.mapping_id;
    RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_mapping_head_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.edit_seq <> OLD.edit_seq + 1 OR NOT EXISTS (
        SELECT 1 FROM mapping_revision
        WHERE mapping_revision_id = NEW.current_revision_id AND mapping_id = NEW.mapping_id
          AND revision_no = NEW.edit_seq) THEN
        RAISE EXCEPTION 'mapping head can only advance through a new revision';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_mapping_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.mapping_id IS DISTINCT FROM OLD.mapping_id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR
       NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.rule_id IS DISTINCT FROM OLD.rule_id OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'mapping identity is immutable';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_mapping_head_invalidates() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE parsing_application SET published_run_id = NULL WHERE application_id = NEW.application_id;
    RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_publish_run() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extraction_run
                    WHERE run_id = NEW.published_run_id AND application_id = NEW.application_id AND status = 'succeeded') THEN
        RAISE EXCEPTION 'only a successful owned run can be published';
    END IF;
    IF EXISTS (SELECT 1 FROM mapping WHERE application_id = NEW.application_id AND current_revision_id IS NULL) THEN
        RAISE EXCEPTION 'every mapping needs a head revision';
    END IF;
    IF EXISTS (SELECT mapping_id, current_revision_id FROM mapping WHERE application_id = NEW.application_id
               EXCEPT SELECT j.key::uuid, (j.value->>'revision_id')::uuid
                      FROM extraction_run r, jsonb_each(r.input_manifest_json->'mappings') AS j
                      WHERE r.run_id = NEW.published_run_id) OR
       EXISTS (SELECT j.key::uuid, (j.value->>'revision_id')::uuid
               FROM extraction_run r, jsonb_each(r.input_manifest_json->'mappings') AS j
               WHERE r.run_id = NEW.published_run_id
               EXCEPT SELECT mapping_id, current_revision_id FROM mapping WHERE application_id = NEW.application_id) THEN
        RAISE EXCEPTION 'run inputs differ from current mapping heads';
    END IF;
    IF EXISTS (SELECT 1 FROM mapping m JOIN mapping_revision v ON v.mapping_revision_id = m.current_revision_id
               WHERE m.application_id = NEW.application_id AND v.status <> 'approved') THEN
        RAISE EXCEPTION 'every mapping head must be approved';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_application_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR
       NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.schema_id IS DISTINCT FROM OLD.schema_id OR
       NEW.scope_key IS DISTINCT FROM OLD.scope_key OR NEW.profile_rev IS DISTINCT FROM OLD.profile_rev OR
       NEW.schema_rev IS DISTINCT FROM OLD.schema_rev THEN
        RAISE EXCEPTION 'application identity is immutable';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v3_run_state_transition() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT (NEW.status = OLD.status OR
            (OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
            (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','cancelled'))) THEN
        RAISE EXCEPTION 'invalid extraction state transition';
    END IF;
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR
       NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.schema_rev IS DISTINCT FROM OLD.schema_rev OR
       NEW.profile_rev IS DISTINCT FROM OLD.profile_rev OR NEW.engine_version IS DISTINCT FROM OLD.engine_version OR
       NEW.input_manifest_json IS DISTINCT FROM OLD.input_manifest_json OR NEW.auto_approved IS DISTINCT FROM OLD.auto_approved THEN
        RAISE EXCEPTION 'run identity and manifest are immutable';
    END IF;
    RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 트리거. 이름은 schema_sqlite.sql과 1:1이다.
-- ---------------------------------------------------------------------------
CREATE TRIGGER field_edge_level BEFORE INSERT ON parsing_field_edge
    FOR EACH ROW WHEN (NEW.relation = 'parent_of') EXECUTE FUNCTION v3_field_edge_level();
CREATE TRIGGER field_edge_level_update BEFORE UPDATE ON parsing_field_edge
    FOR EACH ROW WHEN (NEW.relation = 'parent_of') EXECUTE FUNCTION v3_field_edge_level();
CREATE TRIGGER field_edge_same_schema BEFORE INSERT ON parsing_field_edge
    FOR EACH ROW EXECUTE FUNCTION v3_field_edge_same_schema();
CREATE TRIGGER field_level_guard BEFORE UPDATE OF field_level ON parsing_field
    FOR EACH ROW EXECUTE FUNCTION v3_field_level_guard();
CREATE TRIGGER field_group_not_target_rule BEFORE INSERT ON parsing_rule
    FOR EACH ROW WHEN (NEW.default_field_id IS NOT NULL) EXECUTE FUNCTION v3_field_group_not_target('default_field_id');
CREATE TRIGGER field_group_not_target_rule_update BEFORE UPDATE OF default_field_id ON parsing_rule
    FOR EACH ROW WHEN (NEW.default_field_id IS NOT NULL) EXECUTE FUNCTION v3_field_group_not_target('default_field_id');
CREATE TRIGGER field_group_not_target_revision BEFORE INSERT ON mapping_revision
    FOR EACH ROW WHEN (NEW.field_id IS NOT NULL) EXECUTE FUNCTION v3_field_group_not_target('field_id');
CREATE TRIGGER field_group_guard BEFORE UPDATE OF value_type ON parsing_field
    FOR EACH ROW WHEN (NEW.value_type = 'group' AND OLD.value_type <> 'group') EXECUTE FUNCTION v3_field_group_guard();
CREATE TRIGGER parsing_field_in_use_no_delete BEFORE DELETE ON parsing_field
    FOR EACH ROW EXECUTE FUNCTION v3_parsing_field_in_use();
CREATE TRIGGER parsing_rule_in_use_no_delete BEFORE DELETE ON parsing_rule
    FOR EACH ROW EXECUTE FUNCTION v3_parsing_rule_in_use();

CREATE TRIGGER mapping_edit_seq BEFORE INSERT ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v3_mapping_edit_seq();
CREATE TRIGGER mapping_edit_seq_advance AFTER INSERT ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v3_mapping_edit_seq_advance();
CREATE TRIGGER mapping_head_guard BEFORE UPDATE OF edit_seq, current_revision_id ON mapping
    FOR EACH ROW EXECUTE FUNCTION v3_mapping_head_guard();
CREATE TRIGGER mapping_identity BEFORE UPDATE ON mapping
    FOR EACH ROW EXECUTE FUNCTION v3_mapping_identity();
CREATE TRIGGER mapping_head_invalidates AFTER UPDATE OF current_revision_id ON mapping
    FOR EACH ROW EXECUTE FUNCTION v3_mapping_head_invalidates();

CREATE TRIGGER publish_run BEFORE UPDATE OF published_run_id ON parsing_application
    FOR EACH ROW WHEN (NEW.published_run_id IS NOT NULL) EXECUTE FUNCTION v3_publish_run();
CREATE TRIGGER application_starts_unpublished BEFORE INSERT ON parsing_application
    FOR EACH ROW WHEN (NEW.published_run_id IS NOT NULL) EXECUTE FUNCTION v3_reject('new application must start unpublished');
CREATE TRIGGER application_identity BEFORE UPDATE ON parsing_application
    FOR EACH ROW EXECUTE FUNCTION v3_application_identity();

CREATE TRIGGER extraction_run_no_update BEFORE UPDATE ON extraction_run
    FOR EACH ROW WHEN (OLD.status IN ('succeeded','failed','cancelled')) EXECUTE FUNCTION v3_reject_finished_run();
CREATE TRIGGER extraction_run_no_delete BEFORE DELETE ON extraction_run
    FOR EACH ROW WHEN (OLD.status IN ('succeeded','failed','cancelled')) EXECUTE FUNCTION v3_reject_finished_run();
CREATE TRIGGER run_state_transition BEFORE UPDATE ON extraction_run
    FOR EACH ROW WHEN (OLD.status IN ('queued','running')) EXECUTE FUNCTION v3_run_state_transition();

CREATE TRIGGER document_snapshot_no_update BEFORE UPDATE ON document_snapshot
    FOR EACH ROW EXECUTE FUNCTION v3_reject('document_snapshot is immutable');
CREATE TRIGGER document_snapshot_no_delete BEFORE DELETE ON document_snapshot
    FOR EACH ROW EXECUTE FUNCTION v3_reject('document_snapshot is immutable');
CREATE TRIGGER sheet_no_update BEFORE UPDATE ON sheet
    FOR EACH ROW EXECUTE FUNCTION v3_reject('sheet is immutable');
CREATE TRIGGER sheet_no_delete BEFORE DELETE ON sheet
    FOR EACH ROW EXECUTE FUNCTION v3_reject('sheet is immutable');
CREATE TRIGGER source_region_no_update BEFORE UPDATE ON source_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('source_region is immutable');
CREATE TRIGGER source_region_no_delete BEFORE DELETE ON source_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('source_region is immutable');
CREATE TRIGGER mapping_revision_no_update BEFORE UPDATE ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v3_reject('mapping_revision is immutable');
CREATE TRIGGER mapping_revision_no_delete BEFORE DELETE ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v3_reject('mapping_revision is immutable');
CREATE TRIGGER mapping_region_no_update BEFORE UPDATE ON mapping_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('mapping_region is immutable');
CREATE TRIGGER mapping_region_no_delete BEFORE DELETE ON mapping_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('mapping_region is immutable');
CREATE TRIGGER extracted_value_no_update BEFORE UPDATE ON extracted_value
    FOR EACH ROW EXECUTE FUNCTION v3_reject('extracted_value is immutable');
CREATE TRIGGER extracted_value_no_delete BEFORE DELETE ON extracted_value
    FOR EACH ROW EXECUTE FUNCTION v3_reject('extracted_value is immutable');
CREATE TRIGGER extracted_value_region_no_update BEFORE UPDATE ON extracted_value_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('extracted_value_region is immutable');
CREATE TRIGGER extracted_value_region_no_delete BEFORE DELETE ON extracted_value_region
    FOR EACH ROW EXECUTE FUNCTION v3_reject('extracted_value_region is immutable');
