-- Fixed Domain KG 기반 Excel 통합 시스템 — 논리 스키마 (설계서 v0.1 §13)
-- 4개 영역: Domain / Document Tree / Semantic Mapping / Integration·Transformation
PRAGMA foreign_keys = ON;

-- ============================================================ §13.1 Domain --
CREATE TABLE IF NOT EXISTS domain_concept (
    concept_id     TEXT PRIMARY KEY,          -- CONCEPT-00125
    canonical_name TEXT NOT NULL,
    canonical_name_en TEXT,
    description    TEXT,                      -- 도메인 정의
    concept_type   TEXT,                      -- process_parameter/quality_metric/...
    data_type      TEXT,                      -- numeric/text/category/datetime/flag
    domain_level   TEXT,                      -- L1/L2/L3
    canonical_unit TEXT,
    unit_dimension TEXT,
    status         TEXT NOT NULL DEFAULT 'ACTIVE'   -- ACTIVE/DEPRECATED
);

CREATE TABLE IF NOT EXISTS domain_relation (
    source_concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    target_concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    relation_type     TEXT NOT NULL,          -- IS_A/PART_OF/AFFECTS/MEASURED_BY/RELATED_TO
    PRIMARY KEY (source_concept_id, target_concept_id, relation_type)
);

CREATE TABLE IF NOT EXISTS domain_alias (
    concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    alias_text TEXT NOT NULL,
    alias_norm TEXT NOT NULL,                 -- normalize_label() 결과 (검색 키)
    PRIMARY KEY (concept_id, alias_norm)
);
CREATE INDEX IF NOT EXISTS idx_alias_norm ON domain_alias(alias_norm);

-- 단위 기준은 units.yaml(UnitRegistry)이 원본이며, 조회 편의를 위해 미러링한다
CREATE TABLE IF NOT EXISTS unit (
    symbol     TEXT PRIMARY KEY,
    dimension  TEXT NOT NULL,
    factor     REAL NOT NULL DEFAULT 1.0,     -- base = value*factor + offset
    offset     REAL NOT NULL DEFAULT 0.0
);

-- ===================================================== §13.2 Document Tree --
CREATE TABLE IF NOT EXISTS document (
    document_id     TEXT PRIMARY KEY,         -- 논리 문서 ID (파일명 기반)
    filename        TEXT NOT NULL,
    filepath        TEXT,
    file_type       TEXT DEFAULT 'xlsx',
    current_version TEXT
);

