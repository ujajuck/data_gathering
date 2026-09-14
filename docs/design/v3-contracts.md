# v3 구현 계약 — Parsing Schema / Parsing Profile 런타임

작성일: 2026-09-14
상태: 구현 기준 (이 문서와 코드가 다르면 같은 커밋에서 이 문서를 고친다)

근거 문서(모두 `docs/design/`):
[system-identity-and-scope.md](system-identity-and-scope.md) ·
[parsing-core-schema.md](parsing-core-schema.md)(18개안) ·
[parsing-core-schema-reply.md](parsing-core-schema-reply.md) §5(남은 빈칸 3개, 구현 경로) ·
[ui-development-spec.md](ui-development-spec.md)(개발 기준안, 승인 목업) ·
[ui-screen-definition.md](ui-screen-definition.md) · [ui-wireframes.md](ui-wireframes.md) ·
[drm-viewer-render-architecture.md](drm-viewer-render-architecture.md) ·
[v2-decisions.md](v2-decisions.md) §2-3(18개안 채택).

이 문서는 위 문서들이 정한 것을 **코드 단위(파일·테이블·컬럼·엔드포인트·화면)**로 고정한다.
설계 판단이 갈리는 지점의 결정과 근거는 [v3-decisions.md](v3-decisions.md)에 적는다.

두 가지 요구를 모든 구현이 따른다.

- **사용성**: 사용자는 내부 ID(application/revision/run)를 보지 않는다. 화면마다 대표 행동 하나. 값이 보이는 곳에는 항상 `원본 보기`. 빈 상태에는 다음 행동. 로딩은 패널 단위(사이트 전체가 멈추지 않는다).
- **속도**: 목록은 keyset 페이지 + 페이지 범위 요약. 렌더는 캐시(스냅샷+시트+renderer_version)와 창(window) 단위. 이미지는 별도 asset. 그리드는 가상화. 승인/추출은 요청 1회. 같은 결과를 두 번 계산하지 않는다(서명 캐시).

---

## 0. 위치와 이름

| 영역 | 경로 | 비고 |
|---|---|---|
| DDL | `db/v3/schema_sqlite.sql`, `db/v3/schema_postgres.sql` | 18개 코어 + `schema_meta` + 런타임 테이블 |
| 런타임 | `kg/v3/` | `kg/v2/`는 이관 완료까지 유지. v3는 v2의 **모듈 함수만** 재사용하고(`kg.v2.spec.bounds/address/decimal/typed`, `kg.v2.normalization`, `kg.v2.readers.XlsxReader.region` 등) v2 `Service`/`Database`/API는 import하지 않는다 |
| 렌더 서버 | `kg/v3/render/` | 별도 프로세스(`python -m kg.v3 render-serve`) 또는 in-process 어댑터 |
| API | `/api/v3/...` | `python -m kg.v3 serve`(독립) 및 `kg.webapp`에 `install(app, root)` |
| DB 파일 | `<ws>/data/kg/v3.db` | `schema_meta.version = 3` |
| 정의 파일 | `<ws>/schemas/<schema_id>/r%04d.json`, `<ws>/profiles/<profile_id>/r%04d.json` | Git/DVC 추적 대상. DB는 projection |
| 산출물 | `<ws>/data/exports/<build_key>/` | `data.csv|xlsx|sqlite` + `manifest.json` |
| 렌더 캐시 | `<ws>/data/render-cache/<snapshot_id>/<sheet_id>.<renderer_version>.json`, `assets/<asset_id>` | 재생성 가능 |
| 프런트 | `frontend/src/v3/` | 기본 화면. `?v2=1`은 v2, `?v1=1`은 v1 유지 |
| E2E | `e2e/v3/` | Playwright, 임시 작업 공간, 렌더 서버 별도 프로세스 |
| 문서 | `docs/ARCHITECTURE_V3.md`, `docs/e2e-results-v3.md` | |

용어(코드 식별자 → UI 표기): `parsing_schema` → 파싱 스키마, `parsing_field` → 필드, `parsing_profile` → 파싱 프로파일,
`parsing_rule` → 파싱 규칙, `source_region` → 원본 위치, build → 데이터 빌드, `mapping` → 매핑, `extraction_run` → 파싱 실행.
`KG`, `Concept`, `Template`, `Integration`은 UI에 쓰지 않는다.

---

## 1. 코어 스키마 (SQLite 기준, 18개 + 보완 3건)

공통 규칙: ID는 애플리케이션 생성 UUID 문자열(`TEXT`). 시각은 ISO-8601 UTC 문자열. JSON 컬럼은 `json_valid` CHECK.
모든 FK는 `REFERENCES` + 인덱스. 아래 "불변" 표시 테이블은 UPDATE/DELETE 거부 트리거를 둔다.

### 1.1 문서

```sql
document (
  document_id TEXT PK, document_name TEXT NOT NULL, provider TEXT NOT NULL,   -- 'local-xlsx' | 운영자 등록 DRM provider
  source_path TEXT NOT NULL,                       -- provider 기준 상대 참조. 절대 경로/비밀 경로 금지
  file_type TEXT NOT NULL, current_snapshot_id TEXT REFERENCES document_snapshot,
  created_at, updated_at, UNIQUE(provider, source_path))
document_snapshot (불변) (
  snapshot_id PK, document_id FK, revision_no INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
  ciphertext_sha256, provider_version, dvc_rev, author, authored_at,
  filename TEXT NOT NULL, byte_size INTEGER, excel_date_system TEXT, captured_at NOT NULL,
  UNIQUE(document_id, revision_no), UNIQUE(document_id, content_sha256))
sheet (불변) (sheet_id PK, snapshot_id FK, sheet_name NOT NULL, ordinal INTEGER NOT NULL, native_sheet_key,
  visibility TEXT NOT NULL DEFAULT 'visible', estimated_rows, estimated_cols,
  UNIQUE(snapshot_id, ordinal), UNIQUE(snapshot_id, sheet_name))
source_region (불변) (region_id PK, sheet_id FK, kind TEXT CHECK IN ('cells','image','chart','shape','text'),
  locator_key TEXT NOT NULL,                       -- cells: 'B3:C3' (병합은 병합 범위 전체), 그 외: object key
  r1,c1,r2,c2 INTEGER, geometry_json, created_at, UNIQUE(sheet_id, kind, locator_key))
```

### 1.2 Parsing Schema

