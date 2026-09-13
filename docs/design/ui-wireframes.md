# UI Wireframes — Use-case Driven

작성일: 2026-09-14

## 1. 전체 Navigation

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Data Gathering                                                             │
│ Documents | Data Build | Parsing Schema | Parsing Profiles | Operations     │
└──────────────────────────────────────────────────────────────────────────────┘
```

`Source Review`는 독립 메뉴로 두지 않고 필요한 화면에서 진입하는 검수 Workspace로 사용한다.

---

# 2. S-01 Documents

목적: 문서를 찾고 상태를 확인하고 Data Build 대상으로 선택한다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Documents                                                    [원본 등록]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [문서명 검색________________] [상태 ▼] [Profile ▼] [상세 필터]             │
├──┬────────────────────────┬──────────────┬────────────┬──────────┬──────────┤
│□ │ 문서명                 │ Profile      │ Schema     │ 상태     │ 최근처리 │
├──┼────────────────────────┼──────────────┼────────────┼──────────┼──────────┤
│□ │ experiment_001.xlsx    │ Process v3   │ Process    │ 정상     │ 09-14    │
│□ │ experiment_002.xlsx    │ Process v3   │ Process    │ 정상     │ 09-14    │
│□ │ old_format_014.xlsx    │ -            │ -          │ 미매칭   │ -        │
│□ │ report_037.xlsx        │ Report v2    │ Quality    │ 검수필요 │ 09-13    │
└──┴────────────────────────┴──────────────┴────────────┴──────────┴──────────┘
│ 3개 선택                                             [데이터 만들기 →]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

행 클릭 시 우측 Drawer:

```text
                         ┌──────────────────────────────────┐
                         │ experiment_001.xlsx              │
                         │ 상태: 정상                       │
                         ├──────────────────────────────────┤
                         │ Snapshot                         │
                         │ 2026-09-14 / 최신                │
                         │                                  │
                         │ Parsing Profile                  │
                         │ Process Experiment v3            │
                         │                                  │
                         │ Parsing Schema                   │
                         │ Process Data                     │
                         │                                  │
                         │ Sheets  7                        │
                         │ Extracted Fields  23             │
                         │                                  │
                         │ [원본/추출 확인]                 │
                         │ [이 문서로 데이터 만들기]        │
                         └──────────────────────────────────┘
```

### 화면 원칙

- 일반 사용자는 `application_id`, revision UUID 등을 보지 않는다.
- 목록에서 가장 중요한 것은 **이 문서를 지금 사용할 수 있는지**다.
- 미매칭/실패 문서는 보이되 수정 기능은 `Operations`로 연결한다.

---

# 3. S-02 Data Build

목적: 선택한 문서에서 필요한 Parsing Field를 골라 실제 Agent 입력용 테이블을 만든다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Data Build                                                                  │
│ 입력 문서 37개 · 사용 가능 35개 · 제외 2개              [문서 다시 선택] │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ Parsing Schema        │ 출력 필드                                           │
│ [Process Data ▼]      │                                                     │
│                       │ ☑ experiment_id     text                            │
│ [필드 검색________]   │ ☑ temperature       decimal   °C                   │
│                       │ ☑ pressure          decimal   bar                  │
│ ▼ Experiment          │ ☑ duration          decimal   sec                  │
│   ☑ ID                │ ☐ operator          text                           │
│   ☑ Type              │                                                     │
│ ▼ Condition           │ 선택 필드 4개                                       │
│   ☑ Temperature       │                                                     │
│   ☑ Pressure          │                                                     │
│   ☑ Duration          │                                                     │
└───────────────────────┴──────────────────────────────────────────────────────┤
│ Preview                                                                      │
├───────────────┬──────────────┬──────────────┬──────────────┬────────────────┤
│ experiment_id │ temperature  │ pressure     │ duration     │ source         │
├───────────────┼──────────────┼──────────────┼──────────────┼────────────────┤
│ EXP-001       │ 180          │ 1.2          │ 300          │ [원본 확인]    │
│ EXP-002       │ 185          │ 1.2          │ 280          │ [원본 확인]    │
│ EXP-003       │ 190          │ 1.3          │ 270          │ [원본 확인]    │
└───────────────┴──────────────┴──────────────┴──────────────┴────────────────┘
│ 제외 문서 2개 [보기]                                  [CSV] [SQLite] [XLSX]│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 화면 원칙

- 기존 `Database`의 Integration/Project 개념은 제거한다.
- 사용자가 해야 하는 판단은 **문서 / Schema / Field / 결과 형식** 네 가지로 제한한다.
- Preview의 값 또는 행에서 바로 `Source Review`로 갈 수 있어야 한다.
- 제외 문서는 이유만 명확히 보여준다.

---

# 4. S-03 Parsing Schema

목적: 공통 데이터 의미를 정의하고 현재 연결 상태를 확인한다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Parsing Schema                                      [새 Schema] [버전 이력]│
├───────────────────────┬──────────────────────────────┬───────────────────────┤
│ Schema / Field        │ Field Definition             │ 연결 현황             │
│                       │                              │                       │
│ [Process Data ▼]      │ Temperature                  │ Profiles 4            │
│ [검색____________]    │                              │ Rules 9               │
│                       │ 정의                         │ Documents 1,284       │
│ ▼ Experiment          │ 공정 설정 온도               │                       │
│   ID                  │                              │ 최근 값              │
│   Type                │ Type: decimal                │ 180 °C               │
│ ▼ Condition           │ Unit: °C                     │ 185 °C               │
│   ● Temperature       │                              │ 190 °C               │
│   Pressure            │ Alias                        │                       │
│   Duration            │ 온도, 공정온도, Temp         │ [원본 보기]          │
│                       │                              │                       │
│ [Graph 보기]          │ Parent: Condition            │                       │
└───────────────────────┴──────────────────────────────┴───────────────────────┘
```

