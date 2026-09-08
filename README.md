# Semantic Excel Integration

반정형 Excel(반복 블록·병합 셀·색 범례·수기 양식)을 **도메인 온톨로지**의 개념에
매핑해 **문서군(공유 양식) → 양식 → 문서** 계층으로 관리하고, 원본 충실 뷰어로
근거를 확인하며, 셀 단위 출처 추적(lineage)이 붙은 **통합 DB**를 만드는 시스템.

문서를 표준 양식으로 강제 변환하지 않는다 — 각 문서의 구조를 Knowledge Tree로
보존하고, 의미 노드를 고정 개념 체계에 연결한 뒤, 개념을 공통 축으로 목적별
DB를 생성한다. 문서는 `docs/`에 모은다 — 아키텍처 다이어그램(ERD·모듈·
시퀀스·EL 플로우)은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 설계 ↔ 모듈
대응은 [kg/README.md](kg/README.md), 작업 이력은
[docs/PROGRESS.md](docs/PROGRESS.md) 참고.

DB v2 재설계 제안은 [docs/design/db-schema-v2.md](docs/design/db-schema-v2.md)에 있다.
DRM 읽기 전용 접근, 여러 시트·복수 영역, 항목별 출처, 목적별 중복 처리와
화면/API 연결을 다룬다. `db/v2/schema_sqlite.sql`은 별도 빈 DB용 검증 스키마이며
현행 `kg/schema.sql`을 대체하거나 기존 DB를 자동 변경하지 않는다.

## 구성

```
kg/          코어 + 웹 서버 — 온톨로지/트리/시맨틱 매핑, 문서군·추출 레시피·
             재크롤링, DRM 획득 게이트, 원본 충실 렌더(LibreOffice PDF 포함),
             통합 DB 빌더(DAG/lineage), FastAPI(kg/webapp.py)
frontend/    React + TypeScript 5탭 UI — 유일한 프론트. 빌드(dist)가 커밋되어
             서버가 루트 / 에 바로 서빙한다 (프론트 수정 시 npm run build)
src/         Parser library — 파서·단위 엔진 코어(Inspector/RegionDetector/
             UnitRegistry/RecordBuilder, kg가 §14.1 계약으로 사용) + survey.
             레거시 앱 경로는 삭제됨 — 경위는 docs/MIGRATION.md
domains/<d>/ 도메인 워크스페이스 — config(개념·단위 units.yaml·정규화
             프리셋 normalizers.yaml)·data/raw(원본)·data/kg/kg.db
tests/       회귀 전체 (python -m pytest)
```

## 빠른 시작 (웹)

```bash
pip install -e ".[test]"

# 최초 1회 — 온톨로지 시드 + 원본 적재/매핑 (financier 예제 도메인)
python -m kg.cli --ws domains/financier seed
python -m kg.cli --ws domains/financier ingest --raw domains/financier/data/raw --map

# 웹 실행 — 이 서버 하나가 API와 웹 UI를 모두 서빙한다
python -m kg.webapp --ws domains/financier --port 8010
#  → http://localhost:8010/      5탭 UI (React — /app 경로도 동일)
```

