# v2 아키텍처 다이어그램 — DB 스키마(ERD)와 클래스 다이어그램

v2 런타임(`kg/v2/`, `frontend/src/v2/`)의 구조를 그림으로 정리한다. v1(`kg/`, `kg/schema.sql`)은
[ARCHITECTURE.md](ARCHITECTURE.md)가 담당한다. 원본 근거는 [db/v2/schema_sqlite.sql](../db/v2/schema_sqlite.sql),
[kg/v2/db.py](../kg/v2/db.py)의 런타임 테이블, 각 모듈 소스이며 **스키마나 모듈이 바뀌면 이 문서도 같은 커밋에서 갱신한다**.
(GitHub에서 mermaid가 바로 렌더된다.)

- 설계 근거와 규칙: [design/db-schema-v2.md](design/db-schema-v2.md) · 실행 안내: [design/db-schema-v2-runtime.md](design/db-schema-v2-runtime.md)
- PostgreSQL 이식: [design/db-schema-v2-postgres.md](design/db-schema-v2-postgres.md) · 후속 구현 기록: [design/v2-followup.md](design/v2-followup.md)

---

## 1. DB 스키마 (ERD)

워크스페이스 DB `<ws>/data/kg/v2.db` 하나에 DDL 테이블 32개 + 런타임 테이블 2개(`runtime_job`, `version_signature`는
`kg/v2/db.py`가 `CREATE TABLE IF NOT EXISTS`로 만든다), 트리거 72개(불변성·발행 조건·레벨 규칙), 뷰 1개(`current_extracted_item`)가 산다.
아래 ERD는 DDL을 `PRAGMA table_info`/`foreign_key_list`로 읽어 생성한 것이라 컬럼·PK·FK가 실제와 일치한다
(총 34개 테이블, 영역별로 나눠 그림; 다른 영역의 테이블을 참조하는 FK는 그 영역에 빈 상자로 나타난다).

핵심 규칙(자세한 것은 설계 문서 §4·§6):

- 문서의 정체성은 `document_id`(안정 ID)이고 내용은 `document_version`이다. 해시·이름으로 문서를 병합하지 않는다.
- 규칙은 `template_version`(불변)에, 문서별 수정은 `mapping_revision`(추가 전용, `mapping_head`가 현재 승인본과 `edit_seq` CAS)에 남는다.
- 값은 `extracted_item`(불변)이고 모든 항목은 `item_region`으로 원자 출처(셀/병합 앵커/시트)를 가진다. `series_region`은 선택 영역 단위 출처다.
- 사용자 DB는 `integration_version`(불변 명세) → `build_run`(입력 실행 고정 `build_input`) → 결과 한 칸당 `build_lineage` N행이다.
- KG는 `kg_revision` 단위 스냅샷이며 매핑·추출·빌드는 특정 리비전을 참조한다.

### KG — 사람이 발행하는 불변 스냅샷

```mermaid
erDiagram
    kg_revision {
        TEXT kg_revision_id PK
        INTEGER revision_no
        TEXT content_sha256
        TEXT created_by
        TEXT created_at
    }
    domain_concept {
        TEXT kg_revision_id PK,FK
        TEXT concept_id PK
        TEXT name
        TEXT definition
        INTEGER level
        TEXT value_type
        TEXT canonical_unit
        TEXT status
    }
    domain_alias {
        TEXT kg_revision_id PK,FK
        TEXT concept_id PK,FK
        TEXT alias_norm PK
        TEXT alias_text
        TEXT context_key PK
        TEXT context_json
    }
    domain_edge {
        TEXT kg_revision_id PK,FK
        TEXT from_concept_id PK,FK
        TEXT to_concept_id PK,FK
        TEXT relation_type PK
    }
    kg_revision ||--o{ domain_concept : "kg_revision_id"
    domain_concept ||--o{ domain_alias : "concept_id"
    domain_concept ||--o{ domain_edge : "from_concept_id"
```

### 문서·버전·원본 위치

