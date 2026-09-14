# 진행 로그

작업 단위(=커밋)마다 한 항목씩 기록한다. 상세 근거·검증 방법은 각 커밋
메시지에 있고, 여기는 흐름을 한눈에 보는 색인이다. 최신이 위.

## 2026-09-14 — 재설계·레거시 정리 (claude/system-redesign-e2e-docs)

- **정리 리뷰 반영 — 이름공간 잔재·죽은 코드 제거 + 조용한 실패 방지 2건** (이 커밋 — 아래 정리 항목에 대한 리뷰 반영)
  - 프런트 이름공간: 경로만 바뀌고 남아 있던 `v3` 이름을 실제 이름까지 옮겼다 —
    CSS 루트 클래스 `.v3` → `.app`, 클래스·DOM id 접두 `v3-` → `app-`, 토큰 `--v3-*` → `--app-*`,
    브라우저 저장소 키 `v3.token`·`v3.build.draft`·`v3.build.columns`·`v3.profile.draft` → `schema.*`,
    테스트 픽스처 `v3Fixture` → `appFixture`. `frontend/src`·`frontend/tests`·`e2e/specs` 세 곳을 같은 커밋에서 바꿔
    셀렉터 계약이 어긋나지 않는다. 남은 `v3`는 스키마·프로파일 **리비전 표시**(`… v3`)뿐이다
  - 죽은 값 제거: 이관 도구를 지웠는데 남아 있던 작업 종류 `migrate`를 DDL CHECK·API `JobKind`·
    화면 라벨·계약 문서에서 함께 뺐다(작업 내역의 빈 '마이그레이션' 필터가 사라진다).
    `UnitRegistry`는 빌드가 실제로 쓰는 것만 남기고(`load`·`normalize_unit`·`dimensions_of` + 새 `factor_offset`),
    `build.py`가 private `_params`를 뚫던 자리를 공개 접근자로 바꿨다(Decimal 산술은 그대로).
    v1 시절 작업 공간 파일 `config/concepts.yaml`·`relations.yaml`·`parser_rules.yaml`과
    `profileDraft.ts`의 호출자 없는 export를 지웠다
  - 조용한 실패 방지(호환 껍데기가 아니라 한 번 짚고 멈추는 안전장치): 옛 위치(`<ws>/data/kg/v3.db`)에 DB가 있는데
    `<ws>/workspace.db`가 없으면 빈 DB를 만들지 않고 409 `WORKSPACE_DB_MOVED`로 멈춘다(문서가 전부 사라진 것처럼 보이던 경로).
    옛 접두(`KG_V3_*`·`KG_V2_*`·`KG_E2E_*`·`KG_DRM_*`) 환경변수가 설정돼 있으면 시작할 때 stderr로 한 번 경고한다
    (옛 이름만 남은 배포에서 접근 토큰이 소리 없이 꺼지던 경로). 폴백은 만들지 않았다
  - 계약 절 번호 정리: 이관 절 삭제 뒤 §10 CLI → §9 · §11 테스트 → §10으로 바뀐 것을 코드·테스트 주석 9곳에 반영,
    없는 심볼을 가리키던 계약 §2.1 `readers.XlsxReader.region` → `engine.region`
  - 검증: `python3 -m pytest tests -q` **205 passed · 47 subtests**(45.2s) ·
    `frontend: npx vitest run` **15 files / 150 tests passed**(32.0s) + `npm run build` ·
    `e2e: npm test` **21 passed**(2.7m, 연속 3회). `docs/e2e-results.md` §3 로그·§5 수치를 현재 트리 실행으로 교체

