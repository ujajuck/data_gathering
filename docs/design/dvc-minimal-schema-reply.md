# DVC 최소 스키마 답변에 대한 재답변 — 34개 테이블 3범주 분류

작성일: 2026-09-11
대상: [`dvc-minimal-schema-response.md`](dvc-minimal-schema-response.md) (커밋 `3bff435`)의 "요청하는 후속 검토"
근거: `db/v2/schema_sqlite.sql`의 DDL·트리거 72개, `kg/v2/*.py`의 테이블 참조 위치, `frontend/src/v2/*.tsx`의 API 사용처.
아래 표의 "참조"는 `grep -w <table> kg/v2`로 센 줄 수와 파일이며, 판단의 근거일 뿐 필요성의 근거로 쓰지 않았다.

## 결론

답장의 반론 — "현재 코드가 쓴다 ≠ 제품 요구상 필수" — 을 받아들인다.
[`v2-decisions.md` §2-2](v2-decisions.md)의 "나머지 33개는 런타임이 읽고 쓴다"는 문장은 전환 비용의 근거로만 읽어야 하며 그렇게 고쳐 적었다.

같은 기준(동일 불변식을 더 작은 물리 모델로 표현할 수 있는가)으로 34개 테이블을 다시 분류한 결과:

| 범주 | 개수 | 테이블 |
|---|---|---|
| **A. 제품 불변식 때문에 필요한 관계** | 21 | document, document_version, sheet, source_region, access_observation, kg_revision, domain_concept, domain_edge, domain_alias, template, template_rule, template_application, application_sheet, mapping_revision, mapping_head, extraction_run, extracted_series, extracted_item, integration_version, integration_field, integration_source |
| **B. 현재 구현 방식 때문에 분리된 관계** (병합 권고) | 5 | run_mapping, series_region, item_region(둘을 1개로), integration_project, template_version(테이블은 유지, 정의 본문만 DVC로) |
| **C. DVC 또는 앱 레이어가 담당할 수 있는 관계** | 3 (+1 부분) | artifact, build_input, render_chunk(이미 미사용); build_run은 상태는 A, 산출물 포인터는 C |
| **결정 보류(제품 결정)** | 1 | build_lineage. 그 밖에 document_version의 컬럼 축소 폭, kg_revision의 DVC pin 대체도 결정에 따라 달라짐 |

(`schema_meta`와 런타임 보조 테이블 `runtime_job`·`version_signature`는 분류 대상에서 뺐다.)

권고를 모두 적용하면 32(+런타임 2) → **27(+2)** 테이블이다. 답장의 18개 중간안과의 차이 9개는 §4에서 하나씩 짚었다.
그중 4개(access_observation, application_sheet, integration_source, extracted_series)는 원 요구사항에 직접 걸려 중간안에 다시 넣어야 한다고 본다.

## 1. 분류 기준

- **A**: 이 관계를 없애면 설계 §4·§6·§8의 불변식(리비전 불변, 승인본 덮어쓰기 금지, DRM 권한 재확인) 또는 원 요구사항 8개 중 하나를 표현할 수 없다.
- **B**: 불변식은 다른 테이블의 컬럼·제약으로 이미 표현되며, 분리는 트리거 작성이나 조회 편의 때문이다.
- **C**: DVC ref(파일 해시·리비전) 또는 서비스 코드가 같은 보장을 줄 수 있고, DB에 남기는 이유가 "조회 편의"뿐이다.

## 2. 전체 분류표

