# v3 구현 계약 — Parsing Schema / Parsing Profile 런타임

작성일: 2026-09-14 (개정 2 — 적대적 검증 45건 반영)
상태: 구현 기준 (이 문서와 코드가 다르면 같은 커밋에서 이 문서를 고친다)

근거 문서(모두 `docs/design/`):
[system-identity-and-scope.md](system-identity-and-scope.md)(identity) ·
[parsing-core-schema.md](parsing-core-schema.md)(core, 18개안) ·
[parsing-core-schema-reply.md](parsing-core-schema-reply.md)(reply, §5 남은 빈칸 3개) ·
[ui-development-spec.md](ui-development-spec.md)(개발 기준안, 승인 목업 `assets/ui-approved-mockup.svg`) ·
[ui-screen-definition.md](ui-screen-definition.md) · [ui-wireframes.md](ui-wireframes.md) ·
[drm-viewer-render-architecture.md](drm-viewer-render-architecture.md)(render) ·
[db-schema-v2.md](db-schema-v2.md) §8(DRM 조건) · [v2-decisions.md](v2-decisions.md) §2-3(18개안 채택).

이 문서는 위 문서들이 정한 것을 **코드 단위(파일·테이블·컬럼·엔드포인트·화면)**로 고정한다.
문서끼리 갈리는 지점의 결정과 근거는 [v3-decisions.md](v3-decisions.md)에 적는다(§번호로 참조).

두 가지 요구를 모든 구현이 따른다.

- **사용성**: 사용자는 내부 ID(application/revision/run)를 보지 않는다(§7 표시 규칙). 화면마다 대표 행동 하나. 값이 보이는 곳에는 항상 `원본 보기`. 빈 상태에는 다음 행동. 로딩은 패널 단위(사이트 전체가 멈추지 않는다). 같은 원인은 묶어서 한 번에 처리한다.
- **속도**: 목록은 keyset 페이지 + 페이지 범위 요약. 렌더는 캐시(스냅샷+시트+renderer_version)와 창(window) 단위, 밴드 파일로 O(창) 응답. 이미지는 별도 asset. 그리드는 가상화. 검수→추출→발행은 요청 1회. 화면 진입 API 호출 ≤ 3. 같은 결과를 두 번 계산하지 않는다.

---

## 0. 위치와 이름

| 영역 | 경로 | 비고 |
|---|---|---|
| DDL | `db/v3/schema_sqlite.sql`, `db/v3/schema_postgres.sql` | 18개 코어 + `schema_meta` + 런타임 테이블 |
| 런타임 | `kg/v3/` | `kg/v2/`는 이관 완료까지 유지. v3는 v2의 **순수 함수만** 재사용한다: `kg.v2.spec.bounds/address/decimal/decimal_text/typed`, `kg.v2.normalization`(v2 op 실행·프리셋 읽기만; 파이프라인 검증과 `split_delimiter`는 `kg/v3/normalization.py`), `kg.v2.readers.XlsxReader`(상속; `region/area/resolve/_check/describe/signature` 재사용, `extract`는 v3 엔진으로 교체, `render` 추가), `kg.v2.suggest.signature_terms`(구조 서명), `kg.watch.FileEventWatcher`. v2 `Service`/`Database`/`api`/`jobs.Jobs`는 import하지 않는다(`jobs.py`는 v3로 복사·수정) |
| 렌더 서버 | `kg/v3/render/` | 별도 프로세스(`python -m kg.v3 render-serve`) 또는 in-process 어댑터 |
| API | `/api/v3/...` | `python -m kg.v3 serve`(독립) 및 `kg.webapp`에 `install(app, root)` |
| DB 파일 | `<ws>/data/kg/v3.db` | `schema_meta.version = 3` |
| 정의 파일 | `<ws>/schemas/<schema_key>/r%04d.json`, `<ws>/profiles/<profile_id>/r%04d.json` | Git/DVC 추적 대상. DB는 projection. `current.json` 심볼릭 복사본을 같이 둔다 |
| 산출물 | `<ws>/data/exports/<build_key>/` | `data.csv|xlsx|sqlite` + `manifest.json` |
| 렌더 캐시 | `<ws>/data/render-cache/<snapshot_id>/<sheet_id>.<renderer_version>/{meta.json, band-<r1>-<r2>.json}`, `<ws>/data/render-cache/<snapshot_id>/assets/<sha256>.<ext>` | 재생성 가능. asset은 snapshot 디렉터리 안에만(전역 공유 금지). `invalidate(snapshot_id)`는 디렉터리 전체 삭제 |
| 프런트 | `frontend/src/v3/` | 기본 화면. `?v2=1`은 v2, `?v1=1`은 v1 유지. `frontend/src/v3/**`는 `../v2/client`·`../v2/Workbench` 등 v2 훅/API 래퍼를 import하지 않는다(허용: `../v2/DomainGraph`의 순수 함수 `layoutDomain`·`groupColor`·`GROUP_COLORS`와 타입만). 컴포넌트 테스트 `v3-imports.test.tsx`가 이를 검사 |
| E2E | `e2e/v3/` | Playwright, 임시 작업 공간, 렌더 서버 별도 프로세스 |
| 문서 | `docs/ARCHITECTURE_V3.md`, `docs/e2e-results-v3.md` | |

용어(코드 식별자 → UI 표기): `parsing_schema` → 파싱 스키마, `parsing_field` → 필드, `parsing_profile` → 파싱 프로파일,
`parsing_rule` → 파싱 규칙, `source_region` → 원본 위치, build → 데이터 빌드, `mapping` → 매핑, `extraction_run` → 파싱 실행, job → 작업.
`KG`, `Concept`, `Template`, `Integration`, `문서군`은 v3 UI 문자열에 쓰지 않는다(`v3-terms.test.tsx`가 소스 문자열을 검사).

---

## 1. 코어 스키마 (SQLite 기준, 18개 + 보완)

공통 규칙: ID는 애플리케이션 생성 UUID 문자열(`TEXT`, `^[0-9a-f-]{36}$`). 시각은 ISO-8601 UTC 문자열. JSON 컬럼은 `json_valid` CHECK.
PK 컬럼은 SQLite에서도 명시적으로 `NOT NULL`. 모든 FK는 `REFERENCES` + 인덱스. "불변" 표시 테이블은 UPDATE/DELETE 거부 트리거(`<table>_no_update/_no_delete`).
snapshot 바인딩 불변식(§1.9)을 위해 `snapshot_id`를 자식 테이블에 비정규화하고 복합 FK를 건다(v2 방식; 복합 FK의 부모 컬럼 조합에는 UNIQUE).

### 1.1 문서

```sql
document (
  document_id TEXT PK, document_name TEXT NOT NULL, provider TEXT NOT NULL,   -- 'local-xlsx' | 운영자 등록 DRM provider 키
  source_path TEXT NOT NULL,                       -- provider 기준 상대 참조. 절대 경로/비밀 경로 금지
  file_type TEXT NOT NULL, current_snapshot_id TEXT,
  status TEXT NOT NULL DEFAULT 'not_extracted'
    CHECK (status IN ('not_extracted','locked','unmatched','review','changed','failed','normal')),   -- §4.12 서비스 유지 캐시
  status_detail_json TEXT, last_processed_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(provider, source_path),
  FOREIGN KEY (document_id, current_snapshot_id) REFERENCES document_snapshot(document_id, snapshot_id) DEFERRABLE INITIALLY DEFERRED)
document_snapshot (불변) (
  snapshot_id TEXT PK, document_id TEXT NOT NULL REFERENCES document, revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  change_token TEXT NOT NULL,                      -- Reader describe().token. local-xlsx = content_sha256; DRM = provider_version(+ciphertext)
  content_sha256 TEXT, ciphertext_sha256 TEXT, provider_version TEXT, dvc_rev TEXT,   -- 평문 해시는 정책상 가능한 경우만. 해시용 해제본을 만들지 않는다
  author TEXT, authored_at TEXT, filename TEXT NOT NULL, byte_size INTEGER, excel_date_system TEXT, captured_at TEXT NOT NULL,
  CHECK (content_sha256 IS NOT NULL OR provider_version IS NOT NULL OR ciphertext_sha256 IS NOT NULL),
  UNIQUE(document_id, revision_no), UNIQUE(document_id, snapshot_id))
sheet (불변) (sheet_id TEXT PK, snapshot_id TEXT NOT NULL REFERENCES document_snapshot, sheet_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),   -- 0부터, 워크북 순서(describe·sheet_roles.match.ordinal과 같은 기준)
  native_sheet_key TEXT, visibility TEXT NOT NULL DEFAULT 'visible', estimated_rows INTEGER, estimated_cols INTEGER,
  UNIQUE(snapshot_id, ordinal), UNIQUE(snapshot_id, sheet_name), UNIQUE(sheet_id, snapshot_id))
source_region (불변) (region_id TEXT PK, snapshot_id TEXT NOT NULL, sheet_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cells','image','chart','shape','text')),
  locator_key TEXT NOT NULL,                       -- cells: 'B3:C3'(병합은 병합 범위 전체), 그 외: object key
  r1 INTEGER, c1 INTEGER, r2 INTEGER, c2 INTEGER, geometry_json TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id),
  UNIQUE(sheet_id, kind, locator_key), UNIQUE(region_id, snapshot_id))
```

### 1.2 Parsing Schema

```sql
parsing_schema (schema_id TEXT PK, schema_key TEXT NOT NULL UNIQUE,   -- 사람이 읽는 안정 키(정의 파일·API 경로). schema_id는 UUID
  schema_name TEXT NOT NULL UNIQUE, description TEXT, definition_path TEXT, current_rev INTEGER NOT NULL DEFAULT 0,
  definition_sha256 TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
parsing_field (field_id TEXT PK, schema_id TEXT NOT NULL REFERENCES parsing_schema, field_key TEXT NOT NULL,   -- 영문 key(UI '영문명')
  field_name TEXT NOT NULL, description TEXT, field_level INTEGER CHECK (field_level IS NULL OR field_level > 0),
  value_type TEXT NOT NULL CHECK (value_type IN ('text','decimal','boolean','date','datetime','group')),
  canonical_unit TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  ordinal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(schema_id, field_key))
parsing_alias (alias_id TEXT PK, field_id TEXT NOT NULL REFERENCES parsing_field, alias_text TEXT NOT NULL, alias_norm TEXT NOT NULL,
  context_key TEXT NOT NULL DEFAULT '', UNIQUE(field_id, alias_norm, context_key))
parsing_field_edge (edge_id TEXT PK, schema_id TEXT NOT NULL REFERENCES parsing_schema,
  from_field_id TEXT NOT NULL REFERENCES parsing_field, to_field_id TEXT NOT NULL REFERENCES parsing_field,
  relation TEXT NOT NULL CHECK (relation IN ('parent_of','related_to')), ordinal INTEGER,
  UNIQUE(schema_id, from_field_id, to_field_id, relation), CHECK (from_field_id <> to_field_id))
```

- `value_type='group'`은 트리의 묶음 노드(예: "공정 정보")다. 값이 추출되지 않는다. 트리거 `field_group_not_target`: `parsing_rule.default_field_id`·`mapping_revision.field_id`가 group 필드를 가리키면 ABORT(서비스는 422 `GROUP_FIELD_TARGET`).
- 트리거 `field_edge_level`(BEFORE INSERT ON parsing_field_edge WHEN relation='parent_of'): 양쪽 `field_level`이 NULL이거나 `to.level <> from.level + 1`이면 ABORT(NULL은 `COALESCE`로 통과시키지 않는다). 트리거 `field_level_guard`(BEFORE UPDATE OF field_level): 기존 parent_of 간선이 깨지면 ABORT. 다부모 허용.
- **projection 삭제 금지**: `parsing_field`·`parsing_rule`은 DELETE 트리거로 거부한다. 정의 파일에서 사라진 항목은 `status='deprecated'`로만 표시한다(reply §5-2.2).

### 1.3 Parsing Profile

```sql
parsing_profile (profile_id TEXT PK, profile_name TEXT NOT NULL UNIQUE, description TEXT,
  schema_id TEXT NOT NULL REFERENCES parsing_schema,          -- 프로파일은 스키마 하나를 대상으로 한다. 변경 불가(422 SCHEMA_IMMUTABLE)
  definition_path TEXT, current_rev INTEGER NOT NULL DEFAULT 0, definition_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','deprecated')),
  reference_application_id TEXT REFERENCES parsing_application,   -- 승인 시 대표 문서 적용 건. PostgreSQL은 ALTER TABLE로 뒤에 추가(순환)
  reference_profile_rev INTEGER, reference_signature TEXT,          -- 대표 적용 건의 매치 서명(§3.4)과 그때의 rev. NULL이면 identical 판정 없음
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
parsing_rule (rule_id TEXT PK, profile_id TEXT NOT NULL REFERENCES parsing_profile, rule_key TEXT NOT NULL, rule_name TEXT,
  default_field_id TEXT REFERENCES parsing_field,             -- nullable: field_key 없는 규칙(v2 concept_id NULL 등)
  ordinal INTEGER NOT NULL, selector_json TEXT NOT NULL, value_spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')), created_at TEXT NOT NULL,
  UNIQUE(profile_id, rule_key))
```

Profile JSON 전체는 파일(`definition_path`)이 진실이고 `parsing_rule`은 조회·편집용 projection이다(identity §8.2). 새 리비전 저장 = 파일 `r%04d.json` 추가 + `current_rev` 증가 + rule projection upsert(사라진 rule은 deprecated). approved 프로파일의 새 리비전은 §4.2의 참조 재검증 규칙을 따른다.

### 1.4 Application / Mapping

