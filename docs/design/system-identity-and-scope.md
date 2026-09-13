# System Identity, Scope and Requirements

작성일: 2026-09-14

## 1. 시스템 정체성

이 시스템은 범용 Excel Viewer, 범용 Document AI, 자동 Knowledge Graph 생성기, 장기 데이터웨어하우스가 아니다.

핵심 정체성은 다음과 같다.

> **NASCA/DRM 등으로 보호된 기업 내부 문서를 검증된 Parsing Schema / Parsing Profile을 통해 정형화된 단일 테이블 데이터로 변환하여 공정/분석 Agent에 제공하는 내부용 Secure Document-to-Table Adapter**

즉 Agent가 원본 문서의 물리적 양식, DRM 처리, 병합 셀, 시트 위치, 단위 정규화, 문서별 파싱 로직을 직접 알지 않아도 되게 하는 **Agent용 데이터 준비 계층**이다.

핵심 흐름은 다음과 같다.

```text
NASCA / DRM / Local Excel
        ↓
Parsing Profile
        ↓
Parsing Schema Mapping
        ↓
검증된 Extracted Value + Provenance
        ↓
사용자가 선택한 단일 Table
        ↓
SQLite / CSV / XLSX / Agent Input
```

최종 통합 파일은 시스템 내부의 영속 Source of Truth가 아니라 일회성 산출물이다.

---

## 2. 해결하려는 문제

기업 내부 Agent가 Excel 기반 데이터를 사용하려면 현재는 Agent 개발자가 문서별 파싱 코드를 직접 작성해야 한다.

이 방식에는 다음 문제가 있다.

1. 같은 문서를 여러 Agent가 반복해서 파싱한다.
2. 동일한 필드를 Agent마다 다른 의미, alias, 단위 기준으로 해석할 수 있다.
3. 문서 양식 변경이 Agent 코드 변경으로 직접 전파된다.
4. NASCA/DRM 접근, 복호화, 보안 파일 취급 로직을 Agent마다 다시 구현해야 한다.
5. 파싱 결과가 원본의 어느 sheet/cell/region에서 왔는지 추적하기 어렵다.
6. 문서가 수천 개일 때 문서별 수동 mapping 검수는 운영 불가능하다.

따라서 이 시스템은 문서의 물리적 구조와 Agent의 데이터 계약을 분리해야 한다.

```text
문서 양식 변경
    ↓
Parsing Profile 수정/추가
    ↓
공통 Parsing Schema 유지
    ↓
Agent 인터페이스는 유지
```

---

## 3. 개별 Agent 파싱 대비 존재 이유

이 시스템이 가치가 있는 조건은 다음 조합이다.

```text
여러 Agent
×
많은 반복 문서
×
양식 변동
×
DRM/NASCA
×
공통 의미 정의 필요
```

문서가 몇 개이고 Agent가 하나뿐이라면 개별 파싱이 더 단순할 수 있다. 반대로 위 조건에서는 중앙 Parsing Service의 이점이 커진다.

### 3.1 중복 구현 제거

여러 Agent가 각각 Excel 구조 분석, 병합셀 처리, alias 처리, 단위 변환을 반복하지 않는다.

### 3.2 Agent와 문서 양식 분리

Agent는 `temperature`, `pressure`, `time` 같은 표준 필드만 소비한다. 실제 값이 어느 sheet, 어느 cell, 어떤 label로 존재하는지는 Parsing Profile이 담당한다.

### 3.3 데이터 의미 계약 통일

Parsing Schema가 Agent 사이의 공통 의미 계약이 된다.

### 3.4 Provenance 보장

각 값은 최소한 다음 경로로 원본까지 추적 가능해야 한다.

```text
Extracted Value
→ Parsing Field
→ Mapping Revision
→ Source Region
→ Sheet
→ Document Snapshot
```

### 3.5 DRM/NASCA 처리 중앙화

Agent가 보안 문서 취급 로직을 직접 갖지 않도록 한다. 원본 접근과 렌더/파싱은 통제된 Parsing Service 영역에서 수행한다.

---

## 4. 운영 모델

이 시스템은 대규모 동시 실시간 처리 시스템을 목표로 하지 않는다.

NASCA/DRM과 보안 정책을 고려하여 기본 운영 모델은 다음과 같다.

- 내부 서비스
- on-demand / batch 중심
- 신규 양식은 등록 의뢰 방식
- 기존 Profile과 일치하는 문서는 자동 처리
- 신규/불일치 양식만 Profile 추가 또는 수정 대상으로 분리

문서 10,000개가 들어와도 10,000개를 개별 검수하는 것이 아니라, 실제 양식 유형을 수십 개 수준의 Parsing Profile로 재사용하는 것이 목표다.

