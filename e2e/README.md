# E2E 시나리오 (Playwright)

현행 React UI 기준의 브라우저 시나리오 테스트. UI가 바뀌면 **여기 스크립트도
같은 커밋에서 갱신한다** — 구버전 UI를 가정한 스크립트를 방치하지 않는다.

## 실행

```bash
# 1) 서버 기동 (financier 예제 도메인)
python -m kg.webapp --ws domains/financier --port 8010

# 2) 전체 실행 — kg.db를 자동 백업/원복한다
node e2e/run_all.mjs
```

환경변수: `KG_BASE_URL`(기본 http://127.0.0.1:8010), `KG_WS`(기본
domains/financier), `PLAYWRIGHT_INDEX`/`CHROMIUM_PATH`(브라우저 경로).
개별 시나리오는 `node e2e/02_concept_tree_build.mjs`처럼 단독 실행 가능
(DB 변조 시나리오는 러너로 돌리거나 수동으로 원복할 것).

## 시나리오

| 파일 | 검증 |
|---|---|
| 01_shell | 루트 `/`·`/app`이 React 5탭 서빙 |
| 02_concept_tree_build | 개념 트리 상위→하위 일괄 선택, indeterminate, 빌드, .db/.csv 다운로드 |
| 03_normalize_preset | '값·단위 분리' 프리셋으로 "195 ℃"→195 (미리보기+CSV) |
| 04_build_reuse | 무변경 재생성 → 이전 빌드 즉시 재사용, 선택 변경 → 재계산 |
| 05_templates_nm | 템플릿 생성/같은 문서 N:M 배정/해제 독립성 (DB 변조 → 러너가 원복) |

주의: 빌드 시나리오는 `domains/<ws>/data/kg/builds/`에 산출 파일을 남긴다
(로컬 데이터 — 커밋 대상 아님).
