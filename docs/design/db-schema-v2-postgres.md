# v2 확장 도구: PostgreSQL DDL, Apache AGE projection, DVC export

[db-schema-v2.md §10](db-schema-v2.md#10-sqlite--postgresql--age-dvc)의 이행 설계를 코드로 옮긴 도구 세 가지를 설명한다.
셋 다 **구문/구조 검증만 수행했다**. 이 저장소의 테스트 환경에는 PostgreSQL, Apache AGE, DVC가 없어
실제 서버에서 DDL 실행·그래프 적재·`dvc repro`를 검증하지 않았다. 배포 전에 고정한 PostgreSQL major + AGE
릴리스 조합에서 반드시 실행 검증한다.

| 도구 | 파일 | 검증 |
|---|---|---|
| PostgreSQL DDL | `db/v2/schema_postgres.sql` | `tests/test_schema_postgres.py` — pglast 파싱, 테이블/트리거 집합이 SQLite와 동일, PL/pgSQL 본문 파싱 |
| AGE projection | `kg/v2/age_projection.py`, `python -m kg.v2 age-projection` | `tests/test_v2_age.py` — 생성 텍스트, 이스케이프, 라벨 정규화, pglast 파싱 |
| DVC export | `kg/v2/export.py`, `python -m kg.v2 export`, `dvc.yaml`의 `v2_export_build` | `tests/test_v2_export.py` — 실제 빌드에서 폴더/manifest 생성, dvc.yaml 구조 |

## A. PostgreSQL DDL (`db/v2/schema_postgres.sql`)

`schema_sqlite.sql`과 테이블 32개, 트리거 72개, 인덱스 14개(+런타임 인덱스 5개), 뷰 1개가 이름 단위로 1:1이다.
`kg/v2/db.py`가 런타임에 만드는 SQLite 전용 `runtime_job`(작업 큐)·`version_signature`(문서군 제안용 파생 캐시, 재계산 가능) 테이블과 §10의 AGE projection/outbox 테이블은 포함하지 않는다. PostgreSQL로 옮길 때 이 둘은 서비스 마이그레이션에서 같은 컬럼으로 만든다.

### 타입 변환

| SQLite | PostgreSQL | 대상 |
|---|---|---|
| 애플리케이션 발급 uuid4 TEXT id | `UUID` | `*_id` 가운데 `kg/v2/db.py:uid()`로 발급하는 컬럼 전부(`artifact_id`, `kg_revision_id`, `document_id`, `document_version_id`, `sheet_id`, `access_id`, `region_id`, `template_id`, `template_version_id`, `application_id`, `mapping_revision_id`, `supersedes_id`, `run_id`, `published_run_id`, `pinned_run_id`, `series_id`, `item_id`, `project_id`, `integration_version_id`, `build_id`, `*_artifact_id`) |
| 논리 ID/키 TEXT | `TEXT` 유지 | `concept_id`, `from/to_concept_id`, `rule_key`, `field_key`, `scope_key`, `role_key`, `record_key`, `locator_key`, `request_key`, `instance_key`, `*_sha256`, `storage_ref`, `source_ref`, `git_commit` 등 |
| 시스템이 `now()`로 쓰는 ISO TEXT | `TIMESTAMPTZ` | `created_at`, `registered_at`, `captured_at`, `checked_at`, `expires_at`, `finished_at` |
| 제공자가 보고한 naive ISO | `TEXT` 유지 | `document_version.authored_at`, `source_modified_at` — §5의 "시간대가 불명확하면 UTC라고 추정하지 않는다"를 지키기 위해 원문 보존 |
| 0/1 + CHECK | `BOOLEAN` | `access_observation.can_*` |
| `json_valid()` TEXT | `JSONB` (기본값 `'{}'::jsonb`) | 모든 `*_json` 컬럼. 컬럼명은 그대로 두어 이관 시 컬럼 단위로 복사한다 |
| 십진 문자열 | `TEXT` 유지 + `NUMERIC` 파생 컬럼 | `extracted_item.value_text`는 value_type별 다형 컬럼이므로 유지하고 `value_numeric NUMERIC GENERATED ALWAYS AS (CASE WHEN value_type='decimal' THEN value_text::numeric END) STORED`를 추가 |
| INTEGER byte_size | `BIGINT` | `artifact.byte_size`, `document_version.byte_size` |
| `IS NOT` / `RAISE(ABORT, 'm')` / PRAGMA | `IS DISTINCT FROM` / `RAISE EXCEPTION 'm'` / 삭제 | 트리거 본문 |

상호 참조 FK(`document.current_version_id` → `document_version`, `template_application.published_run_id` → `extraction_run`)는
참조 대상 테이블을 만든 뒤 `ALTER TABLE ... ADD CONSTRAINT`로 붙인다. 나머지는 SQLite 파일 순서 그대로다.

### 트리거 → PL/pgSQL 함수

트리거 이름은 SQLite와 같고 모두 `FOR EACH ROW`다. PostgreSQL의 `WHEN` 절에는 서브쿼리를 쓸 수 없어 EXISTS 검사는 함수 본문으로 옮겼다.
메시지 문자열은 SQLite와 동일하다(SQLSTATE는 기본 `P0001`).

| 함수 | 트리거 |
|---|---|
| `v2_reject()` — `RAISE EXCEPTION '%', TG_ARGV[0]` | 모든 `*_no_update`/`*_no_delete`, `extraction_no_delete`, `build_no_delete`, `application_starts_unpublished`, `extraction_starts_queued`, `build_starts_queued` |
| `v2_mapping_head_approved_insert/update()` | `mapping_head_approved_insert/update` |
| `v2_mapping_head_invalidate()` (AFTER, `RETURN NULL`) | `mapping_head_invalidates_insert/update/delete` |
| `v2_run_mapping_pin()`, `v2_run_state_transition()`, `v2_application_identity()`, `v2_publish_run()`, `v2_lineage_selected_input()` | 같은 이름의 트리거 |
| `v2_kg_sealed()` | `domain_concept_sealed`, `domain_alias_sealed`, `domain_edge_sealed` |
| `v2_template_rule_sealed()`, `v2_application_sheet_sealed()` | `template_rule_sealed`, `application_sheet_insert/update/delete` |
| `v2_extracted_series_running()`, `v2_series_region_running()`, `v2_extracted_item_running()`, `v2_item_region_running()` | `*_running_insert` — 테이블마다 조인이 달라 함수를 분리했다(존재하지 않는 NEW 컬럼 참조 방지) |
| `v2_build_state_transition()`, `v2_build_input_pin()`, `v2_build_lineage_running()`, `v2_hierarchy_level()` | 같은 이름의 트리거 |
| `v2_integration_sealed()` (`TG_ARGV[0]` 메시지) | `integration_field_sealed`, `integration_source_sealed` |

### 주의

- **JSONB는 키 순서/공백을 정규화한다.** `definition_sha256`/`spec_sha256`/`content_sha256`은 항상 애플리케이션의
  `dump()`(`kg/v2/db.py`) 결과로 계산하고, JSONB 텍스트에서 재계산하지 않는다. 이관 코드도 같은 규칙을 따라야 한다.
- 트리거의 동시성 의미는 SQLite(단일 writer)와 다르다. `publish_run`의 EXCEPT 검사 같은 다중 행 불변식은 서비스 트랜잭션에서
  `SELECT ... FOR UPDATE` 등 행 잠금과 함께 써야 §11의 불변식이 유지된다.
- `value_numeric`은 `spec.decimal_text`가 지수 없는 고정 소수 문자열을 쓰므로 캐스트 가능하다. 다른 형식이 들어오면 INSERT가 실패한다.

## B. Apache AGE projection (`python -m kg.v2 age-projection`)

```bash
python -m kg.v2 age-projection --ws domains/financier --kg current --out age/kg_current.sql
python -m kg.v2 age-projection --ws domains/financier --kg 3 --out age/kg_r3.sql --graph v2_kg_r3
psql -d <db> -f age/kg_r3.sql      # 실제 AGE 서버에서 (이 저장소에서는 미검증)
```

- `--kg`는 `current`(최대 `revision_no`), 리비전 번호, 또는 `kg_revision_id`를 받는다. 없으면 `NOT_FOUND`.
- 그래프 이름 기본값은 `v2_kg_r<revision_no>`다. **revision_no는 DB마다 다르므로** 여러 워크스페이스를 한 AGE 서버에 올릴 때는 `--graph`로 이름을 구분한다.
  이름은 `^[a-z_][a-z0-9_]{0,62}$`이어야 한다(`INVALID_GRAPH_NAME`).
- 스크립트는 멱등이다: 그래프가 없으면 생성, 정점은 `MERGE (c:domain_concept {kg_revision_id, concept_id})` + `SET name/level/status`,
  엣지는 `domain_edge` PK 4개를 속성으로 `MERGE`. 라벨은 `domain_concept`(정점)과 `relation_type`(엣지)이다.
- **서비스 ID를 속성으로 유지하고 AGE 내부 id는 FK로 쓰지 않는다**(§10). 스크립트에 `id()`/`start_id`/`end_id`가 나오지 않는다.
- 라벨로 쓸 수 없는 `relation_type`(공백, 한글 등)은 `rel_<sha256 앞 12자>`로 정규화한다. 원문은 항상 엣지 속성 `relation_type`에 남으므로 조회 시 라벨이 아니라 속성을 본다.
- 문자열은 `\`, `'`, 개행, 탭, 기타 제어문자를 이스케이프한다. 달러 인용 태그(`$cy$`, `$v2age$`)를 포함한 이름은 `AGE_UNSAFE_TEXT`로 거부한다.
- 마지막 DO 블록이 정점/엣지 수를 검증하고 다르면 예외를 내므로 트랜잭션 전체가 롤백된다(§10 "검증 후 전환").
- 미검증 항목: AGE 릴리스별 `MERGE ... SET` 지원, plpgsql DO 블록 안의 `cypher()` 호출, `LOAD 'age'` 권한. 실행 전에 고정한 AGE 버전에서 확인한다.

## C. DVC export (`python -m kg.v2 export`)

```bash
python -m kg.v2 export --ws domains/financier --build <build_id> --out exports/v2/<build_id>
dvc add exports/v2/<build_id>          # 승인된 snapshot을 DVC로 추적
git add exports/v2/<build_id>.dvc exports/v2/.gitignore
```

또는 `dvc.yaml`의 `vars.v2_export`(`ws`, `build_id`, `out`)를 편집한 뒤 `dvc repro v2_export_build`.
스테이지 `deps`는 `kg/v2`, `db/v2/schema_sqlite.sql`이고 `outs`는 `${v2_export.out}` 하나다.

출력 폴더 구조:

```
exports/v2/<build_id>/
  custom-db-<build_id>.sqlite   # 빌드 산출물 그대로(발행 후 불변 파일의 복사본)
  manifest.json                 # 아래 필드
```

`manifest.json`(`format: data-gathering-v2-export/1`): `build`(build_id, integration_version_id, input_fingerprint,
input_manifest, row_count, 시각), `integration`(project, revision_no, kg_revision_id, spec_sha256, fields),
`kg_revision`(id, revision_no, content_sha256), `template_versions`(template_id, name, revision_no, format, definition_sha256,
engine_contract_version), `extraction_runs`(run_id, application/document/template version id, request_key, input_fingerprint,
engine_version, environment, selection, mappings[rule_key, mapping_revision_id]), `document_versions`(display_name, provider,
filename, provider_version_token, ciphertext/content sha256, byte_size, captured_at), `dataset`(file, artifact_id, sha256,
byte_size, dataset_manifest = SQLite `_manifest`), `source_policy`.

동작 규칙:

- `status='succeeded'`인 빌드만 내보낸다(`NOT_FOUND`). 내보내기 전에 모든 입력 원본의 접근 권한을 다시 확인한다(§8;
  원본이 없으면 reader의 `SOURCE_NOT_FOUND`). 복사본 sha256이 `artifact.sha256`과 다르면 `EXPORT_HASH_MISMATCH`,
  `_manifest`의 build_id가 다르면 `EXPORT_MANIFEST_MISMATCH`이며 만든 파일을 제거한다.
- 비어 있지 않은 폴더는 덮어쓰지 않는다(`EXPORT_EXISTS`, 409).
- 성공 시 `artifact(kind='manifest', dvc_ref_json={build_id, dataset_sha256, manifest_sha256, out})` 1행을 기록한다.
  반복 export마다 manifest artifact가 누적된다(감사 이력).
- `document.source_ref`, `artifact.storage_ref`는 서버 전용 불투명 참조라 manifest에 넣지 않는다.

**DVC에 두지 않는 것**(§10): 활성 `data/kg/v2.db`, `kg.db`, 잠금 중인 SQLite 파일, DRM 원본/렌더/해제본.
export는 발행 후 불변인 빌드 파일만 복사하므로 SQLite backup API 없이 트랜잭션 일관성이 보장된다.
