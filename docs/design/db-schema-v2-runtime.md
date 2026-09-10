# DB v2 실행 안내

2026-09-09 구현. 브랜치 `codex/db-schema-redesign`.
설계 DDL을 실제 원본 읽기·검수·추출·통합 DB 생성에 연결한다.
모든 값은 문서 버전, 템플릿 버전, 매핑 리비전, 추출 실행, 원자 출처를 참조한다.

이후 사용자 검토에 따라 [기존 디자인·기능을 복원](v2-restoration.md)했다.
제품명은 Semantic Excel Integration, 탭은 파일 분석/개념 탐색/원본 데이터/통합 DB/템플릿 관리다.
문서 필터, 검수 큐, 개념 체크, 전처리, CSV, 이력 복원, 개념 편집, 템플릿 내보내기를 v2에 연결했다.

## 실행

```bash
pip install -e ".[web,test]"
python -m examples.schema_v2.runtime_demo --workspace /tmp/data-gathering-v2-demo
python -m kg.v2 --ws /tmp/data-gathering-v2-demo --port 8010
```

```bash
python -m kg.v2 watch --ws /tmp/data-gathering-v2-demo --once   # --once 없이 실행하면 --interval(기본 2초)마다 감시
```

`watch`는 `<workspace>/data/raw`(또는 그 아래 `--raw` 폴더)의 `*.xlsx`/`*.xlsm`을 폴링해
`POST /documents/register`와 같은 경로로 등록한다. 같은 경로의 바뀐 파일은 같은 문서의 새 버전이
되고 바뀌지 않은 파일은 `unchanged`로 기록만 남긴다. 암호화 문서는 `DRM_READER_REQUIRED`로
건너뛰며 해제본을 만들지 않고, 삭제된 파일은 로그만 남기고 문서·버전 행을 지우지 않는다.
이벤트마다 stdout에 JSON 한 줄을 쓴다.

`http://localhost:8010/?v2=1`에 접속한다. 샘플 생성기는 가상 공정 기록 65개와 두 시트,
병합 셀·서식·차트, 수동 KG와 검수 대기 템플릿을 만든다. 기존 샘플은 덮어쓰지 않는다.
일반 문서의 경우 `<workspace>/data/raw`에 있는 원본을 참조한다. 브라우저 업로드로
해제본을 만드는 기능은 제공하지 않는다. 실제 문서를 사용할 때는 승인된 원본 위치/제공자를 연결한다.

프런트 수정 후 `npm --prefix frontend ci && npm --prefix frontend run build`로 dist를 갱신한다.
기존 `kg.webapp`에도 v2 API가 연결되지만 v1 API는 그대로 남는다. v2만 사용할 때는 위의
독립 서버를 사용한다. 기본 바인딩은 `127.0.0.1`, 단일 사용자·단일 서버 워커 PoC다.

## v1 이관 (`migrate`)

기존 `data/kg/kg.db`(v1)를 새 v2 워크스페이스로 옮긴다. v1은 읽기 전용(`mode=ro`)으로만 열고,
기존 스키마를 덮어쓰지 않는다 (설계 §12 이행 순서 1~5).

```bash
python -m kg.v2 migrate --ws <v2 워크스페이스> --from-ws <v1 워크스페이스> [--raw DIR] [--dry-run] [--report report.json]
python -m kg.v2 serve --ws <v2 워크스페이스> --port 8010   # 서브커맨드를 생략하면 serve로 해석한다
```