| 테이블 | 범주 | 트리거 | 참조(줄/파일) | 근거 |
|---|---|---|---|---|
| schema_meta | 보조 | 0 | 2 / db | 마이그레이션 버전. 분류 대상 아님 |
| artifact | **C** | 0 | 11 / build, export, migrate, service | 런타임이 쓰는 kind는 `protected_source`·`dataset`·`manifest` 3종. `git_commit`·`dvc_ref_json` 컬럼이 곧 DVC 포인터라 답장의 `document_snapshot.dvc_rev`와 같은 목적. 각 버전 테이블에 ref 컬럼을 두면 없앨 수 있음 |
| kg_revision | **A** (보류 가능) | 2(불변) | 17 / 8파일 | 개념·관계·별칭이 `kg_revision_id`로 봉인(sealed)됨. 답장 §5의 "Parsing Schema 파일을 DVC에 pin"으로 대체하려면 트리·이웃 탐색·커버리지 그래프(`graph.py`, `features.py`)가 SQL이 아니라 파일 로드로 바뀜. `content_sha256` 컬럼이 이미 있어 DVC 파일과 1:1 대응은 지금도 가능 |
| domain_concept / domain_edge / domain_alias | **A** | 3/4/3 | 29/18/8 | 요구 "도메인 KG 기반". 답장의 parsing_field/edge/alias와 1:1 대응이므로 이름 외 차이 없음 |
| document | **A** | 0 | 39 | 논리 문서. 답장과 동일 |
| document_version | **A** | 2(불변) | 42 / 12파일 | 답장의 `document_snapshot`과 같은 테이블. 컬럼 15개 중 `provider_version_token`·`content_sha256`·`ciphertext_sha256`·`captured_at`이 답장 제안과 겹침. 줄일 것은 컬럼(author/authored_at/excel_date_system 등 표시용)이지 테이블이 아님 |
| sheet | **A** | 2 | 65 | 요구 8(시트:템플릿 N:M)의 한 축. 답장 18개안에도 있음 |
| access_observation | **A** | 0 | 3 / features | 요구 2(DRM 읽기 전용) 구현체. 열기·추출·다운로드 때 재확인한 권한을 사용자·버전별로 기록. **답장 18개안에 없음** — DRM을 다루는 제품에서 빠지면 안 되는 관계 |
| source_region | **A** | 2 | 5 | 답장과 동일 |
| template | **A** | 0 | 46 | 답장의 parsing_profile |
| template_version | **B** | 2 | 35 | `definition_json` 본문을 DB에 저장. DVC가 정의 파일을 보관하면 `definition_sha256`+ref만 남기고 본문은 이관 가능. 테이블 자체는 `template_rule`·`mapping_revision`·`extraction_run`의 FK 대상이라 유지 |
| template_rule | **A** | 3 | 5 | 답장의 parsing_rule. `mapping_revision`·`integration_source`가 (template_version_id, rule_key)로 참조 |
| template_application | **A** | 3 | 30 | 답장의 parsing_application. `published_run_id`가 "어느 실행이 현재 값인가"를 고정 |
| application_sheet | **A** | 3 | 7 | 요구 8: 한 적용 건이 시트 여러 장을 역할별로 씀(`role_key`, `ordinal`). 레시피 이식(suggest)이 시트 역할 이름으로 매칭. **답장 18개안에 없음** |
| mapping_revision | **A** | 2(불변) | 30 | 답장 §1이 필요하다고 한 바로 그 테이블 |
| mapping_head | **A** | 5 | 12 | 답장 §1의 `mapping(current_revision_id, edit_seq, status)` 제안과 컬럼이 같다(PK가 (application_id, rule_key)인 점만 다름). 즉 답장의 "단순화"는 v2가 이미 가진 구조 |
| extraction_run | **A** | 3(상태) | 17 | 답장과 동일 |
| run_mapping | **B** | 3 | 4 / build, export, extract, service | §3-1 참조. 성공 실행의 출처는 `extracted_series.mapping_revision_id`가 이미 보존 |
| extracted_series | **A** | 3 | 11 | 요구 4(리스트 값·가로/세로). 규칙 1회 적용의 단위로 `cardinality`·`axis`·`record_scope_key`를 가짐. 답장의 `extracted_value` 하나로 합치면 리스트·행렬의 그룹 정체성을 값마다 JSON으로 반복해야 함. **답장 18개안에 없음** |
| series_region | **B** | 3 | 2 / api, extract | §3-2 참조. item_region과 구조 동일 |
| extracted_item | **A** | 3 | 7 | 답장의 extracted_value |
| item_region | **B** | 3 | 3 / api, build, extract | §3-2 참조 |
| render_chunk | **C** | 0 | 0 | 정책상 렌더 바이트 비영속. 이미 "미사용" 표기 |
| integration_project | **B** | 0 | 4 | 이름·작성자만 가짐. `integration_version.project_id` 대신 이름 컬럼으로 흡수 가능 |
| integration_version | **A** | 2(불변) | 6 | 답장의 `integration`. 통합 정의도 리비전 불변이어야 빌드 재현 가능 |
| integration_field | **A** | 3 | 2 | 답장과 동일 |
| integration_source | **A** | 3 | 2 / build | 필드 하나에 문서 여러 건의 규칙을 모으는 관계(요구 "엑셀 대량 파일 → 사용자 DB"). 답장의 `integration_field.parsing_field_id` 하나로는 "어느 문서의 어느 규칙"을 지정할 수 없음. UI "소스 일괄 추가"가 쓰는 관계. **답장 18개안에 없음** |
| build_run | **A/C** | 3(상태) | 8 | 빌드 상태·`input_fingerprint`는 A(작업 큐·멱등). `output_artifact_id`·`report_artifact_id`는 DVC ref로 대체 가능(C) |
| build_input | **C** | 3 | 2 / build, export | `build_run.input_manifest_json`이 같은 내용(실행 ID 목록)을 이미 가짐. 중복 |
| build_lineage | **보류** | 4 | 2 / api, build | 통합 DB 셀 → 추출 항목 → 원본 셀 역추적. `Database.tsx`가 셀 클릭 → 원본 위치 이동에 사용. 이 기능이 요구인지는 제품 결정(§4) |
| runtime_job / version_signature | 보조 | — | — | 작업 큐·문서군 서명 캐시. 재생성 가능. 분류 대상 아님 |