- **레거시 삭제 · `kg` → `schema` 개명 · 작업 공간 경로 정리** (이 커밋)
  - 무엇: 저장소에 함께 있던 이전 세대 런타임을 전부 지우고, 남은 하나의 이름을 구조에 맞췄다.
    `kg/`(v1 모듈 · `kg/v2/` 전부) · 파서 라이브러리 `src/` · 예제 작업 공간 `domains/` · v2→v3 이관 도구
    (`migrate.py`, CLI `migrate`, 관련 테스트·문서) · v1·v2 프런트 자산 · `e2e/v1`·`e2e/v2` · v1·v2 문서를 삭제했다.
    현행이 실제로 쓰던 것만 새 위치로 옮겼다: `spec.py`·`normalization.py`·`readers.py`(상속 없이 한 클래스)·
    `filewatch.py`·`units.py`. 하위 호환 shim(구 경로 re-export · 구 환경변수 폴백 · `/api/v3` 별칭)은 두지 않았다.
  - 이름: `kg/v3/*` → `schema/*`(v3 하위 패키지 없이 평탄화), `db/v3/*.sql` → `db/*.sql`,
    `frontend/src/v3/` → `frontend/src/app/`, `e2e/v3/` → `e2e/specs/` + `e2e/serve.py`,
    `tests/test_v3_*.py` → `tests/test_*.py`, API 접두 `/api/v3` → `/api`,
    환경변수 `KG_V3_*`·`KG_E2E_*` → `SCHEMA_*`·`SCHEMA_E2E_*`(폴백 없음), CLI `python -m kg.v3` → `python -m schema`
  - 작업 공간: DB 파일을 `<ws>/data/kg/v3.db` → **`<ws>/workspace.db`**로 옮겼다. `data/` 아래에는 다시 만들 수 있는
    것만 남는다(`raw/` 입력, `exports/`·`render-cache/` 파생). 런타임 경로·`.gitignore`·화면 어디에도 `data/kg`를 쓰지 않는다
    (옛 위치를 가리키는 곳은 `schema/db.py`의 안전장치 상수 하나와 그 근거를 적은 문서뿐이다).
    `schema_meta.version = 3`은 스키마 리비전 번호라 그대로 둔다
  - 검증: `python -m pytest -q` **205 passed · 47 subtests** (45.2s) · `cd frontend && npm test`
    **15 files / 150 tests passed** (32.0s). 브라우저 스위트는 `docs/e2e-results.md` 참고
  - 문서: v1·v2 문서 삭제(`ARCHITECTURE_V2.md`·`MIGRATION.md`·`IMPLEMENTATION_PLAN.md`·`design/db-schema-v2*`·
    `design/v2-*`·`design/ui-screen-definition.md`·`design/ui-wireframes.md`·`design/*dvc-minimal*`),
    `ARCHITECTURE_V3.md` → `ARCHITECTURE.md` · `e2e-results-v3.md` → `e2e-results.md` ·
    `design/v3-contracts.md` → `design/contracts.md` · `design/v3-decisions.md` → `design/decisions.md`(§12 추가),
    README 재작성(작업 공간 레이아웃 포함), CI `.github/workflows/v3.yml` → `ci.yml`(v2 단계 제거),
    `.claude/settings.json` deny 경로 갱신

