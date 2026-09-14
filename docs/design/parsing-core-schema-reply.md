# 22개 코어안에 대한 답변 — 합의 확인과 남은 결함 5개

작성일: 2026-09-11
대상: [`parsing-core-schema.md`](parsing-core-schema.md) (커밋 `07b5de0`)
근거: `db/v2/schema_sqlite.sql`, `kg/v2/spec.py`·`build.py`·`features.py`·`graph.py`·`api.py`·`recrawl.py`, `db-schema-v2.md` §8.
아래 파일:줄 표기는 이 커밋 기준이다.

> 이 문서는 2026-09-11 시점의 검토 기록이다. 여기서 가리키는 이전 세대 코드(`kg/v2/`·`db/v2/`)와 문서(`db-schema-v2.md`·`v2-restoration.md`)는
> 이후 저장소에서 삭제됐다([decisions.md §12](decisions.md)) — 이름은 당시 근거를 밝히기 위해 그대로 두고 링크만 풀었다. 현행 계약은 [contracts.md](contracts.md)다.

## 결론

22개안의 방향에 동의한다. 병합 권고 4건(run_mapping·build_input 제외, series_region+item_region 통합, integration_project 흡수)과
복귀 3건(application_sheet, extracted_series, integration_source)이 반영됐고, 남은 차이는 테이블 수가 아니라 **컬럼과 바인딩 단위**다.

- 철회: `access_observation`을 A(불변식)로 분류한 것. 22개안 §6의 구분(정확성은 provider 재확인, 저장은 감사)이 맞다.
  설계 §8도 "권한 관찰 행은 감사용이다. 매 요청에서 실제 권한을 확인한다"고 적고 있다. 운영 테이블로 둔다.
- 결함으로 보는 것 5개(§1). 이 중 1·2는 22개안이 스스로 세운 불변식 3·1과 충돌하므로 DDL 확정 전에 고쳐야 한다.
- §7 검증 질문 5개에 대해 "현재 v2가 어떻게 동작하는지"만 답한다(§2). 요구인지는 사용자 결정이다.

## 1. 결함 5개

### 1-1. `mapping_revision`에 스펙 스냅샷이 없다 — 불변식 3 위반

초안의 `mapping_revision`은 `field_id`, `observed_key`, `status`만 갖는다(§3). 영역은 `mapping_region`으로 빠졌지만
**값을 어떻게 읽고 변환하는지**는 어디에도 고정되지 않는다.

v2는 `mapping_revision.effective_spec_json`에 셀렉터·값 타입·`normalization`(identity/trim/affine/pipeline)을 함께 저장하고,
`spec.py:244-256`이 리비전 저장 시 이를 검증한다. 프리셋은 이름이 아니라 연산 배열로 고정된다(복원 기록 `v2-restoration.md` §전처리).

초안대로면 `parsing_rule.value_spec`(현재 projection)이나 `normalizers.yaml`을 바꾸는 순간 과거 추출의 의미가 바뀐다.
답장 §1이 지적한 "어제 B3→온도, 오늘 B3→압력"과 같은 종류의 문제가 값 변환 축에서 되풀이된다.

**고침**: `mapping_revision`에 `effective_spec`(JSON, 셀렉터+값 명세+정규화 연산) 컬럼을 둔다. `mapping_region`을 유지하려면
스펙 JSON의 영역 부분과 `mapping_region`이 같은 내용을 두 번 갖게 되므로, 둘 중 하나만 진실로 정한다.
"이 셀을 참조하는 매핑 전부"를 SQL로 찾을 요구가 없으면 `mapping_region`을 빼고 22→21개로 줄이는 쪽을 권한다.

### 1-2. `parsing_application`은 document, 영역·시트는 snapshot에 묶인다 — 바인딩 단위 불일치

초안: `parsing_application.document_id`, `application_sheet.sheet_id → sheet.snapshot_id`, `mapping_region.region_id → source_region → sheet → snapshot`.
문서에 새 snapshot이 들어오면 같은 application의 시트 바인딩과 매핑 영역은 **이전 snapshot**을 가리킨다.
새 snapshot에 대해 매핑을 새로 검수해야 하는지, 승계하는지, 승계한 매핑의 상태는 무엇인지가 정의되지 않는다.

