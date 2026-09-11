# v2 후속 구현 기록 — 남은 격차 해소

2026-09-09 · 브랜치 `claude/data-gathering-schema-review-6kf0n9` (codex/db-schema-redesign @ ee51355 위에 추가)

판단 근거(넣은 것·안 넣은 것·이유)는 [v2-decisions.md](v2-decisions.md)에 따로 모았다.
[복원 기록](v2-restoration.md)이 "후속 범위"로 남겨 둔 항목 가운데 이 환경에서 구현·검증할 수 있는 것을 구현했다.
실제 DRM SDK·네이티브 렌더 어댑터는 SDK가 없어 여전히 미연동이며, PDF 프리뷰는 DRM 문서에 적용할 수 없어 범위에서 제외했다.

## 추가한 기능

| 항목 | 구현 | 검증 |
|---|---|---|
| KG 이웃 탐색 그래프 (codex/v2-kg-coverage 편입) | 개념 탐색의 `이웃 탐색` 모드: `GET /kg/{kg}/explore`(중심 개념 주변 한 단계, 페이지당 30개·관계 120개, 선택 문서 버전의 승인/검수/반려/발행 시리즈 수), `frontend/src/v2/KnowledgeGraph.tsx`, 상세 패널의 "선택 문서의 검수 규칙 → 검수 →". 기본 모드는 아래 hull 캔버스. | codex 테스트 3개(`tests/test_v2_runtime.py`), `frontend/tests/knowledge-graph.test.tsx`, `e2e/v2/graph.spec.ts` |
| KG 커버리지 그래프 캔버스 | `GET /api/v2/kg/{kg}/graph` (`kg/v2/graph.py`) + `frontend/src/v2/DomainGraph.tsx`. v1 DomainGraph의 배치 알고리즘·색을 그대로 쓰고 데이터는 v2(현재 문서 버전의 발행 실행)로 계산한다. 개념 탐색 화면이 v1처럼 3열(목록/그래프/상세)이 되며 hull 클릭은 문서군 필터, 노드 클릭은 개념 상세·편집기다. 하위 개념이 없는 L1도 hull로 그린다. 2,000노드 상한을 넘으면 `truncated`. | `tests/test_v2_graph.py`, `frontend/tests/graph.test.tsx`; 이관한 financier KG(L1 7·리프 48)로 실제 브라우저 확인 |
| v1 `kg.db` → v2 이관 | `python -m kg.v2 migrate --ws <v2> --from-ws <v1> [--raw DIR] [--dry-run] [--report r.json]` (`kg/v2/migrate.py`). 새 안정 ID, `artifact` 링크로 멱등, 매핑은 전부 `proposed`, 값은 재추출 대상. v1 `IS_A`(자식→부모)는 레벨 차 1일 때 `parent_of`로 방향을 뒤집어 옮긴다. | `tests/test_v2_migrate.py`(19); 실제 financier 워크스페이스 이관: 문서 13·시트 139·개념 55·별칭 252·엣지 68, 재실행 시 전부 `existing` |
| 같은 양식 문서군 제안 · 레시피 이식 | 문서 버전의 구조 서명(시트명·라벨·병합) 캐시(`version_signature`), `GET /versions/{id}/suggestions`, `POST /versions/{id}/applications/from-suggestion` (`kg/v2/suggest.py`), 파일 분석 화면의 `Suggestions.tsx`. 이식된 규칙은 항상 `proposed`(§4.10). | `tests/test_v2_suggest.py`, `frontend/tests/suggestions.test.tsx`; 복사본 문서로 브라우저 확인(점수 1.0 → 등록 → 원본 화면에 검수 대기 규칙) |
| raw 폴더 감시 등록 | `python -m kg.v2 watch --ws <ws> [--raw DIR] [--interval] [--once]` (`kg/v2/watch.py`). `kg/watch.py`의 안정화 검사 재사용, 같은 경로의 변경은 같은 문서의 새 버전, 삭제는 기록만. raw 밖을 가리키는 링크·끊어진 링크는 항목별로 건너뛴다. | `tests/test_v2_ops.py`; 실제 CLI로 created/unchanged/revision 2 확인 |
| 템플릿 재크롤링 | `POST /template-versions/{id}/recrawl` `{mode: fill|reset_auto}` + `recrawl-status` (`kg/v2/recrawl.py`), 템플릿 관리 화면의 `Recrawl.tsx`. 승인된 head가 모두 있는 적용 건만 큐잉, 매핑 리비전은 읽기만. 멱등 키는 `request_key:mode:application_id`, 1,000건 상한은 `truncated`로 알린다. | `tests/test_v2_ops.py`, `frontend/tests/recrawl.test.tsx`; 브라우저에서 "이미 발행됨/검수 필요" 건너뜀 확인 |
| PostgreSQL DDL · AGE projection | `db/v2/schema_postgres.sql`(32 테이블·72 트리거 동일 이름), `python -m kg.v2 age-projection` (`kg/v2/age_projection.py`). | `tests/test_schema_postgres.py`(pglast 문법·객체 집합 비교), `tests/test_v2_age.py`. **실행 중인 PostgreSQL/AGE가 없어 런타임 검증은 하지 않았다.** |
| DVC 내보내기 | `python -m kg.v2 export --ws <ws> --build <id> --out <dir>` (`kg/v2/export.py`), `dvc.yaml`의 `v2_export_build`, `.dvcignore`. 활성 `v2.db`·원본은 outs/deps에 넣지 않는다. | `tests/test_v2_export.py`; DVC 미설치라 `dvc repro`는 실행하지 않았다 |
| e2e 브라우저 경로 | `CHROMIUM_PATH`로 사전 설치 Chromium 사용 (`e2e/playwright.config.ts`). | 이 환경에서 `e2e/v2` 통과 |

