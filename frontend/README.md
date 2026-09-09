# Semantic Excel Integration — React Frontend

이 시스템의 **웹 프런트엔드**다 (React + TypeScript + Vite). 기본 화면은 `src/v2/`의
문서·도메인 KG·원본 검수·템플릿·사용자 DB 탭이다. `/api/v2`는 독립 서버 `kg.v2` 또는
기존 `kg.webapp`에서 제공한다. [v2 실행 안내](../docs/design/db-schema-v2-runtime.md)에
샘플 생성, 검수와 추출, DRM Reader 계약 및 지원 범위를 정리했다.
빌드 산출물(`dist/`)이 커밋되어 서버가 루트
`/` 에 바로 서빙한다 — 프론트를 고치면 `npm run build` 후 dist까지 커밋한다.
(초기 바닐라 JS UI `kg/web_kg`는 포트 완료 후 제거됐다.)

## 기존 화면 (`?v1=1`)

5탭 구성:

1. **파일 분석** — 등록 파일 표(문서군 배지·DRM/Render/Parse 상태) + 파일명·
   작성자 검색/작성일 필터/정렬, 미등록(raw) 파일의 분석 → 문서군 제안 →
   레시피 이식 등록, 잠긴 파일의 정식 DRM 해제 요청.
2. **개념 탐색** — 온톨로지 트리 + 문서군 커버리지 그래프(확대/축소),
   문서군 상세는 `양식(템플릿) → 문서` 계층(미배정은 '기타', 문서 수 클릭 →
   우측 문서 표), 추출 레시피 스냅샷·이력·롤백, 재크롤링 폴링, 개념
   편집기(별칭/관계/폐기/복원).
3. **원본 데이터** — 셀 렌더(병합/스타일/이미지/텍스트박스 앵커) + Semantic
   Overlay 토글, 검수 큐, Source Inspector("추출된 키 → 값" 표, 승인/반려/
   재매핑/통합 포함, 양식 provenance, PDF Preview 링크), 문서군으로 돌아가기.
4. **통합 DB** — ①개념 트리 체크(상위 체크 시 하위 일괄 선택) → ②스키마
   확인 → ③생성·다운로드(.db/.csv). 양식 카드에서 전처리(자동/원값/
   normalizers.yaml 프리셋)·문서별 가감(`kg_cart_v3` localStorage).
5. **템플릿 관리** — 파싱 템플릿 생성/버전/라이프사이클, 문서 배정·해제.
   문서:템플릿은 N:M (템플릿마다 파싱 관점이 다르다).

## 실행

```bash
# v2 샘플과 백엔드 (개발 프록시 대상)
python -m examples.schema_v2.runtime_demo --workspace /tmp/data-gathering-v2-demo
python -m kg.v2 --ws /tmp/data-gathering-v2-demo --port 8010

# 개발 서버 (Vite, /api → 127.0.0.1:8010 프록시)
npm ci
npm run dev

# 프로덕션: 빌드하면 kg.webapp이 / 에 서빙 (base: "./", dist는 커밋 대상)
npm run build
```

## 구조

- `src/v2/` — 기본 v2 작업 화면, 범위별 원본 표시, 검수 초안, 작업 상태, 사용자 DB
- `tests/workbench.test.tsx` — v2 화면 컴포넌트 상호작용 회귀 테스트
- `src/lib/api.ts` — fetch 헬퍼 + colName/parseRange + cart 저장소
- `src/lib/store.tsx` — 5탭 공유 상태
- `src/screens/` — FilesScreen / KgScreen(+kg/) / SourceScreen(+source/) / DbScreen / TemplatesScreen
- `src/webkg.css` — 앱 스타일(`.wk` 스코프)

## 컴포넌트 검증

```bash
npm ci
npm test
npm run build
```

테스트 환경은 Node 24.19.0이다. 잠금 파일의 jsdom은 Node 22.22.2 이상(22.x) 또는
24.15.0 이상(24.x), 26 이상을 요구한다. Vitest·jsdom·React Testing Library로 실제
화면 컴포넌트를 마운트하고 가상 API 응답만 제공하며 외부 네트워크를 사용하지 않는다.

병합 셀의 키보드 선택과 포인터 이벤트, 여러 영역/시트의 검수 초안·개념·승인 저장,
늦은 표시 작업 취소, 확대 시 재조회 방지, 30개 단위 페이지 이동,
DB 생성 요청과 선택한 출처로의 이동, 집계 변경 시 타입/단위 복원을 검증한다.
jsdom에는 레이아웃·히트 테스트가 없으므로 실제 브라우저의 시각·마우스 드래그 검증과 구분한다.

## 레거시 PDF 근거 뷰어

기존 PDF.js 기반 read-only 뷰어는 `?legacy=1` 로 접근한다
(`src/LegacyViewer.tsx`, lazy 로드). `src/viewer/ViewerAdapter.ts` 가 엔진
경계 계약이며, LibreOffice 렌더는 인가된 해제본 + XLSX 검증 통과 후에만
프리뷰를 제공한다.

## License notes

Runtime dependencies are pinned for reproducible review. React is MIT licensed;
PDF.js is Apache-2.0 licensed; Vite is MIT licensed. LibreOffice is an external
rendering process and is not bundled by this package. Deployment owners should
regenerate and review third-party notices for the exact deployed dependency tree.
