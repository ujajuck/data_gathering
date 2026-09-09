-- data_gathering v2 스키마. 새 DB 전용이며 kg/schema.sql의 자동 마이그레이션이 아니다.
-- 문서/템플릿 ID는 애플리케이션이 생성하는 안정 ID(UUID 권장), 해시는 버전 검증용이다.
-- 각 연결에서도 foreign_keys/busy_timeout을 설정한다. WAL은 배포 시 로컬 디스크에서 설정한다.
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY CHECK (version = 2),
    description TEXT NOT NULL
);
INSERT INTO schema_meta VALUES (2, 'Versioned extraction v2; separate database; no v1 migration');

-- 큰 원본/렌더/산출물 바이트는 DB 밖에 둔다. URI는 서버 전용 불투명 참조다.
CREATE TABLE artifact (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('protected_source','template_code','render','dataset','report','manifest')),
    storage_ref TEXT NOT NULL,
    sha256 TEXT,
    byte_size INTEGER CHECK (byte_size >= 0),
    media_type TEXT,
    git_commit TEXT,
    dvc_ref_json TEXT CHECK (dvc_ref_json IS NULL OR json_valid(dvc_ref_json)),
    policy_ref TEXT,
    created_at TEXT NOT NULL
);

-- 도메인 KG는 사람이 발행한 불변 스냅샷. concept_id는 개념의 논리 ID다.
CREATE TABLE kg_revision (
    kg_revision_id TEXT PRIMARY KEY NOT NULL,
    revision_no INTEGER NOT NULL UNIQUE CHECK (revision_no > 0),
    content_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE domain_concept (
    kg_revision_id TEXT NOT NULL REFERENCES kg_revision,
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
    kg_revision_id TEXT NOT NULL,
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
    kg_revision_id TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    alias_norm TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
    PRIMARY KEY (kg_revision_id, concept_id, alias_norm, context_key),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept
);
-- 같은 단어가 여러 개념의 동의어일 수 있다. 전역 UNIQUE(alias_norm)는 금지한다.
CREATE INDEX alias_lookup ON domain_alias(kg_revision_id, alias_norm, context_key, concept_id);

CREATE TABLE document (
    document_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    file_type TEXT NOT NULL DEFAULT 'xlsx',
    current_version_id TEXT,
    registered_at TEXT NOT NULL,
    FOREIGN KEY (document_id, current_version_id)
        REFERENCES document_version(document_id, document_version_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX document_page ON document(display_name, document_id);
CREATE TABLE document_version (
    document_version_id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES document,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    provider_version_token TEXT,
    ciphertext_sha256 TEXT,
    content_sha256 TEXT, -- 접근 정책상 계산할 수 있을 때만; 해시 계산을 위한 해제본을 만들지 않는다.
    source_artifact_id TEXT REFERENCES artifact,
    filename TEXT NOT NULL,
    author TEXT,
    authored_at TEXT,
    source_modified_at TEXT,
    file_type TEXT NOT NULL DEFAULT 'xlsx',
    excel_date_system TEXT CHECK (excel_date_system IN ('1900','1904')),
    byte_size INTEGER CHECK (byte_size >= 0),
    captured_at TEXT NOT NULL,
    UNIQUE (document_id, revision_no),
    UNIQUE (document_id, document_version_id)
);
CREATE INDEX version_page ON document_version(document_id, revision_no DESC);
CREATE TABLE sheet (
    sheet_id TEXT PRIMARY KEY NOT NULL,
    document_version_id TEXT NOT NULL REFERENCES document_version,
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
    access_id TEXT PRIMARY KEY NOT NULL,
    document_version_id TEXT NOT NULL REFERENCES document_version,
    principal_ref TEXT NOT NULL,
    provider TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    can_view INTEGER NOT NULL CHECK (can_view IN (0,1)),
    can_extract INTEGER NOT NULL CHECK (can_extract IN (0,1)),
    can_render_web INTEGER NOT NULL CHECK (can_render_web IN (0,1)),
    can_cache_derivative INTEGER NOT NULL CHECK (can_cache_derivative IN (0,1)),
    checked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- 하나의 행은 한 시트의 한 직사각형/객체다. 떨어진 두 영역을 큰 사각형 하나로 합치지 않는다.
-- 셀 좌표는 1부터 시작하며 양 끝을 포함한다. 그림의 정확한 앵커는 geometry_json에 둔다.
CREATE TABLE source_region (
    region_id TEXT PRIMARY KEY NOT NULL,
    document_version_id TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'cells' CHECK (kind IN ('cells','image','chart','shape','text')),
    locator_key TEXT NOT NULL,
    r1 INTEGER NOT NULL CHECK (r1 >= 1),
    c1 INTEGER NOT NULL CHECK (c1 >= 1),
    r2 INTEGER NOT NULL CHECK (r2 >= r1),
    c2 INTEGER NOT NULL CHECK (c2 >= c1),
    merge_anchor_r INTEGER,
    merge_anchor_c INTEGER,
    object_key TEXT,
    geometry_json TEXT CHECK (geometry_json IS NULL OR json_valid(geometry_json)),
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
    template_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE template_version (
    template_version_id TEXT PRIMARY KEY NOT NULL,
    template_id TEXT NOT NULL REFERENCES template,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id TEXT NOT NULL REFERENCES kg_revision,
    format TEXT NOT NULL CHECK (format IN ('json','python','hybrid')),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    definition_sha256 TEXT NOT NULL,
    code_artifact_id TEXT REFERENCES artifact,
    engine_contract_version TEXT NOT NULL,
    environment_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(environment_json)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (template_id, revision_no),
    UNIQUE (template_version_id, kg_revision_id),
    CHECK (format = 'json' OR code_artifact_id IS NOT NULL)
);
CREATE TABLE template_rule (
    template_version_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    kg_revision_id TEXT NOT NULL,
    concept_id TEXT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
    record_spec_json TEXT NOT NULL CHECK (json_valid(record_spec_json)),
    value_spec_json TEXT NOT NULL CHECK (json_valid(value_spec_json)),
    PRIMARY KEY (template_version_id, rule_key),
    UNIQUE (template_version_id, ordinal),
    FOREIGN KEY (template_version_id, kg_revision_id) REFERENCES template_version(template_version_id, kg_revision_id),
    FOREIGN KEY (kg_revision_id, concept_id) REFERENCES domain_concept
);
-- 한 적용 건이 여러 시트 역할을 바인딩한다. 같은 문서/위치의 다른 목적은 scope_key로 구분한다.
CREATE TABLE template_application (
    application_id TEXT PRIMARY KEY NOT NULL,
    document_version_id TEXT NOT NULL REFERENCES document_version,
    template_version_id TEXT NOT NULL REFERENCES template_version,
    scope_key TEXT NOT NULL,
    published_run_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (document_version_id, template_version_id, scope_key),
    UNIQUE (application_id, document_version_id, template_version_id),
    UNIQUE (application_id, document_version_id),
    UNIQUE (application_id, template_version_id),
    FOREIGN KEY (published_run_id, application_id) REFERENCES extraction_run(run_id, application_id)
);
CREATE TABLE application_sheet (
    application_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sheet_id TEXT NOT NULL,
    PRIMARY KEY (application_id, role_key, ordinal),
    UNIQUE (application_id, role_key, sheet_id),
    FOREIGN KEY (application_id, document_version_id) REFERENCES template_application(application_id, document_version_id),
    FOREIGN KEY (sheet_id, document_version_id) REFERENCES sheet(sheet_id, document_version_id)
);
CREATE INDEX sheet_applications ON application_sheet(sheet_id, application_id);

-- 원본은 수정하지 않는다. 키/값 위치 또는 개념 수정·승인·반려마다 새 리비전을 쓴다.
CREATE TABLE mapping_revision (
    mapping_revision_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    template_version_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id TEXT NOT NULL,
    concept_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('template','manual','candidate')),
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
    effective_spec_json TEXT NOT NULL CHECK (json_valid(effective_spec_json)),
    evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
    supersedes_id TEXT,
    created_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
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
    application_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    mapping_revision_id TEXT NOT NULL,
    edit_seq INTEGER NOT NULL DEFAULT 1 CHECK (edit_seq > 0),
    PRIMARY KEY (application_id, rule_key),
    FOREIGN KEY (mapping_revision_id, application_id, rule_key)
        REFERENCES mapping_revision(mapping_revision_id, application_id, rule_key)
);

CREATE TABLE extraction_run (
    run_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    template_version_id TEXT NOT NULL,
    request_key TEXT NOT NULL, -- HTTP 재전송은 같은 키, 명시적 재시도는 새 키.
    input_fingerprint TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    error_summary TEXT,
    UNIQUE (application_id, request_key),
    UNIQUE (run_id, application_id),
    UNIQUE (run_id, document_version_id),
    FOREIGN KEY (application_id, document_version_id, template_version_id)
        REFERENCES template_application(application_id, document_version_id, template_version_id)
);
CREATE INDEX extraction_job_page ON extraction_run(status, created_at, run_id);
CREATE TABLE run_mapping (
    run_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    mapping_revision_id TEXT NOT NULL,
    PRIMARY KEY (run_id, rule_key),
    UNIQUE (run_id, mapping_revision_id),
    FOREIGN KEY (run_id, application_id) REFERENCES extraction_run(run_id, application_id),
    FOREIGN KEY (mapping_revision_id, application_id, rule_key)
        REFERENCES mapping_revision(mapping_revision_id, application_id, rule_key)
);
CREATE TABLE extracted_series (
    series_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    mapping_revision_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
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
    series_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    region_id TEXT NOT NULL,
    PRIMARY KEY (series_id, role, ordinal),
    FOREIGN KEY (series_id, document_version_id) REFERENCES extracted_series(series_id, document_version_id),
    FOREIGN KEY (region_id, document_version_id) REFERENCES source_region(region_id, document_version_id)
);
CREATE INDEX region_series ON series_region(region_id, series_id);
-- 리스트 전체 JSON 대신 값 하나당 한 행. 숫자는 십진 문자열로 보존하여 SQLite REAL 반올림을 피한다.
CREATE TABLE extracted_item (
    item_id TEXT PRIMARY KEY NOT NULL,
    series_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    record_key TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK (row_ordinal >= 0),
    col_ordinal INTEGER NOT NULL CHECK (col_ordinal >= 0),
    raw_type TEXT NOT NULL,
    raw_text TEXT,
    display_text TEXT,
    value_type TEXT NOT NULL CHECK (value_type IN ('decimal','text','boolean','date','datetime','asset','null')),
    value_text TEXT,
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
    item_id TEXT NOT NULL,
    document_version_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('value','input','record_key','unit','context')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    region_id TEXT NOT NULL,
    PRIMARY KEY (item_id, role, ordinal),
    FOREIGN KEY (item_id, document_version_id) REFERENCES extracted_item(item_id, document_version_id),
    FOREIGN KEY (region_id, document_version_id) REFERENCES source_region(region_id, document_version_id)
);
CREATE INDEX item_by_region ON item_region(region_id, item_id);

-- 렌더는 재생성 가능한 페이지/타일/셀 블록 캐시. 전체 시트 JSON/BLOB를 한 행에 넣지 않는다.
CREATE TABLE render_chunk (
    sheet_id TEXT NOT NULL REFERENCES sheet,
    render_profile_key TEXT NOT NULL,
    access_scope_key TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    layout_revision TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('tile','page','cells','geometry','thumbnail')),
    artifact_id TEXT NOT NULL REFERENCES artifact,
    geometry_json TEXT NOT NULL CHECK (json_valid(geometry_json)),
    expires_at TEXT NOT NULL,
    PRIMARY KEY (sheet_id, render_profile_key, access_scope_key, policy_revision, layout_revision, chunk_key)
);
CREATE INDEX render_expiry ON render_chunk(expires_at);

CREATE TABLE integration_project (
    project_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE integration_version (
    integration_version_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES integration_project,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    kg_revision_id TEXT NOT NULL REFERENCES kg_revision,
    spec_json TEXT NOT NULL CHECK (json_valid(spec_json)), -- 소스선택/업무키/조인/정규화/중복/충돌/DAG.
    spec_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, revision_no),
    UNIQUE (integration_version_id, kg_revision_id)
);
CREATE TABLE integration_field (
    integration_version_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    kg_revision_id TEXT NOT NULL,
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
    build_id TEXT PRIMARY KEY NOT NULL,
    integration_version_id TEXT NOT NULL REFERENCES integration_version,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    input_fingerprint TEXT NOT NULL,
    input_manifest_json TEXT NOT NULL CHECK (json_valid(input_manifest_json)),
    output_artifact_id TEXT REFERENCES artifact,
    report_artifact_id TEXT REFERENCES artifact,
    row_count INTEGER CHECK (row_count >= 0),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (build_id, integration_version_id)
);
CREATE TABLE build_input (
    build_id TEXT NOT NULL REFERENCES build_run,
    run_id TEXT NOT NULL REFERENCES extraction_run,
    selection_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selection_json)),
    PRIMARY KEY (build_id, run_id)
);
-- 사용자가 필드마다 선택한 추출 소스. 빌드 시작 시 실제 실행 ID로 해석하여 build_input에 고정한다.
CREATE TABLE integration_source (
    integration_version_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    application_id TEXT NOT NULL,
    template_version_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    pinned_run_id TEXT,
    options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
    PRIMARY KEY (integration_version_id, field_key, application_id, rule_key),
    FOREIGN KEY (integration_version_id, field_key) REFERENCES integration_field,
    FOREIGN KEY (application_id, template_version_id) REFERENCES template_application(application_id, template_version_id),
    FOREIGN KEY (template_version_id, rule_key) REFERENCES template_rule,
    FOREIGN KEY (pinned_run_id, application_id) REFERENCES extraction_run(run_id, application_id)
);
-- 결과 한 칸에 N개의 원본 항목이 기여할 수 있다. 합계/조인/중복 병합의 출처를 모두 남긴다.
CREATE TABLE build_lineage (
    build_id TEXT NOT NULL,
    integration_version_id TEXT NOT NULL,
    output_table TEXT NOT NULL,
    output_row_key TEXT NOT NULL,
    field_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    item_id TEXT NOT NULL REFERENCES extracted_item,
    contribution_role TEXT NOT NULL CHECK (contribution_role IN ('value','deduplicated','aggregate_input','join_key','filter_input')),
    transform_path_json TEXT NOT NULL CHECK (json_valid(transform_path_json)),
    PRIMARY KEY (build_id, output_table, output_row_key, field_key, ordinal),
    FOREIGN KEY (build_id, integration_version_id) REFERENCES build_run(build_id, integration_version_id),
    FOREIGN KEY (integration_version_id, field_key) REFERENCES integration_field
);
CREATE INDEX lineage_reverse ON build_lineage(item_id, build_id);

-- 승인된 head만 현재 매핑으로 사용한다. edit_seq는 API의 조건부 UPDATE에 쓴다.
CREATE TRIGGER mapping_head_approved_insert BEFORE INSERT ON mapping_head BEGIN
    SELECT RAISE(ABORT, 'mapping head must be approved') WHERE
        NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id=NEW.mapping_revision_id AND status='approved');
