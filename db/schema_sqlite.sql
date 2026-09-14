-- data_gathering 코어 스키마(계약 docs/design/contracts.md §1). schema_meta.version = 3(스키마 리비전).
-- ID는 애플리케이션이 만드는 UUID 문자열, 시각은 ISO-8601 UTC 문자열, JSON 컬럼은 json_valid CHECK.
-- snapshot 바인딩(§1.9): 자식 테이블마다 snapshot_id를 비정규화하고 복합 FK로 부모와 같은 snapshot임을 강제한다.
-- 런타임 테이블(runtime_job·snapshot_signature)은 schema/db.py가 만든다(§1.6).
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY CHECK (version = 3),
    description TEXT NOT NULL
);
INSERT INTO schema_meta VALUES (3, 'Parsing Schema / Parsing Profile runtime; schema revision 3; one database per workspace');

-- §1.1 문서. document ↔ document_snapshot은 상호 참조라 current_snapshot_id FK는 지연 검사한다.
CREATE TABLE document (
    document_id TEXT PRIMARY KEY NOT NULL,
    document_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    current_snapshot_id TEXT,
    status TEXT NOT NULL DEFAULT 'not_extracted'
        CHECK (status IN ('not_extracted','locked','unmatched','review','changed','failed','normal')),
    status_detail_json TEXT CHECK (status_detail_json IS NULL OR json_valid(status_detail_json)),
    last_processed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, source_path),
    FOREIGN KEY (document_id, current_snapshot_id)
        REFERENCES document_snapshot(document_id, snapshot_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX document_by_status_name ON document(status, document_name);
CREATE INDEX document_by_status_updated ON document(status, updated_at DESC);
CREATE INDEX document_current_snapshot ON document(current_snapshot_id);
-- 문서 목록 정렬·keyset(§6 sort): 기본 정렬은 coalesce(last_processed_at,'') 식 인덱스, 이름·상태 정렬은 (열, document_id).
CREATE INDEX document_by_processed ON document(coalesce(last_processed_at,'') DESC, document_id DESC);
CREATE INDEX document_by_name ON document(document_name, document_id);
CREATE INDEX document_by_status ON document(status, document_id);

CREATE TABLE document_snapshot (
    snapshot_id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES document,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    change_token TEXT NOT NULL,
    content_sha256 TEXT,
    ciphertext_sha256 TEXT,
    provider_version TEXT,
    dvc_rev TEXT,
    author TEXT,
    authored_at TEXT,
    filename TEXT NOT NULL,
    byte_size INTEGER,
    excel_date_system TEXT,
    captured_at TEXT NOT NULL,
    CHECK (content_sha256 IS NOT NULL OR provider_version IS NOT NULL OR ciphertext_sha256 IS NOT NULL),
    UNIQUE (document_id, revision_no),
    UNIQUE (document_id, snapshot_id)
);
CREATE INDEX snapshot_by_document_revision ON document_snapshot(document_id, revision_no DESC);
CREATE INDEX snapshot_by_document_token ON document_snapshot(document_id, change_token);

CREATE TABLE sheet (
    sheet_id TEXT PRIMARY KEY NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES document_snapshot,
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
    region_id TEXT PRIMARY KEY NOT NULL,
    snapshot_id TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cells','image','chart','shape','text')),
    locator_key TEXT NOT NULL,
    r1 INTEGER,
    c1 INTEGER,
    r2 INTEGER,
    c2 INTEGER,
    geometry_json TEXT CHECK (geometry_json IS NULL OR json_valid(geometry_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id),
    UNIQUE (sheet_id, kind, locator_key),
    UNIQUE (region_id, snapshot_id)
);
CREATE INDEX region_by_sheet_position ON source_region(sheet_id, r1, c1);

-- §1.2 Parsing Schema. 정의 파일이 진실이고 이 테이블들은 projection이다(삭제 대신 deprecated).
CREATE TABLE parsing_schema (
    schema_id TEXT PRIMARY KEY NOT NULL,
    schema_key TEXT NOT NULL UNIQUE,
    schema_name TEXT NOT NULL UNIQUE,
    description TEXT,
    definition_path TEXT,
    current_rev INTEGER NOT NULL DEFAULT 0,
    definition_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE parsing_field (
    field_id TEXT PRIMARY KEY NOT NULL,
    schema_id TEXT NOT NULL REFERENCES parsing_schema,
    field_key TEXT NOT NULL,
    field_name TEXT NOT NULL,
    description TEXT,
    field_level INTEGER CHECK (field_level IS NULL OR field_level > 0),
    value_type TEXT NOT NULL CHECK (value_type IN ('text','decimal','boolean','date','datetime','group')),
    canonical_unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (schema_id, field_key)
);
CREATE INDEX field_by_schema_status ON parsing_field(schema_id, status, ordinal);

CREATE TABLE parsing_alias (
    alias_id TEXT PRIMARY KEY NOT NULL,
    field_id TEXT NOT NULL REFERENCES parsing_field,
    alias_text TEXT NOT NULL,
    alias_norm TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    UNIQUE (field_id, alias_norm, context_key)
);
CREATE INDEX alias_by_norm ON parsing_alias(alias_norm);

CREATE TABLE parsing_field_edge (
    edge_id TEXT PRIMARY KEY NOT NULL,
    schema_id TEXT NOT NULL REFERENCES parsing_schema,
    from_field_id TEXT NOT NULL REFERENCES parsing_field,
    to_field_id TEXT NOT NULL REFERENCES parsing_field,
    relation TEXT NOT NULL CHECK (relation IN ('parent_of','related_to')),
    ordinal INTEGER,
    UNIQUE (schema_id, from_field_id, to_field_id, relation),
    CHECK (from_field_id <> to_field_id)
);
CREATE INDEX edge_by_from ON parsing_field_edge(from_field_id);
CREATE INDEX edge_by_to ON parsing_field_edge(to_field_id);

-- §1.3 Parsing Profile. reference_application_id는 parsing_application과 상호 참조(SQLite는 선언 순서 무관).
CREATE TABLE parsing_profile (
    profile_id TEXT PRIMARY KEY NOT NULL,
    profile_name TEXT NOT NULL UNIQUE,
    description TEXT,
    schema_id TEXT NOT NULL REFERENCES parsing_schema,
    definition_path TEXT,
    current_rev INTEGER NOT NULL DEFAULT 0,
    definition_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','deprecated')),
    reference_application_id TEXT REFERENCES parsing_application,
    reference_profile_rev INTEGER,
    reference_signature TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX profile_by_schema ON parsing_profile(schema_id);
CREATE INDEX profile_by_reference ON parsing_profile(reference_application_id);

CREATE TABLE parsing_rule (
    rule_id TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES parsing_profile,
    rule_key TEXT NOT NULL,
    rule_name TEXT,
    default_field_id TEXT REFERENCES parsing_field,
    ordinal INTEGER NOT NULL,
    selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
    value_spec_json TEXT NOT NULL CHECK (json_valid(value_spec_json)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
    created_at TEXT NOT NULL,
    UNIQUE (profile_id, rule_key)
);
CREATE INDEX rule_by_field ON parsing_rule(default_field_id);

-- §1.4 Application / Mapping. published_run_id FK는 extraction_run과 상호 참조(SQLite는 선언 순서 무관).
CREATE TABLE parsing_application (
    application_id TEXT PRIMARY KEY NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES document_snapshot,
    profile_id TEXT NOT NULL REFERENCES parsing_profile,
    schema_id TEXT NOT NULL REFERENCES parsing_schema,
    scope_key TEXT NOT NULL DEFAULT 'default',
    profile_rev INTEGER NOT NULL,
    schema_rev INTEGER NOT NULL,
    published_run_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('auto','manual','inherited')),
    match_signature TEXT NOT NULL,
    match_signature_json TEXT CHECK (match_signature_json IS NULL OR json_valid(match_signature_json)),
    compatibility TEXT NOT NULL CHECK (compatibility IN ('identical','compatible','manual')),
    created_at TEXT NOT NULL,
    UNIQUE (snapshot_id, profile_id, scope_key),
    UNIQUE (application_id, snapshot_id),
    FOREIGN KEY (published_run_id, application_id) REFERENCES extraction_run(run_id, application_id)
);
CREATE INDEX application_by_snapshot_profile ON parsing_application(snapshot_id, profile_id);
CREATE INDEX application_by_profile ON parsing_application(profile_id);
CREATE INDEX application_by_schema ON parsing_application(schema_id);
CREATE INDEX application_by_published_run ON parsing_application(published_run_id);

CREATE TABLE application_sheet (
    application_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sheet_id TEXT NOT NULL,
    PRIMARY KEY (application_id, role_key, ordinal),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id),
    FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id)
);
CREATE INDEX application_sheet_by_sheet ON application_sheet(sheet_id);

-- 헤드(current_revision_id)는 항상 마지막 리비전이며 edit_seq = 헤드의 revision_no. 트리거 mapping_edit_seq_*가 유일한 갱신 경로다.
CREATE TABLE mapping (
    mapping_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    rule_id TEXT NOT NULL REFERENCES parsing_rule,
    current_revision_id TEXT,
    edit_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (application_id, rule_id),
    UNIQUE (mapping_id, snapshot_id),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id),
    FOREIGN KEY (mapping_id, current_revision_id)
        REFERENCES mapping_revision(mapping_id, mapping_revision_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX mapping_by_rule ON mapping(rule_id);
CREATE INDEX mapping_by_head ON mapping(current_revision_id);

CREATE TABLE mapping_revision (
    mapping_revision_id TEXT PRIMARY KEY NOT NULL,
    mapping_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    snapshot_id TEXT NOT NULL,
    field_id TEXT REFERENCES parsing_field,
    observed_key TEXT,
    effective_spec_json TEXT NOT NULL CHECK (json_valid(effective_spec_json)),
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
    origin TEXT NOT NULL CHECK (origin IN ('profile','inherited','manual','import','auto')),
    evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
    created_by TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    CHECK (status <> 'approved' OR field_id IS NOT NULL),
    UNIQUE (mapping_id, revision_no),
    UNIQUE (mapping_id, mapping_revision_id),
    UNIQUE (mapping_revision_id, snapshot_id),
    FOREIGN KEY (mapping_id, snapshot_id) REFERENCES mapping(mapping_id, snapshot_id)
);
CREATE INDEX revision_by_mapping ON mapping_revision(mapping_id, revision_no DESC);
CREATE INDEX revision_by_field ON mapping_revision(field_id);

CREATE TABLE mapping_region (
    mapping_revision_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (mapping_revision_id, role, ordinal),
    FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
    FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id)
);
CREATE INDEX mapping_region_by_region ON mapping_region(region_id);

-- §1.5 Extraction. 완료(succeeded/failed/cancelled) 뒤에는 불변이다.
CREATE TABLE extraction_run (
    run_id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    schema_rev INTEGER,
    profile_rev INTEGER,
    engine_version TEXT NOT NULL,
    input_manifest_json TEXT NOT NULL CHECK (json_valid(input_manifest_json)),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    started_at TEXT,
    finished_at TEXT,
    error_summary TEXT,
    auto_approved INTEGER NOT NULL DEFAULT 0,
    UNIQUE (run_id, application_id),
    UNIQUE (run_id, snapshot_id),
    FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id)
);
CREATE INDEX run_by_application_started ON extraction_run(application_id, started_at DESC);

-- 값 출처는 항상 extracted_value_region이다(단일 출처도 행 1개). source_region_id 컬럼은 두지 않는다.
CREATE TABLE extracted_value (
    value_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    mapping_revision_id TEXT NOT NULL,
    field_id TEXT NOT NULL REFERENCES parsing_field,
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
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id, snapshot_id) REFERENCES extraction_run(run_id, snapshot_id),
    FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
    UNIQUE (value_id, snapshot_id)
);
CREATE INDEX value_by_run_field_record ON extracted_value(run_id, field_id, record_key);
CREATE INDEX value_by_revision ON extracted_value(mapping_revision_id);
CREATE INDEX value_by_field ON extracted_value(field_id);
-- 매핑 행 요약(리비전별 첫 값·개수), 필드 최근 값, 단위 충돌 큐가 실행 전체를 훑지 않게 한다.
CREATE INDEX value_by_run_revision ON extracted_value(run_id, mapping_revision_id, group_key, item_index, value_id);
CREATE INDEX value_by_field_created ON extracted_value(field_id, created_at DESC, value_id);
CREATE INDEX value_unit_by_run ON extracted_value(run_id, field_id, unit_normalized) WHERE unit_normalized IS NOT NULL;

