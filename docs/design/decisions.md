# 결정 기록 — 문서끼리 갈리는 지점을 어떻게 정했나

작성일: 2026-09-14. 계약은 [contracts.md](contracts.md), 근거 문서는 그 머리말에 있다.
판단이 바뀌면 이 문서를 같은 커밋에서 고친다. 근거가 문서면 §번호를, 코드면 파일 위치를 적는다.

## 1. 매핑 자동 승인 — 신규 문서는 자동, 같은 문서의 새 snapshot은 검수

| 문서 | 말하는 것 |
|---|---|
| identity §5 운영 모델 | "기존 Parsing Profile과 일치하는 문서는 자동 처리, 신규/불일치 양식만 운영 검수" |
| identity §6 승인 정책 | "이미 승인된 Parsing Profile/Mapping 패턴은 동일하거나 호환되는 문서 구조에 자동 적용할 수 있다. 자동 적용 결과도 어떤 Profile/Mapping 판단에서 파생되었는지 추적 가능해야 한다" |
| core §6.1 | "새 snapshot이 들어오면 기존 승인 mapping을 자동 승인 상태로 그대로 사용하지 않는다. 필요하면 이전 mapping을 candidate/proposed 상태로 승계하여 재검수한다" (사용자 동의 2026-09-13) |
| reply §5-1 1-2 | 위 규칙을 "자동 승인 없음"으로 확인 |
| 이전 세대 설계(삭제됨) | "이식 규칙은 항상 검수 대기" |

결정:
- **신규 문서에 approved 프로파일을 처음 적용할 때**(계약 §4.3): 매치 서명이 프로파일의 참조 서명과 `identical`이면 `status='approved', origin='auto'`로 자동 승인하고 곧바로 추출·발행한다. identity §5·§6가 근거다. 추적성은 `evidence_json{reference_revision_id, profile_rev, match_signature}`로 보장한다. `compatible`은 시트/영역 재바인딩이 개입해 서명 동일성으로 값 동일성을 보장할 수 없으므로 `proposed`(검수)다. 이전 세대 설계의 "자동 승인 금지"는 이 경우에 한해 identity §6가 대체한다.
- **같은 문서의 새 snapshot**(계약 §4.4): identical이어도 `status='proposed', origin='inherited'`로 승계하고 "변경 감지" 큐에 넣는다. core §6.1·reply §5-1을 그대로 따른다. 검수 비용은 큐의 `approve_all` 1클릭(승인+추출+발행 요청 1회)이며, identical/compatible 구분을 큐 행에 보여 준다.
- 비대칭은 의도다. 새 문서는 "같은 양식의 문서를 수천 개 처리"하는 UC-1의 대상이고, snapshot 변경은 UC-5의 "적용 가능 여부 재판정" 대상이다.
- draft 프로파일은 자동 적용 대상이 아니다(계약 §4.3). 초안을 문서마다 자동으로 붙이면 검수 큐가 문서 단위로 넘친다. 초안은 테스트(§4.7)와 수동 적용(§6 `POST /snapshots/{sid}/applications`)으로만 문서에 닿고, 승인(§4.8) 직후 `rematch`가 소급한다.

## 2. 헤드의 의미 — 마지막 리비전이 헤드, rejected도 헤드

이전 세대는 매핑 헤드가 approved 리비전만 가리켰다. 지금은 **마지막 리비전이 항상 헤드**다(계약 §1.4). 이유: (1) CAS를 `revision_no = edit_seq + 1` 하나로 DB에서 강제할 수 있다, (2) "이 규칙의 현재 검수 상태"가 한 행으로 읽힌다, (3) rejected를 헤드에서 숨기면 반려된 규칙이 어느 큐에도 안 보이는 구멍이 생긴다(검증에서 지적). rejected 헤드는 "반려됨 · 수정 필요"로 검수 큐에 남고 추출을 막는다.

## 3. `instance_key` 제거

core §7.1의 `mapping(application_id, rule_id, instance_key)`에서 `instance_key`를 뺐다(계약 §1.4 `UNIQUE(application_id, rule_id)`). 반복 블록의 정체성은 이미 `extracted_value.group_key`가 담당하고(core §8.2 `group_key`), 계약의 어느 흐름도 instance_key를 채우지 않았으며, 있으면 `extraction_run.input_manifest_json.mappings`를 rule_key로 키잉할 수 없다. manifest는 `mapping_id`로 키잉한다.