```text
신규 문서
  ↓
기존 Profile로 처리 가능?
  ├─ YES → 자동 적용
  └─ NO  → 신규 양식 등록 요청
             ↓
         Profile 작성/검수
             ↓
         동일 양식 재사용
```

---

## 5. Mapping 승인 정책

"모든 Mapping은 문서별 수동 승인"을 요구하지 않는다.

정책은 다음과 같이 정의한다.

> **새로운 의미 관계 또는 기존 승인 규칙과 호환되지 않는 Mapping은 사람의 검수가 필요하다. 이미 승인된 Profile/Mapping 패턴은 동일하거나 호환되는 문서 구조에 자동 승계할 수 있다.**

자동 승계 판단에는 최소 다음 조건을 사용할 수 있다.

- Profile revision 동일/호환
- Schema revision 호환
- Sheet role 일치
- selector 정상 매칭
- observed key 또는 승인 alias 일치
- value type / unit 일치
- 구조 fingerprint 동일/호환
- 충돌 없음

승인 방식은 예를 들어 `manual`, `inherited`, `batch_approved` 등으로 구분할 수 있으며, 자동 승계된 결과도 어떤 승인 정책에서 파생되었는지 추적 가능해야 한다.

---

## 6. 범위

### 6.1 시스템이 책임지는 영역

- 문서 등록 및 snapshot 식별
- Excel 구조 파악
- Parsing Schema 관리
- Parsing Profile 관리
- Profile ↔ Sheet 역할 바인딩
- Mapping 후보 생성/재사용
- 예외 Mapping 검수
- 값 추출 및 정규화
- Source Region provenance
- Field 기준 문서/값 탐색
- 문서 기준 Field 탐색
- SQLite / CSV / XLSX 일회성 생성
- Agent가 소비할 단일 테이블 생성
- NASCA/DRM 처리와 렌더/파싱 경계 통제

### 6.2 명확한 비범위

- 범용 Excel 편집기
- 대규모 실시간 동시 사용자 serving
- 자동 Schema/KG 무검증 성장
- LLM 단독 의미 승인
- 영구 통합 데이터웨어하우스
- Agent orchestration 자체
- 모든 종류의 비정형 문서에 대한 범용 Document AI

---

## 7. 핵심 요구사항

### P0

- 여러 Parsing Schema 운용
- 재사용 가능한 Parsing Profile
- 문서 Snapshot과 Profile 적용 관계 보존
- Source Region 추적
- Mapping Revision 보존
- Extracted Value provenance
- 신규 양식과 기존 양식 구분
- 기존 승인 Profile의 반복 문서 자동 적용
- 일회성 Table/SQLite/CSV/XLSX 생성
- Agent가 문서 양식과 무관하게 표준 Field를 소비 가능

### P1

- Profile 유사도/호환성 판정
- 신규 양식 등록 요청 Workflow
- Mapping batch review
- 문서 변경 시 재파싱/영향 분석
- DRM 렌더 캐시
- 원본 위치 검수 Viewer

### P2

- LLM 기반 alias 후보 제안
- Profile 초안 생성
- selector 후보 추천
- 신규 Field 후보 제안

자동 생성/추천은 승인 권한을 대체하지 않는다.

---

## 8. 현재 Parsing Profile 구현 상태

현재 브랜치에는 두 세대의 JSON 기반 Parsing Template/Profile 구현이 공존한다.

### 8.1 기존 `kg/parsing.py`

기존 구현은 대략 다음 구조다.

```json
{
  "sheet_templates": [
    {
      "name": "oven_test",
      "match": {
        "name_regex": "^(180|185|190|195|200)"
      },
      "mappings": [
        {
          "key": "temperature",
          "concept_id": "oven_temperature",
          "source": {
            "key_search": ["온도"],
            "offset": {"row": 0, "col": 1}
          },
          "type": "number",
          "unit": "C"
        }
      ]
    }
  ]
}
```

`sheet_templates -> match -> mappings` 구조이며 JSON 전체를 버전별 spec으로 저장한다.

### 8.2 v2 `kg/v2/spec.py`

v2는 다음 구조를 canonical JSON으로 사용한다.

```text
sheet_roles
rules[]
  - rule_key
  - concept_id
  - selector
      key/value/unit/context
      areas[]
        range | find | relative
  - record_spec
  - value_spec
```

예시는 `examples/schema_v2/template_multisheet.json`에 있다.

현 v2 실행기는 JSON만 지원하며 `validate_template()`에서 `format=json`을 강제한다.

새 18-table core schema는 아직 실제 runtime으로 이식되기 전이며, 앞으로 `parsing_profile`과 `parsing_rule.selector_json / value_spec_json`이 이 선언형 JSON 실행 의미를 담는 방향이다.

---

## 9. 외부 Parsing Profile과 통합 가능성

