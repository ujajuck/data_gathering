# E2E 시나리오 (Playwright)

현행 React UI 기준의 브라우저 시나리오 테스트. UI가 바뀌면 **여기 스크립트도
같은 커밋에서 갱신한다** — 구버전 UI를 가정한 스크립트를 방치하지 않는다.

## v3 실행 (기본 화면)

```bash
npm --prefix frontend ci && npm --prefix frontend run build
npm --prefix e2e ci
cd e2e
npx playwright install --with-deps chromium          # 또는 KG_E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium
npm run test:v3
```

러너 `v3/serve.py`(감독 프로세스)가 임시 작업 공간에 `examples/schema_v3/demo.py`의 가상 문서(같은 양식 3개·앵커 이동 1개·
다른 양식 1개·잠긴 파일 1개·이미지 시트)와 스키마·approved 프로파일을 만들고, **렌더 서버를 별도 프로세스(8032)**로,
메인 API/UI를 8031로 띄운다. 제어 포트(18031)의 `POST /reset`으로 스펙 파일마다 새 작업 공간을 시드해 스펙 간 상태를 격리한다
(`helpers.resetWorkspace()`, ≈3.5초). 작업 공간 경로는 `e2e/v3/.workspace`에 기록되어 새 snapshot 시나리오가
`mutate_first_document`를 실행한다. 포트는 `KG_E2E_V3_PORT`·`KG_E2E_V3_RENDER_PORT`·`KG_E2E_V3_CONTROL_PORT`로 바꿀 수 있다.
실제 도메인 DB·사용자 원본은 열지 않는다.

| 스펙 | 검증 |
|---|---|
| `v3/documents.spec.ts` | 등록 대화상자 · 7개 상태 칩 · 정렬/필터 · 드로어 4탭(파일 보기 202 폴링) · 문서→프로파일→스키마 관계 |
| `v3/profiles.spec.ts` | 목록·6탭 · JSON 검증 · v1/v2 Import 미리보기 경고 · 테스트 → Source Review overlay · 승인 · 재파싱 |
| `v3/schema.spec.ts` | 트리/그래프 토글 · 필드 상세 · 사용 프로파일/연관 문서 탭 · 필드에서 Source Review |
| `v3/build.spec.ts` | 문서 3개 인계 · candidates · 헤더 중복 오류 · 순서 변경 · 미리보기 원본 보기 · CSV/XLSX/SQLite 내용 · manifest |
| `v3/jobs.spec.ts` | 요약 카드 · 묶음 행 · approve_all 1클릭 · 실패 이동 · 작업 목록 |
| `v3/source-review.spec.ts` | 실제 셀·overlay · 드래그 재지정 · 승인→추출 요청 1회 · 역방향 조회 · 잠긴 문서 실패 표시 |
| `v3/render-isolation.spec.ts` | 렌더 중 문서 API 응답 시간 · 캐시 재접근 < 1초 · 304 |

결과와 완료 조건 대조표는 [docs/e2e-results-v3.md](../docs/e2e-results-v3.md). 실패 보고서는 `e2e/playwright-report-v3`,
trace·다운로드·스크린샷은 `e2e/test-results-v3`(Git 제외).

## v2 실행 (`?v2=1`)


Python 3.12와 프로젝트의 web/test 의존성, Node 24.15 이상이 필요하다.

```bash
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix e2e ci
cd e2e
npx playwright install --with-deps chromium
npm run test:v2
```

`KG_E2E_PYTHON`으로 Python 실행 경로를 지정할 수 있다. 서버와 다운로드 SQLite 검사 모두 같은
Python을 쓴다. `CHROMIUM_PATH`를 지정하면 v1 러너(`helpers.mjs`)와 같은 브라우저 실행 파일을
`launchOptions.executablePath`로 사용한다. 미지정 시 `npx playwright install`이 설치한 chromium을 쓴다
(`.github/workflows/v2.yml`은 지정하지 않는다). 러너는 `127.0.0.1:8021`에 임시 가상 작업 공간을 직접 생성·실행하며, 스펙은 `/?v2=1&…`로 v2 화면에 진입한다.
기존 서버 재사용이나 실제 `kg.db` 변경은 하지 않는다. 실패 보고서는 `e2e/playwright-report`,
trace·다운로드·스크린샷은 `e2e/test-results`에 남으며 Git에서는 제외한다.

승인된 테스트 환경에 Chromium이 이미 설치되어 있다면 `KG_E2E_CHROMIUM_PATH`에 실행 파일의
절대 경로를 지정한다. v1의 `CHROMIUM_PATH`도 대체값으로 지원하며 `KG_E2E_CHROMIUM_PATH`가
우선한다. 둘 다 없으면 Playwright가 관리하는 기본 Chromium을 사용한다.

```bash
KG_E2E_CHROMIUM_PATH=/usr/bin/chromium npm run test:v2
```

경로 지정은 기존 브라우저를 선택하는 옵션이며 실행 환경의 접근 제한을 변경하지 않는다.
브라우저와 Playwright 간 호환성은 해당 환경에서 검증한다. CI는 기본 번들 브라우저를 사용한다.

`v2/workbench.spec.ts`는 기존 브랜드/탭/파란색, 문서 필터, 미선택 안내, 병합·복수 영역 overlay,
페이지 이동·확대, 승인·추출, 소스 일괄 선택, DB 생성, CSV/SQLite 업무키, 다른 시트의 lineage 이동을 검사한다.
추출 후 KG 커버리지에서 최신 승인 규칙·발행 시리즈를 확인하고 원본 검수로 돌아가는 흐름도 검사한다.
`v2/graph.spec.ts`는 35개 하위 개념을 가진 가상 KG에서 30개 단위 이웃 조회, 관계 방향,
확대·실제 포인터 드래그, 키보드 선택, 상세 이동, URL 재진입을 검사한다.
`.github/workflows/v2.yml`은 백엔드·컴포넌트·빌드·v2 브라우저 검사를 push/PR마다 실행한다.
각 실행이 독립 작업 공간을 사용하므로 전체 워크플로를 재실행할 수 있다.

## v1 실행 (`?v1=1`)

```bash
# 1) 서버 기동 (financier 예제 도메인)
python -m kg.webapp --ws domains/financier --port 8010

# 2) 전체 실행 — kg.db를 자동 백업/원복한다
node e2e/run_all.mjs
```

환경변수: `KG_BASE_URL`(기본 http://127.0.0.1:8010), `KG_WS`(기본
domains/financier), `PLAYWRIGHT_INDEX`/`CHROMIUM_PATH`(브라우저 경로).
개별 시나리오는 `node e2e/02_concept_tree_build.mjs`처럼 단독 실행 가능
(DB 변조 시나리오는 러너로 돌리거나 수동으로 원복할 것).

## 시나리오

| 파일 | 검증 |
|---|---|
| 01_shell | `/`·`/app`의 `?v1=1`이 기존 React 5탭 서빙 |
| 02_concept_tree_build | 개념 트리 상위→하위 일괄 선택, indeterminate, 빌드, .db/.csv 다운로드 |
| 03_normalize_preset | '값·단위 분리' 프리셋으로 "195 ℃"→195 (미리보기+CSV) |
| 04_build_reuse | 무변경 재생성 → 이전 빌드 즉시 재사용, 선택 변경 → 재계산 |
| 05_templates_nm | 템플릿 생성/같은 문서 N:M 배정/해제 독립성 (DB 변조 → 러너가 원복) |

주의: 빌드 시나리오는 `domains/<ws>/data/kg/builds/`에 산출 파일을 남긴다
(로컬 데이터 — 커밋 대상 아님).
