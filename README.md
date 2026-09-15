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
| [docs/design/drm-integration.md](docs/design/drm-integration.md) | 보호 문서 해제 경로 선택지와 DRM 운영 담당자 확인 목록 |
| [docs/e2e-results.md](docs/e2e-results.md) | 브라우저 E2E 실행 결과와 완료 조건 대조표 |

## 구성

```
schema/      런타임 — 파싱 스키마/프로파일 projection, Reader 계약(격리 프로세스), 보호 문서 접근(schema/drm.py),
             DSL 3.0 검증·컴파일, Import Adapter(3.0·이전 세대 템플릿·generic), 추출 엔진, 매핑 검수(CAS)·발행,
             데이터 빌드, 검수 큐, FastAPI /api, 렌더 서버(schema/render/), 원본 폴더 감시(schema/filewatch.py)
db/          코어 18개 테이블 DDL — schema_sqlite.sql(SQLite) · schema_postgres.sql(PostgreSQL 번역)
frontend/    React + TypeScript. 화면은 src/app/(문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역
             + Source Review 오버레이). 빌드(dist)가 커밋되어 서버가 루트 /에 바로 서빙한다
e2e/         Playwright 브라우저 시나리오(e2e/specs, 렌더 서버 별도 프로세스)
examples/demo/  E2E·데모용 가상 작업 공간 시드(스키마·프로파일·문서 6종)
tests/       백엔드 회귀 (python -m pytest)
```

작업 공간(`<ws>`) 레이아웃 — 정의 파일이 진실이고 DB는 projection, `data/` 아래는 감사 기록(`audit/`)만 빼면 다시 만들 수 있다.

