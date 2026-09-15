# 브라우저 E2E 결과 (Semantic Excel Integration)

2026-09-15 UTC 기준 `e2e/specs/` 스위트(계약 `docs/design/contracts.md` §8)의 실제 실행 결과다.
모든 스펙은 가상 문서(openpyxl 생성)만 쓰는 임시 작업 공간에서 돌고, 실제 사용자 작업 공간·원본은 열지 않는다.

## 1. 실행 명령·환경

```bash
# 사전 검사(전부 통과해야 dist가 최신이고 백엔드가 건강하다)
cd frontend && npm run build
cd frontend && npx vitest run
python3 -m pytest tests -q

# 브라우저 E2E
cd e2e && SCHEMA_E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium SCHEMA_E2E_PYTHON=python3 npm test 2>&1 | tee /tmp/run.log

# list reporter 출력을 남긴다. Playwright는 시작할 때 outputDir(test-results/)를 비우므로
# 실행 중에 그 안으로 tee하면 파일이 지워진 inode에 쓰여 남지 않는다 — 실행이 끝난 뒤 옮긴다.
mkdir -p test-results && cp /tmp/run.log test-results/run.log
```

아래 §2~§8의 수치는 모두 **같은 회차**(2회 연속 통과 중 두 번째 실행)의 출력이다. §3은 그 실행의 list reporter 전문이고,
§5는 그 실행이 찍은 `[timing]` 줄이며, 사전 검사 수치도 같은 트리에서 이어서 돌린 결과다.

| 항목 | 값 |
| --- | --- |
| Python | 3.11.15 (FastAPI + uvicorn, openpyxl) |
| Node | v22.22.2 |
| Playwright | 1.63.0 (`@playwright/test`), TypeScript 스펙, `workers: 1`, `fullyParallel: false`, `retries: 0` |
| Chromium | 141.0.7390.37 (`SCHEMA_E2E_CHROMIUM_PATH`), viewport 1600×1100 |
| 메인 API/UI | 127.0.0.1:8031 (`SCHEMA_E2E_PORT`), `schema.api.create_app` + `frontend/dist` |
| 렌더 서버 | 127.0.0.1:8032 (`SCHEMA_E2E_RENDER_PORT`), `python -m schema render-serve` **별도 프로세스** — 메인은 `SCHEMA_RENDER_URL`로 http 모드 사용 |
| 러너 제어 서버 | 127.0.0.1:18031 (`SCHEMA_E2E_CONTROL_PORT`, 기본 메인 포트+10000) — `POST /reset`으로 스펙 파일마다 새 작업 공간 |
| 작업 공간 | 스펙 파일마다 새 임시 폴더에 `examples/demo/demo.py`의 `seed()`(스키마 1 · 프로파일 1 · 문서 6 · 이미지 시트 1) |
| 브라우저 오류 | 모든 스펙이 `pageerror`·`console.error`(favicon 제외)를 모아 마지막에 비어 있음을 단언 |

Playwright `webServer`는 `e2e/serve.py` 한 프로세스다. 이 프로세스는 작업 공간을 시드한 뒤 렌더 서버(8032)와 메인 서버(8031)를
자식 프로세스로 띄우고, 제어 포트(18031)에서 `POST /reset`을 받으면 새 임시 폴더를 시드하고 두 서버를 다시 띄운다.
각 스펙 파일은 `test.beforeAll`에서 `helpers.resetWorkspace()`를 불러 시드 상태에서 시작한다(리셋 1회 3.0–3.1초 × 8회, §3 로그의 `reset → generation` 줄).
스펙 파일 안의 test()들은 같은 작업 공간을 순서대로 쓴다(등록 → 검수 → 발행 흐름).

## 2. 결과 요약

| 항목 | 값 |
| --- | --- |
| 스펙 파일 | 8 (`build` · `documents` · `jobs` · `profiles` · `register-directory` · `render-isolation` · `schema` · `source-review`) |
| test() | 26 (문서 삭제 §4.13 3개 · 스키마 폐기 §4.2.3 1개를 이번 회차에 추가) |
| 통과 / 실패 / 건너뜀 / flaky | **26 / 0 / 0 / 0** |
| 소요 | Playwright 보고 `26 passed (2.8m)` (시드·서버 기동·리셋 8회 포함) |
| 안정성 | 최종 트리에서 3회 연속 전체 통과 — `26 passed (2.8m)` · `26 passed (2.8m)` · `26 passed (2.9m)`. 재시도 0(`retries: 0`). §3·§5는 **두 번째 실행**의 출력 그대로다(로그 원본을 남기려면 §1 마지막 명령으로 `e2e/test-results/run.log`에 옮긴다 — 그 폴더는 `.gitignore` 대상이라 저장소에는 들어가지 않는다) |

같은 트리에서 사전 검사도 이어서 돌렸다: `cd frontend && npm run build` 성공(`✓ built in 1.74s`),
`cd frontend && npx vitest run` **Test Files 15 passed (15) · Tests 177 passed (177)**,
저장소 루트 `python3 -m pytest tests -q -p no:cacheprovider` **299 passed, 2 warnings, 50 subtests passed in 54.04s**.

## 3. list reporter 출력 전문

`[WebServer]` 줄은 러너의 제어 로그(스펙 파일마다 한 번의 리셋), `[timing]` 줄은 render-isolation 스펙이 측정한 값이다.

