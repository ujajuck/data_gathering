# DRM Viewer Performance Issue and Render Service Architecture

작성일: 2026-09-14

## 1. 문제 정의

현재 웹 UI에서 DRM/NASCA 보호 Excel 문서를 열면 문서 한 건의 로딩이 매우 오래 걸리고, 렌더링 중 프론트가 심하게 버벅이거나 사이트 전체가 사실상 멈추는 문제가 있다.

실사용 환경에서 DRM 해제 자체는 약 5초 수준이다. 따라서 사용자 체감 지연의 전부를 DRM으로 설명하기 어렵고, 실제 병목은 **복호화 이후의 Excel 렌더/직렬화/브라우저 DOM 생성이 웹 요청 경로에 직접 결합된 구조**에 있다.

현재 구현은 `kg/webapp.py`, `src/inspect/inspector.py`, `frontend/src/screens/source/SheetGrid.tsx` 등에 걸쳐 다음 흐름을 갖는다.

```text
브라우저 GET /api/sheet
        ↓
Main FastAPI Server
        ↓
DRM 파일이면 Excel COM Open
        ↓
Sheet.Copy()
        ↓
임시 XLSX SaveAs
        ↓
openpyxl 재오픈
        ↓
셀/병합/폰트/테두리/행높이/열폭/이미지/Shape 추출
        ↓
대형 JSON 생성
        ↓
브라우저 전송
        ↓
React HTML table 전체 렌더
```

DRM 렌더 경로의 코드 주석도 `Copy -> SaveAs -> openpyxl` 방식이 시트당 수초가 걸릴 수 있음을 전제로 한다.

---

## 2. 현재 구현의 주요 병목

### 2.1 Web/API 요청 안에서 무거운 렌더 수행

현재 `/api/sheet` 요청이 cache miss일 경우 Excel COM과 openpyxl 렌더를 직접 수행한다.

이 작업은 CPU, 파일 IO, Excel 프로세스, COM 호출을 모두 사용하며 실패/지연이 Main Web Server의 응답성과 직접 연결된다.

### 2.2 DRM 파일을 시트 전환 때 다시 열 가능성

메모리 캐시는 존재하지만 프로세스 재시작, snapshot 변경, cache miss 등의 경우 다시 DRM/Excel 경로를 탄다.

DRM 해제 비용 약 5초가 허용 가능한 수준이더라도 이를 반복 클릭마다 지불하면 사용성이 나오지 않는다.

### 2.3 전체 Sheet를 한 번에 JSON으로 생성

현재 렌더는 최대 행/열 제한 내에서 셀 스타일과 레이아웃을 함께 만든다. 복잡한 문서에서는 큰 JSON이 생성된다.

### 2.4 이미지 base64 인라인

현재 이미지가 sheet JSON에 base64 data URL로 포함될 수 있다. 셀 데이터와 이미지가 한 응답에 결합되면 네트워크 전송, JSON parsing, memory usage가 모두 커진다.

### 2.5 React 전체 DOM 렌더

현재 `SheetGrid.tsx`는 `max_row × max_col` 크기의 `<td>`를 한꺼번에 생성한다.

기본 cap이 300 × 40이라면 최대 12,000개 셀 DOM이 한 번에 만들어질 수 있다. overlay 계산과 merged-cell 계산까지 같은 렌더 사이클에 수행된다.

---

## 3. 설계 결론

가장 단순한 해결은 **Main Web/API Server와 별도로 openpyxl/Excel 렌더·파싱 전용 API Server를 분리하는 것**이다.

이 시스템은 높은 동시성을 목표로 하지 않으므로 Render Server는 낮은 concurrency, 심지어 Windows Excel COM 경로는 concurrency=1로 운용해도 된다.

```text
┌──────────────────────┐
│      Browser UI      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Main Web/API       │
│ - Schema/Profile     │
│ - Mapping            │
│ - Extraction Query   │
│ - Agent Export       │
└──────────┬───────────┘
           │ Render API
           ▼
┌──────────────────────┐
│ Excel/OpenPyXL       │
│ Render Server        │
│ - DRM access         │
│ - Excel COM          │
│ - openpyxl parsing   │
│ - render cache       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Render Cache         │
│ snapshot + sheet     │
└──────────────────────┘
```

