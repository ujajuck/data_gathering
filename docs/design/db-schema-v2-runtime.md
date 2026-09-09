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

`http://localhost:8010/?v2=1`에 접속한다. 샘플 생성기는 가상 공정 기록 65개와 두 시트,
병합 셀·서식·차트, 수동 KG와 검수 대기 템플릿을 만든다. 기존 샘플은 덮어쓰지 않는다.
일반 문서의 경우 `<workspace>/data/raw`에 있는 원본을 참조한다. 브라우저 업로드로
해제본을 만드는 기능은 제공하지 않는다. 실제 문서를 사용할 때는 승인된 원본 위치/제공자를 연결한다.

프런트 수정 후 `npm --prefix frontend ci && npm --prefix frontend run build`로 dist를 갱신한다.
기존 `kg.webapp`에도 v2 API가 연결되지만 v1 API는 그대로 남는다. v2만 사용할 때는 위의
독립 서버를 사용한다. 기본 바인딩은 `127.0.0.1`, 단일 사용자·단일 서버 워커 PoC다.

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
| `frontend/src/v2/` | 다섯 화면, 원본 범위 선택, 검수, 작업 표시, 결과와 원본 간 이동 |

`db/v2/schema_sqlite.sql`의 32개 테이블에 런타임 작업 상태용 `runtime_job`이 추가된다.
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
  `version_source_ref`를 함께 반환한다.
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
| 원본 등록/버전 | `POST /documents/register`, `GET /documents`, `/documents/{id}/versions`, `/versions/{id}/sheets` |
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
| 값/출처 | `GET /series/{id}/items`, `/series/{id}/regions`, `/items/{id}`, `/items/{id}/regions` |
| 통합 DB | `POST /integrations`, `/integrations/{id}/build`, `GET /builds?integration_version_id=…` |
| 결과 | `GET /builds/{id}/rows`, `/builds/{id}/lineage?row_key=…&field_key=…`, `/builds/{id}/download` |

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