| v1 | v2 | 규칙 |
|---|---|---|
| `domain_concept`/`domain_alias`/`domain_relation` | `kg_revision` 1개 | v1 `IS_A`(자식→부모)는 레벨 차가 정확히 1일 때만 방향을 뒤집어 v2 `parent_of`(부모→자식, 설계 §4.9)로 옮기므로 개념 탐색 트리·그래프에서 계층이 유지된다. 그 밖의 관계 유형과 레벨 조건에 맞지 않는 `IS_A`는 그대로 복사하고 링크 detail(`parent_of_from_is_a`, notes)에 기록한다. `canonical_name_en`/`concept_type`/`unit_dimension`은 KG를 키우지 않기 위해 옮기지 않고 링크에 기록한다. `unit`은 units.yaml이 원본이므로 옮기지 않는다. |
| `document`/`document_version` | 새 안정 ID의 `document`/`document_version` | 원본 파일을 `<v2 ws>/data/raw`(v1 경로의 상대경로·파일명 사본 우선) → `--raw`/v1 raw → v1 절대경로 순으로 찾고, 찾은 파일이 `<v2 ws>/data/raw` 아래에 있으며 바이트 해시가 v1 `file_hash`와 같을 때만 다시 읽어 등록한다. 별도 v2 워크스페이스로 옮길 때는 v1 raw 파일을 v2 `data/raw`에 복사해 두면 된다. 파일이 없으면 `source missing`, 해시가 다르면 `source changed`로 건너뛴다. 해시나 이름만으로 기존 v2 문서와 병합하지 않는다. |
| `parsing_template_version`/`sheet_template`/`template_mapping` | `template`/`template_version` | `range`는 값 영역(단일 셀 scalar, 한 열/행 list, 그 외 matrix)으로, `key_search`+`offset`은 `find`+`relative`로 변환한다. `range`만 있던 매핑의 키 영역은 매핑 키·개념 이름·별칭으로 추론하므로 추출 시 키를 못 찾을 수 있다 — 검수에서 확정한다. 변환할 수 없으면(잘못된 범위, 시트 17개 이상 등) `template_version`을 만들지 않고 원본 JSON을 artifact(`policy_ref='v1-migration-source'`)로 보관하며 `needs_review`로 표시한다. |
| `document_template_assignment` (+`document_override`) | `template_application` (`scope_key='v1-migration'`) + `mapping_revision` | 모든 매핑은 `proposed`이며 `mapping_head`를 만들지 않는다(§4.10 — 사람이 다시 검수한다). 승인된 override는 `origin='manual'`의 새 `proposed` 리비전이 된다. 이미 사람이 v2에서 수정·승인한 매핑은 `EDIT_CONFLICT`로 건너뛰고 절대 덮어쓰지 않는다. `headers`만으로 시트를 고르던 배정은 시트를 열지 않고는 판단할 수 없어 건너뛴다. |
| `parsed_source.value_json`/`payload_value` | 옮기지 않음 | 원자 출처가 없으므로 발행 추출로 복사하지 않는다. 보고서의 `re_extract_required`에 parse run 단위로 나열되며, v2에서 검수 후 다시 추출한다. |

v1 ID와 새 v2 ID의 대응은 `artifact` 행(`kind='manifest'`, `policy_ref='v1-migration'`,
`storage_ref`에 `{"schema":"v1-migration/1","entity":…,"v1_id":…,"v2_id":…}`)으로 남는다. 다시 실행하면
이미 링크된 v1 행은 `existing`으로 건너뛰므로 멱등이며, 중간에 중단된 실행도 그대로 이어서 실행한다.
`--dry-run`은 `v2.db`를 만들거나 쓰지 않고 계획(`planned`)만 보고한다. 보고서(`--report`)는
`{format, counts, skipped:[{entity,v1_id,reason}], links, re_extract_required}` JSON이며 건너뛴 항목이 있어도 종료 코드는 0이다.

## 화면에서 확인할 순서

1. **문서**: 샘플 문서를 선택하고 현재/과거 등록 버전과 시트를 확인한다. 새 템플릿은
   펼침 메뉴에서 `main`, `common` 같은 시트 역할을 실제 시트에 연결한다.
   여러 템플릿을 같은 문서/시트에 적용해도 각 적용 건의 검수와 결과가 독립된다.
2. **원본 · 검수**: `공정 기록` 시트와 `공정 운전 기록` 적용 건을 선택한다.
   `B3:C3` + `D3`가 키, `B4:C68`이 값, `공통 정보!B1`이 단위다.
   셀을 드래그한 뒤 **이 영역 추가**를 누른다. 기존 영역은 삭제하고 새 위치를 추가할 수 있다.
   셀에 키보드로 초점을 두고 Enter/Space를 눌러도 선택된다. 영역 순서·업무키·상대 탐색은 세부 JSON에서 편집한다.
3. 연결 개념과 범위를 확인하고 **승인 → 수정 버전 저장 → 승인한 규칙으로 추출**한다.
   수정은 기존 기록을 갱신하지 않고 새 리비전을 만든다. 동시 수정은 409로 거부한다.
   수정 시 이전 현재 발행을 해제하며, 모든 규칙이 승인되어야 새 실행을 시작한다.
4. 하단 항목 목록의 값을 눌러 원자 값·단위·업무키 출처를 각각 연다.
   `다음`으로 31번째 값 이후를 확인하고, 원본의 40행/12열 이동과 25~200% 확대를 확인한다.
5. **도메인 KG**: 개념/동의어 검색, 관련 관계 페이지, 현재 추출 소스에서 원본으로 이동한다.
   동의어 표현이 여러 개념에 해당하면 후보를 모두 반환한다. 연결은 검수자가 승인한다.
6. **사용자 DB**: 개념의 발행 소스를 필드에 추가하고 이름·행 결합을 정한 뒤 생성한다.
   미리보기의 값 → 기여 항목 → 기여 영역 → 원본으로 이동한다. SQLite 다운로드에는 전체 값,
   필드 타입/단위, 실행 manifest와 모든 lineage가 포함된다.

