# DVC 중심 최소 DB 스키마

## 결론

기존 `db/v2`의 32개 물리 테이블은 재현성·감사·권한·렌더 캐시·빌드 lineage까지 DB 자체에서 모두 해결하려는 설계다.
이 프로젝트가 원본 Excel, 템플릿, KG 정의, 통합 산출물의 버전 이력을 Git/DVC로 관리한다면 그 책임을 DB에 다시 구현할 필요가 없다.

이 문서는 다음 경계를 기본안으로 둔다.

- **Git/DVC**: 파일의 버전과 복원. 원본 Excel, 템플릿 정의, KG export/spec, 통합 산출물.
- **RDB**: 안정 ID, 문서-시트-템플릿-KG의 관계, 현재 검수 매핑, 실행과 추출값.
- **해시**: 변경 감지/무결성 속성일 뿐 PK가 아니다.
- **실행 이력**: DVC가 대체하지 못하므로 `extraction_run`만 최소한 유지한다.

실행 가능한 DDL:

- `db/dvc/schema_sqlite.sql`
- `db/dvc/schema_postgres.sql`

기존 `db/v2`는 즉시 삭제하지 않는다. 현재 `kg/v2` 런타임과 테스트가 v2 테이블에 강하게 결합돼 있으므로 비교/마이그레이션 기준으로 남기고, 신규 구현은 DVC 최소 스키마를 기준으로 전환한다.

## 1. 기존 사용자 초안에서 유지/수정할 부분

| 초안 | 최소 스키마 | 이유 |
|---|---|---|
| `문서해시 PK` | `document_id PK` + `content_sha256` 속성 | 파일 수정으로 논리 문서의 ID가 바뀌면 안 됨 |
| `excelFile` 상속 | 제거, `document.file_type` | 현재 역할이 중복됨 |
| `시트해시 PK` | `sheet_id PK` + `document_id FK` | 같은 내용의 시트가 둘일 수 있고 내용 수정이 정체성을 바꾸면 안 됨 |
| `템플릿해시 PK` | `template_id PK` + `dvc_rev`/`definition_sha256` | 템플릿 이력은 DVC가 담당 |
| `템플릿매핑` 한 테이블 | `template_application` + `mapping` + `extracted_value` | 적용 관계, 검수 매핑, 실행 결과의 수명이 다름 |
| `키위치`/`값위치` 문자열 | `source_region` FK | 병합셀, 이미지, 차트, 복합 영역을 같은 방식으로 참조 |
| `도메인kg` | `domain_concept` | 이름/레벨 외 타입/단위/정의는 실제 통합 시 필요 |
| 동의어 없음 | `domain_alias` | 문서마다 다른 표현을 같은 개념에 연결하기 위함 |
| `도메인엣지` | `domain_edge` | 그대로 유지 |

## 2. 테이블 수

업무 테이블은 12개다. `schema_meta`는 스키마 식별용이라 업무 테이블 수에서 제외한다.

| 영역 | 테이블 | 책임 |
|---|---|---|
| 문서 | `document` | 논리 문서, 현재 원본 경로와 DVC ref |
| 문서 | `sheet` | 현재 문서 snapshot의 시트 |
| 원본 | `source_region` | 셀/이미지/차트 등의 위치 |
| KG | `domain_concept` | 현재 도메인 개념 |
| KG | `domain_alias` | 동의어/표현 |
| KG | `domain_edge` | 개념 간 관계 |
| 템플릿 | `template` | 논리 템플릿과 현재 DVC ref |
| 템플릿 | `template_rule` | 재사용 가능한 추출 규칙 |
| 적용 | `template_application` | 어느 문서에 어느 템플릿을 어떤 목적으로 적용하는지 |
| 매핑 | `mapping` | 규칙-시트-영역-도메인 개념의 현재 검수 결과 |
| 실행 | `extraction_run` | 실제 추출 실행과 사용한 DVC ref 고정 |
| 결과 | `extracted_value` | 값 하나당 한 행 |

v2에서 제거한 대표 테이블은 다음과 같다.

`document_version`, `kg_revision`, `template_version`, `artifact`, `mapping_revision`, `mapping_head`, `run_mapping`, `extracted_series`, `series_region`, `item_region`, `integration_project`, `integration_version`, `integration_field`, `integration_source`, `build_run`, `build_input`, `build_lineage`, `access_observation`, `render_chunk`.

없앤 이유는 크게 세 가지다.

1. 파일/정의 버전 이력은 DVC와 중복된다.
2. 현재 요구에서 검수 리비전 전체를 RDB에서 event sourcing 할 필요가 없다.
3. 사용자 DB 빌드와 렌더/권한 캐시는 실제 요구가 생길 때 독립 모듈로 추가할 수 있다.

## 3. 전체 관계

```mermaid
erDiagram
    document ||--o{ sheet : contains
    sheet ||--o{ source_region : has

    domain_concept ||--o{ domain_alias : aliases
    domain_concept ||--o{ domain_edge : from
    domain_concept ||--o{ domain_edge : to

    template ||--o{ template_rule : defines
    document ||--o{ template_application : applies
    template ||--o{ template_application : used_by

    template_application ||--o{ mapping : owns
    template_rule ||--o{ mapping : mapped_by
    sheet ||--o{ mapping : located_on
    domain_concept ||--o{ mapping : means
    source_region ||--o{ mapping : key_or_value

    template_application ||--o{ extraction_run : executes
    extraction_run ||--o{ extracted_value : produces
    mapping ||--o{ extracted_value : based_on
    source_region ||--o{ extracted_value : sourced_from
```

