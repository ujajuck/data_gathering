# System Identity, Scope and Requirements

작성일: 2026-09-14

## 1. 용어 정의

이 문서에서는 다음 용어를 고정해서 사용한다.

- **Parsing Schema**: 여러 문서에서 추출한 데이터를 공통 의미로 맞추기 위한 목표 데이터 구조. 무엇을 의미하는 데이터인지 정의한다.
- **Parsing Field**: Parsing Schema를 구성하는 개별 표준 필드.
- **Parsing Profile**: 특정 문서 양식에서 Parsing Field에 해당하는 값을 어디서, 어떻게 찾고 읽을지 정의한 재사용 가능한 파싱 설정. 문서 양식을 읽는 방법을 정의한다.
- **Parsing Rule**: Parsing Profile 내부의 개별 탐색·추출·변환 규칙.
- **Mapping**: Parsing Rule의 결과를 특정 Parsing Field와 연결한 적용 결과.
- **Source Region**: 추출값이 실제로 참조한 원본 Sheet/Cell/Range 등의 위치.

핵심 구분은 다음과 같다.

> **Parsing Schema = 무엇인가 / Parsing Profile = 어떻게 찾는가**

---

## 2. 시스템 정체성

이 시스템은 범용 Excel Viewer, 범용 Document AI, 자동 Knowledge Graph 생성기, 장기 데이터웨어하우스가 아니다.

핵심 정체성은 다음과 같다.

> **NASCA/DRM 등으로 보호된 기업 내부 문서를 검증된 Parsing Schema와 Parsing Profile을 통해 정형화된 단일 테이블 데이터로 변환하여 공정/분석 Agent에 제공하는 내부용 Secure Document-to-Table Adapter**

즉 Agent가 원본 문서의 물리적 양식, DRM 처리, 병합 셀, 시트 위치, 단위 정규화, 문서별 파싱 코드를 직접 알지 않아도 되게 하는 **Agent용 데이터 준비 계층**이다.

```text
NASCA / DRM / Local Excel
        ↓
Parsing Profile
        ↓
Parsing Schema Mapping
        ↓
Extracted Value + Provenance
        ↓
단일 Table
        ↓
SQLite / CSV / XLSX / Agent Input
```

최종 통합 파일은 시스템 내부의 영속 Source of Truth가 아니라 필요할 때 생성하는 산출물이다.

---

## 3. 해결하려는 문제와 존재 이유

Agent 개발자가 문서별 파서를 직접 만드는 방식에는 다음 문제가 있다.

1. 여러 Agent가 같은 문서 양식을 반복 구현한다.
2. 동일한 데이터를 Agent마다 다른 의미·alias·단위로 해석할 수 있다.
3. 문서 양식 변경이 Agent 코드 변경으로 직접 전파된다.
4. NASCA/DRM 접근과 보안 파일 취급 로직이 Agent별로 중복된다.
5. 추출값이 원본 어디에서 왔는지 추적하기 어렵다.
6. 수천 문서를 문서별로 검수하는 방식은 운영할 수 없다.

따라서 이 시스템의 핵심 가치는 다음 세 가지다.

- **파싱 구현의 공통화**: 문서 양식별 Parsing Profile을 재사용한다.
- **의미 계약의 공통화**: Parsing Schema를 Agent 간 공통 데이터 계약으로 사용한다.
- **원본 추적성**: 추출값을 원본 Source Region까지 추적할 수 있다.

문서 양식이 바뀌면 가능한 한 Agent 코드는 바뀌지 않고 Parsing Profile만 수정한다.

### 3.1 일회성 파싱 코드 대비 장점

이 시스템의 목적은 단순히 파싱 코드를 한 곳에 모으는 것이 아니다. 개인 또는 Agent 개발자가 필요할 때마다 일회성 파싱 코드를 생성하는 방식과 비교하면 다음 차이가 있다.

- **재사용**: 한 번 검증한 Parsing Profile을 같은 양식의 여러 문서와 여러 Agent가 재사용한다.
- **변경 격리**: 문서 양식이 바뀌면 Agent 코드를 수정하지 않고 Parsing Profile을 수정한다.
- **의미 통일**: 서로 다른 문서 표현을 공통 Parsing Schema의 Parsing Field로 정규화한다.
- **검증 가능성**: 추출값을 문서·Sheet·Source Region과 Mapping 판단까지 역추적할 수 있다.
- **운영 가능성**: 신규 양식, 파싱 실패, 예외 Mapping, 문서 변경을 중앙에서 관리할 수 있다.
- **Agent 단순화**: Agent는 Excel/DRM/파싱 구현 대신 검증된 표준 테이블만 소비한다.