```text
> test
> playwright test --config=playwright.config.ts

[WebServer] [e2e-control] generation 1 · workspace schema-e2e-fuo1946r · main 8031 · render 8032 · control 18031

Running 26 tests using 1 worker

[WebServer] [e2e-control] reset → generation 2 · workspace schema-e2e-hj9n553z · 3014 ms
  ✓   1 specs/build.spec.ts:91:1 › 문서 인계 · 제외 사유 · 스키마 · 출력 Header 편집 · 미리보기/원본 보기 · CSV/XLSX/SQLite · manifest · 새 빌드 (7.2s)
[WebServer] [e2e-control] reset → generation 3 · workspace schema-e2e-8lzgh4hl · 3059 ms
  ✓   2 specs/documents.spec.ts:35:1 › 쉘 · 문서 표 · 상태 칩 · 필터 · 정렬 (3.3s)
  ✓   3 specs/documents.spec.ts:156:1 › 문서 등록 대화상자 · 상세 드로어(파일 보기·추출 결과·적용 프로파일·연결 스키마) · 잠긴 문서 (8.2s)
  ✓   4 specs/documents.spec.ts:379:1 › 새 snapshot(변경 감지) · Snapshot 이력 · 다중 선택 → 데이터 빌드 (4.4s)
  ✓   5 specs/documents.spec.ts:491:1 › 문서 삭제 — 다중 선택 확인 대화상자 · 원본 보존 · 목록에서 사라짐 · 같은 파일 재등록 (3.2s)
  ✓   6 specs/documents.spec.ts:561:1 › 문서 삭제 — 단건(상세 드로어) · 원본 파일까지 · 대표 문서 프로파일 초안 · 작업 내역 (3.0s)
  ✓   7 specs/documents.spec.ts:633:1 › 문서 삭제 거부 — 없는 문서 404 · 빈 목록 422 · 상한 초과 422 (241ms)
[WebServer] [e2e-control] reset → generation 4 · workspace schema-e2e-1ror05z6 · 3068 ms
  ✓   8 specs/jobs.spec.ts:71:1 › 요약 카드 · 신규 양식/매핑 검수/파싱 실패 큐 · 렌더 서버 상태 · 작업 목록 (3.9s)
  ✓   9 specs/jobs.spec.ts:267:1 › 매핑 검수 전체 승인 → 문서 정상 · 큐 0 · 묶음 처리 작업 행 (2.6s)
  ✓  10 specs/jobs.spec.ts:307:1 › 새 snapshot(변경 감지) 큐 → 동일 승계 전체 승인 → 정상 · 변경 감지 0 (3.7s)
  ✓  11 specs/jobs.spec.ts:380:1 › 실패한 등록 작업 행(오류 문구 · 이동 → 문서 드로어) · 재파싱이 도는 동안 JobBar '진행 중 작업' (21.1s)
[WebServer] [e2e-control] reset → generation 5 · workspace schema-e2e-zauz9jer · 3050 ms
  ✓  12 specs/profiles.spec.ts:71:1 › 목록 · 상태 필터 · 탭 없는 단일 상세(요약줄 · 정의 JSON · 변경 이력) · 대표 문서 지정 · 내보내기 (7.6s)
  ✓  13 specs/profiles.spec.ts:240:1 › + 새 프로파일 하나로: 빈 골격 · v1 파싱 템플릿 붙여넣기(형식 판별 · 경고) → 저장 → 초안 프로파일 (2.8s)
  ✓  14 specs/profiles.spec.ts:369:1 › 정의 JSON 편집 → 새 리비전 저장 → 테스트 팝오버 → Source Review(테스트 모드) · 재파싱(fill) (9.2s)
[WebServer] [e2e-control] reset → generation 6 · workspace schema-e2e-rz3wiznt · 3037 ms
  ✓  15 specs/register-directory.spec.ts:52:1 › 폴더 일괄 등록: 미리보기 → 4개 등록 → 재스캔(변경 없음) → 다시 읽기 → 값 변경(변경 감지) (4.8s)
  ✓  16 specs/register-directory.spec.ts:163:1 › API: 폴더 경로 검증(422 INVALID_SOURCE · 404) · 작업 라벨 (1.2s)
[WebServer] [e2e-control] reset → generation 7 · workspace schema-e2e-61gn444q · 3072 ms
[timing] first render (open drawer → cells visible, 공정 기록): 1151 ms
[timing] first render polling round-trips (202 count): 1 responses
[timing] cached re-access (close → reopen drawer, in-memory client cache): 248 ms
[timing] cached re-access (after reload → open drawer → cells visible, render-server cache): 278 ms
[timing] cached window GET (200): 14 ms
[timing] cached window GET with If-None-Match (304): 12 ms
[timing] first render (image sheet 첨부 → cells visible): 958 ms
[timing] render asset GET (200 image/png): 11 ms
  ✓  17 specs/render-isolation.spec.ts:72:1 › 첫 렌더(별도 렌더 서버) · 캐시 재접근 < 1초 · ETag/304 · Cache-Control · 이미지 asset (5.4s)
[timing] register heavy document (2000x90): 1796 ms
[timing] render request → 202 (uncached heavy sheet): 11 ms
[timing] documents list during render (5 samples, max): 9 ms
[timing] documents list during render (5 samples, mean): 8 ms
[timing] navigate 문서 → 파싱 스키마 during render: 398 ms
[timing] heavy sheet render (202 → 200, 2000x90): 2799 ms
[timing] heavy sheet tail window GET (cached): 39 ms
  ✓  18 specs/render-isolation.spec.ts:233:1 › 격리: 큰 시트를 렌더하는 동안 문서 목록 API < 500ms · 화면 이동 가능 (8.1s)
[timing] documents list baseline (10 samples, mean): 9 ms
[timing] documents list baseline (10 samples, max): 22 ms
[timing] documents list baseline (10 samples, min): 7 ms
[timing] summary
  first render (open drawer → cells visible, 공정 기록): 1151 ms
  first render polling round-trips (202 count): 1 responses
  cached re-access (close → reopen drawer, in-memory client cache): 248 ms
  cached re-access (after reload → open drawer → cells visible, render-server cache): 278 ms
  cached window GET (200): 14 ms
  cached window GET with If-None-Match (304): 12 ms
  first render (image sheet 첨부 → cells visible): 958 ms
  render asset GET (200 image/png): 11 ms
  register heavy document (2000x90): 1796 ms
  render request → 202 (uncached heavy sheet): 11 ms
  documents list during render (5 samples, max): 9 ms
  documents list during render (5 samples, mean): 8 ms
  navigate 문서 → 파싱 스키마 during render: 398 ms
  heavy sheet render (202 → 200, 2000x90): 2799 ms
  heavy sheet tail window GET (cached): 39 ms
  documents list baseline (10 samples, mean): 9 ms
  documents list baseline (10 samples, max): 22 ms
  documents list baseline (10 samples, min): 7 ms
  ✓  19 specs/render-isolation.spec.ts:331:1 › 문서 목록 API 지연 기준선(10회) (1.2s)
[WebServer] [e2e-control] reset → generation 8 · workspace schema-e2e-7t8s1i5v · 3043 ms
  ✓  20 specs/schema.spec.ts:62:1 › 스키마 목록 · 상세 헤더 · 트리/그래프 토글 · 필드 상세 · 사용 프로파일/연관 문서 추적 · 필드에서 Source Review (6.9s)
  ✓  21 specs/schema.spec.ts:367:1 › 필드 편집(alias 추가 → PATCH → 새 리비전) · 변경 이력 (3.0s)
  ✓  22 specs/schema.spec.ts:476:1 › 새 스키마 생성(생성 전용) · 같은 키 재생성 거부 · 필드 추가/삭제 · 사용 중 필드·스키마 삭제 거부 (6.2s)
  ✓  23 specs/schema.spec.ts:660:1 › 스키마 폐기 → 목록 기본(활성)에서 사라짐 → 상태 필터 · 새 프로파일/데이터 빌드 선택에서 빠짐 → 폐기 해제 (5.3s)
[WebServer] [e2e-control] reset → generation 9 · workspace schema-e2e-l41ooesx · 3064 ms
  ✓  24 specs/source-review.spec.ts:84:1 › 검수 화면: 컨텍스트 · 시트/규칙 목록 · 실제 셀 · overlay · 확대 · 셀 이동 → 드래그 재지정 · 승인(요청 1회) · 모두 승인 · 이력/복원 · 반려 · 역방향 조회 (9.7s)
  ✓  25 specs/source-review.spec.ts:384:1 › 창 요청: 60행·26열을 넘는 문서를 스크롤하면 뷰어가 두 번째 창(A61:… / AA…)을 요청해 그린다 (3.1s)
  ✓  26 specs/source-review.spec.ts:435:1 › 잠긴 문서: 드로어 파일 보기는 Snapshot 없음 안내, 등록 뒤 잠긴 원본은 뷰어 안에서만 DRM 실패 + 다시 시도 — 나머지 화면은 정상 (4.0s)

  26 passed (2.8m)
```

## 4. ui-development-spec §10 완료 조건 → 스펙 → 검증 방법