```sql
parsing_application (application_id TEXT PK, snapshot_id TEXT NOT NULL REFERENCES document_snapshot,
  profile_id TEXT NOT NULL REFERENCES parsing_profile, schema_id TEXT NOT NULL REFERENCES parsing_schema,
  scope_key TEXT NOT NULL DEFAULT 'default', profile_rev INTEGER NOT NULL, schema_rev INTEGER NOT NULL,
  published_run_id TEXT,                                       -- reply §5-2.1 복귀. 발행 조건 트리거 §1.4 규칙
  origin TEXT NOT NULL CHECK (origin IN ('auto','manual','inherited')),
  match_signature TEXT NOT NULL, match_signature_json TEXT,     -- §3.4 매치 서명(이 application의 profile_rev로 계산)
  compatibility TEXT NOT NULL CHECK (compatibility IN ('identical','compatible','manual')),
  created_at TEXT NOT NULL,
  UNIQUE(snapshot_id, profile_id, scope_key), UNIQUE(application_id, snapshot_id),
  FOREIGN KEY (published_run_id, application_id) REFERENCES extraction_run(run_id, application_id))
application_sheet (application_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, role_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), sheet_id TEXT NOT NULL,
  PRIMARY KEY (application_id, role_key, ordinal),
  FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id),
  FOREIGN KEY (sheet_id, snapshot_id) REFERENCES sheet(sheet_id, snapshot_id))
mapping (mapping_id TEXT PK, application_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, rule_id TEXT NOT NULL REFERENCES parsing_rule,
  current_revision_id TEXT, edit_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(application_id, rule_id), UNIQUE(mapping_id, snapshot_id),
  FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id),
  FOREIGN KEY (mapping_id, current_revision_id) REFERENCES mapping_revision(mapping_id, mapping_revision_id) DEFERRABLE INITIALLY DEFERRED)
mapping_revision (불변) (mapping_revision_id TEXT PK, mapping_id TEXT NOT NULL, revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  snapshot_id TEXT NOT NULL,
  field_id TEXT REFERENCES parsing_field,                      -- nullable; approved면 필수
  observed_key TEXT, effective_spec_json TEXT NOT NULL,        -- §2 compile_rule 결과(selector+value_spec+record_spec+relations, 앵커 인라인)
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('profile','inherited','manual','import','auto')),
  evidence_json TEXT,                                          -- auto: {reference_revision_id, profile_rev, match_signature}; inherited: {previous_application_id, previous_revision_id, compatibility, previous_signature, new_signature}
  created_by TEXT, reason TEXT, created_at TEXT NOT NULL,
  CHECK (status <> 'approved' OR field_id IS NOT NULL),
  UNIQUE(mapping_id, revision_no), UNIQUE(mapping_id, mapping_revision_id), UNIQUE(mapping_revision_id, snapshot_id),
  FOREIGN KEY (mapping_id, snapshot_id) REFERENCES mapping(mapping_id, snapshot_id))
mapping_region (불변) (mapping_revision_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, region_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key')), ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (mapping_revision_id, role, ordinal),
  FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
  FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id))
```

규칙(트리거):
- **헤드** = `mapping.current_revision_id` = 항상 **마지막 리비전**(status와 무관). `edit_seq` = 헤드의 `revision_no`(리비전 없음 = 0).
- **CAS**(`mapping_edit_seq`): BEFORE INSERT ON mapping_revision → `NEW.revision_no <> mapping.edit_seq + 1`이면 ABORT; AFTER INSERT → `UPDATE mapping SET edit_seq = NEW.revision_no, current_revision_id = NEW.mapping_revision_id`. 서비스는 `BEGIN IMMEDIATE` 안에서 `revision_no = expected_seq + 1`로 삽입하고 IntegrityError는 409 `EDIT_CONFLICT`(리비전·영역 모두 롤백). `mapping.edit_seq/current_revision_id`의 직접 UPDATE는 트리거가 거부(`NEW.edit_seq <> OLD.edit_seq + 1` 또는 헤드가 `revision_no = NEW.edit_seq`인 리비전이 아니면 ABORT). 최초 리비전은 `expected_seq = 0`.
- 헤드가 바뀔 때마다(`mapping_head_invalidates`) 그 application의 `published_run_id = NULL`(재추출 필요).
- **발행 조건**(`publish_run`, BEFORE UPDATE OF published_run_id WHEN NEW IS NOT NULL): 실행이 `status='succeeded'`이고 `application_id`가 같으며, `mapping(application_id).{mapping_id, current_revision_id}` 집합과 `input_manifest_json.$.mappings` 의 `{key, $.revision_id}` 집합이 양방향 `EXCEPT`로 같고, 헤드가 NULL인 mapping이 없고, 모든 헤드가 `approved`일 때만. `application_starts_unpublished`: INSERT 시 `published_run_id`는 NULL. `application_identity`: `application_id/snapshot_id/profile_id/schema_id/scope_key/profile_rev/schema_rev`는 UPDATE 불가.
- `mapping_region`은 검수 결과의 **실제 위치**다. 리비전 저장 시 `effective_spec_json`의 `range` 영역과 검수에서 확인된 `find/anchor` 결과 위치를 role별로 기록한다(역방향 조회 "이 셀을 참조하는 매핑"). composite 앵커는 멤버 영역 각각(ordinal = 멤버 순서).
- `rejected` 헤드: 규칙에 유효한 매핑이 없는 상태. 추출 불가(§4.6), 검수 큐에 "반려됨 · 수정 필요"로 남는다(§4.11). 반려 후 새 proposed/approved 리비전을 추가하면 해소된다.

### 1.5 Extraction

```sql
extraction_run (run_id TEXT PK, application_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  schema_rev INTEGER, profile_rev INTEGER, engine_version TEXT NOT NULL,
  input_manifest_json TEXT NOT NULL,   -- {"mappings":{mapping_id:{"revision_id":..,"rule_key":..}}, "bindings":{role:[sheet_id]}, "engine":{...}}
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  started_at TEXT, finished_at TEXT, error_summary TEXT, auto_approved INTEGER NOT NULL DEFAULT 0,   -- §4.3 자동 승인 뒤 실행이면 1(실패 큐 표시용)
  UNIQUE(run_id, application_id), UNIQUE(run_id, snapshot_id),
  FOREIGN KEY (application_id, snapshot_id) REFERENCES parsing_application(application_id, snapshot_id))
  -- 완료(succeeded/failed/cancelled) 후 불변(트리거 run_state_transition: queued→running→종료만 허용)
extracted_value (불변) (value_id TEXT PK, run_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, mapping_revision_id TEXT NOT NULL,
  field_id TEXT NOT NULL REFERENCES parsing_field,
  group_key TEXT NOT NULL,             -- "{rule_key}|{sheet_id}|{anchor_locator}" 반복 블록 정체성(extracted_series 대체)
  record_key TEXT, item_index INTEGER, raw_text TEXT, display_text TEXT, value_text TEXT, value_type TEXT NOT NULL,
  value_state TEXT NOT NULL CHECK (value_state IN ('present','null','empty','error')),
  unit_raw TEXT, unit_normalized TEXT, formula_state TEXT, source_identity_key TEXT NOT NULL, derivation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, snapshot_id) REFERENCES extraction_run(run_id, snapshot_id),
  FOREIGN KEY (mapping_revision_id, snapshot_id) REFERENCES mapping_revision(mapping_revision_id, snapshot_id),
  UNIQUE(value_id, snapshot_id))
extracted_value_region (불변) (value_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, region_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('key','value','unit','context','record_key','input')), ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (value_id, role, ordinal),
  FOREIGN KEY (value_id, snapshot_id) REFERENCES extracted_value(value_id, snapshot_id),
  FOREIGN KEY (region_id, snapshot_id) REFERENCES source_region(region_id, snapshot_id))
```

값 출처는 **항상** `extracted_value_region`이다(단일 출처도 행 1개; reply §5-2.3). `extracted_value.source_region_id`는 두지 않는다.
`value_state`: `present`(값 있음) · `empty`(빈 셀) · `null`(결합 결과 없음, 분할 조각 없음 등 명시적 없음) · `error`(수식 오류·변환 실패, `raw_text`에 원문).
`extracted_value.field_id`는 NOT NULL이다(§4.6이 전부 approved인 헤드만 추출하므로).

### 1.6 코어 밖 런타임 테이블 (`kg/v3/db.py`가 `CREATE TABLE IF NOT EXISTS`)

```sql
runtime_job (job_id TEXT PK, kind TEXT NOT NULL CHECK (kind IN ('register','extract','reparse','build','test','queue_action','migrate')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')), principal TEXT NOT NULL,
  payload_json TEXT NOT NULL, result_json TEXT, error_code TEXT, error_message TEXT, completed INTEGER NOT NULL DEFAULT 0, total INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  target_kind TEXT CHECK (target_kind IN ('document','profile','application','build','queue_group','workspace')), target_id TEXT, label TEXT,   -- 작업 내역 표시용
  created_at TEXT NOT NULL, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, UNIQUE(principal, kind, request_key))
snapshot_signature (snapshot_id TEXT PK REFERENCES document_snapshot, algorithm TEXT NOT NULL,   -- 'structure-v2': 프로파일 무관 문서 구조 서명(라벨 기반 휴리스틱)
  signature_json TEXT NOT NULL, signature_sha256 TEXT NOT NULL, reader_revision TEXT NOT NULL, computed_at TEXT NOT NULL)
source_digest (provider TEXT NOT NULL, source_path TEXT NOT NULL, byte_size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,   -- §4.1.1 폴더 일괄 등록의 "변경 없음" 판정 캐시
  content_sha256 TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (provider, source_path))
```

- 동기 실행되는 작업(프로파일 테스트 §4.7, 동기 빌드 §4.10)도 시작 시 `running` 행을 넣고 종료 시 `succeeded|failed`로 갱신한다(응답은 결과 본문). `result_json`에는 요약만(`{errors, groups, compatibility}` 또는 `{build_key, download_url, row_count}`). 렌더는 `runtime_job`이 아니다(§5 렌더 서버 큐).
- `source_digest`는 로컬 원본의 `(byte_size, mtime_ns)` → 내용 SHA-256 캐시다. 같은 stat이면 파일을 읽지 않고 해시를 재사용한다. 진실은 `document_snapshot.change_token`이며 이 표는 언제 지워도 된다(다음 스캔이 다시 계산).
- `snapshot_signature`는 §4.11 `unmatched` 묶음("신규 양식 후보")에만 쓰고 매치 판정에는 쓰지 않는다. `access_observation`·`render_chunk`는 두지 않는다(권한은 매 요청 확인, 렌더 캐시는 파일; 접근 상태 열은 `document.status`로 대체 — reply §5-3).

### 1.7 뷰·인덱스

- 뷰 `current_value`: `document.current_snapshot_id`의 application 중 `published_run_id`가 있는 실행의 값만(`document_id, application_id, profile_id, field_id, value.*`).
- 인덱스: `document(status, document_name)`, `document(status, updated_at DESC)`, `document(current_snapshot_id)`, `document_snapshot(document_id, revision_no DESC)`, `document_snapshot(document_id, change_token)`,
  `parsing_application(snapshot_id, profile_id)`, `parsing_application(profile_id)`, `mapping(application_id, rule_id)`, `mapping_revision(mapping_id, revision_no DESC)`,
  `extraction_run(application_id, started_at DESC)`, `extracted_value(run_id, field_id, record_key)`, `extracted_value(mapping_revision_id)`, `extracted_value(field_id)`,
  `extracted_value_region(region_id)`, `source_region(sheet_id, r1, c1)`, `parsing_alias(alias_norm)`, `parsing_field(schema_id, status, ordinal)`, `runtime_job(state, created_at)`, `runtime_job(target_kind, target_id)`.
- 조회 성능 인덱스(리뷰 반영; DDL과 `kg/v3/db.py` RUNTIME_DDL(`IF NOT EXISTS`, 기존 DB 보강)에 같이 둔다): `document(coalesce(last_processed_at,'') DESC, document_id DESC)`(기본 정렬 keyset), `document(document_name, document_id)`, `document(status, document_id)`, `mapping(current_revision_id)`(헤드 역조회·발행 트리거),
  `extracted_value(run_id, mapping_revision_id, group_key, item_index, value_id)`(매핑 행의 첫 값·개수), `extracted_value(field_id, created_at DESC, value_id)`(필드 최근 값), 부분 인덱스 `extracted_value(run_id, field_id, unit_normalized) WHERE unit_normalized IS NOT NULL`(단위 충돌 큐).

### 1.8 PostgreSQL

`db/v3/schema_postgres.sql`은 같은 객체 집합(테이블·제약·인덱스·뷰)을 PL/pgSQL 트리거로 번역한다. 순환 FK(`document.current_snapshot_id`, `parsing_application.published_run_id`, `mapping.current_revision_id`, `parsing_profile.reference_application_id`)는 두 테이블 생성 뒤 `ALTER TABLE ... ADD CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED`로 건다. `tests/test_schema_v3_postgres.py`가 pglast로 구문을 검증하고 SQLite DDL과 테이블·컬럼 집합이 같은지 비교한다(런타임 미검증을 문서에 명시).

### 1.9 snapshot 바인딩 불변식

`sheet`·`source_region`·`application_sheet`·`mapping`·`mapping_revision`·`mapping_region`·`extraction_run`·`extracted_value`·`extracted_value_region`은 모두 `snapshot_id`를 갖고 복합 FK로 부모와 같은 snapshot임을 DB가 강제한다. "다른 snapshot의 시트/영역/리비전을 가리키는 행"은 만들 수 없다(`tests/test_schema_v3.py` 'snapshot 바인딩').

---

## 2. Canonical Parsing Profile JSON (DSL 3.0)

파일 하나가 프로파일 한 리비전이다. v2 템플릿 JSON의 상위 호환이며 identity §8.1·§9의 요소를 더한다.