CREATE TABLE extracted_value_region (
    value_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key','input')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (value_id, role, ordinal),
    FOREIGN KEY (value_id, snapshot_id) REFERENCES extracted_value(value_id, snapshot_id),
    FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id)
);
CREATE INDEX value_region_by_region ON extracted_value_region(region_id);

-- §1.7 뷰: 현재 snapshot의 발행된 실행 값만. 과거 snapshot/미발행 실행의 값이 섞이지 않는다.
CREATE VIEW current_value AS
SELECT d.document_id, a.application_id, a.profile_id, v.*
FROM extracted_value v
JOIN parsing_application a ON a.published_run_id = v.run_id
JOIN document d ON d.current_snapshot_id = a.snapshot_id;

-- ---------------------------------------------------------------------------
-- 트리거. 메시지는 schema_postgres.sql의 RAISE EXCEPTION과 동일하다.
-- ---------------------------------------------------------------------------

-- §1.2 스키마 트리 규칙. NULL 레벨은 COALESCE로 통과시키지 않는다(둘 다 있어야 parent_of 가능).
CREATE TRIGGER field_edge_level BEFORE INSERT ON parsing_field_edge
WHEN NEW.relation = 'parent_of' BEGIN
    SELECT RAISE(ABORT, 'parent_of requires child level = parent level + 1') WHERE
        (SELECT field_level FROM parsing_field WHERE field_id = NEW.to_field_id) IS NOT
        (SELECT field_level + 1 FROM parsing_field WHERE field_id = NEW.from_field_id)
        OR (SELECT field_level FROM parsing_field WHERE field_id = NEW.from_field_id) IS NULL;