| 영역 | 완료 조건 | 스펙 | 검증 방법(실제 단언) | 결과 |
| --- | --- | --- | --- | --- |
| Navigation | 제품명 `Semantic Excel Integration` | documents #1 | `<title>`과 사이드바 `.app-brand strong` 텍스트가 정확히 일치 | pass |
| Navigation | 메뉴 순서 문서 → 파싱 프로파일 → 파싱 스키마 → 데이터 빌드 → 작업 내역 | documents #1 (+ 모든 스펙의 `openScreen`) | `navigation[name=주 메뉴]`의 버튼 텍스트 배열이 정확히 그 순서; 이동 뒤 `aria-current=page` | pass |
| Parsing Schema | 하나의 화면 | schema #1 | `?screen=schema` 한 화면 안에 목록 · 상세 헤더(새 리비전 · 이름 바꾸기 · 삭제) · 탭(구조 보기/사용 프로파일/연관 문서/변경 이력) · 필드 상세 영역이 함께 렌더 | pass |
| Parsing Schema | 새 스키마는 만들기 전용(덮어쓰지 않는다) | schema #3 | `새 스키마` → 정의 JSON 붙여넣기 → `가져오기` → 토스트 `임시 검증 스키마 v1 저장됨` · 목록 2건; 같은 키로 다시 만들면 409 `SCHEMA_EXISTS`와 문구 `이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요.`가 대화상자에 그대로 뜨고, 리비전 수·이름은 그대로(아무것도 쓰지 않는다) | pass |
| Parsing Schema | 필드 추가·삭제가 된다 | schema #3 | `+ 필드 추가`의 타입 목록이 계약 어휘(`text/decimal/boolean/date/datetime/group`)와 일치 → 201 응답이 **필드 상세**(`schema.rev = 2`) → 필드 상세에서 `삭제` → 모달 `'임시 필드' 필드를 지운 새 리비전을 저장합니다.` → `{current_rev: 3, fields_remaining: 2}` · 토스트 `'임시 필드' 필드를 지웠습니다 · v3` · 트리 2개 · 그 필드 GET 404 | pass |
| Parsing Schema | 쓰는 곳이 있으면 지우지 않는다 | schema #3 | 자식 있는 필드 → 409 `FIELD_HAS_CHILDREN`(하위 필드 7개 목록 + `하위 필드 보기` → 첫 하위 필드로 이동), 규칙·추출값이 쓰는 필드 → 409 `FIELD_IN_USE`(프로파일·규칙 근거 + `사용 프로파일 보기` → 사용 프로파일 탭), 프로파일이 쓰는 스키마 → 409 `SCHEMA_IN_USE`(`profile_count 1 · document_count 4`). 세 경우 모두 모달이 열린 채 서버 문구를 보이고 리비전·필드는 그대로 | pass |
| Parsing Schema | 정의는 지우지 않고 폐기한다(§4.2.3) | schema #4 | 상세 머리에 상태에 따라 `폐기`\|`폐기 해제` 버튼이 **하나만**; `폐기` → 확인 대화상자 `'공정 데이터 표준'을(를) 폐기합니다. 새 파싱 프로파일을 이 스키마에 만들 수 없게 되고 목록 기본에서 숨습니다. 이미 있는 프로파일·적용 건·추출값은 그대로이며 언제든 '폐기 해제'할 수 있습니다.` → 200 응답이 `GET /schemas/{key}`와 **완전히 같은 본문**(`status: deprecated` · `application_count` · `fields[]`, 두 응답 `toEqual`) → 칩 `폐기`(.muted) · 안내 한 줄 · 버튼이 `폐기 해제`로; 프로파일 1건·적용 문서는 그대로 | pass |
| Parsing Schema | 폐기하면 새로 붙일 곳에서 빠진다 | schema #4 | 목록 기본(활성) `스키마 목록 (0)`, 상태 필터 `활성·폐기·전체` 중 `폐기` → 1건(칩 `폐기`); `GET /schemas` 0건 · `?status=deprecated` 1건 · `?status=all` 1건; `새 프로파일` 대화상자의 `파싱 스키마` 선택지가 `["스키마 없음"]`; 데이터 빌드 2단계 선택지가 `["선택하세요"]`; `POST /profiles` → 422 `SCHEMA_DEPRECATED`(`폐기된 파싱 스키마에는 새 프로파일을 만들 수 없습니다. 스키마 상세에서 '폐기 해제'한 뒤 다시 시도하세요.`, 프로파일 수 불변) | pass |
| Parsing Schema | 폐기는 되돌릴 수 있다 | schema #4 | `폐기 해제`는 확인 대화상자 없이 바로 `POST /schemas/{key}/activate`(`page.getByRole("dialog")` 0개) → 토스트 · 칩 `활성` · 안내 줄 사라짐 · 기본 목록 `스키마 목록 (1)` · `새 프로파일` 선택지 복귀; 같은 상태를 두 번 요청하면 409 `ALREADY_ACTIVE`(`이미 활성 상태인 스키마입니다.`) / `ALREADY_DEPRECATED`(`이미 폐기된 스키마입니다.`), 없는 키는 404 `UNKNOWN_SCHEMA` | pass |
| Parsing Schema | 아무도 안 쓰면 지워진다 | schema #3 | 임시 스키마 `삭제` → `'임시 검증 스키마'과(와) 필드 2개를 지웁니다. 되돌릴 수 없습니다.` → 200 `{deleted{fields: 2, revisions: 3}}` · 토스트 · 목록 1건 · `GET /schemas/e2e_temp` 404 | pass |
| Parsing Schema | Tree / Graph 토글 | schema #1 | `트리 보기`/`그래프 보기` 버튼 `aria-pressed`, 트리 treeitem 14개(그룹 3 + 필드 11), 그래프 SVG 노드 14 · 간선 12(parent_of 11 + related_to 1 점선), `?view=graph` URL, 확대 select | pass |
| Parsing Schema | Field 선택 시 상세 | schema #1 | 트리 클릭/Enter·그래프 노드 클릭 → `?field_key=temperature`, 필드 상세에 영문명·decimal·°C·alias 칩·부모 그룹·관련 필드 | pass |
| Parsing Schema | 사용 Profile과 실제 문서까지 추적 | schema #1 | `사용 프로파일 1개 보기 ›` → 사용 프로파일 탭 행 `[공정데이터_A양식 · v1 · temperature · 4 · 승인]`; `연관 문서 보기 ›` → 문서 3건 행(프로파일 v1 · Snapshot · 정상) → `원본 보기` → Source Review에서 실제 셀(C8='온도')과 overlay | pass |
| Parsing Profile | 탭 없는 한 화면 | profiles #1 | 상세 안에 `tablist`가 0개이고 규칙 카드·필드 매핑 표·적용 문서 표가 모두 없음 + 요약줄(연결 스키마 · 대표 문서 · 적용 문서) · 정의 JSON 편집기 · 변경 이력이 한 화면에 함께 렌더 | pass |
| Parsing Profile | Profile → Schema Field 연결 | profiles #1·#3 | 요약줄의 `연결 스키마`, 정의 JSON의 `schema_key`와 규칙 11개(`rule_key` 배열), 테스트 모드 패널의 `필드` 줄(`온도 · decimal · °C`) | pass |
| Parsing Profile | 만들기 버튼은 하나 | profiles #2 | 목록에 `외부 Profile Import` 버튼 0개 · `+ 새 프로파일` 1개; 대화상자 안에서 빈 골격/붙여넣기·파일 업로드를 라디오로 고르고 형식 자동 판별(`v1-parsing-template` · 경고 2)까지 한 자리에서 | pass |
| Parsing Profile | 저장 전 초안은 테스트하지 않는다 | profiles #2 | 대화상자에 `대표 문서로 테스트` 버튼과 `테스트 문서` 목록이 없고 안내는 `저장한 뒤 상세 화면에서 문서를 골라 테스트하세요.` | pass |
| Parsing Profile | 정의를 고쳐 새 리비전 | profiles #3 | 편집기에서 `description` 변경 → 상태 줄 `저장되지 않은 변경이 있습니다.` · 검증 `오류 없음` → `저장(새 리비전)` → `PUT /profiles/{id}` → 토스트 `공정데이터_A양식 v2 저장됨` · 머리 v2 · 변경 이력 2줄 · r1은 읽기 전용(`readonly`, 저장 비활성) · 승인 상태와 대표 문서(기준 v1) 유지 | pass |
| Parsing Profile | 실제 파일 테스트 | profiles #3 | 머리의 `테스트` → 팝오버(적용 문서 라디오 4개 · 문서 검색) → `테스트 실행` → `POST /profiles/{id}/test {snapshot_id}` → Source Review(테스트 모드) 열림, 컨텍스트가 저장된 현재 리비전 `공정데이터_A양식 v2` | pass |
| Parsing Profile | Source Region overlay로 추출 위치 확인 | profiles #3, source-review #1 | 테스트 모드 overlay(역할 main/common, 영역 버튼)와 검수 overlay(`키` C11 · `값` C12:C71 · `단위` 공통 정보!B1)의 라벨·범위·셀 좌표 일치(±6px) | pass |
| Parsing Profile | 대표 문서 승인 진입점 | profiles #1 | 요약줄 `대표 문서 지정` → 팝오버에 매핑을 모두 승인한 비대표 적용 건 2건(`동일 · 검수 11/11`)과 `이 문서로 승인` | pass |
| Settings | 사용자 접근 토큰이 없다 | documents #1 | 설정 화면에 `서버 접근` 영역·`접근 토큰` 입력·`저장` 버튼이 0개, `GET /settings` 응답에 `access_token_required` 키 없음. 어떤 스펙도 `Authorization` 헤더나 토큰 저장소를 쓰지 않는다(브라우저 오류 0으로 전 화면 통과) | pass |
| Settings | Reader 카드가 무엇을 설정해야 하는지 알려 준다 | documents #1 | `Reader` 카드 칩 `연결 안 됨` + 안내 `보호된 문서를 읽으려면 서버에 SCHEMA_READER_FACTORY를 설정하고 python -m schema drm-probe로 확인하세요.` + `이 서버는 기본으로 127.0.0.1에만 열립니다.`, `GET /settings`의 `reader.drm.available = false` | pass |
| DRM | 보호 문서 문구가 무엇을 설정해야 하는지 말한다 | documents #1·#2, jobs #1·#4, source-review #3 | 상태 칩 title·드로어 `최근 오류`·작업 오류 문구·렌더 403 본문이 모두 `보호된 문서입니다. 서버에 보안 읽기 어댑터(SCHEMA_READER_FACTORY)를 설정하면 읽을 수 있습니다 — 설정 화면의 Reader 카드에서 연결 상태를 확인하세요.` | pass |
| Data Build | 여러 문서 선택 | build #1, documents #3 | 문서 화면 다중 선택 2·3건 → 토스트 `N개 문서 · 데이터 빌드로 이동 ›` → 1단계 입력 문서 N개, candidates 제외 사유 표시 | pass |
| Data Build | Schema Field 선택 | build #1 | 2단계 `파싱 스키마` combobox 선택 → 필드 11개 · 값 있는 문서 수 3, 단위 툴팁(`단위 °C`) | pass |
| Data Build | 출력 Header 직접 편집 | build #1 | 3단계 `{필드명} 출력 Header` textbox 값 변경(온도→온도_C, 압력→압력_bar), 중복 시 `중복된 출력 Header입니다.`·빈 값 시 `출력 Header를 입력하세요.`로 다음 단계 비활성 | pass |
| Data Build | 컬럼 순서 변경 | build #1 | `온도 위로` 클릭 → 순서 배열이 EXPECTED_HEADERS와 일치, 첫/마지막 행의 위로/아래로 버튼 비활성 | pass |
| Data Build | Preview 후 CSV/XLSX/SQLite 생성 | build #1 | 미리보기 표 셀 = `POST /builds/preview` 값; CSV 다운로드 파일 헤더·행 수 파싱(csv), XLSX 헤더(openpyxl), SQLite `data` 표 행 수·컬럼(sqlite3); manifest 카드; build_key 재사용(`reused: true`) | pass |
| Data Build | Preview 값에서 원본으로 이동 | build #1 | `온도_C 1행 원본 보기`(title `공정 기록!C9`) → `?review=&rule=temperature&sheet=&range=C9` → Source Review overlay 2개(키 C8 · 값 C9:C68)가 셀 위에 정렬, 뒤 화면 inert | pass |
| Document | 루트 폴더 하나를 UI에서 지정 → 하위 파일 전부 등록(사용자 요구 · §4.1.1) | register-directory #1 | 등록 대화상자 → 폴더 행 `📁 일괄` → `이 폴더 전체 등록` → 미리보기 `일괄/ 아래 파일 4개 · 하위 폴더 2개` · 칩 `새 파일 4 / 변경된 문서 0 / 변경 없음 0 / 잠김 0` · `건너뜀: 임시 파일 1 · 지원하지 않는 파일 1` → `4개 등록 시작` → 요약 `4개 중 4개 등록 · 0개 변경 없음 · 0개 실패` · 결과 표 4행(`완료` · `공정데이터_A양식 · 동일` · 상태 `정상` 3 / `없음` · `프로파일 없음` 1, 실패 사유 빈칸) → 닫기 → 문서 목록 6 + 4건(하위 폴더 파일 포함), 대화상자 어디에도 UUID 없음 | pass |
| Document | 재실행이 싸다(변경 없는 파일 건너뜀) | register-directory #1 | 등록 직후 `GET /sources/scan?directory=일괄` → `{folders: 2, files: 4, targeted: 0, states{unchanged: 4}, skipped{temp: 1, unsupported: 1, symlink: 0}}`; 폴더 행 `일괄 전체 등록` → 칩 `변경 없음 4`·`새 파일 0`, 주 행동이 `0개 등록 시작`으로 비활성 + `등록할 새 파일이나 변경된 문서가 없습니다.`; 체크박스 `변경 없는 문서·잠긴 문서도 다시 읽기` → `4개 등록 시작` → `4개 중 4개 등록 · 4개 변경 없음 · 0개 실패`(문서 수 불변) | pass |
| Document | 값이 바뀐 파일만 다시 읽는다 | register-directory #1 | 하위 폴더 복사본 1개의 값 변경(`mutate_document`) → 스캔 칩 `변경된 문서 1` · `변경 없음 3` → `1개 등록 시작` → `1개 중 1개 등록 · 3개 변경 없음 · 0개 실패` · 결과 표 1행 상태 `변경 감지` → 문서 목록에서 그 행만 `변경 감지`, 나머지는 `정상` | pass |
| Document | 폴더 경로 검증 · 작업 라벨 | register-directory #2 | API `GET /sources/scan`·`POST /documents/register-directory`에 `..`·`일괄/../..`·`/etc` → 422 `INVALID_SOURCE`, 없는 폴더 → 404 `SOURCE_NOT_FOUND`, 알 수 없는 provider → 422 `UNKNOWN_PROVIDER`(문서 행 증가 0); `GET /jobs?kind=register` 첫 행 = `{state: succeeded, target_kind: workspace, label: "일괄 폴더 일괄 등록"}`, 같은 라벨 3건(오류 요청은 작업을 만들지 않는다) | pass |
| Document | 문서는 진짜로 지운다(§4.13) — 다중 선택 | documents #4 | 체크박스 2건 → 선택 바 `[선택 해제, 데이터 빌드에 추가, 삭제]` · `2개 선택` → `삭제` → 대화상자 `문서 삭제`(본문 `문서 2개를 지웁니다. 각 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.` + 지울 문서 이름 목록) → `취소`는 아무것도 지우지 않음(문서 7건 그대로) → 다시 `삭제` → `POST /documents/delete {document_ids, purge_source:false}` → 토스트 `문서 2개를 지웠습니다.` · 표 8행→6행 · `GET /documents` 7→5 · 지운 id는 404 | pass |
| Document | 원본 파일은 기본으로 남는다 | documents #4 | 대화상자의 `원본 파일도 함께 지우기 (data/raw)` 체크박스가 **기본 해제**이고 보조 줄 `체크하지 않으면 원본 파일은 그대로 남고, 다시 등록하면 같은 문서가 만들어집니다.`; 삭제 뒤 `<ws>/data/raw`의 두 파일이 그대로 있고(파이썬으로 파일 존재 확인), 같은 파일을 다시 등록하면 상태 `정상` · 프로파일 v1이 다시 붙은 **새 document_id**로 들어온다(지운 id는 돌아오지 않는다) | pass |
| Document | 원본까지 지우는 선택지 · 대표 문서 · 작업 내역 | documents #5 | 상세 드로어 머리의 `삭제` → 같은 대화상자(단건 문구 `'공정데이터_2024_01.xlsx'을(를) 지웁니다. …`) → 체크박스를 켜면 `DELETE /documents/{id}?purge_source=true` → 드로어 닫힘 · `?document=` 사라짐 · 원본 파일 사라짐; 토스트가 `문서 1개를 지웠습니다. 원본 파일 1개도 지웠습니다. 파싱 프로파일 1개가 초안으로 내려갔습니다 — 대표 문서를 다시 지정해 승인하세요.` → `파싱 프로파일 열기` → 목록 상태 칩 `초안`, `GET /profiles/{id}`의 `status: draft` · `reference` 없음; 작업 내역 `종류=삭제` 2행 `[<문서명> 삭제, 문서 2개 삭제]`(이동 버튼 없음)과 `GET /jobs?kind=delete`의 `target_kind: workspace` · `target_id: null` · `summary{requested:1, deleted:1, failed:0}` · `profiles_reset[{profile_id, profile_name}]` | pass |
| Document | 되돌릴 수 없는 일의 사거리를 묶는다 | documents #6 | 없는 문서 `DELETE` → 404 `UNKNOWN_DOCUMENT`; `POST /documents/delete {document_ids: []}` → 422 `VALIDATION_ERROR`; 201개 → 422 `TOO_MANY_DOCUMENTS`(`한 번에 최대 200개까지 지울 수 있습니다. 나누어 지우세요.`); 세 거부 뒤 문서 수 불변 | pass |
| Document | 문서 → Profile → Schema 관계 | documents #2 | 드로어 관계 카드 `문서 · 파싱 프로파일 · 파싱 스키마`, 적용 프로파일 탭(v1 · 발행 · 호환 · 검수 11/11), 연결 스키마 카드 `프로파일 … 경유 · 파싱 스키마 화면에서 구조 보기 ›` | pass |
| Source Review | 실제 Excel 형태 | source-review #1·#2, render-isolation #1 | 뷰어 셀 텍스트(`A1='온도 단위'`, C8='온도' 등)를 실제 렌더 결과로 단언, 60행×26열을 넘으면 두 번째 창(A61:… / AA…) 요청, 이미지 시트 asset(png) | pass |
| Source Review | Key/Value/Unit/Context overlay | source-review #1 | overlay 라벨 `키`·`값`·`단위`, 역할 버튼 `["키","값","단위","문맥"]`, 범례에 `키` | pass |
| Source Review | 파싱 근거와 원본 위치를 동시에 확인 | source-review #1 | 우측 패널 dl `[필드, 파싱 규칙, 관찰된 키, 추출값, 원본 위치, 상태]` + 원본 위치 버튼 `키: 공정 기록!C11 · 값: …!C12:C71 · 단위: 공통 정보!B1` 클릭 → `?range=` 초점, 드래그 재지정 → `원본 위치 변경됨` → 승인(요청 1회) | pass |

