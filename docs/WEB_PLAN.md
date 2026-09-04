# 웹 프론트 구축 계획 — REST API 기반 경량·재사용 구조

정적 스냅샷 렌더링(현재 Artifact 페이지 방식)은 데이터가 커지면 생성 시간·페이지
크기·갱신 주기 모두 한계가 있다. 이를 **REST API + 경량 프론트**로 전환한다.
설계문서 §12(API 설계)와 §11(UI/UX)을 실행 계획으로 구체화한 문서다.

## 0. 원칙

1. **서버가 자르고, 프론트는 그린다** — 목록은 전부 서버 페이지네이션/필터.
   프론트는 화면에 보이는 만큼만 요청한다. 전체 dump API는 만들지 않는다.
2. **API 계약이 중심** — 화면은 언제든 갈아탈 수 있게(추후 React 등),
   OpenAPI 스키마가 프론트·백 사이의 유일한 계약이다.
3. **projection은 요약, 상세는 지연 로딩** — 온톨로지/KG/허브 요약은 데이터가
   커져도 크기가 고정(개념 수·클래스 수에 비례)이고, 셀 단위 상세는 클릭 시에만.
4. **빌드 파이프라인 없는 프론트** — 순수 ES Module + fetch. 번들러/프레임워크
   없이 파일 몇 개로 배포·재사용 가능하게 유지한다.
5. **읽기와 쓰기 분리** — 조회 API는 무상태 캐시 가능, 쓰기(매핑 승인·재처리)는
   기존 idempotent 파이프라인 함수를 그대로 호출한다.

## 1. 백엔드 — FastAPI (src/api/server.py)

선택 이유: 표준적, pydantic 응답 검증, OpenAPI 문서 자동 생성(=프론트 계약),
기존 `src/api/queries.py` 함수를 얇게 감싸기만 하면 됨.

### 1.1 엔드포인트 (설계문서 §12 매핑)

| Method | Endpoint | 응답 | 비고 |
|---|---|---|---|
| GET | /api/stats | 문서/레코드/관측/매핑률/pending 카운트 | 헤더 스탯 타일 |
| GET | /api/ontology | 도메인→개념 트리 | 크기 고정, 캐시 |
| GET | /api/graph | KG 노드/엣지(+근거 수) | 크기 고정, 캐시 |
| GET | /api/concepts | 개념 목록 `?domain=&q=&page=` | source_count 포함 |
| GET | /api/concepts/{id}/sources | 개념→필드→시트→문서→버전 역추적 `?page=` | §11.1 클릭 역추적 |
| GET | /api/documents | 문서 목록 + current 버전/상태 | |
| GET | /api/documents/{name}/versions | DVC/구조/의미 해시 버전 이력 | §11.4 |
| GET | /api/records | `?type=&lot=&sheet=&page=&size=` | 커서 대신 offset(단순) |
| GET | /api/records/{key} | 레코드 + observation 전체 | 상세 화면 |
| GET | /api/lots | 허브 요약 목록 `?page=` (SQL 집계) | §11.3 |
| GET | /api/lots/{lot} | LOT 상세: 문서 횡단 레코드/개념/출처 | |
| GET | /api/lineage/{concept_id} | `?lot=` 개념 lineage (원시값→표준값→셀) | 패널 6 |
| GET | /api/mapping/pending | 검토 대기 목록 `?page=` | §11.2 리뷰 화면 |
| POST | /api/mapping/decisions | 승인/거절 {field_signature, concept_id, action} | 승인 시 synonym 승격 |
| POST | /api/ingestion/reprocess | {file?} 재처리 트리거 | 기존 Pipeline 호출 |
| GET | /api/jobs | ingestion_job 목록 | 운영 |

공통 응답 형식: `{items, page, size, total}` (목록), 오류는 RFC7807 스타일
`{detail}`. 모든 목록 기본 `size=50, max=500`.

### 1.2 성능 작업 (대량 데이터 전제)

- **N+1 제거**: 현재 `lot_hub_projection`/`knowledge_graph_projection`이
  레코드마다 observation을 재조회한다(레코드 N × 쿼리 1). → GROUP BY 집계
  SQL 한 방으로 재작성. `/api/lots`는 `record GROUP BY business_key`,
  KG 엣지 근거 수는 `record_key별 엔티티클래스 존재여부`를 임시테이블/CTE로.