```sql
parsing_schema (schema_id PK, schema_name UNIQUE NOT NULL, description, definition_path, current_rev INTEGER NOT NULL DEFAULT 0,
  definition_sha256, status TEXT CHECK IN ('active','deprecated') DEFAULT 'active', created_at, updated_at)
parsing_field (field_id PK, schema_id FK, field_key TEXT NOT NULL,   -- 영문 key (UI '영문명'), 스키마 안에서 유일
  field_name TEXT NOT NULL, description, field_level INTEGER, value_type TEXT CHECK IN ('text','decimal','boolean','date','datetime','group'),
  canonical_unit, status CHECK IN ('active','deprecated') DEFAULT 'active', ordinal INTEGER NOT NULL DEFAULT 0,
  created_at, updated_at, UNIQUE(schema_id, field_key))
parsing_alias (alias_id PK, field_id FK, alias_text NOT NULL, alias_norm NOT NULL, context_key TEXT NOT NULL DEFAULT '',
  UNIQUE(field_id, alias_norm, context_key))
parsing_field_edge (edge_id PK, schema_id FK, from_field_id FK, to_field_id FK,
  relation CHECK IN ('parent_of','related_to'), ordinal, UNIQUE(schema_id, from_field_id, to_field_id, relation), CHECK(from<>to))
```

`value_type='group'`은 트리의 묶음 노드(예: "공정 정보")다. 값이 추출되지 않는다. `parent_of`는 레벨 차 1을 트리거로 강제한다(다부모 허용).
**projection 삭제 금지**: `parsing_field`·`parsing_rule`은 DELETE 트리거로 거부한다. 정의 파일에서 사라진 항목은 `status='deprecated'`로만 표시한다(reply §5-2.2).

### 1.3 Parsing Profile

```sql
parsing_profile (profile_id PK, profile_name UNIQUE NOT NULL, description, schema_id FK NOT NULL,
  definition_path, current_rev INTEGER NOT NULL DEFAULT 0, definition_sha256,
  status CHECK IN ('draft','approved','deprecated') DEFAULT 'draft',
  reference_application_id TEXT,                   -- 승인 시 대표 문서 적용 건(구조 서명 기준). FK 없음(순환 방지), 서비스가 검증
  created_at, updated_at)
parsing_rule (rule_id PK, profile_id FK, rule_key NOT NULL, rule_name, default_field_id FK parsing_field,
  ordinal INTEGER NOT NULL, selector_json NOT NULL, value_spec_json NOT NULL,
  status CHECK IN ('active','deprecated') DEFAULT 'active', created_at, UNIQUE(profile_id, rule_key))
```

Profile JSON 전체는 파일(`definition_path`)이 진실이고 `parsing_rule`은 조회·편집용 projection이다(identity §8.2). 새 리비전 저장 = 파일 `r%04d.json` 추가 + `current_rev` 증가 + rule projection upsert(사라진 rule은 deprecated).

### 1.4 Application / Mapping

```sql
parsing_application (application_id PK, snapshot_id FK NOT NULL, profile_id FK NOT NULL, schema_id FK NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'default', profile_rev INTEGER NOT NULL, schema_rev INTEGER NOT NULL,
  published_run_id TEXT REFERENCES extraction_run,   -- reply §5-2.1 복귀. 발행 조건 트리거
  origin CHECK IN ('auto','manual','inherited','test'), created_at,
  UNIQUE(snapshot_id, profile_id, scope_key))
application_sheet (application_id FK, role_key NOT NULL, ordinal INTEGER NOT NULL, sheet_id FK NOT NULL,
  PRIMARY KEY(application_id, role_key, ordinal))
mapping (mapping_id PK, application_id FK, rule_id FK, instance_key TEXT NOT NULL DEFAULT '',
  current_revision_id TEXT REFERENCES mapping_revision, edit_seq INTEGER NOT NULL DEFAULT 0, created_at,
  UNIQUE(application_id, rule_id, instance_key))
mapping_revision (불변) (mapping_revision_id PK, mapping_id FK, revision_no INTEGER NOT NULL, snapshot_id FK NOT NULL,
  field_id FK NOT NULL, observed_key, effective_spec_json NOT NULL,      -- §2의 rule 전체(selector+value_spec+record_spec+normalization)
  status CHECK IN ('proposed','approved','rejected'), origin CHECK IN ('profile','inherited','manual','import','auto'),
  evidence_json,                                     -- 자동 승인 근거: {"reference_revision_id":..,"profile_rev":..,"signature":..}
  created_by, reason, created_at, UNIQUE(mapping_id, revision_no))
mapping_region (불변) (mapping_revision_id FK, region_id FK, role CHECK IN ('key','value','unit','context','record_key'), ordinal,
  PRIMARY KEY(mapping_revision_id, role, ordinal))
```

규칙(트리거 또는 서비스, 표기):
- CAS: `mapping.edit_seq`는 리비전 삽입마다 정확히 1 증가(트리거 `mapping_edit_seq`). 요청은 `expected_seq`를 보낸다 → 불일치면 409 `EDIT_CONFLICT`.
- 헤드 변경 시 `parsing_application.published_run_id = NULL`(트리거). 발행 조건: 실행이 `succeeded`이고 `input_manifest_json.mappings`의 리비전 집합이 현재 헤드와 같을 때만(트리거 `publish_run`).
- `mapping_region`은 검수 결과의 **실제 위치**다. 리비전 저장 시 `effective_spec_json`의 `range` 영역과 검수에서 확인된 `find/anchor` 결과 위치를 role별로 기록한다(역방향 조회 "이 셀을 참조하는 매핑"용).
- 새 snapshot 승계는 §4.4.

### 1.5 Extraction

```sql
extraction_run (run_id PK, application_id FK, snapshot_id FK, schema_rev, profile_rev, engine_version NOT NULL,
  input_manifest_json NOT NULL,     -- {"mappings":{rule_key:mapping_revision_id},"bindings":{role:[sheet_id]},"engine":..}
  status CHECK IN ('queued','running','succeeded','failed','cancelled'), started_at, finished_at, error_summary)
  -- 완료(succeeded/failed/cancelled) 후 불변(트리거)
extracted_value (불변) (value_id PK, run_id FK, mapping_revision_id FK, field_id FK,
  group_key TEXT NOT NULL,          -- "{rule_key}|{sheet_id}|{anchor_locator}" 반복 블록 정체성 (extracted_series 대체)
  record_key, item_index INTEGER, raw_text, display_text, value_text, value_type NOT NULL,
  value_state CHECK IN ('present','null','empty','error'), unit_raw, unit_normalized, formula_state,
  source_identity_key NOT NULL, derivation_key NOT NULL, created_at)
extracted_value_region (불변) (value_id FK, region_id FK, role CHECK IN ('key','value','unit','context','record_key','input'), ordinal,
  PRIMARY KEY(value_id, role, ordinal))
```