반대로 문서가 소수이고 한 번만 사용하며 양식 재사용이나 원본 추적이 필요하지 않다면 일회성 파싱 코드가 더 단순할 수 있다.

따라서 이 시스템이 제공하는 본질적인 가치는 다음과 같다.

> **반복해서 사용하는 사내 문서 데이터를 개인별 일회성 파싱 코드가 아니라 검증·재사용·추적 가능한 공통 데이터 공급 체계로 전환한다.**

---

## 4. 대표 유저케이스

계정·권한 체계는 현재 범위에서 다루지 않는다. 아래의 사용자와 운영자는 **역할 구분**이며 별도 계정 모델을 의미하지 않는다.

### UC-1. Agent용 표준 테이블 생성

주 사용자: Agent 개발자 또는 내부 데이터 사용자

1. 사용할 문서 또는 문서군을 선택한다.
2. 필요한 Parsing Schema를 선택한다.
3. 등록된 Parsing Profile이 적용되어 값을 추출한다.
4. 공통 Parsing Field 기준으로 결과를 구성한다.
5. 단일 Table, CSV, SQLite, XLSX 등으로 생성하여 Agent 입력으로 사용한다.

이 시스템의 가장 대표적인 유저케이스다.

### UC-2. 추출 결과의 원본 확인

1. 생성된 값 또는 Parsing Field를 선택한다.
2. 해당 값의 문서, Sheet, Source Region을 확인한다.
3. 원본 위치와 Mapping 근거를 확인한다.

목적은 결과가 왜 그렇게 만들어졌는지 검증하는 것이다.

### UC-3. 신규 문서 양식 등록

주 역할: 운영자

1. 신규 문서가 기존 Parsing Profile로 처리 가능한지 확인한다.
2. 처리할 수 없으면 신규 양식 등록 대상으로 분류한다.
3. Parsing Profile을 추가하거나 기존 Profile을 수정한다.
4. Parsing Schema와의 Mapping을 검수한다.
5. 승인된 Profile은 이후 동일 양식 문서에 재사용한다.

### UC-4. 파싱 실패·예외 처리

주 역할: 운영자

1. Profile 미매칭, selector 실패, 타입·단위 충돌 등의 문서를 확인한다.
2. Profile 또는 예외 Mapping을 수정한다.
3. 재파싱한다.
4. 수정 결과의 원본 위치와 추출값을 검수한다.

### UC-5. 문서 양식 변경 대응

주 역할: 운영자

1. 문서 snapshot 변경을 감지한다.
2. 기존 Profile 적용 가능 여부를 다시 판정한다.
3. 문제가 없으면 기존 Profile을 재사용한다.
4. 구조가 달라졌으면 Profile 수정 또는 예외 검수 대상으로 전환한다.

### UC-6. 외부 Parsing Profile 이관

주 역할: 운영자

1. 다른 파싱 프로그램의 Profile JSON을 입력한다.
2. Import Adapter가 내부 canonical Parsing Profile JSON으로 변환한다.
3. 변환 결과를 검증한다.
4. 이후 동일한 내부 Parsing Runtime으로 실행한다.

---

## 5. 운영 모델

이 시스템은 대규모 동시 실시간 처리를 목표로 하지 않는다.

기본 운영 모델은 다음과 같다.

- 내부 서비스
- on-demand / batch 중심
- 신규 양식은 등록 의뢰 방식
- 기존 Parsing Profile과 일치하는 문서는 자동 처리
- 신규/불일치 양식만 운영 검수

수천 개 문서를 문서별로 검수하지 않고, 실제 문서 양식을 Parsing Profile 단위로 관리·재사용하는 것이 목표다.

---

## 6. Mapping 승인 정책

모든 문서의 Mapping을 하나씩 수동 승인하지 않는다.

> **새로운 의미 관계 또는 기존 승인 규칙과 호환되지 않는 Mapping은 사람의 검수가 필요하다. 이미 승인된 Parsing Profile/Mapping 패턴은 동일하거나 호환되는 문서 구조에 자동 적용할 수 있다.**

자동 적용 결과도 어떤 Profile/Mapping 판단에서 파생되었는지 추적 가능해야 한다.

---

## 7. 범위

### 7.1 포함

- 문서 등록 및 snapshot 식별
- Excel 구조 파악
- Parsing Schema 관리
- Parsing Profile 관리
- Profile과 Sheet 역할 바인딩
- Mapping 생성·재사용·예외 검수
- 값 추출 및 정규화
- Source Region provenance
- Field 기준 문서/값 탐색
- 문서 기준 Field 탐색
- 단일 Table 및 CSV/SQLite/XLSX 생성
- NASCA/DRM 환경의 파싱·렌더 처리
- 신규 양식 등록 및 실패 문서 운영 처리
- 외부 Parsing Profile JSON import