- **설계 문서 기반 재설계·구현·E2E** (이 브랜치의 커밋 묶음)
  - 입력: `claude/data-gathering-schema-review-6kf0n9`의 설계 문서군(시스템 정체성·18개 코어 스키마·
    개발 기준안+승인 목업·렌더 서버 아키텍처)을 fast-forward 병합. 코드 단위 계약
    `docs/design/contracts.md`(적대적 검증 45건 반영), 문서 간 충돌 결정 `docs/design/decisions.md`
  - 백엔드 `schema/`·`db/`: 18개 코어 테이블(+런타임 2) DDL SQLite/PostgreSQL, 트리거 35개(불변·CAS·
    발행 조건·projection 보호), Parsing Profile DSL 3.0(이름 앵커·composite·regex·relations·split_delimiter),
    Import Adapter(3.0/v2/v1/generic), 추출 엔진·매치 판정, Reader 격리(forkserver), 서비스(등록 1회 Reader →
    자동 적용/승계/검수 CAS/추출/발행/프로파일 테스트·승인·재파싱/문서 상태 캐시), 데이터 빌드(CSV/XLSX/SQLite+manifest),
    검수 큐 5종(묶음 처리), FastAPI `/api`, 별도 렌더 서버(밴드 캐시·창 응답·asset·ETag/304·인증),
    v2→v3 이관, raw 감시. 적대적 리뷰 32건 중 31건 반영
  - 프런트 `frontend/src/app/`: 좌측 사이드바 5화면(문서·파싱 프로파일·파싱 스키마·데이터 빌드·작업 내역)+설정,
    Source Review 오버레이, 창 단위 가상화 SheetViewer, 출력 Header 편집, 트리/그래프 토글, 큐 묶음 처리;
    규칙 테스트(금지 용어·ID 비노출·v2 import 금지·진입 호출 ≤3·접근성). 기본 화면 v3, `?v2=1`/`?v1=1` 유지
  - E2E `e2e/specs/`: 감독 러너(렌더 서버 별도 프로세스, 스펙 파일마다 작업 공간 리셋), 스펙 7개·테스트 19개,
    결과·완료 조건 대조·측정값은 `docs/e2e-results.md`
  - 검증: `python -m pytest` 443 passed(DRM e2e 제외 시) · `npm test` 180 passed · `npm run test:v3` 19 passed(연속 3회) ·
    `npm run test:v2` 3 passed. CI `.github/workflows/v3.yml`
  - 문서: `docs/ARCHITECTURE.md`(ERD·모듈·시퀀스·API 지도), README/e2e/frontend/kg README, `.env.sample`
- **폴더 일괄 등록 — 루트 폴더 하나로 하위 파일 전부 등록** (이 커밋)
  - 무엇: 파일을 하나씩 고르는 대신 원본 폴더 하나를 지정하면 하위 폴더까지 전부 등록한다(계약 §4.1.1).
    미리보기는 Reader 프로세스 없이 stat과 내용 해시(Reader `change_token`과 같은 SHA-256)만 보고,
    해시는 `source_digest`(§1.6, `(byte_size, mtime_ns)` 키)에 캐시되어 같은 stat이면 파일을 읽지 않는다.
    기본 대상은 새 파일 + 변경된 문서라 같은 폴더 재실행이 싸고, 변경 없음·잠김은 체크박스로 다시 읽는다.
    작업은 진행률(completed/total)을 올리고, 파일 하나의 실패는 그 행의 사유로 남으며 요약이 결과물이다
    (전부 실패해도 작업은 succeeded, 스캔 자체의 실패만 failed). 새 snapshot은 여전히 검수 대기(proposed)다
  - 어디: `schema/service.py`(`scan_sources`·`register_directory`·`source_digest` 캐시), `schema/db.py`(런타임 테이블 `source_digest`),
    `schema/api.py`(`GET /sources/scan` · `POST /documents/register-directory`), `schema/__main__.py`(`register` 명령),
    `schema/watch.py`(기본 하위 폴더 감시, `--no-recursive`), `frontend/src/app/DocumentRegister.tsx`(폴더 미리보기·진행·요약 모드)
  - 테스트: `tests/test_register_directory.py` 17건 + `tests/test_watch.py` 5건 → `python -m pytest tests/test_register_directory.py tests/test_watch.py -q` **22 passed**.
    브라우저 시나리오는 `e2e/specs/register-directory.spec.ts`(결과는 `docs/e2e-results.md`)
  - 문서: `docs/ARCHITECTURE.md`(ERD에 `source_digest` — 22개 테이블·인덱스 39개, §2.1 일괄 등록 시퀀스, API 지도·프런트·테스트·운영),
    `docs/design/decisions.md` §11(변경 판정·실패 처리·잠긴 파일·승인 정책), README 빠른 시작·CLI, `.env.sample`(`SCHEMA_REGISTER_DIRECTORY_LIMIT`)

