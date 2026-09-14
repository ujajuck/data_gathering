# Semantic Excel Integration — React Frontend

이 시스템의 **웹 프런트엔드**다 (React + TypeScript + Vite). 화면은 `src/app/`의
문서 · 파싱 프로파일 · 파싱 스키마 · 데이터 빌드 · 작업 내역(좌측 사이드바) + Source Review 오버레이 하나뿐이다.
파일·라우트·픽스처 설명은 [src/app/README.md](src/app/README.md), 계약은 [docs/design/contracts.md §7](../docs/design/contracts.md)에 있다.
빌드 산출물(`dist/`)이 커밋되어 서버가 루트 `/`에 바로 서빙한다 — 프론트를 고치면 `npm run build` 후 dist까지 커밋한다.

## 실행

```bash
# 샘플 작업 공간과 백엔드 (개발 프록시 대상)
python -m schema seed-demo --workspace /tmp/schema-demo
python -m schema serve --ws /tmp/schema-demo --port 8010

npm ci
npm run dev                  # Vite, /api → 127.0.0.1:8010 프록시
npm test                     # vitest 컴포넌트 회귀
npm run build                # tsc -b && vite build → dist/ (base: "./", dist는 커밋 대상)
```

## 구조

- `src/App.tsx` · `src/main.tsx` — 진입점. 작업 화면 하나만 lazy 로드한다.
- `src/app/` — 화면 · `client.ts`(API `/api` 접두, 캐시, 라우팅) · `app.css`
- `src/product.ts` — 제품명 상수
- `tests/` — Vitest + jsdom 컴포넌트 회귀와 정적 규칙 검사(용어·import·ID 비노출·진입 호출 수·접근성)
- `../e2e/` — 실제 서버·실제 XLSX를 쓰는 Playwright 스펙

## 컴포넌트 검증

```bash
npm ci
npx tsc -b
npm test
npm run build
```

테스트 환경은 Node 24.19.0이다. 잠금 파일의 jsdom은 Node 22.22.2 이상(22.x) 또는
24.15.0 이상(24.x), 26 이상을 요구한다. Vitest·jsdom·React Testing Library로 실제
화면 컴포넌트를 마운트하고 가상 API 응답만 제공하며 외부 네트워크를 사용하지 않는다.
jsdom에는 레이아웃·히트 테스트가 없으므로 실제 브라우저의 시각·마우스 드래그 검증은 E2E가 맡는다.

## License notes

Runtime dependencies are pinned for reproducible review. React is MIT licensed;
Vite is MIT licensed. LibreOffice is an external rendering process and is not
bundled by this package. Deployment owners should regenerate and review
third-party notices for the exact deployed dependency tree.
