# v3 프런트엔드 (`frontend/src/v3`)

파싱 스키마 · 파싱 프로파일 런타임의 React 화면. 계약은 `docs/design/v3-contracts.md` §6(API 형태) · §7(화면·표시 규칙·성능 규칙), 기준선은 `docs/design/ui-development-spec.md`, 목업은 `docs/design/assets/ui-approved-mockup.svg`.

규칙 요약
- 모든 API는 `client.ts`의 `api`/`apiRaw`/`useData`/`usePage`를 거친다(GET 60초 캐시 + in-flight 중복 제거, 쓰기 뒤 캐시 무효화 + `writeSeq` 증가 → JobBar 폴링 시작).
- 화면 진입 API 호출 ≤ 3, 목록은 keyset 페이징(`limit=50&cursor=`), 검색은 250ms 디바운스, 쓰기는 낙관적 갱신, 화면은 `React.lazy`, 시트 DOM ≤ 3,000셀.
- 화면 텍스트에 UUID·SHA-256을 쓰지 않는다. 라벨 도우미: `snapshotLabel` · `profileLabel`(`이름 vN`) · `schemaLabel` · `regionLabel`(`Sheet!A1:B2`) · `mappingRevisionLabel` · `jobLabel`.
- 사용자 문구는 한국어, §0 용어(파싱 스키마/필드/파싱 프로파일/파싱 규칙/원본 위치/데이터 빌드/작업 내역)만 쓴다(금지 용어는 `tests/v3-terms.test.tsx`가 검사).
- v2에서는 `../v2/DomainGraph`의 `layoutDomain` · `groupColor` · `GROUP_COLORS`와 타입만 가져온다(`tests/v3-imports.test.tsx`).
- '원본 보기'는 어디서나 `reviewRoute({application_id, rule_key?, sheet_id?, range?})`로 같은 파라미터를 만든다.

## 파일

| 구분 | 파일 | 내용 |
| --- | --- | --- |
| 쉘 | `Workbench.tsx` | 사이드바(주 메뉴 `aria-current="page"`) · 통합 검색(combobox → listbox) · JobBar · 화면 lazy 로딩 · Source Review 오버레이(뒤 화면 `inert`) · 토스트 · 401/403 토큰 폼 |
| 공용 | `client.ts` | API 클라이언트 · 캐시 · `useData`/`usePage`/`Pager`/`State`(로딩·오류·빈 상태) · 라우팅(`useRoute`/`useNavigation`, `reviewRoute`) · `useJob`(POST `?wait=` + `/jobs/{id}` 폴링) · 날짜/라벨 도우미 · 토스트 |
| | `types.ts` | §6 응답·요청 형태 + 라벨 표(`STATUS_*`, `PROFILE_STATUS_*`, `APPLICATION_STATE_*`, `COMPATIBILITY_LABELS`, `JOB_STATE_LABELS`, `JOB_KIND_LABELS`, `QUEUE_LABELS`, `BUILD_REASON_LABELS`, `SEARCH_KIND_LABELS`) |
| | `ui.tsx` | `Heading` · `Chip` · `StatusChip` · `ProfileStatusChip` · `ApplicationStateChip` · `Tabs` · `Modal`(role=dialog, aria-modal, 초점 가두기, Escape) · `EmptyState` · `ZoomControl` |
| | `v3.css` | 모든 스타일(`.v3` 루트 아래, 토큰 `--v3-*`, 1000px 이하 반응형) |
| 시트 | `SheetViewer.tsx`, `sheetGeometry.ts` | 렌더 창(A1:Z60 타일) 뷰어: readonly/review 모드, overlay, 드래그 선택, 202/4xx/503 처리; 순수 기하 함수 |
| 문서 | `Documents.tsx`, `DocumentDetail.tsx`, `DocumentRegister.tsx` | 목록(검색·상태·프로파일 필터·정렬·선택 → 데이터 빌드) · 상세 모달(파일 보기/추출 결과/적용 프로파일/연결 스키마, 다른 프로파일로 파싱) · 등록 대화상자(GET /sources → POST /documents/register) |
| 프로파일 | `Profiles.tsx`, `ProfileDetail.tsx`, `ProfileRules.tsx`, `ProfileImport.tsx`, `profileModel.ts`, `profileDraft.ts` | 목록 + 상세(기본 정보/규칙/필드 매핑/테스트/JSON/변경 이력) · 규칙 편집 폼 · 외부 정의 가져오기/새 프로파일 · 정의 JSON 순수 도우미 · 미저장 정의 초안(sessionStorage `v3.profile.draft`) |
| 스키마 | `Schema.tsx`, `SchemaTree.tsx`, `SchemaGraph.tsx`, `FieldDetail.tsx`, `SchemaTabs.tsx`, `SchemaImport.tsx` | 3열(목록/트리·그래프/필드 상세) · 사용 프로파일/연관 문서/변경 이력 탭 · 새 스키마/새 리비전 가져오기 |
| 데이터 빌드 | `Build.tsx`, `BuildColumns.tsx`, `BuildOutput.tsx`, `buildModel.ts`, `buildDraft.ts` | 5단계(대상 문서/스키마/출력 설정/미리보기/생성) · 컬럼 헤더·순서 편집 · 미리보기·생성·manifest · 초안(sessionStorage `v3.build.draft`, 컬럼 설정 `v3.build.columns`) |
| 작업 내역 | `Jobs.tsx`, `JobsQueue.tsx` | 검수 큐 요약 카드 · 큐 묶음 표(낙관적 묶음 처리, 멤버 펼치기) · 작업 목록(취소·이동) · 3초 폴링 |
| 설정 | `Settings.tsx` | 렌더 서버/Reader/한도/작업 공간 · 정규화 프리셋 · 서버 접근 토큰 |
| Source Review | `SourceReview.tsx`, `SourceReviewMapping.tsx`, `SourceReviewTest.tsx`, `sourceReviewShared.ts` | 전체 화면 오버레이: 시트·파싱 규칙 목록 / review 모드 SheetViewer / 매핑 상세(수정·승인·반려·이력·복원, 409 충돌 복구) 또는 테스트 결과 패널 |