## 4. 값 출처는 `extracted_value_region` 한 경로

reply §5-2.3의 권고대로 `extracted_value.source_region_id`를 두지 않는다. 단일 출처도 행 1개다. "이 셀에서 나온 값 전부" 조회가 UNION 없이 한 경로가 된다.

## 5. `published_run_id` 복귀, `parsing_rule.status` 추가, `mapping_revision.field_id` nullable

reply §5-2의 빈칸 1·2를 그대로 반영했다. 추가로 `mapping_revision.field_id`는 nullable이다(approved면 필수): 대상 필드가 아직 없는 proposed 리비전이 실제로 생기고, `field_key`가 없는 규칙도 proposed 리비전까지는 만들어야 검수 큐에 보이기 때문이다.

## 6. 정의 파일과 DB projection

identity §8.2에 따라 Profile/Schema JSON 파일이 진실이고 DB는 projection이다. 파일은 `<ws>/profiles/<profile_id>/r%04d.json`처럼 리비전마다 남긴다 — UI "변경 이력" 탭과 `extraction_run.profile_rev` pin이 필요로 한다. Git/DVC가 파일 버전을 맡는다는 core §10과 충돌하지 않는다(파일이 곧 DVC 추적 대상).

## 7. 두 종류의 서명

`snapshot_signature`(구조 서명, 프로파일 무관)와 `parsing_application.match_signature`/`parsing_profile.reference_signature`(매치 서명, 프로파일 rev 종속)를 분리했다. 검증에서 둘이 섞여 있음이 지적됐다. 구조 서명은 "신규 양식 후보" 묶음에만, 매치 서명은 자동 승인 판정에만 쓴다. approved 프로파일에 새 리비전을 저장하면 참조 서명이 구 rev 것이 되므로 자동 승인이 중단되고, 재승인 또는 `rematch`가 참조를 재검증해야 재개된다.

## 8. 렌더 서버 — Reader `render` 연산, 밴드 캐시, 재검증 캐시

- render §12는 `_render_sheet`를 렌더 서버로 옮기라 했지만 경로를 받는 렌더러는 Reader 격리를 깬다. 렌더는 Reader 계약의 `render` 연산(스트림)이며 `XlsxReader`가 openpyxl로 구현한다. DRM Reader는 자체 뷰포트로 구현하거나 `RENDER_UNSUPPORTED`를 낸다.
  ([drm-viewer-render-architecture.md](drm-viewer-render-architecture.md)의 "임시 해제 XLSX를 만들지 않는다"는 §16에서 **작업 공간 안에 만들지 않는다**로 바뀌었다 —
  해제본 없이 읽는 경로가 실제로 존재하지 않아 보호 문서가 언제나 잠겼기 때문이다. 대신 위치·수명·권한·감사를 계약으로 묶었다.)
- 전체 시트 JSON 하나는 큰 시트에서 수십 MB가 되어 창 응답 < 20ms를 못 지킨다. 100행 밴드 파일 + `meta.json`으로 나눠 창 요청이 밴드 ≤2개만 읽게 했다. 창 JSON은 `rows/columns`(스크롤 기하)는 전체를, `cells`는 창 안만 담는다.
- `Cache-Control: max-age`는 권한 철회 뒤에도 한 시간 동안 보이게 하므로 `private, no-cache` + ETag/304로 바꿨다. 재접근은 본문 없는 304라 sub-second 목표(render §10)를 유지한다.
- asset은 snapshot 디렉터리 안에만 둔다. 전역 sha256 이름공간은 문서 간 이미지 누출과 권한 검사 불가를 만든다.

## 9. 동기/비동기

시스템은 on-demand·저동시성(identity §5)이다. 등록·추출·재파싱·묶음 처리·큰 빌드는 `runtime_job` 큐이고, 엔드포인트의 `?wait=`로 한 요청에서 결과까지 받는다(UI 왕복 최소화). 프로파일 테스트와 작은 빌드는 동기이지만 작업 내역 이력을 위해 `runtime_job` 행은 남긴다(개발 기준안 §7 "작업 내역 목록 대상"). 렌더는 렌더 서버의 자체 큐이며 메인 API는 절대 완료를 기다리지 않는다(render §6).