END;
CREATE TRIGGER mapping_head_approved_update BEFORE UPDATE ON mapping_head BEGIN
    SELECT RAISE(ABORT, 'mapping head identity is immutable') WHERE
        NEW.application_id IS NOT OLD.application_id OR NEW.rule_key IS NOT OLD.rule_key;
    SELECT RAISE(ABORT, 'mapping head must be approved') WHERE
        NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id=NEW.mapping_revision_id AND status='approved');
    SELECT RAISE(ABORT, 'edit_seq must advance by one') WHERE NEW.edit_seq <> OLD.edit_seq + 1;
END;
CREATE TRIGGER mapping_head_invalidates_insert AFTER INSERT ON mapping_head BEGIN
    UPDATE template_application SET published_run_id=NULL WHERE application_id=NEW.application_id;
END;
CREATE TRIGGER mapping_head_invalidates_update AFTER UPDATE ON mapping_head BEGIN
    UPDATE template_application SET published_run_id=NULL WHERE application_id=NEW.application_id;
END;
CREATE TRIGGER mapping_head_invalidates_delete AFTER DELETE ON mapping_head BEGIN
    UPDATE template_application SET published_run_id=NULL WHERE application_id=OLD.application_id;
END;
CREATE TRIGGER run_mapping_pin BEFORE INSERT ON run_mapping BEGIN
    SELECT RAISE(ABORT, 'inputs can only be pinned while queued') WHERE
        NOT EXISTS (SELECT 1 FROM extraction_run WHERE run_id=NEW.run_id AND status='queued');
    SELECT RAISE(ABORT, 'run input must be approved') WHERE
        NOT EXISTS (SELECT 1 FROM mapping_revision WHERE mapping_revision_id=NEW.mapping_revision_id AND status='approved');
