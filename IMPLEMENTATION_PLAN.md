# 구현 계획 — 단일 공정 반정형 Excel 통합·DB화·DVC 변경추적 시스템

설계 문서 v3.0(단일 공정 반정형 Excel 통합·DB화·DVC 변경추적 시스템)을 기준으로 한
실행 계획이다. 예시 3종 XLSX는 회귀 fixture로 고정하되, **파서는 예시에 하드코딩하지
않고** 다중 문서·다중 시트·대량 파일을 기본 전제로 일반화한다.

## 1. 목표와 비범위

- 목표: 구조 해석(Inspect) → 영역/반복 Block 탐지(Segment) → Concept 매핑(Mapping)
  → 정규화(Canonicalize) → 버전 DB 적재(Load) → 표준 Workbook Export까지의
  전체 파이프라인과, DVC/해시 기반 원본 버전 추적 및 증분 재처리.
- 비범위(문서 §1): 공정 간 흐름(대공정/소공정 지도), ML 모델 overlay, UI 구현.
  단 API/DB 스키마에는 확장 포인트(process_id 등)를 유지한다.

## 2. 예시 데이터 실측 결과 (문서 §2 검증)

| 파일 | 시트 | 반복 구조 | 특징 |
|---|---|---|---|
| 01_설비점검일지 | 설비점검 | 점검 Block 4개 (row 4/17/30/43) | key-value + 점검항목 표 + IF/COUNTIF 판정 + 특이사항 + 이미지, J2:K5 색상 범례(녹색=정상/노랑=확인/빨강=이상) |
| 02_품질검사성적서 | 검사결과 | 성적서 3개 (row 4/21/38) | 2단 병합 헤더(치수 검사(mm)>외경/길이/두께, 물성 검사>강도/수분), AVERAGE/판정 수식, L2:M5 범례(노랑=입력/회색=계산/빨강=이탈) |
| 03_공정운전실적 | Batch운전 | Batch 카드 4개 (row 4/17/30/43) | key-value + 가로 방향 온도 프로파일(초기/중간/종료) + 수율·평균온도 계산 + M2:N5 범례(파랑=입력/회색=계산/빨강=이상) |

핵심 확인 사항: **색 의미가 문서마다 다르다**(01의 노랑=확인필요 vs 02의 노랑=입력).
따라서 색 의미는 전역 규칙이 아니라 문서 로컬 범례에서 추론한다(문서 §10.2).

## 3. 저장소 구조 (문서 §8.1 준수)

```
repo/
├─ data/
│  ├─ raw/                  # DVC 추적 대상: 원본 Excel (예시 3종 포함)
│  ├─ staging/              # structure.jsonl, mapped.jsonl (중간 산출물)
│  ├─ canonical/            # 재현 가능한 canonical package
│  └─ quarantine/           # 파싱 실패/검토 필요
├─ config/
│  ├─ concepts.yaml         # Canonical concept / synonym 사전 (버전 필드 포함)
│  ├─ units.yaml            # 단위 변환 규칙 (버전 필드 포함)
│  └─ parser_rules.yaml     # 문서별 승인된 구조 규칙 (색 의미 등)
├─ metadata/
│  └─ source_manifest.jsonl # 파일별 hash/버전/처리 상태
├─ db/
│  ├─ schema_sqlite.sql     # 개발/테스트용 (기본)
│  └─ schema_postgres.sql   # 운영용 (문서 §6.3 DDL)
├─ src/
│  ├─ common/               # 데이터 모델(dataclass), 해시/캐시 키 유틸
│  ├─ watch/                # FileEventWatcher, StabilityGuard, EventQueue
│  ├─ dvc_adapter/          # DvcRepository (CLI subprocess) + HashOnlyDvc fallback
│  ├─ inspect/              # WorkbookInspector, Style/Formula/DrawingExtractor
│  ├─ segment/              # RegionDetector, RepeatedBlockDetector, HeaderResolver
│  ├─ mapping/              # ConceptRegistry, CandidateService, ConstraintFilter, ReviewPolicy
│  ├─ units/                # UnitParser, UnitConverter
│  ├─ canonicalize/         # RecordBuilder, ObservationBuilder, SemanticHasher, PackageWriter
│  ├─ loader/               # VersionedLoader (SCD2: 종료+INSERT), DeltaPlanner
│  ├─ export/               # CanonicalWorkbookExporter (고정 5-sheet 계약)
│  ├─ pipeline.py           # process_file() 오케스트레이션 (문서 §13.1)
│  └─ cli.py                # ingest / watch / export / status / reprocess
├─ tests/                   # 문서 §14 합격 기준 전체 + §14.1 mutation 회귀
├─ dvc.yaml                 # inspect → map → canonicalize 3-stage (문서 §8.5)
└─ IMPLEMENTATION_PLAN.md
```