## 라우트 파라미터 (`?screen=…`)

| 화면 | 파라미터 |
| --- | --- |
| 공통 | `screen=documents\|profiles\|schema\|build\|jobs\|settings`, `review=<application_id>` 또는 `test=<profile_id>\|draft&snapshot=<snapshot_id>`(오버레이) + `rule=<rule_key>` `sheet=<sheet_id>` `range=<A1>` |
| documents | `q` `status` `profile_id` `schema_key` `sort=[-]document_name\|status\|last_processed_at` · `document=<id>` `tab=file\|values\|profiles\|schemas` `sheet` |
| profiles | `q` `status=draft\|approved\|deprecated` `schema_key` · `profile=<id>` `tab=info\|rules\|mapping\|test\|json\|history` `rev=<n>` · `import=1&snapshot=<sid>`(작업 내역 큐의 '프로파일 만들기' → 외부 Profile Import 대화상자를 열고 그 snapshot을 테스트 문서로 미리 고른다; 닫으면 두 키를 지운다) |
| schema | `schema=<key>` `view=graph` `tab=profiles\|documents\|history` `field_key=<key>` `field_filter=<key>` |
| build | `step=2..5`(1단계는 파라미터 없음) |
| jobs | `queue=unmatched\|review\|failed\|changed\|conflict` `state` `kind` |

`go(patch)`는 현재 파라미터에 덮어쓰고(빈 값은 제거), `reset(route)`는 전체를 바꾼다(검색 결과 이동 등). Source Review 닫기는 `review·test·rule·range·snapshot`만 지운다.

## 테스트와 픽스처 (`frontend/tests/v3-*`)

`tests/setup.ts`는 `fetch`를 예외로 막아 두므로 모든 테스트는 픽스처로 fetch 목을 설치한다.

- `v3-fixture.ts` — `v3Fixture()`: `resetClient()` + 저장소 초기화 후 `fetch`를 `method + path` 정규식 표로 라우팅한다(§6 표본: 문서 7종 상태, 시트 3개, 렌더 창, 값, 매핑, 프로파일, 스키마 트리/그래프, 작업, 큐, 빌드). 반환값: `ids`(UUID/SHA 형태의 표본 ID), `state`(문서·실행 중 작업·토큰 필요 여부), `calls`(모든 호출 기록), `overrides`(`"GET /path"` → 응답 또는 `reply(status, body)`), `renderApp(url)`(Workbench 렌더), `callsTo(re, method)`, `waitForApi(re, method, count)`. `UUID_RE`/`SHA_RE`로 ID 비노출을 검사한다.
- 화면별 확장 픽스처: `v3-documents-fixture.ts`(GET /sources 트리·등록 결과), `v3-profiles-fixture.ts`(정의 JSON·리비전·import-preview·approve/reparse), `v3-schema-fixture.ts`(트리 3그룹 11필드·그래프·필드 상세·PATCH), `v3-build-fixture.ts`(초안 시드·preview·builds·manifest), `v3-jobs-fixture.ts`(큐 묶음·멤버·묶음 처리·취소), `v3-source-review-fixture.ts`(리비전 쓰기·409 충돌·rollback·approve-all·프로파일 테스트).
- `v3-source-files.ts` — 정적 검사 도우미(`listV3Files`, `stripComments`)와 `settleNetwork(f)`(fetch 목이 조용해질 때까지 대기).
- 규칙 테스트: `v3-terms`(§0 금지 용어, 주석 제외) · `v3-imports`(v2 import 제한) · `v3-ids`(모든 화면·탭·오버레이의 body 텍스트에 UUID/SHA 없음) · `v3-entry-calls`(화면 진입 호출 ≤ 3, 중복 GET 없음, `limit ≤ 50`) · `v3-a11y`(th scope·table aria-label·dialog 속성·nav aria-current·아이콘 버튼 이름).

```sh
cd frontend
npx tsc -b            # 타입 검사(빌드 스크립트와 동일)
npx vitest run        # v2 + v3 전체
npx vitest run tests/v3-documents.test.tsx
npm run build         # tsc -b && vite build → dist/
```
