# 단일 공정 반정형 Excel 통합·DB화·DVC 변경추적 시스템

설계 문서 v3.0을 구현한 파이프라인. 하나의 공정에 속하는 서로 다른 반정형 Excel
문서(반복 Block, 병합 셀, 색 범례, 수식, 이미지)를 개념 중심으로 정규화·통합하고,
원본 변경과 DB 반영 이력을 재현 가능하게 관리한다.

전체 구현 계획과 설계 결정은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) 참고.

## 파이프라인

```
원본 Excel → Watcher(안정화) → DVC/해시 버전 → Inspector(구조)
  → RegionDetector(반복 Block/계층 헤더/범례) → ConceptMapper(동의어+문맥+단위)
  → Review Gate(낮은 confidence는 pending) → Canonicalizer(Record+Observation)
  → Canonical Package(JSONL+manifest) → VersionedLoader(SCD2 DB) → 표준 Workbook
```

## 빠른 시작

```bash
pip install -e ".[test]"

python -m src.cli ingest            # data/raw 전체 증분 처리 (semantic cache)
python -m src.cli status            # 문서/버전/레코드 현황
python -m src.cli export            # 고정 5-sheet 표준 workbook 생성
python -m src.cli hub --lot BT26821 # LOT 허브: 문서 횡단 통합 뷰
python -m src.cli graph             # 지식 그래프 projection (엔티티/관계)
python -m src.cli ontology          # 개념 온톨로지 계층
python -m src.cli watch             # polling watcher 루프 (debounce+안정화)
python -m src.cli reprocess         # 캐시 무시 전체 재처리
python -m src.cli survey --raw incoming/   # 적재 전 어휘 조사 (사전 격차 리포트)

python -m pytest tests/            # §14 합격 기준 + 복합/혼돈 실데이터 + API 71개 테스트
```

### 웹 UI (REST API + 경량 프론트)

```bash
pip install fastapi uvicorn
uvicorn src.api.server:app --port 8000
# → http://localhost:8000        7개 뷰 (온톨로지/지식그래프/매핑리뷰/단위/LOT허브/Lineage/레코드)
# → http://localhost:8000/docs   OpenAPI 스키마 (프론트-백 계약)
```

- 모든 목록은 서버 페이지네이션(`?page=&size=`, 최대 500) — 대량 데이터에서도
  화면에 보이는 만큼만 조회한다. 1만 관측치 기준 목록 12ms / 상세 5ms.
- 고정 크기 projection(stats/ontology/graph/documents)은 프로세스 캐시 + ETag 304.
- 매핑 리뷰 화면에서 검토 대기 항목을 승인하면 `config/concepts.yaml` 동의어로
  승격되고 사전 버전이 올라가 다음 ingest부터 재매핑된다 (§5 학습 루프).
- 프론트(`web/`)는 빌드 파이프라인 없는 순수 ES Module — 컴포넌트는 DOM을
  반환하는 순수 함수라 파일 복사만으로 재사용 가능하다. 구조는 WEB_PLAN.md 참고.

### 적재 전 어휘 조사 (survey — 온톨로지 우선 워크플로)

신규 문서 묶음은 바로 적재하지 말고 먼저 조사한다. `survey`는 DB/캐시를 일절
건드리지 않는 dry-run으로 구조 해석 + 매핑만 수행해서 사전 격차를 보고한다:

```bash
python -m src.cli --repo-root domains/financier survey --raw incoming/ --out survey.json
```

- **미지 라벨**: 후보 개념이 없는 라벨 (신규 개념 정의 필요) — 빈도/출처/표본 값 포함
- **모호 라벨**: 후보는 있으나 auto 임계(0.85) 미달 — 후보 개념·신뢰도와 함께 제시
- **미등록 단위**: 값의 단위뿐 아니라, 단위가 라벨/헤더로 흡수된 경우까지 탐지
  (예: °F 미등록 시 화씨 값이 무단위로 ℃ 개념에 적재되는 침묵 오염을 사전 차단)
- **예상 매핑률**: 이대로 적재했을 때의 커버리지 예측
- **proposal_yaml**: 후보 개념별 동의어 후보 / 신규 개념·단위 스텁 — 검토 후
  concepts/units.yaml에 반영하면 적재→pending→수정→재적재 사이클이 한 번으로 준다

검증: 혼돈양식 v3 6종을 보강 전(v4) 사전으로 survey하면 예상 매핑률 48.9%와
함께 실제로 보강이 필요했던 라벨('core T' 468건, 'PUFF / dome rise', '봉투 폭',
'°F' 등)을 정확히 짚는다. 보강 후 예상치(98.1%)는 실제 적재 결과와 일치한다.

서버 없이 공유할 스냅샷이 필요하면 정적 리포트 생성기를 쓴다:

```bash
python scripts/build_report.py     # → data/canonical/report.html (6패널 + Workbook 미리보기)
```

## 핵심 성질

- **3중 버전 분리**: raw binary(DVC/sha256) / structure hash / semantic hash.
  서식만 바뀌면 DB row는 그대로다.
- **재처리 캐시 키** = hash(원본 해시, parser 버전, concept 사전 버전, 단위 규칙 버전).
  사전이 바뀌면 원본이 안 바뀌어도 재매핑된다.
- **Record + Observation long model**: grain이 다른 문서(점검/LOT·시료/Batch)를
  스키마 변경 없이 통합. wide 분석 뷰는 pivot으로 생성.
- **UPDATE 없음**: valid_from/valid_to/is_current SCD2. 값 1개 수정 시 해당
  observation만 새 버전이 되고, 과거 시점 current view를 재구성할 수 있다.
