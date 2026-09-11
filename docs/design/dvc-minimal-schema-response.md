# DVC 최소 스키마 크리틱에 대한 답변

작성일: 2026-09-11  
대상: `docs/design/v2-decisions.md`의 **DVC 최소 스키마 vs v2 — 요구사항 대조**

## 결론

크리틱 중 일부는 타당하며 DVC 최소안은 수정이 필요하다. 특히 다음 세 가지는 최소안의 실제 결함 또는 과도한 축소다.

1. 현재 `mapping` 행을 제자리 수정하면서 `extracted_value.mapping_id`가 그 행을 직접 참조하는 구조
2. key/value 위치를 단일 FK로만 표현한 구조
3. 사용자 맞춤 통합 DB 영역을 핵심 모델에서 제거한 것

다만 **현재 v2 런타임이 33개 테이블을 실제로 읽고 쓴다는 사실을, 그 분해 수준의 필요성 근거로 보지는 않는다.** 현재 구현이 해당 스키마에 결합돼 있다는 사실은 migration cost의 근거이지 schema necessity의 근거는 아니다.

판단 기준은 다음이어야 한다.

> 동일한 제품 요구와 불변식을 더 작은 데이터 모델로 표현할 수 있는가?

목표는 최소 테이블 수가 아니라, 필요한 provenance와 검수 이력을 유지하면서 DVC와 RDB의 책임 중복을 줄이는 것이다.

---

## 1. `mapping` 제자리 수정 문제 — 크리틱에 동의

현재 최소안은 대략 다음 형태다.

```text
mapping
- mapping_id
- domain_id
- key_region_id
- value_region_id

extracted_value
- mapping_id FK
```

이 구조에서는 과거 추출 이후 mapping을 수정하면 과거 값의 의미도 현재 mapping을 따라간다.

예:

```text
어제
B3 -> 온도

오늘 수정
B3 -> 압력
```

과거 `extracted_value`가 동일한 `mapping_id`를 참조하고 있다면 JOIN 결과상 과거 값도 압력에서 추출한 값처럼 보이게 된다. 이는 provenance 불변성 위반이다.

따라서 revision은 필요하다.

다만 이를 해결하기 위해 현재 v2의

```text
mapping_revision
mapping_head
run_mapping
```

세 구조를 모두 유지해야 한다고 보지는 않는다.

다음 정도로 단순화할 수 있다.

```text
mapping
- mapping_id PK
- application_id FK
- rule_id FK
- current_revision_id FK
- edit_seq
- status

mapping_revision
- mapping_revision_id PK
- mapping_id FK
- revision_no
- parsing_field_id FK
- observed_key
- created_at

extracted_value
- value_id PK
- run_id FK
- mapping_revision_id FK
- ...
```

`mapping.current_revision_id`가 현재 head 역할을 하고 `edit_seq`로 CAS를 수행한다.

이 방식이면:

- 과거 추출의 의미 불변
- 현재 승인 mapping 조회
- 동시 수정 감지
- rollback 대상 revision 보존

을 만족하면서 `mapping_head`와 별도 `run_mapping`을 필수로 만들지 않아도 된다.

---

## 2. 단일 key/value region — 크리틱에 동의

최소안의

```text
key_region_id
value_region_id
```

단일 FK는 실제 Excel 문서 표현을 충분히 담지 못한다.

예:

```text
key:
B3:C3 + F3

value:
B5:B7 + B10:C11
```

또는 unit/context가 별도 위치에 있을 수 있다.

따라서 다음과 같은 N:M 관계가 필요하다.

```text
mapping_region
- mapping_revision_id FK
- region_id FK
- role
- ordinal
```

예:

```text
map-r1 | B3:C3    | key     | 0
map-r1 | F3       | key     | 1
map-r1 | B5:B7    | value   | 0
map-r1 | B10:C11  | value   | 1
map-r1 | D2       | unit    | 0
```

이 정도면 비연속 영역과 역할별 원본 위치를 명시적으로 표현할 수 있다.

다만 이 요구가 곧바로

```text
extracted_series
series_region
extracted_item
item_region
```

4단계 분해 전체의 필요성을 의미하지는 않는다. 실제 쿼리와 lineage 요구를 기준으로 추가 분해 여부를 판단해야 한다.

---

## 3. DRM 원본을 DVC가 복원할 수 있다는 전제 — 크리틱에 동의

DVC 최소안은 문서 버전 복원을 DVC에 맡긴다는 전제가 강하다.

그러나 DRM 정책상 원본 또는 암호문을 DVC remote에 보관할 수 없다면 `document_version` 계열을 완전히 제거해서는 안 된다.