### 화면 원칙

- 기본은 Tree/List.
- Graph는 구조 확인용 보조 보기.
- 기존 `KG`, `Concept` 용어는 UI에서 제거하고 `Parsing Schema`, `Parsing Field`로 통일한다.

---

# 5. S-04 Parsing Profiles

목적: 문서 양식별 Parsing Profile을 등록·수정·테스트한다.

## 목록

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Parsing Profiles                              [외부 Profile Import] [새로] │
├──────────────────────────┬─────────┬────────────┬───────────┬───────────────┤
│ Profile                  │ Version │ Schema     │ 적용문서  │ 상태          │
├──────────────────────────┼─────────┼────────────┼───────────┼───────────────┤
│ Process Experiment       │ v3      │ Process    │ 1,284     │ 정상          │
│ Quality Report           │ v2      │ Quality    │ 348       │ 정상          │
│ Legacy Experiment        │ v5      │ Process    │ 94        │ 검수 필요     │
└──────────────────────────┴─────────┴────────────┴───────────┴───────────────┘
```

## 상세/편집

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Process Experiment v3                      [대표 문서 테스트] [새 버전 저장]│
├────────────────────┬─────────────────────────────────────────────────────────┤
│ Sheet Roles        │ Parsing Rules                                           │
│                    │                                                         │
│ main               │ temperature → Temperature                              │
│  DATA              │   find "온도" → right 1                               │
│                    │                                                         │
│ metadata           │ pressure → Pressure                                     │
│  INFO              │   find "압력" → below 1                               │
│                    │                                                         │
│                    │ duration → Duration                                     │
│                    │   anchor "시험시간"                                    │
├────────────────────┴─────────────────────────────────────────────────────────┤
│ [기본 편집] [JSON] [버전 이력]                                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 외부 Profile Import

```text
외부 JSON 입력
   ↓
Adapter 변환
   ↓
Canonical Parsing Profile Preview
   ↓
Validation
   ↓
대표 문서 Test
   ↓
새 Profile 저장
```

### 화면 원칙

- 기본 사용은 Rule Form.
- JSON은 고급 편집 탭으로 내린다.
- `anchors`, `relations`, `composite_anchors`는 Profile 내부 기능이지 별도 관리 화면을 만들지 않는다.

---

# 6. S-05 Operations

목적: 정상 처리되지 않은 것만 모아 운영자가 처리한다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Operations                                                                  │
├─────────────────┬─────────────────┬─────────────────┬──────────────────────┤
│ 신규 양식 12    │ Mapping 검수 8 │ Parsing 실패 5 │ 변경 감지 21         │
└─────────────────┴─────────────────┴─────────────────┴──────────────────────┘

[신규 양식] [Mapping 검수] [Parsing 실패] [변경 감지]

┌───────────────────────┬───────────────┬──────────────┬─────────────────────┐
│ 대상                  │ 원인          │ 영향         │ 처리                │
├───────────────────────┼───────────────┼──────────────┼─────────────────────┤
│ 신규양식 A · 37문서   │ Profile 없음 │ 37 documents │ [Profile 만들기]    │
│ Process v3 · 8문서    │ selector 실패│ 2 rules      │ [원본 검수]         │
│ Legacy v5 · 14문서    │ 단위 충돌     │ pressure     │ [일괄 검수]         │
└───────────────────────┴───────────────┴──────────────┴─────────────────────┘
```