활성 탭만 마운트한다. 문서/시트/매핑/결과 선택은 URL에 남고, 페이지 커서와 사용자가 작성한
템플릿·매핑·통합 필드 초안은 제한된 메모리 안에서 탭 이동 동안 유지한다. 새로고침하면 저장하지 않은
초안은 사라진다. 원본 렌더는 최대 60초 동안만 메모리에 보유하고 이후 새 권한 확인을 요구한다.

## 구현된 데이터 경로

| 코드 | 책임 |
|---|---|
| `kg/v2/db.py` | 기존 DB와 분리한 DDL 초기화, 연결별 FK/WAL, 짧은 쓰기 트랜잭션, 필터에 묶인 커서 |
| `kg/v2/service.py` | 원본 버전 등록, 버전별 원본 참조, 수동 KG 가져오기, 템플릿 버전, 시트 배정, 검수 CAS |
| `kg/v2/spec.py` | 실행 가능한 JSON 문법과 값 타입/단위 변환 검증 |
| `kg/v2/readers.py` | 원본을 저장하지 않는 XLSX Reader, 운영자 지정 DRM factory |
| `kg/v2/render.py` | 원본 버전·표시 범위·셀/이미지 좌표 계약 검증 |
| `kg/v2/jobs.py` | 영속 작업 큐, 진행률·취소·idempotency, 시간/메모리 제한 Reader 프로세스 |
| `kg/v2/extract.py` | series/item 배치 저장, 원자 출처, 입력 head가 일치하는 성공 실행만 발행 |
| `kg/v2/build.py` | 실행 고정, 디스크 staging, 중복/충돌 검사, 사용자 DB와 N:M lineage |
| `kg/v2/api.py` | `/api/v2`, 요청/페이지 크기 제한, 조회·다운로드 시 원본 접근 재확인 |
| `kg/v2/suggest.py` | 문서 버전 구조 서명 캐시, 같은 양식 문서군 점수, 시트 역할 매칭, 검수 대기 레시피 이식, `sign` CLI 백필 |
| `frontend/src/v2/` | 다섯 화면, 원본 범위 선택, 검수, 작업 표시, 결과와 원본 간 이동 |

`db/v2/schema_sqlite.sql`의 32개 테이블에 런타임 작업 상태용 `runtime_job`과 문서군 제안용 파생 캐시 `version_signature`가 `CREATE TABLE IF NOT EXISTS`로 추가된다.
버전 원본의 주소는 `document_version.source_artifact_id → artifact.storage_ref`에 고정하며,
바이트 복사본은 만들지 않는다. 원본 위치가 변경되면 기존 버전의 참조는 보존된다.
기본 XLSX Reader는 과거 바이트가 원래 위치에 없거나 변경되었으면 옛 버전의 렌더/재추출을 거부한다.
실제 버전 복원은 보안 제공자가 `version_source_ref`와 버전 토큰으로 제공해야 한다.

## JSON 템플릿 실행 문법

전체 실행 가능한 예시는 `examples/schema_v2/runtime_demo.py`의 `definition`이다.
기존 `template_multisheet.json`은 장기 설계 예시로, 그 모든 연산을 이번 실행기가 지원하지는 않는다.

| 항목 | 현재 실행 지원 |
|---|---|
| `sheet_roles` | 1~16개 역할, `one`/`many`; 실제 문서 버전의 시트 ID에 배정 |
| `selector.key/value/unit/context.areas` | 순서 있는 1~32개 영역, 각 영역의 `sheet_role` 필수 |
| 절대 범위 | `range: "B3:C20"`; 1부터 시작하는 닫힌 유한 범위 |
| 키 검색 | `find: {texts:["공정온도","Process Temp"],within:"A1:Z100",occurrence:0}`; NFKC·공백·대소문자 정규화 |
| 상대 영역 | `relative: {row:1,col:0,rows:20,cols:1}`; 키 앵커에 대한 오프셋 |
| 반복 키 | `selector.key.repeat: "each"`; 선언하지 않은 복수 일치는 오류 |
| 값 모양 | `scalar/none`, `list/down/right`, `matrix/row_major/column_major` |
| 목록 원소 | `element_layout: one_per_row/one_per_column/each_cell`; 기본값은 방향에 따른 한 행/열의 한 값 |
| 병합·겹침 | 실제 병합 전체 범위와 앵커를 보존하고 동일 앵커는 한 번 읽음 (`anchor_once`) |
| 종료 | `explicit_areas` 또는 `blank_run` + `count`; `max_items` 초과는 실패이며 부분 성공으로 발행하지 않음 |
| 단일 값 결합 | `combine: concat/sum`; 각각의 입력 출처를 저장. 기본 `ordered_union`에서 여러 단일 값은 오류 |
| 레코드 | `record_spec.scope`로 표를 구분; `key`는 `coordinate/physical_row/physical_column` 또는 `{column:"A"}` / `{row:1}` |
| 값 타입 | `text/decimal/boolean/date/datetime`; 원문·정규값·수식·원본 위치 분리 |
| 정규화 | `identity/trim/affine/pipeline`; affine의 `factor/offset`은 문자열 Decimal. pipeline은 프리셋 연산 배열을 버전에 고정 |
| 단위 | 원본과 목표가 다르면 `source_unit` + 명시적인 affine 필요. 단순한 단위 이름 바꾸기는 거부 |
| 수식 | 저장된 계산값만 사용 (`cached_only`), 캐시 없거나 Excel 오류면 실패. 외부 링크 갱신/재계산 없음 |