## 5. 측정 시간 (render-isolation 스펙, §3 실행의 `[timing]` 값)

| 측정 | 값 | 기준 |
| --- | --- | --- |
| 첫 렌더(드로어 열기 → 셀 표시, 공정 기록) | 1151 ms | 202 폴링 1회 |
| 첫 렌더 202 응답 수 | 1 responses | — |
| 캐시 재접근(드로어 닫고 다시 열기, 클라이언트 메모리 캐시) | 248 ms | < 1초 (네트워크 요청 0) |
| 캐시 재접근(새로고침 뒤 드로어 → 셀 표시, 렌더 서버 캐시) | 278 ms | < 1초 (200만, 202 없음) |
| 캐시된 창 GET (200) | 14 ms | — |
| 캐시된 창 GET + If-None-Match (304) | 12 ms | ETag 일치 → 304, `Cache-Control: private, no-cache` |
| 첫 렌더(이미지 시트 첨부 → 셀 표시) | 958 ms | 이미지는 별도 asset |
| 렌더 asset GET (200 image/png) | 11 ms | — |
| 큰 문서 등록(2000×90 셀, wait=30 작업) | 1796 ms | — |
| 캐시 안 된 큰 시트 렌더 요청 → 202 | 11 ms | 절대 렌더 완료를 기다리지 않음 |
| 렌더 중 문서 목록 API (5회 최대) | 9 ms | < 500 ms |
| 렌더 중 문서 목록 API (5회 평균) | 8 ms | — |
| 렌더 중 화면 이동 문서 → 파싱 스키마 | 398 ms | 막히지 않음 |
| 큰 시트 렌더 완료(202 → 200, 2000×90) | 2799 ms | truncated false (§5 상한 200,000셀 미만) |
| 큰 시트 마지막 창 GET(캐시) | 39 ms | — |
| 문서 목록 API 기준선(10회 평균 / 최대 / 최소) | 9 / 22 / 7 ms | — |

다른 스펙에서 관찰한 값(단언 대상은 아니며 참고용):