## 2026-09-07

- **레거시 일괄 삭제 — Phase 1** (이 커밋)
  - 유지보수 모드 모듈 삭제: src/{api,canonicalize,loader,export,pipeline.py,
    cli.py,dvc_adapter}, web/, scripts/build_report.py, dvc.legacy.yaml,
    docs/WEB_PLAN.md, 레거시 테스트 7종
  - RecordBuilder는 survey의 dry-run 매핑 엔진이라 파서 라이브러리로 이동
    (src/mapping/record_builder.py). survey 진입점은 `kg.cli survey`로 이관
  - README/.gitignore 레거시 표기 제거, MIGRATION 처분표 갱신.
    전체 103 passed + survey 스모크 확인

## 2026-09-06

- **레거시(src)/현행(kg) 경계 정리 — Phase 0** (이 커밋)
  - docs/MIGRATION.md 신설: 목표 아키텍처(Input/Versioning→Parser API→
    Document KG→Semantic Layer), 모듈 처분표(Parser library 코어 유지 /
    이관 완료 / kg가 흡수 / 유지보수 모드), 단계·규칙(레거시에 신규 기능
    금지, Parser library의 kg 비의존)
  - watcher 이관: src/watch → schema/filewatch.py, `kg.cli watch` 신설(raw 폴링→
    자동 ingest+map, DRM 잠김 스킵+해제본 도착 감지, 삭제 이벤트 무시).
    src.watch는 re-export 셔틀로 하위호환
  - DVC 현행화: dvc.yaml을 kg_ingest 스테이지(멱등 재적재)로 교체,
    레거시 canonical 스테이지는 dvc.legacy.yaml로 분리
  - semantic cache는 이관 불요로 판정 — ingest 해시 스킵·매핑 승계·빌드
    서명 재사용이 같은 역할을 kg에 내장. 테스트 2종 추가, 전체 159 passed
- **증분 빌드 + 조립 벌크화 + E2E 리포 편입** (b9f0e03)
  - 증분: 빌드 서명(구성+선택 노드의 현재 payload_id+단위 사전 버전)으로
    무변경 재빌드는 이전 산출물을 즉시 재사용 — 합성 600문서 기준
    19.4s → 0.0s. 문서 재적재·구성 변경·산출물 삭제는 서명/검사로 무효화,
    include_nodes 없는 자동 선택 구성은 안전측(재사용 금지)
  - 조립 벌크화: assemble_sources의 노드당 개별 조회(조상 탐색 포함
    노드당 10+쿼리)를 벌크 JOIN+튜플 커서로 — 600문서 조립 쿼리 수천→20개.
    unit_convert는 (src,tgt) 아핀 계수 사전계산. 직렬화(serialize_result)를
    락 밖으로 분리해 finalize의 락 보유 시간 단축
  - E2E를 리포로 편입: e2e/ 러너+시나리오 5종(셸/트리 빌드·다운로드/정규화
    프리셋/빌드 재사용/템플릿 N:M) — kg.db 자동 백업·원복, 현행 UI 기준.
    UI 변경 시 같은 커밋에서 갱신하는 규칙 명문화. 전체 23건 통과
  - 회귀: 재사용 서명 테스트(test_build_reuse.py) 추가, 전체 157 passed