## 10. 하지 않은 것

- 같은 양식 문서군 제안 화면: unmatched 큐가 구조 서명으로 묶어 "신규 양식 후보"를 보여 주는 것으로 대체. 배정은 `assign_profile` 묶음 처리가 담당.
- 실제 DRM SDK, PostgreSQL 런타임 검증: 환경이 없다. 계약은 어댑터 경계와 DDL 번역만 고정한다.
- 계정/RBAC: 범위 밖(identity §7.2).

## 11. 폴더 일괄 등록 — 변경 판정·실패 처리·잠긴 파일·승인 정책

근거: 사용자 요구("파일을 하나하나 넣지 말고 루트 디렉터리 하나를 UI에서 지정하면 그 하위 파일을 다 집어넣게 하라",
"사용성과 속도를 항상 생각하라")와 계약 [§4.1.1](contracts.md)·[§1.6](contracts.md)(`source_digest`).
구현은 `schema/service.py`(`scan_sources`·`register_directory`), `schema/api.py`(`GET /sources/scan` · `POST /documents/register-directory`),
`frontend/src/app/DocumentRegister.tsx`, `python -m schema register`.

- **"변경 없음" 판정은 내용 해시로 한다 — mtime이 아니라.** 대상은 DVC/사내 공유 폴더에서 체크아웃·복사되는 파일이라
  내용이 그대로여도 mtime이 바뀌고(체크아웃·동기화), 내용이 바뀌어도 mtime이 그대로일 수 있다(복원·시계 오차).
  mtime만 믿으면 "바뀐 게 없는데 수천 개를 다시 읽거나", "바뀐 문서를 건너뛰는" 두 가지 사고가 난다.
  판정에 쓰는 해시는 Reader가 `change_token`으로 쓰는 것과 **같은 SHA-256**(`schema.readers.file_hash`)이다.
  그래서 스캔이 `unchanged`라고 한 파일은 등록해 봐도 새 snapshot이 생기지 않는다 — 미리보기 수치와 결과가 어긋나지 않는다.
- **대신 stat 캐시(`source_digest`)를 둔다.** 해시는 파일을 전부 읽는 비용이라 수천 파일 폴더를 열 때마다 낼 수 없다.
  `(provider, source_path) → (byte_size, mtime_ns, content_sha256)`를 남기고, stat이 같으면 파일을 읽지 않는다.
  등록(§4.1)이 끝날 때도 같은 값을 기록하므로 단일 등록·watch·일괄 등록 어느 경로로 들어온 문서든 첫 미리보기부터 캐시가 따뜻하다.
  크기가 다르면 해시 없이 `changed`로 끊는다. 이 표는 **캐시일 뿐**이라 언제 지워도 되고(진실은 `document_snapshot.change_token`),
  다음 스캔이 다시 채운다. 스캔은 Reader 프로세스를 띄우지 않는다 — 미리보기 한 번에 프로세스 수천 개를 띄우는 설계는 사용성·속도 요구와 정면으로 어긋난다.
- **파일 하나의 실패는 작업을 실패로 만들지 않는다.** 일괄 등록 작업의 결과물은 개별 성공이 아니라 **요약**이다
  (`summary{found, targeted, registered, unchanged, failed, locked, skipped}` + 파일별 행 ≤500).
  전부 실패해도 작업은 `succeeded`이고, 실패 사유는 행마다 남는다. 단일 등록(§4.1)은 반대다(전부 실패면 작업 `failed`):
  파일 하나를 고른 사람에게는 실패가 곧 작업의 결과이지만, 폴더를 고른 사람에게는 "무엇이 왜 안 됐는지"가 결과다.
  스캔 자체의 Problem(경로 오류·한도 초과)만 작업을 `failed`로 만든다 — 그때는 요약을 만들 수 없기 때문이다.