```jsonc
{
  "format": "parsing-profile", "schema_version": "3.0",
  "profile_name": "공정데이터_A양식", "schema_key": "process_standard", "description": "...",
  "sheet_roles": {
    "main":   {"cardinality": "one",  "match": {"name": "공정 기록"}},
    "common": {"cardinality": "one",  "match": {"any_of": [{"name_regex": "^공통"}, {"contains_text": {"texts": ["온도 단위"], "within": "A1:AD30", "mode": "any"}}]}},
    "exp":    {"cardinality": "many", "match": {"name_regex": "^\\d+C$"}}
  },
  "anchors": {
    "hdr_temp": {"sheet_role": "main", "find": {"texts": ["온도"], "within": "A1:Z60"}},
    "hdr_lot":  {"sheet_role": "main", "find": {"regex": "^(배치|LOT)$", "within": "A1:Z60"}},
    "table":    {"all_of": ["hdr_lot", "hdr_temp"]}
  },
  "rules": [
    {
      "rule_key": "lot", "rule_name": "배치", "field_key": "lot",
      "selector": {
        "key":   {"areas": [{"sheet_role": "main", "anchor": "hdr_lot"}], "repeat": "once"},
        "value": {"areas": [{"sheet_role": "main", "relative": {"row": 1, "col": 0, "rows": 65, "cols": 1}}],
                  "cardinality": "list", "axis": "down", "element_layout": "one_per_row", "stop": {"kind": "blank_run", "count": 2}}
      },
      "value_spec": {"type": "text"}, "record_spec": {"scope": ["process-table"], "key": "physical_row"}
    },
    {
      "rule_key": "temperature", "rule_name": "온도", "field_key": "temperature",
      "selector": {
        "key":   {"areas": [{"sheet_role": "main", "anchor": "hdr_temp"}], "repeat": "once", "separator": " "},
        "value": {"areas": [{"sheet_role": "main", "relative": {"row": 1, "col": 0, "rows": 65, "cols": 1}}],
                  "cardinality": "list", "axis": "down", "element_layout": "one_per_row",
                  "stop": {"kind": "blank_run", "count": 2, "max_items": 10000}, "combine": "ordered_union"},
        "unit":  {"areas": [{"sheet_role": "main", "relative": {"row": 0, "col": 1, "anchor": "hdr_temp"}}]},
        "context": {"areas": [{"sheet_role": "main", "range": "A1"}]}
      },
      "value_spec": {"type": "decimal", "unit": "°C", "source_unit": null,
                     "normalization": {"operation": "pipeline", "version": "2",
                                       "steps": [{"op": "trim_text"}, {"op": "split_delimiter", "delimiter": "/", "index": 0}, {"op": "split_unit_suffix"}]}},
      "record_spec": {"scope": ["process-table"], "key": "physical_row"},
      "relations": [{"to_rule": "lot", "kind": "same_row"}]
    }
  ]
}
```

### 2.1 문법

- **sheet_roles[role].match**는 다음 중 하나: `name`(시트 제목 원문과 정확 일치, v2 `names`와 같음) | `name_regex`(시트 제목 원문에 `re.search`; 검증 규칙은 `find.regex`와 같음) | `ordinal`(0부터, 워크북 순서) | `contains_text{texts[1~20], within(기본 A1:AD30), mode: any|all(기본 any)}`(셀 텍스트 정확 일치, `find.texts` 규칙; v1 `headers` = any) | `any_of: [matcher, ...]`(OR). 한 시트가 여러 role에 바인딩될 수 있다. `many`의 바인딩 순서(=`application_sheet.ordinal`)는 워크북 시트 순서. `one`은 정확히 1개 매치여야 하며 0개 또는 2개 이상이면 incompatible.
- **area**는 `range | find | relative | anchor` 중 **하나**.
  - `find`는 `texts` 또는 `regex` 중 하나 + 선택 `within`(texts 기본 `A1:AZ100`, regex는 **필수**, 10,000셀 이하) + 선택 `occurrence`(0-기반; 범위 밖이면 빈 결과).
  - `texts`: 셀 텍스트와 정확 일치. 양쪽을 v2 `norm()`(NFKC → casefold → 공백 축약)으로 정규화한다.
  - `regex`: Python `re`. 검증 시 `re.compile` 실패 또는 256자 초과 → `INVALID_REGEX`. 플래그는 인라인(`(?i)`)만. **무제한 반복(상한 16 이상) 안에 또 다른 반복이나 선택(`|`)을 겹쳐 쓰면 `INVALID_REGEX`**(예: `(a+)+`, `(a|a?)*`, `(\w+\s?)*` — Reader 프로세스에서 셀 1만 개에 대해 돌므로 지수 역추적 패턴을 저장 단계에서 거른다; `[^\s]+ [^\s]+`처럼 나란한 반복은 허용). 매칭은 NFKC 정규화 + 공백 축약한 셀 텍스트(`str(value)` 앞 1,024자, casefold 하지 않음)에 `re.search`. 전체 일치는 `^...$`. (예제 `^(배치|LOT)$`는 `LOT`에 매치, `lot`에는 매치하지 않는다.)
  - 공통: 병합 범위는 왼쪽 위 셀만 검사하고 region 단위로 중복 제거(v2 `region`). 값이 `None`인 셀은 검사하지 않는다.
  - `relative: {row, col, rows=1, cols=1, anchor?}`. 기준 영역은 `relative.anchor`가 있으면 그 이름 앵커의 해결 영역, 없으면 이 rule의 `key.areas[0]`이 해결된 영역(병합이면 병합 범위). 기준 셀은 기준 영역의 `(r1, c1)`. 기준 영역은 `relative` 영역과 같은 `sheet_role`이어야 한다(`repeat: each`인 키에서는 키가 발견된 그 시트의 앵커). 검증(`INVALID_SELECTOR`/`INVALID_ANCHOR`): `key.areas[0]`이 `relative`이면 `relative.anchor` 필수; `relative.anchor`는 `anchors`에 있어야 하고 sheet_role이 같아야 한다.
  - `anchor: name`: 이름 앵커의 해결 영역을 그대로 쓴다. area의 `sheet_role`은 앵커의 `sheet_role`과 같아야 한다.
- **anchors[name]**은 `{sheet_role, find}`(단일) 또는 `{all_of: [name, ...]}`(composite, 2~8개, 깊이 1, 멤버는 모두 단일 앵커이고 같은 `sheet_role`) 중 하나(3.0은 `all_of`만). 해결(엔진·매치 판정 공통; `many` role은 바인딩된 시트마다 따로): 앵커의 `find`는 정확히 한 영역으로 해결돼야 한다 — 히트 0 → 앵커 실패(매치 판정 incompatible + `missing`, 추출 `ANCHOR_NOT_FOUND`), 히트 2개 이상이고 `occurrence` 없음 → `AMBIGUOUS_ANCHOR`(일반 area의 `find`는 v2대로 모든 히트). composite의 해결 영역은 멤버 영역(병합 포함)의 bounding box, 멤버 하나라도 실패하면 실패; `relative` 기준은 box의 `r1,c1`. composite를 키로 쓰면 `observed_key`는 멤버 텍스트를 `all_of` 순서로 `separator`로 이은 값, `KEY_AREA_LIMIT`는 멤버별, `mapping_region role=key`는 멤버별 기록. `compile_rule`은 앵커 참조를 `{sheet_role, find}` 또는 `{sheet_role, all_of: [{find}, {find}]}`로 인라인한다(앵커 이름은 `effective_spec.anchor_name`으로 남긴다).
- **rules[].field_key**는 선택(없으면 `parsing_rule.default_field_id = NULL`, 리비전은 proposed까지만). 있으면 스키마의 active 필드여야 하고(`UNKNOWN_FIELD`) group이면 `GROUP_FIELD_TARGET`.
- **value**: `cardinality scalar|list|matrix`, `axis none|down|right|row_major|column_major`, `element_layout each_cell|one_per_row|one_per_column`, `stop {kind: explicit_areas|blank_run, count, max_items}`, `combine ordered_union|concat|sum`, `separator`, `merge_policy anchor_once`, `blank_policy preserve` — 의미와 한도는 v2 `spec.validate_rule`과 같다.
- **기본값(v2 런타임과 동일하게 채움)**: `key.repeat=once`; `value.cardinality=scalar`, `axis=none`; `element_layout`: list+down → `one_per_row`, list+right → `one_per_column`, 그 외 `each_cell`(v2 `XlsxReader.extract` 런타임 기본; spec.py의 검증용 `each_cell`과 다름); `stop={kind: explicit_areas, max_items: 10000}`; `combine=ordered_union`; `separator=' '`; `value_spec={type: text, formula_policy: cached_only, normalization: {operation: identity, version: '1'}}`; `find.within=A1:AZ100`(texts); `record_spec` 없음(→ `{scope: [rule_key], key: coordinate}`).
- **normalization**: `operation identity|trim|affine|pipeline`. `steps[].op`: v2의 `trim_text|strip_thousands|split_unit_suffix|percent_to_ratio|automatic` + **`split_delimiter`** `{"op":"split_delimiter","delimiter":<1~8자>,"index":<정수; 음수는 뒤에서>,"strip":true}`(identity §9). `split_delimiter`는 type text·decimal에 허용, 문자열 값에만 작동(비문자열 통과), 어느 위치든 가능, 조각 없음 → `value_state='null'`. 검증·실행은 `kg/v3/normalization.py`: `validate_pipeline`은 v2 규칙(1~16 step, v2 op는 `op` 키만, decimal 전용 op 타입 검사)을 적용하되 `split_delimiter`에만 `delimiter/index/strip` 허용; `prepare(value, normal, target)`은 step 목록을 `split_delimiter` 기준으로 잘라 v2 구간은 `kg.v2.normalization.prepare`에 부분 파이프라인으로 위임하고 `split_delimiter`는 직접 처리, unit/ratio는 마지막 값. `split_delimiter`가 포함되면 `version='2'`로 저장(그 외 `'1'` 유지). v2 `spec.validate_rule`의 normalization 분기는 호출하지 않는다.
- **relations[]** = `{to_rule, kind: same_row|same_column|offset, row?, col?}`(offset은 row·col 필수). **의미는 record_key 유도이며 값 영역을 바꾸지 않는다.** 엔진은 `to_rule` 기준 위상 정렬로 `to_rule`을 먼저 실행한다. 이 rule의 각 item에 대해 같은 primary sheet의 `to_rule` item(그 시트의 모든 group, `repeat: each` 포함) 중 조건을 만족하는 첫 item(item_index 오름차순)을 짝으로 삼는다: `same_row` = 짝의 값 영역 r1..r2가 이 item 값 영역의 r1을 포함; `same_column` = 짝의 c1..c2가 이 item의 c1을 포함; `offset` = 짝의 값 영역이 셀 (r1+row, c1+col)을 포함. 짝이 있으면 `record_key := 짝의 record_key`, `extracted_value_region(role='record_key')`에 짝의 value 영역, `derivation_key`에 `relation:<to_rule>:<kind>`; `record_spec.key`보다 우선(짝이 없을 때 대체). 짝도 `record_spec.key`도 없으면 `record_key = NULL`(실패 아님). 최대 4개, 첫 번째로 짝을 찾은 relation 사용. 검증(`INVALID_RELATION`): `to_rule` 없음, 자기 참조·순환, primary `sheet_role` 다름, 어느 쪽이든 `cardinality=scalar`, `offset`에 row/col 누락. `compile_rule`은 relations를 그대로 보존한다.
- 한도: 프로파일 512KB, sheet_roles 1~16, rules 1~200, area 1~32, anchors 64, relations 4.
- **검증기** `kg/v3/profile.py`: `validate_profile(json, schema_fields) -> canonical(dict)`(기본값 채움; 오류 `Problem(code)`: v2 `INVALID_*`·`RANGE_LIMIT`·`UNSUPPORTED_*` 유지 + `INVALID_ANCHOR`·`INVALID_RELATION`·`INVALID_REGEX`·`UNKNOWN_FIELD`·`GROUP_FIELD_TARGET`·`UNKNOWN_SCHEMA`·`SCHEMA_MISMATCH`). `compile_rule(rule, anchors) -> effective_spec`(앵커 인라인, relations 보존; 자기완결 rule이며 `mapping_revision.effective_spec_json`에 고정). `compile_profile(canonical) -> {rule_key: effective_spec}`.
- **Import Adapter** `kg/v3/adapters.py`: `detect_format(obj) -> 'parsing-profile-3.0' | 'v2-template' | 'v1-parsing-template' | 'generic-keyvalue'`, `to_canonical(obj, schema_key, schema_fields) -> (canonical, report{format_detected, warnings[{code, path, message}]})`. 3.0 입력은 정의의 `schema_key`가 요청 `schema_key`와 같아야 한다(`SCHEMA_MISMATCH`).
  - v2-template(`sheet_roles/rules[concept_id]`): `concept_id → field_key`(NULL이면 field_key 생략 + `MISSING_FIELD` 경고), `kg_revision_id/format/schema_version` 버림(경고), 나머지 그대로.
  - v1-parsing-template(`sheet_templates[].{name, match, mappings[]}`): role = sheet template name. `match.names` 1개 → `match.name` + `cardinality one`; n개 → `name_regex ^(?:a|b)$`(re.escape) + `many`; `headers` → `contains_text{texts, within A1:AD30, mode any}`; 둘 다 → `any_of`. `source.key_search + offset` → `key.areas[0] = {find: {texts: key_search, within: A1:AZ100, occurrence: 0}}`, `value.areas[0] = {relative: {row: offset.row|0, col: offset.col|1}}`, scalar; 경고 `KEY_SEARCH_WINDOW`(v1은 시트 전체 검색), `CASEFOLD_MATCH`. `source.range`(키 없음) → `key.areas[0] = {find: {texts: dedupe([mapping.key, field.name, *aliases]), occurrence: 0}}`, `value.areas[0] = {range}`(1×1 scalar, 1×n list/right, n×1 list/down, m×n matrix/row_major) + 경고 `KEY_INFERRED`. `value_type number → decimal`, `unit`·`normalization.target_unit → value_spec.unit`(변환은 빌드에서), `key → rule_key`, `concept_id → field_key`.
  - generic-keyvalue(`{"fields":[{"name","sheet","cell"|"label","offset","type","unit"}]}`): `sheet → role(name match)`, `cell → range`, `label → find.texts + relative(offset)`.

