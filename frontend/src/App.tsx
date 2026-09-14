// 유일한 웹 프런트(React). 작업 화면 하나만 렌더한다.
import { Suspense, lazy } from "react";

const Workbench = lazy(() => import("./app/Workbench"));

export default function App() {
  return (
    <Suspense fallback={<p>작업 공간을 불러오는 중…</p>}>
      <Workbench />
    </Suspense>
  );
}