- **머지(빌드) 병목 개선 — 정합성 캡 제거 + 락 밖 DAG + deepcopy 제거** (ad5525f)
  - /api/proposal의 node_ids[:500] 캡 제거 — 초과분이 조용히 빌드에서
    누락되던 정합성 버그(트리 일괄 선택 552개에서 이미 발생). 노드당
    3쿼리 → 청크(500) JOIN 배치 조회, 620노드 회귀 테스트 추가
  - 빌드를 prepare(락)→execute_dag(락 밖)→finalize(락) 3단계로 분리 —
    대형 빌드의 CPU 구간 동안 웹 서버가 계속 응답한다
  - run_dag 블록별 Frame deepcopy 제거(소유권 규약: 입력을 제자리 수정),
    산출/lineage 기록을 executemany 배치로
  - 실측(문서당 2천값 합성): 600문서 122만 셀 기준 DAG 66.8s→8.4s(8배),
    피크 메모리 1.9GB→0.9GB — 그리고 그 8.4s는 이제 락 밖
  - 전체 156 passed + 트리 선택→빌드 E2E 재통과
- **문서 갱신 — 정규화 레지스트리/개념 트리/다운로드 반영** (f35d755)
  - ARCHITECTURE.md: 모듈 다이어그램에 normalize 모듈·value_normalize·
    /api/normalizers·다운로드 라우트, 시퀀스 3.5를 새 빌드 흐름(트리 체크→
    프리셋→value_normalize→다운로드)으로 재작성, EL 플로우에 정규화 프리셋
    경로와 다운로드 추가, 불변식 5번(정규화 비고정) 신설. mermaid 15/15 재검증
  - README 3종: 통합 DB 항목을 3단계+트리+프리셋+다운로드로, 워크스페이스
    구성에 normalizers.yaml, kg 설계표에 §10 확장 행 추가
- **통합 DB 데이터 선택을 개념 트리로** (b0409a2)
  - 개념 드롭다운(평면 리스트) 제거 → 온톨로지 트리 + 체크박스.
    상위 개념 체크 시 하위 개념 소스가 일괄 담기고, 부분 선택은
    indeterminate, 해제도 서브트리 단위. 소스 없는 개념은 비활성
  - 양식 카드는 담긴 다중 개념의 소스를 합산해 표시(개념별 캐시,
    localStorage 복원 시 재확보)
  - 검증: Playwright 10건(트리 표시/상위→하위 일괄/합산/전체 해제/
    indeterminate/빌드) 통과, 전체 155 passed
- **정규화기 레지스트리 — 코드 고정 없이 툴처럼** (c25eb83)
  - kg/normalize.py: 원자 정규화기 카탈로그(trim_text/strip_thousands/
    percent_to_ratio/split_unit_suffix) — 코드는 작은 순수 연산만, 선언적
    파라미터만 허용(임의 코드 금지). 조합·선택은 전부 데이터:
    <작업 공간>/config/normalizers.yaml 프리셋 + 빌드 config rules
  - value_normalize DAG 블록: 노드/컬럼 단위 선언 적용, 분리된 단위는
    lineage.unit으로 unit_convert에 전달, 적용 이력(normalized)도 lineage에
  - GET /api/normalizers(카탈로그+프리셋), BuildReq.normalize_rules(프리셋
    id 참조), 통합 DB '양식별 전처리' 드롭다운에 프리셋 노출
  - parsing._convert_scalar의 하드코딩 변환 dict → UnitRegistry(units.yaml)
    우선, 레지스트리 없을 때만 최소 폴백
  - 검증: 단위 테스트 5종 + E2E('195 ℃' 텍스트 → 프리셋 적용 후 숫자,
    CSV 산출물까지 반영), 전체 155 passed
- **통합 DB: 3단계 단순화 + 산출물 다운로드(반환)** (2ce31de)
  - 화면을 `① 데이터 선택 → ② 스키마 확인 → ③ 생성·다운로드`로 재구성 —
    장식용 파이프라인 블록 제거, 빈 상태에 다음 행동 안내, 스키마 표를
    결과 컬럼 중심(이름/개념/위치 수/처리/상태)으로 축소
  - '반환' 실체화: GET /api/build/{id}/download (.db는 SQLite 파일 그대로,
    ?format=csv는 CSV) — 결과 패널에 다운로드 버튼 2종. 이전엔 서버 경로
    문자열만 보여줘 파일을 받을 방법이 없었다
  - 검증: Playwright 12건(3단계 표시·자동 반영·생성·다운로드 200 + SQLite
    매직/CSV 헤더 확인) + 다운로드 엔드포인트 회귀 테스트(404/410 포함),
    전체 150 passed