- **잠긴 파일(DRM Reader 미등록)은 기본 대상에서 뺀다.** 잠긴 문서를 매번 다시 읽어 봐야 `DRM_READER_REQUIRED`로 끝나므로
  큰 폴더에서 비용만 늘고 실패 행만 쌓인다. 문서 행은 `status='locked'`로 남아 화면에서 보이고,
  Reader factory를 붙인 뒤 `변경 없는 문서·잠긴 문서도 다시 읽기`(API `include_unchanged: true`, CLI `--include-unchanged`)로 재시도한다.
  같은 체크박스가 `unchanged`도 다시 읽는다 — 두 경우 모두 "이번엔 다시 읽어라"는 같은 의도다.
- **일괄이라고 승인 정책이 달라지지 않는다.** 이미 있는 문서의 새 내용은 §4.4대로 새 snapshot으로 승계되고 **`proposed`**로 남는다
  (자동 승인 없음, §1). 폴더 하나로 수백 건이 들어와도 "변경 감지" 큐에서 `approve_all` 한 번으로 처리한다.
  신규 문서의 `identical` 자동 승인·추출·발행도 §4.3 그대로다 — 일괄 등록은 §4.1 `register`를 파일마다 부르는 것일 뿐이다.

## 12. 레거시 제거 — 패키지 하나(`schema`), DB 하나(`<ws>/workspace.db`), 호환 껍데기 없음

저장소에 세 세대의 런타임(v1 Fixed Domain KG · v2 versioned extraction · 현행)이 함께 있었고,
경로에 `kg`·`v3`가 남아 있어 "KG를 만드는 시스템"으로 읽혔다. 정체성(identity §1)은 KG가 아니라
Document-to-Table Adapter다. 사용자 결정으로 이전 세대를 **전부** 지우고 이름을 구조에 맞췄다.

- **`kg/` → `schema/` 하나로.** 현행이 실제로 쓰던 순수 함수만 새 위치로 옮겼다:
  주소·범위·타입 변환은 `schema/spec.py`, 정규화 op는 `schema/normalization.py`,
  XLSX Reader는 상속 없이 `schema/readers.py` 한 클래스, 파일 안정화 감시는 `schema/filewatch.py`,
  단위 변환표는 `schema/units.py`. `kg/v2/`·v1 모듈·파서 라이브러리 `src/`·예제 작업 공간 `domains/`는 삭제했다.
  `v3` 하위 패키지를 두지 않은 이유: 버전 이름을 경로에 박으면 다음 개정 때 또 같은 일을 한다.
  스키마 리비전 번호는 데이터에 있다(`schema_meta.version = 3`) — 그것으로 충분하다.
- **이관(migrate) 도구도 지웠다.** v2 작업 공간을 옮길 대상이 남아 있지 않은데 이관 코드·테스트·문서만
  유지 비용으로 남는다. 옮길 v2 데이터가 실제로 생기면 그때 지워진 커밋에서 되살린다(이력에 남아 있다).
- **DB 파일은 `<ws>/workspace.db`.** 이전 경로 `<ws>/data/kg/v3.db`는 Fixed Domain KG 시절 이름이라
  `data/kg`라는 폴더가 KG 저장소처럼 읽혔고, 같은 런타임 산출물(DB·빌드 산출물·렌더 캐시)이
  `data/` 아래 여기저기 흩어져 있었다. 이제 작업 공간 루트에 DB 하나, `data/` 아래에는
  **다시 만들 수 있는 것만**(`raw/`는 입력, `exports/`·`render-cache/`는 파생) 둔다.
  백업 대상이 `schemas/`·`profiles/`·`data/raw/`로 한 줄에 설명된다.
- **호환 껍데기를 두지 않았다.** 구 경로 re-export, 구 환경변수(`KG_V3_*`·`KG_V2_*`) 폴백,
  `/api/v3` 별칭은 만들지 않는다(사용자 결정). 사용자가 하나뿐이고 배포된 외부 클라이언트가 없어
  호환 계층은 이득 없이 "두 이름이 다 맞는" 상태만 만든다. 환경변수는 `SCHEMA_` 접두 하나,
  API 접두는 `/api` 하나, CLI는 `python -m schema` 하나다.
  대신 **조용한 실패만 막는 안전장치 두 개**를 뒀다(값을 읽어 쓰지 않으므로 호환 껍데기가 아니다):
  옛 위치에 DB가 남아 있는 작업 공간을 열면 빈 DB를 만들지 않고 409 `WORKSPACE_DB_MOVED`로 멈추고,
  옛 접두 환경변수가 설정돼 있으면 시작할 때 stderr로 한 번 알린다(옛 이름만 있으면 렌더 주소·Reader 어댑터가 소리 없이 기본값으로 내려간다).

