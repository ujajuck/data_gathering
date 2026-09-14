// Semantic Excel Integration — 유일한 웹 프론트 (React).
// 기본은 v3 작업 화면. ?v2=1 은 v2, ?v1=1 은 v1, ?legacy=1 은 기존 PDF 근거 뷰어.
import { Suspense, lazy } from "react";
import { StoreProvider, useStore } from "./lib/store";
import type { Screen } from "./lib/store";
import FilesScreen from "./screens/FilesScreen";
import KgScreen from "./screens/KgScreen";
import SourceScreen from "./screens/SourceScreen";
import DbScreen from "./screens/DbScreen";
import TemplatesScreen from "./screens/TemplatesScreen";
import "./webkg.css";
import "./product.css";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, PRODUCT_STEPS } from "./product";

const V3Workbench = lazy(() => import("./v3/Workbench"));

const V2Workbench = lazy(() => import("./v2/Workbench"));

const LegacyViewer = lazy(() => import("./LegacyViewer"));

const STEPS: [Screen, string][] = PRODUCT_STEPS.map((s) => [s.v1, s.label]);

function Shell() {
  const s = useStore();
  return (
    <div className="wk">
      {s.initError && (
        <div style={{ background: "#fbe9e9", padding: "10px 24px" }}>
          {s.initError}
        </div>
      )}
      <header className="top">
        <div className="brand">
          <b>{PRODUCT_NAME}</b>
          <div>{PRODUCT_DESCRIPTION}</div>
        </div>
        <nav className="steps">
          {STEPS.map(([id, label]) => (
            <button
              key={id}
              className={`step${s.screen === id ? " active" : ""}`}
              onClick={() => s.show(id)}
            >
              {label}
              {id === "db" && s.cartCount ? ` (${s.cartCount})` : ""}
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
  const params = new URLSearchParams(window.location.search);
  if (params.has("legacy")) {
    return (
      <Suspense fallback={null}>
        <LegacyViewer />
      </Suspense>
    );
  }
  if (params.has("v2")) {
    return (
      <Suspense fallback={<p>작업 공간을 불러오는 중…</p>}>
        <V2Workbench />
      </Suspense>
    );
  }
  if (params.has("v1")) {
    return (
      <StoreProvider>
        <Shell />
      </StoreProvider>
    );
  }
  return (
    <Suspense fallback={<p>작업 공간을 불러오는 중…</p>}>
      <V3Workbench />
    </Suspense>
  );
}