Schema 정의 JSON(`schemas/<schema_key>/r%04d.json`):

```jsonc
{"format": "parsing-schema", "schema_version": "3.0", "schema_key": "process_standard", "schema_name": "공정 데이터 표준",
 "fields": [{"field_key": "process", "name": "공정 정보", "type": "group", "level": 1},
            {"field_key": "temperature", "name": "온도", "type": "decimal", "unit": "°C", "level": 2, "parents": ["process"],
             "aliases": ["온도값", "Temp"], "description": "공정 설정 온도", "related": ["pressure"]}]}
```

`parents`는 배열(문자열 하나도 받아 정규화; projection은 항목마다 `parent_of` 간선). `schema_key`는 사람이 읽는 안정 키.

---

## 3. 실행 엔진과 Reader (`kg/v3/engine.py`, `kg/v3/readers.py`)

### 3.1 엔진
- 입력: 열린 workbook 2개(raw/cached, v2 방식), `bindings{role:[sheet_name]}`, `effective_spec` 목록(`compile_rule` 결과 또는 리비전의 `effective_spec_json`).
- 출력 이벤트 스트림: `{"type":"group", group_key, rule_key, observed_key, primary_sheet, regions{key,value,unit,context}}` → `{"type":"values", group_key, items[{item_index, record_key, raw_text, display_text, value_text, value_type, value_state, unit_raw, unit_normalized, formula_state, regions{key,value,unit,context,record_key,input}}]}`(배치 ≤ 200) → `{"type":"verified", token}`. v2 `XlsxReader.extract`의 리스트/행렬/병합/stop/결합/업무키 로직을 가져오되 `find.regex`, 이름 앵커·composite, `relative.anchor`, `relations`, `split_delimiter`를 더한다. 오류 코드: v2 `KEY_NOT_FOUND/AMBIGUOUS_KEY/AREA_NOT_FOUND/VALUE_NOT_FOUND/...` + `ANCHOR_NOT_FOUND`·`AMBIGUOUS_ANCHOR`(`relative` 기준 미해결은 `ANCHOR_NOT_FOUND`).
- 값 정규화는 모두 `kg.v3.normalization.prepare`를 거친다(v2 `readers.py`의 `prepare` 호출 경로는 `extract` 교체와 함께 대체).

### 3.2 Reader 계약
`make_reader(root, provider, principal)`; `XlsxReader(v2 상속)`. 연산:
- `describe(source_ref, profiles=[])` → 시트·서명(`structure-v2`)·권한 + `token` + (profiles가 있으면 같은 프로세스에서) `matches[{profile_id, profile_rev, bindings, compatibility, match_signature, missing, resolved}]`. 등록 시 Reader 프로세스 **1회**, 워크북 로드 **1회**(시트 목록·서명·매치가 같은 `data_only` 워크북을 쓴다), 파일 해시는 시작·끝 2회.
- `match(source_ref, expected_token, profiles)` → `matches[]`(새 snapshot 승계·rematch·test_profile용). `match_specs(source_ref, expected_token, specs, bindings_hint)` → `{bindings, resolved, missing, match_signature}`(§4.4 승계용).
- `extract(source_ref, expected_token, specs, bindings)` → §3.1 스트림.
- `render(source_ref, expected_token, sheet_name, r1=1, c1=1, rows=2000, cols=200)` → 스트림 `{type:'meta', renderer_version, mode:'native'|'simplified', layout_revision=token, sheet, rows[{index,y,height}], columns[{index,x,width}], styles[...], merges, freeze, width, height, estimated_rows, estimated_cols, truncated, rendered_bounds{r2,c2}, band_rows:100}` → `{type:'band', r1, r2, cells[{r1,c1,r2,c2,text,s}]}`(100행 밴드, 빈 셀 생략, `s`=styles 인덱스; 한 밴드가 6MB를 넘으면 50/25행으로 분할) → `{type:'image', asset_id(sha256), ext, x, y, width, height, bytes(base64, ≤2MB)}` → `{type:'verified', token}`. 모든 이벤트 ≤ 8MB. `XlsxReader.render`는 openpyxl 구현이며 경로를 내부에서만 해석한다(호출자는 경로를 주지 않는다). DRM Reader는 자체 `render_viewport/read_regions`(db-schema-v2 §8)로 구현하며 해제본 파일을 만들지 않는다; 불가하면 `RENDER_UNSUPPORTED`(UI "간략 보기 미지원"). `authorize(required='render')`의 `can_render_web` 필요, `can_cache_derivative=false`면 파일 캐시 없이 메모리만.
- 격리: `kg/v3/jobs.py`(v2 복사·수정)의 `_reader_child`는 `extract`·`render`·`describe`·`match` 모두 이벤트 스트림으로 취급한다. 한도 환경변수 `KG_V3_READER_TIMEOUT_SECONDS/MEMORY_MB/FACTORY`(없으면 `KG_V2_*` 폴백). 프로세스 시작 방식은 `KG_V3_READER_CONTEXT`(기본 `forkserver` + `kg.v3.readers` 미리 import → 연산마다 인터프리터를 새로 띄우지 않는다; `spawn`으로 되돌릴 수 있다). 자식은 호출 시점의 `KG_*` 환경변수를 명시적으로 넘겨받는다. 메인 API의 `authorize`는 local-xlsx가 아닌 provider에 대해 (principal, 원본, token, 권한)별로 30초 동안 결과를 기억한다.

### 3.3 매치 판정 (`kg/v3/engine.py: match_profile(profile_canonical, wb, sheets, reference=None)` — Reader 안에서 호출되는 순수 함수)
1. `sheet_roles[].match`로 시트 바인딩. 실패 → `incompatible`(`missing: [{role}]`).
2. 각 rule의 **모든** role(key/value/unit/context)에서 `find`·`anchor`(composite 포함)로 지정된 영역과 `relative` 기준을 해결한다. 하나라도 없으면 `incompatible`(`missing: [{rule_key, role}]`). `relations[].to_rule`이 missing이면 incompatible.
3. **매치 서명** = 정렬된 `[rule_key, sheet_role, key locator, value locator, unit locator, context locator]`(각 `sheet_name!range`, 미지정 role은 null, composite는 멤버 목록)의 SHA-256(`profile_rev` 종속). `reference={signature, profile_rev}`가 주어지고 `signature`가 같고 `profile_rev == 현재 rev`이면 `identical`, 아니면 `compatible`. reference가 없으면(draft, 참조 미검증) 최대 `compatible`.
4. Reader 한도 초과(`READER_TIMEOUT`/메모리)는 `{compatibility: 'incompatible', missing: ['*'], error: code}`.

### 3.4 서명 두 종류
- **구조 서명**(`snapshot_signature`, `structure-v2`): 문서 자체의 라벨 구조(프로파일 무관). `unmatched` 묶음에만.
- **매치 서명**(`parsing_application.match_signature`, `parsing_profile.reference_signature`): 프로파일 rev에 종속. 자동 승인 판정에만.

---

## 4. 서비스 규칙 (`kg/v3/service.py`)

### 4.1 문서 등록 (`register`)
`source_ref`는 저장·조회 전에 정규화한다(`posixpath.normpath`; `a.xlsx`·`./a.xlsx`·`sub/../a.xlsx`는 같은 문서, 절대 경로·`..` 상위 이동은 422 `INVALID_SOURCE`). `describe(profiles = status='approved' 전부)` 1회 → `document`(provider, 정규화한 source_path로 upsert) + snapshot 판정(describe `token`이 **현재** snapshot의 `change_token`과 같으면 새 snapshot 없음; 다르면 §4.4) + `sheet` + `snapshot_signature` → 같은 작업에서 `auto_apply`(§4.3, describe의 `matches[]` 사용) → `refresh_document_status`. 잠긴 파일(PK 매직 아님·DRM Reader 미등록)은 작업 `failed(DRM_READER_REQUIRED)`, `document.status='locked'`, `last_error` 기록(문서 행은 남는다).
`provider`는 작업을 만들기 전에 검증한다: `'local-xlsx'`이거나 Reader 어댑터(`KG_V3_READER_FACTORY`)가 연결돼 있어야 하고, 아니면 422 `UNKNOWN_PROVIDER`(알 수 없는 provider로 잠긴 문서 행을 양산하지 않는다).
`local-xlsx`는 등록 전후 stat이 같으면 `source_digest`(§1.6)에 `(byte_size, mtime_ns, snapshot.change_token)`을 기록한다 — watch·단일 등록·폴더 일괄 등록 어느 경로로 들어와도 다음 폴더 미리보기(§4.1.1)가 파일을 다시 읽지 않는다.

#### 4.1.1 폴더 일괄 등록 (`scan_sources(directory)`, `register_directory(directory, provider, include_unchanged)`)
사용자는 파일을 하나씩 고르지 않고 **루트 폴더 하나를 지정**하면 그 아래(하위 폴더 포함) 전부를 등록한다.
- `directory`는 `data/raw` 기준 상대 폴더(`""` = 최상위). 정규화는 source_ref와 같다(`posixpath.normpath`; 절대 경로·`..` 상위 이동 → 422 `INVALID_SOURCE`; 없는 폴더 → 404 `SOURCE_NOT_FOUND`). 심볼릭 링크는 폴더든 파일이든 따라가지 않는다(건너뜀 `symlink`). `.`으로 시작하는 폴더는 들어가지 않는다.
- 스캔(`os.scandir` 재귀, 폴더·파일 이름 순으로 결정적): 대상은 확장자 `.xlsx|.xlsm|.xls`(대소문자 무시). `~$`로 시작하는 파일은 `temp`, 그 밖의 확장자는 `unsupported`로 세기만 한다. 걸은 항목 200,000개 또는 대상 파일이 `register_directory_files`(기본 10,000, `KG_V3_REGISTER_DIRECTORY_LIMIT`)를 넘으면 413 `DIRECTORY_LIMIT`("하위 폴더를 나누어 등록하세요"). 스캔은 **Reader 프로세스를 띄우지 않는다**(메인 프로세스에서 stat과 해시만).
- 파일 분류(`state`): `document(provider, source_path)` 행이 없으면 `new`; 있고 `status='locked'`면 `locked`; 있고 현재 snapshot이 없으면 `changed`; 있으면 현재 snapshot의 `change_token`과 파일 내용 해시(`file_hash`, Reader와 같은 SHA-256)를 비교해 같으면 `unchanged`, 다르면 `changed`. 해시 전에 `document_snapshot.byte_size`와 파일 크기가 다르면 해시 없이 `changed`. 해시는 `source_digest`(§1.6)에 `(byte_size, mtime_ns)`가 같으면 재사용한다. `local-xlsx`가 아닌 provider는 파일 내용을 메인 프로세스가 읽을 수 없으므로 등록 여부만 보고 `new|registered`로 두고 항상 Reader에 보낸다(`registered`는 대상에 포함).
- 등록 대상: 기본 `new + changed`(+ 다른 provider의 `registered`). `include_unchanged: true`면 `unchanged`·`locked`도 다시 읽는다(잠긴 파일은 Reader가 연결됐을 때 다시 시도하는 용도).
- `GET /sources/scan?directory=` → `{directory, folders, files, states{new, changed, unchanged, locked}, skipped{temp, unsupported, symlink}, targeted, limit, sample[≤20 {source_ref, state}]}`. `files`는 대상 확장자 파일 수, `targeted`는 기본 설정(include_unchanged=false)의 등록 대상 수.
- `POST /documents/register-directory {directory, provider='local-xlsx', include_unchanged=false} (job, wait)` → `runtime_job kind='register'`(payload `{directory, provider, include_unchanged, recursive: true}`, `target_kind='workspace'`, label `"<폴더 마지막 이름 또는 '원본 폴더'> 폴더 일괄 등록"`). 작업은 스캔 → `checkpoint(0, targeted)` → 대상 파일을 정렬 순서대로 §4.1 `register`로 처리(파일마다 `checkpoint(n)`; 취소하면 그때까지 등록된 문서는 남고 `cancelled`). 파일 하나의 Problem은 그 행의 `error`로 남기고 다음 파일로 간다(§4.1 단일 등록과 달리 **전부 실패해도 작업은 `succeeded`**, 요약이 결과물이다; 스캔 자체의 Problem만 작업 `failed`). 등록 전 stat을 잡아 두고 등록 뒤 stat이 같으면 `source_digest`에 `(byte_size, mtime_ns, snapshot.change_token)`을 기록해 다음 스캔이 파일을 읽지 않게 한다.
- 결과 `{directory, summary{found, targeted, registered, new, changed, unchanged, failed, locked, skipped{temp, unsupported, symlink}}, documents[≤500: §4.1 행 + source_ref + state(스캔 분류)], truncated}`. `registered`는 오류 없이 끝난 대상 수(새 snapshot 없이 `unchanged`로 끝난 재읽기도 포함), `unchanged`는 스캔에서 변경 없음으로 분류된 수(건너뛴 수 + include_unchanged로 다시 읽은 수), `locked`는 스캔의 locked + 이번에 `DRM_READER_REQUIRED`로 끝난 수. `documents`가 500행을 넘으면 앞 500행만 남기고 `truncated: true`(요약은 항상 전체 기준).
- 단일 파일 등록(§4.1 `POST /documents/register`)은 그대로 둔다. `python -m kg.v3 watch`는 기본으로 하위 폴더까지 감시한다(`--no-recursive`로 최상위만).

