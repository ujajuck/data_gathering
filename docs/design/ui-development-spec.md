# Semantic Excel Integration — UI Development Specification

작성일: 2026-09-14
상태: 개발 기준안

참조 문서:
- `docs/design/system-identity-and-scope.md`
- `docs/design/ui-screen-definition.md`
- `docs/design/ui-wireframes.md`
- `docs/design/parsing-core-schema.md`

참조 목업:
- `docs/design/assets/ui-approved-mockup.svg`

---

## 1. 고정 제품명과 용어

서비스 헤더의 제품명은 **Semantic Excel Integration**으로 고정한다.

UI 용어는 다음을 사용한다.

- Parsing Schema = 파싱 스키마
- Parsing Field = 필드
- Parsing Profile = 파싱 프로파일
- Parsing Rule = 파싱 규칙
- Source Region = 원본 위치
- Data Build = 데이터 빌드

`KG`, `Concept`, `Template`, `Integration Project`는 사용자 기본 UI 용어로 사용하지 않는다.

핵심 의미 구분:

> **파싱 스키마 = 무엇을 추출한 데이터로 볼 것인가**  
> **파싱 프로파일 = 실제 문서에서 그 데이터를 어떻게 찾을 것인가**

---

## 2. 전체 Navigation

좌측 메뉴는 데이터 흐름에 맞춰 아래 순서로 고정한다.

```text
Semantic Excel Integration

문서
파싱 프로파일
파싱 스키마
데이터 빌드
작업 내역

설정
```

흐름:

```text
실제 문서
  ↓
Parsing Profile 적용
  ↓
Parsing Schema의 Field로 의미 연결
  ↓
Data Build에서 필요한 Field 선택/출력 컬럼 정의
  ↓
CSV / XLSX / SQLite 생성
```

`Source Review`는 독립 메뉴가 아니다. 문서/프로파일/스키마/빌드 결과에서 진입하는 공통 상세 Workspace다.

---

## 3. S-01 문서

### 목적

실제 입력 파일을 관리하고, 문서에 어떤 파싱 프로파일과 파싱 스키마가 적용되었는지 확인한다.

### 기본 레이아웃

```text
┌ 문서 검색 / 상태 필터 / + 문서 등록 ───────────────────────┐
│ 문서명 │ 상태 │ 적용 프로파일 │ 연결 스키마 │ 최근 처리 │
├─────────────────────────────────────────────────────────────┤
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘

행 선택 → Document Detail
```

### Document Detail

필수 표시:

- 문서명 / 현재 Snapshot
- Sheet 목록
- 적용 Parsing Profile
- 연결 Parsing Schema
- 최근 Parsing 상태
- 최근 오류

주요 행동:

- `원본 보기`
- `다른 프로파일로 파싱`
- `데이터 빌드에 추가`

관계는 항상 다음 방향으로 확인 가능해야 한다.

```text
문서 → Parsing Profile → Parsing Schema
```

---

## 4. S-02 파싱 프로파일

### 목적

문서 양식에서 데이터를 찾는 규칙을 관리하고 실제 파일에 적용해 검증한다.

### Profile 목록

기본 컬럼:

```text
프로파일명
버전
연결 스키마
적용 문서 수
상태
최근 수정
```

### Profile Detail

탭:

```text
기본 정보 | 규칙 | 필드 매핑 | 테스트 | JSON | 변경 이력
```

필수 구성:

- Sheet matcher / Sheet role
- Parsing Rule
- key/value/unit/context selector
- 연결 Parsing Field
- type / unit / normalization
- canonical JSON

외부 Profile JSON은 Import Adapter를 통해 canonical Profile JSON으로 변환한다.

### 실제 파일 테스트

Profile Detail의 `테스트`에서 실제 문서를 선택하면 Source Review를 연다.

```text
Profile
  ↓ 적용
실제 Excel Sheet
  ↓ overlay
Key / Value / Unit / Context
  ↓
추출 결과
```

Profile DSL 확장 때문에 별도 코어 DB 테이블을 추가하지 않는다.

