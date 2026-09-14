# v3 결정 기록 — 문서끼리 갈리는 지점을 어떻게 정했나

작성일: 2026-09-14. 계약은 [v3-contracts.md](v3-contracts.md), 근거 문서는 그 머리말에 있다.
판단이 바뀌면 이 문서를 같은 커밋에서 고친다. 근거가 문서면 §번호를, 코드면 파일 위치를 적는다.

## 1. 매핑 자동 승인 — 신규 문서는 자동, 같은 문서의 새 snapshot은 검수

| 문서 | 말하는 것 |
|---|---|
| identity §5 운영 모델 | "기존 Parsing Profile과 일치하는 문서는 자동 처리, 신규/불일치 양식만 운영 검수" |
| identity §6 승인 정책 | "이미 승인된 Parsing Profile/Mapping 패턴은 동일하거나 호환되는 문서 구조에 자동 적용할 수 있다. 자동 적용 결과도 어떤 Profile/Mapping 판단에서 파생되었는지 추적 가능해야 한다" |
| core §6.1 | "새 snapshot이 들어오면 기존 승인 mapping을 자동 승인 상태로 그대로 사용하지 않는다. 필요하면 이전 mapping을 candidate/proposed 상태로 승계하여 재검수한다" (사용자 동의 2026-09-13, [v2-decisions §2-3](v2-decisions.md)) |
| reply §5-1 1-2 | 위 규칙을 "자동 승인 없음"으로 확인 |
| v2 설계 §4.10 / v2-decisions | "이식 규칙은 항상 검수 대기" (v2 문서군 제안의 규칙) |

결정:
- **신규 문서에 approved 프로파일을 처음 적용할 때**(계약 §4.3): 매치 서명이 프로파일의 참조 서명과 `identical`이면 `status='approved', origin='auto'`로 자동 승인하고 곧바로 추출·발행한다. identity §5·§6가 근거다. 추적성은 `evidence_json{reference_revision_id, profile_rev, match_signature}`로 보장한다. `compatible`은 시트/영역 재바인딩이 개입해 서명 동일성으로 값 동일성을 보장할 수 없으므로 `proposed`(검수)다. v2 설계 §4.10의 "자동 승인 금지"는 이 경우에 한해 identity §6가 대체한다.
- **같은 문서의 새 snapshot**(계약 §4.4): identical이어도 `status='proposed', origin='inherited'`로 승계하고 "변경 감지" 큐에 넣는다. core §6.1·reply §5-1을 그대로 따른다. 검수 비용은 큐의 `approve_all` 1클릭(승인+추출+발행 요청 1회)이며, identical/compatible 구분을 큐 행에 보여 준다.
- 비대칭은 의도다. 새 문서는 "같은 양식의 문서를 수천 개 처리"하는 UC-1의 대상이고, snapshot 변경은 UC-5의 "적용 가능 여부 재판정" 대상이다.
- draft 프로파일은 자동 적용 대상이 아니다(계약 §4.3). 초안을 문서마다 자동으로 붙이면 검수 큐가 문서 단위로 넘친다. 초안은 테스트(§4.7)와 수동 적용(§6 `POST /snapshots/{sid}/applications`)으로만 문서에 닿고, 승인(§4.8) 직후 `rematch`가 소급한다.

## 2. 헤드의 의미 — 마지막 리비전이 헤드, rejected도 헤드

v2는 `mapping_head`가 approved 리비전만 가리켰다(`db/v2/schema_sqlite.sql:470`). v3는 **마지막 리비전이 항상 헤드**다(계약 §1.4). 이유: (1) CAS를 `revision_no = edit_seq + 1` 하나로 DB에서 강제할 수 있다, (2) "이 규칙의 현재 검수 상태"가 한 행으로 읽힌다, (3) rejected를 헤드에서 숨기면 반려된 규칙이 어느 큐에도 안 보이는 구멍이 생긴다(검증에서 지적). rejected 헤드는 "반려됨 · 수정 필요"로 검수 큐에 남고 추출을 막는다.

## 3. `instance_key` 제거

core §7.1의 `mapping(application_id, rule_id, instance_key)`에서 `instance_key`를 뺐다(계약 §1.4 `UNIQUE(application_id, rule_id)`). 반복 블록의 정체성은 이미 `extracted_value.group_key`가 담당하고(core §8.2 `group_key`), 계약의 어느 흐름도 instance_key를 채우지 않았으며, 있으면 `extraction_run.input_manifest_json.mappings`를 rule_key로 키잉할 수 없다. manifest는 `mapping_id`로 키잉한다.

## 4. 값 출처는 `extracted_value_region` 한 경로

reply §5-2.3의 권고대로 `extracted_value.source_region_id`를 두지 않는다. 단일 출처도 행 1개다. "이 셀에서 나온 값 전부" 조회가 UNION 없이 한 경로가 된다.

## 5. `published_run_id` 복귀, `parsing_rule.status` 추가, `mapping_revision.field_id` nullable

reply §5-2의 빈칸 1·2를 그대로 반영했다. 추가로 `mapping_revision.field_id`는 nullable이다(approved면 필수): v2에 `concept_id IS NULL`인 proposed 리비전이 존재하고(`db/v2/schema_sqlite.sql:250`), `field_key`가 없는 규칙도 proposed 리비전까지는 만들어야 검수 큐에 보이기 때문이다.