```
<ws>/workspace.db        런타임 SQLite (schema_meta.version = 3)
<ws>/schemas/<schema_key>/r0001.json    파싱 스키마 정의(리비전별) + current.json
<ws>/profiles/<profile_id>/r0001.json   파싱 프로파일 정의(리비전별) + current.json
<ws>/data/raw/           원본 문서(하위 폴더 허용)
<ws>/data/exports/<build_key>/  데이터 빌드 산출물 + manifest.json
<ws>/data/render-cache/  렌더 밴드 캐시(스냅샷별, 재생성 가능)
<ws>/data/audit/         보호 문서 접근 기록 drm-<YYYYMMDD>.jsonl (append-only, 재생성 불가)
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

1. **문서** — 원본을 찾고 상태(정상·검수 필요·변경 감지·프로파일 없음·재추출 필요·파싱 실패·잠김)를 확인하고 데이터 빌드 대상으로 고른다. 등록은 파일 체크박스 또는 폴더 하나 지정(하위 폴더까지 한 작업, 진행률·요약 표시). 잘못 등록한 문서는 행을 골라 `삭제`로 치운다(단건·다중, `원본 파일도 함께 지우기`는 기본 해제). 상세: 파일 보기(실제 셀 렌더)·추출 결과·적용 프로파일·연결 스키마.
2. **파싱 프로파일** — 문서 양식별로 값을 찾는 규칙(JSON DSL 3.0: sheet role · 이름 앵커/composite · range/find/regex/relative · relations · 정규화). 목록의 버튼은 `+ 새 프로파일` 하나이고, 빈 골격으로 시작하거나 외부 정의를 붙여넣거나 파일로 올린다(형식 자동 판별 — Import Adapter가 canonical로 바꾼다). 상세는 **탭 없는 한 화면**이다: 요약줄 + 정의 JSON 편집기(저장하면 새 리비전) + `테스트`(문서를 고르면 Source Review 테스트 모드) + `변경 이력`. 테스트는 저장된 리비전으로만 돌고, 대표 문서로 승인하면 재파싱이 소급한다.
3. **파싱 스키마** — 공통 데이터 의미(필드·타입·단위·alias·계층)를 트리/그래프로 보고, 필드에서 사용 프로파일·연관 문서·원본까지 추적한다. `+ 새 스키마`는 **생성 전용**이라 이미 있는 키를 덮어쓰지 않고(409), 새 리비전은 스키마를 열어 `새 리비전`으로 저장한다. 더 쓰지 않을 스키마는 `폐기`로 목록에서 내리고(언제든 `폐기 해제`), 스키마·필드 **삭제**는 쓰는 곳이 하나도 없을 때만 되며 쓰이고 있으면 어느 프로파일·규칙이 잡고 있는지 알려 준다.
4. **데이터 빌드** — 문서 선택 → 스키마 → 출력 Header 편집·순서 → 미리보기(값마다 원본 보기) → CSV/XLSX/SQLite + manifest.json. 영속 Integration 객체는 없다.
5. **작업 내역** — 같은 원인·같은 양식을 묶은 검수 큐(신규 양식·매핑 검수·파싱 실패·변경 감지·충돌)와 작업 이력. 묶음 처리(프로파일 배정·모두 승인·재파싱)는 요청 1회.
- **Source Review** — 어디서나 `원본 보기`로 여는 검수 작업공간. 별도 렌더 서버의 창 단위 캐시로 실제 셀·병합·이미지를 보이고 key/value/unit/context overlay 위에서 승인·수정·반려한다.

## 만들고 고치고 치우는 법 (한눈에)

진실은 `<ws>/data/raw`의 **원본 파일**과 `<ws>/schemas`·`<ws>/profiles`의 **정의 파일** 둘뿐이다.
그래서 치우는 길이 둘로 갈린다 — **문서는 진짜 지우고, 정의는 지우지 않고 폐기한다**(근거는 [decisions.md §19](docs/design/decisions.md)).

| 대상 | 만들기 | 고치기 | 치우기 |
|---|---|---|---|
| **문서** | `+ 문서 등록`(파일 체크박스 · 폴더 하나로 하위 전부) · `python -m schema register`/`watch` | 같은 파일의 내용이 바뀌면 **새 snapshot**으로 승계된다(문서를 고치는 것이 아니다) | **삭제**(단건 · 목록 선택 바로 다중, 한 번에 200개까지). 그 문서의 snapshot·시트·영역·적용 건·매핑·리비전·추출 실행·값이 함께 사라진다. `원본 파일도 함께 지우기`(기본 해제)를 고르지 않으면 `data/raw`의 원본은 남고, 다시 등록하면 같은 문서가 만들어진다 |
| **파싱 스키마** | `+ 새 스키마`(생성 전용 — 있는 키는 409) · `python -m schema import-schema` | `새 리비전`·`이름 바꾸기`·필드 추가/편집/삭제 — 리비전을 **쌓는다**(정의 파일 `r0001.json`, `r0002.json`, …) | **폐기**(`폐기 해제`로 되돌릴 수 있다): 목록 기본·새 프로파일 대상·데이터 빌드 선택에서 빠진다. **삭제**는 쓰는 프로파일·적용 기록이 **하나도 없을 때만** |
| **파싱 프로파일** | `+ 새 프로파일`(빈 골격 · 붙여넣기 · 파일 업로드) · `python -m schema import-profile` | 정의 JSON을 저장하면 **새 리비전**. `대표 문서 지정`으로 승인하면 재파싱이 소급한다 | **폐기**(`승인`으로 되살린다): 새 문서에 자동 적용되지 않는다. **삭제**는 적용된 문서가 **하나도 없을 때만** |

- 폐기한 스키마라도 **이미 승인된 프로파일은 새 문서에 계속 적용된다** — 그것을 멈추는 것은 프로파일 폐기다.
- 대표 문서를 지우면 그 프로파일은 **초안으로 내려간다**(승인의 근거가 사라졌다). 대표 문서를 다시 지정해 승인한다.
- 지울 수 없는 것을 누르게 하지 않는다: 화면은 삭제가 가능할 때만 `삭제`를 그리고, 그래도 막히면 어느 프로파일·규칙·문서가 잡고 있는지 말해 준다.
- 지운 내용은 `작업 내역`에 남는다(문서명·원본 경로·지운 snapshot/적용 건/매핑/실행/값 수·원본 파일 삭제 여부·요청자).

## CLI

```bash
python -m schema serve | render-serve | watch | register | drm-probe | import-schema | import-profile | build | seed-demo