v2는 `template_application.document_version_id`로 적용 건을 버전에 묶고, 새 버전은 재크롤링이 새 적용 건을 만든다(`recrawl.py:7-16`).
`mapping_revision`에도 `document_version_id`·`template_version_id`가 있어 리비전이 어느 파일 상태에서 검수됐는지 남는다.

**고침**: `parsing_application.snapshot_id`로 바꾸거나(v2 방식), document에 두려면 `mapping_revision.snapshot_id`를 추가하고
"새 snapshot의 매핑은 이전 승인본을 `candidate`로 복사, 자동 승인 없음"을 규칙으로 적는다(설계 §4 "매핑 자동 승인 금지"와 일치).

### 1-3. `parsing_schema`·`parsing_profile` 리비전 제거 — 현재 UI가 과거 리비전을 SQL로 읽는다

22개안 §5는 field/alias/edge와 rule을 "현재 projection"으로 두고 `extraction_run.schema_rev/profile_rev`에 pin한다.
이 전제는 "과거 리비전을 DB에서 동시에 조회하지 않는다"이다. 현재 v2는 조회한다.

| 조회 | 위치 | 하는 일 |
|---|---|---|
| 문서 목록의 루트 개념 이름 | `features.py:70` | 매핑에 고정된 `m.kg_revision_id`의 개념 이름 |
| 커버리지 그래프(hull), 이웃 탐색 | `graph.py:25`, `graph.py:240` | 매핑 고정 리비전으로 조인 |
| 개념별 소스·시리즈 조회 | `api.py:490`, `api.py:706-729` | `(kg_revision_id, concept_id)` 쌍으로 이름과 소스 |

폐기·개명된 개념을 가진 과거 매핑을 "그 당시 이름"으로 보여주는 것이 요구라면 리비전 테이블이 필요하고,
"현재 이름으로 보여주되 폐기된 것은 표시"로 충분하면 초안대로 갈 수 있다. 후자를 택하면 위 세 조회와 검수 이력 화면이 바뀐다.
**답**: §7-2는 현재 동작 기준으로 "예"다. 요구인지는 사용자 결정.

### 1-4. `extracted_value` 최소 컬럼에서 빠진 4개는 빌드가 쓴다

초안 컬럼: item_index, record_key, raw_text, value_text, value_type, unit_raw, unit_normalized.
빠진 것 중 런타임이 쓰는 것:

| 컬럼 | 사용처 | 역할 |
|---|---|---|
| `value_state` | `build.py:334`, `build.py:363` | 결측/비어있음/존재 판정. 통합 DB의 NULL 규칙 |
| `source_identity_key`, `derivation_key` | `build.py:357` | 같은 원본 셀에서 두 규칙이 뽑은 값의 중복 제거 |
| `formula_state`, `display_text` | `api.py:773` | 검수 화면에서 수식 셀·표시값 확인(설계 §8 "저장된 수식 결과만 읽는다") |

`row_ordinal`·`col_ordinal`은 `extraction_region`으로 옮길 수 있다. 나머지 4개는 값 테이블에 있어야 한다.

### 1-5. `integration`이 제자리 수정되면 과거 빌드를 재현할 수 없다

초안의 `integration`은 `spec_json` + `revision_or_dvc_ref nullable`이고 `integration_field`·`integration_source`가 `integration_id`를 직접 참조한다.
`build_run`을 운영으로 뺀 상태에서 spec을 고치면 "어느 정의로 만든 산출물인가"는 DVC ref에만 남는다.
DVC를 쓰지 않는 배포(§7-1이 "불가"인 경우)에서는 남지 않는다.

**고침**: 매핑과 같은 규칙을 적용한다. `integration`은 안정 ID, 정의는 `integration_revision`(불변)에 두고 필드·소스·빌드는 리비전을 참조한다.
v2의 `integration_project`+`integration_version` 구조가 바로 이것이며, 앞서 "project 흡수"를 권한 것은 이름 테이블을 없애자는 뜻이지 리비전을 없애자는 뜻이 아니었다.
테이블 수는 그대로다(integration → integration + integration_revision, mapping_region 제거와 상쇄).