CREATE TABLE IF NOT EXISTS document_version (
    version_id  TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document(document_id),
    file_hash   TEXT NOT NULL,
    parser_version TEXT,
    parsed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docver_doc ON document_version(document_id);

-- Tree Node — node_id는 (document, tree_path) 기반의 안정적 식별자.
-- 같은 경로가 버전 간 유지되면 같은 node이며 mapping이 승계된다 (§12.1).
CREATE TABLE IF NOT EXISTS tree_node (
    node_id        TEXT PRIMARY KEY,
    document_id    TEXT NOT NULL REFERENCES document(document_id),
    parent_node_id TEXT REFERENCES tree_node(node_id),
    node_type      TEXT NOT NULL,   -- DOCUMENT/SHEET/TABLE/HEADER/SUB_HEADER/VALUE_SET/IMAGE/CHART
    node_name      TEXT NOT NULL,
    tree_path      TEXT NOT NULL,   -- document / sheet / table#n / header path (안정 경로)
    locator        TEXT,            -- sheet!A1:B10 등 원본 위치
    data_type      TEXT,            -- 관찰된 값 타입 (numeric/text/mixed/...)
    unit           TEXT,            -- 관찰/추론 단위 (원본 표기)
    semantic_fingerprint TEXT NOT NULL,  -- 의미 지문: 이름/경로/단위/타입/대표값
    content_fingerprint  TEXT NOT NULL,  -- 내용 지문: 값 전체 포함
    representative_values TEXT,     -- JSON 배열 (대표값 ≤4)
    metadata       TEXT,            -- JSON: 병합/스타일/인접헤더/row_keys 등
    status         TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE/REMOVED
    created_version_id TEXT REFERENCES document_version(version_id),
    removed_version_id TEXT REFERENCES document_version(version_id)
);
CREATE INDEX IF NOT EXISTS idx_node_doc ON tree_node(document_id, status);
CREATE INDEX IF NOT EXISTS idx_node_parent ON tree_node(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_node_path ON tree_node(tree_path);

-- 값 Payload — 그래프/트리 밖 관계형 저장 (§6.3 "그래프와 값 저장의 분리")
CREATE TABLE IF NOT EXISTS data_payload (
    payload_id   TEXT PRIMARY KEY,
    tree_node_id TEXT NOT NULL REFERENCES tree_node(node_id),
    version_id   TEXT NOT NULL REFERENCES document_version(version_id),
    row_count    INTEGER NOT NULL,
    checksum     TEXT NOT NULL,
    is_current   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_payload_node ON data_payload(tree_node_id, is_current);

CREATE TABLE IF NOT EXISTS payload_value (
    payload_id   TEXT NOT NULL REFERENCES data_payload(payload_id),
    row_idx      INTEGER NOT NULL,
    row_key      TEXT,               -- 행 정렬 키 (LOT/시각/인스턴스명 등, 있을 때)
    value_num    REAL,
    value_text   TEXT,
    cell_address TEXT,               -- 원본 셀 주소 (lineage 최말단)
    PRIMARY KEY (payload_id, row_idx)
);

-- =================================================== §13.3 Semantic Mapping --
CREATE TABLE IF NOT EXISTS semantic_mapping (
    mapping_id   TEXT PRIMARY KEY,
    tree_node_id TEXT NOT NULL REFERENCES tree_node(node_id),
    concept_id   TEXT REFERENCES domain_concept(concept_id),  -- NULL = UNMAPPED
    confidence   REAL NOT NULL DEFAULT 0.0,
    method       TEXT,               -- alias_exact/lexical/rule/llm 등 판단 방법
    status       TEXT NOT NULL,      -- AUTO_APPROVED/REVIEW_REQUIRED/APPROVED/REJECTED/UNMAPPED
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    deactivated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_map_node ON semantic_mapping(tree_node_id, is_active);
CREATE INDEX IF NOT EXISTS idx_map_concept ON semantic_mapping(concept_id, is_active);

CREATE TABLE IF NOT EXISTS mapping_evidence (
    mapping_id     TEXT PRIMARY KEY REFERENCES semantic_mapping(mapping_id),
    context_json   TEXT NOT NULL,    -- §7.2 입력 Context 스냅샷
    candidates_json TEXT NOT NULL,   -- Top-K 후보와 점수
    reason         TEXT              -- 판정 근거 서술
);

CREATE TABLE IF NOT EXISTS review_history (
    review_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id TEXT NOT NULL REFERENCES semantic_mapping(mapping_id),
    action     TEXT NOT NULL,        -- APPROVE/REJECT/REMAP/DEACTIVATE
    reviewer   TEXT,
    note       TEXT,
    at         TEXT NOT NULL
);

-- ===================================== §13.4 Integration / Transformation --
CREATE TABLE IF NOT EXISTS integration_project (
    integration_id TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1,
    config_json    TEXT NOT NULL,    -- 프로젝트 정의 원본 (재현성)
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_field (
    field_id       TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integration_project(integration_id),
    field_name     TEXT NOT NULL,
    concept_id     TEXT REFERENCES domain_concept(concept_id),
    target_type    TEXT,             -- numeric/text/...
    target_unit    TEXT
);

CREATE TABLE IF NOT EXISTS source_selection (
    field_id     TEXT NOT NULL REFERENCES integration_field(field_id),
    tree_node_id TEXT NOT NULL REFERENCES tree_node(node_id),
    enabled      INTEGER NOT NULL DEFAULT 1,
    options      TEXT,               -- JSON (우선순위 등)
    PRIMARY KEY (field_id, tree_node_id)
);

CREATE TABLE IF NOT EXISTS transformation_node (
    node_id        TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integration_project(integration_id),
    operation_type TEXT NOT NULL,    -- select/rename/type_cast/unit_convert/filter/
                                     -- value_mapping/null_handling/deduplicate/join/
                                     -- union/aggregate/derived_column/validation
    config         TEXT NOT NULL     -- JSON
);

CREATE TABLE IF NOT EXISTS transformation_edge (
    integration_id TEXT NOT NULL REFERENCES integration_project(integration_id),
    from_node_id   TEXT NOT NULL REFERENCES transformation_node(node_id),
    to_node_id     TEXT NOT NULL REFERENCES transformation_node(node_id),
    PRIMARY KEY (integration_id, from_node_id, to_node_id)
);

CREATE TABLE IF NOT EXISTS build_run (
    build_id       TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integration_project(integration_id),
    status         TEXT NOT NULL,    -- SUCCESS/FAILED
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    output_db      TEXT,             -- 산출 Custom RDBMS 파일 경로
    output_table   TEXT,
    row_count      INTEGER,
    log            TEXT
);

CREATE TABLE IF NOT EXISTS lineage_edge (
    build_id       TEXT NOT NULL REFERENCES build_run(build_id),
    output_row_id  INTEGER NOT NULL, -- 산출 테이블의 _row_id
    output_field   TEXT NOT NULL,
    payload_id     TEXT REFERENCES data_payload(payload_id),
    row_idx        INTEGER,          -- payload_value 행
    tree_node_id   TEXT REFERENCES tree_node(node_id),
    transform_path TEXT,             -- JSON: 거쳐온 transformation node 목록
    PRIMARY KEY (build_id, output_row_id, output_field)
);

-- ==================================================== KG2: DKG 멤버십 델타 --
-- DKG(=L1 root concept)의 '사람 델타'만 저장한다. AUTO 멤버십은 승인 매핑에서
-- 파생되며(kg/groups.py) 여기 저장되지 않는다.
-- 최종 멤버 = 파생 ∪ INCLUDED − EXCLUDED. EXCLUDED는 파생 부활을 막는 tombstone.
CREATE TABLE IF NOT EXISTS document_group_member (
    root_concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    document_id     TEXT NOT NULL REFERENCES document(document_id),
    state           TEXT NOT NULL CHECK (state IN ('INCLUDED','EXCLUDED')),
    created_at      TEXT NOT NULL,
    PRIMARY KEY (root_concept_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_dgm_doc ON document_group_member(document_id);

-- ================================================== KG2: Extraction Recipe --
-- 그룹(=L1 root)당 ACTIVE 1개(부분 유니크 인덱스로 강제). spec_json은 불변
-- 스냅샷 — 새 스냅샷/롤백은 기존 ACTIVE를 ARCHIVED로 내리고 새 행을 INSERT하는
-- append-only 선형 이력이다.
CREATE TABLE IF NOT EXISTS extraction_recipe (
    recipe_id       TEXT PRIMARY KEY,               -- RCP-12hex
    root_concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    status          TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE/ARCHIVED
    spec_json       TEXT NOT NULL,
    note            TEXT,
    created_at      TEXT NOT NULL,
    created_by      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_active
    ON extraction_recipe(root_concept_id) WHERE status='ACTIVE';

-- ==================================================== KG2: Recrawl Run -----
-- 재크롤링 실행 기록 — 백그라운드 실행 + UI 폴링 + 기동 시 복구의 근거.
CREATE TABLE IF NOT EXISTS recrawl_run (
    run_id          TEXT PRIMARY KEY,               -- RCL-12hex
    root_concept_id TEXT NOT NULL REFERENCES domain_concept(concept_id),
    recipe_id       TEXT REFERENCES extraction_recipe(recipe_id),
    mode            TEXT NOT NULL,                  -- fill/reset_auto
    status          TEXT NOT NULL,                  -- RUNNING/SUCCESS/PARTIAL/FAILED
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    summary_json    TEXT                            -- 문서별 진행/결과 JSON 배열
);
CREATE INDEX IF NOT EXISTS idx_recrawl_root ON recrawl_run(root_concept_id, started_at);
