-- data_gathering v2 스키마의 PostgreSQL 번역본. 새 DB 전용이며 schema_sqlite.sql과 테이블/트리거 이름이 1:1이다.
-- 변환 규칙(docs/design/db-schema-v2.md §10, docs/design/db-schema-v2-postgres.md):
--   애플리케이션 발급 uuid4 TEXT id → UUID, 시스템이 쓰는 ISO TEXT 시각 → TIMESTAMPTZ, 0/1 → BOOLEAN,
--   json_valid() TEXT → JSONB, byte_size → BIGINT, IS NOT → IS DISTINCT FROM, RAISE(ABORT) → RAISE EXCEPTION.
--   concept_id/rule_key/field_key 같은 논리 키와 모든 sha256/참조 문자열은 TEXT를 유지한다.
--   제공자가 보고한 naive ISO(document_version.authored_at/source_modified_at)는 시간대를 추정하지 않기 위해 TEXT를 유지한다(§5).
--   extracted_item.value_text는 value_type별 다형 컬럼이므로 TEXT를 유지하고 NUMERIC 파생 컬럼 value_numeric을 둔다.
-- 포함하지 않는 것: kg/v2/db.py가 런타임에 만드는 SQLite 전용 runtime_job(작업 큐)·version_signature(문서군 제안용 파생 캐시, 재계산 가능) 테이블, AGE projection/outbox 테이블(§10: 실제 확장 시 추가).
-- 검증 범위: pglast 구문 검증(tests/test_schema_postgres.py)만 수행했다. 실제 PostgreSQL 서버에서 실행 검증하지 않았다.
-- JSONB는 키 순서/공백을 정규화한다. definition_sha256/spec_sha256/content_sha256은 항상 애플리케이션의 dump()(kg/v2/db.py)
-- 결과로 계산하며 JSONB 텍스트에서 재계산하지 않는다.

CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY CHECK (version = 2),
    description TEXT NOT NULL
);
INSERT INTO schema_meta VALUES (2, 'Versioned extraction v2; PostgreSQL translation of schema_sqlite.sql');

-- 큰 원본/렌더/산출물 바이트는 DB 밖에 둔다. URI는 서버 전용 불투명 참조다.
CREATE TABLE artifact (
    artifact_id UUID PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('protected_source','template_code','render','dataset','report','manifest')),
    storage_ref TEXT NOT NULL,
    sha256 TEXT,
    byte_size BIGINT CHECK (byte_size >= 0),
    media_type TEXT,
    git_commit TEXT,
    dvc_ref_json JSONB,
    policy_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

-- 도메인 KG는 사람이 발행한 불변 스냅샷. concept_id는 개념의 논리 ID다.
CREATE TABLE kg_revision (
    kg_revision_id UUID PRIMARY KEY NOT NULL,
    revision_no INTEGER NOT NULL UNIQUE CHECK (revision_no > 0),
    content_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE domain_concept (
    kg_revision_id UUID NOT NULL REFERENCES kg_revision,
    concept_id TEXT NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level > 0),
    value_type TEXT,
    canonical_unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    PRIMARY KEY (kg_revision_id, concept_id)
);
CREATE TABLE domain_edge (
    kg_revision_id UUID NOT NULL,
    from_concept_id TEXT NOT NULL,
    to_concept_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    PRIMARY KEY (kg_revision_id, from_concept_id, to_concept_id, relation_type),
    FOREIGN KEY (kg_revision_id, from_concept_id) REFERENCES domain_concept,
    FOREIGN KEY (kg_revision_id, to_concept_id) REFERENCES domain_concept,
    CHECK (from_concept_id <> to_concept_id)
);
CREATE INDEX edge_incoming ON domain_edge(kg_revision_id, to_concept_id, relation_type, from_concept_id);
CREATE TABLE domain_alias (
    kg_revision_id UUID NOT NULL,
    concept_id TEXT NOT NULL,
    alias_norm TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (kg_revision_id, concept_id, alias_norm, context_key),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept
);
-- 같은 단어가 여러 개념의 동의어일 수 있다. 전역 UNIQUE(alias_norm)는 금지한다.
CREATE INDEX alias_lookup ON domain_alias(kg_revision_id, alias_norm, context_key, concept_id);