```mermaid
erDiagram
    document {
        TEXT document_id PK,FK
        TEXT display_name
        TEXT provider
        TEXT source_ref
        TEXT file_type
        TEXT current_version_id FK
        TEXT registered_at
    }
    document_version {
        TEXT document_version_id PK
        TEXT document_id FK
        INTEGER revision_no
        TEXT provider_version_token
        TEXT ciphertext_sha256
        TEXT content_sha256
        TEXT source_artifact_id FK
        TEXT filename
        TEXT author
        TEXT authored_at
        TEXT source_modified_at
        TEXT file_type
        TEXT excel_date_system
        INTEGER byte_size
        TEXT captured_at
    }
    sheet {
        TEXT sheet_id PK
        TEXT document_version_id FK
        TEXT native_sheet_key
        TEXT name
        INTEGER ordinal
        TEXT visibility
        INTEGER estimated_rows
        INTEGER estimated_cols
    }
    source_region {
        TEXT region_id PK
        TEXT document_version_id FK
        TEXT sheet_id FK
        TEXT kind
        TEXT locator_key
        INTEGER r1
        INTEGER c1
        INTEGER r2
        INTEGER c2
        INTEGER merge_anchor_r
        INTEGER merge_anchor_c
        TEXT object_key
        TEXT geometry_json
    }
    artifact {
        TEXT artifact_id PK
        TEXT kind
        TEXT storage_ref
        TEXT sha256
        INTEGER byte_size
        TEXT media_type
        TEXT git_commit
        TEXT dvc_ref_json
        TEXT policy_ref
        TEXT created_at
    }
    access_observation {
        TEXT access_id PK
        TEXT document_version_id FK
        TEXT principal_ref
        TEXT provider
        TEXT policy_revision
        INTEGER can_view
        INTEGER can_extract
        INTEGER can_render_web
        INTEGER can_cache_derivative
        TEXT checked_at
        TEXT expires_at
    }
    render_chunk {
        TEXT sheet_id PK,FK
        TEXT render_profile_key PK
        TEXT access_scope_key PK
        TEXT policy_revision PK
        TEXT layout_revision PK
        TEXT chunk_key PK
        TEXT kind
        TEXT artifact_id FK
        TEXT geometry_json
        TEXT expires_at
    }
    document_version ||--o{ document : "current_version_id"
    artifact ||--o{ document_version : "source_artifact_id"
    document ||--o{ document_version : "document_id"
    document_version ||--o{ sheet : "document_version_id"
    sheet ||--o{ source_region : "sheet_id"
    document_version ||--o{ access_observation : "document_version_id"
    artifact ||--o{ render_chunk : "artifact_id"
    sheet ||--o{ render_chunk : "sheet_id"
```

### 템플릿·적용 건·매핑 리비전

```mermaid
erDiagram
    template {
        TEXT template_id PK
        TEXT name
        TEXT created_by
        TEXT created_at
    }
    template_version {
        TEXT template_version_id PK
        TEXT template_id FK
        INTEGER revision_no
        TEXT kg_revision_id FK
        TEXT format
        TEXT definition_json
        TEXT definition_sha256
        TEXT code_artifact_id FK
        TEXT engine_contract_version
        TEXT environment_json
        TEXT created_by
        TEXT created_at
    }
    template_rule {
        TEXT template_version_id PK,FK
        TEXT rule_key PK
        TEXT kg_revision_id FK
        TEXT concept_id FK
        INTEGER ordinal
        TEXT selector_json
        TEXT record_spec_json
        TEXT value_spec_json
    }
    template_application {
        TEXT application_id PK,FK
        TEXT document_version_id FK
        TEXT template_version_id FK
        TEXT scope_key
        TEXT published_run_id FK
        TEXT created_at
    }
    application_sheet {
        TEXT application_id PK,FK
        TEXT document_version_id FK
        TEXT role_key PK
        INTEGER ordinal PK
        TEXT sheet_id FK
    }
    mapping_revision {
        TEXT mapping_revision_id PK
        TEXT application_id FK
        TEXT document_version_id FK
        TEXT template_version_id FK
        TEXT rule_key FK
        INTEGER revision_no
        TEXT kg_revision_id FK
        TEXT concept_id FK
        TEXT origin
        TEXT status
        TEXT effective_spec_json
        TEXT evidence_json
        TEXT supersedes_id FK
        TEXT created_by
        TEXT reason
        TEXT created_at
    }
    mapping_head {
        TEXT application_id PK,FK
        TEXT rule_key PK,FK
        TEXT mapping_revision_id FK
        INTEGER edit_seq
    }
    artifact ||--o{ template_version : "code_artifact_id"
    kg_revision ||--o{ template_version : "kg_revision_id"
    template ||--o{ template_version : "template_id"
    domain_concept ||--o{ template_rule : "concept_id"
    template_version ||--o{ template_rule : "template_version_id"
    extraction_run ||--o{ template_application : "published_run_id"
    template_version ||--o{ template_application : "template_version_id"
    document_version ||--o{ template_application : "document_version_id"
    sheet ||--o{ application_sheet : "sheet_id"
    template_application ||--o{ application_sheet : "application_id"
    domain_concept ||--o{ mapping_revision : "concept_id"
    template_version ||--o{ mapping_revision : "template_version_id"
    template_rule ||--o{ mapping_revision : "rule_key"
    template_application ||--o{ mapping_revision : "application_id"
    mapping_revision ||--o{ mapping_head : "mapping_revision_id"
```

