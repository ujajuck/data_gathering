# Semantic Excel Integration

NASCA/DRM 등으로 보호된 사내 Excel 문서를 **검증된 파싱 스키마(무엇)와 파싱 프로파일(어떻게)**로
정형화된 단일 테이블 데이터로 바꾸어 공정/분석 Agent에 제공하는 **Secure Document-to-Table Adapter**다.
Agent는 원본의 물리 양식·DRM·병합 셀·단위를 알 필요 없이 표준 테이블만 소비하고, 모든 추출값은
원본 Sheet/Range까지 추적된다. 최종 CSV/XLSX/SQLite는 필요할 때 만드는 산출물이지 새로운 Source of Truth가 아니다.

현행 런타임은 **v3**(`kg/v3/`, `db/v3/`, `frontend/src/v3/`)다. 설계 근거와 결정은 `docs/`에 있다.

| 문서 | 내용 |
|---|---|
| [docs/ARCHITECTURE_V3.md](docs/ARCHITECTURE_V3.md) | ERD(22개 테이블·트리거 35개)·모듈·시퀀스·API 지도·프런트 구조·운영 |
| [docs/design/v3-contracts.md](docs/design/v3-contracts.md) | 코드 단위 계약(테이블·DSL·서비스 규칙·렌더 서버·API·화면·E2E·이관) |
| [docs/design/v3-decisions.md](docs/design/v3-decisions.md) | 설계 문서끼리 갈린 지점의 결정과 근거 |
| [docs/design/system-identity-and-scope.md](docs/design/system-identity-and-scope.md) · [parsing-core-schema.md](docs/design/parsing-core-schema.md) · [ui-development-spec.md](docs/design/ui-development-spec.md) · [drm-viewer-render-architecture.md](docs/design/drm-viewer-render-architecture.md) | 시스템 정체성 · 18개 코어 스키마 · 승인된 UI 기준안 · 렌더 서버 아키텍처 |
| [docs/e2e-results-v3.md](docs/e2e-results-v3.md) | v3 브라우저 E2E 실행 결과와 완료 조건 대조표 |

## 구성

```
kg/v3/       v3 런타임 — 파싱 스키마/프로파일 projection, Reader 계약(격리 프로세스), DSL 3.0 검증·컴파일,
             Import Adapter(3.0·v2·v1·generic), 추출 엔진, 매핑 검수(CAS)·발행, 데이터 빌드, 검수 큐,
             FastAPI /api/v3, 렌더 서버(kg/v3/render/), v2→v3 이관, raw 감시
db/v3/       코어 18개 테이블 DDL(SQLite + PostgreSQL 번역) — 불변성·CAS·발행 조건 트리거
frontend/    React + TypeScript. 기본 화면은 src/v3/(문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역 + Source Review 오버레이).
             빌드(dist)가 커밋되어 서버가 루트 /에 바로 서빙한다. ?v2=1 → v2 화면, ?v1=1 → v1 화면
e2e/         Playwright 브라우저 시나리오 — v3(e2e/v3, 렌더 서버 별도 프로세스), v2(e2e/v2), v1(run_all.mjs)
examples/schema_v3/  E2E·데모용 가상 작업 공간 시드(스키마·프로파일·문서 7종)
kg/, kg/v2/, src/, domains/  이전 런타임(v1 Fixed Domain KG, v2 versioned extraction)과 파서 라이브러리 — 이관 완료까지 유지
tests/       회귀 전체 (python -m pytest) — v1 · v2 · v3
```

## 빠른 시작 (v3)

```bash
pip install -e ".[web,test]"

# 가상 문서·스키마·프로파일이 들어 있는 작업 공간을 만든다 (사용자 원본을 읽지 않는다)
python -m kg.v3 seed-demo --workspace /tmp/v3-demo

# 렌더 서버(별도 프로세스)와 메인 API/UI
python -m kg.v3 render-serve --ws /tmp/v3-demo --port 8032 &
KG_V3_RENDER_URL=http://127.0.0.1:8032 python -m kg.v3 serve --ws /tmp/v3-demo --port 8010
#  → http://localhost:8010/   (KG_V3_RENDER_URL이 없으면 같은 프로세스 안의 렌더 워커를 쓴다)
```

실제 작업 공간은 `<ws>/data/raw/`에 원본을 두고 `문서 → + 문서 등록`(또는 `python -m kg.v3 watch --ws <ws>`)으로 등록한다.
원본 폴더(하위 포함)를 한 번에 등록: `문서 → + 문서 등록 → 폴더 → 이 폴더 전체 등록`,
또는 `python -m kg.v3 register --ws <ws> --directory <폴더>`. 미리보기는 Reader 없이 stat·해시 캐시만 보므로 파일이 수천 개라도 빠르고,
변경 없는 문서는 건너뛰어 같은 폴더를 다시 돌리는 비용이 싸다(다시 읽으려면 `변경 없는 문서·잠긴 문서도 다시 읽기` 또는 `--include-unchanged`).
등록은 Reader 프로세스 1회로 시트·구조 서명·approved 프로파일 매치를 함께 계산하고, 매치가 `identical`이면 사람 개입 없이
자동 승인·추출·발행한다(근거는 [v3-decisions §1](docs/design/v3-decisions.md)). 나머지는 `작업 내역`의 검수 큐로 간다.