| 측정 | 값 |
| --- | --- |
| 작업 공간 리셋(시드 + 렌더/메인 서버 재기동) | 3.01–3.07초 × 8회 (§3 로그의 `reset → generation` 8줄) |
| `POST /applications/{id}/approve-all?wait=20` (값 88개 추출 포함) | 인라인 완료 |
| `POST /profiles/{id}/reparse?wait=10` (fill, 시드 4문서 전부 건너뜀) | 인라인 완료 |
| `POST /profiles/{id}/test` (공정데이터_2024_02, 그룹 11) | 동기 응답, 20초 TEST_TIMEOUT 안 |
| 재파싱(rematch) 큰 호환 문서(4000×150) 포함 | JobBar `진행 중 작업`이 관찰될 만큼 지속(jobs #11 전체 21.1초) |
| 잠긴 파일 단독 재등록 실패 작업 | 인라인 완료(DRM_READER_REQUIRED) |
| `POST /builds` 36행 × 11열 CSV/XLSX/SQLite | 동기 200, 두 번째 CSV 빌드 `reused: true` |
| 폴더 일괄 등록: 스캔 → 4파일 등록 → 재스캔 → 4파일 재읽기 → 값 변경 → 1파일 등록 | 세 번의 `?wait=10` 작업이 모두 대화상자 안에서 인라인 완료(register-directory #1 전체 4.8초) |
| 문서 2건 다중 삭제(`POST /documents/delete?wait=10`) + 같은 파일 2건 재등록 | 대화상자 안에서 인라인 완료(documents #5 전체 3.2초) |
| 문서 1건 단건 삭제(`DELETE /documents/{id}?purge_source=true`, snapshot 2 · 적용 1 · 값 11) + 작업 내역 확인 | 동기 200(documents #6 전체 3.0초) |
| 스키마 폐기 → 목록/선택지 확인 → 폐기 해제 | `POST /schemas/{key}/deprecate`·`/activate` 모두 동기 200(schema #23 전체 5.3초) |
| 같은 폴더 재스캔(`GET /sources/scan`, 4파일·2폴더) | Reader 프로세스 없이 stat + `source_digest` 재사용 — 인라인 응답 |

## 6. 스펙별 시나리오

| 스펙 | test() | 검증한 시나리오 |
| --- | --- | --- |
| `documents.spec.ts` | 6 | 쉘(제품명·메뉴 순서·설정 — 접근 토큰 카드 없음 · Reader 카드 안내) · 문서 표 시드 6건과 상태 칩(정상·검수 필요·미매칭·잠김)·적용 프로파일·연결 스키마 · 검색/상태 필터 · 정렬 헤더 `aria-sort` 순환 · 등록 대화상자(원본 폴더 목록 → 복사본 등록 → 작업 완료) · 상세 드로어 탭(파일 보기 202 폴링 → 셀 텍스트, 추출 결과 표 → 원본 보기 → Source Review, 적용 프로파일 v1 · 발행 · 검수 11/11, 연결 스키마 카드) · 잠긴 문서(원본 보기 비활성, 적용 없음) · 대표 문서 변경 재등록 → r2 snapshot · 변경 감지(inherited) · Snapshot 이력 · 새 값 렌더 · 다중 선택 → 데이터 빌드 인계 · **문서 삭제(§4.13)**: 다중 선택 → 확인 대화상자(문구·이름 목록·`원본 파일도 함께 지우기` 기본 해제·취소는 아무것도 지우지 않음) → `POST /documents/delete` → 목록·API에서 사라지고 원본 파일은 남음 → 같은 파일 재등록(새 document_id) · 단건(상세 드로어)에서 대표 문서를 지울 때 확인 **전에** `대표 문서입니다 — 파싱 프로파일 '공정데이터_A양식'…` 경고 + 원본까지 삭제 → 드로어 닫힘 · 원본 파일 사라짐 · 대표 문서를 지운 프로파일이 `초안`으로 · 작업 내역 `종류=삭제` 2행과 `GET /jobs?kind=delete` 본문 · 거부 갈래(404 `UNKNOWN_DOCUMENT` · 422 `VALIDATION_ERROR` · 422 `TOO_MANY_DOCUMENTS`) |
| `profiles.spec.ts` | 3 | 목록 열(프로파일명·버전·연결 스키마·적용 문서 수·상태·최근 수정)·상태 필터 · **탭 없는 단일 상세**(요약줄 연결 스키마/대표 문서 r1·기준 v1·자동 승인/적용 문서 4 · 정의 JSON 편집기의 자동 검증·문법 오류·되돌리기 · 내보내기 다운로드 내용 · 변경 이력 · 대표 문서 지정 팝오버) · 없어진 것 확인(tablist 0 · 규칙 카드 0 · 필드 매핑 표 0 · 적용 문서 표 0) · `+ 새 프로파일` 하나(빈 골격 골격 확인 → 붙여넣기로 v1 템플릿 → 형식 판별 · canonical 미리보기 · 경고 2 → 저장 → 초안) · 정의 JSON 편집 → v2 저장 → r1 읽기 전용 보기 → 테스트 팝오버 → Source Review 테스트 모드(판정 `호환`) · 재파싱(fill) 토스트 `0건 처리 · 4건 건너뜀` |
| `schema.spec.ts` | 4 | 스키마 목록(필드 14 · 프로파일 1 · 문서 4) · 상세 헤더 v1 활성 · 트리/그래프 토글 · 그래프 확대 · 필드 상세(온도) · 사용 프로파일/연관 문서 탭 field_filter 추적 · 필드에서 Source Review(C8='온도' + overlay) · 필드 편집(alias PATCH → 응답이 **필드 상세**(`schema.rev = 2`) → v2 · 변경 이력 현재 표시) · 새 스키마 만들기(생성 전용 · 같은 키 409 `SCHEMA_EXISTS`) · 필드 추가(타입 어휘) → 필드 삭제(새 리비전) · 자식/사용 중 필드 409 · 사용 중 스키마 409 · 빈 스키마 삭제 · **폐기/폐기 해제(§4.2.3)**: 확인 대화상자 → 응답이 스키마 상세와 같은 본문 → 칩 `폐기`·안내 줄·버튼 하나(`폐기 해제`) · 목록 기본(활성)에서 숨김 — 빈 상태가 `활성 파싱 스키마가 없습니다…` + `폐기된 스키마 보기`이고 `새 스키마`는 없음(하나뿐인 스키마를 폐기한 뒤 같은 스키마를 다시 만들게 두지 않는다) → 상태 필터(`활성·폐기·전체`)로 복귀 · `새 프로파일`/데이터 빌드 2단계 선택지에서 빠짐 · `POST /profiles` 422 `SCHEMA_DEPRECATED` · 확인 없이 `폐기 해제` → 복귀 · 같은 상태 두 번 409(`ALREADY_ACTIVE`/`ALREADY_DEPRECATED`) · 없는 키 404 |
| `build.spec.ts` | 1 | 문서 3개 인계 · candidates 제외 사유 · 스키마 선택 · 출력 Header 편집(중복·빈 값 오류) · ↑ 순서 변경 · 미리보기 = API 값 · 원본 보기 → Source Review overlay · CSV/XLSX/SQLite 생성과 다운로드 파일 내용(csv·openpyxl·sqlite3) · manifest · build_key 재사용 · 새 빌드 |
| `jobs.spec.ts` | 4 | 요약 카드 5개 · 신규 양식/매핑 검수/파싱 실패 큐 묶음 행과 멤버 표(Snapshot 날짜·상태 칩) · 원본 보기 → Source Review · 렌더 서버 상태 · 작업 목록(종류 필터) · 매핑 검수 `전체 승인` → 문서 정상 · 큐 0 · 묶음 처리 작업 행 · 새 snapshot 변경 감지 큐 → 동일 승계 전체 승인 · 잠긴 파일 재등록 실패 행(오류 문구 · 이동 → 문서 드로어) · 큰 문서 재파싱 중 JobBar `진행 중 작업` |
| `source-review.spec.ts` | 3 | 컨텍스트 브레드크럼(`{schema} v{rev}`) · 시트/규칙 목록(제안 칩) · 실제 셀 · overlay 키/값/단위 · 확대 · 셀 이동 → 드래그 재지정 → `원본 위치 변경됨` · 승인(POST 1회) · 모두 승인(추출 88값·발행) · 변경 이력/복원 · 반려 · 재승인 → 추출 폴링 · 역방향 조회(API) · 창 요청(80행×30열 문서 스크롤 → A61:… / AA…) · 잠긴 문서(드로어 Snapshot 없음 안내, 뷰어 안 DRM 403 → `다시 시도`, 나머지 화면 정상) |
| `register-directory.spec.ts` | 2 | `helpers.makeRawTree`로 원본 폴더에 `일괄/2024/`·`일괄/2024/하위/` 트리(같은 양식 복사본 3 + 다른 양식 1 + `~$임시.xlsx` + `메모.txt`) 생성 · 대화상자 폴더 이동 → `이 폴더 전체 등록` 미리보기(`일괄/ 아래 파일 4개 · 하위 폴더 2개` · 상태 칩 4종 · 건너뜀 줄 · 다시 읽기 체크박스 해제 상태) → `4개 등록 시작` → 요약 `4개 중 4개 등록 · 0개 변경 없음 · 0개 실패` · 결과 표 4행(등록/자동 적용/상태/실패 사유) · UUID 비노출 · 문서 목록 +4건(정상 3 · 프로파일 없음 1) · 폴더 행 `일괄 전체 등록`으로 재스캔 → `변경 없음 4`·`0개 등록 시작` 비활성·안내 문구 · 체크박스 켜고 4건 재읽기(문서 수 불변) · `helpers.mutateRawDocument`로 하위 복사본 값 변경 → `변경된 문서 1` → `1개 등록 시작` → 결과 행·문서 목록 `변경 감지` · API `..`/`일괄/../..`/절대 경로 422 `INVALID_SOURCE` · 없는 폴더 404 `SOURCE_NOT_FOUND` · 알 수 없는 provider 422 `UNKNOWN_PROVIDER` · `GET /jobs?kind=register` 라벨 `일괄 폴더 일괄 등록` |
| `render-isolation.spec.ts` | 3 | 첫 렌더 202 → 폴링 → 200 · 캐시 재접근 < 1초(클라이언트/렌더 서버) · ETag/If-None-Match 304 · `Cache-Control: private, no-cache` · 이미지 asset png · 큰 시트(2000×90) 렌더 중 문서 목록 API < 500 ms와 화면 이동 · 기준선 10회 |

## 7. 실패·건너뜀·경고

실패 0, 건너뜀(`test.skip`) 0, flaky 0. 단, 정직하게 적어 둘 사항:

### 7.1 약하게 단언했거나 우회한 것

- **다운로드 파일 이름**은 검사하지 않는다. 프런트가 분리된 `<a download>`를 클릭하므로 Chromium이 `suggestedFilename`을 `download`로 보고하고, 서버의 `Content-Disposition`(`process_standard-<build_key>.csv`, `<profile>-r<rev>.json`)과 프런트가 붙이는 이름(`data.csv`, `<profile>_v<rev>.json`)이 서로 다르다. 스펙은 URL과 **파일 내용**만 검사한다.
- **역방향 조회(셀 → 규칙/값)** 는 UI가 없어 `GET /regions/{rid}/values`·`GET /sheets/{sheet}/regions`를 API로만 검증한다.
- **잠긴 문서의 뷰어 안 DRM 실패**는 시드의 잠긴 문서(current_snapshot null)로는 뷰어가 마운트되지 않아, 등록된 문서의 바이트를 잠긴 페이로드로 바꿔(렌더 프록시 403 DRM_READER_REQUIRED) 도달한다. 이때 Chrome이 4xx마다 남기는 `Failed to load resource … 403` 콘솔 오류는 브라우저 생성이라 정확히 거부된 렌더 응답 수만큼만 허용한다(그 외 console.error는 실패).
- **JobBar `진행 중 작업`**과 **렌더 격리 창**은 시드 문서로는 작업·렌더가 너무 빨리 끝나 관찰할 수 없어 `write_heavy_document`(4000×150 / 2000×90)로 만든 큰 문서를 쓴다.
- **재파싱(fill)** 은 시드에 '승인됐지만 추출 안 된' 문서가 없어 `0건 처리 · 4건 건너뜀` 토스트만 확인한다(queued > 0 미관찰).
- **캐시 재접근 < 1초**는 두 경로를 따로 잰다: 드로어 재열기는 클라이언트 60초 메모리 캐시라 네트워크 요청 0, 새로고침 뒤 재접근이 렌더 서버 캐시(200만, 202 없음).
- **Stepper 버튼 접근 이름**이 CSS `::before` 번호 때문에 `1대상 문서`처럼 읽혀 부분 일치로 찾는다.
- **테스트 결과 영역의 최신 값 선택**: `GET /schemas/{key}/fields/{field_key}/values`가 같은 created_at 안에서는 UUID 순이라 스키마 스펙은 `items[0]`을 API에서 읽어 UI가 그것과 같음을 단언한다(고정 범위 아님).
- 스펙은 계약 문구가 아닌 **실제 라벨**을 단언한다: 큐 동작은 `전체 승인`/`검수 열기`/`원본 보기`(계약의 '모두 승인'·'원본 검수' 아님), 매핑 상태는 `제안/승인/반려`(`검수 필요`는 문서 상태), 프로파일 상세의 적용 문서 상태 칩은 `document_status`.
- **폴더 일괄 등록의 성능 근거**는 브라우저에서 간접적으로만 본다. 스펙이 확인하는 것은 재스캔이 `변경 없음 4 · targeted 0`을 돌려주고 `0개 등록 시작`이 비활성이라는 **결과**이며, 스캔이 Reader 프로세스를 띄우지 않는다는 것·`source_digest`가 같은 stat에서 `file_hash`를 0회 부른다는 것은 `tests/test_register_directory.py`(계약 §10)가 본다. 대화상자 미리보기 응답 시간도 재지 않는다(시드 규모가 4파일·2폴더라 의미 있는 수치가 나오지 않는다).
- **문서 삭제의 부분 실패**(`documents[].error` · `summary.failed` > 0으로 대화상자가 열린 채 실패 목록을 보이는 갈래)와 **원본 삭제 실패**(`source_error` — `SOURCE_MISSING`·`SOURCE_SYMLINK`·`SOURCE_OUTSIDE_RAW`·`PURGE_UNSUPPORTED`·`SOURCE_REMOVE_FAILED`)는 브라우저에서 만들어 낼 수 없어(작업 공간이 정상이고 원본이 모두 raw 안에 있다) 단위 테스트가 본다. 스펙은 성공 경로와 요청 단계 거부(404 `UNKNOWN_DOCUMENT` · 422 `VALIDATION_ERROR` · 422 `TOO_MANY_DOCUMENTS`)만 단언한다.
- **`DOCUMENT_BUSY`(409)** 도 브라우저에서 재현하지 않는다 — 삭제 요청이 도는 동안 `queued|running` 작업을 붙잡아 둘 방법이 스펙에 없다. 대신 `DeleteDialog.FINAL_CODES`에 이 코드가 **없다**는 것(작업이 끝나면 다시 누를 수 있어야 한다)은 `frontend/tests`가 본다.
- **200개 상한**은 실제로 200개를 지워 확인하지 않는다. 201개 id를 보내 422로 막히는 것과 그 뒤 문서 수가 그대로인 것만 본다.
- **다중 삭제가 10초를 넘겨 작업으로 넘어가는 갈래**(`POST /documents/delete?wait=10`이 진행 중 응답을 돌려주고 토스트가 `문서 삭제가 작업 내역에서 계속 진행됩니다.`로 바뀌는 경우)는 시드 규모에서 항상 인라인으로 끝나 관찰되지 않는다.
- **폐기한 스키마의 approved 프로파일이 새 문서에 계속 적용된다**(계약 §4.2.3의 결정)는 안내 문구와 프로파일·적용 건이 그대로 남아 있음까지만 본다. 폐기 상태에서 새 문서를 등록해 자동 적용이 실제로 도는지는 단언하지 않는다.
- **일부러 거부시킨 409**: 스키마 스펙 3번은 `SCHEMA_EXISTS`·`FIELD_HAS_CHILDREN`·`FIELD_IN_USE`·`SCHEMA_IN_USE` 네 건을 만든다. Chrome이 4xx마다 남기는 `Failed to load resource … 409` 콘솔 오류는 브라우저 생성이라 정확히 4건만 허용하고 그 외 `console.error`는 실패로 본다.
- **잠긴 원본의 렌더 403**은 한 번의 요청으로 확정되지 않는다. 렌더는 비동기라 첫 응답이 202이고, 어댑터가 없으면 다음 폴링에서 403 `{status:'failed', error{code,message}, retry_after}`가 된다 — 스펙은 202인 동안 0.5초 간격으로 최대 60초 폴링한 뒤 403을 단언한다.
- **`e2e/test-results/run.log`**: Playwright가 시작할 때 `outputDir`을 비우므로 실행 중에 그 안으로 `tee`하면 지워진 inode에 쓰여 파일이 남지 않는다. §1의 명령은 실행이 끝난 뒤 로그를 옮긴다.
- **폴더 일괄 등록에서 확인하지 않은 갈래**: 413 `DIRECTORY_LIMIT` 안내, 작업 취소, 심볼릭 링크 건너뜀, 잠긴 파일 다시 읽기, `documents[]` 500행 `truncated` 표시, 최상위(`원본 폴더 전체 등록`) 경로는 브라우저 스펙이 아니라 단위 테스트가 덮는다. 스펙은 결과 화면에 `앞 500개만 표시` 문구가 **없음**만 단언한다.

### 7.2 E2E 중 발견해 고친 것 (모두 이 스위트로 검증됨)

러너·스펙:

- `e2e/serve.py`: 전체 스위트를 한 서버로 돌리면 스펙 파일들이 앞선 스펙의 등록·승인·빌드 상태를 이어받아 9/19가 실패했다(문서 4→6, 큐 0, 옵션 5→7 …). 러너를 감독 프로세스로 바꿔 렌더/메인 서버를 자식으로 띄우고 제어 포트의 `POST /reset`으로 스펙 파일마다 새 작업 공간을 시드한다. SIGTERM/SIGINT에서도 자식·표식(`.workspace`)·임시 폴더를 정리하고, 자식의 uvicorn INFO 로그는 걸러 list reporter 출력이 서버 로그에 묻히지 않게 했다.
- `e2e/specs/helpers.ts` `resetWorkspace()` 추가, 스펙마다 `test.beforeAll(resetWorkspace)`(이번 개정에서 더한 `register-directory.spec.ts` 포함 8개).
- `e2e/specs/helpers.ts` 도우미 2개 추가(이번 개정): `makeRawTree(entries)` — 원본 폴더 아래에 하위 폴더까지 있는 트리를 한 번의 파이썬 호출로 만든다(시드 문서 복사 또는 텍스트 파일); `mutateRawDocument(source_ref)` — `examples/demo/demo.py`의 `mutate_document(root, source_ref)`를 불러 하위 폴더 안 복사본의 값을 바꾼다(기존 `mutateFirstDocument`는 대표 문서 전용이라 하위 폴더를 가리킬 수 없었다).

프런트(`frontend/src/app/`, 그 회차에 재빌드·vitest 통과 — 지금 트리의 수치는 §2):

- `SourceReview.tsx` 테스트 결과 정규화: `POST /profiles/{id}/test`의 regions/values/bindings가 이름 키 dict(sheet_id 없음)로 와서 overlay가 TypeError로 빈 화면이었다 → 두 형태 모두 받아 sheet_name으로 sheet_id 해석.
- `SourceReview.tsx` 모두 승인: 응답 `{application_id, approved, skipped, extraction}`을 JobResponse로 취급해 배너가 오류 스타일·`state undefined`였다 → 정규화, 진행 중 추출 추적.
- `SourceReview.tsx` 승인 쓰기: `POST /mappings/{mid}/revisions`가 돌려주는 `extraction` 작업을 무시해 마지막 규칙 승인 뒤 값이 안 나왔다 → 작업 추적(`승인됨 · 추출 진행 중…` → `추출 완료 · 값 N개 · 발행됨`).
- `SourceReviewMapping.tsx` 변경 이력 목록 캐시 키를 낙관적 revision_no 대신 쓰기 순번으로 → 복원 뒤 stale 목록 방지.
- `ProfileDetail.tsx` 적용 문서 상태 칩이 `row.status`(없음)를 읽어 비어 있었다 → `document_status`.
- `Schema.tsx`/`SchemaTabs.tsx` 필드 PATCH 뒤 상세 헤더 v1·변경 이력 '현재'가 갱신되지 않았다 → 목록/상세/트리/그래프/이력 재조회.
- `BuildOutput.tsx` 미리보기 행을 셀 배열로 인덱싱해 모든 셀이 '-'였다(실제 행은 `{row_no, document, snapshot, record_key, cells}`) → `cellsOf(row)`.
- `Jobs.tsx` `GET /queues`의 `summary`를 `counts`로 읽어 요약 카드 5개가 '–'였다; `JobsQueue.tsx` 멤버 행 키(`document_status`, `detail.error`); 종류 필터의 `render`(API 422) 제거; 3초 폴링에 `/status` 포함(진행 중 작업 수 60초 지연 해소).
- `Documents.tsx`/`DocumentDetail.tsx`/`ui.tsx` `statusDetailText`: `status_detail`이 객체라 상태 칩 툴팁이 `[object Object]`가 되던 것을 항목별 요약 문장으로.
- `SheetViewer.tsx` `normalizeStyle`: 렌더 서버의 스타일 이름(`background`·`fontWeight`·`s` 인덱스)과 픽스처의 짧은 이름을 모두 받도록.
- `types.ts`: 위 형태들(`PreviewRow`, `QueueSummary`, `QueueMemberRow`, `ProfileDocumentRow`, `SchemaRef.rev`) 타입.

백엔드(`schema/`, 그 회차에 `pytest` 통과 — 지금 트리의 수치는 §2):

- `service.py` `application_summary`의 `schema` 참조에 `rev` 추가 → Source Review 브레드크럼이 §7의 `{schema_name} v{rev}` 형태.
- `operations.py` 큐 멤버 행에 `snapshot {snapshot_id, revision_no, captured_at}` 첨부(페이지당 IN 질의 1회) → Snapshot 열에 날짜; 큐 원인 문구의 영문 어휘(`compatible 1`)를 `호환 1`로(`tests/test_operations.py` 기대값 동반 수정).

시드 도우미(`examples/demo/demo.py`, 시드 문서 집합은 그대로): `write_heavy_document(root, rows, cols)`, `write_wide_document(root)` 추가.

### 7.3 폴더 일괄 등록 스펙을 더하면서 E2E가 잡아낸 회귀 (고침)

`register-directory.spec.ts`를 더한 실행에서 기존 스펙 3개가 실패했다. 원인은 같은 개정에서 넣은 §6 "목록 응답의 축약 결과"의 첫 구현이
`GET /jobs` 결과의 **모든** 배열을 `<key>_count`로 바꿔 버린 것이었다(작업 내역이 곧바로 쓰는 짧은 배열까지 사라졌다).

| 실패한 스펙 | 증상 | 고침 |
| --- | --- | --- |
| `jobs.spec.ts:265` | `GET /jobs?kind=queue_action`의 `result.skipped`가 사라져 `{queued: 1, skipped: []}` 단언 실패 | `Jobs.brief_result`가 `BRIEF_ROWS`(20)를 넘는 배열만 축약하도록 수정 |
| `jobs.spec.ts:305` | 앞 스펙이 중간에 끊겨 큐 상태가 남아 요약 카운트 불일치 | 위와 같음(선행 실패의 파생) |
| `profiles.spec.ts:439` | `재파싱(fill)` 작업의 `result.skipped`가 사라져 건너뛴 문서 4건을 읽지 못함 | 위와 같음 |

수정 뒤에는 같은 명령이 연속으로 통과했다(그 회차 기준 3회 연속 전체 통과 — 지금 트리의 수치는 §2). 폴더 일괄 등록의 500행 `documents[]`는 여전히 목록에서 빠지고
`documents_count`로 대신하며, 전문은 `GET /jobs/{id}`가 준다(`schema/jobs.py` `Jobs.brief_result`·`BRIEF_ROWS`).

이번 개정에서 `register-directory.spec.ts`를 §8 문장대로 다시 쓰고(도우미 `makeRawTree`·`mutateRawDocument` 사용, `GET /jobs?kind=register`
라벨 단언 추가) 돌렸을 때는 **프런트·백엔드 수정 없이 첫 실행에서 그 스펙 2개가 모두 통과**했고, 그 회차의 전체 실행 3회도 전부 통과였다.

### 7.4 고치지 않은 계약·구현 차이 (관찰만)

- §4.7 테스트 결과의 regions/values/bindings 형태를 계약이 고정하지 않아 서비스(이름 키 dict)와 프런트 타입(§6 매핑 행 배열)이 다르다 — 프런트에서 양쪽 수용, 백엔드 변경 시 `tests/test_service.py` 갱신 필요.
- `GET /profiles/{id}/revisions`·`GET /schemas/{key}/revisions`에 `created_by`/`summary`가 없어 변경 이력의 작성자·요약 열은 '-'.
- 그래프 hull 라벨 `문서 N`이 그룹 노드의 document_count(항상 0)를 쓴다; 관련 필드 링크는 저장 방향(온도 → 압력)으로만 보인다.
- `POST /builds/preview` 행 래퍼(`row_no, document, snapshot, record_key, cells`)와 `POST /builds` 추가 필드(`reused`, `format`, `row_count`, manifest `formats`)는 계약 §6/§4.10에 없다.
- 작업 내역: 실패 큐 잠김 묶음에 `next_action` 기반 이동 버튼이 없고(드로어는 문서명 링크로만), 영향 칩은 rule_key(한국어 규칙명 아님), 프로파일 테스트 작업 라벨만 `r1` 표기.
- 시드에는 실패 작업이 없다(잠긴 파일은 성공한 묶음 등록 작업의 result 안 오류) — 실패 행은 잠긴 파일 단독 재등록으로 만든다.
- Source Review 닫기(Escape)는 `sheet=`를 유지한다(문서 드로어와 공유), 발행 뒤 복원하면 문서가 '정상'에서 벗어난다(§4.5와 일관, §7 표에는 없음).
- 렌더 서버는 토큰이 없을 때 loopback 호출에 그대로 응답한다(스펙은 이를 이용해 렌더 서버를 직접 관찰).
- §4.1.1 일괄 등록 작업 라벨을 계약은 `"<폴더 마지막 이름 또는 '원본 폴더'> 폴더 일괄 등록"`으로 적어 최상위에서는 `원본 폴더 폴더 일괄 등록`으로도 읽히지만, 구현은 `원본 폴더 일괄 등록`이다. 스펙은 하위 폴더(`일괄 폴더 일괄 등록`)만 단언한다.
- 계약 §8은 스펙 파일 목록에 `settings.spec.ts`를 적지만 `e2e/specs/`에는 그 파일이 없다. 설정 화면 단언(접근 토큰 입력칸 없음 · Reader 카드 연결 상태와 127.0.0.1 안내 · 잠김 묶음의 `설정 열기` → `#reader`)은 `documents.spec.ts` #1과 `source-review.spec.ts` #3 안에 들어 있다 — 커버리지는 있고 파일 이름만 다르다. 파일을 새로 만들면 같은 단언이 두 벌이 되므로 나누지 않았다.
- 스키마 목록에서 유일한 스키마를 폐기하면 기본(활성) 필터의 빈 상태 문구가 `아직 파싱 스키마가 없습니다. 정의 JSON을 가져와 시작하세요.`다 — 스키마가 하나 있는데도 '없다'고 말한다(상태 필터가 바로 옆에 있어 길은 막히지 않는다). 스펙은 현재 문구를 그대로 단언한다.
- 등록 결과 표의 `상태` 열은 문서 상태 칩을 그대로 쓴다 — 값이 바뀐 파일을 다시 등록하면 승계가 `proposed`라 `변경 감지`로 보인다(§4.4대로지만, '등록 성공'과 '검수 필요'가 한 열에 섞여 보인다).

### 7.5 실행 환경 경고

- 자식 서버가 남기던 uvicorn INFO 로그는 러너가 거른다; WARNING 이상과 트레이스백은 `[main]`/`[render]` 접두사로 그대로 나온다(최종 실행에서는 없음).
- 여러 스위트를 동시에 돌릴 때는 `SCHEMA_E2E_PORT`/`SCHEMA_E2E_RENDER_PORT`/`SCHEMA_E2E_CONTROL_PORT`와 `SCHEMA_E2E_REPORT`/`SCHEMA_E2E_RESULTS`를 다르게 준다. `pkill -f serve.py` 같은 광범위한 종료는 다른 실행의 러너까지 죽이므로 자기 PID만 종료한다.
- 이번 결과의 시간 값은 단일 워커·순차 실행 기준이며 다른 부하가 없을 때의 값이다.

### 7.6 화면 정리·DRM 개정에서 스펙을 고친 것 (직전 회차)

바뀐 화면에 맞춰 단언을 고쳤고, 스펙이 잡아낸 실제 결함은 한 건이다.

| 무엇 | 어디 | 내용 |
| --- | --- | --- |
| 스펙이 잡아낸 결함(고침) | `frontend/src/app/SchemaEditor.tsx` | `필드 추가` 대화상자의 타입 목록이 `string/float/integer/date/boolean`이라 기본값 `string`으로는 `POST /schemas/{key}/fields`가 422로 거부됐다(계약 §6 어휘는 `text/decimal/boolean/date/datetime/group`). 목록과 기본값을 계약 어휘로 바꿨고 schema #3이 옵션 목록과 201 응답을 단언한다. |
| DRM 문구 한 곳으로 | `e2e/specs/helpers.ts` | `DRM_READER_REQUIRED` 문구가 바뀌어 문서·작업 내역·Source Review 세 스펙이 각자 들고 있던 상수를 `helpers.DRM_MESSAGE` 하나로 모았다. |
| 렌더 403 폴링 | `source-review.spec.ts` | 잠긴 원본 렌더가 첫 요청에서 202로 오게 바뀌어(해제 시도) 202 동안 폴링한 뒤 403과 `{status:'failed', …retry_after}` 본문을 단언한다. |
| 프로파일 상세 | `profiles.spec.ts` | 탭 6개(기본 정보·규칙·필드 매핑·테스트·JSON·변경 이력)를 쓰던 단언을 지우고 단일 화면(요약줄·정의 JSON 편집기·테스트 팝오버·변경 이력)으로 다시 썼다. `tablist`·규칙 카드·필드 매핑 표·적용 문서 표가 **없음**도 함께 단언한다. |
| 프로파일 만들기 | `profiles.spec.ts`, `jobs.spec.ts` | `외부 Profile Import` 대화상자가 `새 프로파일` 하나로 합쳐졌다. 작업 내역의 `프로파일 만들기`는 이제 `?screen=profiles&import=1`만 붙이고 `snapshot=`을 넘기지 않는다(저장 전 초안은 테스트할 수 없다). |
| 스키마 화면 | `schema.spec.ts` | 변경 이력 탭 안내 문구와 쓰기 버튼 위치(상세 머리의 `새 리비전`·`이름 바꾸기`·`삭제`)를 고쳤고, 필드 PATCH 응답 단언을 가져오기 요약에서 **필드 상세**(`schema.rev = 2`)로 바꿨다. 생성·삭제 시나리오 test()를 하나 더했다. |
| 판정이 바뀐 것 | `profiles.spec.ts` | 정의를 고쳐 v2를 저장한 뒤의 테스트 판정은 `동일`이 아니라 `호환`이다 — `identical`은 대표 문서 승인 당시 리비전과 같을 때만이다(`engine._judge`, §3.3). 작업 결과도 `compatibility: "compatible"`. |

관찰만 하고 고치지 않은 것:

- 새 스키마 대화상자의 주 버튼 이름이 아직 `가져오기`다(생성 전용 대화상자에는 `만들기` 쪽이 맞지만 계약 §C가 이 라벨을 정하지 않았다 — 스펙은 현재 라벨을 단언한다).
- 변경 이력의 `이 리비전 보기`는 현재 리비전 행에서는 `?rev=`를 지우기만 해 아무 변화가 없다(이전 리비전 행에서만 읽기 전용 보기로 바뀐다).

### 7.7 문서 삭제·스키마 폐기 개정에서 스펙을 고친 것 (이번 회차)

새 동작 두 가지(문서 삭제 §4.13 · 스키마 폐기 §4.2.3)를 스펙으로 덮고, 그 변경 때문에 깨진 기존 단언 두 건을 고쳤다.
이번 회차에 스펙이 잡아낸 **제품 코드 결함은 없다** — 두 실패 모두 새 기능이 화면·문구를 바꿔서 생긴 기대값 차이였고, 스펙 쪽을 고쳤다.

| 무엇 | 어디 | 내용 |
| --- | --- | --- |
| 새 시나리오 | `documents.spec.ts` | test() 3개 추가(#4 다중 선택 → 확인 대화상자 → 원본 보존 삭제 → 재등록, #5 단건 + 원본까지 삭제 → 대표 문서 프로파일 초안 → 작업 내역, #6 거부 갈래 404/422). 세 test()는 파일 맨 뒤에 둔다 — 되돌릴 수 없는 일이라 앞 test()들이 보는 문서 수를 흔들지 않는다. 다음 스펙 파일은 `resetWorkspace()`가 새 작업 공간을 시드하므로 지운 문서가 넘어가지 않는다. |
| 새 시나리오 | `schema.spec.ts` | test() 1개 추가(#4 폐기 → 목록 기본에서 숨김 → 상태 필터 → `새 프로파일`·데이터 빌드 선택지에서 빠짐 → 폐기 해제 → 409/404). 시드 스키마를 폐기했다가 반드시 되돌려 놓는다. |
| 새 도우미 | `e2e/specs/helpers.ts` | `rawFileExists(source_ref)` — `<ws>/data/raw` 안의 파일이 남아 있는지 파이썬으로 확인한다. `purge_source` 기본값(해제)에서 원본이 그대로인 것과, 체크했을 때 사라지는 것을 같은 도우미로 본다. |
| 깨진 단언(고침) | `jobs.spec.ts` 작업 목록 test() | 작업 종류 필터 목록에 `삭제`가 붙어 `["전체","등록","추출","재파싱","빌드","테스트","묶음 처리"]` 단언이 실패했다(`JOB_KIND_LABELS`에 `delete` 추가). 기대값에 `삭제`를 더했다. |
| 깨진 단언(고침) | `schema.spec.ts` 삭제 거부 test() | `SCHEMA_IN_USE` 문구가 계약 §4.2.1 개정으로 `… 프로파일 상세에서 '삭제'한 뒤 다시 시도하거나, 더 쓰지 않으려면 이 스키마를 '폐기'하세요.`로 바뀌어 옛 꼬리 문구 단언이 실패했다. 새 문구로 고쳤다. |

스펙을 쓰면서 확인한 것(모두 통과):

- 선택 바의 `삭제`와 상세 드로어의 `삭제`가 **같은 확인 대화상자**를 연다(제목 `문서 삭제`, 단건/다중 문구만 다르다).
- `원본 파일도 함께 지우기 (data/raw)` 체크박스는 **기본 해제**이고, 그 상태에서 지우면 `<ws>/data/raw`의 파일이 그대로 남는다. 같은 파일을 다시 등록하면 프로파일이 다시 붙은 **새 문서**가 만들어진다(지운 `document_id`는 돌아오지 않는다).
- 대표 문서를 지우면 프로파일이 `초안`으로 내려가고 `reference`가 비며, 그 사실이 응답(`profiles_reset`)·토스트·작업 기록에 모두 남는다.
- 작업 내역 행은 `target_kind: workspace` · `target_id: null`이라 이동 버튼이 없다 — 지워진 문서를 가리키는 죽은 링크를 만들지 않는다.
- 스키마 폐기·폐기 해제 응답은 `GET /schemas/{key}`와 **완전히 같은 본문**이다(스펙이 두 응답을 `toEqual`로 비교한다). 화면은 이 응답 하나로 헤더·칩·버튼을 갱신한다.
- 화면 낱말은 프로파일과 같은 `폐기`/`폐기 해제`다 — 어느 스펙도 `비활성화`를 찾지 않는다.

## 8. 재현 절차

1. `cd frontend && npm ci && npm run build` (dist가 없으면 메인 서버가 UI를 서빙하지 않는다). `npx vitest run`으로 컴포넌트 회귀 통과 확인(이번 회차 `15 passed (15)` 파일 / `177 passed (177)` 테스트).
2. 저장소 루트에서 `python3 -m pytest tests -q` (이번 회차 `299 passed, 2 warnings, 50 subtests passed`).
3. `cd e2e && npm ci` (Playwright 1.63.0). Chromium이 Playwright 기본 경로에 없으면 `SCHEMA_E2E_CHROMIUM_PATH`로 실행 파일을 지정한다.
4. `SCHEMA_E2E_CHROMIUM_PATH=<chromium> SCHEMA_E2E_PYTHON=python3 npm test 2>&1 | tee /tmp/run.log` → 끝난 뒤 `mkdir -p test-results && cp /tmp/run.log test-results/run.log`
   - 러너가 임시 작업 공간을 시드하고 8032(렌더)·8031(메인)·18031(제어)을 연다. 스펙 파일마다 `[e2e-control] reset → generation N` 줄이 한 번씩 나온다.
   - 기대 결과: `26 passed (약 2.8–3.0m)`, `[timing]` 값이 §5 표 범위 안.
5. 실패 시 `playwright-report/`(HTML)와 `test-results/<테스트>/`의 trace.zip·스크린샷·error-context.md를 본다(`npx playwright show-trace <trace.zip>`).
6. 개별 스펙만 돌릴 때: `npx playwright test specs/<name>.spec.ts` — 스펙이 beforeAll에서 리셋하므로 결과는 전체 실행과 같다.
   단, `documents.spec.ts`의 삭제 test() 3개는 **같은 파일의 앞 test()들이 만든 상태**(등록한 복사본 1건 · 대표 문서의 r2 snapshot)를 이어받는다.
   앞 test()가 실패하면 Playwright가 워커를 다시 띄우면서 `beforeAll`이 새 작업 공간을 시드하므로 뒤 test()의 문서 수 단언도 함께 어긋난다 — 첫 실패 원인부터 본다.