## 2. §7 검증 질문 — 현재 동작 기준 답

| # | 질문 | 현재 v2 | 모르는 것 |
|---|---|---|---|
| 1 | DRM 원본을 DVC remote에 둘 수 있는가 | 두지 않는다. `document_version.source_artifact_id`는 로컬 사본 포인터이고 DVC 내보내기는 manifest만 싣는다 | 정책. 사용자/보안 담당 결정 |
| 2 | 과거 schema revision을 DB에서 동시에 탐색하는가 | 한다(§1-3의 세 조회) | 요구인지 |
| 3 | 통합 DB 셀 → 원본 셀 역추적이 필수인가 | 있다(`Database.tsx`의 lineage → `/items/{id}/regions`), v1에도 `_source_*` 컬럼이 있었다 | 요구인지 |
| 4 | Parsing Schema를 하나만 운용하는가 | 하나(`kg_revision`은 단일 계보). `parsing_schema` 테이블은 현재 요구에 없다 | 다분야 운용 계획 |
| 5 | 실패 실행의 입력 매핑을 FK로 보존해야 하는가 | manifest로 충분하다고 본다. 실패 실행은 재실행 대상이지 조회 대상이 아니다 | — |

## 3. 수정 반영 시 코어 목록

22개안에서 §1을 반영하면:

- 제거: `mapping_region`(스펙 JSON이 진실) → 21
- 추가: `integration_revision` → 22
- 조건부 추가: `schema_revision`·`profile_revision`(§7-2가 "요구"이면) → 24

컬럼 추가: `mapping_revision.effective_spec`·`snapshot_id`, `extracted_value.value_state`·`source_identity_key`·`derivation_key`·`formula_state`·`display_text`.
바인딩 변경: `parsing_application.snapshot_id`(또는 §1-2의 승계 규칙).

## 4. 다음 단계 제안

§1-1·1-2·1-5는 사용자 결정 없이 고칠 수 있는 결함이므로 DDL 초안에 먼저 반영하고,
§7의 1·2·3은 결정이 나올 때까지 v2 테이블(`kg_revision`, `template_version`, `build_lineage`)을 유지한다.
합의된 병합 4건은 지금 v2 DDL 마이그레이션으로 구현할 수 있다(`schema_meta` 버전 올림, 테스트 갱신). 이 작업은 위 결정과 독립이다.

---

## 5. 18개안(커밋 `8a9da5c`, 2026-09-14)에 대한 확인

같은 경로의 문서가 22개안에서 18개안으로 개정됐다. 위 §1~§4는 22개안 기준이며, 18개안에 대한 확인은 이 절에 적는다.
사용자가 2026-09-13 채팅에서 18개안에 동의했으므로 §1-3(리비전 동시 조회)·§2의 질문 2·3·4·5는 결정된 것으로 본다.

### 5-1. 해소된 것

| §1 결함 | 18개안의 처리 |
|---|---|
| 1-1 스펙 스냅샷 없음 | `mapping_revision.effective_spec_json` 추가. `parsing_rule`은 projection, 실행 의미는 리비전이 고정 |
| 1-2 바인딩 단위 불일치 | `parsing_application.snapshot_id`, `mapping_revision.snapshot_id`. 새 snapshot은 candidate/proposed로 승계, 자동 승인 없음 |
| 1-3 과거 리비전 SQL 조회 | 제거 유지. `parsing_application`·`extraction_run`의 `schema_rev`/`profile_rev` pin으로 대체 — 사용자 결정 |
| 1-4 값 컬럼 4개 | `value_state`·`source_identity_key`·`derivation_key`·`formula_state`·`display_text` 복귀 |
| 1-5 integration 제자리 수정 | integration·build 계열을 코어에서 제거하고 일회성 export + manifest로 — 사용자 결정 |

`extracted_series` 제거는 문제없다. `cardinality`·`axis`는 이미 값 명세(`spec.py:186-194`)에 있어 `effective_spec_json`으로 따라오고, 묶음 정체성은 `group_key`로 남는다.