END;
CREATE TRIGGER field_edge_level_update BEFORE UPDATE ON parsing_field_edge
WHEN NEW.relation = 'parent_of' BEGIN
    SELECT RAISE(ABORT, 'parent_of requires child level = parent level + 1') WHERE
        (SELECT field_level FROM parsing_field WHERE field_id = NEW.to_field_id) IS NOT
        (SELECT field_level + 1 FROM parsing_field WHERE field_id = NEW.from_field_id)
        OR (SELECT field_level FROM parsing_field WHERE field_id = NEW.from_field_id) IS NULL;
END;
-- 간선은 같은 스키마의 필드끼리만 잇는다(schema_id 비정규화의 의미를 지킨다).
CREATE TRIGGER field_edge_same_schema BEFORE INSERT ON parsing_field_edge BEGIN
    SELECT RAISE(ABORT, 'edge fields must belong to the edge schema') WHERE
        (SELECT schema_id FROM parsing_field WHERE field_id = NEW.from_field_id) IS NOT NEW.schema_id OR
        (SELECT schema_id FROM parsing_field WHERE field_id = NEW.to_field_id) IS NOT NEW.schema_id;
END;
CREATE TRIGGER field_level_guard BEFORE UPDATE OF field_level ON parsing_field BEGIN
    SELECT RAISE(ABORT, 'field level change breaks a parent_of edge') WHERE EXISTS (
        SELECT 1 FROM parsing_field_edge e JOIN parsing_field child ON child.field_id = e.to_field_id
        WHERE e.relation = 'parent_of' AND e.from_field_id = NEW.field_id
          AND (NEW.field_level IS NULL OR child.field_level IS NOT NEW.field_level + 1))
    OR EXISTS (
        SELECT 1 FROM parsing_field_edge e JOIN parsing_field parent ON parent.field_id = e.from_field_id
        WHERE e.relation = 'parent_of' AND e.to_field_id = NEW.field_id
          AND (NEW.field_level IS NULL OR NEW.field_level IS NOT parent.field_level + 1));