-- document ↔ document_version은 상호 참조라 current_version_id FK는 document_version 생성 뒤 ALTER TABLE로 붙인다.
CREATE TABLE document (
    document_id UUID PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    file_type TEXT NOT NULL DEFAULT 'xlsx',
    current_version_id UUID,
    registered_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX document_page ON document(display_name, document_id);
CREATE TABLE document_version (
    document_version_id UUID PRIMARY KEY NOT NULL,
    document_id UUID NOT NULL REFERENCES document,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    provider_version_token TEXT,
    ciphertext_sha256 TEXT,
    content_sha256 TEXT, -- 접근 정책상 계산할 수 있을 때만; 해시 계산을 위한 해제본을 만들지 않는다.
    source_artifact_id UUID REFERENCES artifact,
    filename TEXT NOT NULL,
    author TEXT,
    authored_at TEXT, -- 제공자가 보고한 naive ISO 원문. 시간대를 추정하지 않으므로 TIMESTAMPTZ로 바꾸지 않는다.
    source_modified_at TEXT, -- 위와 같다.
    file_type TEXT NOT NULL DEFAULT 'xlsx',
    excel_date_system TEXT CHECK (excel_date_system IN ('1900','1904')),
    byte_size BIGINT CHECK (byte_size >= 0),
    captured_at TIMESTAMPTZ NOT NULL,
    UNIQUE (document_id, revision_no),
    UNIQUE (document_id, document_version_id)
);
ALTER TABLE document ADD CONSTRAINT document_current_version_fk
    FOREIGN KEY (document_id, current_version_id)
    REFERENCES document_version(document_id, document_version_id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX version_page ON document_version(document_id, revision_no DESC);
CREATE TABLE sheet (
    sheet_id UUID PRIMARY KEY NOT NULL,
    document_version_id UUID NOT NULL REFERENCES document_version,
    native_sheet_key TEXT, -- 제공자 내부 ID; 버전 간 동일성은 별도 검증한다.
    name TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','very_hidden')),
    estimated_rows INTEGER CHECK (estimated_rows >= 0),
    estimated_cols INTEGER CHECK (estimated_cols >= 0),
    UNIQUE (document_version_id, ordinal),
    UNIQUE (document_version_id, name),
    UNIQUE (sheet_id, document_version_id)
);

-- 권한의 관찰 이력일 뿐 실제 권한 부여 테이블이 아니다. 매 요청/작업 시작에 제공자가 재확인한다.
CREATE TABLE access_observation (
    access_id UUID PRIMARY KEY NOT NULL,
    document_version_id UUID NOT NULL REFERENCES document_version,
    principal_ref TEXT NOT NULL,
    provider TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    can_view BOOLEAN NOT NULL,
    can_extract BOOLEAN NOT NULL,
    can_render_web BOOLEAN NOT NULL,
    can_cache_derivative BOOLEAN NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- 하나의 행은 한 시트의 한 직사각형/객체다. 떨어진 두 영역을 큰 사각형 하나로 합치지 않는다.
-- 셀 좌표는 1부터 시작하며 양 끝을 포함한다. 그림의 정확한 앵커는 geometry_json에 둔다.
CREATE TABLE source_region (
    region_id UUID PRIMARY KEY NOT NULL,
    document_version_id UUID NOT NULL,
    sheet_id UUID NOT NULL,
    kind TEXT NOT NULL DEFAULT 'cells' CHECK (kind IN ('cells','image','chart','shape','text')),
    locator_key TEXT NOT NULL,
    r1 INTEGER NOT NULL CHECK (r1 >= 1),
    c1 INTEGER NOT NULL CHECK (c1 >= 1),
    r2 INTEGER NOT NULL CHECK (r2 >= r1),
    c2 INTEGER NOT NULL CHECK (c2 >= c1),
    merge_anchor_r INTEGER,
    merge_anchor_c INTEGER,
    object_key TEXT,
    geometry_json JSONB,
    FOREIGN KEY (sheet_id, document_version_id) REFERENCES sheet(sheet_id, document_version_id),
    UNIQUE (sheet_id, locator_key),
    UNIQUE (region_id, document_version_id),
    CHECK ((merge_anchor_r IS NULL AND merge_anchor_c IS NULL) OR
           (merge_anchor_r IS NOT NULL AND merge_anchor_c IS NOT NULL AND
            merge_anchor_r BETWEEN r1 AND r2 AND merge_anchor_c BETWEEN c1 AND c2)),
    CHECK (kind = 'cells' OR object_key IS NOT NULL)
);
CREATE INDEX region_viewport ON source_region(sheet_id, r1, r2, c1, c2);

CREATE TABLE template (
    template_id UUID PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE template_version (
    template_version_id UUID PRIMARY KEY NOT NULL,
    template_id UUID NOT NULL REFERENCES template,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id UUID NOT NULL REFERENCES kg_revision,
    format TEXT NOT NULL CHECK (format IN ('json','python','hybrid')),
    definition_json JSONB NOT NULL,
    definition_sha256 TEXT NOT NULL,
    code_artifact_id UUID REFERENCES artifact,
    engine_contract_version TEXT NOT NULL,
    environment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (template_id, revision_no),
    UNIQUE (template_version_id, kg_revision_id),
    CHECK (format = 'json' OR code_artifact_id IS NOT NULL)
);
CREATE TABLE template_rule (
    template_version_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    kg_revision_id UUID NOT NULL,
    concept_id TEXT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    selector_json JSONB NOT NULL,
    record_spec_json JSONB NOT NULL,
    value_spec_json JSONB NOT NULL,
    PRIMARY KEY (template_version_id, rule_key),
    UNIQUE (template_version_id, ordinal),
    FOREIGN KEY (template_version_id, kg_revision_id) REFERENCES template_version(template_version_id, kg_revision_id),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept
);
-- 한 적용 건이 여러 시트 역할을 바인딩한다. 같은 문서/위치의 다른 목적은 scope_key로 구분한다.
-- published_run_id FK는 extraction_run 생성 뒤 ALTER TABLE로 붙인다(상호 참조).
CREATE TABLE template_application (
    application_id UUID PRIMARY KEY NOT NULL,
    document_version_id UUID NOT NULL REFERENCES document_version,
    template_version_id UUID NOT NULL REFERENCES template_version,
    scope_key TEXT NOT NULL,
    published_run_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (document_version_id, template_version_id, scope_key),
    UNIQUE (application_id, document_version_id, template_version_id),
    UNIQUE (application_id, document_version_id),
    UNIQUE (application_id, template_version_id)
);
CREATE TABLE application_sheet (
    application_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    role_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sheet_id UUID NOT NULL,
    PRIMARY KEY (application_id, role_key, ordinal),
    UNIQUE (application_id, role_key, sheet_id),
    FOREIGN KEY (application_id, document_version_id) REFERENCES template_application(application_id, document_version_id),
    FOREIGN KEY (sheet_id, document_version_id) REFERENCES sheet(sheet_id, document_version_id)
);
CREATE INDEX sheet_applications ON application_sheet(sheet_id, application_id);

-- 원본은 수정하지 않는다. 키/값 위치 또는 개념 수정·승인·반려마다 새 리비전을 쓴다.
CREATE TABLE mapping_revision (
    mapping_revision_id UUID PRIMARY KEY NOT NULL,
    application_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    template_version_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id UUID NOT NULL,
    concept_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('template','manual','candidate')),
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
    effective_spec_json JSONB NOT NULL,
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    supersedes_id UUID,
    created_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (application_id, rule_key, revision_no),
    UNIQUE (mapping_revision_id, application_id, rule_key),
    UNIQUE (mapping_revision_id, document_version_id),
    FOREIGN KEY (application_id, document_version_id, template_version_id)
        REFERENCES template_application(application_id, document_version_id, template_version_id),
    FOREIGN KEY (template_version_id, rule_key) REFERENCES template_rule,
    FOREIGN KEY (template_version_id, kg_revision_id) REFERENCES template_version(template_version_id, kg_revision_id),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept,
    FOREIGN KEY (supersedes_id, application_id, rule_key)
        REFERENCES mapping_revision(mapping_revision_id, application_id, rule_key),
    CHECK (status <> 'approved' OR concept_id IS NOT NULL)
);
CREATE INDEX mapping_by_concept ON mapping_revision(kg_revision_id, concept_id, status, mapping_revision_id);
CREATE TABLE mapping_head (
    application_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    mapping_revision_id UUID NOT NULL,
    edit_seq INTEGER NOT NULL DEFAULT 1 CHECK (edit_seq > 0),
    PRIMARY KEY (application_id, rule_key),
    FOREIGN KEY (mapping_revision_id, application_id, rule_key)
        REFERENCES mapping_revision(mapping_revision_id, application_id, rule_key)
);

CREATE TABLE extraction_run (
    run_id UUID PRIMARY KEY NOT NULL,
    application_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    template_version_id UUID NOT NULL,
    request_key TEXT NOT NULL, -- HTTP 재전송은 같은 키, 명시적 재시도는 새 키.
    input_fingerprint TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    environment_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    error_summary TEXT,
    UNIQUE (application_id, request_key),
    UNIQUE (run_id, application_id),
    UNIQUE (run_id, document_version_id),
    FOREIGN KEY (application_id, document_version_id, template_version_id)
        REFERENCES template_application(application_id, document_version_id, template_version_id)
);
ALTER TABLE template_application ADD CONSTRAINT application_published_run_fk
    FOREIGN KEY (published_run_id, application_id) REFERENCES extraction_run(run_id, application_id);
CREATE INDEX extraction_job_page ON extraction_run(status, created_at, run_id);
CREATE TABLE run_mapping (
    run_id UUID NOT NULL,
    application_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    mapping_revision_id UUID NOT NULL,
    PRIMARY KEY (run_id, rule_key),
    UNIQUE (run_id, mapping_revision_id),
    FOREIGN KEY (run_id, application_id) REFERENCES extraction_run(run_id, application_id),
    FOREIGN KEY (mapping_revision_id, application_id, rule_key)
        REFERENCES mapping_revision(mapping_revision_id, application_id, rule_key)
);
CREATE TABLE extracted_series (
    series_id UUID PRIMARY KEY NOT NULL,
    run_id UUID NOT NULL,
    mapping_revision_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    instance_key TEXT NOT NULL, -- 동일 규칙이 발견한 반복 블록의 식별자.
    record_scope_key TEXT NOT NULL, -- 문서버전/표/반복블록 범위; 서로 다른 표의 행번호 혼합 방지.
    observed_key TEXT,
    cardinality TEXT NOT NULL CHECK (cardinality IN ('scalar','list','matrix')),
    axis TEXT NOT NULL CHECK (axis IN ('none','down','right','row_major','column_major')),
    status TEXT NOT NULL CHECK (status IN ('ready','missing','review_required')),
    UNIQUE (run_id, mapping_revision_id, instance_key),
    UNIQUE (series_id, document_version_id),
    FOREIGN KEY (run_id, mapping_revision_id) REFERENCES run_mapping(run_id, mapping_revision_id),
    FOREIGN KEY (run_id, document_version_id) REFERENCES extraction_run(run_id, document_version_id),
    FOREIGN KEY (mapping_revision_id, document_version_id) REFERENCES mapping_revision(mapping_revision_id, document_version_id),
    CHECK ((cardinality='scalar' AND axis='none') OR
           (cardinality='list' AND axis IN ('down','right')) OR
           (cardinality='matrix' AND axis IN ('row_major','column_major')))
);
CREATE TABLE series_region (
    series_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    region_id UUID NOT NULL,
    PRIMARY KEY (series_id, role, ordinal),
    FOREIGN KEY (series_id, document_version_id) REFERENCES extracted_series(series_id, document_version_id),
    FOREIGN KEY (region_id, document_version_id) REFERENCES source_region(region_id, document_version_id)
);
CREATE INDEX region_series ON series_region(region_id, series_id);
-- 리스트 전체 JSON 대신 값 하나당 한 행. value_text는 십진 문자열 원문이며 value_numeric은 decimal 항목의 NUMERIC 파생 컬럼이다.
CREATE TABLE extracted_item (
    item_id UUID PRIMARY KEY NOT NULL,
    series_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    record_key TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK (row_ordinal >= 0),
    col_ordinal INTEGER NOT NULL CHECK (col_ordinal >= 0),
    raw_type TEXT NOT NULL,
    raw_text TEXT,
    display_text TEXT,
    value_type TEXT NOT NULL CHECK (value_type IN ('decimal','text','boolean','date','datetime','asset','null')),
    value_text TEXT,
    value_numeric NUMERIC GENERATED ALWAYS AS (CASE WHEN value_type = 'decimal' THEN value_text::numeric END) STORED,
    value_state TEXT NOT NULL CHECK (value_state IN ('present','blank','missing','excel_error','unavailable')),
    formula_text TEXT,
    formula_state TEXT NOT NULL DEFAULT 'none' CHECK (formula_state IN ('none','cached','cached_unknown_age','missing_cache','evaluated_by_provider')),
    unit_raw TEXT,
    unit_normalized TEXT,
    source_identity_key TEXT NOT NULL, -- 원자 출처들의 정규 직렬화. 값/템플릿 ID/실행 ID를 포함하지 않는다.
    derivation_key TEXT NOT NULL, -- 의미/정규화/계산/단위 규칙의 정규 직렬화; 템플릿 전체 해시가 아니다.
    UNIQUE (series_id, item_index),
    UNIQUE (item_id, document_version_id),
    FOREIGN KEY (series_id, document_version_id) REFERENCES extracted_series(series_id, document_version_id),
    CHECK ((value_state = 'present' AND value_type <> 'null' AND value_text IS NOT NULL) OR
           (value_state <> 'present' AND value_type = 'null' AND value_text IS NULL)),
    CHECK (value_type <> 'boolean' OR value_text IN ('true','false')),
    CHECK (formula_state = 'none' OR formula_text IS NOT NULL)
);
CREATE INDEX item_record ON extracted_item(series_id, record_key, item_index);
CREATE INDEX item_source_identity ON extracted_item(source_identity_key, derivation_key);
CREATE TABLE item_region (
    item_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('value','input','record_key','unit','context')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    region_id UUID NOT NULL,
    PRIMARY KEY (item_id, role, ordinal),
    FOREIGN KEY (item_id, document_version_id) REFERENCES extracted_item(item_id, document_version_id),
    FOREIGN KEY (region_id, document_version_id) REFERENCES source_region(region_id, document_version_id)
);
CREATE INDEX item_by_region ON item_region(region_id, item_id);

-- 렌더는 재생성 가능한 페이지/타일/셀 블록 캐시. 전체 시트 JSON/BLOB를 한 행에 넣지 않는다.
CREATE TABLE render_chunk (
    sheet_id UUID NOT NULL REFERENCES sheet,
    render_profile_key TEXT NOT NULL,
    access_scope_key TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    layout_revision TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('tile','page','cells','geometry','thumbnail')),
    artifact_id UUID NOT NULL REFERENCES artifact,
    geometry_json JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (sheet_id, render_profile_key, access_scope_key, policy_revision, layout_revision, chunk_key)
);
CREATE INDEX render_expiry ON render_chunk(expires_at);

CREATE TABLE integration_project (
    project_id UUID PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE integration_version (
    integration_version_id UUID PRIMARY KEY NOT NULL,
    project_id UUID NOT NULL REFERENCES integration_project,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id UUID NOT NULL REFERENCES kg_revision,
    spec_json JSONB NOT NULL, -- 소스선택/업무키/조인/정규화/중복/충돌/DAG.
    spec_sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, revision_no),
    UNIQUE (integration_version_id, kg_revision_id)
);
CREATE TABLE integration_field (
    integration_version_id UUID NOT NULL,
    field_key TEXT NOT NULL,
    kg_revision_id UUID NOT NULL,
    concept_id TEXT,
    output_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    target_type TEXT NOT NULL,
    target_unit TEXT,
    PRIMARY KEY (integration_version_id, field_key),
    UNIQUE (integration_version_id, ordinal),
    UNIQUE (integration_version_id, output_name),
    FOREIGN KEY (integration_version_id, kg_revision_id) REFERENCES integration_version(integration_version_id, kg_revision_id),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept
);
CREATE TABLE build_run (
    build_id UUID PRIMARY KEY NOT NULL,
    integration_version_id UUID NOT NULL REFERENCES integration_version,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    input_fingerprint TEXT NOT NULL,
    input_manifest_json JSONB NOT NULL,
    output_artifact_id UUID REFERENCES artifact,
    report_artifact_id UUID REFERENCES artifact,
    row_count INTEGER CHECK (row_count >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    UNIQUE (build_id, integration_version_id)
);
CREATE TABLE build_input (
    build_id UUID NOT NULL REFERENCES build_run,
    run_id UUID NOT NULL REFERENCES extraction_run,
    selection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (build_id, run_id)
);
-- 사용자가 필드마다 선택한 추출 소스. 빌드 시작 시 실제 실행 ID로 해석하여 build_input에 고정한다.
CREATE TABLE integration_source (
    integration_version_id UUID NOT NULL,
    field_key TEXT NOT NULL,
    application_id UUID NOT NULL,
    template_version_id UUID NOT NULL,
    rule_key TEXT NOT NULL,
    pinned_run_id UUID,
    options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (integration_version_id, field_key, application_id, rule_key),
    FOREIGN KEY (integration_version_id, field_key) REFERENCES integration_field,
    FOREIGN KEY (application_id, template_version_id) REFERENCES template_application(application_id, template_version_id),
    FOREIGN KEY (template_version_id, rule_key) REFERENCES template_rule,
    FOREIGN KEY (pinned_run_id, application_id) REFERENCES extraction_run(run_id, application_id)
);
-- 결과 한 칸에 N개의 원본 항목이 기여할 수 있다. 합계/조인/중복 병합의 출처를 모두 남긴다.
CREATE TABLE build_lineage (
    build_id UUID NOT NULL,
    integration_version_id UUID NOT NULL,
    output_table TEXT NOT NULL,
    output_row_key TEXT NOT NULL,
    field_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    item_id UUID NOT NULL REFERENCES extracted_item,
    contribution_role TEXT NOT NULL CHECK (contribution_role IN ('value','deduplicated','aggregate_input','join_key','filter_input')),
    transform_path_json JSONB NOT NULL,
    PRIMARY KEY (build_id, output_table, output_row_key, field_key, ordinal),
    FOREIGN KEY (build_id, integration_version_id) REFERENCES build_run(build_id, integration_version_id),
    FOREIGN KEY (integration_version_id, field_key) REFERENCES integration_field
);
CREATE INDEX lineage_reverse ON build_lineage(item_id, build_id);

-- 런타임 인덱스: kg/v2/db.py가 SQLite에서 CREATE INDEX IF NOT EXISTS로 만드는 것과 같다.
CREATE INDEX access_latest ON access_observation(document_version_id, principal_ref, checked_at DESC, access_id DESC);
CREATE INDEX app_source ON template_application(document_version_id, application_id);
CREATE INDEX version_provider ON document(provider, source_ref);
CREATE INDEX series_by_mapping ON extracted_series(mapping_revision_id, run_id, series_id);
CREATE INDEX items_by_series ON extracted_item(series_id, item_index, item_id);

-- 트리거 함수. 메시지 문자열은 schema_sqlite.sql의 RAISE(ABORT, ...)와 동일하다.
CREATE OR REPLACE FUNCTION v2_reject() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION '%', TG_ARGV[0];
END
$fn$;

CREATE OR REPLACE FUNCTION v2_mapping_head_approved_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id = NEW.mapping_revision_id AND status = 'approved') THEN
        RAISE EXCEPTION 'mapping head must be approved';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_mapping_head_approved_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.rule_key IS DISTINCT FROM OLD.rule_key THEN
        RAISE EXCEPTION 'mapping head identity is immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id = NEW.mapping_revision_id AND status = 'approved') THEN
        RAISE EXCEPTION 'mapping head must be approved';
    END IF;
    IF NEW.edit_seq <> OLD.edit_seq + 1 THEN
        RAISE EXCEPTION 'edit_seq must advance by one';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_mapping_head_invalidate() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE template_application SET published_run_id = NULL
     WHERE application_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.application_id ELSE NEW.application_id END;
    RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_run_mapping_pin() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extraction_run WHERE run_id = NEW.run_id AND status = 'queued') THEN
        RAISE EXCEPTION 'inputs can only be pinned while queued';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id = NEW.mapping_revision_id AND status = 'approved') THEN
        RAISE EXCEPTION 'run input must be approved';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_run_state_transition() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
            (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','cancelled'))) THEN
        RAISE EXCEPTION 'invalid extraction state transition';
    END IF;
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR
       NEW.document_version_id IS DISTINCT FROM OLD.document_version_id OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR
       NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint OR
       NEW.engine_version IS DISTINCT FROM OLD.engine_version OR NEW.environment_json IS DISTINCT FROM OLD.environment_json THEN
        RAISE EXCEPTION 'run identity and manifest are immutable';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_application_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id OR
       NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.scope_key IS DISTINCT FROM OLD.scope_key THEN
        RAISE EXCEPTION 'application bindings require a new application';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_publish_run() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extraction_run
                    WHERE run_id = NEW.published_run_id AND application_id = NEW.application_id AND status = 'succeeded') THEN
        RAISE EXCEPTION 'only a successful owned run can be published';
    END IF;
    IF EXISTS (SELECT rule_key, mapping_revision_id FROM mapping_head WHERE application_id = NEW.application_id
               EXCEPT SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id = NEW.published_run_id) OR
       EXISTS (SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id = NEW.published_run_id
               EXCEPT SELECT rule_key, mapping_revision_id FROM mapping_head WHERE application_id = NEW.application_id) THEN
        RAISE EXCEPTION 'run inputs differ from current mapping heads';
    END IF;
    IF EXISTS (SELECT 1 FROM extracted_series WHERE run_id = NEW.published_run_id AND status <> 'ready') THEN
        RAISE EXCEPTION 'run has unresolved or missing series';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM run_mapping WHERE run_id = NEW.published_run_id) OR EXISTS (
        SELECT 1 FROM run_mapping m WHERE m.run_id = NEW.published_run_id AND NOT EXISTS (
            SELECT 1 FROM extracted_series s WHERE s.run_id = m.run_id AND s.mapping_revision_id = m.mapping_revision_id)) THEN
        RAISE EXCEPTION 'every run input needs a resolved series';
    END IF;
    IF EXISTS (SELECT 1 FROM extracted_series s WHERE s.run_id = NEW.published_run_id AND s.cardinality = 'scalar'
               AND (SELECT count(*) FROM extracted_item i WHERE i.series_id = s.series_id) <> 1) THEN
        RAISE EXCEPTION 'scalar series must contain exactly one item';
    END IF;
    IF EXISTS (SELECT 1 FROM extracted_series s WHERE s.run_id = NEW.published_run_id AND
               (NOT EXISTS (SELECT 1 FROM series_region r WHERE r.series_id = s.series_id AND r.role = 'key') OR
                NOT EXISTS (SELECT 1 FROM series_region r WHERE r.series_id = s.series_id AND r.role = 'value'))) THEN
        RAISE EXCEPTION 'resolved series needs key and value regions';
    END IF;
    IF EXISTS (SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
               WHERE s.run_id = NEW.published_run_id AND NOT EXISTS (
                   SELECT 1 FROM item_region r WHERE r.item_id = i.item_id AND r.role IN ('value','input'))) THEN
        RAISE EXCEPTION 'every item needs atomic provenance';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_lineage_selected_input() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
                   JOIN build_input b ON b.run_id = s.run_id WHERE i.item_id = NEW.item_id AND b.build_id = NEW.build_id) THEN
        RAISE EXCEPTION 'lineage item is outside build inputs';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
                   JOIN mapping_revision m USING (mapping_revision_id)
                   JOIN integration_source f ON f.application_id = m.application_id AND f.rule_key = m.rule_key
                   WHERE i.item_id = NEW.item_id AND f.integration_version_id = NEW.integration_version_id AND f.field_key = NEW.field_key
                     AND (f.pinned_run_id IS NULL OR f.pinned_run_id = s.run_id)) THEN
        RAISE EXCEPTION 'lineage item is outside field source selection';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_kg_sealed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM template_version WHERE kg_revision_id = NEW.kg_revision_id)
       OR EXISTS (SELECT 1 FROM integration_version WHERE kg_revision_id = NEW.kg_revision_id) THEN
        RAISE EXCEPTION 'referenced KG snapshot is sealed';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_template_rule_sealed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM template_application WHERE template_version_id = NEW.template_version_id) THEN
        RAISE EXCEPTION 'applied template version is sealed';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_application_sheet_sealed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF (TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM extraction_run WHERE application_id = NEW.application_id))
       OR (TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM extraction_run WHERE application_id = OLD.application_id)) THEN
        RAISE EXCEPTION 'executed application sheet bindings are sealed';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$fn$;

