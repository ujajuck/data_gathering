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
python -m src.cli watch             # polling watcher 루프 (debounce+안정화)
python -m src.cli reprocess         # 캐시 무시 전체 재처리

python -m pytest tests/            # 설계문서 §14 합격 기준 28개 테스트
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
