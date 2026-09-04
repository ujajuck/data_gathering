# Fixed Domain KG 기반 Excel 데이터 통합 (설계서 v0.1 구현)

`kg/`는 "고정 지식 그래프 기반 Excel 데이터 통합 시스템 설계서 v0.1"의 구현이다.
문서를 하나의 표준 양식으로 강제 변환하지 않는다 — 각 문서의 구조를 **Document
Knowledge Tree**로 보존하고, 트리의 의미 노드를 **Fixed Domain KG**의 개념에
연결한 뒤, KG 개념을 공통 축으로 **목적별 Custom RDBMS**를 생성한다.

기존 `src/` 파이프라인(Inspector/RegionDetector — 혼돈양식 복원 휴리스틱 포함)은
§14.1 Parser 계약의 구현체로 재사용하며, 이후 계층은 파서 내부에 종속되지 않는다.

## 설계서 ↔ 모듈 대응

| 설계서 | 구현 |
|---|---|
| §5 Fixed Domain KG (노드/관계 5종/Alias/Unit) | `config/domain_kg.yaml` + `kg/domain/loader.py` |
| §6 Document Knowledge Tree (+Value Payload 분리, Asset) | `kg/tree/builder.py` |
| §7 Semantic Mapping (후보검색→Top-K→판정, 상태 4종) | `kg/mapping/retriever.py` · `judge.py` · `mapper.py` |
| §8 Domain 중심 역탐색 | `kg/search.py` `reverse_lookup()` |
| §9 Custom RDBMS (Integration Project, `_source_*` 컬럼) | `kg/integration/builder.py` |
| §10 Transformation DAG (13종 블록) | `kg/integration/dag.py` |
| §11 Lineage (값→변환→셀→헤더→시트→문서→버전) | `lineage_edge` + `kg/search.py` `lineage_of()` |
| §12 버전/Tree Diff (semantic·content 지문 분리) | `kg/tree/diff.py` |
| §13 논리 스키마 4개 영역 | `kg/schema.sql` |
| §15 예외/검수 정책 (UNMAPPED 유지, 임의 개념 생성 금지) | judge/mapper + `review` CLI |
| §16.1 Phase 1 정량 지표 | `kg/cli.py metrics` |

## 빠른 시작 (financier 도메인)

```bash
python -m kg.cli --ws domains/financier seed                                  # Domain KG 시드
python -m kg.cli --ws domains/financier ingest --raw domains/financier/data/raw --map
python -m kg.cli --ws domains/financier search core_temperature               # §8.1 역탐색
python -m kg.cli --ws domains/financier review --list                         # 검수 큐
python -m kg.cli --ws domains/financier project --config kg/examples/experiment_result.yaml
python -m kg.cli --ws domains/financier build --name experiment_result        # Custom RDBMS
python -m kg.cli --ws domains/financier trace --build BLD-… --row 1 --field core_temp
python -m kg.cli --ws domains/financier metrics                               # §16.1 지표

python -m kg.webapp --ws domains/financier --port 8010                        # 웹 UI
```

## 웹 UI (4탭)

`kg/webapp.py` 서버 하나가 REST API와 React 프론트(`frontend/dist`)를
루트 `/` 에 서빙한다 (`/app` 은 구 경로 호환). 바닐라 web_kg는 React 포트
완료 후 제거됐다.

화면: **파일 분석**(검색/작성일 필터/정렬, raw 분석→문서군 제안→레시피 이식
등록, DRM 정식 해제 요청→해제본 감지) / **개념 탐색**(온톨로지 트리+문서군
커버리지 줌, 문서군 상세 `양식→문서` 계층·레시피 스냅샷/롤백·재크롤링, 개념
편집) / **원본 데이터**(원본 충실 렌더 — 병합/스타일/이미지/텍스트박스 앵커
정합 + Semantic Overlay, 검수 승인/반려/재매핑, PDF Preview) / **통합 DB**
(개념→양식→문서 선택 마법사, 양식별 전처리 — 자동 정규화/원값 유지, 스키마
제안·빌드·lineage).

## 핵심 성질

- **node_id는 (document, tree_path)의 안정 해시** — 행이 밀려도 경로가 같으면 같은
  노드다. 값만 바뀌면 semantic 지문이 유지되어 **매핑이 승계**되고 payload만 새
  버전으로 교체된다. 헤더 텍스트가 바뀌면 removed+added로 처리되고 기존 매핑은
  비활성화된다(재평가 대상).
- **판정기는 교체 가능**: 기본 RuleJudge(결정론, 오프라인)와
  LLMJudge(`ANTHROPIC_API_KEY` 설정 시, 후보 밖 응답은 기각). 어느 쪽이든 LLM/규칙은
  **기존 개념 중 판별만** 한다 — 임의 개념 생성 금지(§1.2).
- **값은 그래프 밖에**: 트리 노드는 대표값(≤4)만 갖고, 전체 값은
  `data_payload`/`payload_value`(관계형 Payload)에 저장된다(§6.3).
- **Canonical DB 없음**: 통합 산출물은 Integration Project별 별도 SQLite 파일이며,
  모든 행이 `_source_document_id/_source_version_id/_source_sheet/_source_locator`를
  갖고 셀 단위 `lineage_edge`로 역추적된다.
- **Source 조립**: 같은 TABLE(Region)에 속한 소스 노드들의 payload를 행 키
  (row_key, 없으면 원본 셀 행 번호)로 정합해 프레임을 만든다 — 문서마다 표 모양이
  달라도 Region 내부의 행 정합은 원본 구조가 보장한다.

## 검증 결과 (financier 12문서, 복합+혼돈 양식)

- Tree: 2,833 노드 / payload 24,348 값 / 헤더 locator 보존 100%
- Mapping: 2,261 판정 — AUTO 89.1%, REVIEW 4.4%, UNMAPPED 6.5% (rule judge)
- 역탐색: `core_temperature` → 두 양식·12문서 횡단, `core T`(전치)·`°F`(화씨) 소스 포함
- Build: `experiment_result` 2,662행 (°F→℃·cm→mm 정규화, add-in별 시계열 보존),
  lineage 8,958셀. 비호환 단위는 변환하지 않고(§15) 빌드 로그 warnings로 드러난다
- 변경 추적: 값 수정 → 매핑 승계 + payload 교체 / 헤더 개명 → 제거+추가 + 매핑
  비활성화 / 개명 원복 → 노드 부활(added). ingest는 원자적(도중 실패 시 전체 롤백)

정책 노트: `REJECTED`는 사람의 결정이므로 자동 재평가하지 않는다(검수자가
`review --action remap`으로만 변경). 사전 보강 후에는 `map --retry-unmapped`로
UNMAPPED만 재평가한다. `lineage_edge.transform_path`는 해당 빌드의 선형 DAG
전체이며, 파생/집계 셀은 lineage 항목의 `derived`/`aggregated` 표식으로
구분된다.

테스트: `python -m pytest tests/test_kg_system.py` (20 cases — 적대 리뷰 회귀 10건 포함, 전체 스위트 100개와 공존).