-- 테이블마다 조인이 다르므로 NEW의 존재하지 않는 컬럼을 참조하지 않도록 함수를 분리한다.
CREATE OR REPLACE FUNCTION v2_extracted_series_running() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extraction_run WHERE run_id = NEW.run_id AND status = 'running') THEN
        RAISE EXCEPTION 'extraction output requires a running job';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_series_region_running() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extracted_series s JOIN extraction_run r USING (run_id)
                   WHERE s.series_id = NEW.series_id AND r.status = 'running') THEN
        RAISE EXCEPTION 'extraction output requires a running job';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_extracted_item_running() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extracted_series s JOIN extraction_run r USING (run_id)
                   WHERE s.series_id = NEW.series_id AND r.status = 'running') THEN
        RAISE EXCEPTION 'extraction output requires a running job';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_item_region_running() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id) JOIN extraction_run r USING (run_id)
                   WHERE i.item_id = NEW.item_id AND r.status = 'running') THEN
        RAISE EXCEPTION 'extraction output requires a running job';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_build_state_transition() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
            (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','cancelled'))) THEN
        RAISE EXCEPTION 'invalid build state transition';
    END IF;
    IF NEW.build_id IS DISTINCT FROM OLD.build_id OR NEW.integration_version_id IS DISTINCT FROM OLD.integration_version_id OR
       NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint OR NEW.input_manifest_json IS DISTINCT FROM OLD.input_manifest_json THEN
        RAISE EXCEPTION 'build manifest is immutable';
    END IF;
    IF NEW.status = 'succeeded'
       AND NOT EXISTS (SELECT 1 FROM artifact WHERE artifact_id = NEW.output_artifact_id AND kind = 'dataset') THEN
        RAISE EXCEPTION 'successful build requires a dataset artifact';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_build_input_pin() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM build_run WHERE build_id = NEW.build_id AND status = 'queued') THEN
        RAISE EXCEPTION 'build inputs require a queued build';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM extraction_run WHERE run_id = NEW.run_id AND status = 'succeeded') THEN
        RAISE EXCEPTION 'build input requires a successful extraction';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_build_lineage_running() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM build_run WHERE build_id = NEW.build_id AND status = 'running') THEN
        RAISE EXCEPTION 'build lineage requires a running build';
    END IF;
    RETURN NEW;