## 13. 스키마 생성과 새 리비전을 다른 문 두 개로 나눈 이유

사용자가 지적한 사고: **새 스키마를 만들었더니 기존 스키마가 사라졌다.** 원인은 `POST /schemas`가 `import_schema`를
그대로 불러, `schema_key`가 같으면 "가져오기"로 보고 조용히 기존 스키마의 새 리비전을 저장한 것이다. 화면에서
`+ 새 스키마`를 누른 사람의 의도는 "하나 더 만든다"인데 결과는 "있는 것을 덮어쓴다"였다. 리비전 기록에는 남으므로
데이터가 사라진 것은 아니지만, **화면의 낱말과 서버의 동작이 어긋나면 그것은 사고다.**

- `POST /schemas`는 **생성 전용**이다. 이미 있는 키면 409 `SCHEMA_EXISTS`이고 **아무것도 쓰지 않는다**(정의 파일·리비전·projection 모두).
  message가 대신 갈 곳을 알려 준다: `이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요.`
- 새 리비전은 `PUT /schemas/{schema_key}` 하나가 맡는다. 경로와 본문의 키가 다르면 422 `SCHEMA_KEY_MISMATCH` —
  "다른 스키마를 고른 채 저장" 역시 같은 종류의 사고라 조용히 성공시키지 않는다.
- 두 응답의 형태는 같다(`{schema_key, schema_name, current_rev, unchanged, fields{...}}`). 다른 것은 **어느 문으로 들어왔는가**뿐이고,
  그것이 곧 사용자의 의도다.

삭제도 같은 원칙이다. 예전에는 삭제 API가 아예 없어 "지우려면 정의 파일을 손으로 지우고 DB를 되살리라"는 상태였다.
지금은 `DELETE /schemas/{key}` · `DELETE /schemas/{key}/fields/{field_key}`가 있고, **쓰는 곳이 하나라도 있으면 지우지 않는다**
(409 `SCHEMA_IN_USE` · `FIELD_IN_USE` · `FIELD_HAS_CHILDREN`). 거부는 "안 됩니다"로 끝내지 않고 **어느 프로파일·규칙이
잡고 있는지**를 함께 준다(`detail`). 필드 삭제는 projection 행을 직접 지우는 대신 **그 필드를 뺀 새 리비전을 저장하는 방식**이라
§6 "파일이 진실"이 유지된다 — 삭제도 하나의 리비전이고 변경 이력에 남는다.
DDL도 여기에 맞췄다: `parsing_field`의 무조건 DELETE 금지 트리거를 **조건부**(`parsing_field_in_use_no_delete`)로 바꿔
참조가 있는 행만 거부한다. 서비스가 먼저 같은 조건을 검사해 409를 돌려주고, 트리거는 마지막 그물이다.

`PATCH /schemas/{key}/fields/{field_key}`가 가져오기 요약(`{fields:{added,updated,...}}`)을 돌려주던 것도 같은 부류의 결함이었다.
화면은 필드 상세를 다시 그려야 하는데 받은 것이 요약이라 아무것도 갱신할 수 없었다 — "저장은 됐는데 화면은 그대로"다.
`POST`·`PATCH`·`GET`이 **모두 같은 필드 상세**를 돌려주게 고정했다.

## 14. 프로파일 상세를 탭 없는 한 화면으로 합친 이유

탭 6개(기본 정보 · 규칙 · 필드 매핑 · 테스트 · JSON · 변경 이력)는 **같은 정의 하나를 여섯 가지 방식으로 그린 것**이었다.
규칙 카드 편집기와 필드 매핑 표는 JSON 편집기와 같은 것을 고치는 두 번째·세 번째 입구였고, 셋이 서로를 실시간으로
반영하지 않아 "어느 쪽이 진짜인가"를 사용자가 판단해야 했다. 진실은 정의 파일 하나(§6)이므로 입구도 하나여야 한다.