### 4.2 정의 가져오기
`import_schema(definition)`: projection upsert(추가·갱신·deprecated 표시, 삭제 없음) + `current_rev` 증가 + 파일 저장 — 파일은 projection이 통과한 뒤 같은 트랜잭션의 커밋 직전에 쓰고, 거부(`GROUP_FIELD_TARGET`·`PROFILE_NAME_CONFLICT` 등)되면 `r%04d.json`을 남기지 않고 `current.json`을 되돌린다(파일이 진실이므로 유령 리비전 금지). `schema_key`는 영숫자로 시작해야 한다(`.`/`..` 같은 경로 조각 금지).
 `import_profile(schema_key, definition, format='auto')`: adapter → validate → 파일 저장 + rule projection, `current_rev` 증가, `status` 유지. approved 프로파일에 새 리비전을 저장하면 `reference_profile_rev`는 그대로 남아 §4.3 자동 승인이 **중단**된다(모든 매치가 compatible → proposed); `approve_profile`(§4.8) 재호출 또는 `reparse(mode='rematch')`가 참조 적용 건을 새 rev로 재검증해 `reference_profile_rev/reference_signature`를 갱신하면 재개된다.

### 4.3 자동 적용 (`auto_apply(snapshot_id, matches)`) — 신규 문서·수동 등록
`status='approved'` 프로파일만 대상(draft·deprecated 제외). `incompatible` 건너뜀. 매치되면 `parsing_application(origin='auto', compatibility, match_signature)` + `application_sheet` + rule별 `mapping` + 리비전 1개(`expected_seq=0`):
- `identical` **and** 프로파일 approved **and** rule에 `default_field_id`가 있음 → `status='approved', origin='auto', evidence_json={reference_revision_id, profile_rev, match_signature}` → 헤드 전부 approved면 같은 작업에서 추출(§4.6, `auto_approved=1`)·발행. **사람 개입 없음**(identity §5·§6; v3-decisions §1).
- `compatible`, 또는 `default_field_id` 없음(사유 `FIELD_REQUIRED`) → `status='proposed', origin='profile'` → "매핑 검수" 큐.
여러 프로파일이 매치되면 모두 적용(N:M, `scope_key='default'`). 매치 없음 → `document.status='unmatched'`("프로파일 없음" 큐, 구조 서명으로 묶음).
draft 프로파일을 문서에 붙이는 경로는 §4.7 `test_profile`(저장 없음)과 `POST /snapshots/{sid}/applications {profile_id}`(origin='manual', compatibility='manual', 리비전 proposed/origin profile)뿐이다.

### 4.4 새 snapshot (UC-5)
같은 `document`에 다른 `change_token`이 등록되면 새 snapshot(`revision_no+1`) + `current_snapshot_id` 갱신 + `RenderClient.invalidate(previous_snapshot_id)`. 과거 snapshot과 token이 같아도(A→B→A) 새 snapshot을 만든다. 이전 snapshot의 application마다 이전 헤드 리비전들의 `effective_spec_json` 목록으로 `match_specs`를 실행하고, 기준 서명은 이전 헤드들의 `mapping_region`(role key/value/unit/context)에서 만든 매치 서명이다.
- identical 또는 compatible → 새 `parsing_application(origin='inherited', profile_rev·schema_rev = 이전 값, compatibility)` + rule별 리비전 1개: `effective_spec_json·field_id·observed_key`는 이전 헤드에서 복사, `mapping_region`은 새 snapshot에서 해결된 region으로 다시 기록, **`status='proposed', origin='inherited'`**, `evidence_json={previous_application_id, previous_revision_id, compatibility, previous_signature, new_signature}` → "변경 감지" 큐. **자동 승인 없음**(core §6.1, reply §5-1 1-2; v3-decisions §1). 큐 항목의 대표 행동은 `approve_all`(identical이면 승인+추출+발행이 요청 1회).
- incompatible → application 없이 "변경 감지 · 프로파일 불일치" 큐(`document.status='changed'`).
이전 snapshot의 값은 그대로 남는다(불변). 문서 목록·빌드는 `current_snapshot_id` 기준이며 승인 전까지 `published_run_id`가 없으므로 빌드에서 `review_required`로 제외된다. 프로파일 새 리비전 반영은 §4.9 `rematch`가 담당한다(승계 시 profile_rev를 올리지 않는다).

### 4.5 매핑 검수 (`revise`, `approve_all`, `rollback`)
`POST /mappings/{mid}/revisions {expected_seq, status, field_key?, effective_spec?, regions?, reason?, extract?}` → 새 리비전(`revision_no = expected_seq + 1`, §1.4 트리거; 충돌 시 리비전·영역 모두 롤백, 409 `EDIT_CONFLICT`) + 헤드 갱신. `regions?: [{role, sheet_id, range}]`는 서버가 `source_region(kind='cells', locator_key=range)` upsert 후 `mapping_region`에 기록. `field_key`는 proposed/rejected에서 선택, `approved`면 결과 리비전이 group이 아닌 필드로 해석돼야 한다(명시 `field_key` → 이전 헤드 `field_id` → rule `default_field_id` 순; 없으면 422 `FIELD_REQUIRED`). 승인된 헤드가 바뀌면 `published_run_id`가 NULL이 되어 "재추출 필요".
**승인 후 자동 재추출**: `extract: true`(기본)면 application의 헤드가 모두 approved일 때 같은 요청에서 추출을 큐에 넣고 `wait`까지 처리한다(검수→값 확인이 요청 1회). `approve_all`은 proposed 헤드 전부를 approved 리비전으로 복제(같은 spec·field·regions, `origin='manual'`, reason)하고 추출한다. `rollback {expected_seq, target_revision_id}`는 과거 리비전을 복제한 새 리비전.

### 4.6 추출 (`extract(application_id)`)
헤드가 전부 `approved`여야 한다(아니면 422 `REVIEW_REQUIRED`, 미승인 rule 목록·상태). `extraction_run(queued, input_manifest)` → Reader 격리 실행 → 값·영역 저장(배치 200, 값당 영역 ≤ 1,000, 실행당 값 ≤ 1,000,000) → `succeeded` + `published_run_id`. 실패는 `error_summary`와 함께 `failed`(작업 내역 "파싱 실패", `document.status='failed'`; 자동 승인 뒤 실패면 `auto_approved: true` 표시).

### 4.7 프로파일 테스트 (`test_profile(profile_id | definition, snapshot_id)`)
저장하지 않는 dry-run: match → compile → 엔진 실행 → `{bindings, compatibility, match_signature, groups[{rule_key, field, observed_key, regions, values[:50], count}], errors[{code, message, rule_key?}]}`. `runtime_job kind='test'`(target profile, label `<profile_name> r<rev> · <document_name>`) 행을 남기되 결과 전체는 저장하지 않는다. 20초 상한 초과 시 200으로 그때까지의 groups + `errors[{code:'TEST_TIMEOUT'}]`. application 행을 만들지 않는다.

### 4.8 프로파일 승인 (`approve_profile(profile_id, application_id)`)
검증: application이 이 프로파일·문서의 현재 snapshot의 것(`INVALID_APPLICATION`), 헤드 전부 approved(`REVIEW_REQUIRED`). `reference_application_id`·`reference_profile_rev = current_rev`·`reference_signature = application.match_signature`(application.profile_rev가 다르면 reference snapshot에 `match`를 다시 실행; 실패 시 422 `REFERENCE_MISMATCH`), `status='approved'`. 승인 직후 같은 작업에서 `reparse(profile_id, 'rematch')`를 큐에 넣는다(승인 전에 등록된 unmatched 문서와 수동 적용 건 소급). 다른 application으로 다시 승인하면 참조가 바뀐다.

### 4.9 재파싱 (`reparse(profile_id, mode)`) — 작업
프로파일이 approved가 아니면 422 `PROFILE_NOT_APPROVED`. `mode='fill'`: 이 프로파일이 적용된 현재 snapshot 중 `published_run_id IS NULL`이고 헤드 전부 approved인 건을 추출. `mode='rematch'`: 이 프로파일의 적용 건 **및** 현재 snapshot에 이 프로파일 application이 없는 `unmatched` 문서. 적용 건은 `match` 재판정 → identical이면 승인 헤드(또는 사람 손을 거치지 않은 `origin='profile'|'auto'` proposed 헤드·리비전 없는 새 규칙)를 복제한 새 리비전(`approved`, `origin='auto'`, 새 profile_rev 스펙, evidence)을 추가하고 헤드를 옮긴 뒤 추출(`auto_approved=1`), compatible이면 proposed 리비전 추가; **승계 proposed 헤드(`origin='inherited'`)가 있는 application은 `review_required`로 건너뛴다**(§4.4의 새 snapshot 검수는 사람이 `approve_all`로 끝낸다; decisions §1), 수동 proposed·rejected 헤드는 identical이어도 proposed 리비전만 추가한다(`review_required`). 헤드가 전부 approved이고 미발행인 건은 `fill`이거나 헤드가 이미 현재 rev면 바로 추출하고, 옛 rev면 재매치해 새 스펙을 받은 뒤 추출한다. unmatched 문서는 §4.3 규칙으로 application 신설. 결과 `{queued, skipped[{document_id, document_name, reason}]}`.

### 4.10 데이터 빌드 (`build.py`)
입력 `{document_ids[] (current snapshot 기준), schema_key, columns[{field_key, header, target_unit?}], row_mode: 'record'|'document', format}`.
- `candidates(document_ids, schema_key?)` → `{documents[{document_id, document_name, usable, reason?: unmatched|review_required|failed|not_extracted|locked, profile{...}?}], summary{total, usable, excluded}, fields[{field_key, name, type, unit, document_count}]}`(schema_key가 있으면 필드별 "값 있는 문서 수").
- 대상: 각 문서의 current snapshot에서 `published_run_id`가 있는 application의 값(`current_value`). 제외 사유는 candidates와 같다.
- 행: `record` → `(snapshot, record_key)`마다 1행; scalar(record_key 없음) 값은 그 문서의 모든 행에 복제. `document` → 문서당 1행(리스트는 첫 값 + `<header>_count`).
- 같은 (행, field)에 값이 여럿이면 `source_identity_key`가 같은 것은 1개, 다르면 첫 값 + `conflicts[]`.
- 컬럼: header 비어 있음/중복 → 422 `INVALID_HEADER{fields}`. `target_unit`이 있고 `unit_normalized`가 다르면 `UnitRegistry`(`config/units.yaml`) affine 변환, 불가하면 conflict.
- Preview: 최대 50행, 각 셀 `{text, value_id, sheet_id, sheet_name, range, application_id, rule_key}`.
- Export: `data.csv`(UTF-8 BOM, CRLF) | `data.xlsx`(헤더 굵게, 너비 자동) | `data.sqlite`(테이블 `data`; 컬럼 = header; `_source_<header>` = `sheet!range`; `_document`, `_snapshot`(captured_at 날짜), `_record_key`). `manifest.json = {build_key, created_at, schema{key, rev}, sources[{document_id, document_name, snapshot_id, application_id, run_id, profile{id, name, rev}}], columns[{field_key, header, type, unit}], row_mode, row_count, excluded[], conflicts[]}`. 산출물 `<ws>/data/exports/<build_key>/`(build_key = 입력 SHA-256 앞 16자; 같은 입력이면 재사용).
- 문서 200개·행 20만 이하는 동기(그래도 `runtime_job kind='build'` 행), 초과는 비동기 작업.

### 4.11 작업 내역·검수 큐 (`operations.py`)
`queues()` → 요약 카운트 + 큐별 묶음 행 `{group_key, kind, cause, label, count, impact{documents, rules[]|fields[]}, representative{document_id, document_name, snapshot_id, application_id?, profile_id?}, actions[], write_actions[](actions 중 POST가 받는 것), next_action{kind, route, params?}(대표 문서로 가는 다음 행동: unmatched → create_profile `?screen=profiles&new=1&snapshot=`, review/failed/changed/conflict → open_review `?review=<application_id>`, 불일치 → open_document, locked → register_reader `?screen=settings#reader`)}`. `GET /queues`는 application 집계를 TEMP 테이블로 요청당 한 번만 계산한다:
- `unmatched`(프로파일 없음; `group_key` = 구조 서명 sha256; "신규 양식 후보 · N문서"; actions `create_profile`, `assign_profile`)
- `review`(proposed·rejected·NULL 헤드가 있는 application; `group_key` = profile_id; actions `open_review`, `approve_all`)
- `failed`(마지막 실행 failed/cancelled(발행 여부 무관 — §4.12 `failed`와 같은 조건) 또는 locked; `group_key` = error_code|locked; actions `open_review`, `reparse`)
- `changed`(새 snapshot에서 inherited proposed 또는 불일치; `group_key` = profile_id|`incompatible`; actions `open_review`, `approve_all`(identical만 활성), `assign_profile`)
- `conflict`(단위 불일치·빌드 충돌; `group_key` = field_key; action `open_review`)
`actions` 중 `open_review`·`create_profile`은 이동, `assign_profile`·`approve_all`·`reparse`는 묶음 쓰기(`POST /queues/{kind}/groups/{group_key}/actions`, 작업 1개 `kind='queue_action'`, `total=count`, 결과 `{queued, skipped[]}`; 같은 묶음에 같은 내용의 작업이 queued/running이면 새로 만들지 않고 그 작업을 돌려준다(멱등); 404 `GROUP_NOT_FOUND`, 422 `ACTION_NOT_ALLOWED`). **같은 원인·같은 서명은 묶는다**(문서 단위 나열 금지). 멤버 목록은 `GET /queues/{kind}/groups/{group_key}/members`(행 `{document_id, document_name, snapshot_id, application_id, profile_id, profile_name, compatibility, state(큐 종류), document_status(§4.12 어휘), application_state(§6 application state 어휘 | null), detail{}, next_action{}}`). 묶음 처리 요청의 확인→제출은 프로세스 잠금으로 직렬화한다(동시에 두 번 눌러도 작업 1개).