### 추출 실행·원자 출처

```mermaid
erDiagram
    extraction_run {
        TEXT run_id PK
        TEXT application_id FK
        TEXT document_version_id FK
        TEXT template_version_id FK
        TEXT request_key
        TEXT input_fingerprint
        TEXT engine_version
        TEXT environment_json
        TEXT status
        TEXT created_at
        TEXT finished_at
        TEXT error_summary
    }
    run_mapping {
        TEXT run_id PK,FK
        TEXT application_id FK
        TEXT rule_key PK,FK
        TEXT mapping_revision_id FK
    }
    extracted_series {
        TEXT series_id PK
        TEXT run_id FK
        TEXT mapping_revision_id FK
        TEXT document_version_id FK
        TEXT instance_key
        TEXT record_scope_key
        TEXT observed_key
        TEXT cardinality
        TEXT axis
        TEXT status
    }
    series_region {
        TEXT series_id PK,FK
        TEXT document_version_id FK
        TEXT role PK
        INTEGER ordinal PK
        TEXT region_id FK
    }
    extracted_item {
        TEXT item_id PK
        TEXT series_id FK
        TEXT document_version_id FK
        INTEGER item_index
        TEXT record_key
        INTEGER row_ordinal
        INTEGER col_ordinal
        TEXT raw_type
        TEXT raw_text
        TEXT display_text
        TEXT value_type
        TEXT value_text
        TEXT value_state
        TEXT formula_text
        TEXT formula_state
        TEXT unit_raw
        TEXT unit_normalized
        TEXT source_identity_key
        TEXT derivation_key
    }
    item_region {
        TEXT item_id PK,FK
        TEXT document_version_id FK
        TEXT role PK
        INTEGER ordinal PK
        TEXT region_id FK
    }
    template_application ||--o{ extraction_run : "application_id"
    mapping_revision ||--o{ run_mapping : "mapping_revision_id"
    extraction_run ||--o{ run_mapping : "run_id"
    mapping_revision ||--o{ extracted_series : "mapping_revision_id"
    extraction_run ||--o{ extracted_series : "run_id"
    run_mapping ||--o{ extracted_series : "mapping_revision_id"
    source_region ||--o{ series_region : "region_id"
    extracted_series ||--o{ series_region : "series_id"
    extracted_series ||--o{ extracted_item : "series_id"
    source_region ||--o{ item_region : "region_id"
    extracted_item ||--o{ item_region : "item_id"
```

### 사용자 DB·lineage