값 출처는 **항상** `extracted_value_region`이다(단일 출처도 행 1개; reply §5-2.3). `extracted_value.source_region_id`는 두지 않는다.
`value_state`: `present`(값 있음) · `empty`(빈 셀) · `null`(결합 결과 없음 등 명시적 없음) · `error`(수식 오류·변환 실패, `raw_text`에 원문).

### 1.6 코어 밖 런타임 테이블 (`kg/v3/db.py`가 `CREATE TABLE IF NOT EXISTS`)

```sql
runtime_job (job_id PK, kind, state, principal, payload_json, result_json, error_code, error_message,
  completed, total, cancel_requested, request_key, request_hash, target_kind, target_id, label,   -- 작업 내역 화면용 대상 표시
  created_at, heartbeat_at, finished_at, UNIQUE(principal, kind, request_key))
snapshot_signature (snapshot_id PK FK, algorithm, signature_json, signature_sha256, reader_revision, computed_at)  -- 구조 서명 캐시
```

`access_observation`·`render_chunk`는 두지 않는다(권한은 매 요청 확인, 렌더 캐시는 파일).

### 1.7 뷰·인덱스

- 뷰 `current_value`: `document.current_snapshot_id`의 application 중 `published_run_id`가 있는 실행의 값만.
- 인덱스: `document(current_snapshot_id)`, `document_snapshot(document_id, revision_no DESC)`, `parsing_application(snapshot_id, profile_id)`,
  `mapping(application_id, rule_id)`, `mapping_revision(mapping_id, revision_no DESC)`, `extracted_value(run_id, field_id, record_key)`,
  `extracted_value(mapping_revision_id)`, `extracted_value_region(region_id)`, `source_region(sheet_id, r1, c1)`, `parsing_alias(alias_norm)`, `runtime_job(state, created_at)`.

### 1.8 PostgreSQL

`db/v3/schema_postgres.sql`은 같은 객체 집합(테이블·제약·인덱스·뷰)을 PL/pgSQL 트리거로 번역한다. `tests/test_schema_v3_postgres.py`가
pglast로 구문을 검증하고 SQLite DDL과 테이블·컬럼 집합이 같은지 비교한다(런타임 미검증을 문서에 명시).

---

## 2. Canonical Parsing Profile JSON (DSL 3.0)

파일 하나가 프로파일 한 리비전이다. v2 템플릿 JSON의 상위 호환이며 identity §8.1·§9의 요소를 더한다.

```jsonc
{
  "format": "parsing-profile", "schema_version": "3.0",
  "profile_name": "공정데이터_A양식", "schema_key": "process_standard", "description": "...",
  "sheet_roles": {
    "main":   {"cardinality": "one",  "match": {"name": "공정 기록"}},            // match: name | name_regex | ordinal | contains_text(within)
    "common": {"cardinality": "one",  "match": {"name_regex": "^공통"}},
    "exp":    {"cardinality": "many", "match": {"name_regex": "^\\d+C$"}}
  },
  "anchors": {                                                                    // 이름 붙은 앵커. rule area가 {"anchor": name}으로 참조
    "hdr_temp": {"sheet_role": "main", "find": {"texts": ["온도"], "within": "A1:Z60"}},
    "hdr_lot":  {"sheet_role": "main", "find": {"regex": "^(배치|LOT)$", "within": "A1:Z60"}},
    "table":    {"all_of": ["hdr_lot", "hdr_temp"]}                              // composite: 모두 찾았을 때 bounding box, 없으면 실패
  },
  "rules": [
    {
      "rule_key": "temperature", "rule_name": "온도", "field_key": "temperature",   // field_key → parsing_field(schema_key)
      "selector": {
        "key":   {"areas": [{"sheet_role": "main", "anchor": "hdr_temp"}], "repeat": "once", "separator": " "},
        "value": {"areas": [{"sheet_role": "main", "relative": {"row": 1, "col": 0, "rows": 65, "cols": 1}}],
                  "cardinality": "list", "axis": "down", "element_layout": "one_per_row",
                  "stop": {"kind": "blank_run", "count": 2, "max_items": 10000}, "combine": "ordered_union"},
        "unit":  {"areas": [{"sheet_role": "common", "range": "B1"}]},
        "context": {"areas": [{"sheet_role": "main", "range": "A1"}]}
      },
      "value_spec": {"type": "decimal", "unit": "°C", "source_unit": null,
                     "normalization": {"operation": "pipeline", "version": "1",
                                       "steps": [{"op": "trim_text"}, {"op": "split_unit_suffix"}]}},
      "record_spec": {"scope": ["process-table"], "key": {"column": "A"}},
      "relations": [{"to_rule": "lot", "kind": "same_row"}]                     // 필드 간 상대 관계(§9). same_row | same_column | offset{row,col}
    }
  ]
}
```

- area는 `range | find | relative | anchor` 중 **하나**. `find`는 `texts`(정확 일치, NFKC casefold) 또는 `regex`(Python `re`, `within` 필수, 10,000셀 이하) + `occurrence`.
- `relative`는 앵커(키의 첫 영역 또는 `anchor`)를 기준으로 한다. `relations`는 값 영역을 다른 rule의 해결된 값 영역 기준으로 다시 정렬한다(`same_row`: 같은 행의 값만 record에 결합).
- `normalization.steps[].op`: v2의 `trim_text | strip_thousands | split_unit_suffix | percent_to_ratio | automatic` + **`split_delimiter`**(`{"op":"split_delimiter","delimiter":",","index":0}`, identity §9). `operation`: `identity | trim | affine | pipeline`.
- `value_spec.type`: `text | decimal | boolean | date | datetime`. 수식은 저장된 결과만 읽는다(`formula_policy: cached_only`).
- 한도: 프로파일 512KB, sheet_roles 1~16, rules 1~200, area 1~32, anchors 64.
- **검증기** `kg/v3/profile.py`: `validate_profile(json) -> canonical(dict)`(기본값 채움, 오류는 `Problem(code, message)`; 코드는 v2 `INVALID_*`·`RANGE_LIMIT`·`UNSUPPORTED_*`를 유지하고 `INVALID_ANCHOR`·`INVALID_RELATION`·`INVALID_REGEX`·`UNKNOWN_FIELD`를 더한다). `compile_rule(rule, anchors) -> effective_spec`(앵커 참조를 인라인해 `mapping_revision.effective_spec_json`에 고정할 자기완결 rule).
- **Import Adapter** `kg/v3/adapters.py`: `detect_format(obj) -> 'parsing-profile-3.0' | 'v2-template' | 'v1-parsing-template' | 'generic-keyvalue'`, `to_canonical(obj, schema_fields) -> (canonical, report)`. v2 템플릿(`sheet_roles/rules[concept_id]`)은 `concept_id → field_key`; v1(`sheet_templates[].match/mappings[].source.range|key_search+offset`)은 `match.names → name`, `name_regex`, `headers → contains_text`, `key_search → find.texts`, `offset → relative`, `value_type number → decimal`; generic(`{"fields":[{"name","sheet","cell"|"label","offset","type","unit"}]}`)은 최소 형식. report는 변환 못 한 항목을 `warnings[]`로 남긴다.