- **색 의미는 문서 로컬**: 시트 범례를 탐지해 fill→역할(입력/계산/이상)을 추론.
  같은 노랑이 문서마다 다른 뜻이어도 안전하다.
- **record key는 위치가 아니라 업무 키**: 헤더가 2행 밀려도, 시트명이 바뀌어도
  같은 레코드로 인식한다.
- **다중 시트/대량 파일 전제**: 시트별 독립 분해, 파일별 증분 캐시, 삭제는
  tombstone 처리.
- **복합 실데이터 대응(온톨로지/지식그래프 확장)**:
  - 아핀 단위 변환: 348.15 K → 75.00 ℃, 167 °F → 75.00 ℃ (+ kPa/MPa/ton/g/
    Pa·s/fraction/ppm/MWh 등 22종 변환 검증)
  - 문서 내장 사전(MASTER_코드표, Tag_Dictionary, 현장코드, 계산근거)을 자동
    인식해 doc-scoped 동의어로 흡수 — RX_TEMP/QTY_IN 같은 태그가 표준 개념으로 해소
  - 반복 블록 없는 시트의 다영역 분할: 좌우 병렬 블록([Block A]|[Block B]),
    AREA-1/2/3, 3단 헤더+단위행, "파랑=PLC" 인라인 범례
  - Grain 교정: 행=LOT 표와 전치 표(개념=행, LOT=열)를 LOT 단위 레코드로 분할
  - LOT 허브: 같은 LOT(BT26821)를 생산일보/MES/QC/공정실적 문서 횡단으로 통합
  - Cross-document lineage: '반응온도'가 75℃/75 degC/348.15 K/PV 75 네 가지
    표현에서 모두 75.00 ℃로 정규화되고 출처 셀 주소가 보존됨
  - 온톨로지(공정/품질/설비/에너지/시간/기타 도메인)와 지식 그래프
    (공정운전—uses→설비 등, 실제 레코드 co-occurrence 근거 포함) projection

## 다중 도메인

도메인(공정/제품군)마다 독립 워크스페이스를 쓴다 — 사전과 DB가 완전히 분리된다:

```
domains/financier/            # 예: 휘낭시에 실험 도메인 (베이커리)
├─ config/                    #   도메인 전용 concepts/units/relations
└─ data/raw/                  #   해당 도메인 원본 Excel
```

```bash
python -m src.cli --repo-root domains/financier ingest --raw domains/financier/data/raw
python -c "import uvicorn; from src.api.server import create_app; \
           uvicorn.run(create_app('domains/financier', web_dir='web'), port=8001)"
```

같은 파서·API·프론트가 사전 교체만으로 동작한다. 휘낭시에 12개 문서(복합양식 6
+ 혼돈양식 v3 6, 약 120개 시트) 기준 레코드 290개, 관측치 24,348개, 매핑률
98.1% — LOT 대신 레시피가 허브 키가 되어 같은 레시피(초코)가 두 양식의 문서를
횡단으로 조인되고, 지식 그래프는 도메인 관계(굽는다/측정함/원가구성)로 자동
배치된다.

혼돈양식 v3(수기 스타일 — 서식/구조 규칙이 거의 없는 문서)에서 검증된 구조 복원:

- **서식 없는 헤더**: bold/fill이 전혀 없어도 등록 단위 토큰이 다수인
  단위행(min/#/°F/cm/%/g) 바로 위 텍스트 행을 헤더로 강제 인식
- **후행 라벨/단위 전치**: `…숫자열… | core T | °C` 처럼 행 오른쪽 끝에 개념과
  단위가 붙는 변형을 별도 표로 구출 — 위쪽 `metric|0|3|…|21` 키 행에서 시간축
  row_key까지 복원
- **캡션 그룹**: `CORE TEMP (℃)` 단독 캡션 아래 `base/Rum 2%/… | 숫자열` 행
  묶음을 캡션=개념, 행 머리=variant 인스턴스로 해석
- **전치 KPI**: `metric|185|195|…` 키 행 아래 `core max(℃)`/`rise mm`/`crack%`
  같은 단위 내장 라벨 행을 행=개념으로 복원
- **행별 단위 열**: 원가표 `투입|단위` 열의 kg/g 혼합 단위를 행 단위로
  왼쪽 값 열에 전파 (버터 0.115 kg → 115 g, ℉ 심부온도는 아핀 변환으로 ℃)
- **시트명 금지 문자**: openpyxl이 거부하는 `210?` 같은 시트명은 임시 사본에서
  정화 후 파싱 (원본 불변)

## DVC

`dvc`가 설치된 환경에서는 `dvc add data/raw` + remote push로 원본 binary를
보존하고, `dvc.yaml`의 inspect → canonicalize 스테이지로 canonical package를
재현한다. DB 적재는 DVC 밖의 idempotent Loader가 맡는다(§8.5). DVC 미설치
환경에서는 sha256 기반 fallback이 동일 인터페이스로 동작한다.

```bash
git init && dvc init
dvc add data/raw
dvc remote add -d storage <S3-or-SSH-remote>
dvc push
```

## 저장소 구조

```
config/      concepts.yaml(개념·동의어), units.yaml(단위), parser_rules.yaml(문서별 승인 규칙)
db/          schema_sqlite.sql(기본), schema_postgres.sql(운영용 — 논리 동일)
src/         watch / dvc_adapter / inspect / segment / mapping / units /
             canonicalize / loader / export / api / pipeline.py / cli.py
tests/       §14 합격 기준 + §14.1 mutation 회귀 (fixtures = 예시 XLSX 3종)
data/raw/    원본 Excel (운영에서는 DVC 추적 대상)
```