```mermaid
erDiagram
    integration_project {
        TEXT project_id PK
        TEXT name
        TEXT created_by
        TEXT created_at
    }
    integration_version {
        TEXT integration_version_id PK
        TEXT project_id FK
        INTEGER revision_no
        TEXT kg_revision_id FK
        TEXT spec_json
        TEXT spec_sha256
        TEXT created_at
    }
    integration_field {
        TEXT integration_version_id PK,FK
        TEXT field_key PK
        TEXT kg_revision_id FK
        TEXT concept_id FK
        TEXT output_name
        INTEGER ordinal
        TEXT target_type
        TEXT target_unit
    }
    integration_source {
        TEXT integration_version_id PK,FK
        TEXT field_key PK,FK
        TEXT application_id PK,FK
        TEXT template_version_id FK
        TEXT rule_key PK,FK
        TEXT pinned_run_id FK
        TEXT options_json
    }
    build_run {
        TEXT build_id PK
        TEXT integration_version_id FK
        TEXT status
        TEXT input_fingerprint
        TEXT input_manifest_json
        TEXT output_artifact_id FK
        TEXT report_artifact_id FK
        INTEGER row_count
        TEXT created_at
        TEXT finished_at
    }
    build_input {
        TEXT build_id PK,FK
        TEXT run_id PK,FK
        TEXT selection_json
    }
    build_lineage {
        TEXT build_id PK,FK
        TEXT integration_version_id FK
        TEXT output_table PK
        TEXT output_row_key PK
        TEXT field_key PK,FK
        INTEGER ordinal PK
        TEXT item_id FK
        TEXT contribution_role
        TEXT transform_path_json
    }
    kg_revision ||--o{ integration_version : "kg_revision_id"
    integration_project ||--o{ integration_version : "project_id"
    domain_concept ||--o{ integration_field : "concept_id"
    integration_version ||--o{ integration_field : "integration_version_id"
    extraction_run ||--o{ integration_source : "pinned_run_id"
    template_rule ||--o{ integration_source : "rule_key"
    template_application ||--o{ integration_source : "application_id"
    integration_field ||--o{ integration_source : "field_key"
    artifact ||--o{ build_run : "output_artifact_id"
    integration_version ||--o{ build_run : "integration_version_id"
    extraction_run ||--o{ build_input : "run_id"
    build_run ||--o{ build_input : "build_id"
    integration_field ||--o{ build_lineage : "field_key"
    build_run ||--o{ build_lineage : "build_id"
    extracted_item ||--o{ build_lineage : "item_id"
```

### 운영·런타임

```mermaid
erDiagram
    schema_meta {
        INTEGER version PK
        TEXT description
    }
    runtime_job {
        TEXT job_id PK
        TEXT kind
        TEXT state
        TEXT principal
        TEXT payload_json
        TEXT result_json
        TEXT error_code
        TEXT error_message
        INTEGER completed
        INTEGER total
        INTEGER cancel_requested
        TEXT request_key
        TEXT request_hash
        TEXT created_at
        TEXT heartbeat_at
        TEXT finished_at
    }
    version_signature {
        TEXT document_version_id PK,FK
        TEXT algorithm
        TEXT signature_json
        TEXT signature_sha256
        TEXT reader_revision
        TEXT computed_at
    }
    document_version ||--o{ version_signature : "document_version_id"
```

### 트리거·뷰 요약

| 종류 | 대상 | 규칙 |
|---|---|---|
| 불변성(`*_immutable`) | `kg_revision`·`domain_*`·`document_version`·`sheet`·`source_region`·`template_version`·`template_rule`·`mapping_revision`·`extraction_run`(완료 후)·`extracted_*`·`*_region`·`build_*` 등 | UPDATE/DELETE 거부 (`... is immutable`) |
| 발행 조건 | `template_application.published_run_id` | 성공한 실행이고 실행이 사용한 매핑이 현재 head와 같을 때만 발행; head가 바뀌면 `published_run_id`를 NULL로 |
| CAS | `mapping_head.edit_seq` | 새 리비전 삽입 시 기대 seq와 일치해야 하며 증가 |
| 계층 | `domain_edge(parent_of)` | 부모→자식 레벨이 정확히 1 증가 (다부모 허용) |
| 뷰 | `current_extracted_item` | 현재 문서 버전의 발행 실행에 속한 항목만 |

---

## 2. 클래스 다이어그램

### 2.1 백엔드 코어 (`kg/v2/`)