- 남은 구성: 상단 요약줄(프로파일명·리비전·상태·연결 스키마·대표 문서·적용 문서 수) + **정의 JSON 편집기**(검증 오류·경고 표시,
  저장하면 새 리비전) + `테스트` 버튼(문서를 고르면 Source Review 테스트 모드) + 하단 `변경 이력`(리비전을 누르면 그 JSON을 읽기 전용으로).
- **`대표 문서로 테스트`(저장 전 초안)를 지웠다.** 초안에는 리비전이 없고, 테스트는 `mapping_revision.effective_spec_json`을 고정한
  리비전 위에서만 뜻이 있다. 저장하지 않은 버퍼를 테스트하면 "테스트한 것"과 "저장될 것"이 다를 수 있다.
  같은 이유로 `POST /profiles/test {definition}`(본문에 정의를 싣는 갈래)도 함께 지웠다 — 그 갈래를 부르는 화면이 하나도 남지 않았다.
  대화상자에는 대신 한 줄을 남겼다: `저장한 뒤 상세 화면에서 문서를 골라 테스트하세요.`
- **`외부 Profile Import`와 `새 프로파일`을 버튼 하나로 합쳤다.** 둘은 같은 대화상자를 제목만 바꿔 띄우고 있었다.
  버튼은 `+ 새 프로파일` 하나이고, 안에서 빈 골격으로 시작하거나 외부 정의를 붙여넣거나 파일로 올린다(형식 자동 판별은 그대로).
  `POST /profiles/import-preview`는 남겼다 — 그 자동 판별과 상세 편집기의 오류·경고 표시가 둘 다 이 엔드포인트를 쓴다.
- **남긴 것 하나**: 요약줄의 `대표 문서` 옆 `지정` 팝오버. 사용자가 열거한 네 구성에는 없지만, 지우면 프로파일 승인(§4.8) 진입점이
  제품 어디에도 남지 않아 자동 적용(§4.3)을 영영 켤 수 없다. 표를 되살리는 대신 팝오버(승인 가능한 적용 건만)로 접어 넣어
  화면은 그대로 하나로 유지했다.

## 15. 사용자 접근 토큰을 없애고 대신 127.0.0.1에 바인딩한 이유

설정 화면의 `서버 접근 토큰` 입력칸은 **저장되지 않는 값**이었다. 브라우저가 토큰을 둘 곳(서버가 발급하는 세션·쿠키)이 없는데
`localStorage`에 사람이 직접 적어 넣는 구조였고, 아무도 쓰지 않았다. 토큰을 넣을 곳이 없으면 인증은 기능이 아니라 **고장**이다 —
서버에 `SCHEMA_ACCESS_TOKEN`을 설정하는 순간 화면 전체가 401로 죽는다.

- 메인 API에서 사용자 대상 bearer 인증을 **걷어냈다**: `SCHEMA_ACCESS_TOKEN` · `AUTH_REQUIRED` ·
  `GET /settings`의 `access_token_required` · 프런트의 `Authorization` 헤더와 `localStorage` 토큰 저장소.
- 대신 `python -m schema serve`가 **기본으로 `127.0.0.1`에 바인딩한다**. 접근 제어는 그 경계에서 한다.
  `--host`로 그 밖에 열 수는 있지만 시작할 때 stderr에 경고 한 줄이 나오고, 앞단 인증은 운영자 책임이다.
- 렌더 서버와 메인 API 사이의 내부 bearer는 **서버 대 서버**라 그대로 둔다. 다만 사용자 토큰을 걷어내면서 같은 변수를
  공유할 이유가 없어져 이름을 갈랐다: `SCHEMA_RENDER_TOKEN`(없이 루프백 밖에 열면 403 `RENDER_TOKEN_REQUIRED`).
  이름을 남겨 두면 "접근 토큰"이라는 지워진 개념이 배포 문서에 계속 살아남는다.
- 계정/RBAC가 실제로 필요해지면 그때 세션 발급까지 함께 설계한다(§10). 반쪽짜리 토큰칸을 남겨 두는 것보다
  없는 편이 상태가 정직하다.

## 16. DRM — 전제를 뒤집었다(평문이 예외, 보호 문서가 기본)