END;

-- group 필드는 값이 추출되지 않으므로 규칙·리비전의 대상이 될 수 없다(서비스 422 GROUP_FIELD_TARGET).
CREATE TRIGGER field_group_not_target_rule BEFORE INSERT ON parsing_rule
WHEN NEW.default_field_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'group field cannot be a mapping target') WHERE EXISTS (
        SELECT 1 FROM parsing_field WHERE field_id = NEW.default_field_id AND value_type = 'group');
END;
CREATE TRIGGER field_group_not_target_rule_update BEFORE UPDATE OF default_field_id ON parsing_rule
WHEN NEW.default_field_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'group field cannot be a mapping target') WHERE EXISTS (
        SELECT 1 FROM parsing_field WHERE field_id = NEW.default_field_id AND value_type = 'group');
END;
CREATE TRIGGER field_group_not_target_revision BEFORE INSERT ON mapping_revision
WHEN NEW.field_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'group field cannot be a mapping target') WHERE EXISTS (
        SELECT 1 FROM parsing_field WHERE field_id = NEW.field_id AND value_type = 'group');
END;
-- 이미 대상이 된 필드를 group으로 바꾸는 우회 경로도 막는다.
CREATE TRIGGER field_group_guard BEFORE UPDATE OF value_type ON parsing_field
WHEN NEW.value_type = 'group' AND OLD.value_type <> 'group' BEGIN
    SELECT RAISE(ABORT, 'group field cannot be a mapping target') WHERE
        EXISTS (SELECT 1 FROM parsing_rule WHERE default_field_id = NEW.field_id) OR
        EXISTS (SELECT 1 FROM mapping_revision WHERE field_id = NEW.field_id);