### 7.2 비범위

- 계정/RBAC/조직 권한 관리
- 범용 Excel 편집기
- 대규모 실시간 동시 사용자 serving
- 자동 Parsing Schema/KG 무검증 성장
- LLM 단독 의미 승인
- 영구 통합 데이터웨어하우스
- Agent orchestration 자체
- 범용 Document AI

---

## 8. Parsing Profile 설계 원칙

### 8.1 저장 형식

Parsing Profile의 실행 정의는 **JSON 기반 선언형 Profile**로 관리한다.

현재 브랜치에는 기존 `kg/parsing.py` 형식과 v2 `kg/v2/spec.py` 형식이 공존한다. 향후에는 하나의 canonical Parsing Profile JSON을 기준으로 정리한다.

canonical Profile은 최소 다음 의미를 표현해야 한다.

```text
sheet_roles
rules
  - field/rule key
  - selector
  - value shape/type
  - normalization
anchors
relations
```

`anchors`, `relations`는 필요한 경우 Profile JSON DSL의 문법 요소로 포함한다.

### 8.2 DB와 JSON의 역할

외부 Profile 형식을 추가로 지원하기 위해 **코어 테이블을 추가하지 않는다.**

- `parsing_profile`: Profile의 안정 ID와 버전/정의 위치 관리
- `parsing_rule`: 필요한 검색·조회 단위 projection
- Profile JSON: 실제 파싱 DSL과 세부 실행 규칙
- `mapping_revision.effective_spec_json`: 실제 실행 당시 적용된 규칙 고정

즉 `composite_anchors`, `relations` 같은 기능은 별도 DB 엔터티로 만들지 않고 Profile JSON과 파싱 실행부에서 처리한다.

### 8.3 외부 Profile 통합

외부 파싱 프로그램의 JSON 형식은 내부 DB 스키마에 직접 맞추지 않는다.

```text
외부 Profile JSON
        ↓
Import Adapter
        ↓
Canonical Parsing Profile JSON
        ↓
Validate / Compile
        ↓
Parsing Runtime
```

따라서 외부 Profile 통합에 필요한 주요 변경 범위는 다음이다.

- Import Adapter
- canonical Profile validator
- selector/anchor/relation parser
- Runtime executor

DB 스키마 확장은 원칙적으로 필요하지 않다.

---

## 9. 현재 Profile 호환 시 고려할 기능

현재 v2가 이미 지원하는 주요 selector는 `range`, `find`, `relative`다.

외부 Profile 통합 시 추가 검토가 필요한 기능은 다음이다.

- regex 기반 field/anchor 탐색
- composite anchor
- field 간 relative relation
- 일반 delimiter split normalization

이 기능들은 Parsing Profile JSON DSL과 파싱 실행부를 확장해서 처리한다.

---

## 10. Viewer 및 DRM 처리 원칙

원본 검수 Viewer는 추출값과 Source Region의 관계를 보여주는 용도다.

DRM 해제와 OpenPyXL 기반 Sheet 파싱/렌더링은 Main Web/API와 분리한 별도 Render/Parsing Server에서 처리하고 결과를 캐시한다.

상세 설계는 `docs/design/drm-viewer-render-architecture.md`를 따른다.

---

## 11. 제품 불변식

1. 모든 추출값은 원본 Source Region으로 추적 가능해야 한다.
2. Parsing Schema는 무엇인지, Parsing Profile은 어떻게 찾는지를 책임진다.
3. 승인된 Parsing Profile은 반복 문서에 재사용할 수 있어야 한다.
4. 문서 양식 변경은 가능한 한 Agent 코드에 전파되지 않아야 한다.
5. 최종 통합 데이터는 산출물이며 새로운 영구 Source of Truth가 아니다.
6. 외부 Parsing Profile은 canonical Profile JSON으로 변환하여 수용한다.
7. Profile DSL 확장을 이유로 불필요한 코어 테이블을 추가하지 않는다.

---

## 12. 성공 기준

- Agent별 자체 Parser 구현 수 감소
- 신규 Agent 개발 시 문서 파싱 코드 감소
- Parsing Profile 재사용률
- 신규 문서 중 기존 Profile 자동 적용률
- 신규 양식 추가 요청 비율
- 문서 양식 변경 시 Agent 코드 변경 없이 대응한 비율
- 추출값의 원본 추적 가능률
- 예외/실패 문서의 운영 검수 비율