이전 구현은 파일 앞 두 바이트가 `PK`가 아니면 곧바로 `DRM_READER_REQUIRED`로 잠그고 끝이었다. 실제 해제 경로는
`SCHEMA_READER_FACTORY`라는 빈 자리로만 있고 구현이 없었다. 설계 문서([drm-viewer-render-architecture.md](drm-viewer-render-architecture.md) §4)도
렌더 서버가 DRM 접근과 Excel COM을 맡는다고 적어 놓고 그 부분만 비어 있었다. 결과는 **이 제품이 존재하는 이유인
보호 문서가 언제나 잠긴 채로 끝나는 상태**였다.

- **판별 순서를 뒤집었다.** 확장자가 아니라 원본 앞 32바이트를 본다: `SCHEMA_DRM_MAGIC`에 등록된 시그니처 → `vendor`,
  `PK` → 평문 `ooxml`, `D0CF11E0`(OLE2/CFB) → `ole2`, 그 밖 전부 → `unknown`. **`ooxml`만 평문이고 나머지는 전부 보호 문서**다.
  운영자 시그니처를 `PK`보다 먼저 보는 이유는 평문처럼 보이는 래퍼를 운영자가 선언할 수 있어야 하기 때문이다.
- **보호 문서는 잠금이 아니라 Reader로 넘길 대상이다.** `DRM_READER_REQUIRED`는 넘길 Reader가 없을 때만 남는
  마지막 상태이고, 그 문구는 잠겼다고만 말하지 않고 **무엇을 설정해야 하는지** 말한다(`SCHEMA_READER_FACTORY`, 설정 화면 Reader 카드).
  `.xls` + OLE2는 "구형 형식일 수도 있다"는 갈래를 따로 안내한다.
- **판별은 `make_reader` 한 곳에서만** 한다. `XlsxReader.authorize`의 `PK` 검사를 지웠다 — 같은 판정을 두 곳에서 하면
  어댑터를 붙여도 계속 잠기는 화면이 남는다. 이것이 예전 구조의 진짜 함정이었다.
- **해제본을 작업 공간에 만들지 않는다.** 임시 폴더는 `<ws>` 밖(0700)이고 세션 파일은 0600이며 이름은
  `sha256(provider|source_ref|change_token)` 앞 32자다(원본 이름·경로·사용자 이름을 담지 않는다).
  폴더가 작업 공간 안을 가리키면 서버가 `DRM_TEMP_IN_WORKSPACE`로 **시작하지 않는다** — 설정 실수로 평문이 백업·Git에 섞이는
  경로를 런타임 검사로 막는다.
- **해제 비용은 snapshot마다 한 번**이다(설계 문서 §5 기준 건당 약 5초). 세션 키가 `document_snapshot.change_token`이라
  같은 snapshot의 `describe`·`match`·`match_specs`·`extract`·`render`가 한 번 해제한 파일을 다시 쓴다.
  연산마다 해제하면 문서 하나 등록에 5초 × 연산 수가 그대로 붙는다. 보안 우선 배치는 `SCHEMA_DRM_CACHE_TTL_SECONDS=0`으로
  재사용을 끄고 연산이 끝나는 즉시 지운다 — 기본값과 반대쪽 극단을 설정 하나로 고를 수 있게 했다.
- **모든 접근을 남긴다.** `<ws>/data/audit/drm-<YYYYMMDD>.jsonl`(append-only, 0600) + 그 접근을 일으킨 작업의
  `result_json.drm{unlocked, reused, failed}`. 새 테이블을 만들지 않은 것은 의도다 — 감사 기록은 DB projection과
  수명이 다르고(작업 공간을 지우고 다시 만들어도 남아야 한다), DDL을 늘리면 PostgreSQL 번역까지 따라와야 한다.
  작업 내역 화면에 별도 열이 필요해지면 그때 §4.11에 결정을 더한다.
- **Excel COM 참조 구현은 저장소에 두되 기본으로 연결하지 않는다.** 예전 코드의 검증된 경로(Open → `SaveAs(51)` →
  막히면 시트 `Copy()` → `SaveAs` → 그것도 막히면 `DRM_EXPORT_BLOCKED`)를 `schema/drm.py: ExcelComReader`로 남겼고,
  `SCHEMA_READER_FACTORY=schema.drm:excel_com_reader`로 가리켰을 때만 쓰인다. 무인 서비스 금지·동시 실행 1·
  대화형 세션 요구는 제약이지 선택지가 아니다. 값만 긁어 "원본 충실"인 척 보여주는 폴백은 만들지 않았다 —
  그것은 이 제품이 팔고 있는 추적성 자체를 깨뜨린다.

