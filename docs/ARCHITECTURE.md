# 시스템 아키텍처 다이어그램

`kg/` 현행 시스템의 구조를 그림으로 정리한다 — ①DB 스키마(ERD), ②모듈/클래스,
③시나리오별 시퀀스, ④EL 데이터 플로우. 원본 근거는 [kg/schema.sql](../kg/schema.sql)과
각 모듈 소스이며, 스키마가 바뀌면 이 문서도 같은 커밋에서 갱신한다.
(GitHub에서 mermaid가 바로 렌더된다.)

- 작업 이력: [PROGRESS.md](PROGRESS.md)
- 레거시 초기 설계: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) / [WEB_PLAN.md](WEB_PLAN.md)

---

## 1. DB 스키마 (ERD)

하나의 워크스페이스 DB(`domains/<d>/data/kg/kg.db`)에 6개 영역이 산다.
영역별로 나눠 그린다 (PK/FK와 핵심 컬럼만 표기).

### 1.1 도메인 온톨로지 + 시맨틱 매핑

고정 개념 체계(L1/L2/L3)와, 문서 트리 노드를 개념에 잇는 매핑.
`semantic_mapping`이 두 세계(온톨로지 ↔ 문서 트리)의 다리다.

```mermaid
erDiagram
    domain_concept {
        TEXT concept_id PK
        TEXT canonical_name
        TEXT concept_type
        TEXT domain_level "L1/L2/L3"
        TEXT canonical_unit
        TEXT status "ACTIVE/DEPRECATED"
    }
    domain_relation {
        TEXT source_concept_id PK,FK
        TEXT target_concept_id PK,FK
        TEXT relation_type PK "IS_A/PART_OF/AFFECTS/..."
    }
    domain_alias {
        TEXT concept_id PK,FK
        TEXT alias_norm PK "정규화 검색 키"
    }
    unit {
        TEXT symbol PK
        TEXT dimension
        REAL factor "base = v*factor + offset"
        REAL offset
    }
    semantic_mapping {
        TEXT mapping_id PK
        TEXT tree_node_id FK
        TEXT concept_id FK "NULL = UNMAPPED"
        REAL confidence
        TEXT status "AUTO_APPROVED/REVIEW_REQUIRED/APPROVED/REJECTED"
        INT  is_active
    }
    mapping_evidence {
        TEXT mapping_id PK,FK
        TEXT context_json "판정 입력 스냅샷"
        TEXT candidates_json "Top-K 후보"
    }
    review_history {
        INT  review_id PK
        TEXT mapping_id FK
        TEXT action "APPROVE/REJECT/REMAP"
    }
    tree_node {
        TEXT node_id PK
    }

    domain_concept ||--o{ domain_relation : "source/target"
    domain_concept ||--o{ domain_alias : has
    domain_concept ||--o{ semantic_mapping : "maps to"
    tree_node ||--o{ semantic_mapping : "is judged"
    semantic_mapping ||--o| mapping_evidence : evidence
    semantic_mapping ||--o{ review_history : audit
```

### 1.2 문서 트리 + 값 저장 (그래프/값 분리)

문서 구조는 `tree_node`(안정 경로 기반 — 버전이 바뀌어도 같은 경로면 같은
노드로 매핑 승계), 값은 트리 밖 `data_payload/payload_value`에 관계형으로 둔다.
`payload_value.cell_address`가 lineage의 최말단이다.

