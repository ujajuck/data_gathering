// Semantic Excel Integration — 유일한 웹 프론트 (React).
// 기존 PDF 근거 뷰어는 ?legacy=1 로 접근할 수 있다.
import { Suspense, lazy } from "react";
import { StoreProvider, useStore } from "./lib/store";
import type { Screen } from "./lib/store";
import FilesScreen from "./screens/FilesScreen";
import KgScreen from "./screens/KgScreen";
import SourceScreen from "./screens/SourceScreen";
import DbScreen from "./screens/DbScreen";
import TemplatesScreen from "./screens/TemplatesScreen";
import "./webkg.css";

const LegacyViewer = lazy(() => import("./LegacyViewer"));

const STEPS: [Screen, string][] = [
  ["files", "1. 파일 분석"],
  ["kg", "2. 개념 탐색"],
  ["source", "3. 원본 데이터"],
  ["db", "4. 통합 DB"],
  ["templates", "5. 템플릿 관리"],
];

function Shell() {
  const s = useStore();
  return (
    <div className="wk">
      {s.initError && (
        <div style={{ background: "#fbe9e9", padding: "10px 24px" }}>{s.initError}</div>
      )}
      <header className="top">
        <div className="brand">
          <b>Semantic Excel Integration</b>
          <div>도메인 온톨로지 · 문서군 · Source Location · Custom DB</div>
        </div>
        <nav className="steps">
          {STEPS.map(([id, label]) => (
            <button key={id} className={`step${s.screen === id ? " active" : ""}`}
              onClick={() => s.show(id)}>
              {label}{id === "db" && s.cartCount ? ` (${s.cartCount})` : ""}
            </button>
          ))}
        </nav>
      </header>
      {s.ready && (
        <>
          <FilesScreen />
          <KgScreen />
          <SourceScreen />
          <DbScreen />
          <TemplatesScreen />
        </>
      )}
    </div>
  );
}

export default function App() {
  if (new URLSearchParams(window.location.search).has("legacy")) {
    return <Suspense fallback={null}><LegacyViewer /></Suspense>;
  }
  return <StoreProvider><Shell /></StoreProvider>;
}