Schema 정의 JSON(`schemas/.../r%04d.json`):

```jsonc
{"format": "parsing-schema", "schema_version": "3.0", "schema_key": "process_standard", "schema_name": "공정 데이터 표준",
 "fields": [{"field_key": "process", "name": "공정 정보", "type": "group", "level": 1},
            {"field_key": "temperature", "name": "온도", "type": "decimal", "unit": "°C", "level": 2, "parent": "process",
             "aliases": ["온도값", "Temp"], "description": "공정 설정 온도", "related": ["pressure"]}]}
```

`schema_key`는 사람이 읽는 안정 키(`parsing_schema.schema_id`는 UUID; API는 둘 다 받는다).

---

## 3. 실행 엔진 (`kg/v3/engine.py`)

- 입력: 열린 workbook 2개(raw/cached, v2 방식), `bindings{role:[sheet_name]}`, `effective_spec`(compile 결과) 목록.
- 출력: 이벤트 스트림 `{"type":"group", group_key, rule_key, observed_key, primary_sheet, regions{key,value,unit,context}}` →
  `{"type":"values", group_key, items[{item_index, record_key, raw_text, display_text, value_text, value_type, value_state, unit_raw, unit_normalized, formula_state, regions{...}}]}` → `{"type":"verified", token}`.
  v2 `XlsxReader.extract`의 리스트/행렬/병합/stop/결합/업무키 로직을 가져오되 다음을 더한다: `find.regex`, 이름 앵커·composite, `relations`, `split_delimiter`.
- 격리: Reader 프로세스 격리(`kg/v3/jobs.py`, v2 `jobs.py`를 v3 테이블 이름으로 옮김; 시간·메모리 한도 환경변수는 `KG_V3_READER_*`, 없으면 `KG_V3_`→`KG_V2_` 순으로 읽음).
- Reader 계약(`kg/v3/readers.py`): `make_reader(root, provider, principal)`; `XlsxReader`는 v2를 상속·재사용하고 `extract(source_ref, expected_token, specs, bindings)`만 v3 엔진으로 바꾼다. `describe`는 시트·서명·권한을 한 번에 돌려준다(등록 시 프로세스 1회).
- **매치 판정** `match_profile(profile_canonical, describe_result/sheet_grid) -> {"bindings":..., "compatibility": "identical"|"compatible"|"incompatible", "signature":..., "missing":[...]}`:
  1) `sheet_roles[].match`로 시트 바인딩(one은 정확히 1개, many는 1개 이상; 못 찾으면 incompatible).
  2) 각 rule의 키 앵커(find/anchor)를 해결. 하나라도 없으면 incompatible(`missing`에 rule_key).
  3) 구조 서명 = 정렬된 `[rule_key, sheet_role, 해결된 key locator, 해결된 unit locator]`의 SHA-256. 참조 서명(프로파일 `reference_application_id`의 서명)과 같으면 **identical**, 다르면 **compatible**.

---

## 4. 서비스 규칙 (`kg/v3/service.py`)

### 4.1 문서 등록 (`register`)
`describe` 1회 → `document`(provider, source_path로 upsert) + `document_snapshot`(content_sha256 같으면 새 snapshot 없음) + `sheet` + `snapshot_signature`.
등록 직후 **자동 적용**(§4.3)을 같은 작업에서 수행한다. 잠긴 파일(PK 매직 아님, DRM Reader 미등록)은 `DRM_READER_REQUIRED` 실패 작업으로 남고 문서는 `status='locked'`로 목록에 보인다(작업 내역 → 실패).

### 4.2 정의 가져오기
`import_schema(definition)`: 파일 저장 + projection upsert(추가·갱신·deprecated 표시, 삭제 없음). `import_profile(definition, format=auto)`: adapter → validate → 파일 저장 + rule projection. 둘 다 `current_rev` 증가. 프로파일 저장 시 `status`는 유지(승인은 별도).

### 4.3 자동 적용 (`auto_apply(snapshot_id)`)
`status IN ('approved','draft')`인 프로파일 전부에 대해 `match_profile`. `incompatible`은 건너뜀. 매치되면 `parsing_application(origin='auto')` + `application_sheet` + rule별 `mapping` + 리비전 1개:
- 프로파일 `approved` **and** compatibility `identical` → 리비전 `status='approved', origin='auto', evidence_json={reference_revision_id, profile_rev, signature}` → 곧바로 추출 실행(§4.6) → 발행. **사람 개입 없음** (identity §5·§6: 일치 문서 자동 처리).
- 그 외(compatible, 또는 프로파일 draft) → `status='proposed', origin='profile'` → 작업 내역 "매핑 검수" 큐.
여러 프로파일이 매치되면 모두 적용한다(N:M, scope_key='default'). 아무것도 매치되지 않으면 문서는 `unmatched`(작업 내역 "프로파일 미매칭").

### 4.4 새 snapshot (UC-5)
같은 `document`에 다른 `content_sha256`이 등록되면 새 snapshot + `current_snapshot_id` 갱신. 이전 snapshot의 application마다: 새 snapshot에 `match_profile` →
identical이고 이전 헤드가 approved면 `origin='inherited'`로 **승계 + 자동 승인**(evidence에 이전 리비전 ID) → 추출·발행; compatible이면 `proposed`(origin inherited) → "변경 감지" 큐; incompatible이면 application을 만들지 않고 "변경 감지 · 프로파일 불일치" 큐.
이전 snapshot의 값은 그대로 남는다(불변). 문서 목록·빌드는 `current_snapshot_id` 기준.