python -m schema register --ws <ws> --directory 2024/공정   # 폴더 아래 전부 등록(요약 JSON, 실패 행이 있으면 종료 코드 1)
python -m schema watch --ws <ws>                            # raw 폴더 감시 → 등록 + 자동 적용(기본 하위 폴더 포함, --no-recursive로 최상위만)
python -m schema import-schema --ws <ws> --file schema.json # 정의 파일 → 새 리비전
python -m schema build --ws <ws> --schema <schema_key> --documents <id> ... --format xlsx --out ./out
python -m schema drm-probe --ws <ws> [--source 2024/a.xlsx] [--unlock] [--json]  # 보호 문서 점검
```

서브커맨드를 생략하면 `serve`로 해석한다(`python -m schema --ws <ws> --port 8010`).
모든 명령은 시작할 때 `<ws>/.env`와 `./.env`를 읽는다([schema/env.py](schema/env.py); 이미 export된 변수가 우선).
키 목록은 [.env.sample](.env.sample)에 있다 — `SCHEMA_RENDER_URL`, `SCHEMA_READER_FACTORY`(보안 읽기 어댑터),
`SCHEMA_DRM_*`(해제 세션), `SCHEMA_RENDER_TOKEN`(렌더 서버 내부 bearer), `SCHEMA_REGISTER_DIRECTORY_LIMIT` 등.

## 테스트

```bash
python -m pytest                       # 백엔드 회귀
cd frontend && npm ci && npm test      # 컴포넌트 (용어·import 금지·ID 비노출·진입 호출 수 규칙 포함)
cd frontend && npm run build           # dist/ 갱신 (dist는 커밋 대상)
cd e2e && npm ci && npm test           # 브라우저 시나리오 (임시 작업 공간 + 렌더 서버 8032)
```

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml)이 push/PR마다 위 전부를 실행한다.
사전 설치 Chromium을 쓰려면 `SCHEMA_E2E_CHROMIUM_PATH`를 지정한다([e2e/README.md](e2e/README.md)).

## 보호 문서(DRM) 설정

**보호 문서가 기본이고 평문 OOXML이 예외다.** 확장자가 아니라 원본 **앞 32바이트**로 컨테이너를 판별한다.
순서대로 먼저 맞는 것을 쓴다: `SCHEMA_DRM_MAGIC`에 등록한 운영자 시그니처(보호) → `PK`(평문 OOXML) →
`D0CF11E0`(OLE2/CFB, 보호) → **그 밖 전부(보호)**. 운영자 시그니처가 `PK`보다 앞인 이유는 평문처럼 보이는 래퍼를
운영자가 선언할 수 있어야 하기 때문이다.
보호 문서는 잠금으로 끝내지 않고 운영자가 연결한 **보안 읽기 어댑터**로 넘어가고, 어댑터가 없을 때만
`DRM_READER_REQUIRED`(403)로 남는다. 그 문구는 잠겼다고만 말하지 않고 무엇을 설정해야 하는지 알려 준다.

```bash
# 1) 어댑터를 연결한다 (<모듈>:<함수> 하나. 저장소 안의 윈도우 Excel COM 참조 구현은 schema.drm:excel_com_reader)
export SCHEMA_READER_FACTORY=approved_package.reader:factory
# 2) 평문처럼 보이는 벤더 컨테이너가 있으면 시그니처를 알려 준다 (hex:/ascii:, 쉼표 구분)
export SCHEMA_DRM_MAGIC=hex:0a0b0c0d,ascii:NASCA
# 3) 이 서버가 실제로 읽을 수 있는지 확인한다 (--unlock이면 한 번 해제해 보고 그 자리에서 지운다)
python -m schema drm-probe --ws <ws> --unlock
#    종료 코드 0 전부 정상 · 1 해제 실패 · 2 어댑터 설정 없음. 화면에서는 `설정 → Reader` 카드가 같은 값을 보여 준다.
```

- **해제 비용은 snapshot마다 한 번**이다. 세션 키가 문서 내용 해시(`change_token`)라 같은 snapshot의
  등록·매치·추출·원본 보기는 한 번 해제한 파일을 다시 쓴다. `SCHEMA_DRM_CACHE_TTL_SECONDS=0`이면
  재사용 없이 연산마다 해제하고 끝나는 즉시 지운다(보안 우선 배치).
- **해제본은 작업 공간 안에 만들지 않는다.** 위치는 `SCHEMA_DRM_TEMP_DIR`(기본 `<OS 임시>/schema-drm-<uid>`,
  폴더 0700·파일 0600)이고, 작업 공간 안을 가리키면 서버가 `DRM_TEMP_IN_WORKSPACE`로 시작을 거부한다.
  서버는 시작할 때 지난 해제본을 통째로 비운다.
- **모든 접근이 남는다**: `<ws>/data/audit/drm-<YYYYMMDD>.jsonl`(append-only, 0600)과 작업 결과의
  `drm{unlocked, reused, failed}`. 해제본 경로·자격 증명·파일 내용은 기록하지 않는다.
- Reader는 시간·메모리 한도가 걸린 격리 프로세스에서 돈다(`SCHEMA_READER_TIMEOUT_SECONDS`·`SCHEMA_READER_MEMORY_MB`).
  어댑터가 없으면 기본 Reader는 `local-xlsx`(평문 xlsx)만 다룬다.
- 윈도우 Excel COM 참조 구현은 **기본으로 연결되지 않는다**. 쓰려면 Windows + Excel + 대화형 로그인 세션이 필요하고
  동시 실행은 1이다(`SCHEMA_RENDER_CONCURRENCY=1` + `SCHEMA_DRM_COM_LOCK`, `SCHEMA_READER_CONTEXT=spawn` 권장).
  해제 경로 선택지와 담당자 확인 목록은 [docs/design/drm-integration.md](docs/design/drm-integration.md).

## 운영

- **메인 API에는 사용자 인증이 없다.** `python -m schema serve`는 기본으로 `127.0.0.1`에만 바인딩하고,
  `--host`로 그 밖에 열면 시작할 때 경고 한 줄이 나온다 — 앞단(리버스 프록시 등)에 인증을 두는 것은 운영자 책임이다.
  렌더 서버와 메인 서버가 주고받는 내부 bearer(`SCHEMA_RENDER_TOKEN`)는 서버 대 서버라 그대로 있고,
  루프백이 아닌 주소로 `render-serve`를 열려면 반드시 설정해야 한다.
  인증이 없는 자리는 **출처 검사**가 메운다: `/api/*`는 `Host`가 `127.0.0.1`·`localhost`·`[::1]`(또는
  `SCHEMA_ALLOWED_HOSTS`에 적은 이름)이 아니면 400 `HOST_NOT_ALLOWED`로 끊고, 교차 출처 쓰기는 403으로 막는다
  (DNS 리바인딩으로 아무 웹 페이지나 루프백 API를 부르는 것을 막는 유일한 방어다).
  옛 `SCHEMA_ACCESS_TOKEN`은 `SCHEMA_RENDER_TOKEN`으로 이름이 바뀌었다 — 옛 이름만 남아 있으면 시작할 때
  경고와 함께 그 값을 쓰지만(이번 릴리스까지), `.env`의 키 이름을 바꾸는 편이 낫다.
- 백업 대상은 `<ws>/schemas/`·`<ws>/profiles/`(정의 = 진실)와 `<ws>/data/raw/`다. `<ws>/workspace.db`와
  `<ws>/data/exports/`·`<ws>/data/render-cache/`는 정의와 원본에서 다시 만들 수 있어 Git에 넣지 않는다(.gitignore).
  `<ws>/data/audit/`의 보호 문서 접근 기록은 다시 만들 수 없다.
- 작업 이력은 [docs/PROGRESS.md](docs/PROGRESS.md).