Decimal은 TEXT로 저장해 28자리 Decimal 기본 컨텍스트로 반올림되는 것을 방지한다.
연산 컨텍스트는 4,096자리이며 과도한 자릿수/지수는 거부한다. Excel에 이미 부동소수로 저장된 값의
원래 입력 자릿수를 복원한다는 의미는 아니다. JSON/Python/hybrid 중 PoC 실행 지원은 JSON이며,
임의 스크립트·SQL을 요청에서 실행하지 않는다. 객체/OCR 추출과 Python 실행기 등록은 확장 범위다.

## 통합 DB 의미

- `record_scope`: 같은 등록 문서 버전·기준 시트·표 범위와 같은 `record_key`만 한 출력 행으로 묶는다.
  서로 다른 필드는 같은 표의 `scope`와 업무 행/열 규칙을 사용해야 한다. 임의 목록을 순번으로 zip하지 않는다.
- `business_key`: 모든 선택 소스에 업무키 셀 행/열이 필요하고, 사용자가 문서 간 의미의 동일성을 확인한다.
  같은 출력 행·필드에 서로 다른 원본 항목이 남으면 충돌로 중단한다. 자동 Cartesian join은 없다.
- `aggregate`: 원본/변환 기준 중복 제거 후 필드별 sum/min/max/count를 수행한다.
  count는 빈칸이 아닌 관찰 개수이며 목표 단위는 비운다.
- 원본 식별 + 정규화/레코드/문맥 명세가 같을 때만 중복을 합친다. 같은 숫자라는 이유로 합치지 않는다.
  같은 원본·변환인데 값이 다르면 실행 충돌이다. 합쳐진 모든 관찰은 `deduplicated` lineage로 남긴다.
- 빌드 시작 시 현재 발행 실행 또는 `pinned_run_id`를 고정한다. 과거 문서 버전은 명시적 실행 고정이 필요하다.
  시작한 뒤 새 추출이 발행되어도 이미 시작한 빌드 입력은 바뀌지 않는다.
- 출력 DB의 `data`는 사용자 필드, `_field_schema`는 타입·단위, `_manifest`는 고정 입력,
  `_lineage`는 각 결과의 원자 출처다. 숫자형 값도 정밀도 보존을 위해 TEXT이며 타입을 명시한다.
- 새 빌드의 `_record_key`는 읽기 쉬운 업무키다. 내부 `_row_key`는 출처 연결을 위해 유지한다.
  `/download?format=csv`는 `data`만 행별 스트리밍하며 기본 `/download`는 전체 SQLite다.

## DRM Reader 계약

실제 DRM SDK와 렌더러는 이 저장소/환경에 제공되지 않았다. 제품 권한, 지원 API,
허용되는 파생 저장 및 브라우저 렌더 정책은 해당 운영 환경에서 연결·검증해야 한다.
`tests/v2_reader_fixture.py`는 계약 테스트 대역이며 실제 DRM 구현으로 사용하지 않는다.

서버 환경 변수:

| 변수 | 기본값 / 의미 |
|---|---|
| `KG_V2_READER_FACTORY` | 미설정; `approved_package.reader:factory` 형식의 운영자 등록 코드 |
| `KG_V2_READER_REVISION` | 어댑터 코드/환경의 고정 버전. 추출 manifest에 기록; 실제 배포에서는 명시적으로 고정 |
| `KG_V2_READER_TIMEOUT_SECONDS` | 작업별 Reader 호출 최대 120초 |
| `KG_V2_READER_MEMORY_MB` | POSIX Reader 프로세스 주소 공간 최대 1,536MB; Windows에서는 제공자 자체 메모리 제한 필요 |
| `KG_V2_ACCESS_TOKEN` | 선택적 Bearer 토큰. 브라우저는 메모리에만 유지 |
| `KG_V2_PRINCIPAL` | `local-user`; 서버가 고정하는 실제 제공자 사용자 문맥. 요청자가 이름을 바꿀 수 없음 |