```mermaid
erDiagram
    document {
        TEXT document_id PK
        TEXT filename
        TEXT current_version FK
    }
    document_version {
        TEXT version_id PK
        TEXT document_id FK
        TEXT file_hash
        TEXT parsed_at
    }
    tree_node {
        TEXT node_id PK "(document, tree_path) 기반 안정 ID"
        TEXT document_id FK
        TEXT parent_node_id FK
        TEXT node_type "SHEET/TABLE/HEADER/VALUE_SET/..."
        TEXT tree_path
        TEXT locator "sheet!A1:B10"
        TEXT semantic_fingerprint
        TEXT status "ACTIVE/REMOVED"
    }
    data_payload {
        TEXT payload_id PK
        TEXT tree_node_id FK
        TEXT version_id FK
        INT  is_current
    }
    payload_value {
        TEXT payload_id PK,FK
        INT  row_idx PK
        TEXT row_key "LOT/시각 등 업무 키"
        REAL value_num
        TEXT value_text
        TEXT cell_address "lineage 최말단"
    }

    document ||--o{ document_version : versions
    document ||--o{ tree_node : structure
    tree_node ||--o{ tree_node : parent
    tree_node ||--o{ data_payload : values
    document_version ||--o{ data_payload : "of version"
    data_payload ||--o{ payload_value : rows
```

### 1.3 파싱 템플릿 런타임 (문서:템플릿 = N:M)

템플릿은 KG 노드가 아닌 **운영 파싱 계층**. 버전은 불변 스냅샷이고,
`document_template_assignment`는 PK(document, version, template)로 **한 문서에
관점이 다른 템플릿 여러 개**를 허용한다. override·parse_run·상태 갱신은 전부
템플릿 단위로 독립이다.

```mermaid
erDiagram
    parsing_template {
        TEXT template_id PK
        TEXT name
        TEXT target_document_kg "대상 문서군(L1)"
        TEXT lifecycle "DRAFT/ACTIVE/DEPRECATED/ARCHIVED"
    }
    parsing_template_version {
        TEXT template_id PK,FK
        INT  version PK
        TEXT spec_json "불변 스냅샷"
    }
    sheet_template {
        TEXT sheet_template_id PK
        TEXT template_id FK
        INT  template_version FK
        TEXT matcher_json "names/name_regex/headers"
    }
    template_mapping {
        TEXT mapping_id PK
        TEXT sheet_template_id FK
        TEXT mapping_key
        TEXT concept_id
        TEXT source_json "range 또는 key_search+offset"
        TEXT unit
    }
    document_template_assignment {
        TEXT document_id PK,FK
        TEXT document_version PK,FK
        TEXT template_id PK,FK "N:M — 관점별 복수 배정"
        INT  template_version
        TEXT status "ASSIGNED/PARSED/REVIEW_REQUIRED/OVERRIDDEN/FAILED"
    }
    document_override {
        TEXT override_id PK
        TEXT document_version FK
        TEXT template_mapping_id FK
        TEXT override_source_json "문서별 수동 위치 (사람 판단 불가침)"
        TEXT status "APPROVED/CONFLICT/REDUNDANT"
    }
    parse_run {
        TEXT parse_run_id PK
        TEXT document_version FK
        TEXT template_id FK
        INT  template_version
        TEXT status "SUCCESS/REVIEW_REQUIRED/FAILED"
    }
    parsed_source {
        TEXT parsed_source_id PK
        TEXT parse_run_id FK
        TEXT template_mapping_id FK
        TEXT mapping_source "TEMPLATE/MANUAL"
        TEXT value_json
    }
    document { TEXT document_id PK }

    parsing_template ||--o{ parsing_template_version : versions
    parsing_template_version ||--o{ sheet_template : sheets
    sheet_template ||--o{ template_mapping : mappings
    parsing_template_version ||--o{ document_template_assignment : "assigned (N:M)"
    document ||--o{ document_template_assignment : "복수 관점"
    template_mapping ||--o{ document_override : "per-doc delta"
    parsing_template_version ||--o{ parse_run : executes
    parse_run ||--o{ parsed_source : sources
```

### 1.4 뷰어 + DRM 획득 게이트

DRM은 우회하지 않는다 — 요청서 발급 → 해제본(같은 파일명) 도착 자동 감지.
뷰어 원본 경로(`unlocked_path`)는 백엔드 전용으로 API에 절대 노출되지 않는다.