- **아키텍처 다이어그램 + 문서 정리** (1b65c58)
  - docs/ARCHITECTURE.md 신설 — mermaid 15개: DB ERD 6영역(온톨로지·매핑/
    트리·값/템플릿 N:M/뷰어·DRM/문서군·레시피·재크롤링/통합·lineage),
    모듈 다이어그램(백엔드+프론트), 시나리오 시퀀스 6종(등록/DRM/렌더
    우선순위/N:M 파싱/통합 빌드/재크롤링), EL 데이터 플로우 + 불변식 4개
  - 전 블록을 mermaid 11.4 실렌더로 검증(15/15). 루트에 흩어져 있던
    IMPLEMENTATION_PLAN.md·WEB_PLAN.md를 docs/로 이동, README 링크 갱신 —
    문서·자료는 docs/ 한곳에 모은다
- **템플릿 N:M 배정 + 템플릿 관리 페이지** (7b343d4)
  - 문서:템플릿 배정을 1:1 → N:M으로 확장 — 템플릿마다 파싱하려는 정보
    (관점)가 달라도 한 문서에 함께 배정된다. PK를 (document, version,
    template)로 재구축(구 DB는 KgStore가 열 때 자동 마이그레이션)
  - 배정 추가/해제(unassign)·override·버전 교체 감사·parse_run 상태가 전부
    템플릿 단위로 독립. 파싱은 배정이 여럿이면 template_id 지정 필수
  - /api/files는 JOIN 복제를 피해 templates 배열로 집계, 노드 상세/뷰어
    locator는 위치와 일치하는 매핑의 템플릿을 대표로 표기
  - 5번째 탭 '템플릿 관리' 신설 — 목록(라이프사이클·버전·배정 수)/생성
    (초기 spec 포함)/새 버전/라이프사이클 변경/추출 매핑 표/문서 배정·해제
  - 검증: 단위 테스트 3종(N:M 파싱 독립·override 비전염·마이그레이션) +
    Playwright 8건(생성→중복 배정→파일탭 배지 2개→해제 독립) + 149 passed
- **파일 분석 탭에 템플릿 배정 여부** (6a21b5e)
  - 파일 표에 '템플릿' 컬럼(이름 vN 배지 / 미배정, 정렬 가능) —
    해당되는 템플릿이 있는지 없는지는 파일 분석 탭에서 확인한다
  - 전체/템플릿 배정/미배정 필터 칩 + 검색이 템플릿 이름도 매칭
  - 검증: Playwright(컬럼·배지·필터 건수·검색·정렬) 7건 통과,
    데모 배정은 검증 후 DB 원복. pytest 146 passed
- **프론트 단일화 — web_kg 제거, React를 루트 / 에 서빙** (fa62724)
  - `kg/web_kg`(바닐라 JS UI) 삭제 — 프론트는 `frontend/`(React) 하나만 유지.
    빌드 산출물 `frontend/dist/`를 커밋 대상으로 전환(.gitignore 해제)하고
    `kg/webapp.py`가 루트 `/` 와 구 경로 `/app` 모두에 dist를 서빙(빌드가
    없으면 안내 문구). README 3종을 단일 프론트 기준으로 갱신
  - 문서군 선택 시 첫 템플릿의 문서 목록 표가 우측 사이드바에 자동으로
    펼쳐짐(클릭 없이) — 문서군당 1회만 자동, 이후 접기 상태는 사용자 조작 유지
  - 가드 테스트 재작성(tests/test_integrated_web_ui.py): web_kg 부재·4탭
    구조·핵심 기능 문구·루트 서빙(dist 커밋 포함)을 사실 기준으로 검증
  - 검증: Playwright(루트/·/app React 4탭, 문서군 선택→문서 5개 표 자동
    표시, 상세 그래프 템플릿 상자) + 전체 pytest 146 passed