END;
CREATE TRIGGER run_state_transition BEFORE UPDATE ON extraction_run BEGIN
    SELECT RAISE(ABORT, 'invalid extraction state transition') WHERE NOT (
        (OLD.status='queued' AND NEW.status IN ('running','failed','cancelled')) OR
        (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled')));
    SELECT RAISE(ABORT, 'run identity and manifest are immutable') WHERE
        NEW.run_id IS NOT OLD.run_id OR NEW.application_id IS NOT OLD.application_id OR
        NEW.document_version_id IS NOT OLD.document_version_id OR NEW.template_version_id IS NOT OLD.template_version_id OR
        NEW.request_key IS NOT OLD.request_key OR NEW.input_fingerprint IS NOT OLD.input_fingerprint OR
        NEW.engine_version IS NOT OLD.engine_version OR NEW.environment_json IS NOT OLD.environment_json;
END;
CREATE TRIGGER application_identity BEFORE UPDATE ON template_application BEGIN
    SELECT RAISE(ABORT, 'application bindings require a new application') WHERE
        NEW.application_id IS NOT OLD.application_id OR NEW.document_version_id IS NOT OLD.document_version_id OR
        NEW.template_version_id IS NOT OLD.template_version_id OR NEW.scope_key IS NOT OLD.scope_key;
END;
CREATE TRIGGER publish_run BEFORE UPDATE OF published_run_id ON template_application
WHEN NEW.published_run_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'only a successful owned run can be published') WHERE NOT EXISTS (
        SELECT 1 FROM extraction_run WHERE run_id=NEW.published_run_id AND application_id=NEW.application_id AND status='succeeded');
    SELECT RAISE(ABORT, 'run inputs differ from current mapping heads') WHERE
        EXISTS (SELECT rule_key, mapping_revision_id FROM mapping_head WHERE application_id=NEW.application_id
                EXCEPT SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id=NEW.published_run_id) OR
        EXISTS (SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id=NEW.published_run_id
                EXCEPT SELECT rule_key, mapping_revision_id FROM mapping_head WHERE application_id=NEW.application_id);
    SELECT RAISE(ABORT, 'run has unresolved or missing series') WHERE EXISTS (
        SELECT 1 FROM extracted_series WHERE run_id=NEW.published_run_id AND status<>'ready');
    SELECT RAISE(ABORT, 'every run input needs a resolved series') WHERE NOT EXISTS (
        SELECT 1 FROM run_mapping WHERE run_id=NEW.published_run_id) OR EXISTS (
        SELECT 1 FROM run_mapping m WHERE m.run_id=NEW.published_run_id AND NOT EXISTS (
            SELECT 1 FROM extracted_series s WHERE s.run_id=m.run_id AND s.mapping_revision_id=m.mapping_revision_id));
    SELECT RAISE(ABORT, 'scalar series must contain exactly one item') WHERE EXISTS (
        SELECT 1 FROM extracted_series s WHERE s.run_id=NEW.published_run_id AND s.cardinality='scalar'
        AND (SELECT count(*) FROM extracted_item i WHERE i.series_id=s.series_id)<>1);
    SELECT RAISE(ABORT, 'resolved series needs key and value regions') WHERE EXISTS (
        SELECT 1 FROM extracted_series s WHERE s.run_id=NEW.published_run_id AND
        (NOT EXISTS (SELECT 1 FROM series_region r WHERE r.series_id=s.series_id AND r.role='key') OR
         NOT EXISTS (SELECT 1 FROM series_region r WHERE r.series_id=s.series_id AND r.role='value')));
    SELECT RAISE(ABORT, 'every item needs atomic provenance') WHERE EXISTS (
        SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
        WHERE s.run_id=NEW.published_run_id AND NOT EXISTS (
            SELECT 1 FROM item_region r WHERE r.item_id=i.item_id AND r.role IN ('value','input')));
END;
CREATE TRIGGER lineage_selected_input BEFORE INSERT ON build_lineage BEGIN
    SELECT RAISE(ABORT, 'lineage item is outside build inputs') WHERE NOT EXISTS (
        SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
        JOIN build_input b ON b.run_id=s.run_id WHERE i.item_id=NEW.item_id AND b.build_id=NEW.build_id);
    SELECT RAISE(ABORT, 'lineage item is outside field source selection') WHERE NOT EXISTS (
        SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id)
        JOIN mapping_revision m USING (mapping_revision_id)
        JOIN integration_source f ON f.application_id=m.application_id AND f.rule_key=m.rule_key
        WHERE i.item_id=NEW.item_id AND f.integration_version_id=NEW.integration_version_id AND f.field_key=NEW.field_key
          AND (f.pinned_run_id IS NULL OR f.pinned_run_id=s.run_id));