```mermaid
erDiagram
    drm_request {
        TEXT request_id PK
        TEXT filename UK "파일당 1건"
        TEXT locked_hash "잠긴 파일 SHA-256"
        TEXT status "REQUESTED → RELEASED → INGESTED"
    }
    viewer_document_version {
        TEXT document_id PK,FK
        TEXT document_version PK,FK
        TEXT sha256
        TEXT unlocked_path "백엔드 전용 — API 비노출"
        TEXT drm_status "PROTECTED/UNLOCKING/READY/FAILED"
        TEXT render_status "PENDING/RUNNING/SUCCESS/FAILED"
    }
    viewer_sheet {
        TEXT document_id PK,FK
        TEXT document_version PK,FK
        INT  sheet_index PK
        TEXT state "visible/hidden/veryHidden"
        TEXT merged_ranges_json
        TEXT images_json
    }
    sheet_render {
        TEXT document_id PK,FK
        TEXT sheet_name PK
        TEXT render_json "원본 충실 렌더 캐시"
        TEXT file_hash "변경 시 무효화"
    }
    document { TEXT document_id PK }

    document ||--o{ viewer_document_version : "per version"
    viewer_document_version ||--o{ viewer_sheet : sheets
    document ||--o{ sheet_render : "render cache"
```

### 1.5 문서군(그룹) + 추출 레시피 + 재크롤링

문서군 멤버십은 승인 매핑에서 **파생**되고, 사람 델타(INCLUDED/EXCLUDED)만
저장한다. 레시피는 그룹당 ACTIVE 1개의 append-only 선형 이력.

```mermaid
erDiagram
    domain_concept { TEXT concept_id PK "L1 = 문서군 루트" }
    document { TEXT document_id PK }
    document_group_member {
        TEXT root_concept_id PK,FK
        TEXT document_id PK,FK
        TEXT state "INCLUDED/EXCLUDED (tombstone)"
    }
    extraction_recipe {
        TEXT recipe_id PK
        TEXT root_concept_id FK
        TEXT status "ACTIVE(그룹당 1) / ARCHIVED"
        TEXT spec_json "불변 스냅샷 — 롤백은 새 행 INSERT"
    }
    recrawl_run {
        TEXT run_id PK
        TEXT root_concept_id FK
        TEXT recipe_id FK
        TEXT mode "fill / reset_auto (승인은 불가침)"
        TEXT status "RUNNING/SUCCESS/PARTIAL/FAILED"
    }

    domain_concept ||--o{ document_group_member : "사람 델타"
    document ||--o{ document_group_member : membership
    domain_concept ||--o{ extraction_recipe : "per 문서군"
    domain_concept ||--o{ recrawl_run : recrawls
    extraction_recipe ||--o{ recrawl_run : "uses"
```

### 1.6 통합 DB 빌드 + Lineage

통합 프로젝트 정의 → 변환 DAG → 산출 Custom RDBMS 파일 + 셀 단위 lineage.

```mermaid
erDiagram
    integration_project {
        TEXT integration_id PK
        TEXT config_json "재현성 원본"
    }
    integration_field {
        TEXT field_id PK
        TEXT integration_id FK
        TEXT concept_id FK
        TEXT target_unit
    }
    source_selection {
        TEXT field_id PK,FK
        TEXT tree_node_id PK,FK
        INT  enabled
    }
    transformation_node {
        TEXT node_id PK
        TEXT operation_type "unit_convert/filter/join/..."
        TEXT config "JSON (skip_nodes 등)"
    }
    transformation_edge {
        TEXT from_node_id PK,FK
        TEXT to_node_id PK,FK
    }
    build_run {
        TEXT build_id PK
        TEXT integration_id FK
        TEXT output_db "산출 RDBMS 파일"
        TEXT status
    }
    lineage_edge {
        TEXT build_id PK,FK
        INT  output_row_id PK
        TEXT output_field PK
        TEXT payload_id FK "→ payload_value → cell_address"
        TEXT transform_path "거쳐온 변환 목록"
    }
    tree_node { TEXT node_id PK }
    data_payload { TEXT payload_id PK }

    integration_project ||--o{ integration_field : fields
    integration_field ||--o{ source_selection : "선택된 위치"
    tree_node ||--o{ source_selection : source
    integration_project ||--o{ transformation_node : "DAG"
    transformation_node ||--o{ transformation_edge : "edges"
    integration_project ||--o{ build_run : builds
    build_run ||--o{ lineage_edge : "셀 단위 출처"
    data_payload ||--o{ lineage_edge : "traces to"
```