### 4.5 매핑 검수 (`revise`, `approve`, `reject`, `rollback`)
`POST .../mappings/{id}/revisions {expected_seq, status, field_key?, effective_spec?, regions?, reason}` → 새 리비전(불변) + 헤드 갱신(CAS). 승인된 헤드 집합이 바뀌면 `published_run_id`가 NULL이 되어 "재추출 필요"가 된다.
**승인 후 자동 재추출**: 요청에 `extract: true`(기본 true)면 같은 요청 안에서 application의 헤드가 모두 approved일 때 추출을 큐에 넣고 `wait`까지 처리한다(요청 1회로 검수→값 확인).

### 4.6 추출 (`extract(application_id)`)
헤드가 전부 `approved`여야 한다(아니면 422 `REVIEW_REQUIRED`, 미승인 rule 목록). `extraction_run(queued)` → Reader 격리 실행 → 값·영역 저장(배치 200) → `succeeded` + `published_run_id`. 실패는 `error_summary`와 함께 `failed`(작업 내역 "파싱 실패", 문서 상태 `failed`).

### 4.7 프로파일 테스트 (`test_profile(profile_id or definition, snapshot_id)`)
저장하지 않는 dry-run: match → compile → 엔진 실행 → 결과 `{bindings, compatibility, groups[{rule_key, observed_key, regions, values[:50]}], errors[]}`. Source Review는 이 결과의 regions를 overlay로 그린다(`origin='test'` application을 만들지 않는다).

### 4.8 프로파일 승인 (`approve_profile(profile_id, application_id)`)
대표 문서의 application(헤드 전부 approved)을 `reference_application_id`로 고정하고 `status='approved'`. 이후 §4.3의 자동 승인 기준이 된다.

### 4.9 재파싱 (`reparse(profile_id, mode)`) — 작업
`mode='fill'`: 이 프로파일이 적용된 현재 snapshot 중 `published_run_id IS NULL`이고 헤드 전부 approved인 건을 추출. `mode='rematch'`: 프로파일 새 리비전 이후, 적용 건마다 `match_profile` 재판정 → identical이면 승인 리비전을 새 profile_rev 스펙으로 갱신(origin auto)·추출, 아니면 proposed. 결과 `{queued, skipped[{application_id, reason}]}`.

### 4.10 데이터 빌드 (`build.py`)
입력 `{document_ids[] (current snapshot 기준), schema_key, columns[{field_key, header, target_unit?}], row_mode: 'record'|'document', format}`.
- 대상: 각 문서의 current snapshot에서 `published_run_id`가 있는 application의 값(`current_value` 뷰). 제외 사유: `unmatched | review_required | failed | not_extracted | locked`.
- 행: `row_mode='record'` → `(snapshot, record_key)`마다 1행; scalar 값(record_key 없음)은 그 문서의 모든 행에 복제. `row_mode='document'` → 문서당 1행(리스트는 첫 값 + `_count`).
- 같은 (행, field)에 값이 여럿이면 `source_identity_key`가 같은 것은 1개로, 다르면 첫 값을 쓰고 `conflicts[]`에 기록.
- 컬럼 검증: header 비어 있음/중복 → 422 `INVALID_HEADER`. 단위: `target_unit`이 있고 `unit_normalized`가 다르면 affine 변환(`config/units.yaml`의 `UnitRegistry` 재사용, 불가하면 conflict).
- Preview: 최대 50행, 각 셀 `{text, value_id, sheet_id, sheet_name, range, application_id, rule_key}` → `원본 보기`.
- Export: `data.csv`(UTF-8 BOM, CRLF) | `data.xlsx`(openpyxl, 헤더 굵게, 너비 자동) | `data.sqlite`(테이블 `data`, 컬럼은 header, `_source_<header>` 컬럼에 `sheet!range`, `_document`, `_snapshot`, `_record_key`). `manifest.json` = `{build_key, created_at, schema:{key, rev}, sources:[{document_id, snapshot_id, application_id, run_id, profile:{id,rev}}], columns:[{field_key, header, type, unit}], row_count, excluded:[...], conflicts:[...]}`. 산출물은 `<ws>/data/exports/<build_key>/`(build_key = 입력 SHA-256 앞 16자; 같은 입력이면 재사용 → 속도).
- 문서 200개·행 20만 이하는 동기, 초과는 작업(`runtime_job kind='build'`)으로 처리하고 `작업 내역`에서 다운로드.

### 4.11 작업 내역·검수 큐 (`operations.py`)
`queues()` → 요약 카운트와 목록: `unmatched`(프로파일 없음, 문서 구조 서명으로 묶음 "신규 양식 후보 · N문서"), `review`(proposed 헤드가 있는 application, 프로파일별 묶음), `failed`(마지막 실행 failed 또는 locked), `changed`(새 snapshot에서 proposed/불일치), `conflict`(빌드 conflicts 또는 unit 불일치). 각 항목에 `actions[]`(`open_review`, `create_profile`, `assign_profile`, `reparse`, `approve_all`)을 준다. **같은 원인·같은 서명은 묶는다**(문서 단위 나열 금지).

---

## 5. 렌더 서버 (`kg/v3/render/`)