```mermaid
classDiagram
    direction LR
    class Problem {
        +code: str
        +message: str
        +status: int
    }
    class Cancelled
    Problem <|-- Cancelled

    class Database {
        +root: Path
        +path: Path  "data/kg/v2.db"
        +connect(write=False) ctx
        -init_schema() "schema_meta==2 검사, 런타임 테이블 생성, FK/WAL/busy_timeout"
    }
    class Jobs {
        +db: Database
        +handler / failure_handler
        +thread, stop, wake: Event
        +volatile: dict  "렌더 캐시(비영속, 8개·60초)"
        +start() / close()
        +submit(kind, payload, principal, request_key, prepare) JobResponse
        +get(jid, principal) / cancel(jid, principal)
        +run_one()  "runtime_job 큐 1워커, heartbeat 30초"
    }
    class Service {
        +db: Database
        +root: Path
        +jobs: Jobs
        +read(provider, principal, operation, payload, checkpoint)  "격리 Reader 프로세스 호출"
        +version(version_id) / authorize(version_id, principal, required) / grant()
        +register(source_ref, provider, principal, document_id) dict
        +import_kg(definition, principal) / import_current_kg()
        +create_template(name, definition, principal)
        +apply_template(version_id, template_version_id, bindings, ...)
        +mapping(mapping_id) / revise(aid, mid, body, principal)
        +prepare_extraction(conn, job_id, payload)
        +handle_job(kind, payload, principal, checkpoint)  "register·viewport·extract·build"
        +fail_job(kind, payload, exc)
    }
    class XlsxReader {
        <<Reader 계약: 운영자 factory로 교체>>
        +authorize(source_ref, required) caps
        +describe(source_ref)  "token·sheets·capabilities·signature"
        +viewport(source_ref, token, sheet, r1, c1, rows, cols)
        +extract(source_ref, token, rules, bindings)  "series→items→verified 이벤트"
        +signature(source_ref, token)  "구조 서명(라벨·병합·시트명)"
    }
    Service *-- Database
    Service *-- Jobs
    Jobs ..> Service : handler
    Service ..> XlsxReader : 별도 프로세스(시간·메모리 제한)

    class extract {
        <<module>>
        +execute_extraction(service, payload, principal, checkpoint)
        +ensure_region(conn, version_id, sheets, region)
    }
    class build {
        <<module>>
        +create_integration(service, name, spec, principal)
        +prepare_build(conn, job_id, payload)  "발행 실행 고정"
        +execute_build(service, payload, principal, checkpoint)  "중복·충돌 검사, lineage N:M"
        +authorize_build() / output_path()
    }
    class features {
        <<module>>
        +document_query(...)  "필터·정렬·keyset"
        +document_summary_query(document_ids)  "페이지 범위 templates/roots"
        +selection_cte(kg, roots, excluded)  "개념 트리 일괄 선택"
        +rollback() / edit_concept() / record_access()
    }
    class graph {
        <<module>>
        +coverage_graph(conn, kg, domain, cap)  "L1 문서군 hull·발행 출처 수"
    }
    class suggest {
        <<module>>
        +store_signature() / similarity() / match_sheets()
        +list_suggestions(service, version_id, threshold, limit)
        +transplant(service, version_id, body, principal)  "항상 proposed"
        +sign_versions()
    }
    class recrawl {
        <<module>>
        +recrawl(service, tid, mode, request_key, principal)  "fill / reset_auto"
        +status_query() / status_summary()
    }
    class normalization {
        <<module>>
        +validate_pipeline() / prepare(value, normal, target) / presets(root)
    }
    class spec {
        <<module>>
        +validate_template() / validate_rule() / typed() / bounds() / address()
    }
    Service ..> extract
    Service ..> build
    Service ..> spec
    extract ..> normalization
    api ..> features
    api ..> graph
    api ..> suggest
    api ..> recrawl
    class api {
        <<FastAPI /api/v2>>
        +install(app, root)
        -listing(sql, params, scope, keys, cursor, limit, descending, enrich)
        -submit(kind, body, user, prepare)  "request_key 멱등"
        -safe_write(fn, ...)
    }
    api *-- Service
    class cli {
        <<python -m kg.v2>>
        serve · watch · migrate · sign · export · age-projection
    }
    class Watcher {
        +service: Service
        +raw / base: Path
        +watcher: FileEventWatcher  "kg/watch.py 재사용"
        +scan() / run(once)
    }
    class Migration {
        +ws / from_ws / raw
        +links: dict  "artifact(policy_ref='v1-migration')"
        +run() report  "kg→documents→templates→assignments"
    }
    class export {
        <<module>>
        +export_build(service, build_id, out, principal)  "manifest + sqlite, DVC 추적 폴더"
    }
    class age_projection {
        <<module>>
        +build_projection(conn, revision, graph) / write_projection()
    }
    cli ..> api
    cli ..> Watcher
    cli ..> Migration
    cli ..> export
    cli ..> age_projection
    Watcher *-- Service
    Migration ..> Service
```

### 2.2 요청/명세 계약 (`kg/v2/contracts.py`, Pydantic)