Main Web/API Server는 더 이상 Excel COM이나 openpyxl 전체 workbook 렌더를 직접 수행하지 않는다.

---

## 4. Render Server 책임

Render Server는 다음만 책임진다.

1. NASCA/DRM 정책에 따라 허용된 문서 접근
2. Excel/OpenPyXL을 이용한 workbook/sheet 구조 해석
3. 병합, 셀 값, 행높이, 열폭, 스타일, 이미지/shape 등의 Viewer용 데이터 생성
4. Source Region 좌표 조회
5. render cache 저장/조회
6. Main API에 렌더 결과 제공

반대로 다음은 Render Server 책임이 아니다.

- Parsing Schema 의미 관리
- Parsing Profile lifecycle
- Mapping 승인 정책
- Agent용 최종 table 선택
- 통합 DB 영구 관리

---

## 5. 캐시 정책

보안 정책상 렌더 캐시 저장이 허용되는 것을 전제로 한다.

권장 cache key는 다음과 같다.

```text
document_snapshot_id
+ sheet_id or sheet_name
+ renderer_version
```

문서가 변경되어 새로운 snapshot이 생성되면 기존 캐시는 자동으로 별도 상태가 되며 재사용하지 않는다.

### 최초 접근

```text
DRM Open (~5s)
+ Excel/OpenPyXL Render
+ Cache 저장
```

### 재접근

```text
Cache Lookup
→ 즉시 Viewer 응답
```

DRM 해제 5초는 최초 렌더 비용으로 수용하되 반복 접근에서 다시 지불하지 않는 것이 핵심이다.

---

## 6. 동기/비동기 처리

Main Web 요청이 Render Worker 작업 완료까지 block되지 않도록 한다.

```text
GET Viewer
  ↓
Cache Hit?
  ├─ YES → 즉시 응답
  └─ NO  → Render 요청 등록
             ↓
         Render Server
             ↓
         Cache 생성
```

UI는 cache miss일 때 문서 전체 사이트를 막는 대신 해당 Viewer 영역만 `Rendering` 상태를 표시해야 한다.

이 시스템은 대규모 동시성을 목표로 하지 않으므로 복잡한 분산 queue까지 필요하지 않을 수 있다. 단일 Render Server 내부 queue와 worker 1개부터 시작하는 것이 적절하다.

---

## 7. Viewer 데이터 구조

기본 Viewer는 Excel 편집기가 아니라 provenance 검수 화면이다.

따라서 다음을 우선 제공한다.

```text
Extracted Value
→ Source Region
→ 해당 Sheet/Range 표시
→ KEY / VALUE / UNIT / CONTEXT Overlay
```

전체 sheet를 항상 렌더하는 대신 Source Region 주변 context window를 먼저 제공할 수 있다.

예:

```text
Target = D142
Context = row 135~150, col B~F
```

필요할 때만 전체 Sheet를 요청한다.

### 전체 Sheet가 필요한 경우

전체 Sheet Viewer는 React 전체 DOM 방식보다 virtualized grid 또는 tile/window 기반 렌더를 우선 검토한다.

---

## 8. Excel 양식 보존

Render Server를 분리한다고 해서 Excel 양식 보존 방식 자체가 바뀌는 것은 아니다. 오히려 렌더 비용을 Main Web Server에서 격리하기 때문에 더 충실한 렌더 전략을 사용할 수 있다.

현재 openpyxl 기반 Viewer가 보존하는 주요 요소는 다음과 같다.

- 셀 값
- 병합
- fill
- font 일부
- border
- alignment
- 행높이
- 열폭
- 이미지 anchor
- 일부 Shape/TextBox

다만 openpyxl/HTML 재현은 Excel native renderer와 100% 동일하지 않다. 조건부 서식, 복잡한 chart/SmartArt, theme, 일부 shape z-order 등은 차이가 날 수 있다.

따라서 Viewer 목적을 두 단계로 구분한다.

1. **구조/Mapping 검수**: openpyxl render JSON + overlay
2. **원본 시각 확인이 절대적으로 필요한 경우**: 별도 native preview 전략을 선택 가능