## 4. 단계별 계획 (문서 §17 Phase 매핑)

| Phase | 산출물 | 완료 조건(테스트) |
|---|---|---|
| P0 Fixture | 예시 3종을 `tests/fixtures/` 회귀셋으로 고정 | 반복 Block 11개(4+3+4), 이미지 11개, 수식/merge 전수 탐지 |
| P1 Raw/DVC | Watcher(폴링+안정화+debounce), DVC 어댑터, `source_document`/`document_version` | 파일 변경 시 version history row 생성, dvc 미설치 시 sha256 fallback |
| P2 Structure | 다중 시트 Inspector + Region/Block/Header/Style/Formula/Image 파서 | structure JSON에 header_path·style_role·formula lineage·image anchor 포함 |
| P3 Concept | Concept Registry, synonym, 단위, confidence 분해 점수, Review 정책 | 낮은 confidence는 pending으로 분리되어 current DB에 미반영 |
| P4 Canonical DB | Record/Observation/Lineage + SCD2 versioned loader | 값 1개 수정 시 영향 observation만 새 버전 (종료+INSERT) |
| P5 Export | 고정 5-sheet 표준 Workbook | 3개 문서가 동일 출력 계약으로 통합 |
| P6 API/UI | (비범위 — FastAPI 라우터 스켈레톤과 projection 쿼리만 준비) | — |
| P7 Scale | 파일별 semantic cache key, region fingerprint 기반 증분 | 동일 캐시 키 재처리 skip, 1개 Block 수정 시 해당 Record만 재생성 |

## 5. 핵심 설계 결정 (문서 §1, §5, §6, §8, §9 반영)

1. **3중 버전 분리**: raw binary(DVC/sha256) ↔ 구조(structure_hash) ↔ 의미(semantic_hash).
   semantic_hash가 같으면 DB row는 갱신하지 않는다(§9 Binary only/Layout 케이스).
2. **재처리 캐시 키**(§5.4): `hash(source_hash, parser_version, concept_dict_version, unit_rule_version)`.
   사전이 바뀌면 원본이 안 바뀌어도 재매핑된다.
3. **Record + Observation long model**(§6.1): grain이 다른 문서(점검 1회/LOT·시료/Batch 1회)를
   wide table 없이 통합. wide는 export/view에서 pivot.
4. **UPDATE 금지, 종료+INSERT**(§9.1): `valid_from/valid_to/is_current` SCD2.
   과거 document_version 기준 당시 current view 재구성 가능(Rollback 테스트).
5. **색 의미는 로컬**(§10.2): 시트 내 범례 region을 탐지해 fill→style_role 매핑을 만들고,
   승인 시 `parser_rules.yaml`로 승격. 전역 하드코딩 금지.
6. **수식 = calculated role**(§10.3): formula text + cached value 별도 저장,
   참조셀 파싱으로 calculated_from lineage 유지.
7. **이미지 = attachment**(§10.4): 바이너리 sha256 + anchor 좌표로 가장 가까운 Block에 귀속.
   OCR은 기본 비활성.
8. **DVC 경계**(§8.5): DVC pipeline 산출물은 canonical package까지. DB 적재는 별도
   idempotent Loader. DVC 미설치 환경에선 HashOnlyDvc가 sha256 manifest로 대체하고
   동일 인터페이스를 유지한다.

## 6. 고도화 항목 (예시 대비 실데이터 스케일 대응)

- **다중 시트**: Inspector/Detector가 시트 목록을 순회하고 sheet_name을 매핑 문맥
  고가중치 feature로 사용. 시트별 독립 범례/Block 인식.
- **대량 파일**: 파일별 semantic cache key로 변경 파일만 재처리. manifest(jsonl)에
  파일별 상태 기록. Block 단위 region fingerprint로 부분 재생성.
- **반복 Block 일반화**: 제목 텍스트 패턴이 아니라 (병합 폭 + fill + bold + 상대
  레이아웃 시그니처)의 반복성으로 탐지 — 행 간격이 달라도 동작(§4.2 fingerprint).
- **계층 헤더 일반화**: 2단 이상 N단 병합 헤더를 merge span 트리로 header_path 생성.
- **가로 프로파일**: 행 기반 표 가정 없이 PROFILE region으로 별도 분류.
- **동의어 학습 루프**: 승인된 매핑 결정은 synonym 사전에 승격되어 재등장 시 안정 매핑.

## 7. 검증 계획 (문서 §14)

§14 표의 10개 합격 기준을 pytest로 구현하고, §14.1 mutation(헤더 행 이동, 시트명
변경, Block 추가/삭제, 단위 변경, 동의어 헤더, 수식 변경, 값 1셀 수정 등)을
fixture 변형 생성기로 자동화한다.