```mermaid
classDiagram
    class Contract {
        <<BaseModel, extra=forbid>>
    }
    class JobRequest {
        +request_key: str
    }
    class RegisterRequest {
        +provider: str
        +source_refs: list~str~
    }
    class ViewportRequest {
        +version_id, sheet_id
        +r1, c1, rows, cols
    }
    class RecrawlRequest {
        +mode: fill|reset_auto
    }
    Contract <|-- JobRequest
    JobRequest <|-- RegisterRequest
    JobRequest <|-- ViewportRequest
    JobRequest <|-- RecrawlRequest

    class TemplateDefinition {
        +sheet_roles: list~SheetRole~
        +rules: list~RuleSpec~
    }
    class SheetRole {
        +role_key
        +cardinality: one|many
    }
    class RuleSpec {
        +rule_key, concept_id
        +selector: SelectorSpec
        +value_spec: ValueSpec
        +record_spec: RecordSpec
        +normalization: NormalizationSpec
    }
    class SelectorSpec {
        +key / value / unit / context: SelectionSpec
    }
    class SelectionSpec {
        +areas: list~AreaSpec~
        +repeat, combine
    }
    class AreaSpec {
        +sheet_role
        +range | find: FindSpec | relative: RelativeSpec
    }
    class ValueSpec {
        +type: text|decimal|boolean|date|datetime
        +shape, direction, element_layout
        +unit, source_unit
        +stop: StopSpec
    }
    class RecordSpec {
        +scope
        +key: coordinate | physical_row | physical_column | column:A | row:1
    }
    class NormalizationSpec {
        +operation: identity|trim|affine|pipeline
        +steps: list~NormalizationStep~
    }
    TemplateDefinition *-- SheetRole
    TemplateDefinition *-- RuleSpec
    RuleSpec *-- SelectorSpec
    RuleSpec *-- ValueSpec
    RuleSpec *-- RecordSpec
    RuleSpec *-- NormalizationSpec
    SelectorSpec *-- SelectionSpec
    SelectionSpec *-- AreaSpec
    AreaSpec *-- FindSpec
    AreaSpec *-- RelativeSpec
    ValueSpec *-- StopSpec
    NormalizationSpec *-- NormalizationStep
    Contract <|-- TemplateDefinition
    class TemplateRequest {
        +name
        +definition: TemplateDefinition
    }
    class ApplicationRequest {
        +template_version_id
        +sheet_bindings: role→sheet_id[]
        +name
    }
    class RevisionRequest {
        +expected_seq
        +effective_spec, concept_id
        +status: proposed|approved|rejected
        +reason
    }
    class RollbackRequest {
        +expected_seq, target_revision_id, reason
    }
    class FromSuggestionRequest {
        +source_application_id
        +sheet_bindings, name
    }
    Contract <|-- TemplateRequest
    Contract <|-- ApplicationRequest
    Contract <|-- RevisionRequest
    Contract <|-- RollbackRequest
    Contract <|-- FromSuggestionRequest

    class KGRequest {
        +concepts: list~ConceptDefinition~
        +relations
    }
    class ConceptEditRequest {
        +expected_kg_revision_id
        +name, definition, aliases, relations: RelationEdit
        +status
    }
    Contract <|-- KGRequest
    Contract <|-- ConceptEditRequest
    KGRequest *-- ConceptDefinition
    ConceptEditRequest *-- RelationEdit

    class IntegrationRequest {
        +name, project_id
        +spec: IntegrationSpec
    }
    class IntegrationSpec {
        +kg_revision_id
        +row_mode: record_scope|business_key|aggregate
        +fields: list~OutputField~
    }
    class OutputField {
        +field_key, output_name, concept_id
        +target_type, target_unit, aggregate
        +sources: list~SourceSelection~
    }
    class SourceSelection {
        +application_id, rule_key, pinned_run_id
    }
    Contract <|-- IntegrationRequest
    IntegrationRequest *-- IntegrationSpec
    IntegrationSpec *-- OutputField
    OutputField *-- SourceSelection

    class JobResponse {
        +job_id, kind
        +state: queued|running|succeeded|failed|cancelled
        +completed, total, error_code, error_message, result
    }
    class MigrationReport {
        +format, dry_run, counts
        +links: list~MigrationLink~
        +skipped: list~MigrationSkip~
        +re_extract_required: list~ReExtractItem~
    }
    Contract <|-- JobResponse
    Contract <|-- MigrationReport
    MigrationReport *-- MigrationLink
    MigrationReport *-- MigrationSkip
    MigrationReport *-- ReExtractItem
```