현재 요구사항에서는 우선 1번을 기본으로 하며, Render Server 분리와 cache를 통해 사용성을 확보한다.

---

## 9. 이미지 처리

이미지는 sheet JSON에 base64로 모두 인라인하지 않는 방향을 권장한다.

```text
GET /render/{snapshot}/{sheet}
→ cell/layout/merge metadata

GET /render/assets/{asset_id}
→ image binary
```

프론트는 viewport 안에 들어온 이미지부터 lazy load한다.

이렇게 하면 큰 이미지가 있는 문서도 셀 데이터 조회를 지연시키지 않는다.

---

## 10. 목표 성능

DRM Open 자체가 약 5초라는 실측을 전제로 다음 수준을 목표로 한다.

| 상황 | 목표 |
|---|---:|
| 처음 보는 DRM 문서 | DRM + 렌더 수초, Viewer 영역만 대기 |
| 캐시된 문서 재접근 | 1초 이내 목표 |
| 캐시된 sheet 전환 | sub-second 목표 |
| Mapping Source Region 이동 | 즉시 체감 |
| Render 중 다른 화면/API 사용 | 영향 없어야 함 |

핵심 SLA는 최초 렌더의 절대 시간보다 **Render 작업이 전체 웹서비스 응답성을 죽이지 않는 것**이다.

---

## 11. API 초안

Render Server는 단순한 내부 API면 충분하다.

```text
POST /render
  input: snapshot_id, source_path, sheet(optional)
  output: render_job_id / cached status

GET /render/{snapshot_id}/sheets
  output: sheet metadata

GET /render/{snapshot_id}/sheet/{sheet_id}
  output: render JSON

GET /render/{snapshot_id}/sheet/{sheet_id}?range=C10:F30
  output: context-window JSON

GET /render/assets/{asset_id}
  output: image binary

DELETE /render/{snapshot_id}
  cache invalidation
```

Main API는 해당 내부 API를 호출하고 인증/권한/업무 상태는 기존 서비스에서 관리한다.

---

## 12. 현재 코드에서의 변경 방향

현재 코드의 다음 책임을 분리 대상으로 본다.

### `kg/webapp.py`

- `_render_sheet`
- `_render_sheet_drm`
- `/api/sheet`의 실제 workbook 렌더 처리

Main API에는 Render Server 호출과 cache/result 전달만 남긴다.

### `src/inspect/inspector.py`

Workbook 구조 추출 및 openpyxl/COM 렌더 로직은 Render Server의 재사용 가능한 library로 이동하거나 import한다.

### `frontend/src/screens/source/SheetGrid.tsx`

- 전체 셀 DOM 생성 최소화
- Source Region context window 우선
- 전체 sheet는 virtualization 적용 검토
- 이미지 lazy loading

---

## 13. 시스템 정체성과의 관계

Viewer는 제품 자체가 아니다.

이 시스템의 핵심 목적은 보호 문서를 Excel처럼 웹에서 편집하는 것이 아니라:

> **Agent가 사용할 표준 Table 데이터가 어떤 보호 문서의 어떤 원본 위치에서 왔는지 검증 가능하게 만드는 것**

이다.

따라서 Viewer의 우선순위는 다음과 같다.

1. Source provenance 확인
2. Mapping 검수
3. 원본 문맥 가시성
4. 빠른 반복 접근
5. Excel 편집 기능은 비범위

Render Server 분리는 이 목적을 유지하면서 DRM/OpenPyXL의 무거운 처리가 Main Web Service를 죽이지 않게 하는 최소 아키텍처 변경이다.

---

## 14. 결정 사항

- DRM 렌더 캐시는 허용된다고 전제한다.
- Main Web/API Server와 Excel/OpenPyXL Render Server를 분리한다.
- Render Server의 Excel COM 경로는 낮은 동시성으로 운영한다.
- cache miss만 DRM/OpenPyXL 렌더를 수행한다.
- Viewer는 Source Region 중심 검수를 기본으로 한다.
- 전체 Sheet 렌더는 필요할 때만 수행하거나 cache에서 제공한다.
- 최종 목표는 Excel 웹 편집기가 아니라 provenance가 보이는 Document-to-Table 서비스다.