---

## 5. S-03 파싱 스키마

### 원칙

**파싱 스키마 화면은 하나만 둔다.**

트리 화면과 그래프 화면을 별도 메뉴/페이지로 분리하지 않고 동일 화면에서 토글한다.

### 기본 레이아웃

```text
┌ Schema 목록 ┬──────────── Schema Detail ─────────────┬ Field Detail ┐
│             │ 구조 보기 / 사용 프로파일 / 연관 문서  │              │
│ Schema A    │                                         │ field_name   │
│ Schema B    │ [트리 보기] [그래프 보기]               │ type         │
│ Schema C    │                                         │ unit         │
│             │     Tree or Graph                      │ aliases      │
└─────────────┴─────────────────────────────────────────┴──────────────┘
```

### Schema Detail 상단 탭

```text
구조 보기 | 사용 프로파일 (N) | 연관 문서 (N) | 변경 이력
```

`구조 보기` 안에서만 다음 토글을 제공한다.

```text
[트리 보기] [그래프 보기]
```

### 트리 보기

Field의 계층을 가장 빠르게 이해하는 기본 보기다.

```text
공정 데이터 표준
├─ 기본 정보
│  ├─ 제품명
│  └─ 레시피명
├─ 공정 정보
│  ├─ 공정명
│  ├─ 설비명
│  ├─ 측정일시
│  ├─ 온도
│  ├─ 압력
│  └─ 시간
└─ 결과 정보
   ├─ 결과값
   └─ 판정
```

노드 선택 시 오른쪽 Field Detail을 갱신한다.

### 그래프 보기

현재 구현되어 있는 Schema/KG 관계 그래프를 유지한다.

표현 대상:

- Schema root
- Field group
- Parsing Field
- parent / child / related relation

그래프는 Schema의 관계 이해용이며 편집의 기본 UI는 아니다.

### Field Detail

필수 표시:

- Field명
- 영문 key
- 설명
- type
- unit
- alias
- 부모/자식/related Field
- 사용하는 Parsing Profile 수
- 실제 연결 문서 수

### Schema → Profile → 실제 파일 추적

Schema 화면에서 이 관계가 바로 확인되어야 한다.

`사용 프로파일` 탭:

```text
Profile명 | 버전 | Rule | 적용 문서 수 | 상태
```

프로파일 선택 시 해당 프로파일 상세로 이동한다.

`연관 문서` 탭:

```text
문서명 | 사용 Profile | Snapshot | Parsing 상태 | 원본 보기
```

Field Detail의 `사용 프로파일`, `사용 문서` 링크로도 동일 목록을 필터링하여 열 수 있다.

관계 탐색의 기준:

```text
Parsing Schema
  ↓ contains
Parsing Field
  ↓ mapped by
Parsing Rule / Profile
  ↓ applied to
Document Snapshot / Sheet / Source Region
```

---

## 6. S-04 데이터 빌드

### 목적

선택 문서의 Parsing Field 데이터를 필요한 출력 컬럼으로 구성하고 일회성 결과 파일을 만든다.

### 단계

```text
1. 대상 문서 선택
2. Parsing Schema 선택
3. 출력 Field 선택 + 출력 Header 지정
4. Preview
5. 생성 / Download
```

### 필수 기능: 출력 Header 편집

각 Field마다 **출력 Header명**을 사용자가 직접 지정할 수 있어야 한다.

```text
사용 | 원본 Field | 출력 Header | Type | Unit | 순서
 ☑   | temperature | 온도_C     | float| °C   | ↕
 ☑   | pressure    | 압력_bar   | float| bar  | ↕
```

규칙:

- 기본값은 Parsing Field 이름
- Header 중복 금지
- Header 빈 값 금지
- Drag & Drop 또는 이동 버튼으로 순서 변경
- 제외할 Field는 체크 해제

### Preview

생성 전 실제 데이터 일부를 Table 형태로 표시한다.

각 값에서 `원본 보기`를 제공한다.

`원본 보기` 클릭 시 Source Review를 열고 다음 정보를 전달한다.

