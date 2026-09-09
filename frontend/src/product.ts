// v1과 v2는 같은 제품명과 작업 순서를 사용한다. 데이터 API만 다르다.
export const PRODUCT_NAME = "Semantic Excel Integration";
export const PRODUCT_DESCRIPTION =
  "도메인 온톨로지 · 문서군 · Source Location · Custom DB";
export const PRODUCT_STEPS = [
  { v1: "files", v2: "documents", label: "1. 파일 분석" },
  { v1: "kg", v2: "kg", label: "2. 개념 탐색" },
  { v1: "source", v2: "source", label: "3. 원본 데이터" },
  { v1: "db", v2: "database", label: "4. 통합 DB" },
  { v1: "templates", v2: "templates", label: "5. 템플릿 관리" },
] as const;