## 5개 화면 + Source Review

1. **문서** — 원본을 찾고 상태(정상·검수 필요·변경 감지·프로파일 없음·재추출 필요·파싱 실패·잠김)를 확인하고 데이터 빌드 대상으로 고른다. 등록은 파일 체크박스 또는 폴더 하나 지정(하위 폴더까지 한 작업, 진행률·요약 표시). 상세: 파일 보기(실제 셀 렌더)·추출 결과·적용 프로파일·연결 스키마.
2. **파싱 프로파일** — 문서 양식별로 값을 찾는 규칙(JSON DSL 3.0: sheet role · 이름 앵커/composite · range/find/regex/relative · relations · 정규화). 외부 프로파일 JSON은 Import Adapter가 canonical로 바꾸고, 실제 문서로 테스트한 뒤 대표 문서로 승인한다.
3. **파싱 스키마** — 공통 데이터 의미(필드·타입·단위·alias·계층)를 트리/그래프로 보고, 필드에서 사용 프로파일·연관 문서·원본까지 추적한다.
4. **데이터 빌드** — 문서 선택 → 스키마 → 출력 Header 편집·순서 → 미리보기(값마다 원본 보기) → CSV/XLSX/SQLite + manifest.json. 영속 Integration 객체는 없다.
5. **작업 내역** — 같은 원인·같은 양식을 묶은 검수 큐(신규 양식·매핑 검수·파싱 실패·변경 감지·충돌)와 작업 이력. 묶음 처리(프로파일 배정·모두 승인·재파싱)는 요청 1회.
- **Source Review** — 어디서나 `원본 보기`로 여는 검수 작업공간. 별도 렌더 서버의 창 단위 캐시로 실제 셀·병합·이미지를 보이고 key/value/unit/context overlay 위에서 승인·수정·반려한다.

## CLI

```bash
python -m kg.v3 serve | render-serve | watch | register | migrate | import-schema | import-profile | build | seed-demo
python -m kg.v3 register --ws /tmp/v3 --directory 2024/공정        # 폴더 아래 전부 등록(요약 JSON, 실패 행이 있으면 종료 코드 1)
python -m kg.v3 watch --ws /tmp/v3                                 # raw 폴더 감시 → 등록 + 자동 적용(기본 하위 폴더 포함, --no-recursive로 최상위만)
python -m kg.v3 migrate --ws /tmp/v3 --from-ws domains/financier --report report.json   # v2 작업 공간 이관
```

환경변수는 [.env.sample](.env.sample) 참고(`KG_V3_RENDER_URL`, `KG_V3_READER_FACTORY`(DRM Reader), `KG_V3_ACCESS_TOKEN` 등). `kg.webapp`(v1 서버)에도 `/api/v3`가 함께 설치된다.

## 테스트

```bash
python -m pytest                       # 백엔드 전체 (v1 · v2 · v3)
cd frontend && npm test                # 컴포넌트 (v2 · v3 — 용어·ID 비노출·진입 호출 수 규칙 포함)
cd e2e && npm run test:v3              # v3 브라우저 시나리오 (임시 작업 공간 + 렌더 서버 8032)
cd e2e && npm run test:v2              # v2 브라우저 시나리오 (?v2=1)
```

CI: [.github/workflows/v3.yml](.github/workflows/v3.yml)이 push/PR마다 위 전부를 실행한다. 사전 설치 Chromium을 쓰려면 `KG_E2E_CHROMIUM_PATH`를 지정한다([e2e/README.md](e2e/README.md)).

## 이전 런타임 (v1 · v2)

- **v2** — versioned extraction(`kg/v2/`, 34테이블). `python -m kg.v2 --ws <ws>`로 실행, 화면은 `?v2=1`. 구조와 결정은 [docs/ARCHITECTURE_V2.md](docs/ARCHITECTURE_V2.md)·[docs/design/v2-decisions.md](docs/design/v2-decisions.md). v3 이관은 `python -m kg.v3 migrate`.
- **v1** — Fixed Domain KG(`kg/`, `kg.db`). `python -m kg.webapp --ws domains/financier --port 8010`, 화면은 `?v1=1`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)·[kg/README.md](kg/README.md)·[docs/MIGRATION.md](docs/MIGRATION.md).
- 파서 라이브러리 `src/`(Inspector/RegionDetector/UnitRegistry/RecordBuilder)는 v1·v3 빌드가 재사용한다.

운영 참고: DRM(암호화) 문서는 운영자가 등록한 Reader factory(`KG_V3_READER_FACTORY`)로만 읽으며, 해제본 파일이나 SaveAs 우회를 만들지 않는다.
사내 DRM 컨테이너 판별 시그니처는 `KG_DRM_MAGIC`으로 주입한다. 작업 이력은 [docs/PROGRESS.md](docs/PROGRESS.md).