END;

-- 현재 조회는 원본 버전과 발행된 실행을 고정하여 과거 결과가 섞이는 것을 막는다.
CREATE VIEW current_extracted_item AS
SELECT i.*, s.run_id, s.mapping_revision_id, s.record_scope_key, m.kg_revision_id, m.concept_id,
       a.application_id, a.template_version_id
FROM extracted_item i
JOIN extracted_series s USING (series_id)
JOIN mapping_revision m USING (mapping_revision_id)
JOIN template_application a ON a.published_run_id=s.run_id
JOIN document_version v ON v.document_version_id=a.document_version_id
JOIN document d ON d.document_id=v.document_id AND d.current_version_id=v.document_version_id;

-- 스냅샷은 INSERT만 허용한다. 수정/철회는 새 버전 또는 head 이동으로 표현한다.
CREATE TRIGGER kg_revision_no_update BEFORE UPDATE ON kg_revision
BEGIN SELECT RAISE(ABORT, 'kg_revision is immutable'); END;
CREATE TRIGGER kg_revision_no_delete BEFORE DELETE ON kg_revision
BEGIN SELECT RAISE(ABORT, 'kg_revision is immutable'); END;
CREATE TRIGGER domain_concept_no_update BEFORE UPDATE ON domain_concept
BEGIN SELECT RAISE(ABORT, 'domain_concept is immutable'); END;
CREATE TRIGGER domain_concept_no_delete BEFORE DELETE ON domain_concept
BEGIN SELECT RAISE(ABORT, 'domain_concept is immutable'); END;
CREATE TRIGGER domain_alias_no_update BEFORE UPDATE ON domain_alias
BEGIN SELECT RAISE(ABORT, 'domain_alias is immutable'); END;
CREATE TRIGGER domain_alias_no_delete BEFORE DELETE ON domain_alias
BEGIN SELECT RAISE(ABORT, 'domain_alias is immutable'); END;
CREATE TRIGGER domain_edge_no_update BEFORE UPDATE ON domain_edge
BEGIN SELECT RAISE(ABORT, 'domain_edge is immutable'); END;
CREATE TRIGGER domain_edge_no_delete BEFORE DELETE ON domain_edge
BEGIN SELECT RAISE(ABORT, 'domain_edge is immutable'); END;
CREATE TRIGGER document_version_no_update BEFORE UPDATE ON document_version
BEGIN SELECT RAISE(ABORT, 'document_version is immutable'); END;
CREATE TRIGGER document_version_no_delete BEFORE DELETE ON document_version
BEGIN SELECT RAISE(ABORT, 'document_version is immutable'); END;
CREATE TRIGGER sheet_no_update BEFORE UPDATE ON sheet
BEGIN SELECT RAISE(ABORT, 'sheet is immutable'); END;
CREATE TRIGGER sheet_no_delete BEFORE DELETE ON sheet
BEGIN SELECT RAISE(ABORT, 'sheet is immutable'); END;
CREATE TRIGGER source_region_no_update BEFORE UPDATE ON source_region
BEGIN SELECT RAISE(ABORT, 'source_region is immutable'); END;
CREATE TRIGGER source_region_no_delete BEFORE DELETE ON source_region
BEGIN SELECT RAISE(ABORT, 'source_region is immutable'); END;
CREATE TRIGGER template_version_no_update BEFORE UPDATE ON template_version
BEGIN SELECT RAISE(ABORT, 'template_version is immutable'); END;
CREATE TRIGGER template_version_no_delete BEFORE DELETE ON template_version
BEGIN SELECT RAISE(ABORT, 'template_version is immutable'); END;
CREATE TRIGGER template_rule_no_update BEFORE UPDATE ON template_rule
BEGIN SELECT RAISE(ABORT, 'template_rule is immutable'); END;
CREATE TRIGGER template_rule_no_delete BEFORE DELETE ON template_rule
BEGIN SELECT RAISE(ABORT, 'template_rule is immutable'); END;
CREATE TRIGGER mapping_revision_no_update BEFORE UPDATE ON mapping_revision
BEGIN SELECT RAISE(ABORT, 'mapping_revision is immutable'); END;
CREATE TRIGGER mapping_revision_no_delete BEFORE DELETE ON mapping_revision
BEGIN SELECT RAISE(ABORT, 'mapping_revision is immutable'); END;
CREATE TRIGGER run_mapping_no_update BEFORE UPDATE ON run_mapping
BEGIN SELECT RAISE(ABORT, 'run_mapping is immutable'); END;
CREATE TRIGGER run_mapping_no_delete BEFORE DELETE ON run_mapping
BEGIN SELECT RAISE(ABORT, 'run_mapping is immutable'); END;
CREATE TRIGGER extracted_series_no_update BEFORE UPDATE ON extracted_series
BEGIN SELECT RAISE(ABORT, 'extracted_series is immutable'); END;
CREATE TRIGGER extracted_series_no_delete BEFORE DELETE ON extracted_series
BEGIN SELECT RAISE(ABORT, 'extracted_series is immutable'); END;
CREATE TRIGGER series_region_no_update BEFORE UPDATE ON series_region
BEGIN SELECT RAISE(ABORT, 'series_region is immutable'); END;
CREATE TRIGGER series_region_no_delete BEFORE DELETE ON series_region
BEGIN SELECT RAISE(ABORT, 'series_region is immutable'); END;
CREATE TRIGGER extracted_item_no_update BEFORE UPDATE ON extracted_item
BEGIN SELECT RAISE(ABORT, 'extracted_item is immutable'); END;
CREATE TRIGGER extracted_item_no_delete BEFORE DELETE ON extracted_item
BEGIN SELECT RAISE(ABORT, 'extracted_item is immutable'); END;
CREATE TRIGGER item_region_no_update BEFORE UPDATE ON item_region
BEGIN SELECT RAISE(ABORT, 'item_region is immutable'); END;
CREATE TRIGGER item_region_no_delete BEFORE DELETE ON item_region
BEGIN SELECT RAISE(ABORT, 'item_region is immutable'); END;
CREATE TRIGGER integration_version_no_update BEFORE UPDATE ON integration_version
BEGIN SELECT RAISE(ABORT, 'integration_version is immutable'); END;
CREATE TRIGGER integration_version_no_delete BEFORE DELETE ON integration_version
BEGIN SELECT RAISE(ABORT, 'integration_version is immutable'); END;
CREATE TRIGGER integration_field_no_update BEFORE UPDATE ON integration_field
BEGIN SELECT RAISE(ABORT, 'integration_field is immutable'); END;
CREATE TRIGGER integration_field_no_delete BEFORE DELETE ON integration_field
BEGIN SELECT RAISE(ABORT, 'integration_field is immutable'); END;
CREATE TRIGGER build_input_no_update BEFORE UPDATE ON build_input
BEGIN SELECT RAISE(ABORT, 'build_input is immutable'); END;
CREATE TRIGGER build_input_no_delete BEFORE DELETE ON build_input
BEGIN SELECT RAISE(ABORT, 'build_input is immutable'); END;
CREATE TRIGGER build_lineage_no_update BEFORE UPDATE ON build_lineage
BEGIN SELECT RAISE(ABORT, 'build_lineage is immutable'); END;
CREATE TRIGGER build_lineage_no_delete BEFORE DELETE ON build_lineage
BEGIN SELECT RAISE(ABORT, 'build_lineage is immutable'); END;
CREATE TRIGGER domain_concept_sealed BEFORE INSERT ON domain_concept
WHEN EXISTS (SELECT 1 FROM template_version WHERE kg_revision_id=NEW.kg_revision_id)
  OR EXISTS (SELECT 1 FROM integration_version WHERE kg_revision_id=NEW.kg_revision_id)
