# Semantic Excel Integration

NASCA/DRM 등으로 보호된 사내 Excel 문서를 **검증된 파싱 스키마(무엇)와 파싱 프로파일(어떻게)**로
정형화된 단일 테이블 데이터로 바꾸어 공정/분석 Agent에 제공하는 **Secure Document-to-Table Adapter**다.
Agent는 원본의 물리 양식·DRM·병합 셀·단위를 알 필요 없이 표준 테이블만 소비하고, 모든 추출값은
원본 Sheet/Range까지 추적된다. 최종 CSV/XLSX/SQLite는 필요할 때 만드는 산출물이지 새로운 Source of Truth가 아니다.

런타임은 `schema/` 하나다. 설계 근거와 결정은 `docs/`에 있다.

| 문서 | 내용 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | ERD·모듈·시퀀스·API 지도·프런트 구조·운영 |
| [docs/design/contracts.md](docs/design/contracts.md) | 코드 단위 계약(테이블·DSL·서비스 규칙·렌더 서버·API·화면·E2E·CLI·테스트) |
| [docs/design/decisions.md](docs/design/decisions.md) | 설계 문서끼리 갈린 지점의 결정과 근거 |
| [docs/design/system-identity-and-scope.md](docs/design/system-identity-and-scope.md) · [parsing-core-schema.md](docs/design/parsing-core-schema.md) · [ui-development-spec.md](docs/design/ui-development-spec.md) · [drm-viewer-render-architecture.md](docs/design/drm-viewer-render-architecture.md) | 시스템 정체성 · 18개 코어 스키마 · 승인된 UI 기준안 · 렌더 서버 아키텍처 |
| [docs/e2e-results.md](docs/e2e-results.md) | 브라우저 E2E 실행 결과와 완료 조건 대조표 |

## 구성

```
schema/      런타임 — 파싱 스키마/프로파일 projection, Reader 계약(격리 프로세스), DSL 3.0 검증·컴파일,
             Import Adapter(3.0·이전 세대 템플릿·generic), 추출 엔진, 매핑 검수(CAS)·발행, 데이터 빌드,
             검수 큐, FastAPI /api, 렌더 서버(schema/render/), 원본 폴더 감시(schema/filewatch.py)
db/          코어 18개 테이블 DDL — schema_sqlite.sql(SQLite) · schema_postgres.sql(PostgreSQL 번역)
frontend/    React + TypeScript. 화면은 src/app/(문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역
             + Source Review 오버레이). 빌드(dist)가 커밋되어 서버가 루트 /에 바로 서빙한다
e2e/         Playwright 브라우저 시나리오(e2e/specs, 렌더 서버 별도 프로세스)
examples/demo/  E2E·데모용 가상 작업 공간 시드(스키마·프로파일·문서 6종)
tests/       백엔드 회귀 (python -m pytest)
```

작업 공간(`<ws>`) 레이아웃 — 정의 파일이 진실이고 DB는 projection, `data/` 아래는 모두 다시 만들 수 있다.

```
<ws>/workspace.db        런타임 SQLite (schema_meta.version = 3)
<ws>/schemas/<schema_key>/r0001.json    파싱 스키마 정의(리비전별) + current.json
<ws>/profiles/<profile_id>/r0001.json   파싱 프로파일 정의(리비전별) + current.json
<ws>/data/raw/           원본 문서(하위 폴더 허용)
<ws>/data/exports/<build_key>/  데이터 빌드 산출물 + manifest.json
<ws>/data/render-cache/  렌더 밴드 캐시(스냅샷별, 재생성 가능)
<ws>/config/units.yaml   단위 변환표(선택 — 없으면 같은 단위만 출력)
<ws>/.env                이 작업 공간에만 적용할 환경변수(선택)
```

## 빠른 시작

```bash
pip install -e ".[web,test]"

# 가상 문서·스키마·프로파일이 들어 있는 작업 공간을 만든다 (사용자 원본을 읽지 않는다)
python -m schema seed-demo --workspace /tmp/demo-ws

# 렌더 서버(별도 프로세스)와 메인 API/UI
python -m schema render-serve --ws /tmp/demo-ws --port 8032 &
SCHEMA_RENDER_URL=http://127.0.0.1:8032 python -m schema serve --ws /tmp/demo-ws --port 8010
#  → http://localhost:8010/   (SCHEMA_RENDER_URL이 없으면 같은 프로세스 안의 렌더 워커를 쓴다)
```

실제 작업 공간은 `<ws>/data/raw/`에 원본을 두고 `문서 → + 문서 등록`(또는 `python -m schema watch --ws <ws>`)으로 등록한다.
원본 폴더(하위 포함)를 한 번에 등록: `문서 → + 문서 등록 → 폴더 → 이 폴더 전체 등록`,
또는 `python -m schema register --ws <ws> --directory <폴더>`. 미리보기는 Reader 없이 stat·해시 캐시만 보므로 파일이 수천 개라도 빠르고,
변경 없는 문서는 건너뛰어 같은 폴더를 다시 돌리는 비용이 싸다(다시 읽으려면 `변경 없는 문서·잠긴 문서도 다시 읽기` 또는 `--include-unchanged`).
등록은 Reader 프로세스 1회로 시트·구조 서명·approved 프로파일 매치를 함께 계산하고, 매치가 `identical`이면 사람 개입 없이
자동 승인·추출·발행한다(근거는 [decisions.md §1](docs/design/decisions.md)). 나머지는 `작업 내역`의 검수 큐로 간다.