## 3. 답장이 지목한 4묶음

### 3-1. mapping_revision / mapping_head / run_mapping

- `mapping_head`는 답장의 제안과 동일한 테이블이다(위 표). 병합 대상이 아니다.
- `run_mapping`은 **부분 중복**이다. `extracted_series.mapping_revision_id`가 성공한 실행의 출처를 이미 고정하므로 조회 목적으로는 불필요하다.
  남는 고유 역할 세 가지: (1) `run_mapping_pin` 트리거 — 실행이 `queued`일 때만, 승인된 리비전만 입력으로 고정; (2) 실패한 실행의 입력 기록(시리즈가 없으므로); (3) `export.py`의 manifest 출력.
- 병합안: `extraction_run.input_manifest_json`(이미 `build_run`이 같은 패턴)에 `rule_key → mapping_revision_id`를 기록하고, 승인 검사는 `service.py`에서 한다.
  잃는 것은 FK 참조 무결성뿐이며 `mapping_revision`은 삭제 금지 트리거가 있어 실질 위험은 낮다. **권고: 병합(B).**

### 3-2. extracted_series / series_region / extracted_item / item_region

- `series_region`과 `item_region`은 컬럼 구조가 같다(`role`, `ordinal`, `region_id`, 불변 트리거 3개씩). 차이는 `role` enum뿐(series: key/value/unit/context/record_key, item: value/input/record_key/unit/context).
  답장 §2의 `mapping_region(role, ordinal)` 제안과도 같은 형태다. **권고: `extraction_region(owner_kind, owner_id, role, ordinal, region_id)` 하나로 통합(B).** 참조 5곳, 트리거 6→3.