그렇다고 현재 v2 수준의 문서 버전 모델 전체가 반드시 필요한 것은 아니다.

얇은 snapshot 테이블이면 충분할 가능성이 높다.

```text
document
- document_id PK
- name
- source_path

document_snapshot
- snapshot_id PK
- document_id FK
- content_hash
- dvc_rev nullable
- provider_version nullable
- captured_at
```

처리는 다음과 같다.

```text
DVC 사용 가능
-> dvc_rev로 원본 복원

DVC 사용 불가
-> provider_version/content_hash로 당시 상태 식별
```

즉 DVC가 가능한 경우와 불가능한 경우를 동일 모델에서 처리하되, 파일 상태 이력을 위해 대규모 별도 artifact/revision 체계를 중복 구축하지 않는다.

---

## 4. Integration 제거 — 크리틱에 동의

최소안에서 integration 영역을 제거한 것은 지나친 축소였다.

이 프로젝트의 핵심 흐름은 단순 추출에서 끝나지 않는다.

```text
서로 다른 문서
-> 파싱
-> 공통 스키마에 매핑
-> 선택한 필드의 값을 모음
-> 하나의 사용자 DB로 통합
```

따라서 integration은 후속 옵션이 아니라 핵심 제품 요구다.

최소한 다음 정도는 핵심 스키마에 남겨야 한다.

```text
integration
- integration_id PK
- name
- spec_json

integration_field
- integration_id FK
- field_id
- parsing_field_id FK
- output_name
- target_type
- target_unit
```

다만 현재 v2의

```text
integration_project
integration_version
integration_field
integration_source
build_run
build_input
build_lineage
```

7개 테이블 전체가 반드시 필요한지는 별도 검토가 필요하다.

통합 결과물과 manifest를 DVC로 관리한다면 build 결과 버전과 산출물 이력 일부는 DB에서 중복 관리하지 않아도 된다.

---

## 5. `kg_revision` 제거 문제 — 절충 가능

크리틱의 다음 지적은 타당한 우려다.

> 개념 폐기·개명 시 과거 매핑 의미가 바뀔 수 있다.

다만 이 문제를 해결하는 방법이 반드시 `kg_revision` 테이블일 필요는 없다.

현재 제품 개념을 `도메인 KG`가 아니라 `Parsing Schema`로 재정의한다면, Parsing Schema 정의 파일 자체를 Git/DVC revision에 pin하는 방법도 가능하다.

예:

```text
extraction_run
- parsing_schema_rev
- parsing_profile_rev
- document_snapshot_id
```

과거 실행이 참조한 Parsing Schema revision을 복원할 수 있다면 의미 불변성을 유지할 수 있다.

따라서 이 부분은 **DVC에 Parsing Schema 정의를 실제로 보존할 것인지**에 따라 DB revision 테이블 필요성이 달라진다.

---

## 6. "현재 33개 테이블을 런타임이 사용한다"는 근거에 대한 반론

`v2-decisions.md`에는 다음 취지의 판단이 있다.

> v2에서 실제 과설계 원칙에 걸리는 테이블은 `render_chunk` 하나이며, 나머지 33개는 현재 런타임·테스트가 읽고 쓴다.

이 사실 자체는 맞지만, 스키마 필요성에 대한 충분한 근거는 아니다.

현재 런타임이 34개 테이블 구조를 기준으로 작성됐으므로 해당 코드와 테스트가 그 테이블을 사용하는 것은 당연하다.

질문은 다음이어야 한다.

> 같은 불변식과 제품 요구를 더 적은 관계로 표현할 수 있는가?

예를 들어 현재 v2의

```text
mapping_revision
mapping_head
run_mapping
```

의 역할 상당 부분은

```text
mapping.current_revision_id
mapping.edit_seq
extracted_value.mapping_revision_id
```

조합으로 표현할 수 있다.

마찬가지로 `series_region`과 `item_region`이 각각 별도 테이블이어야 하는지, 일반화된 provenance relation 하나로 합칠 수 없는지도 검토해야 한다.

따라서:

```text
현재 코드가 사용함
!=
제품 요구상 해당 테이블 분리가 필수임
```

이다.

현재 구현 의존성은 **전환 비용**을 판단하는 근거로 사용하는 것이 맞다.

---

## 7. v2의 장점과 약점

현재 v2가 강한 부분은 분명하다.

- provenance를 강하게 보존한다.
- 과거 실행의 의미를 쉽게 변경할 수 없게 한다.
- 복수 원본과 integration lineage까지 표현한다.
- 검수 CAS와 실행 snapshot을 명시적으로 관리한다.