END;

-- projection 삭제 금지: 정의 파일에서 사라진 항목은 status='deprecated'로만 표시한다.
CREATE TRIGGER parsing_field_no_delete BEFORE DELETE ON parsing_field
BEGIN SELECT RAISE(ABORT, 'parsing_field is a projection; deprecate instead of delete'); END;
CREATE TRIGGER parsing_rule_no_delete BEFORE DELETE ON parsing_rule
BEGIN SELECT RAISE(ABORT, 'parsing_rule is a projection; deprecate instead of delete'); END;

-- §1.4 CAS: 리비전 번호는 mapping.edit_seq + 1이어야 하고, 삽입되면 헤드와 edit_seq가 그 리비전으로 이동한다.
CREATE TRIGGER mapping_edit_seq BEFORE INSERT ON mapping_revision BEGIN
    SELECT RAISE(ABORT, 'mapping edit conflict: revision_no must equal edit_seq + 1') WHERE
        NEW.revision_no IS NOT (SELECT edit_seq + 1 FROM mapping WHERE mapping_id = NEW.mapping_id);
END;
CREATE TRIGGER mapping_edit_seq_advance AFTER INSERT ON mapping_revision BEGIN
    UPDATE mapping SET edit_seq = NEW.revision_no, current_revision_id = NEW.mapping_revision_id
    WHERE mapping_id = NEW.mapping_id;