## 2026-09-01

- **문서군 상세 패널 간소화**
  - 4타일 metric → 한 줄 요약(개념·문서·위치·값), 안내문 제거
  - 관리 기능(문서 추가·추출 레시피·재크롤링)을 '관리' 접힘으로 이동 —
    재크롤링 진행 중엔 자동으로 펼쳐짐. 패널 기본 화면은 제목/요약/템플릿
    카드/돌아가기만
- **문서군 상세 그래프도 템플릿 계층으로** (이 커밋)
  - 중앙 '문서군 상세' 그래프를 `문서군[개념](hull+개념 노드) → 템플릿
    상자(문서 N개, 기타 포함)`로 재구성 — 개별 문서 카드 제거. 템플릿
    상자를 누르면 우측 상세 패널의 문서 목록이 열린다(선택 상태 공유)
  - 계층 계산을 templateGroups 헬퍼로 공용화(그래프·패널 동일 로직)
- **개념 탐색 계층 정리 + 뒤로가기** (이 커밋)
  - 문서군 상세를 `문서군[개념] → 템플릿(파싱 스크립트 기준 분류) → 문서
    개수`까지만 표시 — '문서 N개'를 눌러야 문서 목록 표(문서/개념 수/위치/
    제외)가 열리고, 문서를 누르면 원본 데이터로 이동
  - 개념 개수 생략 없이 표기(좌측 문서군 카드·상세 metric·연결 카드)
  - 원본 데이터 화면에 '← 문서군으로' 뒤로가기 추가 (React /app)
- **인스펙터 개편: '추출된 키 → 값' 표 중심** (이 커밋)
  - 원본 데이터 우측 사이드바를 어떤 키에 어떤 값이 뽑혔는지 한눈에 보이는
    표(키/값/단위/셀 주소)로 재구성 — React·web_kg 공통. `/api/source`
    값 한도 8→200건 + 총건수(value_count)
  - 판정 근거·문서·양식 메타는 '상세 정보' 접힘으로 이동, 검토 승인/반려는
    상단으로
- **DRM 렌더 충실화** (이 커밋)
  - DRM(벤더 컨테이너) 문서가 값-전용 그리드로 깨져 보이던 결함 수정:
    COM 렌더를 `시트 복사 → 임시 xlsx → 일반 충실 렌더러` 경로로 재작성
    (병합/스타일/열폭/이미지/텍스트박스 — Windows+Excel 검증 필요),
    복사 차단 환경만 값-전용 폴백 + `degraded` 사유 명시
  - `/api/sheet` 우선순위 재정렬: 읽을 수 있는 원본 xlsx → DB 사전 렌더
    캐시(DRM용) → DRM COM → tree 폴백(저하 명시). DRM 문서가 균일폭
    tree 표에 가로채이던 문제 해소, 구식 캐시가 정상 파일을 가리는 것도 차단
  - 저하 렌더 경고 배너(React·web_kg) + '원본 충실 렌더' 라벨 제거
  - 회귀 테스트 3건 추가 (145 passed)
- **README 최신화 + 시행착오 파일 정리**
  - 루트 README를 현행 기준으로 재작성 — 빠른 시작이 `kg.webapp`(+React
    `/app`) 하나로 통일되고, 초기 파이프라인(`src.cli`/`src.api.server`+
    `web/` 7뷰)은 '레거시' 섹션으로 강등. kg/README의 웹 UI 절도 4탭 현행화
  - 일회성 스크립트 삭제: `scripts/build_dkg.py`(존재하지 않는 입력),
    `scripts/csv_ingest.py`·`csv_dkg_builder.py`(사설 서버 하드코딩) 및
    구 도메인 일회성 스크립트 4종(로컬 경로 하드코딩)