따라서 v2의 불변식을 버리는 것이 목표가 아니다.

문제는 구현 비용이다.

`v2-decisions.md`에서도 인정했듯이 현재 v2는 PoC 관점에서 약 34개 테이블과 72개 트리거를 가지며, PostgreSQL 이식 시 트리거 기반 불변성 유지 비용이 높다.

따라서 다음을 구분해야 한다.

```text
유지해야 하는 것
- provenance
- revision
- CAS
- 복수 source
- integration

반드시 유지할 필요가 없는 것
- 현재와 동일한 테이블 분해 수
- 현재와 동일한 트리거 구현 방식
```

---

## 8. 현재 제안하는 중간안

12개 최소안은 provenance와 integration을 너무 많이 잘라냈다.

반대로 현재 v2 34개 수준은 PoC/이식 관점에서 여전히 무겁다.

현재 검토안은 다음 약 18개 테이블이다.

```text
DOCUMENT
DOCUMENT_SNAPSHOT
SHEET
SOURCE_REGION

PARSING_SCHEMA
PARSING_FIELD
PARSING_ALIAS
PARSING_FIELD_EDGE

PARSING_PROFILE
PARSING_RULE

PARSING_APPLICATION

MAPPING
MAPPING_REVISION
MAPPING_REGION

EXTRACTION_RUN
EXTRACTED_VALUE

INTEGRATION
INTEGRATION_FIELD
```

전체 흐름은 다음과 같다.

```text
Document
  -> Document Snapshot
       -> Sheet
            -> Source Region

Parsing Schema
  -> Parsing Field
       -> Alias
       -> Field Edge

Parsing Profile
  -> Parsing Rule

Document + Parsing Profile
        -> Parsing Application
             -> Mapping
                  -> Mapping Revision
                       -> Mapping Region
                       -> Parsing Field

Parsing Application
        -> Extraction Run
             -> Extracted Value

Parsing Field
        -> Integration
             -> Integrated DB
```

이 모델의 목표는 다음 다섯 가지다.

1. 과거 추출의 의미가 mapping 수정으로 변하지 않는다.
2. 사용자가 수정한 mapping revision을 보존한다.
3. key/value/unit/context의 복수 source region을 표현한다.
4. DVC가 담당할 수 있는 파일/스키마/프로파일/산출물 버전은 DB가 중복 관리하지 않는다.
5. 사용자 맞춤 integration 요구를 핵심 모델에서 표현한다.

---

## 9. 용어 재정의 제안

현재 `domain KG / template`라는 이름은 시스템의 실제 목적보다 KG/ontology 중심 제품이라는 인상을 준다.

이 프로젝트가 집중하려는 것은 업무 지식 그래프 구축 자체가 아니라, 제각각인 문서에서 파싱한 값과 개념을 일관된 틀로 정규화하는 과정이다.

따라서 다음 용어를 검토한다.

```text
domain KG       -> Parsing Schema
domain concept  -> Parsing Field

template        -> Parsing Profile
template rule   -> Parsing Rule
```

의미는 다음과 같다.

```text
Parsing Schema
= 파싱 결과를 넣을 공통 구조

Parsing Profile
= 특정 문서 양식을 그 구조로 해석하는 규칙 묶음
```

제품의 핵심 흐름은 다음과 같이 표현할 수 있다.

```text
서로 다른 Document
        -> Parsing Profile
        -> Parsing Schema
        -> 일관된 데이터
```

향후 스키마를 다시 평가할 때는 `KG를 얼마나 잘 모델링하는가`보다 `문서별 파싱 결과를 얼마나 안정적으로 공통 구조에 투영하고 재현할 수 있는가`를 우선 기준으로 삼는 것이 적절하다.

---

## 요청하는 후속 검토

현재 v2의 34개 물리 테이블을 다음 세 범주로 다시 분류해 검토하는 것이 좋다.

1. **제품 불변식 때문에 반드시 필요한 관계**
2. **현재 구현 방식 때문에 분리된 관계**
3. **DVC 또는 애플리케이션 레이어가 담당할 수 있는 관계**

특히 다음 묶음은 병합 가능성을 다시 검토할 가치가 있다.

```text
mapping_revision / mapping_head / run_mapping

extracted_series / series_region / extracted_item / item_region

integration_version / integration_source / build_input / build_lineage

artifact / document_version / template_version / kg_revision
```

목표는 기존 v2의 불변식을 약화시키는 것이 아니라, **동일한 불변식을 더 작은 물리 모델로 유지할 수 있는지 검증하는 것**이다.
