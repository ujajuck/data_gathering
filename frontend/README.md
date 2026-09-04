# Semantic Excel Integration — React Frontend

이 시스템의 **유일한 웹 프론트**다 (React + TypeScript + Vite). REST API는
`kg/webapp.py` 하나를 사용하고, 빌드 산출물(`dist/`)이 커밋되어 서버가 루트
`/` 에 바로 서빙한다 — 프론트를 고치면 `npm run build` 후 dist까지 커밋한다.
(초기 바닐라 JS UI `kg/web_kg`는 포트 완료 후 제거됐다.)

## 화면

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
# 백엔드 (개발 프록시 대상)
python -m kg.webapp --ws domains/financier --port 8010

# 개발 서버 (Vite, /api → 127.0.0.1:8010 프록시)
npm install
npm run dev

# 프로덕션: 빌드하면 kg.webapp이 / 에 서빙 (base: "./", dist는 커밋 대상)
npm run build
```

## 구조

- `src/lib/api.ts` — fetch 헬퍼 + colName/parseRange + cart 저장소
- `src/lib/store.tsx` — 5탭 공유 상태
- `src/screens/` — FilesScreen / KgScreen(+kg/) / SourceScreen(+source/) / DbScreen / TemplatesScreen
- `src/webkg.css` — 앱 스타일(`.wk` 스코프)

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