CLI는 `python -m kg.v2 <serve|watch|migrate|sign|export|age-projection>`이며, 서브커맨드를 생략한 기존 호출은 `serve`로 해석한다.

## 검토에서 고친 것

기능별 적대적 리뷰(읽기 전용) 뒤 확인된 결함을 고쳤다.

- 병합 중 `workbench.css`의 닫는 중괄호 2개가 빠져 재크롤링·제안 스타일이 720px 미디어 블록 안에 갇힘 → 복원.
- 그래프 SVG가 660px에 맞춰 축소되어 큰 KG에서 글자가 뭉개짐 → 원본 크기로 그리고 래퍼가 스크롤, 36개 초과 그룹은 정사각형에 가깝게 배치.
- 그래프에서 고른 개념이 검색 첫 페이지에 없으면 편집기가 열리지 않음 → `GET /kg/{kg}/concepts?id=` 정확 조회.
- 이관: v1 절대경로가 v2 raw 밖이면 사본을 찾지 않던 문제, 중단 후 재실행 시 템플릿 중복 생성, 사람의 `proposed` 리비전을 override가 덮어쓰던 문제, 같은 바이트의 v1 버전 누락, v1 스키마가 아닌 DB에서 `v2.db`를 만든 뒤 추적 오류 → 모두 수정·테스트.
- watch: raw 밖 심볼릭 링크로 데몬이 죽던 문제, 끊어진 링크 하나가 전체 스캔을 막던 문제 → 항목별 건너뜀.
- recrawl: `mode`가 멱등 키에 없어 같은 키로 배치가 섞이던 문제, 1,000건 절단 무표시, 상태 조회 오류 시 무음 중단 → 수정.
- 문서군 제안: 구조 서명에 업무키·이름 같은 데이터 값이 섞이던 문제(라벨 규칙으로 제한, `structure-v2`), 등록 후 서명 단계의 비-Problem 예외·취소가 이미 커밋된 등록을 실패시키던 문제(best-effort로 기록만), 등록마다 리더 서브프로세스 3회 → 1회(describe가 권한·서명을 함께 반환), `has_more` 고정값, 반려된 리비전을 후보로 이식하던 문제(`SOURCE_REJECTED`), `sign` 범위, 제안 목록의 권한 확인·헤더 문자열 노출 → 모두 수정.
- AGE 엣지 라벨이 정점 라벨과 충돌하거나 63바이트를 넘던 문제, `export --out`이 파일이면 traceback, DVC deps에 `__pycache__` 포함 → 수정.

## 파일 분석 화면: v1 목록 표로 복귀

제품 책임자 지적(v2 화면이 단일 문서 상세에 가까움)에 따라 파일 분석을 v1의 목록 표로 되돌렸다.
상단은 정렬 가능한 표(파일·작성자·작성일·문서군·템플릿·검수·접근·상태·열어보기, 필터 툴바 인라인),
행의 `열어보기`는 우측 모달 드로어(등록 버전·시트·같은 양식 문서군 제안·템플릿 연결·원본 검수 열기),
`원본 등록`은 접힘 블록, 검수 큐는 하단 유지. `GET /documents`는 페이지 범위에서만 요약을 계산해
`templates[]`(적용 건별 상태·검수 건수·scope)·`review_pending`·`roots[]`(매핑이 고정된 KG 리비전의 L1 이름)를 돌려주고
`sort=template|review`를 받는다. 적대적 리뷰에서 확정된 15건(루트 이름의 리비전 고정, SQLite 3.44 전용 문법 제거,
전체 스캔 제거 — 200문서 기준 370ms→8ms, 드로어 모달 접근성·포커스 트랩·Esc 범위, 배지 상태 클래스, 검수 버튼 대상 등)을 수정했다.
검증: `tests/test_v2_documents.py`, `frontend/tests/documents-table.test.tsx`, e2e 2건, 실제 브라우저 확인.

## 운영 점검 항목 (2026-09-11)

| 항목 | 상태 |
|---|---|
| Reader(DRM/COM) 프로세스 격리·타임아웃 | 이미 있음 — `kg/v2/jobs.py` spawn 프로세스, `KG_V2_READER_TIMEOUT_SECONDS`(120초)·`KG_V2_READER_MEMORY_MB`(POSIX RLIMIT), IPC 8MB |
| SQLite WAL | 이미 있음 — `kg/v2/db.py` `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` |
| 문서군/그래프 캐시 | 추가 — `kg/v2/graph.py` 발행 상태 해시 서명 캐시 + 발행 적용 건 기준 커버리지 쿼리 + `document(current_version_id)` 인덱스 |
| `data_payload` LEFT JOIN·`representative_values` 폴백 | v1 전용 자료 구조(`kg/webapp.py`). v2는 `extracted_item`+`item_region`이 값과 출처를 함께 가지므로 해당 없음 |
| 원본 화면 `data.sheets` 방어 | v2 `Source.tsx`는 `sheets.data?.items`로 이미 방어. v1 `SourceScreen.tsx:174`의 무방비 `.map`은 `?? []`로 보강 |
| `.env` 자동 로드 | 추가 — `kg/env.py` (`<ws>/.env` → `./.env`, export된 값 우선), v1/v2 서버 진입점에 연결, `tests/test_env.py` |

## 남은 범위

- 실제 DRM SDK 연동과 네이티브 렌더(원본 충실 보기) — `python -m kg.v2.reader_probe` 계약 점검만 가능.
- PostgreSQL/AGE 런타임 검증, DVC 파이프라인 실행.
- 겹친 템플릿 동시 overlay, 이미지/OCR 키 추출, Python 템플릿 실행기.