### 5-2. 남은 빈칸 3개 (DDL 확정 전 처리)

1. **발행 실행이 없다.** 22개안에 있던 `parsing_application.published_run_id`가 빠졌다. v2는 이 컬럼으로 "이 적용 건의 현재 값은 어느 실행인가"를 정하며 `extract.py`·`api.py`·`graph.py`·`features.py`·`build.py`·`recrawl.py` 17곳이 참조한다. 없으면 "가장 최근 succeeded 실행"이 암묵 규칙이 되고, 재추출 중 이전 값이 보이는 문제와 실패한 재추출 뒤 어느 값이 현재인지가 정의되지 않는다. `published_run_id`(nullable, FK → extraction_run)를 되돌리기를 권한다.
2. **projection 동기화 규칙.** `parsing_field`·`parsing_rule`을 정의 파일의 현재 projection으로 두면서 `mapping_revision.field_id`·`mapping.rule_id`가 FK로 참조한다. 정의 파일에서 필드·규칙이 사라졌을 때 행을 지우면 과거 리비전의 FK가 깨진다. "projection은 추가·`status=deprecated` 표시만 하고 삭제하지 않는다"를 규칙으로 적어야 한다. `parsing_rule`에는 `status` 컬럼이 없으므로 추가가 필요하다.
3. **값 출처의 이중 표현.** `extracted_value.source_region_id`(단일)와 `extracted_value_region`(복수)을 함께 두면 "이 셀에서 나온 값 전부" 조회가 두 경로의 UNION이 된다. 원본 UI의 역방향 조회가 18개안 §7.3의 근거이므로, 값 쪽도 한 경로로 통일(항상 `extracted_value_region`, 단일 출처는 행 1개)하는 편이 조회가 단순하다. 저장 행 수는 늘지만 v2의 `item_region`이 이미 그 방식이다.

### 5-3. 현재 제품에서 바뀌는 것 (사용자가 동의한 결과)

- **통합 DB 탭**: 통합 정의·빌드 이력·lineage 조회(`Database.tsx`의 `/integrations`, `/builds`, lineage 패널)가 영속 객체가 아니게 된다. 선택 → 파일 생성 → 다운로드의 일회성 화면으로 바뀌고, 결과 셀에서 원본 셀로 가는 기능은 파일의 `_source_*` 컬럼으로 옮긴다. 전처리 프리셋은 매핑 리비전의 `normalization`으로 이미 옮겨져 있어 유지된다.
- **개념 탐색**: KG 리비전 목록·과거 리비전 이름 조회가 없어진다. 폐기 필드는 `status=deprecated`로 현재 projection에서 표시한다. 개념 단건 편집(현재 새 KG 리비전 발행)은 정의 파일 수정 + projection 재적재로 바뀐다.
- **파일 분석 목록의 접근 상태 열**: `access_observation`이 코어 밖이므로 목록 표시용 캐시로 남기거나 열을 없앤다.
- **용어**: Domain KG/개념/템플릿 → Parsing Schema/Field/Profile. 물리 이름 변경 시점은 18개안도 별도 결정으로 남겼다.

### 5-4. 구현 경로

18개안은 v2 런타임(32테이블, 백엔드 테스트 250개, 5탭 UI)과 테이블 절반이 다르므로 제자리 마이그레이션이 아니라 **v3**다.
앞서 제안한 "v2 안에서의 병합 4건"은 그중 3건(run_mapping, build_input, integration_project)이 v3에서 사라지는 테이블에 대한 것이라 하지 않는다.

1. `db/v3/schema_sqlite.sql`·`schema_postgres.sql` + 불변식 테스트(리비전 불변, 승인 CAS, snapshot 바인딩, projection 삭제 금지).
2. v2 → v3 데이터 이관 스크립트: series → `group_key`, `item_region`/`series_region` → `extracted_value_region`, `kg_revision`·`template_version` → 정의 파일 + `schema_rev`/`profile_rev`, integration/build → manifest 파일로 내보내기.
3. 런타임·API·UI를 v3로 전환(통합 DB 탭 재설계 포함). v2는 이관이 끝날 때까지 유지.