Factory는 `factory(root: Path, provider: str, principal: str)`로 Reader를 반환한다.
작업마다 별도 프로세스에서 생성되므로 세션/COM 생성은 그 프로세스 안에서 수행한다.

- `authorize(source_ref, required="view"|"render"|"extract")`: `can_view`, `can_extract`,
  `can_render_web`, `can_cache_derivative`, `native_render`, `access_scope_key`, `policy_revision`,
  timezone이 있는 `expires_at`을 반환한다. `can_extract`는 선택 값과 출처의 DB 저장/사용자 DB 생성을
  허용한다는 계약이다. 권한을 획득하는 통로가 아니며 실제 DRM 권한을 매번 확인해야 한다.
- `describe(source_ref)`: `token`, `filename`, 선택적 작성자/작성일/바이트 크기/Excel epoch,
  `sheets`를 반환한다. 시트명은 버전 내 유일해야 한다. 과거 버전의 보존된 제공자 참조가 있으면
  `version_source_ref`를 함께 반환한다. 선택적으로 `capabilities`(`authorize(source_ref,"extract")` 결과)와
  `signature`(아래 구조 서명, `signature(...)`와 같은 형태)를 함께 돌려주면 등록이 이를 재사용해
  Reader 프로세스를 다시 띄우지 않는다. 없으면 서비스가 `authorize`·`signature`를 따로 호출한다.
- `viewport(source_ref,expected_token,sheet,r1,c1,rows,cols)`: `mode`, `layout_revision`(고정 원본 토큰),
  범위, 폭/높이, 행·열의 픽셀 위치, 병합을 포함하는 `cells`, 범위에 필요한 `images`를 반환한다.
  native는 승인된 원본 이미지와 같은 좌표계의 셀 hit map을 함께 반환해야 한다.
  `cells`는 중복 없이 요청 범위를 덮고, geometry는 행/열 좌표와 일치해야 한다.
  이미지 URL은 인라인 PNG/JPEG/GIF만 허용한다. 외부 URL과 SVG는 받지 않는다.
- `extract(source_ref,expected_token,rules,bindings)`: `series` → `items`(배치) → 마지막 `verified`
  이벤트를 yield한다. 실제 이벤트 형태는 `XlsxReader.extract` 및 `kg/v2/extract.py`가 계약이다.
  마지막 토큰이 일치하지 않거나 출처가 빠진 실행은 발행하지 않는다. 등록된 어댑터는 서버가 신뢰하는
  코드이므로 선택 규칙/타입/단위 의미를 정확히 지키는 적합성 검증을 거쳐야 한다.

기본 Reader는 일반 OOXML만 읽는다. 암호화/다른 형식이면 `DRM_READER_REQUIRED`로 중단한다.
v2에는 Save/SaveAs/시트 Copy/해제본 파일 생성 경로가 없다. XLSX는 수식과 저장된 값 확인을 위해
프로세스 안에서 읽으며, 일반 시트 미리보기의 일부 스타일·이미지는 지원하지만 차트·도형·전체 서식
동일성을 주장하지 않는다. 정확한 보기는 native 제공자가 담당한다.

렌더 바이트는 SQLite, DVC, 원본 파일 또는 서버 파일에 저장하지 않는다. 사용자별 메모리 캐시는
최대 8개·60초이고, 응답 직전에 원본 권한을 다시 확인한다. API 응답은 `Cache-Control: no-store`다.
권한 철회는 다음 조회에서 적용되며 이미 전송한 화면을 DRM 자체 뷰어 수준으로 회수하는 기능은 아니다.
빌드 미리보기/lineage/다운로드도 모든 입력 원본의 권한을 재확인한다. 이미 내려받은 DB의 별도 DRM 적용은
운영 정책의 영역이다. HTTP 로그인·멀티테넌트 ACL을 갖춘 운영 서비스라는 의미는 아니다.

## 크기와 실행 제한

| 경로 | 현재 제한 |
|---|---|
| API 입력 | JSON 2MB, 템플릿/통합 명세 512KB |
| 목록 | keyset cursor, 최대 100행; UI 기본 30행 |
| 시트 표시 | API 100행×30열·3,000셀, UI 40행×12열·480셀 |
| 긴 값 | 항목 미리보기 2,048자, 사용자 DB 미리보기 256자/셀·3,000셀; 다운로드는 전체 값 |
| XLSX | 원본 256MB, ZIP 항목 30,000개, 확장 예상 512MB |
| 추출 | 영역당 100,000셀, 키 검색당 10,000셀, 실행당 1,000,000항목/10,000 series |
| 출처 | 단일 항목의 원자 출처 1,000개, 규칙 역할의 해석된 영역 1,000개 |
| Reader IPC | 한 이벤트 8MB; 큰 원본 읽기는 프로세스를 종료하여 시간 제한/취소 적용 |
| 통합 빌드 | 100필드, 필드당 100소스, 총 1,000,000관찰; 디스크 staging과 100개 lineage 배치 |
| 대기 큐 | 동시 대기/실행 32개, 워커 1개, 중단 작업 heartbeat 30초 이후 실패 처리 |