---

## 2. 모듈/클래스 다이어그램

백엔드는 함수형 모듈 + 단일 저장 클래스(`KgStore`) 구조다. 모든 모듈이
`KgStore`를 첫 인자로 받고, 웹 계층(webapp)이 Lock으로 직렬화한다.

```mermaid
classDiagram
    direction LR

    class KgStore {
        +conn: sqlite3.Connection
        +__init__(db_path, threadsafe)
        -_migrate_template_assignment_nm()
        +upsert_concept() / concept()
        +upsert_document() / add_version()
        +node() / active_mapping()
        +commit() / close()
    }

    class ingest {
        +ingest_file(store, path, rules)
        +parse_workbook()  «src.Inspector 재사용»
        +apply_parsed()  «트리 diff + 매핑 승계»
    }
    class groups {
        «문서군 = L1 파생 ∪ 델타»
        +document_kgs(store)
        +group_documents(store, root)
        +set_member_override() / clear_member_override()
    }
    class parsing {
        «템플릿 N:M 런타임»
        +create_template() / add_version() / update_template()
        +assign() / unassign() / assignments()
        +effective_mappings(store, docver, template_id?)
        +save_override()  «per-template»
        +run_parse(store, doc, ver, path, template_id?)
        +grouped_documents(store, dkg)
    }
    class viewer {
        +register_unlocked() / validate_unlocked_xlsx()
        +document_metadata() / sheets()
        +prepare_render() / execute_render()  «LibreOffice PDF»
        +source_locator()  «위치→매핑 근거»
    }
    class acquisition {
        «DRM 게이트 — 우회 없음»
        +sniff_container()
        +create_request() / build_request_text()
        +refresh_release_states()  «해제본 자동 감지»
    }
    class recrawl {
        +start_run() / run_recrawl(mode: fill|reset_auto)
        +recover_interrupted_runs()
    }
    class search {
        +reverse_lookup() / concept_neighbors()
        +lineage_of(build, row, field)
    }
    class integration_builder {
        +define_project(config)
        +assemble_sources() «Frame 수집»
        +build() «DAG 실행 → RDBMS + lineage»
    }
    class integration_dag {
        +Frame
        +value_normalize «정규화 rules 실행»
        +unit_convert «skip_nodes = 원값 유지»
        +select/rename/filter/join/union/...
    }
    class normalize {
        «정규화기 레지스트리 — 원자 연산은 코드, 조합은 데이터»
        +CATALOG «trim/thousands/percent/split_unit»
        +apply_steps() / validate_steps()
        +load_presets() «normalizers.yaml»
    }
    class webapp {
        «FastAPI — 유일한 서버»
        +/api/files /api/sheet /api/source
        +/api/parsing/* «템플릿·배정·override·parse»
        +/api/groups /api/recipe /api/recrawl
        +/api/proposal /api/build /api/normalizers
        +/api/build/id/download «.db / .csv 반환»
        +/ «React dist 서빙 (+/app)»
    }
    class cli {
        +seed/ingest/map/review/build/trace/...
    }

    webapp --> ingest
    webapp --> groups
    webapp --> parsing
    webapp --> viewer
    webapp --> acquisition
    webapp --> recrawl
    webapp --> search
    webapp --> integration_builder
    cli --> ingest
    cli --> integration_builder
    integration_builder --> integration_dag
    integration_dag --> normalize
    webapp --> normalize : "프리셋 해석"
    recrawl --> parsing
    ingest ..> KgStore
    groups ..> KgStore
    parsing ..> KgStore
    viewer ..> KgStore
    acquisition ..> KgStore
    recrawl ..> KgStore
    search ..> KgStore
    integration_builder ..> KgStore
    webapp ..> KgStore : "Lock 직렬화"
```