END;
-- 헤드의 직접 갱신 거부: edit_seq는 1씩만 오르고 헤드는 revision_no = edit_seq인 이 mapping의 리비전이어야 한다.
CREATE TRIGGER mapping_head_guard BEFORE UPDATE OF edit_seq, current_revision_id ON mapping BEGIN
    SELECT RAISE(ABORT, 'mapping head can only advance through a new revision') WHERE
        NEW.edit_seq <> OLD.edit_seq + 1 OR NOT EXISTS (
            SELECT 1 FROM mapping_revision
            WHERE mapping_revision_id = NEW.current_revision_id AND mapping_id = NEW.mapping_id
              AND revision_no = NEW.edit_seq);
END;
CREATE TRIGGER mapping_identity BEFORE UPDATE ON mapping BEGIN
    SELECT RAISE(ABORT, 'mapping identity is immutable') WHERE
        NEW.mapping_id IS NOT OLD.mapping_id OR NEW.application_id IS NOT OLD.application_id OR
        NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.rule_id IS NOT OLD.rule_id OR
        NEW.created_at IS NOT OLD.created_at;
END;
-- 헤드가 바뀌면 발행이 무효가 된다(재추출 필요).
CREATE TRIGGER mapping_head_invalidates AFTER UPDATE OF current_revision_id ON mapping BEGIN
    UPDATE parsing_application SET published_run_id = NULL WHERE application_id = NEW.application_id;
END;

-- 발행 조건: 소유한 succeeded 실행, manifest의 {mapping_id, revision_id} 집합 = 헤드 집합, NULL 헤드 없음, 헤드 전부 approved.
CREATE TRIGGER publish_run BEFORE UPDATE OF published_run_id ON parsing_application
WHEN NEW.published_run_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'only a successful owned run can be published') WHERE NOT EXISTS (
        SELECT 1 FROM extraction_run
        WHERE run_id = NEW.published_run_id AND application_id = NEW.application_id AND status = 'succeeded');
    SELECT RAISE(ABORT, 'every mapping needs a head revision') WHERE EXISTS (
        SELECT 1 FROM mapping WHERE application_id = NEW.application_id AND current_revision_id IS NULL);
    SELECT RAISE(ABORT, 'run inputs differ from current mapping heads') WHERE
        EXISTS (SELECT mapping_id, current_revision_id FROM mapping WHERE application_id = NEW.application_id
                EXCEPT SELECT j.key, json_extract(j.value, '$.revision_id')
                       FROM extraction_run r, json_each(r.input_manifest_json, '$.mappings') AS j
                       WHERE r.run_id = NEW.published_run_id) OR
        EXISTS (SELECT j.key, json_extract(j.value, '$.revision_id')
                FROM extraction_run r, json_each(r.input_manifest_json, '$.mappings') AS j
                WHERE r.run_id = NEW.published_run_id
                EXCEPT SELECT mapping_id, current_revision_id FROM mapping WHERE application_id = NEW.application_id);
    SELECT RAISE(ABORT, 'every mapping head must be approved') WHERE EXISTS (
        SELECT 1 FROM mapping m JOIN mapping_revision v ON v.mapping_revision_id = m.current_revision_id
        WHERE m.application_id = NEW.application_id AND v.status <> 'approved');
END;
CREATE TRIGGER application_starts_unpublished BEFORE INSERT ON parsing_application
WHEN NEW.published_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'new application must start unpublished'); END;
CREATE TRIGGER application_identity BEFORE UPDATE ON parsing_application BEGIN
    SELECT RAISE(ABORT, 'application identity is immutable') WHERE
        NEW.application_id IS NOT OLD.application_id OR NEW.snapshot_id IS NOT OLD.snapshot_id OR
        NEW.profile_id IS NOT OLD.profile_id OR NEW.schema_id IS NOT OLD.schema_id OR
        NEW.scope_key IS NOT OLD.scope_key OR NEW.profile_rev IS NOT OLD.profile_rev OR
        NEW.schema_rev IS NOT OLD.schema_rev;
END;