일반 XLSX Reader는 메타데이터는 read-only streaming, 병합/스타일·추출은 제한된 격리 프로세스에서
openpyxl로 워크북을 로드한다. **대형 파일을 네이티브 타일처럼 무작위 접근하는 구현은 아니다.**
대형 DRM 원본에는 제공자의 범위 읽기/렌더 API가 필요하다. 제한 초과는 실패로 보고하며 전체 파일을
브라우저로 보내거나 샘플을 전체 성공으로 저장하지 않는다. SQLite WAL은 로컬 디스크를 전제로 한다.

대용량 다운로드는 토큰이 없는 로컬 모드에서 브라우저 다운로드로 스트리밍하고,
토큰 모드에서는 File System Access API가 있는 브라우저에서 스트리밍한다. 미지원 브라우저의
메모리 다운로드는 64MB로 제한하며 큰 파일은 인증된 스트리밍 API 클라이언트를 사용한다.

## 주요 API

FastAPI `/docs`가 요청 파라미터의 기준이다. POST 작업은 `request_key` 필수, 같은 키/같은 요청은
기존 작업을 반환하고 같은 키/다른 내용은 충돌이다.

| 흐름 | 경로 (`/api/v2` 아래) |
|---|---|
| 원본 등록/버전 | `POST /documents/register`, `GET /documents`(문서마다 현재 버전의 `templates[]`(적용 건마다 `application_id`·`scope_key`·`state`·`review_pending`)·`template_count`(적용 건 수: 같은 템플릿 버전을 scope를 달리해 여러 번 적용할 수 있다)·`review_pending`(미승인 규칙 헤드 수)·`roots[]`(발행 실행 기준 문서군 L1 뿌리, 최대 8개; 이름은 매핑이 고정된 KG 리비전의 것 = `GET /kg/{pinned}/graph`의 group, 문서가 여러 고정 리비전에 걸치면 가장 새 고정 리비전; 그래프의 2000 노드 절단은 적용하지 않음)·`root_count`. 정렬 키(`sort=template|review`)는 페이지 SQL이 인덱스로 계산하고 `templates[]`·`roots[]`는 같은 읽기 트랜잭션에서 페이지 문서에 대해서만 두 번째 메타데이터 SQL로 계산; `template=` 필터가 있으면 `sort=template`은 필터에 맞는 첫 템플릿 기준; 원본은 열지 않음), `/documents/{id}/versions`, `/versions/{id}/sheets` |
| 권한/표시 | `GET /versions/{id}/access`, `POST /viewports` |
| 작업 | `GET /jobs/{id}`, `POST /jobs/{id}/cancel` |
| KG | `POST /kg/import`, `/kg/import-current`, `GET /kg/revisions`, `/kg/{id}/concepts`, `/kg/{id}/aliases`, `GET /kg/{id}/graph`(개념 트리 + 현재 문서 버전·발행 실행 기준 출처 수, 최대 2000 노드 초과 시 `truncated`) |
| 템플릿 | `POST /templates`, `GET /templates`, `/templates/{id}/versions`, `/template-versions/{id}` |
| 배정/검수 | `POST /applications`, `GET /applications?version_id=…`, `/applications/{id}/mappings`, `/mappings/{id}` |
| 수정 | `POST /applications/{id}/mappings/{id}/revisions` (`expected_seq`, `effective_spec`, `concept_id`, `status`) |
| 검수 큐·이력 | `GET /review-queue`, `/applications/{id}/rules/{rule_key}/revisions`, `POST /applications/{id}/mappings/{id}/rollback` |
| 개념 선택·편집 | `GET /kg/{id}/tree?roots=…&excluded=…`, `GET /series?kg_revision_id=…&roots=…`, `POST /kg/{id}/concepts/{id}/revisions` |
| 전처리·내보내기 | `GET /normalization-presets`, `/template-versions/{id}/download`, `/builds/{id}/download?format=csv` |
| 추출 | `POST /applications/{id}/extract`, `GET /series?run_id=…` 또는 KG/개념별 현재 출처 |
| 재크롤링 | `POST /template-versions/{id}/recrawl` (`mode` fill/reset_auto, `request_key`; 검수 미완 적용 건은 `review_required`로 건너뜀, 매핑 리비전 불변), `GET /template-versions/{id}/recrawl-status?request_key=…` |
| 값/출처 | `GET /series/{id}/items`, `/series/{id}/regions`, `/items/{id}`, `/items/{id}/regions` |
| 통합 DB | `POST /integrations`, `/integrations/{id}/build`, `GET /builds?integration_version_id=…` |
| 결과 | `GET /builds/{id}/rows`, `/builds/{id}/lineage?row_key=…&field_key=…`, `/builds/{id}/download` |
| 문서군 제안 | `GET /versions/{id}/suggestions?threshold&limit`, `POST /versions/{id}/signature`, `POST /versions/{id}/applications/from-suggestion` |