- **'KG' 표기 제거**
  - React UI의 사용자 노출 문구에서 리터럴 'KG' 전부 제거: 탭 `KG 탐색 →
    개념 탐색`, `전체 KG → 전체 개념`, 헤더 `Fixed Domain KG → 도메인
    온톨로지`, 루트 노드 `고정 개념 체계`, 컬럼 `KG 매핑 → 개념 매핑` 등
  - 서버 생성 문서군 이름 `{L1} KG → {L1} 문서군` (양 프런트 공통 반영)
  - API 경로(`/api/kg/...`)·DB 식별자·레거시 뷰어·web_kg 정적 문구는 유지
- **양식 계층 삽입 + DB 머지 선택 흐름 재설계**
  - 문서군 상세: `문서군 → 양식 → 문서(인스턴스)` 계층으로 재구성.
    양식 미배정 문서는 **기타** 그룹으로 — 계층이 항상 존재
  - 통합 DB: `개념 선택 → 양식 선택(소속 문서 자동 반영) → 양식별
    전처리(자동 정규화/원값 유지) 혹은 문서별 개별 추가/제거` 마법사
  - 백엔드: `/api/files`에 양식(template_name/version) 공급,
    `unit_convert`에 skip_nodes(원값 유지), `/api/build` raw_node_ids
  - docs/PROGRESS.md 신설 — 이후 푸시마다 갱신

## 2026-08-31

- **b0d3cbe** — 그래프 확대/축소(0.5×~2.5×), 파일 분석 검색(파일명·작성자)/
  작성일 필터/컬럼 정렬(+작성자·작성일 컬럼, `/api/files` core 속성 공급),
  사용자 노출 문구 'Document KG' → **문서군** 리네이밍(API·DB 식별자는 유지)
- **aa1eb29** — 이미지/도형이 데이터 범위 밖에 앵커되면 잘리던 결함 수정:
  그리드를 드로잉 범위까지 확장. 이미지 앵커 정합 테스트 + E2E(0.5px 이내)
- **3fe030a** — 텍스트박스 원본 위치 렌더(openpyxl 경로 드로잉 XML 추출,
  앵커 EMU→px) + `table-layout:fixed` 폭 미지정으로 열이 밀리던 정합 결함
  수정. DRM 흐름 E2E(잠금 감지→해제 요청서→해제본 도착→등록→뷰어)
- **7def665** — web_kg 4탭 UI 전체를 React(frontend/)로 포팅. 동일 REST API,
  web_kg는 완전 대체 전까지 `/`에서 유지(이중 유지), React 빌드는 `/app`
  마운트, 레거시 PDF 뷰어는 `?legacy=1`. Playwright 화면 대조 + 쓰기 흐름 E2E
- **f9caa9e / 386bb3a** — dev 머지 사고 복구: 삭제 18파일·손상 xlsx 18개
  복원, 렌더 스테이징 재적용, `/api/files` 500·시트 폴백 가로채기 수정
  (복구 전 40 failed/71 errors → 후 136 passed)

## 이전 (요약)

- KG2: 문서군 영속화(포함/제외 델타), 추출 레시피(스냅샷/이력/롤백),
  재크롤링(fill/reset_auto), KG 개념 편집(별칭/관계/폐기) + 적대 리뷰 18건
- DRM 게이트: 매직바이트 잠금 감지, 정식 해제 요청 추적, 해제본 자동 감지
- 원본 충실 뷰어: 병합/스타일/이미지 렌더, LibreOffice PDF 프리뷰(스테이징),
  Semantic Overlay, Source Inspector(승인/반려/재매핑)
- 통합 DB 빌더: Row Context 스키마 제안, 단위 정규화, lineage, 빌드 리포트
