# E2E 시나리오 (Playwright)

현행 React UI 기준의 브라우저 시나리오 테스트. UI가 바뀌면 **여기 스펙도 같은 커밋에서 갱신한다** —
구버전 UI를 가정한 스크립트를 방치하지 않는다.

## 실행

Python 3.12와 프로젝트의 web/test 의존성, Node 22 이상이 필요하다.

```bash
npm --prefix frontend ci && npm --prefix frontend run build
npm --prefix e2e ci
cd e2e
npx playwright install --with-deps chromium     # 또는 SCHEMA_E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium
npm test
```

러너 `serve.py`(감독 프로세스)가 임시 작업 공간에 `examples/demo/demo.py`의 가상 문서(같은 양식 3개·앵커 이동 1개·
다른 양식 1개·잠긴 파일 1개·이미지 시트)와 스키마·approved 프로파일을 만들고, **렌더 서버를 별도 프로세스(8032)**로,
메인 API/UI를 8031로 띄운다. 제어 포트(18031)의 `POST /reset`으로 스펙 파일마다 새 작업 공간을 시드해 스펙 간 상태를 격리한다
(`helpers.resetWorkspace()`, ≈3.5초). 작업 공간 경로는 `e2e/.workspace`에 기록되어 새 snapshot 시나리오가
`mutate_first_document`를, 폴더 일괄 등록 시나리오가 `helpers.makeRawTree`(원본 폴더 아래 하위 폴더 트리 생성)와
`helpers.mutateRawDocument`(하위 폴더 안 문서 값 변경)를 실행한다.
실제 사용자 작업 공간(`<ws>/workspace.db`)이나 사용자 원본은 열지 않는다.

## 스펙

| 스펙 | 검증 |
|---|---|
| `specs/documents.spec.ts` | 등록 대화상자 · 7개 상태 칩 · 정렬/필터 · 드로어 4탭(파일 보기 202 폴링) · 문서→프로파일→스키마 관계 · 문서 삭제(§4.13) — 다중 선택 확인 대화상자 · 원본 보존/원본까지 삭제 · 같은 파일 재등록 · 대표 문서 삭제 시 프로파일 초안 · 작업 내역 행 · 404/422 거부 |
| `specs/profiles.spec.ts` | 목록 · 탭 없는 단일 상세(요약줄 · 정의 JSON 편집기 · 테스트 팝오버 · 변경 이력) · `+ 새 프로파일` 하나(빈 골격/붙여넣기, 이전 세대 정의 형식 판별과 경고) · 정의 편집 → 새 리비전 → Source Review 테스트 모드 · 대표 문서 지정 · 재파싱 |
| `specs/schema.spec.ts` | 트리/그래프 토글 · 필드 상세 · 사용 프로파일/연관 문서 탭 · 필드에서 Source Review · 필드 편집(PATCH → 필드 상세) · 새 스키마 만들기(생성 전용, 같은 키 409) · 필드 추가/삭제 · 사용 중 필드·스키마 삭제 거부(409) · 빈 스키마 삭제 · 스키마 폐기/폐기 해제(§4.2.3) — 목록 기본에서 숨김 · 상태 필터 · 새 프로파일/데이터 빌드 선택에서 빠짐 · 409/404 |
| `specs/build.spec.ts` | 문서 3개 인계 · candidates · 헤더 중복 오류 · 순서 변경 · 미리보기 원본 보기 · CSV/XLSX/SQLite 내용 · manifest |
| `specs/jobs.spec.ts` | 요약 카드 · 묶음 행 · approve_all 1클릭 · 실패 이동 · 작업 목록 |
| `specs/source-review.spec.ts` | 실제 셀·overlay · 드래그 재지정 · 승인→추출 요청 1회 · 역방향 조회 · 잠긴 문서 실패 표시 |
| `specs/render-isolation.spec.ts` | 렌더 중 문서 API 응답 시간 · 캐시 재접근 < 1초 · 304 |
| `specs/register-directory.spec.ts` | 폴더 일괄 등록(§4.1.1) — 루트 폴더 하나 지정 → 하위 폴더까지 4개 등록 · 재스캔 `변경 없음`(재실행이 싸다) · 값 바뀐 파일만 `변경 감지` · 폴더 경로 422/404 · 작업 라벨 |
| `specs/reparse-application.spec.ts` | 문서 상세 한 건 재파싱(§4.9) — 프로파일 정의를 고쳐 v2 저장 → 대표 문서로 다시 승인(승인이 큐에 넣는 **프로파일 전체** 재파싱은 취소) → 적용 프로파일 행의 `다시 파싱` → 그 문서만 새 리비전으로 발행(추출 결과 탭·API) → 한 번 더 누르면 `이미 최신` 건너뜀 → 다른 문서는 옛 리비전 그대로 · 문서 목록에는 버튼 없음 |

공용 도우미는 `specs/helpers.ts`(오류 수집·작업 공간 리셋·API 호출·다운로드 검사·원본 파일 존재 확인 `rawFileExists`·보호 문서 문구 `DRM_MESSAGE`)에 있다. API 접두는 `/api`다.
스펙 9개 · test() 28개. 메인 API는 사용자 인증이 없다 — 어떤 스펙도 토큰을 보내지 않는다.

## 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SCHEMA_E2E_PORT` | `8031` | 메인 API/UI 포트 |
| `SCHEMA_E2E_RENDER_PORT` | `8032` | 별도 렌더 서버 포트 |
| `SCHEMA_E2E_CONTROL_PORT` | 메인 포트 + 10000 | 러너 제어 서버(작업 공간 리셋) 포트 |
| `SCHEMA_E2E_PYTHON` | `python` | 서버와 다운로드(CSV·XLSX·SQLite) 검사에 쓰는 Python 실행 파일 |
| `SCHEMA_E2E_CHROMIUM_PATH` | (없음) | 이미 설치된 Chromium 실행 파일 경로. 미지정 시 Playwright가 관리하는 브라우저 |
| `SCHEMA_E2E_REPORT` | `playwright-report` | HTML 보고서 폴더 |
| `SCHEMA_E2E_RESULTS` | `test-results` | trace·스크린샷·다운로드 폴더 |

포트 변수는 여러 실행을 병렬로 띄울 때 쓴다(러너와 스펙이 같은 변수를 읽는다).
Chromium 경로 지정은 기존 브라우저를 선택하는 옵션이며 실행 환경의 접근 제한을 바꾸지 않는다.

```bash
SCHEMA_E2E_CHROMIUM_PATH=/usr/bin/chromium SCHEMA_E2E_PYTHON=python3 npm test
```

결과와 완료 조건 대조표는 [docs/e2e-results.md](../docs/e2e-results.md). 실패 보고서는 `e2e/playwright-report`,
trace·다운로드·스크린샷은 `e2e/test-results`에 남으며 Git에서는 제외한다.
Playwright는 시작할 때 `test-results`를 비우므로 list reporter 로그(`test-results/run.log`)는 실행이 **끝난 뒤** 옮긴다.
`.github/workflows/ci.yml`이 백엔드·컴포넌트·빌드·브라우저 검사를 push/PR마다 실행한다.