### 2.3 프론트엔드 컴포넌트 (`frontend/src/`)

```mermaid
classDiagram
    direction TB
    class App {
        ?v1=1 → Shell(v1, kg.db)
        ?legacy=1 → LegacyViewer
        기본 → Workbench(v2, v2.db)
    }
    class product {
        <<product.ts / product.css>>
        PRODUCT_NAME · PRODUCT_STEPS(1~5 탭) · 색/타이포 토큰
    }
    App ..> product
    class Workbench {
        TaskProvider · NavigationContext(URL 상태) · JobBar
        탭: Documents · Knowledge · Source · Database · Templates
        Heading()
    }
    App --> Workbench
    class client {
        <<client.tsx>>
        api() / download() / downloadFile()
        useData() / usePage() / Pager / State
        useNavigation() / useRoute() / readRoute()
        useTasks() / TaskProvider / JobBar
        useViewport() / useDraft()
        column() / range() / box()
    }
    Workbench ..> client

    class Documents {
        1. 파일 분석
    }
    class DocumentsTable {
        필터 툴바 · 정렬 헤더(name/author/authored_at/template/review)
        열: 파일·작성자·작성일·문서군·템플릿·검수·접근·상태·열어보기
        normalize() / openDocument()
    }
    class DocumentDrawer {
        role=dialog aria-modal · 포커스 트랩 · Esc
        등록 버전 · 시트 선택 · 원본·검수 열기
        AssignTemplate()
    }
    class Suggestions {
        같은 양식 문서군 제안 → 선택한 문서군으로 등록(검수 대기)
    }
    class ReviewQueue {
        검수 큐(대기/승인/반려) · 승인/반려
    }
    Workbench --> Documents
    Documents *-- DocumentsTable
    Documents *-- DocumentDrawer
    DocumentDrawer *-- Suggestions
    Documents *-- ReviewQueue

    class Knowledge {
        2. 개념 탐색 (3열: 목록 / 그래프 / 상세)
    }
    class DomainGraph {
        SVG · L1 hull · 발행 출처 수 · 확대 · layoutDomain()
    }
    class ConceptEditor {
        이름·정의·동의어·관계·폐기 → 새 KG 리비전(CAS)
    }
    Workbench --> Knowledge
    Knowledge *-- DomainGraph
    Knowledge *-- ConceptEditor

    class Source {
        3. 원본 데이터 (시트·템플릿 / Grid+overlay / 매핑 검수)
        Grid() · MappingEditor()
    }
    class Presets {
        전처리 프리셋(원값 유지·자동 정규화·normalizers.yaml)
        TemplatePresets()
    }
    class RevisionHistory {
        규칙별 리비전 이력 · 복원(rollback)
    }
    Workbench --> Source
    Source *-- Presets
    Source *-- RevisionHistory

    class Database {
        4. 통합 DB: 소스 선택 → 필드·행 결합 → 생성 → 미리보기·lineage·다운로드(SQLite/CSV)
    }
    class ConceptTree {
        상위 체크 → 하위 일괄 선택 · selectionQuery()
    }
    Workbench --> Database
    Database *-- ConceptTree

    class Templates {
        5. 템플릿 관리: 목록·버전·JSON 편집·내보내기
    }
    class Recrawl {
        재크롤링(채우기 / 자동 재추출) · 상태 요약
    }
    Workbench --> Templates
    Templates *-- Recrawl
    Templates *-- Presets
```

### 2.4 모듈 의존과 데이터 경로 (요약)

```mermaid
flowchart LR
    UI[frontend/src/v2] -->|/api/v2| API[kg/v2/api.py]
    API --> SVC[Service]
    SVC --> DB[(v2.db)]
    SVC --> JOBS[Jobs 큐]
    JOBS -->|register / viewport / extract / build| SVC
    SVC -->|격리 프로세스| RD[Reader: XlsxReader 또는 운영자 DRM factory]
    RD -->|읽기 전용| RAW[(원본 파일 / DRM 제공자)]
    API --> FEAT[features · graph · suggest · recrawl]
    FEAT --> DB
    CLI[python -m kg.v2] --> SVC
    CLI --> MIG[migrate] --> DB
    CLI --> WATCH[watch] --> SVC
    CLI --> EXP[export / age-projection] --> DB
```