- document_snapshot_id
- sheet_id
- source_region
- parsing_profile
- parsing_rule
- parsing_field

### 출력

지원 대상:

- CSV
- XLSX
- SQLite

최종 Build는 장기 영속 Integration 객체가 아니라 요청 시 생성하는 산출물이다.

---

## 7. S-05 작업 내역

### 목적

비동기/장시간 작업과 오류를 확인한다.

목록 대상:

- 문서 Parsing
- DRM/OpenPyXL Render
- Profile 테스트
- Data Build
- 재파싱

기본 컬럼:

```text
작업 종류 | 대상 | 상태 | 시작 | 종료 | 결과/오류
```

실패 작업은 해당 문서/Profile/Source Review로 이동할 수 있어야 한다.

운영 검수 Queue도 이 화면에서 제공하되 별도 계정/RBAC은 현재 구현 범위에서 제외한다.

---

## 8. Source Review 공통 Workspace

### 목적

원본 Excel과 Parsing 결과를 한 화면에서 비교한다.

### 레이아웃

```text
┌ Context: Document / Sheet / Profile / Schema ───────────────┐
├──────────────┬───────────────────────────┬───────────────────┤
│ Sheet/Rule   │ Excel Viewer             │ Mapping / Value   │
│ Navigation   │ + Source Region Overlay  │ Detail            │
│              │                           │                   │
└──────────────┴───────────────────────────┴───────────────────┘
```

중앙 Viewer의 Sheet 렌더링은 Main Web/API가 직접 수행하지 않고 별도 Excel/OpenPyXL Render API를 통해 가져온다.

캐시 key 권장:

```text
document_snapshot_id + sheet_id + renderer_version
```

---

## 9. 구현 시 기존 UI 재사용

가능한 기존 React 자산은 폐기하지 않고 역할을 재배치한다.

| 현재 구현 | 신규 위치 |
|---|---|
| `DocumentsTable` | 문서 |
| `DocumentDrawer` | 문서 상세 |
| `DomainGraph` | 파싱 스키마 > 그래프 보기 |
| `ConceptTree` 계열 | 파싱 스키마 > 트리 보기 |
| `Source.tsx` | Source Review |
| Template/Profile JSON editor | 파싱 프로파일 |
| `ReviewQueue` | 작업 내역 |
| `Database.tsx`의 Field 선택/Preview | 데이터 빌드 |

삭제/축소 대상:

- 사용자에게 노출되는 `KG revision id`, `application_id`, `mapping_revision_id`
- 영속 Integration Project 중심 UI
- 동일 목적의 중복 Tree/List/Graph 화면
- 일반 사용자 화면의 상세 JSON

---

## 10. 개발 완료 조건

### Navigation
- 제품명이 `Semantic Excel Integration`으로 표시된다.
- 메뉴 순서가 `문서 → 파싱 프로파일 → 파싱 스키마 → 데이터 빌드 → 작업 내역`이다.

### Parsing Schema
- 하나의 화면이다.
- Tree / Graph 토글이 가능하다.
- Field 선택 시 상세가 보인다.
- Schema에서 사용 Profile과 실제 문서까지 추적 가능하다.

### Parsing Profile
- Profile → Schema Field 연결이 보인다.
- 실제 파일 테스트가 가능하다.
- Source Region overlay로 추출 위치를 확인할 수 있다.

### Data Build
- 여러 문서 선택이 가능하다.
- Schema Field를 선택할 수 있다.
- **출력 Header를 직접 편집할 수 있다.**
- 컬럼 순서를 변경할 수 있다.
- Preview 후 CSV/XLSX/SQLite를 생성할 수 있다.
- Preview 값에서 원본으로 이동할 수 있다.

### Document
- 문서 → Profile → Schema 관계가 보인다.

### Source Review
- 실제 Excel 형태를 확인할 수 있다.
- Key/Value/Unit/Context overlay를 볼 수 있다.
- 파싱 근거와 원본 위치를 동시에 확인할 수 있다.