외부 파싱 프로그램의 예시는 다음 개념을 가진다.

```text
groups
  ├─ sheets
  └─ fields
composite_anchors
relations
```

이 형식은 현재 시스템과 의미적으로 상당 부분 겹치므로 **통합 가능하다. 다만 그대로 저장하는 것보다는 import adapter를 통해 canonical profile DSL로 변환하는 방식을 권장한다.**

### 9.1 직접 대응 가능한 항목

| 외부 Profile | 현재/신규 Profile 대응 |
|---|---|
| `groups[].id` | profile/group/role 식별자 |
| `groups[].name` | profile/group label |
| `groups[].sheets` | `sheet_roles.matcher.names` |
| `fields[].key` | `rule_key` / Parsing Field key |
| `value_type` | `value_spec.type` |
| `multi_value=false` | `selector.value.cardinality=scalar` |
| `multi_value=true` | `list` 또는 `matrix` |
| `kr_pattern/en_pattern` | key matcher / alias / regex matcher |
| `extract` | selector strategy (`range/find/relative`) |
| `delimiter` | normalization/split 정책 |

### 9.2 확장이 필요한 항목

#### `composite_anchors`

현재 v2 selector는 `range/find/relative`를 지원하지만 복합 regex anchor를 분해하여 여러 sub-field를 만드는 개념은 직접 지원하지 않는다.

권장 방향은 canonical Profile에 재사용 가능한 anchor 정의를 추가하는 것이다.

```json
{
  "anchors": [
    {
      "anchor_id": "bake_temp",
      "matcher": {"regex": "2nd_bake\\+1st_temp"},
      "sub_fields": [
        {"key": "baking", "label": "굽기"}
      ]
    }
  ]
}
```

개별 Parsing Rule은 `anchor_ref`를 참조하도록 컴파일할 수 있다.

#### `relations`

예시의

```json
{
  "base": "exp_id",
  "target": "exp_type",
  "direction": "below",
  "max_dist": 5,
  "infer_conf": 0.7
}
```

은 현재 v2의 단순 `relative` selector보다 상위 개념이다. 필드 간 관계를 이용해 target 위치를 추론하기 때문이다.

따라서 canonical Profile에는 `relation_rules` 또는 cross-rule reference 개념을 추가하는 것이 적절하다.

### 9.3 권장 통합 구조

```text
Legacy kg/parsing.py JSON ─┐
Current v2 JSON          ─┼─> Profile Import Adapter
External Parser JSON     ─┘
                              ↓
                     Canonical Profile IR
                              ↓
                  Parsing Rule / effective_spec
                              ↓
                         Runtime Executor
```

외부 형식을 canonical 형식으로 강제로 바꾸게 하기보다 **입력 형식은 여러 개 허용하고 실행 직전에 하나의 canonical IR로 컴파일**하는 편이 이식성과 유지보수성이 좋다.

특히 새 18-table schema의 `mapping_revision.effective_spec_json`은 실제 실행 당시 canonical spec을 고정하는 용도로 사용할 수 있다.

### 9.4 외부 예시의 주의점

예시 JSON의 `direcrion`은 오타로 보이며 canonical 형식에서는 `direction`으로 고정하는 것이 좋다. Import adapter에서는 이전 형식 호환을 위해 `direcrion`도 alias로 받아줄 수 있다.

`delimiter="||"`는 현재 normalization pipeline에 일반 문자열 split 연산이 없으므로 `split_text` 같은 명시적 normalizer를 추가해야 완전 호환된다.

---

## 10. 제품 불변식

1. 원본보다 가공 데이터가 더 진실일 수 없다. 모든 값은 원본으로 추적 가능해야 한다.
2. Parsing Schema는 "무엇인가", Parsing Profile은 "어떻게 찾는가"를 책임진다.
3. 새로운 의미 결정은 검수 가능해야 하지만, 승인된 Profile은 반복 문서에 자동 재사용할 수 있어야 한다.
4. 문서 양식 변경은 가능한 한 Agent 코드에 전파되지 않아야 한다.
5. 최종 통합 데이터는 산출물이지 새로운 영구 Source of Truth가 아니다.
6. 외부 Parsing Profile은 직접 종속시키지 않고 canonical Profile IR로 변환하여 수용한다.

---

## 11. 성공 기준

이 시스템의 성공은 파싱한 문서 수 자체보다 다음 지표로 판단한다.

- Agent별 자체 Parser 구현 수 감소
- 신규 Agent 개발 시 문서 파싱 코드 작성 비율 감소
- Parsing Profile 재사용률
- 신규 문서 중 기존 Profile 자동 적용률
- 신규 양식 추가 요청 비율
- 문서 양식 변경 시 Agent 코드 변경 없이 대응한 비율
- 추출 값의 원본 추적 가능률
- 예외 검수 비율