## 6. 정의 파일과 DB projection

identity §8.2에 따라 Profile/Schema JSON 파일이 진실이고 DB는 projection이다. 파일은 `<ws>/profiles/<profile_id>/r%04d.json`처럼 리비전마다 남긴다 — UI "변경 이력" 탭과 `extraction_run.profile_rev` pin이 필요로 한다. Git/DVC가 파일 버전을 맡는다는 core §10과 충돌하지 않는다(파일이 곧 DVC 추적 대상).

## 7. 두 종류의 서명

`snapshot_signature`(구조 서명, 프로파일 무관)와 `parsing_application.match_signature`/`parsing_profile.reference_signature`(매치 서명, 프로파일 rev 종속)를 분리했다. 검증에서 둘이 섞여 있음이 지적됐다. 구조 서명은 "신규 양식 후보" 묶음에만, 매치 서명은 자동 승인 판정에만 쓴다. approved 프로파일에 새 리비전을 저장하면 참조 서명이 구 rev 것이 되므로 자동 승인이 중단되고, 재승인 또는 `rematch`가 참조를 재검증해야 재개된다.

## 8. 렌더 서버 — Reader `render` 연산, 밴드 캐시, 재검증 캐시

- render §12는 `_render_sheet`를 렌더 서버로 옮기라 했지만 경로를 받는 렌더러는 DRM Reader 격리(db-schema-v2 §8 "임시 해제 XLSX 금지")를 깬다. 렌더는 Reader 계약의 `render` 연산(스트림)이며 `XlsxReader`가 openpyxl로 구현한다. DRM Reader는 자체 뷰포트로 구현하거나 `RENDER_UNSUPPORTED`를 낸다.
- 전체 시트 JSON 하나는 큰 시트에서 수십 MB가 되어 창 응답 < 20ms를 못 지킨다. 100행 밴드 파일 + `meta.json`으로 나눠 창 요청이 밴드 ≤2개만 읽게 했다. 창 JSON은 `rows/columns`(스크롤 기하)는 전체를, `cells`는 창 안만 담는다.
- `Cache-Control: max-age`는 권한 철회 뒤에도 한 시간 동안 보이게 하므로 `private, no-cache` + ETag/304로 바꿨다. 재접근은 본문 없는 304라 sub-second 목표(render §10)를 유지한다.
- asset은 snapshot 디렉터리 안에만 둔다. 전역 sha256 이름공간은 문서 간 이미지 누출과 권한 검사 불가를 만든다.

## 9. 동기/비동기

시스템은 on-demand·저동시성(identity §5)이다. 등록·추출·재파싱·묶음 처리·큰 빌드는 `runtime_job`(v2 큐 재사용)이고, 엔드포인트의 `?wait=`로 한 요청에서 결과까지 받는다(UI 왕복 최소화). 프로파일 테스트와 작은 빌드는 동기이지만 작업 내역 이력을 위해 `runtime_job` 행은 남긴다(개발 기준안 §7 "작업 내역 목록 대상"). 렌더는 렌더 서버의 자체 큐이며 메인 API는 절대 완료를 기다리지 않는다(render §6).

## 10. 하지 않은 것

- Suggestions(같은 양식 문서군 제안)의 v3 이식: unmatched 큐가 구조 서명으로 묶어 "신규 양식 후보"를 보여 주는 것으로 대체. 레시피 이식은 `assign_profile` 묶음 처리가 담당.
- 실제 DRM SDK, PostgreSQL 런타임 검증, DVC repro: v2와 같은 이유(환경 없음). 계약은 어댑터 경계만 고정.
- 계정/RBAC: 범위 밖(identity §7.2).

## 11. 폴더 일괄 등록 — 변경 판정·실패 처리·잠긴 파일·승인 정책

근거: 사용자 요구("파일을 하나하나 넣지 말고 루트 디렉터리 하나를 UI에서 지정하면 그 하위 파일을 다 집어넣게 하라",
"사용성과 속도를 항상 생각하라")와 계약 [§4.1.1](v3-contracts.md)·[§1.6](v3-contracts.md)(`source_digest`).
구현은 `kg/v3/service.py`(`scan_sources`·`register_directory`), `kg/v3/api.py`(`GET /sources/scan` · `POST /documents/register-directory`),
`frontend/src/v3/DocumentRegister.tsx`, `python -m kg.v3 register`.

- **"변경 없음" 판정은 내용 해시로 한다 — mtime이 아니라.** 대상은 DVC/사내 공유 폴더에서 체크아웃·복사되는 파일이라
  내용이 그대로여도 mtime이 바뀌고(체크아웃·동기화), 내용이 바뀌어도 mtime이 그대로일 수 있다(복원·시계 오차).
  mtime만 믿으면 "바뀐 게 없는데 수천 개를 다시 읽거나", "바뀐 문서를 건너뛰는" 두 가지 사고가 난다.
  판정에 쓰는 해시는 Reader가 `change_token`으로 쓰는 것과 **같은 SHA-256**(`kg.v2.readers.file_hash`)이다.
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