BEGIN SELECT RAISE(ABORT, 'referenced KG snapshot is sealed'); END;
CREATE TRIGGER domain_alias_sealed BEFORE INSERT ON domain_alias
WHEN EXISTS (SELECT 1 FROM template_version WHERE kg_revision_id=NEW.kg_revision_id)
  OR EXISTS (SELECT 1 FROM integration_version WHERE kg_revision_id=NEW.kg_revision_id)
BEGIN SELECT RAISE(ABORT, 'referenced KG snapshot is sealed'); END;
CREATE TRIGGER domain_edge_sealed BEFORE INSERT ON domain_edge
WHEN EXISTS (SELECT 1 FROM template_version WHERE kg_revision_id=NEW.kg_revision_id)
  OR EXISTS (SELECT 1 FROM integration_version WHERE kg_revision_id=NEW.kg_revision_id)
BEGIN SELECT RAISE(ABORT, 'referenced KG snapshot is sealed'); END;
CREATE TRIGGER template_rule_sealed BEFORE INSERT ON template_rule
WHEN EXISTS (SELECT 1 FROM template_application WHERE template_version_id=NEW.template_version_id)
BEGIN SELECT RAISE(ABORT, 'applied template version is sealed'); END;
CREATE TRIGGER application_starts_unpublished BEFORE INSERT ON template_application
WHEN NEW.published_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'new application must start unpublished'); END;
CREATE TRIGGER extraction_starts_queued BEFORE INSERT ON extraction_run
WHEN NEW.status<>'queued'
BEGIN SELECT RAISE(ABORT, 'new extraction must start queued'); END;
CREATE TRIGGER extraction_no_delete BEFORE DELETE ON extraction_run
BEGIN SELECT RAISE(ABORT, 'extraction run is audit history'); END;
CREATE TRIGGER application_sheet_insert BEFORE INSERT ON application_sheet
WHEN EXISTS (SELECT 1 FROM extraction_run WHERE application_id=NEW.application_id)
BEGIN SELECT RAISE(ABORT, 'executed application sheet bindings are sealed'); END;
CREATE TRIGGER application_sheet_update BEFORE UPDATE ON application_sheet
WHEN EXISTS (SELECT 1 FROM extraction_run WHERE application_id=NEW.application_id)
  OR EXISTS (SELECT 1 FROM extraction_run WHERE application_id=OLD.application_id)