END
$fn$;

-- parent_of의 방향은 부모→자식. 어느 한쪽 레벨이 NULL이면 SQLite와 같이 통과한다.
CREATE OR REPLACE FUNCTION v2_hierarchy_level() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF (SELECT level FROM domain_concept WHERE kg_revision_id = NEW.kg_revision_id AND concept_id = NEW.to_concept_id)
       <> (SELECT level + 1 FROM domain_concept WHERE kg_revision_id = NEW.kg_revision_id AND concept_id = NEW.from_concept_id) THEN
        RAISE EXCEPTION 'hierarchy must advance exactly one level';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION v2_integration_sealed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM build_run WHERE integration_version_id = NEW.integration_version_id) THEN
        RAISE EXCEPTION '%', TG_ARGV[0];
    END IF;
    RETURN NEW;
END
$fn$;

-- 승인된 head만 현재 매핑으로 사용한다. edit_seq는 API의 조건부 UPDATE에 쓴다.
CREATE TRIGGER mapping_head_approved_insert BEFORE INSERT ON mapping_head
    FOR EACH ROW EXECUTE FUNCTION v2_mapping_head_approved_insert();
CREATE TRIGGER mapping_head_approved_update BEFORE UPDATE ON mapping_head
    FOR EACH ROW EXECUTE FUNCTION v2_mapping_head_approved_update();