| 파일 | 책임 |
|---|---|
| `renderer.py` | openpyxl → sheet JSON. `render_sheet(path, sheet_name, token) -> {renderer_version, sheet, rows[{index,y,height}], columns[{index,x,width}], cells[{r1,c1,r2,c2,range,text,style{...}}], images[{asset_id,x,y,width,height}], merges, freeze, width, height, estimated_rows, estimated_cols, truncated}`. 상한 2,000행 × 200열(초과는 `truncated: true`, 창 요청은 캐시 범위 안에서만). 셀은 값이 있거나 스타일이 기본과 다른 것만 담는다(빈 셀 생략 → JSON 축소). 이미지는 `assets/<sha256>.<ext>` 파일로 저장하고 URL만 담는다(base64 인라인 금지). |
| `cache.py` | 키 `(snapshot_id, sheet_id, renderer_version)`. `get / put / window(json, range) / invalidate(snapshot_id)`. 파일 + 프로세스 내 LRU 16개. |
| `server.py` | FastAPI. `POST /render {snapshot_id, provider, source_ref, expected_token, sheet_id, sheet_name, range?}` → 캐시 있으면 **200** `{status:'cached', sheet:{...창...}}`, 없으면 큐에 넣고 **202** `{status:'queued'|'rendering', job_id}`. `GET /render/{snapshot_id}/sheets`, `GET /render/{snapshot_id}/sheet/{sheet_id}?range=C10:F30` → 200 창 JSON(ETag = renderer_version+token+range, `Cache-Control: private, max-age=3600`) 또는 202 `{status:'rendering'}` 또는 404 `NOT_RENDERED`. `GET /render/assets/{asset_id}`(immutable 캐시 헤더). `DELETE /render/{snapshot_id}`. `GET /render/status`. 워커 1개(스레드 큐, `KG_V3_RENDER_CONCURRENCY` 기본 1). 렌더는 Reader 격리 프로세스에서 수행(DRM Reader는 `KG_V3_READER_FACTORY`). |
| `client.py` | `RenderClient`: `KG_V3_RENDER_URL`이 있으면 HTTP(httpx, 타임아웃 2초 — 메인 API는 절대 렌더 완료를 기다리지 않는다), 없으면 in-process(같은 큐·캐시 클래스를 스레드로). 메인 API는 `request(snapshot, sheet, range)`가 돌려준 `{status, sheet?}`를 그대로 전달한다. |

메인 API 프록시: `GET /api/v3/snapshots/{sid}/sheets/{sheet_id}/render?range=` → 200 창 JSON | 202 `{status}`; `GET /api/v3/render-assets/{asset_id}` → 바이트(스트리밍). 권한은 메인 API가 매 요청 `authorize(view)`.
UI는 202를 받으면 **뷰어 영역만** "렌더링 중"을 표시하고 700ms 간격으로 같은 GET을 다시 부른다(다른 화면·API는 영향 없음 — e2e에서 검증).

---

## 6. API (`kg/v3/api.py`, prefix `/api/v3`)

공통: 오류 `{"error":{"code","message","fields?"}}`; 목록 `{"items","has_more","next_cursor"}`(keyset, `limit` 기본 50 최대 200); 쓰기는 Pydantic 모델(`contracts.py`, `extra=forbid`); 작업 응답 `JobResponse{job_id,kind,state,completed,total,result,error_code,error_message,target_kind,target_id,label,created_at,finished_at}`; 접근 토큰 `KG_V3_ACCESS_TOKEN`(없으면 `KG_V2_ACCESS_TOKEN`), principal `KG_V3_PRINCIPAL`. 본문 2MB 상한. `Cache-Control: no-store`(렌더 창·asset 제외).
`?wait=<초>`를 받는 작업 엔드포인트는 그 시간까지 작업 완료를 기다렸다가 최종 `JobResponse`를 돌려준다(기본 0 = 즉시 202).

| 화면 | Method 경로 | 요약 |
|---|---|---|
| 공통 | `GET /status` | `{version:'3', workspace, render:{mode:'http'|'inprocess', url}, counts{documents,profiles,schemas,jobs_running}}` |
| 공통 | `GET /search?q=` | 문서·프로파일·스키마·필드 통합 검색(각 최대 5건, `kind`, `id`, `label`, `route`) — 헤더 검색창 |
| 문서 | `GET /sources?directory=` · `POST /documents/register {source_refs[], provider, document_id?} (job, wait)` | 원본 폴더 목록 · 등록(+자동 적용·추출까지 한 작업) |
| 문서 | `GET /documents?q=&status=&profile_id=&schema_key=&sort=&cursor=&limit=` | 행: `{document_id, document_name, provider, file_type, status: normal|unmatched|review|failed|changed|locked|not_extracted, current_snapshot{snapshot_id, revision_no, captured_at, content_sha256}, profiles[{profile_id, profile_name, rev, application_id, state}], schemas[{schema_key, schema_name}], last_processed_at, last_error}` (페이지 범위 요약) |
| 문서 | `GET /documents/{id}` · `GET /documents/{id}/snapshots` · `GET /snapshots/{sid}/sheets` · `GET /snapshots/{sid}/applications` | 상세 드로어 탭(파일 보기 · 추출 결과 · 적용 프로파일 · 연결 스키마) |
| 문서 | `GET /snapshots/{sid}/values?field_key=&rule_key=&cursor=` | 추출 결과 표(값 + 원본 위치) |
| 문서 | `POST /snapshots/{sid}/applications {profile_id, sheet_bindings?} (wait)` | "다른 프로파일로 파싱"(수동 적용; 바인딩 생략 시 match) |
| 문서 | `GET /snapshots/{sid}/sheets/{sheet_id}/render?range=` · `GET /render-assets/{asset_id}` | §5 |
| 프로파일 | `GET /profiles?q=&status=&schema_key=` | `{profile_id, profile_name, current_rev, schema{key,name}, status, document_count, success_rate, updated_at}` |
| 프로파일 | `GET /profiles/{id}` · `GET /profiles/{id}/revisions` · `GET /profiles/{id}/revisions/{rev}` | 상세(기본 정보·규칙·필드 매핑·JSON·변경 이력). JSON은 canonical |
| 프로파일 | `POST /profiles {name?, definition, format?:'auto'}` · `PUT /profiles/{id} {definition, format?}` | 생성/새 리비전(adapter 경유). 응답에 `report{format_detected, warnings[]}` |
| 프로파일 | `POST /profiles/import-preview {definition, format?}` | 변환 미리보기(저장 없음): `{format_detected, canonical, warnings[], errors[]}` |
| 프로파일 | `POST /profiles/{id}/test {snapshot_id}` · `POST /profiles/test {definition, snapshot_id}` | §4.7 (동기, 20초 상한) |
| 프로파일 | `POST /profiles/{id}/approve {application_id}` · `POST /profiles/{id}/reparse {mode} (job)` · `GET /profiles/{id}/documents` | §4.8·§4.9·적용 문서 목록 |
| 프로파일 | `GET /profiles/{id}/export` | canonical JSON 다운로드 |
| 스키마 | `GET /schemas` · `GET /schemas/{key}` · `GET /schemas/{key}/tree` · `GET /schemas/{key}/graph` · `GET /schemas/{key}/revisions` | 목록(필드·프로파일·문서 수) · 상세 · 트리(중첩) · 그래프(nodes/edges, 프로파일 수·문서 수 주석) |
| 스키마 | `GET /schemas/{key}/fields/{field_key}` · `.../fields/{field_key}/profiles` · `.../fields/{field_key}/documents` · `.../fields/{field_key}/values?limit=` | 필드 상세(alias, 부모/자식/related, 사용 프로파일 수, 문서 수, 최근 값 + 원본 위치) |
| 스키마 | `GET /schemas/{key}/profiles` · `GET /schemas/{key}/documents` | 상세 탭 "사용 프로파일" · "연관 문서" |
| 스키마 | `POST /schemas {definition}` · `PUT /schemas/{key} {definition}` · `PATCH /schemas/{key}/fields/{field_key} {name?, description?, aliases?, status?}` | 가져오기/새 리비전/필드 단건 편집(파일 리비전 + projection) |
| 빌드 | `POST /builds/preview {document_ids[], schema_key, columns[], row_mode}` | `{columns, rows[:50], row_count, excluded[], conflicts[]}` |
| 빌드 | `POST /builds {…, format} (wait)` → `{build_key, download_url, manifest}` · `GET /builds/{build_key}/download` · `GET /builds/{build_key}/manifest` | 산출물 |
| 빌드 | `GET /builds/candidates?schema_key=&document_ids=` | 문서별 사용 가능/제외 사유(1단계 표시) |
| 검수 | `GET /applications/{aid}` · `GET /applications/{aid}/mappings` · `GET /mappings/{mid}` · `GET /mappings/{mid}/revisions` | Source Review 우측 패널. 응답은 `rule_key, rule_name, field{key,name,type,unit}, observed_key, status, effective_spec, regions[], revision_no, edit_seq` |
| 검수 | `POST /mappings/{mid}/revisions {expected_seq, status, field_key?, effective_spec?, regions?, reason?, extract?}` · `POST /mappings/{mid}/rollback` · `POST /applications/{aid}/approve-all {extract}` · `POST /applications/{aid}/extract (job, wait)` | §4.5·§4.6 |
| 검수 | `GET /applications/{aid}/values?rule_key=` · `GET /values/{vid}` · `GET /regions/{rid}/values` | 추출값·역방향 조회(셀 → 값·매핑) |
| 작업 | `GET /jobs?state=&kind=&cursor=` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | 작업 내역 |
| 작업 | `GET /queues` · `GET /queues/{kind}?cursor=` | §4.11 |
| 설정 | `GET /normalization-presets` · `GET /settings` | 프리셋 · 읽기 전용 설정 표시(render 모드, reader, 한도) |