프론트(React, `frontend/`)는 5탭 화면이 Context 스토어 하나를 공유한다:

```mermaid
flowchart LR
    subgraph frontend["frontend/src"]
        store["lib/store.tsx<br/>공유 상태 (domain/dkgs/files/cart)"]
        api["lib/api.ts<br/>fetch 헬퍼 + cart 저장소"]
        F["screens/FilesScreen<br/>1. 파일 분석"]
        K["screens/KgScreen (+kg/)<br/>2. 개념 탐색"]
        S["screens/SourceScreen (+source/)<br/>3. 원본 데이터"]
        D["screens/DbScreen<br/>4. 통합 DB"]
        T["screens/TemplatesScreen<br/>5. 템플릿 관리"]
    end
    F & K & S & D & T --> store --> api
    api -->|"/api/*"| W["kg/webapp.py"]
```

---

## 3. 시나리오별 시퀀스 다이어그램

### 3.1 신규 파일 등록 (분석 → 문서군 제안 → 레시피 이식)

```mermaid
sequenceDiagram
    actor U as 사용자
    participant FE as 파일 분석 탭
    participant W as webapp
    participant I as ingest
    participant G as groups
    participant M as semantic_mapping

    U->>FE: data/raw에 새 파일 두고 [분석]
    FE->>W: POST /api/ingest {filename, map:false}
    W->>I: parse_workbook (구조만)
    I-->>W: tree + 어휘 지문
    W->>G: 유사 문서군 탐색 (지문 겹침)
    G-->>FE: 제안 목록 (문서군·match%·레시피 유무)
    U->>FE: 문서군 선택 → [등록]
    FE->>W: POST /api/ingest {filename, group_id}
    W->>I: apply_parsed (트리 확정, 매핑 승계)
    W->>G: 레시피 spec으로 매핑 이식
    W->>M: 잔여 노드 자동 판정 (신뢰도 낮으면 REVIEW_REQUIRED)
    W-->>FE: 등록 완료 (이식 n건 · 검토 m건)
```

### 3.2 DRM 잠금 파일 — 정식 해제 흐름 (우회 없음)

```mermaid
sequenceDiagram
    actor U as 사용자
    participant FE as 파일 분석 탭
    participant W as webapp
    participant A as acquisition
    participant FS as data/raw

    U->>FE: 잠긴 파일에 [정식 해제 요청]
    FE->>W: POST /api/drm/request
    W->>A: create_request (locked_hash 기록)
    A-->>FE: 요청서 텍스트 (결재/그룹웨어 첨부용)
    Note over U,FS: 사내 절차로 해제본 수령 —<br/>같은 파일명으로 data/raw에 배치
    U->>FE: 화면 재방문 (목록 로드)
    FE->>W: GET /api/raw-files
    W->>A: refresh_release_states
    A->>FS: 파일 읽기 가능 여부 검사
    A-->>FE: status = RELEASED (등록 가능 배지)
    U->>FE: [등록] → 3.1 흐름 합류 (status → INGESTED)
```

### 3.3 원본 데이터 뷰어 — 렌더 4단 우선순위

```mermaid
sequenceDiagram
    participant FE as 원본 데이터 탭
    participant W as webapp /api/sheet
    participant X as 원본 xlsx
    participant C as sheet_render 캐시
    participant COM as Excel COM (Windows)
    participant T as tree 폴백

    FE->>W: GET /api/sheet?document_id&sheet
    W->>X: ① 원본 열기 → _render_sheet<br/>(병합/스타일/이미지/텍스트박스 앵커)
    alt 원본 읽기 가능
        X-->>FE: 충실 렌더 JSON
    else 잠김/부재
        W->>C: ② 렌더 캐시 (file_hash 일치 시)
        alt 캐시 적중
            C-->>FE: 캐시 렌더
        else 미스
            W->>COM: ③ Copy→SaveAs(51)→충실 렌더
            alt COM 성공
                COM-->>FE: 충실 렌더
            else 실패/비Windows
                W->>T: ④ tree 기반 값-전용 그리드
                T-->>FE: degraded 렌더 + 저하 배너
            end
        end
    end
```