### 4.12 문서 상태 (`refresh_document_status(document_id)`)
등록·자동 적용·새 snapshot·검수·추출 완료·재파싱 끝에 호출. 현재 snapshot 기준, 먼저 맞는 것: `locked`(등록 실패 DRM_READER_REQUIRED) → `not_extracted`(snapshot 없음, 또는 application은 있는데 실행이 없고 proposed도 없음) → `unmatched`(application 없음) → `changed`(inherited proposed 헤드 또는 §4.4 불일치) → `review`(proposed/rejected/NULL 헤드) → `failed`(마지막 실행 failed/cancelled) → `normal`(전부 approved + published). `last_processed_at` = 관련 실행·작업의 max(finished_at), `last_error` = 마지막 실패 메시지.

---

## 5. 렌더 서버 (`kg/v3/render/`)

| 파일 | 책임 |
|---|---|
| `assemble.py` | Reader `render` 이벤트 스트림 → 캐시 파일(`meta.json` + `band-<r1>-<r2>.json` + `assets/<sha256>.<ext>`). 상한 2,000행 × 200열 **또는** 비어 있지 않은 셀 200,000개 **또는** 직렬화 24MB(먼저 닿는 것) → `truncated: true`, `rendered_bounds`. base64 인라인 금지; `images[].asset_id='<sha256>.<ext>'`, `images[].url='/api/v3/snapshots/{snapshot_id}/render-assets/{asset_id}'`. 쓰기는 `<name>.tmp` → `os.replace`. |
| `cache.py` | 키 `(snapshot_id, sheet_id, renderer_version)` → 디렉터리. `window(key, range)`는 `meta.json` + range와 교차하는 밴드만 읽어(≤100행 창이면 ≤2개) 열로 거른다 — O(창). 프로세스 내 LRU는 바이트 상한 `KG_V3_RENDER_LRU_MB`(기본 256), 디스크 캐시는 `KG_V3_RENDER_CACHE_MB`(기본 4096, 오래된 snapshot부터 제거). `put` 시 같은 시트의 다른 `renderer_version` 디렉터리를 삭제하고, 서버 시작 시 현재 `renderer_version`과 다른 것을 모두 지운다. `invalidate(snapshot_id)`는 세대 번호를 올려 진행 중 작업 결과를 버린다(`cancelled`). |
| `server.py` | FastAPI. `POST /render {snapshot_id, provider, source_ref, expected_token(=document_snapshot.change_token), sheet_id, sheet_name, range?(생략 = A1:Z60)}` → 캐시 있으면 **200** `{status:'cached', sheet}`; 같은 키 작업이 queued/running이면 새로 넣지 않고 **202** `{status:'queued'|'rendering', job_id, position}`(멱등); 없으면 큐에 넣고 202. 실패는 키별 60초 보관하고 Reader `Problem` status를 그대로(`DRM_READER_REQUIRED` 403, `SOURCE_VERSION_CHANGED` 409 → `SNAPSHOT_STALE`, `READER_TIMEOUT` 408, 한도 413, 그 외 422) `{status:'failed', error{code, message}, retry_after: 60}`. 큐 상한 `KG_V3_RENDER_QUEUE`(기본 32) → 503 `RENDER_QUEUE_FULL`. `GET /render/{snapshot_id}/sheets`, `GET /render/{snapshot_id}/sheet/{sheet_id}?range=` → 200 창 JSON | 202 | 4xx failed | 404 `NOT_RENDERED`. `GET /render/{snapshot_id}/assets/{asset_id}`. `DELETE /render/{snapshot_id}`. `GET /render/status {queue_depth, rendering, renderer_version, cache_bytes}`. 모든 엔드포인트는 메인 API와 같은 접근 토큰(`KG_V3_ACCESS_TOKEN`→`KG_V2_ACCESS_TOKEN`, 설정된 경우 401 `AUTH_REQUIRED`)을 요구하고 `RenderClient`(http)가 붙여 보낸다; `render-serve`는 루프백이 아닌 host에 토큰 없이 열 수 없다. 워커 1개(스레드 큐, `KG_V3_RENDER_CONCURRENCY` 기본 1). 렌더는 Reader 격리 프로세스(`KG_V3_READER_FACTORY`). 경로 검증: `snapshot_id`·`sheet_id` `^[0-9a-f-]{36}$`, `asset_id` `^[0-9a-f]{64}\.(png|jpe?g|gif)$`, 실제 경로 `is_relative_to(render_cache_root)` 아니면 404. ETag = `"sha256(renderer_version+snapshot_id+sheet_id+range)[:32]"`, `Cache-Control: private, no-cache`, `If-None-Match` 일치 시 304(asset은 ETag `"<asset_id>"`). `max-age`·`immutable`은 쓰지 않는다(권한 철회 즉시 반영). |
| `client.py` | `RenderClient`: `KG_V3_RENDER_URL`이 있으면 HTTP(httpx `Timeout(connect=0.5, read=2.0)` — 메인 API는 절대 렌더 완료를 기다리지 않는다), 없으면 in-process(같은 큐·캐시 클래스를 스레드로; 렌더 자체는 Reader 격리 프로세스). 연결 실패·타임아웃은 `RenderUnavailable` → 프록시 503 `RENDER_UNAVAILABLE` + `Retry-After: 5`(큐에 넣지 않음). `invalidate(snapshot_id)`. |

**창 JSON** = `{renderer_version, sheet{sheet_id, sheet_name}, range, rows[](캐시 범위 전체 ≤2,000, 원점 0·연속 누적), columns[](전체 ≤200), width, height, estimated_rows, estimated_cols, truncated, rendered_bounds, freeze, styles[], cells[](range와 교차하는 셀만, 병합 포함 한 번씩, 좌표는 전체 시트 기준 `r1,c1,r2,c2`; 창 밖으로 나가면 `clipped: true`; 빈 셀은 생략 — 덮이지 않은 좌표는 클라이언트가 기본 셀로 그림), merges[](교차만), images[](교차만)}`. 창 상한 120행 × 60열(초과 422 `RANGE_TOO_LARGE`), `range`는 `kg.v2.spec.bounds`로 파싱(실패 422 `INVALID_RANGE`), 캐시 범위 밖은 잘라서 `range`에 반영, 교차 없음 → 422 `RANGE_OUT_OF_BOUNDS{rendered_bounds}`.

메인 API 프록시: `GET /api/v3/snapshots/{sid}/sheets/{sheet_id}/render?range=` → `authorize(view)` **먼저** → 200 창 JSON | 202 `{status}` | 4xx failed 전달 | 503 `RENDER_UNAVAILABLE` | 404 `NOT_RENDERED`; `If-None-Match`/ETag 전달(304 포함). `GET /api/v3/snapshots/{sid}/render-assets/{asset_id}` → `authorize(view)` 후 스트리밍.
UI는 202를 받으면 **뷰어 영역만** "렌더링 중"을 표시하고 700ms 간격으로 같은 GET을 다시 부른다; 202가 아닌 응답이면 폴링을 멈추고, 실패면 `error.message` + `다시 시도`(`retry_after` 이후 활성), 503이면 "렌더 서버에 연결할 수 없음"(`console.error` 금지). 다른 화면·API는 영향 없음 — e2e HTTP 모드로 검증. `tests/test_v3_render.py`는 in-process 모드에서 렌더 중 캐시 창 응답 < 20ms를 확인한다.

---

## 6. API (`kg/v3/api.py`, prefix `/api/v3`)

공통: 오류 `{"error":{"code","message","fields?"}}`(모든 message는 한국어; Pydantic 검증 오류 `VALIDATION_ERROR`도 유형별 한국어 문장으로 옮기고 원문은 `fields[].detail`에 남긴다); 목록 `{"items","has_more","next_cursor"}`(keyset, `limit` 기본 50 최대 200); 쓰기는 Pydantic 모델(`contracts.py`, `extra=forbid`); 작업 응답 `JobResponse{job_id, kind, state, completed, total, result, error_code, error_message, target_kind, target_id, label, created_at, started_at, finished_at}`(목록 `GET /jobs`의 `result`는 축약본 — 20행을 넘는 배열은 본문 대신 `<key>_count`만 싣는다(§4.1.1 `documents[≤500]`로 목록이 수 MB가 되지 않게); 전문은 `GET /jobs/{id}`); 접근 토큰 `KG_V3_ACCESS_TOKEN`(없으면 `KG_V2_ACCESS_TOKEN`), principal `KG_V3_PRINCIPAL`. 본문 2MB 상한. `Cache-Control: no-store`(렌더 창·asset은 `private, no-cache` + ETag/304).
`?wait=<초>`(최대 60)를 받는 작업 엔드포인트는 그 시간까지 완료를 기다렸다가 최종 `JobResponse`를 돌려준다(기본 0 = 즉시 202).

| 화면 | Method 경로 | 요약 |
|---|---|---|
| 공통 | `GET /status` | `{version:'3', workspace(작업 공간 폴더 이름; 절대 경로는 노출하지 않는다 — `/settings`도 같다), render{mode:'http'|'inprocess', url, queue_depth, rendering}, counts{documents, profiles, schemas, jobs_running, review}}` |
| 공통 | `GET /search?q=` | 문서·프로파일·스키마·필드 통합 검색(각 최대 5건, `{kind, id, label, sublabel, route}`) — 헤더 검색창 |
| 공통 | `GET /settings` · `GET /normalization-presets` | 읽기 전용 설정(render 모드/URL, reader factory, 한도, 작업 공간) · 프리셋 |
| 문서 | `GET /sources?directory=` · `POST /documents/register {source_refs[], provider, document_id?} (job, wait)` | 원본 폴더 목록 · 등록(+자동 적용·추출까지 한 작업; 결과 `documents[{document_id, document_name, snapshot{...}, status, applied[{application_id, profile_id, profile_name, compatibility, state}], error?}]`; `applied[].state`는 추출·발행까지 끝난 최종 application 상태(자동 승인·발행이면 `published`)) |
| 문서 | `GET /sources/scan?directory=` · `POST /documents/register-directory {directory, provider, include_unchanged} (job, wait)` | §4.1.1 폴더 일괄 등록: 재귀 스캔 미리보기(`states{new, changed, unchanged, locked}`, `skipped`, `targeted`) · 폴더 아래 전부를 한 작업으로 등록(결과 `summary` + `documents[≤500]` + `truncated`) |
| 문서 | `GET /documents?q=&status=&profile_id=&schema_key=&sort=&cursor=&limit=` | `sort ∈ document_name|status|last_processed_at`(`-` 접두 내림차순, 기본 `-last_processed_at`). 행 `{document_id, document_name, provider, file_type, status, status_detail, current_snapshot{snapshot_id, revision_no, captured_at, change_token, content_sha256?}, profiles[{profile_id, profile_name, rev, application_id, state, compatibility}], schemas[{schema_key, schema_name}], last_processed_at, last_error}`(페이지 범위 요약) |
| 문서 | `GET /documents/{id}` · `GET /documents/{id}/snapshots` · `GET /snapshots/{sid}/sheets` · `GET /snapshots/{sid}/applications` | 상세 드로어 탭 |
| 문서 | `GET /snapshots/{sid}/values?field_key=&rule_key=&cursor=` | 추출 결과 표(값 + 원본 위치 + application_id/rule_key) |
| 문서 | `POST /snapshots/{sid}/applications {profile_id, sheet_bindings?} (wait)` | "다른 프로파일로 파싱"(수동 적용; 바인딩 생략 시 match; draft 허용) |
| 문서 | `GET /snapshots/{sid}/sheets/{sheet_id}/render?range=` · `GET /snapshots/{sid}/render-assets/{asset_id}` | §5 |
| 프로파일 | `GET /profiles?q=&status=&schema_key=` | `{profile_id, profile_name, current_rev, schema{key, name}, status, document_count, success_rate, updated_at}` |
| 프로파일 | `GET /profiles/{id}` | `{profile_id, profile_name, description, status, current_rev, schema{key, name}, reference{application_id, document_id, document_name, snapshot{...}, approved_at, profile_rev}|null, auto_approval_active: bool, sheet_roles, rules[{rule_key, rule_name, field{key, name, type, unit}?, selector_summary, value_spec, status}], document_count, success_rate, updated_at}` |
| 프로파일 | `GET /profiles/{id}/revisions` · `GET /profiles/{id}/revisions/{rev}` · `GET /profiles/{id}/export` | 변경 이력 · 리비전 JSON(canonical) · 다운로드 |
| 프로파일 | `POST /profiles {name?, schema_key, definition, format?:'auto'}` · `PUT /profiles/{id} {definition, format?}` | 생성/새 리비전(adapter 경유). 응답에 `report{format_detected, warnings[]}`. schema 변경 시 422 `SCHEMA_IMMUTABLE` |
| 프로파일 | `POST /profiles/import-preview {schema_key, definition, format?}` | `{format_detected, canonical, warnings[], errors[]}`(저장 없음) |
| 프로파일 | `POST /profiles/{id}/test {snapshot_id}` · `POST /profiles/test {schema_key, definition, snapshot_id}` | §4.7 |
| 프로파일 | `POST /profiles/{id}/approve {application_id}` · `POST /profiles/{id}/reparse {mode} (job)` · `GET /profiles/{id}/documents?cursor=&limit=` | §4.8 · §4.9 · keyset 페이지(`(document_name, application_id)`), 행 `{document_id, document_name, snapshot{snapshot_id, revision_no}, application_id, profile_rev, origin, compatibility, heads_approved, heads_total, published, is_reference, state(application 상태 어휘 published|changed|review|failed|extracting|approved — 문서 목록 `profiles[].state`·등록 결과 `applied[].state`와 같다), document_status}` |
| 스키마 | `GET /schemas` · `GET /schemas/{key}` · `GET /schemas/{key}/tree` · `GET /schemas/{key}/graph` · `GET /schemas/{key}/revisions` | 목록(필드·프로파일·문서 수) · 상세 · 트리(중첩, 1회) · 그래프(`nodes[{field_key, name, level, type, parents[], document_count, profile_count}], edges[{from, to, relation}]`) |
| 스키마 | `GET /schemas/{key}/profiles?field_key=` · `GET /schemas/{key}/documents?field_key=&cursor=` | 탭 "사용 프로파일"(`{profile_id, profile_name, current_rev, status, rules{count, keys[:5]}, document_count}`) · "연관 문서"(`{document_id, document_name, profile{...}, snapshot{...}, status, application_id}`) |
| 스키마 | `GET /schemas/{key}/fields/{field_key}` · `.../profiles` · `.../documents` · `.../values?limit=` | 필드 상세(`{field_key, name, description, type, unit, aliases[], parents[], children[], related[], profile_count, document_count, status}`) · 위 두 목록의 `?field_key=` 동치 · 최근 값(`{text, value_id, sheet_id, sheet_name, range, application_id, rule_key, document_id, document_name, captured_at}` 최신순) |
| 스키마 | `POST /schemas {definition}` · `PUT /schemas/{key} {definition}` · `PATCH /schemas/{key}/fields/{field_key} {name?, description?, aliases?, status?}` | 가져오기/새 리비전/필드 단건 편집(파일 리비전 + projection) |
| 빌드 | `POST /builds/candidates {document_ids[], schema_key?}` | §4.10 candidates |
| 빌드 | `POST /builds/preview {document_ids[], schema_key, columns[], row_mode}` | `{columns, rows[:50], row_count, excluded[], conflicts[]}` |
| 빌드 | `POST /builds {…, format} (wait)` → `{build_key, download_url, manifest}` · `GET /builds/{build_key}/download` · `GET /builds/{build_key}/manifest` | 산출물 |
| 검수 | `GET /applications/{aid}` | Source Review 진입용 집계(요청 1회): `{application_id, origin, compatibility, published, heads_approved, heads_total, document{document_id, document_name}, snapshot{snapshot_id, revision_no, captured_at}, profile{profile_id, profile_name, rev}, schema{schema_key, schema_name}, sheets[{sheet_id, sheet_name, ordinal, roles[]}], mappings[<mapping row>]}` |
| 검수 | `GET /applications/{aid}/mappings` · `GET /mappings/{mid}` · `GET /mappings/{mid}/revisions` | mapping row = `{mapping_id, rule_key, rule_name, field{key, name, type, unit}|null, observed_key, status, origin, effective_spec, regions[{role, sheet_id, sheet_name, range}], revision_no, edit_seq, value{value_id, value_text, display_text, unit_normalized, value_type, value_state, count, first_region{sheet_id, sheet_name, range}}|null}`(value = 발행 실행, 없으면 마지막 succeeded 실행의 첫 값). `/revisions` 행은 `value/edit_seq` 대신 `mapping_revision_id, origin, evidence, reason, created_by, created_at` |
| 검수 | `POST /mappings/{mid}/revisions {...}` · `POST /mappings/{mid}/rollback {expected_seq, target_revision_id, reason?}` · `POST /applications/{aid}/approve-all {reason?, extract?} (wait)` · `POST /applications/{aid}/extract (job, wait)` | §4.5 · §4.6 |
| 검수 | `GET /applications/{aid}/values?rule_key=&cursor=` · `GET /values/{vid}` · `GET /regions/{rid}/values` · `GET /sheets/{sheet_id}/regions?range=` | 추출값 · 역방향 조회(셀 → 값·매핑; `/regions/{rid}/values`의 `mappings[]`는 같은 시트에서 그 영역과 **교차**하는 `mapping_region`을 가진 리비전 — 값 영역 C9는 매핑의 값 영역 C9:C73에 포함된다). 실행/리비전 ID는 응답에 없다(§7): `/values/{vid}`는 값 행 + `document{}, snapshot{}, mapping_id, published`, `/regions/{rid}/values`의 값 행은 `published`(bool), 매핑 행은 `{role, mapping_id, status, revision_no, is_head, application_id, rule_key, rule_name, range}` |
| 작업 | `GET /jobs?state=&kind=&cursor=` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | 작업 내역 |
| 작업 | `GET /queues` · `GET /queues/{kind}?cursor=` · `GET /queues/{kind}/groups/{group_key}/members?cursor=` · `POST /queues/{kind}/groups/{group_key}/actions {action, profile_id?, sheet_bindings?, extract?, mode?} (job, wait)` | §4.11 |