## 17. 인증이 없는 API를 무엇으로 지키는가 — Host/Origin 검사

접근 토큰을 없앤 것은 §15에서 정했다. 그 결정에는 빈자리가 하나 있었다: **DNS 리바인딩**.
브라우저의 동일 출처 정책은 `http://127.0.0.1:8031`을 남의 페이지에서 부르지 못하게 막지만,
공격자가 자기 도메인의 A 레코드를 첫 요청 뒤 `127.0.0.1`로 바꾸면 피해자 탭의 출처는 여전히
`http://evil.example:8031`이므로 그 페이지에게 `/api/*`는 **동일 출처**가 된다. 토큰이 있던 시절에는
서버가 401로 막았고 리바인딩된 출처의 `localStorage`는 비어 있어 토큰을 얻을 수도 없었다 —
즉 토큰을 없애면서 새로 열린 면이다.

토큰을 되살리지 않는다(브라우저가 저장할 곳이 없으면 인증은 기능이 아니라 고장이라는 §15의 이유는 그대로다).
대신 `/api/*` 앞에 두 가지 검사를 둔다.

1. `Host`가 `127.0.0.1`·`localhost`·`[::1]`(포트 무관)이 아니면 400 `HOST_NOT_ALLOWED`.
   앞단 프록시를 쓰는 배치는 `SCHEMA_ALLOWED_HOSTS`에 그 이름을 적는다.
2. 쓰기 메서드(POST·PUT·PATCH·DELETE)에서 `Sec-Fetch-Site`가 교차 출처이거나 `Origin`의 호스트가
   허용 목록 밖이면 403 `CROSS_ORIGIN_DENIED`.

리바인딩된 요청은 `Host: evil.example`을 그대로 들고 오므로 (1)에서 끊긴다. 화면(정적 파일)은 이 검사를
거치지 않는다 — 막아야 할 것은 데이터이지 페이지가 아니다.

## 18. 스키마를 지우려면 프로파일을 지울 수 있어야 한다

§13에서 `DELETE /schemas/{key}`를 넣으면서 "쓰는 프로파일이 있으면 409"로 정했고, 그 문구는
"프로파일을 먼저 지우거나 폐기하세요"라고 말했다. 그런데 **프로파일을 지우는 API도 폐기하는 API도 없었다** —
한 번이라도 프로파일을 붙인 스키마는 삭제 기능이 있는 척만 하고 영원히 지워지지 않았다.
사용자가 불만을 말한 "동작하지 않는 화면 요소"가 이번 개정에서 새로 하나 늘어난 셈이다.

셋 중 하나를 골라야 했다. (a) 프로파일 삭제를 만든다 · (b) 폐기를 탈출구로 만든다 ·
(c) 메시지에서 불가능한 지시를 빼고 버튼을 감춘다. **(a)와 (c)를 함께** 했다.

- `DELETE /profiles/{id}`: 적용된 문서가 **하나도 없을 때만**. 규칙 행과 정의 폴더까지 실제로 지운다.
  적용 건이 있으면 409 `PROFILE_IN_USE`다 — 추출값·검수 기록의 근거를 말없이 지울 수는 없다.
- `POST /profiles/{id}/deprecate`: 적용 건이 있어 지울 수 없는 프로파일의 **사용만** 멈춘다.
  기록은 그대로 두므로 이것만으로는 스키마 삭제가 열리지 않는다(규칙 행이 스키마의 필드를 계속 가리킨다).
- 화면은 지울 수 있을 때만 `삭제`를 그린다(스키마: `profile_count === 0 && application_count === 0`,
  프로파일: `document_count === 0`). 눌러도 반드시 실패하는 버튼은 두지 않는다.

DDL도 함께 풀었다: `parsing_rule`의 DELETE를 무조건 막던 트리거를 `mapping`이 그 규칙을 가리킬 때만
막도록 바꿨다(`parsing_rule_in_use_no_delete`). 적용 건이 없으면 매핑도 없으므로, 서비스가 허용하는
경우와 DB가 허용하는 경우가 정확히 같아진다.