## 문서군 제안·레시피 이식

`kg/v2/suggest.py`는 등록한 문서 버전마다 **구조 서명**(`structure-v2`)을 계산해 런타임 캐시 테이블 `version_signature`에 둔다.
서명은 시트명(정규형), 앞 30행×30열 창에서 **라벨로 판정한 셀**의 문자열 정규형(시트당 200개, 정렬 뒤 절단),
같은 창에 걸친 병합 범위(시트당 200개), 시트 크기 추정치다. 원본 바이트는 저장하지 않는다.
라벨 판정은 `readers.signature_terms`의 설명 가능한 규칙이다: 빈 행 다음 첫 행(블록 머리)·병합 범위의 왼쪽 위 셀·
문자열만 있는 행·오른쪽/아래 이웃이 숫자인 셀만 후보로 하고, 숫자·날짜·숫자 문자열, `lot-001`/`no.12` 같은 식별자 모양
문자열, 4행 이상 문자열만 이어지는 표의 둘째 행부터, 같은 열에서 4칸 이상 연속되는 값 옆 문자열(이름·자유 텍스트 같은
레코드 값)은 제외한다. 이는 휴리스틱이므로 데이터 셀이 라벨로 판정될 가능성을 0으로 보장하지는 않지만,
같은 양식에 데이터만 다른 문서는 같은 서명 해시를 가진다(테스트로 확인). 알고리즘 이름이 바뀌면 이전 캐시는 재계산 대상이다.
`version_signature`는 설계 DDL(`db/v2/schema_sqlite.sql`)에 속하지 않는 재계산 가능한 파생 캐시이며
`runtime_job`처럼 `kg/v2/db.py`가 `CREATE TABLE IF NOT EXISTS`로 만든다(schema_meta 버전 변경 없음).

- 계산 시점: `Service.register()` 끝(등록 트랜잭션 커밋 뒤). `describe`가 함께 돌려준 `capabilities`/`signature`를 재사용하므로
  기본 Reader는 등록 한 건에 Reader 프로세스를 한 번만 띄운다(없으면 `authorize(required="extract")`·`signature`를 따로 호출).
  어느 경로든 `can_view`·`can_extract`·만료 시각을 검사한 뒤에만 저장하며 권한 관찰(`access_observation`)을 남긴다.
  서명 실패(권한, `INVALID_READER_CONTRACT`, 예상하지 못한 예외 `INTERNAL`)는 등록을 실패시키지 않고 결과에
  `signature: "failed:<code>"`를 남긴다(취소만 전파). 서명 연산이 없는 보안 Reader는 기존 `viewport` 계약으로 대체한다.
- 백필: `POST /versions/{id}/signature` 또는 `python -m kg.v2 sign --ws <workspace> [--version <id>]`.
  `--version` 없이 실행하면 현재 버전과 템플릿을 연결한 모든 버전(이전 버전 포함) 중 현재 알고리즘 서명이 없는 것을 계산한다.
- 유사도: `0.4·시트명 Jaccard + 0.4·헤더 토큰 Jaccard + 0.2·병합범위 Jaccard`. 양쪽 모두 비어 있는 성분은 제외하고 가중치를 재정규화한다.
  `GET /versions/{id}/suggestions`는 대상 버전의 원본 권한(`authorize`)을 확인한 뒤 템플릿을 연결한 다른 문서 버전
  (같은 문서의 이전 버전 포함, 최근 2,000건)을 캐시된 서명만으로 비교한다. 후보 원본을 열지 않으며 기본 임계값 0.5,
  최대 100건의 bounded 응답이고 `has_more`는 임계값을 넘는 후보가 `limit`보다 많은지 알린다.
  `breakdown`은 시트명 성분만 이름(공통/대상만/원본만)을 싣고 헤더·병합 성분은 개수(`shared_count`/`target_count`/`source_count`)로만 설명한다.
  다른 문서의 셀 문자열은 응답에 싣지 않는다.