CREATE TRIGGER mapping_head_invalidates_insert AFTER INSERT ON mapping_head
    FOR EACH ROW EXECUTE FUNCTION v2_mapping_head_invalidate();
CREATE TRIGGER mapping_head_invalidates_update AFTER UPDATE ON mapping_head
    FOR EACH ROW EXECUTE FUNCTION v2_mapping_head_invalidate();
CREATE TRIGGER mapping_head_invalidates_delete AFTER DELETE ON mapping_head
    FOR EACH ROW EXECUTE FUNCTION v2_mapping_head_invalidate();
CREATE TRIGGER run_mapping_pin BEFORE INSERT ON run_mapping
    FOR EACH ROW EXECUTE FUNCTION v2_run_mapping_pin();
CREATE TRIGGER run_state_transition BEFORE UPDATE ON extraction_run
    FOR EACH ROW EXECUTE FUNCTION v2_run_state_transition();
CREATE TRIGGER application_identity BEFORE UPDATE ON template_application
    FOR EACH ROW EXECUTE FUNCTION v2_application_identity();
CREATE TRIGGER publish_run BEFORE UPDATE OF published_run_id ON template_application
    FOR EACH ROW WHEN (NEW.published_run_id IS NOT NULL) EXECUTE FUNCTION v2_publish_run();
