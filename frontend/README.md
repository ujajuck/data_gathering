# Semantic Excel Integration — React Frontend

`kg/web_kg`(바닐라 JS 4탭 UI)의 React + TypeScript + Vite 포트. web_kg가 쓰는
REST API(`kg/webapp.py`)를 그대로 사용하며 백엔드 변경이 없다. web_kg는 완전
대체 전까지 `/` 에서 그대로 유지된다(이중 유지 의도).

## 화면

web_kg와 동일한 4탭 구성 (클래스/문구 동일 — 화면 대조 검증 용이):

1. **파일 분석** — 등록 파일 표(DKG 배지·DRM/Render/Parse 상태), 미등록(raw)
   파일의 분석 → DKG 제안 → 레시피 이식 등록, 잠긴 파일의 정식 DRM 해제 요청.
2. **KG 탐색** — Domain KG 트리 + Coverage Hull, Document KG 상세 그래프,
   노드/DKG 상세 패널(멤버 델타, PARSING TEMPLATES, 추출 레시피 스냅샷·이력·
   롤백, 재크롤링 폴링), 개념 편집기(별칭/관계/폐기/복원).
3. **원본 데이터** — 원본 충실 셀 렌더(병합/스타일/이미지/도형) + Semantic
   Overlay 토글, 검수 큐, Source Inspector(승인/반려/재매핑/통합 포함,
   VIEWER SOURCE·PARSING TEMPLATE provenance, PDF Preview 링크).
4. **통합 DB** — 장바구니(web_kg와 같은 `kg_cart_v3` localStorage 키 공유),
   스키마 제안/필드명 조정, 빌드 결과(스키마·경고·미리보기·lineage).

## 실행

```bash
# 백엔드 (개발 프록시 대상)
python -m kg.webapp --ws domains/financier --port 8010

# 개발 서버 (Vite, /api → 127.0.0.1:8010 프록시)
npm install
npm run dev

# 프로덕션: 빌드하면 kg.webapp이 /app 에 자동 서빙 (base: "./")
npm run build
```

## 구조

- `src/lib/api.ts` — fetch 헬퍼 + colName/parseRange + cart 저장소
- `src/lib/store.tsx` — 4탭 공유 상태 (web_kg `state` 객체 대응)
- `src/screens/` — FilesScreen / KgScreen(+kg/) / SourceScreen(+source/) / DbScreen
- `src/webkg.css` — web_kg CSS 포트(`.wk` 스코프, 클래스명 유지)

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