### 3.4 템플릿 N:M — 배정·파싱·override

```mermaid
sequenceDiagram
    actor U as 사용자
    participant TM as 템플릿 관리 탭
    participant W as webapp /api/parsing
    participant P as parsing

    U->>TM: 템플릿 A(실험 관점)·B(원가 관점) 생성 + spec v1
    U->>TM: 같은 문서에 A, B 모두 배정
    TM->>W: POST documents/{doc}/assign ×2
    W->>P: assign — 교체가 아닌 추가 (PK: doc,ver,template)
    U->>TM: A로 파싱 실행
    TM->>W: POST documents/{doc}/parse {template_id: A}
    W->>P: prepare_parse(A) → extract_workbook → save_parse_run
    Note over P: 배정이 복수면 template_id 필수<br/>상태 갱신은 A 행만
    U->>TM: B의 매핑 하나를 문서별 override
    W->>P: save_override — B 배정 검증, B 상태만 OVERRIDDEN
    U->>TM: A를 v2로 재배정 (버전 교체)
    W->>P: assign(A,2) → A의 override만 감사(CONFLICT/REDUNDANT)
    Note over P: B의 override는 비전염 — 템플릿 단위 독립
```

### 3.5 통합 DB 빌드 (개념 트리 → 전처리 프리셋 → 생성·다운로드)

```mermaid
sequenceDiagram
    actor U as 사용자
    participant DB as 통합 DB 탭
    participant W as webapp
    participant N as normalize
    participant B as integration.builder
    participant D as integration.dag

    U->>DB: ① 개념 트리 체크 — 상위 개념 체크 시 하위 개념 소스 일괄 담김
    Note over DB: 양식 카드에서 세부 조정 —<br/>전처리(자동/원값/정규화 프리셋) · 문서별 가감
    DB->>W: GET /api/normalizers
    W->>N: catalog + load_presets(normalizers.yaml)
    N-->>DB: 전처리 드롭다운 프리셋
    DB->>W: POST /api/proposal {node_ids}
    W-->>DB: ② Row Context 기반 스키마 제안 (컬럼명 조정)
    U->>DB: ③ [DB 생성]
    DB->>W: POST /api/build {fields, raw_node_ids, normalize_rules}
    W->>N: 프리셋 id → steps 해석 (value_normalize rules)
    W->>B: define_project → assemble_sources (Frame)
    B->>D: value_normalize → unit_convert(skip_nodes 제외) → union → dedup
    Note over D: 분리된 단위는 lineage.unit으로<br/>unit_convert에 전달, 적용 이력도 lineage에
    D-->>B: 결과 Frame + 경고(단위 미변환 등)
    B-->>DB: 산출 DB(_source_* lineage 컬럼) + 빌드 리포트
    U->>DB: ⬇ 다운로드 — GET /api/build/id/download (.db / ?format=csv)
```

### 3.6 재크롤링 (사람 승인 불가침)

```mermaid
sequenceDiagram
    actor U as 사용자
    participant KG as 개념 탐색 탭
    participant W as webapp
    participant R as recrawl

    U->>KG: 문서군에서 [재크롤링] (fill 또는 reset_auto)
    KG->>W: POST /api/recrawl {mode}
    W->>R: start_run (RUNNING 기록) → 백그라운드 실행
    loop 문서군의 각 문서
        R->>R: ACTIVE 레시피로 재추출
        Note over R: fill: 빈 곳만 채움<br/>reset_auto: AUTO 판정만 초기화<br/>APPROVED(사람 승인)는 절대 불변
    end
    KG->>W: 폴링 GET /api/recrawl/status
    W-->>KG: RUNNING → SUCCESS/PARTIAL (문서별 요약)
    Note over W: 서버 재기동 시 recover_interrupted_runs가<br/>중단 run을 FAILED로 정리
```