CREATE TRIGGER lineage_selected_input BEFORE INSERT ON build_lineage
    FOR EACH ROW EXECUTE FUNCTION v2_lineage_selected_input();

-- 현재 조회는 원본 버전과 발행된 실행을 고정하여 과거 결과가 섞이는 것을 막는다.
CREATE VIEW current_extracted_item AS
SELECT i.*, s.run_id, s.mapping_revision_id, s.record_scope_key, m.kg_revision_id, m.concept_id,
       a.application_id, a.template_version_id
FROM extracted_item i
JOIN extracted_series s USING (series_id)
JOIN mapping_revision m USING (mapping_revision_id)
JOIN template_application a ON a.published_run_id = s.run_id
JOIN document_version v ON v.document_version_id = a.document_version_id
JOIN document d ON d.document_id = v.document_id AND d.current_version_id = v.document_version_id;

-- 스냅샷은 INSERT만 허용한다. 수정/철회는 새 버전 또는 head 이동으로 표현한다.
CREATE TRIGGER kg_revision_no_update BEFORE UPDATE ON kg_revision
    FOR EACH ROW EXECUTE FUNCTION v2_reject('kg_revision is immutable');
CREATE TRIGGER kg_revision_no_delete BEFORE DELETE ON kg_revision
    FOR EACH ROW EXECUTE FUNCTION v2_reject('kg_revision is immutable');
