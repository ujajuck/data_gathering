# 프런트엔드 화면 (`frontend/src/app`)

파싱 스키마 · 파싱 프로파일 런타임의 React 화면. 계약은 `docs/design/contracts.md` §6(API 형태) · §7(화면·표시 규칙·성능 규칙), 기준선은 `docs/design/ui-development-spec.md`, 목업은 `docs/design/assets/ui-approved-mockup.svg`.

규칙 요약
- 모든 API는 `client.ts`의 `api`/`apiRaw`/`useData`/`usePage`를 거친다(GET 60초 캐시 + in-flight 중복 제거, 쓰기 뒤 캐시 무효화 + `writeSeq` 증가 → JobBar 폴링 시작).
- 화면 진입 API 호출 ≤ 3(목록과 상세를 한 화면에 함께 그리는 파싱 프로파일 상세만 목록 호출을 더해 4), 목록은 keyset 페이징(`limit=50&cursor=`), 검색은 250ms 디바운스, 쓰기는 낙관적 갱신, 화면은 `React.lazy`, 시트 DOM ≤ 3,000셀.
- 화면 텍스트에 UUID·SHA-256을 쓰지 않는다. 라벨 도우미: `snapshotLabel` · `profileLabel`(`이름 vN`) · `schemaLabel` · `regionLabel`(`Sheet!A1:B2`) · `mappingRevisionLabel` · `jobLabel`.
- 사용자 문구는 한국어, §0 용어(파싱 스키마/필드/파싱 프로파일/파싱 규칙/원본 위치/데이터 빌드/작업 내역)만 쓴다(금지 용어는 `tests/terms.test.tsx`가 검사).
- 이 폴더 바깥에서는 `../product`(제품명)만 가져온다(`tests/imports.test.tsx`). 그래프 배치·색은 폴더 안 `graphLayout.ts`에 있다.
- '원본 보기'는 어디서나 `reviewRoute({application_id, rule_key?, sheet_id?, range?})`로 같은 파라미터를 만든다.

## 파일