- 이식: `POST /versions/{id}/applications/from-suggestion`는 원본 적용 건과 같은 템플릿 버전으로 새 `template_application`을 만들고,
  시트 역할을 시트명 정규형 일치로 연결한다(불일치는 `SHEET_UNMATCHED`, `sheet_bindings`로 직접 지정 가능).
  규칙별 원본 head(없으면 거절되지 않은 최신) 리비전을 `origin=candidate`, `status=proposed`의 새 `mapping_revision`으로 복사하며
  `mapping_head`는 만들지 않는다(규칙 §4.10). 거절된 리비전만 남은 규칙은 `SOURCE_REJECTED`(409)로 거부한다.
  출처 적용 건·리비전은 `reason`과 `evidence_json.transplanted_from`에 남긴다.
  승인은 기존 `POST /applications/{id}/mappings/{id}/revisions`의 `expected_seq: 0` 경로로만 이루어진다.

## 검증과 다음 연동

`tests/test_schema_v2.py`는 버전/소유권/FK/발행/불변 조건을 검증한다.
`tests/test_v2_runtime.py`는 실제 생성 XLSX로 등록·복수 키·병합·다중 시트·가로 목록·행렬·빈칸 종료,
정확한 Decimal, 검수 충돌과 현재 결과 무효화, 수식 캐시 실패, 원본 변경, 취소/idempotency,
페이지 커서, native 좌표 계약, 렌더 비영속, 권한 철회, 중복 통합과 모든 lineage,
집계·미리보기·SQLite 다운로드·워커 수명을 검증한다.

```bash
python -m pytest tests -q
npm --prefix frontend test
npm --prefix frontend run build
```

초기 구현 검증: 전체 회귀 **148개 통과**(추가 subtest 5개), React TypeScript/Vite 프로덕션 빌드 성공.
v2 DDL/런타임 검증은 이 가운데 44개다. 테스트 환경은 Python 3.12, FastAPI 0.141.1,
openpyxl 3.1.5이며 기존 라이브러리의 경고 4개가 있었다.

초기 후속 화면 검증: `frontend/tests/workbench.test.tsx`의 **컴포넌트 회귀 6개 통과**.
Node 24.19.0에서 Vitest·jsdom으로 실제 React 화면을 마운트하고, 네트워크 접속 없이
가상 API 응답으로 병합 셀 선택·복수 영역/시트 수정·검수 저장, 지연 응답 취소,
확대 시 추가 조회 방지, 항목/결과 페이지 이동, DB 생성과 원자 출처 이동을 확인했다.
이 과정에서 다음 오류를 재현하고 수정했다.

- 원본의 강조 표시와 검수 편집기가 같은 초안을 사용하여 저장 전에도 변경 영역을 표시한다.
- DB에서 선택한 단위/입력 영역의 시트와 위치를 원본 화면이 유지한다. 항목의 대표 값 위치로
  임의 이동하지 않으며, 항목 목록에서 값을 새로 선택할 때만 값 위치로 이동한다.
- 건수 집계에서 다른 집계/행 결합으로 전환하면 원래 타입과 단위를 복원한다.

클라우드 브라우저 재시도에서는 도구의 자동 보안 검사가 로컬 URL 접속을 거부했다
(`net::ERR_BLOCKED_BY_CLIENT`, Cloud browser URL policy). 사용자 거부가 아니다.
이 경로의 실제 브라우저 조작·시각 검증은 수행하지 못했다. jsdom의 이벤트 검증은
브라우저 레이아웃/히트 테스트나 실제 DRM 제품의 원본 충실도 검증을 대신하지 않는다.

기존 문서/매핑의 자동 마이그레이션, 임의 코드 템플릿 실행, 이미지/OCR 키 추출, 템플릿 영향도 diff,
모든 겹친 템플릿의 동시 overlay, KG 그래프 캔버스, 작업 큐 분산화는 목표 설계의 다음 단계다.
현재는 선택한 적용 건/규칙의 overlay와 페이지로 나눈 개념 관계 탐색을 제공한다.
PostgreSQL/AGE는 동일 안정 ID/관계형 출처를 옮기고 KG를 투영하는 [이행 설계](db-schema-v2.md)를 따른다.
DVC 자동 연동은 하지 않았다. JSON 템플릿은 Git, 승인된 파생 산출물·manifest는 선택적으로 DVC에
연결할 수 있도록 artifact의 Git/DVC 참조 컬럼을 유지한다. DRM 원본/렌더를 자동 커밋하지 않는다.

확장 도구(구문/구조 검증만, 실제 PostgreSQL·AGE·DVC 런타임 미검증 — [상세](db-schema-v2-postgres.md)):
- `db/v2/schema_postgres.sql` — SQLite DDL의 1:1 PostgreSQL 번역(UUID/TIMESTAMPTZ/BOOLEAN/JSONB, PL/pgSQL 트리거).
- `python -m kg.v2 age-projection` — KG 리비전 하나를 서비스 ID 속성으로 MERGE하는 멱등 Apache AGE 스크립트.
- `python -m kg.v2 export` + `dvc.yaml`의 `v2_export_build` — 완료 빌드의 SQLite와 manifest.json을 DVC 추적 폴더로 내보내기.