CREATE TRIGGER domain_concept_no_update BEFORE UPDATE ON domain_concept
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_concept is immutable');
CREATE TRIGGER domain_concept_no_delete BEFORE DELETE ON domain_concept
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_concept is immutable');
CREATE TRIGGER domain_alias_no_update BEFORE UPDATE ON domain_alias
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_alias is immutable');
CREATE TRIGGER domain_alias_no_delete BEFORE DELETE ON domain_alias
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_alias is immutable');
CREATE TRIGGER domain_edge_no_update BEFORE UPDATE ON domain_edge
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_edge is immutable');
CREATE TRIGGER domain_edge_no_delete BEFORE DELETE ON domain_edge
    FOR EACH ROW EXECUTE FUNCTION v2_reject('domain_edge is immutable');
CREATE TRIGGER document_version_no_update BEFORE UPDATE ON document_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('document_version is immutable');
CREATE TRIGGER document_version_no_delete BEFORE DELETE ON document_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('document_version is immutable');
CREATE TRIGGER sheet_no_update BEFORE UPDATE ON sheet
    FOR EACH ROW EXECUTE FUNCTION v2_reject('sheet is immutable');
CREATE TRIGGER sheet_no_delete BEFORE DELETE ON sheet
    FOR EACH ROW EXECUTE FUNCTION v2_reject('sheet is immutable');
CREATE TRIGGER source_region_no_update BEFORE UPDATE ON source_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('source_region is immutable');
CREATE TRIGGER source_region_no_delete BEFORE DELETE ON source_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('source_region is immutable');
CREATE TRIGGER template_version_no_update BEFORE UPDATE ON template_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('template_version is immutable');
CREATE TRIGGER template_version_no_delete BEFORE DELETE ON template_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('template_version is immutable');
CREATE TRIGGER template_rule_no_update BEFORE UPDATE ON template_rule
    FOR EACH ROW EXECUTE FUNCTION v2_reject('template_rule is immutable');
CREATE TRIGGER template_rule_no_delete BEFORE DELETE ON template_rule
    FOR EACH ROW EXECUTE FUNCTION v2_reject('template_rule is immutable');
CREATE TRIGGER mapping_revision_no_update BEFORE UPDATE ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v2_reject('mapping_revision is immutable');
CREATE TRIGGER mapping_revision_no_delete BEFORE DELETE ON mapping_revision
    FOR EACH ROW EXECUTE FUNCTION v2_reject('mapping_revision is immutable');
CREATE TRIGGER run_mapping_no_update BEFORE UPDATE ON run_mapping
    FOR EACH ROW EXECUTE FUNCTION v2_reject('run_mapping is immutable');
CREATE TRIGGER run_mapping_no_delete BEFORE DELETE ON run_mapping
    FOR EACH ROW EXECUTE FUNCTION v2_reject('run_mapping is immutable');
CREATE TRIGGER extracted_series_no_update BEFORE UPDATE ON extracted_series
    FOR EACH ROW EXECUTE FUNCTION v2_reject('extracted_series is immutable');
CREATE TRIGGER extracted_series_no_delete BEFORE DELETE ON extracted_series
    FOR EACH ROW EXECUTE FUNCTION v2_reject('extracted_series is immutable');
CREATE TRIGGER series_region_no_update BEFORE UPDATE ON series_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('series_region is immutable');
CREATE TRIGGER series_region_no_delete BEFORE DELETE ON series_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('series_region is immutable');
CREATE TRIGGER extracted_item_no_update BEFORE UPDATE ON extracted_item
    FOR EACH ROW EXECUTE FUNCTION v2_reject('extracted_item is immutable');
CREATE TRIGGER extracted_item_no_delete BEFORE DELETE ON extracted_item
    FOR EACH ROW EXECUTE FUNCTION v2_reject('extracted_item is immutable');
CREATE TRIGGER item_region_no_update BEFORE UPDATE ON item_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('item_region is immutable');
CREATE TRIGGER item_region_no_delete BEFORE DELETE ON item_region
    FOR EACH ROW EXECUTE FUNCTION v2_reject('item_region is immutable');