| 구분 | 파일 | 내용 |
| --- | --- | --- |
| 쉘 | `Workbench.tsx` | 사이드바(주 메뉴 `aria-current="page"`) · 통합 검색(combobox → listbox) · JobBar · 화면 lazy 로딩 · Source Review 오버레이(뒤 화면 `inert`) · 토스트 · `/status` 실패 시 연결 오류 카드 |
| 공용 | `client.ts` | API 클라이언트(토큰·Authorization 헤더 없음 — 메인 API는 인증하지 않는다) · 캐시 · `useData`/`usePage`/`Pager`/`State`(로딩·오류·빈 상태) · 라우팅(`useRoute`/`useNavigation`, `reviewRoute`) · `useJob`(POST `?wait=` + `/jobs/{id}` 폴링) · 날짜/라벨 도우미 · 토스트 |
| | `types.ts` | §6 응답·요청 형태 + 라벨 표(`STATUS_*`, `PROFILE_STATUS_*`, `APPLICATION_STATE_*`, `COMPATIBILITY_LABELS`, `JOB_STATE_LABELS`, `JOB_KIND_LABELS`, `QUEUE_LABELS`, `BUILD_REASON_LABELS`, `REPARSE_REASON_LABELS`, `SEARCH_KIND_LABELS`) |
| | `ui.tsx` | `Heading` · `Chip` · `StatusChip` · `ProfileStatusChip` · `ApplicationStateChip` · `Tabs` · `Modal`(role=dialog, aria-modal, 초점 가두기, Escape; `dismissible={false}`면 Escape·배경 클릭·`×`가 닫지 않고 `inert`면 위에 뜬 확인 대화상자 뒤로 물러난다) · `EmptyState` · `ZoomControl` |
| | `app.css` | 모든 스타일(`.app` 루트 클래스 아래, 토큰 `--app-*`, 1000px 이하 반응형 — 클래스 이름은 E2E 선택자 계약이라 그대로 둔다) |
| 시트 | `SheetViewer.tsx`, `sheetGeometry.ts` | 렌더 창(A1:Z60 타일) 뷰어: readonly/review 모드, overlay, 드래그 선택, 202/4xx/503 처리; 순수 기하 함수 |
| 문서 | `Documents.tsx`, `DocumentDetail.tsx`, `DocumentRegister.tsx`, `DocumentDelete.tsx` | 목록(검색·상태·프로파일 필터·정렬·선택 → 데이터 빌드·삭제) · 상세 모달(파일 보기/추출 결과/적용 프로파일/연결 스키마, 적용 프로파일 행마다 `다시 파싱`(§4.9 POST /applications/{aid}/reparse?wait=10), 다른 프로파일로 파싱, 삭제) · 등록 대화상자(파일 고르기 GET /sources → POST /documents/register, 폴더 일괄 등록(§4.1.1) GET /sources/scan → POST /documents/register-directory) · 삭제 확인 대화상자(§4.13 DELETE /documents/{id} 단건 · POST /documents/delete 다중, `원본 파일도 함께 지우기`는 기본 해제, 대표 문서 경고·지울 문서 전체 목록·진행 중에는 닫히지 않음·뒤 드로어 inert) |
| 프로파일 | `Profiles.tsx`, `ProfileDetail.tsx`, `ProfileNew.tsx`, `profileModel.ts` | 목록(`+ 새 프로파일` 버튼 하나) + **탭 없는 단일 상세**(요약줄 · 정의 JSON 편집기 · 테스트 팝오버 · 변경 이력) · 새 프로파일 대화상자(빈 골격/붙여넣기/파일 업로드, 형식 자동 판별) · 정의 JSON 순수 도우미 |
| 스키마 | `Schema.tsx`, `SchemaTree.tsx`, `SchemaGraph.tsx`, `graphLayout.ts`, `FieldDetail.tsx`, `SchemaTabs.tsx`, `SchemaEditor.tsx`, `DeleteDialog.tsx` | 3열(목록/트리·그래프/필드 상세) · 사용 프로파일/연관 문서/변경 이력 탭 · 쓰기 행동(`+ 새 스키마`는 생성 전용 · `새 리비전` · `이름 바꾸기` · `폐기`/`폐기 해제`(§4.2.3) · `삭제` · `+ 필드 추가` · 필드 `편집`/`삭제`) · 목록 상태 필터(활성 기본·폐기·전체) · 확인 대화상자와 409 사용 중 거부(`DeleteDialog` — 문서 삭제·스키마 폐기도 같은 틀을 쓴다) |
| 데이터 빌드 | `Build.tsx`, `BuildColumns.tsx`, `BuildOutput.tsx`, `buildModel.ts`, `buildDraft.ts` | 5단계(대상 문서/스키마/출력 설정/미리보기/생성) · 컬럼 헤더·순서 편집 · 미리보기·생성·manifest · 초안(sessionStorage `schema.build.draft`, 컬럼 설정 `schema.build.columns`) |
| 작업 내역 | `Jobs.tsx`, `JobsQueue.tsx` | 검수 큐 요약 카드 · 큐 묶음 표(낙관적 묶음 처리, 멤버 펼치기) · 작업 목록(취소·이동) · 3초 폴링 |
| 설정 | `Settings.tsx` | 렌더 서버/Reader(보안 읽기 어댑터·DRM 설정)/한도/작업 공간 · 정규화 프리셋. 사용자 접근 토큰은 없다(메인 API는 인증하지 않고 기본으로 127.0.0.1에만 열린다) |
| Source Review | `SourceReview.tsx`, `SourceReviewMapping.tsx`, `SourceReviewTest.tsx`, `sourceReviewShared.ts` | 전체 화면 오버레이: 시트·파싱 규칙 목록 / review 모드 SheetViewer / 매핑 상세(수정·승인·반려·이력·복원, 409 충돌 복구) 또는 테스트 결과 패널(저장된 리비전만 테스트한다) |

## 라우트 파라미터 (`?screen=…`)