React 개발/빌드 (선택):

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173 — /api 는 8010 백엔드로 프록시
npm run build   # dist/ 갱신 → kg.webapp 재시작 시 / 에 서빙 (dist는 커밋 대상)
```

운영 참고: 원본 충실 PDF 프리뷰에는 LibreOffice(`libreoffice-calc`)가,
DRM(암호화) 문서의 COM 렌더에는 Windows + Excel이 필요하다. 둘 다 없어도
셀 그리드 렌더·매핑·빌드는 동작한다. 사내(벤더) DRM 컨테이너 판별은
환경변수 `KG_DRM_MAGIC`(파일 선두 바이트 시그니처, 콤마 구분)으로 주입한다 —
시그니처를 저장소에 두지 않기 위한 규약이며, 미설정 시 해당 판별은 꺼진다.
전체 환경변수 목록과 기본값은 [.env.sample](.env.sample) 참고.

## 5개 화면

1. **파일 분석** — 파일명·작성자·템플릿 검색, 작성일 필터, 정렬, 템플릿
   배정/미배정 필터. 미등록(raw) 파일은
   분석 → 같은 양식의 문서군 제안 → 저장된 추출 레시피로 매핑 이식 등록.
   잠긴 파일(암호화/DRM)은 우회 없이 정식 해제 요청서 발급 → 해제본 도착 자동
   감지 → 등록.
2. **개념 탐색** — 온톨로지 트리 + 문서군 커버리지 그래프(확대/축소).
   문서군 상세는 `양식 → 문서(인스턴스)` 계층(미배정은 '기타'), 추출 레시피
   스냅샷/이력/롤백, 재크롤링(fill/reset_auto — 사람 승인은 불가침), 개념
   편집(별칭/관계/폐기).
3. **원본 데이터** — 원본 충실 렌더(병합/열폭/스타일/이미지/텍스트박스 앵커
   정합) + Semantic Overlay, 검수 큐(승인/반려/재매핑), Source Inspector
   (매핑 근거·양식 provenance·값 미리보기), PDF Preview.
4. **통합 DB** — `① 개념 트리 체크(상위 개념 체크 시 하위 일괄 선택) →
   ② 스키마 확인(컬럼명 조정) → ③ 생성·다운로드` 3단계. 양식 카드에서
   전처리(자동 정규화 / 원값 유지 / normalizers.yaml 정규화 프리셋)와 문서별
   가감을 조정한다. 결과는 `_source_*` lineage 컬럼·빌드 리포트를 포함하고
   `.db`/`.csv` 파일로 바로 내려받는다.
5. **템플릿 관리** — 파싱 템플릿의 생성/버전/라이프사이클과 문서 배정.
   문서:템플릿은 **N:M** — 템플릿마다 파싱하려는 정보(관점)가 달라도 한
   문서에 함께 배정되고, 파싱·override·버전 감사는 템플릿 단위로 독립이다.

## CLI

```bash
python -m kg.cli --ws domains/financier <command>
#  seed / ingest / watch / survey / map / search / review / project / build / trace / status / metrics
#  watch: raw 폴링 → 자동 등록(+매핑), DRM 해제본 도착 감지 포함
```

DVC: `dvc add data/raw`(원본 버전닝) + `dvc.yaml`의 `kg_ingest` 스테이지가
현행 재적재 흐름이다. 재현성(무엇이 어떤 원본·설정에서 나왔나)은 kg.db의
문서 버전 해시·빌드 서명·lineage가 담당한다.

## 테스트

```bash
python -m pytest        # 전체 회귀 (파서·매핑·문서군·뷰어·빌더·웹 API)
node e2e/run_all.mjs    # 브라우저 E2E (서버 기동 후 — e2e/README.md 참고)
```

## 다중 도메인

도메인(공정/제품군)마다 독립 워크스페이스를 쓴다 — 사전과 DB가 완전히 분리된다.
`domains/financier`(휘낭시에 실험 예제) 참고. 새 도메인은 `domains/<이름>/config`에
개념·단위·정규화 사전만 두면 같은 파서·API·프런트가 그대로 동작한다.

## 파서 능력 (src/ 코어 — kg가 재사용)

- 반복 블록/계층 헤더/색 범례/다영역 분할, 수기 혼돈양식 복원(서식 없는 헤더,
  후행 라벨/단위 전치, 캡션 그룹, 전치 KPI, 행별 단위 열)
- 아핀 단위 변환(K/°F→℃ 등 22종), 문서 내장 사전 자동 흡수, record key는
  위치가 아니라 업무 키
- 적재 전 어휘 조사(dry-run): `python -m kg.cli --ws domains/financier
  survey --raw incoming/` — 미지 라벨/모호 라벨/미등록 단위/예상 매핑률 리포트

## 레거시 정리 완료

`kg/` 이전의 초기 Canonical DB 앱 경로(7뷰 서버·canonicalize·loader·export·
pipeline·src.cli·web/·build_report)는 삭제됐다. `src/`는 현행이 사용하는
**Parser library**(inspect/segment/units/common/mapping + survey)로만 남는다 —
경위와 모듈 처분표는 [docs/MIGRATION.md](docs/MIGRATION.md), 초기 설계 이력은
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