CREATE TRIGGER integration_version_no_update BEFORE UPDATE ON integration_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_version is immutable');
CREATE TRIGGER integration_version_no_delete BEFORE DELETE ON integration_version
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_version is immutable');
CREATE TRIGGER integration_field_no_update BEFORE UPDATE ON integration_field
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_field is immutable');
CREATE TRIGGER integration_field_no_delete BEFORE DELETE ON integration_field
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_field is immutable');
CREATE TRIGGER build_input_no_update BEFORE UPDATE ON build_input
    FOR EACH ROW EXECUTE FUNCTION v2_reject('build_input is immutable');
CREATE TRIGGER build_input_no_delete BEFORE DELETE ON build_input
    FOR EACH ROW EXECUTE FUNCTION v2_reject('build_input is immutable');
CREATE TRIGGER build_lineage_no_update BEFORE UPDATE ON build_lineage
    FOR EACH ROW EXECUTE FUNCTION v2_reject('build_lineage is immutable');
CREATE TRIGGER build_lineage_no_delete BEFORE DELETE ON build_lineage
    FOR EACH ROW EXECUTE FUNCTION v2_reject('build_lineage is immutable');
CREATE TRIGGER domain_concept_sealed BEFORE INSERT ON domain_concept
    FOR EACH ROW EXECUTE FUNCTION v2_kg_sealed();
CREATE TRIGGER domain_alias_sealed BEFORE INSERT ON domain_alias
    FOR EACH ROW EXECUTE FUNCTION v2_kg_sealed();
CREATE TRIGGER domain_edge_sealed BEFORE INSERT ON domain_edge
    FOR EACH ROW EXECUTE FUNCTION v2_kg_sealed();
CREATE TRIGGER template_rule_sealed BEFORE INSERT ON template_rule
    FOR EACH ROW EXECUTE FUNCTION v2_template_rule_sealed();
CREATE TRIGGER application_starts_unpublished BEFORE INSERT ON template_application
    FOR EACH ROW WHEN (NEW.published_run_id IS NOT NULL) EXECUTE FUNCTION v2_reject('new application must start unpublished');
CREATE TRIGGER extraction_starts_queued BEFORE INSERT ON extraction_run
    FOR EACH ROW WHEN (NEW.status <> 'queued') EXECUTE FUNCTION v2_reject('new extraction must start queued');
CREATE TRIGGER extraction_no_delete BEFORE DELETE ON extraction_run
    FOR EACH ROW EXECUTE FUNCTION v2_reject('extraction run is audit history');
CREATE TRIGGER application_sheet_insert BEFORE INSERT ON application_sheet
    FOR EACH ROW EXECUTE FUNCTION v2_application_sheet_sealed();
CREATE TRIGGER application_sheet_update BEFORE UPDATE ON application_sheet
    FOR EACH ROW EXECUTE FUNCTION v2_application_sheet_sealed();
CREATE TRIGGER application_sheet_delete BEFORE DELETE ON application_sheet
    FOR EACH ROW EXECUTE FUNCTION v2_application_sheet_sealed();
CREATE TRIGGER extracted_series_running_insert BEFORE INSERT ON extracted_series
    FOR EACH ROW EXECUTE FUNCTION v2_extracted_series_running();
CREATE TRIGGER series_region_running_insert BEFORE INSERT ON series_region
    FOR EACH ROW EXECUTE FUNCTION v2_series_region_running();
CREATE TRIGGER extracted_item_running_insert BEFORE INSERT ON extracted_item
    FOR EACH ROW EXECUTE FUNCTION v2_extracted_item_running();
CREATE TRIGGER item_region_running_insert BEFORE INSERT ON item_region
    FOR EACH ROW EXECUTE FUNCTION v2_item_region_running();
CREATE TRIGGER build_starts_queued BEFORE INSERT ON build_run
    FOR EACH ROW WHEN (NEW.status <> 'queued') EXECUTE FUNCTION v2_reject('new build must start queued');
CREATE TRIGGER build_state_transition BEFORE UPDATE ON build_run
    FOR EACH ROW EXECUTE FUNCTION v2_build_state_transition();
CREATE TRIGGER build_no_delete BEFORE DELETE ON build_run
    FOR EACH ROW EXECUTE FUNCTION v2_reject('build run is audit history');
CREATE TRIGGER build_input_pin BEFORE INSERT ON build_input
    FOR EACH ROW EXECUTE FUNCTION v2_build_input_pin();
CREATE TRIGGER build_lineage_running BEFORE INSERT ON build_lineage
    FOR EACH ROW EXECUTE FUNCTION v2_build_lineage_running();

-- parent_of의 방향은 부모→자식. 다른 관계는 계층 레벨에 얽매이지 않는다.
CREATE TRIGGER hierarchy_level BEFORE INSERT ON domain_edge
    FOR EACH ROW WHEN (NEW.relation_type = 'parent_of') EXECUTE FUNCTION v2_hierarchy_level();
CREATE TRIGGER integration_field_sealed BEFORE INSERT ON integration_field
    FOR EACH ROW EXECUTE FUNCTION v2_integration_sealed('built integration version is sealed');
CREATE TRIGGER integration_source_sealed BEFORE INSERT ON integration_source
    FOR EACH ROW EXECUTE FUNCTION v2_integration_sealed('built integration sources are sealed');
CREATE TRIGGER integration_source_no_update BEFORE UPDATE ON integration_source
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_source is immutable');
CREATE TRIGGER integration_source_no_delete BEFORE DELETE ON integration_source
    FOR EACH ROW EXECUTE FUNCTION v2_reject('integration_source is immutable');