---

## 7. 프런트 (`frontend/src/v3/`)

레이아웃(승인 목업): 좌측 사이드바(제품명 **Semantic Excel Integration**, 부제 Document-to-Table Adapter, 메뉴 `문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역`, 하단 `설정`), 상단 통합 검색, 본문 카드(흰 패널, 1.2px `#d8e0ea` 테두리, 배경 `#f6f8fb`, 강조 `#2563eb`, 활성 `#e8f0ff`).

**상태 표(상태 필터·표·드로어 헤더 공용)**: `normal 정상 .ok #dcfce7` · `review 검수 필요 .warn #fef3c7` · `changed 변경 감지 .warn` · `unmatched 프로파일 없음 .muted #f1f5f9` · `not_extracted 재추출 필요 .muted` · `failed 파싱 실패 .err #fee2e2` · `locked 잠김(DRM) .err`.

**표시 규칙**: 화면 텍스트·툴팁·CSV/XLSX 헤더에 UUID·SHA-256을 쓰지 않는다. 현재 Snapshot = `captured_at 날짜` + 최신이면 `최신` 칩(이력은 `r{revision_no} · 날짜`); 프로파일 = `{profile_name} v{rev}`; 스키마 = `{schema_name} v{rev}`; 매핑 리비전(접힌 상세) = `#{revision_no} · 시각`; 작업 대상 = `label`; 원본 위치 = `{sheet_name}!{range}`. ID는 URL 파라미터와 API 호출에만(설정 화면·접힌 상세의 `ID 복사`만 예외). 컴포넌트 테스트가 렌더 결과에 UUID/sha256 정규식이 없음을 검사.

| 파일 | 내용 |
|---|---|
| `App.tsx`(수정) | 기본 → `v3/Workbench`, `?v2=1` → v2, `?v1=1` → v1, `?legacy=1` → 레거시 |
| `v3/client.ts` | `api()`, `useData`, `usePage`(keyset), `useRoute`(`?screen=documents|profiles|schema|build|jobs|settings&…`), `useJob(wait)`; 요청 중복 제거(같은 URL in-flight 공유), 응답 메모리 캐시(60초, 쓰기 후 무효화) |
| `v3/buildDraft.ts` | `BuildDraft{document_ids[], schema_key?}` 메모리 + `sessionStorage('v3.build.draft')`. 문서 → 데이터 빌드 인계(URL에 ID 없음) |
| `v3/Workbench.tsx` | 사이드바·검색·라우팅·`JobBar`(진행 중 작업 수)·`SourceReview` 오버레이 마운트. 화면은 `React.lazy` |
| `v3/Documents.tsx` + `DocumentDetail.tsx` | 상단 `문서 검색(250ms) · 상태 필터 · 프로파일 필터 · + 문서 등록`; 표 `[선택] · 문서명 · 상태 · 적용 프로파일(vN, 2개 이상이면 첫 항목 +N) · 연결 스키마 · 현재 Snapshot · 최근 처리(상대 시각, 툴팁 절대)`; 정렬 헤더; 다중 선택 → `데이터 빌드에 추가`(토스트 `N개 문서 · 데이터 빌드로 이동 ›`). `+ 문서 등록` 대화상자: `GET /sources` 폴더(체크박스) → `POST /documents/register ?wait=10` → 파일별 결과 행; 10초 초과 시 닫아도 JobBar에서 진행. **폴더 일괄 등록(§4.1.1)**: 폴더 툴바의 `이 폴더 전체 등록`(최상위면 `원본 폴더 전체 등록`)과 폴더 행마다 `전체 등록` 버튼 → `GET /sources/scan?directory=` 미리보기 패널(`<폴더>/ 아래 파일 N개 · 하위 폴더 M개`, 칩 `새 파일 n · 변경된 문서 n · 변경 없음 n · 잠김 n`, 건너뛴 임시/지원하지 않는 파일 수, 체크박스 `변경 없는 문서·잠긴 문서도 다시 읽기`(기본 해제), 주 행동 `N개 등록 시작`(N = targeted; 체크 시 + unchanged + locked; N=0이면 비활성 + `등록할 새 파일이나 변경된 문서가 없습니다.`), 보조 `파일 고르기로 돌아가기`; 413이면 문구 그대로 보이고 하위 폴더로 들어가게 안내) → `POST /documents/register-directory ?wait=10` → 진행(`폴더 일괄 등록 진행 중 (completed/total)`) → 결과 요약 줄 `N개 중 R개 등록 · U개 변경 없음 · F개 실패`(잠김이 있으면 ` · L개 잠김`) + 파일별 결과 표(단일 등록과 같은 열; `truncated`면 `앞 500개만 표시 — 나머지는 문서 화면에서 확인하세요`) + 토스트. 미리보기·진행·결과 어디서도 UUID를 보이지 않는다. 드로어(모달, inert·focus trap·Esc — v2 DocumentDrawer 패턴 이식, 코드 복사 금지) 탭 `파일 보기`(=`SheetViewer` readonly, 좌측 시트 목록, `sheet=` URL) · `추출 결과`(`GET /snapshots/{sid}/values` 표, 행마다 `원본 보기`) · `적용 프로파일`(행 `프로파일 vN · state · 원본 보기 · 다른 프로파일로 파싱`) · `연결 스키마`; 관계 카드 `문서 → 프로파일 → 스키마`; 행동 `원본 보기 · 다른 프로파일로 파싱 · 데이터 빌드에 추가` |
| `v3/Profiles.tsx` + `ProfileDetail.tsx` + `ProfileImport.tsx` | 목록 → 상세 탭 `기본 정보 · 규칙 · 필드 매핑 · 테스트 · JSON · 변경 이력`. 기본 정보: 상태 칩(초안/승인/폐기), `대표 문서`(`<document_name> r<rev>` 또는 없음), 자동 승인 활성 여부, 적용 문서 표(`GET /profiles/{id}/documents`; 행마다 `Source Review 열기`, 헤드 전부 approved인 행에 `이 문서로 승인`; 후보 없으면 힌트), 새 리비전 뒤 `재파싱(rematch)`·`재파싱(fill)`. 규칙 탭: 규칙 폼(sheet role, key/value/unit/context selector 요약, 필드, type/unit/normalization 프리셋). JSON 탭: canonical 편집 + 검증 오류. Import 대화상자: 붙여넣기/업로드 → 형식 판별 → canonical 미리보기 → 경고 → 대표 문서 테스트 → 저장. 테스트 탭: 문서 선택(적용 문서 목록 + 검색) → 실행 → Source Review(`?test=<profile_id>&snapshot=<sid>`; 미저장 정의는 `?test=draft&snapshot=`로 편집기 draft에서 definition 전달) |
| `v3/Schema.tsx` + `SchemaTree.tsx` + `SchemaGraph.tsx` + `FieldDetail.tsx` | 3열(목록 / 상세 탭 `구조 보기 · 사용 프로파일 (N) · 연관 문서 (N) · 변경 이력` / 필드 상세). 구조 보기 안에서만 `[트리 보기] [그래프 보기]` 토글(URL `view=`). 트리는 중첩 응답 1회로 전체를 그린다(펼침은 클라이언트 상태). 그래프는 `layoutDomain` 재사용, SVG는 v3에서 새로 작성(`GET /schemas/{key}/graph` → `Graph` 어댑트). 필드 상세: 필드명·영문명·타입·단위·alias·관계·`사용 프로파일 N개 보기 ›`·`연관 문서 N개 보기 ›`(탭을 `?field_key=`로 필터)·`Source Review 열기`(최신 값의 application/rule/sheet/range; 값 없으면 비활성+힌트)·필드 편집(alias/설명/폐기 → PATCH). 진입 호출 `/schemas`, `/schemas/{key}`, `/schemas/{key}/tree`(필드 상세는 선택 시) |
| `v3/Build.tsx` | 5단계 스텝퍼 `대상 문서 → 스키마 → 출력 설정 → 미리보기 → 생성`. 1단계: draft 읽어 `POST /builds/candidates` 1회, `입력 문서 N개 · 사용 가능 N개 · 제외 N개`, 행별 제거·사유, `[문서 다시 선택]`. 3단계 표: 사용 체크 · 원본 Field · **출력 Header 입력**(기본 = 필드명; 빈값/중복 즉시 오류·생성 비활성) · Type · Unit · 값 있는 문서 · 순서(↑↓ + 드래그). 4단계 미리보기 각 셀 `원본 보기`. 5단계 `CSV ○ XLSX ● SQLite ○` → 다운로드 + manifest 링크. 제외 문서·충돌 표시 |
| `v3/Jobs.tsx` | 상단 요약 카드(신규 양식 · 매핑 검수 · 파싱 실패 · 변경 감지 · 충돌) + 큐 탭(묶음 행 `대상 · 원인 · 영향 · 처리`; 펼치면 멤버; 묶음 버튼은 `POST .../actions ?wait=10`, 낙관적 갱신) + 작업 목록(`GET /jobs`; 열 종류(등록·추출·재파싱·빌드·테스트·묶음 처리·마이그레이션) · 대상(label) · 상태 · 시작 · 종료 · 결과/오류; 실패 행 → target_kind별 이동) + 렌더 서버 상태 한 줄 |
| `v3/SourceReview.tsx` + `SheetViewer.tsx` | 전체 화면 오버레이(`?review=<application_id>&rule=&sheet=&range=` 또는 `?test=`). 진입 호출 = `GET /applications/{aid}` + 렌더 창 ≤2. 3열: 좌 시트·프로파일·규칙 목록 / 중앙 **`SheetViewer`(신규, 가상화; v2 `Source.tsx`의 overlay rect·드래그 선택 로직만 이식)**: 창 응답의 `rows/columns`로 스크롤 영역·헤더를 만들고 스크롤 위치 → 창(`A1:Z60` 단위)으로 환산해 `Map<range, window>` 보관, 보이는 창 + 진행 방향 1창 선행 요청, viewport ± 1창 셀만 DOM(≤3,000), 병합·이미지(`loading="lazy"`)·overlay 좌표는 `rows[].y/columns[].x`, 확대 50~150%, `A1` 이동, overlay key/value/unit/context/focus, 드래그 재지정, `mode='review'|'readonly'` / 우 필드·규칙·observed key·추출값(단위)·원본 위치·상태·`수정 · 승인 · 반려`·접힌 상세(selector JSON, 변경 이력 `GET /mappings/{mid}/revisions`는 펼칠 때만, 복원). 규칙 클릭은 추가 호출 없음. test 모드: 우측은 §4.7 결과(groups[])로, 수정·승인·반려·이력 숨김, 행동은 `닫기 · 다시 실행`. 202/실패/503은 뷰어 영역만 |
| `v3/Settings.tsx` | `?screen=settings`: 읽기 전용 카드(`GET /settings`) + 정규화 프리셋 표 |
| `v3/v3.css` | 토큰·레이아웃·표·칩·그리드·오버레이 |
| `frontend/tests/v3-*.test.tsx` | 네비게이션 순서·문서 표·상태 칩·헤더 편집 검증·트리/그래프 토글·SheetViewer 창 요청·DOM 상한·Source Review overlay·큐 묶음·ID 비노출(`v3-ids`)·용어(`v3-terms`)·import 금지(`v3-imports`) |