---

## 4. EL 데이터 플로우

문서를 표준 양식으로 변환(T)하지 않고 **구조 보존 적재(EL) 후 의미 연결**한다.
변환은 마지막 통합 빌드 단계에서만, 선택적으로 일어난다.

```mermaid
flowchart LR
    subgraph EX["Extract — 원본 획득"]
        RAW["data/raw/*.xlsx"]
        DRM["잠긴 파일<br/>DRM 게이트(요청→해제본 감지)"]
        DRM -->|해제본| RAW
    end

    subgraph LD["Load — 구조 보존 적재 (변환 없음)"]
        INS["src.Inspector<br/>반복 블록/병합/범례/다영역 복원"]
        TREE["tree_node<br/>안정 경로 트리 (버전 간 매핑 승계)"]
        PAY["data_payload / payload_value<br/>값 + cell_address"]
        RC["sheet_render<br/>원본 충실 렌더 캐시"]
        RAW --> INS --> TREE
        INS --> PAY
        RAW --> RC
    end

    subgraph SEM["Semantize — 의미 연결"]
        MAP["semantic_mapping<br/>자동 판정 + 검수(승인/반려)"]
        GRP["문서군 파생<br/>승인 매핑 ∪ 사람 델타"]
        RCP["추출 레시피<br/>신규 문서에 매핑 이식"]
        TREE --> MAP --> GRP
        GRP --> RCP -.->|이식| MAP
    end

    subgraph TPL["Perspective Parse — 관점별 추출 (N:M)"]
        PT["parsing_template vN<br/>문서당 복수 배정"]
        PS["parsed_source<br/>TEMPLATE/MANUAL provenance"]
        PT --> PS
        RAW --> PS
    end

    subgraph TR["Transform+Build — 여기서만 변환"]
        SEL["개념 트리 선택 (상위→하위 일괄)<br/>양식별 전처리 / 문서별 가감"]
        NRM["normalizers.yaml 프리셋<br/>→ value_normalize (선언적 rules)"]
        DAG["변환 DAG<br/>value_normalize·unit_convert·join·..."]
        OUT[("Custom RDBMS<br/>_source_* lineage 컬럼")]
        LIN["lineage_edge<br/>출력 셀 → 원본 cell_address<br/>+ 적용 정규화 이력"]
        MAP --> SEL
        PS --> SEL
        NRM --> DAG
        SEL --> DAG --> OUT
        DAG --> LIN
        PAY --> LIN
    end

    subgraph SV["Serve"]
        UI["React 5탭 UI<br/>(kg.webapp이 / 에 서빙)"]
        DL["산출물 다운로드<br/>/api/build/id/download (.db/.csv)"]
    end
    RC --> UI
    OUT --> UI
    OUT --> DL
    LIN --> UI
```

핵심 불변식:

1. **원본은 불변** — 적재·렌더 어느 단계도 원본 파일을 고치지 않는다 (DRM 우회 없음).
2. **변환은 빌드에서만** — Load 단계는 구조·값을 있는 그대로 보존한다.
3. **사람 판단 불가침** — APPROVED 매핑·수동 override는 재크롤링/재배정이 덮지 않는다.
4. **모든 출력 셀은 원본 셀로 추적 가능** — lineage_edge → payload_value.cell_address.
5. **정규화는 코드에 고정하지 않는다** — 원자 연산만 코드(kg/normalize.py 카탈로그,
   선언적 파라미터만)에 두고, 조합·선택은 데이터(normalizers.yaml 프리셋 + 빌드
   rules)로 관리한다. 단위 변환 규칙의 원본도 units.yaml이다.