- `extracted_series`와 `extracted_item`은 합치지 않기를 권고한다(A). 요구 4의 리스트·행렬 값은 "규칙 1회 적용 = 시리즈 1개, 값 N개"이며, 시리즈의 `cardinality`·`axis`·`record_scope_key`가 값 N개의 공통 속성이다. 값 테이블 하나로 만들면 이 속성을 값마다 반복하거나 JSON으로 넣어야 하고, 발행 실행 기준 커버리지 조회(`graph.py`)가 시리즈 단위로 돈다.
- 답장 §2의 `mapping_region`(매핑 리비전의 영역)은 v2에서 `mapping_revision.effective_spec_json` 안의 selector로 표현된다. 검수 화면이 영역을 겹쳐 그릴 때 JSON을 읽으므로, 매핑 영역까지 정규화할 필요는 현재 없다. 다만 "이 셀을 참조하는 매핑 전부"를 SQL로 찾는 요구가 생기면 그때 정규화한다.

### 3-3. integration_version / integration_source / build_input / build_lineage

- `integration_version`+`integration_field`는 답장의 `integration`+`integration_field`와 같다. `integration_project`는 이름만 가지므로 흡수 가능(B).
- `integration_source`는 답장 안에 없지만 없앨 수 없다(A). 사용자 맞춤 DB의 필드 하나는 문서 여러 건에서 온다. 답장 §4의 `integration_field.parsing_field_id`는 "개념"만 가리키고, 어느 문서 적용 건의 어느 규칙을 쓸지(`application_id`, `rule_key`, `pinned_run_id`)를 잃는다. 이 관계가 없으면 "같은 개념이면 전부"가 되어 사용자가 소스를 고를 수 없다.
- `build_input`은 `build_run.input_manifest_json`과 중복이다. **권고: 제거(C).** manifest는 DVC 내보내기(`export.py`)에도 그대로 실린다.
- `build_lineage`는 **제품 결정이 필요하다.** 현재 UI는 통합 DB의 셀에서 원본 셀로 이동한다(`Database.tsx`의 `lineage_item` → `/items/{id}/regions`). 이 기능을 요구로 보면 A이고, 산출물의 `_source_*` 컬럼(v1 방식)으로 충분하면 C(DVC 산출물 안에 lineage를 넣고 DB에서 제거)다. 원 요구사항의 "키·값 위치 수정 가능"이 통합 DB 셀까지 역추적을 뜻하는지 나는 모른다. v1에 `_source_*`가 있었으므로 요구로 보는 쪽이지만, 결정은 사용자 몫이다.

### 3-4. artifact / document_version / template_version / kg_revision

- `artifact`: DVC 포인터 테이블이다(`git_commit`, `dvc_ref_json`). 답장의 "DVC가 담당" 원칙을 따르면 각 버전 테이블(`document_version.source_artifact_id`, `template_version.code_artifact_id`, `build_run.output_artifact_id`)에 ref 컬럼을 직접 두고 이 테이블은 없앨 수 있다(C). 산출물 3종을 한 곳에서 해시·크기·정책으로 다루는 편의는 잃는다.
- `document_version`: 답장의 `document_snapshot`과 동일하다. 테이블 축소가 아니라 컬럼 축소(표시용 메타 6개)가 논점이다. DRM 원본을 DVC에 둘 수 없는 경우를 답장 §3도 인정했으므로 이 테이블은 A다.
- `template_version`: 정의 본문(`definition_json`)이 DB에 있다. DVC가 정의 파일을 보관하면 본문은 이관하고 해시·ref만 남긴다(B). 테이블은 FK 대상이라 남는다.
- `kg_revision`: 답장 §5의 절충(Parsing Schema 파일 DVC pin)은 가능하다. 다만 v2는 KG를 SQL로 조회한다(트리 펼침, 이웃 탐색, 커버리지 hull). 파일 pin으로 바꾸면 조회마다 파일을 읽거나 캐시를 둬야 하고, 그 캐시가 결국 지금의 테이블이다. **권고: 유지(A).** 이미 있는 `content_sha256`을 DVC 파일 해시와 맞추면 두 세계가 1:1로 대응한다.