## 5개 화면 + Source Review

1. **문서** — 원본을 찾고 상태(정상·검수 필요·변경 감지·프로파일 없음·재추출 필요·파싱 실패·잠김)를 확인하고 데이터 빌드 대상으로 고른다. 등록은 파일 체크박스 또는 폴더 하나 지정(하위 폴더까지 한 작업, 진행률·요약 표시). 상세: 파일 보기(실제 셀 렌더)·추출 결과·적용 프로파일·연결 스키마.
2. **파싱 프로파일** — 문서 양식별로 값을 찾는 규칙(JSON DSL 3.0: sheet role · 이름 앵커/composite · range/find/regex/relative · relations · 정규화). 외부 프로파일 JSON은 Import Adapter가 canonical로 바꾸고, 실제 문서로 테스트한 뒤 대표 문서로 승인한다.
3. **파싱 스키마** — 공통 데이터 의미(필드·타입·단위·alias·계층)를 트리/그래프로 보고, 필드에서 사용 프로파일·연관 문서·원본까지 추적한다.
4. **데이터 빌드** — 문서 선택 → 스키마 → 출력 Header 편집·순서 → 미리보기(값마다 원본 보기) → CSV/XLSX/SQLite + manifest.json. 영속 Integration 객체는 없다.
5. **작업 내역** — 같은 원인·같은 양식을 묶은 검수 큐(신규 양식·매핑 검수·파싱 실패·변경 감지·충돌)와 작업 이력. 묶음 처리(프로파일 배정·모두 승인·재파싱)는 요청 1회.
- **Source Review** — 어디서나 `원본 보기`로 여는 검수 작업공간. 별도 렌더 서버의 창 단위 캐시로 실제 셀·병합·이미지를 보이고 key/value/unit/context overlay 위에서 승인·수정·반려한다.

## CLI

```bash
python -m schema serve | render-serve | watch | register | import-schema | import-profile | build | seed-demo

python -m schema register --ws <ws> --directory 2024/공정   # 폴더 아래 전부 등록(요약 JSON, 실패 행이 있으면 종료 코드 1)
python -m schema watch --ws <ws>                            # raw 폴더 감시 → 등록 + 자동 적용(기본 하위 폴더 포함, --no-recursive로 최상위만)
python -m schema import-schema --ws <ws> --file schema.json # 정의 파일 → 새 리비전
python -m schema build --ws <ws> --schema <schema_key> --documents <id> ... --format xlsx --out ./out
```

서브커맨드를 생략하면 `serve`로 해석한다(`python -m schema --ws <ws> --port 8010`).
모든 명령은 시작할 때 `<ws>/.env`와 `./.env`를 읽는다([schema/env.py](schema/env.py); 이미 export된 변수가 우선).
키 목록은 [.env.sample](.env.sample)에 있다 — `SCHEMA_RENDER_URL`, `SCHEMA_READER_FACTORY`(DRM Reader),
`SCHEMA_ACCESS_TOKEN`, `SCHEMA_REGISTER_DIRECTORY_LIMIT` 등.

## 테스트

```bash
python -m pytest                       # 백엔드 회귀
cd frontend && npm ci && npm test      # 컴포넌트 (용어·import 금지·ID 비노출·진입 호출 수 규칙 포함)
cd frontend && npm run build           # dist/ 갱신 (dist는 커밋 대상)
cd e2e && npm ci && npm test           # 브라우저 시나리오 (임시 작업 공간 + 렌더 서버 8032)
```

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml)이 push/PR마다 위 전부를 실행한다.
사전 설치 Chromium을 쓰려면 `SCHEMA_E2E_CHROMIUM_PATH`를 지정한다([e2e/README.md](e2e/README.md)).

## 운영

- DRM(암호화) 문서는 운영자가 등록한 Reader factory(`SCHEMA_READER_FACTORY`)로만 읽으며, 해제본 파일이나 SaveAs 우회를 만들지 않는다.
  Reader는 시간·메모리 한도가 걸린 격리 프로세스에서 돌고(`SCHEMA_READER_TIMEOUT_SECONDS`·`SCHEMA_READER_MEMORY_MB`),
  기본 Reader는 `local-xlsx`(평문 xlsx)만 다룬다.
- 백업 대상은 `<ws>/schemas/`·`<ws>/profiles/`(정의 = 진실)와 `<ws>/data/raw/`다. `<ws>/workspace.db`와
  `<ws>/data/exports/`·`<ws>/data/render-cache/`는 정의와 원본에서 다시 만들 수 있어 Git에 넣지 않는다(.gitignore).
- 작업 이력은 [docs/PROGRESS.md](docs/PROGRESS.md).