---

## 7. 프런트 (`frontend/src/v3/`)

레이아웃(승인 목업 `docs/design/assets/ui-approved-mockup.svg`): 좌측 사이드바(제품명 **Semantic Excel Integration**, 부제 Document-to-Table Adapter, 메뉴 `문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역`, 하단 `설정`), 상단 통합 검색, 본문 카드(흰 패널, 1.2px `#d8e0ea` 테두리, 배경 `#f6f8fb`, 강조 `#2563eb`, 활성 `#e8f0ff`). 상태 칩: 정상 `#dcfce7` · 검수 `#fef3c7` · 실패 `#fee2e2`.

| 파일 | 내용 |
|---|---|
| `App.tsx`(수정) | 기본 → `v3/Workbench`, `?v2=1` → v2, `?v1=1` → v1, `?legacy=1` → 레거시 |
| `v3/client.ts` | `api()`, `useData`, `usePage`(keyset), `useRoute`(URL `?screen=&…`), `useJob(wait)`; 요청 중복 제거(같은 URL in-flight 공유), 응답 메모리 캐시(60초, 쓰기 후 무효화) |
| `v3/Workbench.tsx` | 사이드바·검색·라우팅·`JobBar`(진행 중 작업 수), `SourceReview` 오버레이 마운트. 화면은 `React.lazy` |
| `v3/Documents.tsx` + `DocumentDetail.tsx` | 표(검색·상태·프로파일 필터, 정렬, 다중 선택 → "데이터 빌드에 추가"), 행 클릭 드로어(모달, 탭 파일 보기·추출 결과·적용 프로파일·연결 스키마, 행동 `원본 보기`·`다른 프로파일로 파싱`·`데이터 빌드에 추가`). 관계 `문서 → 프로파일 → 스키마` 카드 |
| `v3/Profiles.tsx` + `ProfileDetail.tsx` + `ProfileImport.tsx` | 목록 → 상세 탭 `기본 정보 · 규칙 · 필드 매핑 · 테스트 · JSON · 변경 이력`. 규칙 폼(sheet role, key/value/unit/context selector 요약, 필드, type/unit/normalization) + JSON 고급 편집(검증 오류 표시). 외부 Import 대화상자(붙여넣기/업로드 → 형식 판별 → canonical 미리보기 → 경고 → 대표 문서 테스트 → 저장). 테스트 탭: 문서 선택 → 실행 → Source Review(test 모드) |
| `v3/Schema.tsx` + `SchemaTree.tsx` + `SchemaGraph.tsx` + `FieldDetail.tsx` | 3열(목록 / 상세 탭 `구조 보기·사용 프로파일 (N)·연관 문서 (N)·변경 이력` / 필드 상세). 구조 보기 안에서만 `[트리 보기] [그래프 보기]` 토글(URL `view=`). 그래프는 v2 `DomainGraph` 배치 재사용. 필드 상세: 필드명·영문명·타입·단위·alias·관계·사용 프로파일 N개 보기 ›·연관 문서 N개 보기 ›·`Source Review 열기`·필드 편집(alias/설명/폐기) |
| `v3/Build.tsx` | 5단계 스텝퍼 `대상 문서 → 스키마 → 출력 설정 → 미리보기 → 생성`. 출력 설정 표: 사용 체크 · 원본 Field · **출력 Header 입력**(기본 = 필드명, 빈값/중복 즉시 오류) · Type · Unit · 순서(↑↓ 버튼 + 드래그). 미리보기 각 셀 `원본 보기`. 생성: CSV ○ XLSX ● SQLite ○ → 다운로드 + manifest 링크. 제외 문서와 사유 |
| `v3/Jobs.tsx` | 상단 요약 카드(신규 양식 · 매핑 검수 · 파싱 실패 · 변경 감지 · 충돌) + 큐 탭(묶음 행: 대상 · 원인 · 영향 · 처리 버튼) + 작업 목록(종류 · 대상 · 상태 · 시작 · 종료 · 결과/오류, 실패 → 이동) |
| `v3/SourceReview.tsx` + `SheetViewer.tsx` | 전체 화면 오버레이(`?review=<application_id>&rule=&sheet=&range=` 또는 `?test=`). 3열: 좌 시트·프로파일·규칙 목록 / 중앙 **가상화 그리드**(창 요청, 셀 스타일·병합·이미지 lazy, 확대 50~150%, `A1` 이동, overlay key/value/unit/context/focus, 드래그로 영역 재지정) / 우 필드·규칙·observed key·추출값(단위)·원본 위치·상태·`수정 · 승인 · 반려`·접힌 상세(selector JSON, 변경 이력, 복원). 202 응답 시 뷰어 영역만 스피너 |
| `v3/v3.css` | 토큰·레이아웃·표·칩·그리드·오버레이 |
| `frontend/tests/v3-*.test.tsx` | 화면별 컴포넌트 회귀(fixture로 API 대체): 네비게이션 순서·문서 표·헤더 편집 검증·트리/그래프 토글·Source Review overlay·큐 묶음 |