BEGIN SELECT RAISE(ABORT, 'executed application sheet bindings are sealed'); END;
CREATE TRIGGER application_sheet_delete BEFORE DELETE ON application_sheet
WHEN EXISTS (SELECT 1 FROM extraction_run WHERE application_id=OLD.application_id)
BEGIN SELECT RAISE(ABORT, 'executed application sheet bindings are sealed'); END;
CREATE TRIGGER extracted_series_running_insert BEFORE INSERT ON extracted_series
WHEN NOT EXISTS (SELECT 1 FROM extraction_run WHERE run_id=NEW.run_id AND status='running')
BEGIN SELECT RAISE(ABORT, 'extraction output requires a running job'); END;
CREATE TRIGGER series_region_running_insert BEFORE INSERT ON series_region
WHEN NOT EXISTS (SELECT 1 FROM extracted_series s JOIN extraction_run r USING (run_id) WHERE s.series_id=NEW.series_id AND r.status='running')
BEGIN SELECT RAISE(ABORT, 'extraction output requires a running job'); END;
CREATE TRIGGER extracted_item_running_insert BEFORE INSERT ON extracted_item
WHEN NOT EXISTS (SELECT 1 FROM extracted_series s JOIN extraction_run r USING (run_id) WHERE s.series_id=NEW.series_id AND r.status='running')
BEGIN SELECT RAISE(ABORT, 'extraction output requires a running job'); END;
CREATE TRIGGER item_region_running_insert BEFORE INSERT ON item_region
WHEN NOT EXISTS (SELECT 1 FROM extracted_item i JOIN extracted_series s USING (series_id) JOIN extraction_run r USING (run_id) WHERE i.item_id=NEW.item_id AND r.status='running')
BEGIN SELECT RAISE(ABORT, 'extraction output requires a running job'); END;
CREATE TRIGGER build_starts_queued BEFORE INSERT ON build_run
WHEN NEW.status<>'queued'
BEGIN SELECT RAISE(ABORT, 'new build must start queued'); END;
CREATE TRIGGER build_state_transition BEFORE UPDATE ON build_run BEGIN
    SELECT RAISE(ABORT, 'invalid build state transition') WHERE NOT (
        (OLD.status='queued' AND NEW.status IN ('running','failed','cancelled')) OR
        (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled')));
    SELECT RAISE(ABORT, 'build manifest is immutable') WHERE
        NEW.build_id IS NOT OLD.build_id OR NEW.integration_version_id IS NOT OLD.integration_version_id OR
        NEW.input_fingerprint IS NOT OLD.input_fingerprint OR NEW.input_manifest_json IS NOT OLD.input_manifest_json;
    SELECT RAISE(ABORT, 'successful build requires a dataset artifact') WHERE NEW.status='succeeded'
        AND NOT EXISTS (SELECT 1 FROM artifact WHERE artifact_id=NEW.output_artifact_id AND kind='dataset');
END;
CREATE TRIGGER build_no_delete BEFORE DELETE ON build_run
BEGIN SELECT RAISE(ABORT, 'build run is audit history'); END;
CREATE TRIGGER build_input_pin BEFORE INSERT ON build_input BEGIN
    SELECT RAISE(ABORT, 'build inputs require a queued build') WHERE NOT EXISTS (
        SELECT 1 FROM build_run WHERE build_id=NEW.build_id AND status='queued');
    SELECT RAISE(ABORT, 'build input requires a successful extraction') WHERE NOT EXISTS (
        SELECT 1 FROM extraction_run WHERE run_id=NEW.run_id AND status='succeeded');
END;
CREATE TRIGGER build_lineage_running BEFORE INSERT ON build_lineage
WHEN NOT EXISTS (SELECT 1 FROM build_run WHERE build_id=NEW.build_id AND status='running')
BEGIN SELECT RAISE(ABORT, 'build lineage requires a running build'); END;

-- parent_of의 방향은 부모→자식. 다른 관계는 계층 레벨에 얽매이지 않는다.
CREATE TRIGGER hierarchy_level BEFORE INSERT ON domain_edge
WHEN NEW.relation_type='parent_of' BEGIN
    SELECT RAISE(ABORT, 'hierarchy must advance exactly one level') WHERE
        (SELECT level FROM domain_concept WHERE kg_revision_id=NEW.kg_revision_id AND concept_id=NEW.to_concept_id)
        <> (SELECT level+1 FROM domain_concept WHERE kg_revision_id=NEW.kg_revision_id AND concept_id=NEW.from_concept_id);
END;
CREATE TRIGGER integration_field_sealed BEFORE INSERT ON integration_field
WHEN EXISTS (SELECT 1 FROM build_run WHERE integration_version_id=NEW.integration_version_id)
BEGIN SELECT RAISE(ABORT, 'built integration version is sealed'); END;
CREATE TRIGGER integration_source_sealed BEFORE INSERT ON integration_source
WHEN EXISTS (SELECT 1 FROM build_run WHERE integration_version_id=NEW.integration_version_id)
BEGIN SELECT RAISE(ABORT, 'built integration sources are sealed'); END;
CREATE TRIGGER integration_source_no_update BEFORE UPDATE ON integration_source
BEGIN SELECT RAISE(ABORT, 'integration_source is immutable'); END;
CREATE TRIGGER integration_source_no_delete BEFORE DELETE ON integration_source
BEGIN SELECT RAISE(ABORT, 'integration_source is immutable'); END;