## 4. 답장 18개 중간안과의 차이

| 중간안에 없는 v2 테이블 | 판정 | 이유 |
|---|---|---|
| access_observation | **넣어야 함** | 요구 2(DRM). 권한 관찰 없이는 "열기·추출·다운로드 때 재확인"을 표현할 곳이 없음 |
| application_sheet | **넣어야 함** | 요구 8(시트:템플릿 N:M). 시트 역할이 없으면 레시피 이식이 시트 순서에 의존 |
| integration_source | **넣어야 함** | §3-3. 필드당 복수 문서 소스 |
| extracted_series | **넣어야 함** | §3-2. 리스트·행렬 값의 그룹 |
| build_run | 넣어야 함(축소) | 빌드 상태·멱등 키. 산출물 포인터는 DVC로 |
| build_lineage | 제품 결정 | §3-3 |
| artifact | 없앨 수 있음 | §3-4 |
| sheet / template_application | 중간안에 있음 | 동일 |
| run_mapping, series_region+item_region, integration_project, build_input | 없앨 수 있음 | §3 |

## 5. 트리거 72개의 성격 (구현 방식 범주)

| 성격 | 개수 | PostgreSQL 이식 시 대안 |
|---|---|---|
| `*_no_update` / `*_no_delete` (리비전 불변) | 42 | 앱 롤에 `REVOKE UPDATE, DELETE` — 트리거 없이 같은 보장 |
| `*_sealed` (봉인된 리비전에 자식 삽입 금지) | 6 | 유지(트리거 또는 CHECK+함수) |
| 상태 전이(extraction_run, build_run, template_application) | 7 | 유지 |
| `*_running_insert` (실행 중에만 결과 삽입) | 4 | 유지 |
| mapping_head CAS·승인 검사 | 5 | 유지 |
| pin(run_mapping, build_input), lineage 2, hierarchy_level, application_sheet | 8 | 병합 권고 적용 시 4개 소멸 |

즉 트리거의 58%는 "불변"을 SQLite에서 표현하는 방식일 뿐이며, 스키마 크기와 무관하게 이식 시 줄어든다.

## 6. 용어 재정의(답장 §9)에 대해

스키마 판단과 분리해서 본다. 원 프롬프트는 "도메인 KG 기반"이라고 명시했으므로 Parsing Schema/Field/Profile로 바꾸는 것은 제품 정의 변경이고 사용자가 결정할 사항이다.
비용 측면만 적으면: UI 라벨·문서만 바꾸는 것은 저비용, 테이블·컬럼·API 경로까지 바꾸는 것은 34개 테이블과 프론트 전체를 건드리는 고비용이다. 바꾼다면 라벨 먼저, 물리 이름은 PostgreSQL 이식 때 함께 바꾸는 순서를 권한다.

## 7. 모르는 것 (결정되면 분류가 바뀜)

1. DRM 원본(또는 암호문)을 DVC remote에 둘 수 있는가 — 불가면 `document_version`·`access_observation`은 확정 A.
2. 통합 DB 셀에서 원본 셀로 돌아가는 기능이 요구인가 — 예면 `build_lineage` A, 아니면 C.
3. PostgreSQL 전환 시점 — 트리거 42개의 REVOKE 대체는 그때 한다.

## 8. 제안하는 다음 단계

합의되면 각각 별도 커밋으로:

1. `run_mapping` → `extraction_run.input_manifest_json` 흡수, 승인 검사를 서비스로 이동 (`schema_meta` 버전 올림, 마이그레이션 스크립트, 테스트 갱신).
2. `series_region`+`item_region` → `extraction_region` 통합.
3. `build_input` 제거, `integration_project` 흡수.
4. 위 1~3 반영한 ERD를 `ARCHITECTURE_V2.md`에 재생성.

`artifact` 제거와 `template_version` 본문 이관은 DVC 운영 방식(remote 유무·정의 파일 위치)이 정해진 뒤에 한다.