성능 규칙: 화면 진입 시 API 호출 ≤ 3개. 목록 행 ≤ 50/페이지. 그리드는 보이는 창 + 1창 선행 요청, 셀 DOM ≤ 3,000. 이미지 `loading="lazy"`. 검색은 250ms 디바운스. 모든 버튼은 첫 클릭에서 즉시 상태 반영(낙관적 갱신, 실패 시 되돌림).

---

## 8. E2E (`e2e/v3/`)

- `serve.py`: 임시 작업 공간 생성 → `examples/schema_v3/demo.py`의 `seed(root)`로 가상 문서·스키마·프로파일 생성 → 렌더 서버(포트 8032, 별도 `subprocess`) → 메인(8031, `KG_V3_RENDER_URL=http://127.0.0.1:8032`). 종료 시 둘 다 정리. 실제 도메인 DB·사용자 원본은 열지 않는다.
- 시드(모두 openpyxl로 생성): 스키마 `공정 데이터 표준`(그룹 3, 필드 9). 프로파일 `공정데이터_A양식`(approved, 대표 문서 `공정데이터_2024_01.xlsx`). 같은 양식 문서 3개(자동 적용·승인·발행), 앵커가 이동한 문서 1개(compatible → 검수), 다른 양식 1개(unmatched), 잠긴 파일 1개(locked), 이미지가 있는 시트 1개(asset lazy 검증). 시나리오 중 `공정데이터_2024_01.xlsx` 내용을 바꿔 재등록 → 변경 감지.
- 스펙: `documents.spec.ts` · `profiles.spec.ts` · `schema.spec.ts` · `build.spec.ts` · `jobs.spec.ts` · `source-review.spec.ts` · `render-isolation.spec.ts`(렌더 중 문서 API 응답 시간 측정, 캐시 재접근 < 1초). 각 스펙은 `pageerror`/`console.error`를 실패로 본다. 다운로드 파일은 내용까지 검사(CSV 행수·헤더명·`_source_` 컬럼, SQLite 쿼리, XLSX 헤더).
- 결과 문서 `docs/e2e-results-v3.md`: 실행 명령, 환경, list reporter 출력 전문, 시나리오별 검증 항목, 측정 시간(렌더 최초/재접근, 목록 응답), 실패·건너뜀·경고, 재현 절차.

---

## 9. 마이그레이션 (`kg/v3/migrate.py`, `python -m kg.v3 migrate --ws <v3> --from-ws <v2> [--dry-run --report]`)

| v2 | v3 |
|---|---|
| `document`·`document_version`·`sheet`·`source_region` | `document`(provider/source_ref→source_path)·`document_snapshot`·`sheet`·`source_region`(`document_version_id` 제거) |
| 최신 `kg_revision`의 `domain_concept/alias/edge` | `parsing_schema`(key `migrated_kg`) + `parsing_field`(concept_id→field_key, level, deprecated 유지)·alias·edge(`parent_of`, `related`→`related_to`). 정의 파일 r0001 생성 |
| `template`·`template_version`(최신)·`template_rule` | `parsing_profile`(draft) + adapter(v2-template) → 파일 r0001 + `parsing_rule` |
| `template_application`·`application_sheet` | `parsing_application(origin='manual', profile_rev=1)`·`application_sheet` |
| `mapping_head`·`mapping_revision` | `mapping`·`mapping_revision`(status 유지, origin `import`, effective_spec 그대로) |
| `extraction_run`·`run_mapping`·`extracted_series`·`extracted_item`·`item_region`·`series_region` | `extraction_run(input_manifest에 mappings)`·`extracted_value(group_key=series.instance_key, value_state blank→empty)`·`extracted_value_region`(item_region 그대로 + series_region은 `role` 접두 `group_`으로 첫 항목에만) · 발행 실행 유지 |
| `integration_*`·`build_*` | DB로 옮기지 않음. 빌드마다 `<ws>/data/exports/migrated-<build_id>/manifest.json`으로 내보냄 |
| `runtime_job`·`version_signature` | 옮기지 않음(재생성) |

보고서: 테이블별 건수, 건너뜀 사유, 재추출 필요 목록.

---

## 10. CLI (`python -m kg.v3`)

`serve --ws --port [--host]` · `render-serve --ws --port` · `watch --ws [--raw --interval --once]`(등록+자동 적용) · `migrate …` · `import-schema --ws --file` · `import-profile --ws --file [--format]` · `build --ws --schema --documents … --format --out` · `seed-demo --workspace`. 모두 시작 시 `.env` 로드(`kg/env.py`).

---

## 11. 테스트 기준

- `tests/test_schema_v3.py`: 불변식(리비전 불변, CAS, 발행 조건과 헤드 변경 시 NULL, projection 삭제 금지, snapshot 바인딩, 단일 출처 경로, parent_of 레벨).
- `tests/test_v3_profile.py`(DSL·adapter·compile), `tests/test_v3_engine.py`(regex/anchor/composite/relations/split_delimiter/list/matrix/merged/stop), `tests/test_v3_render.py`(캐시 키·창·asset·202/200·격리), `tests/test_v3_runtime.py`(API 통합: 등록→자동 적용→승인/자동 승인→추출→값/역조회→빌드 3형식+manifest→큐→새 snapshot 승계→프로파일 테스트/승인/재파싱→검색), `tests/test_v3_migrate.py`, `tests/test_v3_build.py`.
- 기존 v1·v2 테스트는 그대로 통과해야 한다.
- 성능 회귀(단위): 문서 2,000건 목록 페이지 < 50ms(SQLite, 로컬), 렌더 캐시 창 응답 < 20ms.