**v2 자산 재배치(ui-development-spec §9)**: `DomainGraph` → 배치 함수만; `ConceptTree` → 재사용 안 함(`SchemaTree` 신규); `DocumentsTable/DocumentDrawer` → 패턴만(inert·focus trap·정렬 첫 방향); `Source.tsx` → overlay/드래그 로직만; `Database.tsx` → 헤더 편집 UX만; `Review/Recrawl/ReviewQueue/Presets/Suggestions/ConceptEditor` → 재사용 안 함(`?v2=1`에서만). v2 컴포넌트 파일은 수정하지 않는다.

성능 규칙: 화면 진입 API 호출 ≤ 3. 목록 ≤ 50/페이지. 그리드 셀 DOM ≤ 3,000. 검색 250ms 디바운스. 모든 버튼은 첫 클릭에서 즉시 상태 반영(낙관적 갱신, 실패 시 되돌림).

---

## 8. E2E (`e2e/v3/`)

- `serve.py`(감독 프로세스): 임시 작업 공간 → `examples/schema_v3/demo.py`의 `seed(root)` → 렌더 서버(포트 8032, 자식 프로세스) → 메인(8031, 자식 프로세스, `KG_V3_RENDER_URL=http://127.0.0.1:8032`) + 제어 서버(18031 = 메인 포트 + 10000). 스펙 파일마다 `test.beforeAll`에서 `helpers.resetWorkspace()`가 `POST /reset`을 불러 **새 작업 공간을 시드하고 두 서버를 다시 띄운다**(≈3.5초; 이전 스펙이 남긴 등록·승인·빌드 상태와 격리). 포트는 `KG_E2E_V3_PORT`/`KG_E2E_V3_RENDER_PORT`/`KG_E2E_V3_CONTROL_PORT`로 바꿀 수 있어 여러 스위트를 동시에 돌릴 수 있다. SIGTERM에도 자식·표식·임시 폴더를 정리한다. 실제 도메인 DB·사용자 원본은 열지 않는다.
- 시드(openpyxl 생성): 스키마 `공정 데이터 표준`(그룹 3, 필드 9). 프로파일 `공정데이터_A양식`(approved, 대표 문서 `공정데이터_2024_01.xlsx`). 같은 양식 문서 3개(자동 적용·승인·발행), 앵커가 이동한 문서 1개(compatible → 검수), 다른 양식 1개(unmatched), 잠긴 파일 1개(locked), 이미지가 있는 시트 1개. 시나리오 중 `공정데이터_2024_01.xlsx` 내용을 바꿔 재등록 → 변경 감지(inherited proposed) → approve_all 1클릭 → 발행. compatible 문서를 검수·승인한 뒤 같은 구조의 문서를 등록하면 참조와 다르므로 여전히 compatible임을 확인.
- 스펙: `documents.spec.ts`(등록 대화상자·7개 상태 칩·드로어 탭·파일 보기 202 폴링·관계 카드) · `profiles.spec.ts`(목록·탭·JSON·외부 v1/v2 Import 미리보기와 경고·테스트 → Source Review overlay·승인·재파싱) · `schema.spec.ts`(트리/그래프 토글·필드 상세·사용 프로파일/연관 문서 탭·필드에서 Source Review) · `build.spec.ts`(문서 3개 인계·candidates·헤더 중복 오류·순서 변경·미리보기·원본 보기·CSV/XLSX/SQLite 내용·manifest) · `jobs.spec.ts`(요약 카드·묶음 행·approve_all·실패 이동·작업 목록) · `source-review.spec.ts`(실제 셀·overlay·드래그 재지정·승인→추출 요청 1회·역방향 조회·잠긴 문서 실패 표시) · `render-isolation.spec.ts`(렌더 중 문서 API 응답 시간, 캐시 재접근 < 1초, 304) · `register-directory.spec.ts`(§4.1.1: 원본 폴더에 `일괄/2024/`·`일괄/2024/하위/` 트리(같은 양식 복사본 3 + 다른 양식 1 + `~$임시.xlsx` + `메모.txt`)를 만들고 대화상자 → `일괄` 폴더 → `이 폴더 전체 등록` → 미리보기 수치 → `4개 등록 시작` → 요약 `4개 중 4개 등록 · 0개 변경 없음 · 0개 실패` → 문서 목록 4건(정상 3 · 프로파일 없음 1) → 같은 폴더 다시 스캔 → `변경 없음 4`·시작 비활성 → 체크박스 → 4개 재읽기 결과 `4개 변경 없음` → 복사본 하나의 값을 바꾼 뒤 스캔 → `변경된 문서 1` → 등록 → 변경 감지; API로 `..`·절대 경로 422). 각 스펙은 `pageerror`/`console.error`를 실패로 본다. 다운로드 파일은 내용까지 검사.
- 결과 문서 `docs/e2e-results-v3.md`: 실행 명령, 환경, list reporter 출력 전문, ui-development-spec §10 완료 조건 각 항목 → 스펙 → 검증 방법 → pass/fail 표, 측정 시간, 실패·건너뜀·경고, 재현 절차.

---

## 9. 마이그레이션 (`kg/v3/migrate.py`, `python -m kg.v3 migrate --ws <v3> --from-ws <v2> [--dry-run --report]`)

| v2 | v3 |
|---|---|
| `document`·`document_version`·`sheet`·`source_region` | `document(source_ref→source_path, status 재계산)`·`document_snapshot(change_token = provider_version_token or content_sha256)`·`sheet`·`source_region(+snapshot_id)` |
| 모든 `kg_revision`의 `domain_concept` 합집합(concept별 최고 revision_no 행; 최신 리비전에 없는 개념은 deprecated)·최신 리비전 alias/edge | `parsing_schema(key 'migrated_kg')` + `parsing_field(concept_id→field_key, level, deprecated)`·alias·edge(`parent_of`, `related`→`related_to`). 정의 파일 r0001 |
| `template`·`template_version`(최신)·`template_rule` | `parsing_profile(draft)` + adapter(v2-template) → 파일 r0001 + `parsing_rule`(concept_id NULL → default_field_id NULL) |
| `template_application`·`application_sheet` | `parsing_application(origin='manual', profile_rev=1)`·`application_sheet`. 현재 snapshot의 적용 건이고 raw 파일이 있어 Reader `match_specs`가 성공하면 `compatibility='compatible'`과 실제 매치 서명, 그 외(과거 snapshot·파일 없음·불일치·Reader 오류)는 `compatibility='manual'`, `match_signature='migrated'`. `scope_key`는 'default'(충돌 시 v2 값, 그래도 충돌이면 SCOPE_CONFLICT로 건너뜀) |
| `mapping_head`·`mapping_revision` | `mapping`·`mapping_revision`(status 유지, origin `import`, `revision_no`는 (application, rule)별 1..n으로 재번호(원래 번호·ID는 `evidence_json.v2`), effective_spec은 v3 `validate_rule`+`compile_rule`을 통과시켜 기본값을 채운 것(실패하면 원문 유지 + 보고서 `review_required` INVALID_SPEC), `concept_id NULL → field_id NULL`(보고서 "검수 필요" FIELD_REQUIRED); `mapping_region`은 그 리비전을 쓴 마지막 succeeded 실행의 `series_region`에서 유도) |
| `extraction_run`·`run_mapping`·`extracted_series`·`extracted_item`·`item_region`·`series_region` | `extraction_run(input_manifest에 mappings)`·`extracted_value(group_key=series.instance_key; value_state blank→empty, missing→null, excel_error/unavailable→error; value_type 'null'→필드 타입 또는 'text', 'asset'→'text'+보고)`·`extracted_value_region`(item_region 그대로 + series_region은 같은 role로 `ordinal = 항목 role 최대 ordinal + 1 + series ordinal`)·발행 실행 유지 |
| `integration_*`·`build_*` | DB로 옮기지 않음. 빌드마다 `<ws>/data/exports/migrated-<build_id>/manifest.json` |
| `runtime_job`·`version_signature` | 옮기지 않음(재생성) |

보고서(`v2-migration-report/1`): `counts{table:{migrated, skipped}}`, `skipped[{table, id, reason}]`, `review_required[]`, `re_extract_required[]`(발행 실행을 옮기지 못한 application: `PUBLISHED_RUN_NOT_MIGRATED`·`HEAD_NOT_APPROVED`·`PUBLISH_REJECTED`), `schema{field_keys 개명 목록}`, `profiles[{warnings}]`, `documents{document_id: {applications[], status}}`, `statuses`, `asset_values`, `raw{reader_errors}`, `truncated{}`. `--dry-run`은 아무것도 쓰지 않는다.

---

## 10. CLI (`python -m kg.v3`)

`serve --ws --port [--host]` · `render-serve --ws --port` · `watch --ws [--raw --interval --once --no-recursive]`(등록+자동 적용, 기본 하위 폴더 포함; 제외 규칙은 §4.1.1 스캔과 같다 — 심볼릭 링크와 `.`으로 시작하는 폴더 아래 파일은 건너뛰고 `skipped:'HIDDEN_DIR'`로 알린다) · `register --ws --directory <raw 기준 폴더> [--include-unchanged --provider]`(§4.1.1 폴더 일괄 등록, 요약 JSON 출력; 실패 행이 있으면 종료 코드 1) · `migrate …` · `import-schema --ws --file` · `import-profile --ws --schema --file [--format]` · `build --ws --schema --documents … --format --out` · `seed-demo --workspace`. 모두 시작 시 `.env` 로드(`kg/env.py`).

---

## 11. 테스트 기준

- `tests/test_schema_v3.py`: 불변식(리비전 불변, CAS — 같은 expected_seq 두 번이면 IntegrityError·리비전 수 불변·edit_seq 직접 UPDATE 거부, 발행 조건과 헤드 변경 시 NULL, projection 삭제 금지, snapshot 바인딩(다른 snapshot의 sheet/region/revision 거부), 단일 출처 경로, parent_of 레벨(INSERT·UPDATE·NULL 거부), group 필드 매핑 거부, published_run 소유 검사, application 불변 컬럼).
- `tests/test_schema_v3_postgres.py`(pglast 구문·객체 집합 비교).
- `tests/test_v3_profile.py`(DSL·기본값·adapter v1/v2/generic·compile·오류 코드), `tests/test_v3_normalization.py`(split_delimiter 단독·혼합·version), `tests/test_v3_engine.py`(regex·anchor·composite bounding box/키/기준·AMBIGUOUS_ANCHOR·relative.anchor·relations same_row/same_column/offset·list/matrix/merged/stop·match_profile: within 밖 앵커 해결, missing, 서명 identical/compatible), `tests/test_v3_render.py`(밴드·창 불변식(원점 0·연속 누적·셀 중복 0·병합 straddle·이미지 교차·클램프/422/413)·asset 격리·202/200/failed·멱등 큐·invalidate 세대·격리 중 창 응답 < 20ms·304), `tests/test_v3_runtime.py`(API 통합: 등록 1회 Reader 프로세스 → 자동 적용(approved만) → 수동 적용(draft) → 검수 승인 → 프로파일 승인 → rematch 소급 → 자동 승인·추출 → 값/역조회 → 빌드 3형식+manifest+헤더 검증 → 큐 묶음 처리 → 새 snapshot 승계(proposed) → approve_all → 발행 → 프로파일 테스트 → 검색 → 문서 상태 전이), `tests/test_v3_migrate.py`(v2 템플릿 이관 뒤 추출 결과 동일, NULL concept 리비전, series_region 병합), `tests/test_v3_build.py`.
- `tests/test_v3_register_directory.py`(§4.1.1: 스캔 분류 new/changed/unchanged/locked·temp/unsupported/symlink·숨김 폴더·정규화가 바꾸는 이름(`..\a.xlsx`) 제외, 알 수 없는 provider 422, 스캔·해시 구간 진행률(checkpoint), `source_digest` 재사용(stat 같으면 `file_hash` 호출 0회), 크기 다르면 해시 없이 changed, 일괄 등록 작업의 summary/documents/truncated(한도 낮춰 검증)/취소, include_unchanged, `..`·절대 경로·없는 폴더 오류, 413 한도, API 두 경로, CLI `register`, watch 재귀).
- 기존 v1·v2 테스트는 그대로 통과해야 한다.
- 성능 회귀(단위): 문서 2,000건 목록 페이지 < 50ms(SQLite, 로컬), 렌더 캐시 창 응답 < 20ms.