| 화면 | 파라미터 |
| --- | --- |
| 공통 | `screen=documents\|profiles\|schema\|build\|jobs\|settings`, `review=<application_id>` 또는 `test=<profile_id>&snapshot=<snapshot_id>`(오버레이, 저장된 리비전만) + `rule=<rule_key>` `sheet=<sheet_id>` `range=<A1>` |
| documents | `q` `status` `profile_id` `schema_key` `sort=[-]document_name\|status\|last_processed_at` · `document=<id>` `tab=file\|values\|profiles\|schemas` `sheet` |
| profiles | `q` `status=draft\|approved\|deprecated` `schema_key` · `profile=<id>` `rev=<n>`(그 리비전 JSON을 읽기 전용으로) · `import=1`(작업 내역 큐의 '프로파일 만들기' → `새 프로파일` 대화상자를 연다; 닫으면 지운다). 상세에 탭은 없다 |
| schema | `schema=<key>` `schema_status=deprecated\|all`(기본 활성) `view=graph` `tab=profiles\|documents\|history` `field_key=<key>` `field_filter=<key>` |
| build | `step=2..5`(1단계는 파라미터 없음) |
| jobs | `queue=unmatched\|review\|failed\|changed\|conflict` `state` `kind` |

`go(patch)`는 현재 파라미터에 덮어쓰고(빈 값은 제거), `reset(route)`는 전체를 바꾼다(검색 결과 이동 등). Source Review 닫기는 `review·test·rule·range·snapshot`만 지운다.

## 테스트와 픽스처 (`frontend/tests/`)

`tests/setup.ts`는 `fetch`를 예외로 막아 두므로 모든 테스트는 픽스처로 fetch 목을 설치한다.

- `fixture.ts` — `appFixture()`: `resetClient()` + 저장소 초기화 후 `fetch`를 `method + path` 정규식 표로 라우팅한다(§6 표본: 문서 7종 상태, 시트 3개, 렌더 창, 값, 매핑, 프로파일, 스키마 트리/그래프, 작업, 큐, 빌드). 반환값: `ids`(UUID/SHA 형태의 표본 ID), `state`(문서·실행 중 작업), `calls`(모든 호출 기록), `overrides`(`"GET /path"` → 응답 또는 `reply(status, body)`), `renderApp(url)`(Workbench 렌더), `callsTo(re, method)`, `waitForApi(re, method, count)`. `UUID_RE`/`SHA_RE`로 ID 비노출을 검사한다.
- 화면별 확장 픽스처: `documents-fixture.ts`(GET /sources 트리·등록 결과·GET /sources/scan 미리보기·POST /documents/register-directory 요약·§4.13 문서 삭제 단건/다중), `profiles-fixture.ts`(정의 JSON·리비전·import-preview·approve/reparse), `schema-fixture.ts`(트리 3그룹 11필드·그래프·필드 상세·PATCH/POST 필드·DELETE 스키마·필드와 409 사용 중 거부·§4.2.3 폐기/폐기 해제와 `?status=` 필터), `build-fixture.ts`(초안 시드·preview·builds·manifest), `jobs-fixture.ts`(큐 묶음·멤버·묶음 처리·취소), `source-review-fixture.ts`(리비전 쓰기·409 충돌·rollback·approve-all·프로파일 테스트).
- `source-files.ts` — 정적 검사 도우미(`listAppFiles`, `stripComments`)와 `settleNetwork(f)`(fetch 목이 조용해질 때까지 대기).
- 규칙 테스트: `terms`(§0 금지 용어, 주석 제외) · `imports`(폴더 밖 import 제한) · `ids`(모든 화면·탭·오버레이의 body 텍스트에 UUID/SHA 없음) · `entry-calls`(화면 진입 호출 예산, 중복 GET 없음, `limit ≤ 50`) · `a11y`(th scope·table aria-label·dialog 속성·nav aria-current·아이콘 버튼 이름).

```sh
cd frontend
npx tsc -b            # 타입 검사(빌드 스크립트와 동일)
npx vitest run        # 전체
npx vitest run tests/documents.test.tsx
npm run build         # tsc -b && vite build → dist/
```