## 4. DVC와 DB의 역할 경계

### DVC가 관리할 것

```text
source Excel  ─┐
template file ─┼─ Git/DVC revision
KG spec/export ┤
output DB/file ┘
```

DVC revision은 특정 시점의 파일을 복원하는 용도다. DB의 PK로 사용하지 않는다.

### DB가 관리할 것

```text
document_id
   └─ sheet_id
       └─ source_region

(document, template)
   └─ template_application
       └─ mapping(rule, sheet, region, concept)
           └─ extracted_value
```

즉 DVC가 `A.xlsx@rev123`을 복원할 수 있어도, 그 파일의 `Sheet2!B3:C8`이 어떤 템플릿 규칙과 어떤 도메인 개념에 연결됐는지는 RDB가 관리한다.

## 5. 왜 `extraction_run`은 남기는가

DVC가 파일 버전을 관리해도 다음 질문은 답하지 못한다.

> 어떤 엔진 버전으로, 어느 시점에, 어떤 문서/템플릿/KG revision을 사용해 이 결과를 만들었는가?

따라서 실행 1건만 별도로 저장한다.

```text
extraction_run
- application_id
- document_dvc_rev
- template_dvc_rev
- kg_dvc_rev
- engine_version
- status
- started_at / finished_at
```

v2의 `run_mapping`, `extracted_series`, `series_region`, `item_region`까지는 현재 단계에서 만들지 않는다.

## 6. 매핑 정책

`mapping`은 **현재 승인 상태**를 저장한다.

```text
mapping
- application_id
- rule_id
- sheet_id
- domain_id
- instance_key
- observed_key
- key_region_id
- value_region_id
- status
```

수정할 때 기존 row를 갱신한다. 과거 수정 이력 전체가 제품 요구로 확정되면 그때 `mapping_audit` 하나를 append-only로 추가한다.
초기부터 `mapping_revision + mapping_head + CAS trigger`를 강제하지 않는다.

`instance_key`는 같은 규칙이 한 시트에서 여러 반복 블록에 매핑되는 경우를 구분한다.

## 7. 복합 셀/이미지 위치

`source_region`은 단순 A1 문자열만 보관하지 않는다.

- `locator_key`: UI/디버깅용 표현 (`B3:C8`, `B3:C3,F3` 등)
- `r1,c1,r2,c2`: 일반 셀 범위의 빠른 조회/viewport용
- `geometry_json`: 비연속 영역, 병합 정보, 이미지/차트 anchor 등 확장 데이터

따라서 위치 모델을 별도 테이블로 유지하되, v2처럼 series/item별 region 연결 테이블까지 늘리지는 않는다.

## 8. 문서가 변경됐을 때

1. DVC가 새 원본 revision을 기록한다.
2. `document.dvc_rev`, `content_sha256`, 메타데이터를 갱신한다.
3. 해당 문서의 `sheet`와 `source_region` projection을 다시 만든다.
4. 기존 `mapping`은 시트/영역 재매칭 결과에 따라 유지하거나 `proposed`로 되돌린다.
5. 새 추출은 새 `extraction_run`을 만들고 사용한 DVC refs를 고정한다.
6. 과거 파일 자체가 필요하면 DB의 `document_version` row가 아니라 DVC에서 복원한다.

이 정책은 **파일 이력과 관계 이력을 분리**한다. 파일 변경마다 DB 엔티티 전체를 복제하지 않는다.

## 9. 템플릿/KG 변경도 동일한 원칙

템플릿과 KG 정의 파일을 Git/DVC로 관리한다.

- 템플릿 수정: `template.dvc_rev` 갱신 → 영향 application 재검수
- KG 수정: KG export/spec의 DVC revision 갱신 → 관련 mapping 검증
- 과거 결과 재현: `extraction_run`에 고정된 document/template/KG refs로 파일 복원 후 재실행

DB에 `template_version`, `kg_revision`을 별도로 만들지 않는다.

## 10. 통합 DB는 아직 스키마에 넣지 않는다

현재 v2의 `integration_*`, `build_*`, `build_lineage`는 결과 DB 빌더가 성숙한 뒤 분리해서 추가한다.

현재 단계에서는 다음으로 충분하다.

```text
approved mapping
      ↓
successful extracted_value
      ↓
통합 로직
      ↓
SQLite/CSV/Parquet 등 산출물
      ↓
DVC
```

통합 결과가 어떤 원본 값에서 왔는지 셀 단위 lineage가 실제 제품 요구로 확정되면 그때 `build_lineage` 하나를 추가한다.

## 11. 채택 기준

이 스키마를 기본안으로 채택하고, 다음 요구가 실제로 발생할 때만 테이블을 추가한다.

- DB 내부에서 문서 버전 목록을 고속 질의해야 함 → `document_version`
- 매핑 수정 전체 감사 이력이 필수 → `mapping_audit`
- 하나의 결과 셀에 N개 원본의 lineage가 제품 기능 → `build_lineage`
- 복잡한 list/matrix series 자체를 독립 객체로 질의해야 함 → `extracted_series`
- 권한/DRM 판정을 DB에서 감사해야 함 → `access_observation`
- 렌더 캐시를 다중 서버에서 공유해야 함 → `render_chunk`

**요구가 생기기 전에 미리 만들지 않는다.**