- **인덱스 추가**: `record(business_key, is_current)`,
  `observation(source_document_version_id)`.
- **projection 캐시**: ontology/graph/stats는 프로세스 내 캐시.
  무효화 키 = `max(document_version.detected_at)` + config 버전
  (semantic cache key와 동일 철학, §5.4).
- **HTTP 캐시**: 조회 응답에 ETag(위 무효화 키 기반) — 프론트 재방문 시 304.
- **gzip** 미들웨어, 응답 필드 최소화(프론트가 쓰는 필드만 pydantic 모델로 고정).

### 1.3 서빙/구성

```
uvicorn src.api.server:app          # 개발
web/ 정적 파일은 FastAPI StaticFiles로 같은 origin에서 서빙 → CORS 불필요
DB: 기본 SQLite(WAL) → 운영 전환 시 schema_postgres.sql + 커넥션만 교체
```

## 2. 프론트 — web/ (빌드 없는 ES Module)

```
web/
├─ index.html            # 앱 셸: 상단 스탯 + 좌측(또는 탭) 내비 6뷰
├─ css/
│  ├─ tokens.css         # 지금 Artifact 페이지의 라이트/다크 토큰을 추출(재사용)
│  └─ app.css
└─ js/
   ├─ api.js             # fetch 래퍼: 베이스URL, 에러 토스트, ETag 캐시, 페이지 헬퍼
   ├─ components/        # 재사용 컴포넌트 (프레임워크 없이 함수형)
   │  ├─ data-table.js   #   서버 페이지네이션 테이블(정렬/검색/페이저 내장)
   │  ├─ chips.js        #   개념 칩/상태 pill
   │  ├─ kg-svg.js       #   지식 그래프 SVG 렌더러(노드/엣지 데이터 주입)
   │  └─ lineage-svg.js  #   lineage 흐름도 렌더러
   └─ views/             # 뷰 = 컴포넌트 조립 + API 호출만
      ├─ ontology.js     # 1. 온톨로지 (GET /api/ontology)
      ├─ graph.js        # 2. KG (GET /api/graph)
      ├─ mapping.js      # 3. 문서→개념 + 검토 대기 승인 (§11.2)
      ├─ units.js        # 4. 단위 정규화 (GET /api/lineage/*)
      ├─ hub.js          # 5. LOT 허브: 목록(페이지) → 클릭 시 상세 lazy
      ├─ lineage.js      # 6. 개념 추적 (concept+lot 선택 → lineage)
      └─ workbook.js     # 7. 레코드/관측 브라우저 (서버 페이지네이션)
```

- **라우팅**: hash 라우터(#/hub/BT26821) 30줄 내외 자체 구현 — 딥링크 가능.
- **재사용성**: 컴포넌트는 DOM 노드를 반환하는 순수 함수
  (`dataTable({columns, fetchPage})`), 다른 프로젝트에 파일 복사만으로 이식 가능.
- **대량화 대응**: 목록 뷰는 페이지당 50행; observation 브라우저는 필터
  (concept/document/LOT) 없이는 조회 불가로 설계해 실수로 전체를 당기지 않게 한다.
- **디자인**: 현 Artifact 페이지의 IBM Plex 토큰/구성을 그대로 이식 — 시안 확정본.

## 3. 단계별 실행

| 단계 | 내용 | 완료 조건 |
|---|---|---|
| W1 | FastAPI 서버 + 조회 API 전체 + 집계 SQL/인덱스/캐시 | TestClient 테스트, 1만 관측치 합성 데이터에서 목록 API < 100ms |
| W2 | 프론트 셸 + 조회 6뷰 (기존 디자인 이식) | 브라우저에서 7문서 실데이터 탐색, 스크린샷 검증 |
| W3 | 쓰기: 매핑 승인(synonym 승격) + reprocess + jobs | 승인 → concepts.yaml 반영 → 재매핑 E2E 테스트 |
| W4 | 운영: Postgres 옵션, ETag/gzip 확인, README 배포 가이드 | dvc/watcher와 동시 구동 검증 |

## 4. 이번에 하지 않는 것

- SPA 프레임워크 도입(React 등) — API 계약이 있으니 필요해지면 뷰만 교체
- 원본 workbook 셀 단위 렌더링(§11.2 좌측 패널) — W3 승인 화면은 우선
  field/근거 목록 기반으로 하고, 셀 렌더링은 후속
- 인증/권한 — 배포 환경 결정 후