### 화면 원칙

- 문서 한 건씩 나열하지 말고 **같은 원인/같은 양식은 묶는다.**
- 여기서 직접 복잡한 편집을 하지 않는다.
- 원인에 따라 `Parsing Profiles` 또는 `Source Review`로 보낸다.

---

# 7. S-06 Source Review

목적: Parsing Rule, 추출값, 원본 위치를 한 번에 검수한다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 돌아가기  experiment_014.xlsx / DATA / Process Experiment v3             │
├──────────────────┬───────────────────────────────────┬───────────────────────┤
│ Sheet / Rule     │ Original Sheet                   │ Mapping / Value       │
│                  │                                   │                       │
│ Sheets           │      Excel-like Viewer            │ Field                 │
│ ● DATA           │                                   │ Temperature           │
│   INFO           │       ┌──────────────┐            │                       │
│                  │       │ 온도 │ 180   │ ← VALUE   │ Rule                  │
│ Rules            │       └──────────────┘            │ temperature           │
│ ● temperature    │                                   │                       │
│   pressure       │   KEY / VALUE / UNIT overlay      │ Extracted             │
│   duration       │                                   │ 180 °C                │
│                  │                                   │                       │
│                  │                                   │ Source                │
│                  │                                   │ DATA!D14              │
│                  │                                   │                       │
│                  │                                   │ [수정] [승인] [반려] │
└──────────────────┴───────────────────────────────────┴───────────────────────┘
```

### 화면 원칙

- 현재 `Source.tsx`의 3-column 구조는 유지 가치가 높다.
- 왼쪽에서 내부 Application 개념은 숨기고 `Sheet / Profile / Rule`만 보여준다.
- 중앙은 별도 Render/Parsing Server 결과를 사용한다.
- 오른쪽은 `Parsing Field / Rule / 값 / Source Region / 상태`만 우선 노출한다.
- revision history와 raw JSON은 접힌 상세영역으로 내린다.

---

# 8. 핵심 사용자 Flow

## 8.1 일반 사용자

```text
Documents
   ↓ 문서 선택
Data Build
   ↓ Field 선택
Preview
   ↓
Export
```

검증이 필요한 경우만:

```text
Preview
   ↓ 원본 확인
Source Review
   ↓ 확인
Data Build로 복귀
```

## 8.2 신규 양식 운영

```text
Operations
   ↓ 신규 양식 그룹 선택
Parsing Profiles
   ↓ Profile 작성/Import
대표 문서 테스트
   ↓
Source Review
   ↓ 검수 완료
Profile 새 버전 저장
   ↓
해당 문서군 재파싱
```

## 8.3 Parsing 실패 운영

```text
Operations
   ↓ 실패 그룹 선택
Source Review
   ↓ 원인 확인
Parsing Profile 수정
   ↓
대표 문서 재테스트
   ↓
재파싱
```

---

# 9. 현재 UI에서 우선 제거/축소할 것

1. 상단 독립 `Source` 메뉴
2. 일반 사용자 화면의 KG 용어
3. 일반 사용자 화면의 application/mapping revision 내부 ID
4. Data Build의 Integration Project/Build History 중심 흐름
5. Documents 화면 하단 Review Queue
6. Parsing Profile 기본 화면에서 JSON 우선 편집
7. Source Review에서 동시에 너무 많은 상태/버전/내부 메타데이터 노출

---

# 10. 구현 우선순위

1. Navigation 재구성
2. Documents 목록 단순화 + Data Build 연결
3. Data Build 일회성 흐름으로 단순화
4. Operations 화면 신설 및 Review Queue 이동
5. Source Review 용어/구성 단순화
6. Templates → Parsing Profiles 개명 및 편집 UI 정리
7. KG → Parsing Schema 개명 및 Graph 보조화

첫 구현 목표는 **새 기능 추가보다 현재 기능의 재배치와 숨김**이다.