-- §1.5 실행 상태: queued→running→(succeeded|failed|cancelled). 대기 중 취소/실패는 허용, 완료 뒤에는 불변.
CREATE TRIGGER extraction_run_no_update BEFORE UPDATE ON extraction_run
WHEN OLD.status IN ('succeeded','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'extraction_run is immutable after completion'); END;
CREATE TRIGGER extraction_run_no_delete BEFORE DELETE ON extraction_run
WHEN OLD.status IN ('succeeded','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'extraction_run is immutable after completion'); END;
CREATE TRIGGER run_state_transition BEFORE UPDATE ON extraction_run
WHEN OLD.status IN ('queued','running') BEGIN
    SELECT RAISE(ABORT, 'invalid extraction state transition') WHERE NOT (
        NEW.status = OLD.status OR
        (OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
        (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','cancelled')));
    SELECT RAISE(ABORT, 'run identity and manifest are immutable') WHERE
        NEW.run_id IS NOT OLD.run_id OR NEW.application_id IS NOT OLD.application_id OR
        NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.schema_rev IS NOT OLD.schema_rev OR
        NEW.profile_rev IS NOT OLD.profile_rev OR NEW.engine_version IS NOT OLD.engine_version OR
        NEW.input_manifest_json IS NOT OLD.input_manifest_json OR NEW.auto_approved IS NOT OLD.auto_approved;
END;

-- 불변 테이블: INSERT만 허용한다. 수정/철회는 새 snapshot·새 리비전·새 실행으로 표현한다.
CREATE TRIGGER document_snapshot_no_update BEFORE UPDATE ON document_snapshot
BEGIN SELECT RAISE(ABORT, 'document_snapshot is immutable'); END;
CREATE TRIGGER document_snapshot_no_delete BEFORE DELETE ON document_snapshot
BEGIN SELECT RAISE(ABORT, 'document_snapshot is immutable'); END;
CREATE TRIGGER sheet_no_update BEFORE UPDATE ON sheet
BEGIN SELECT RAISE(ABORT, 'sheet is immutable'); END;
CREATE TRIGGER sheet_no_delete BEFORE DELETE ON sheet
BEGIN SELECT RAISE(ABORT, 'sheet is immutable'); END;
CREATE TRIGGER source_region_no_update BEFORE UPDATE ON source_region
BEGIN SELECT RAISE(ABORT, 'source_region is immutable'); END;
CREATE TRIGGER source_region_no_delete BEFORE DELETE ON source_region
BEGIN SELECT RAISE(ABORT, 'source_region is immutable'); END;
CREATE TRIGGER mapping_revision_no_update BEFORE UPDATE ON mapping_revision
BEGIN SELECT RAISE(ABORT, 'mapping_revision is immutable'); END;
CREATE TRIGGER mapping_revision_no_delete BEFORE DELETE ON mapping_revision
BEGIN SELECT RAISE(ABORT, 'mapping_revision is immutable'); END;
CREATE TRIGGER mapping_region_no_update BEFORE UPDATE ON mapping_region
BEGIN SELECT RAISE(ABORT, 'mapping_region is immutable'); END;
CREATE TRIGGER mapping_region_no_delete BEFORE DELETE ON mapping_region
BEGIN SELECT RAISE(ABORT, 'mapping_region is immutable'); END;
CREATE TRIGGER extracted_value_no_update BEFORE UPDATE ON extracted_value
BEGIN SELECT RAISE(ABORT, 'extracted_value is immutable'); END;
CREATE TRIGGER extracted_value_no_delete BEFORE DELETE ON extracted_value
BEGIN SELECT RAISE(ABORT, 'extracted_value is immutable'); END;
CREATE TRIGGER extracted_value_region_no_update BEFORE UPDATE ON extracted_value_region
BEGIN SELECT RAISE(ABORT, 'extracted_value_region is immutable'); END;
CREATE TRIGGER extracted_value_region_no_delete BEFORE DELETE ON extracted_value_region
BEGIN SELECT RAISE(ABORT, 'extracted_value_region is immutable'); END;
