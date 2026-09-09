import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type Row = Record<string, any>;
export type Page = {
  items: Row[];
  has_more: boolean;
  next_cursor: string | null;
  fields?: Row[];
};
let accessToken = "";
export function setToken(value: string) {
  accessToken = value;
}
export async function api(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch("/api/v2" + path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.detail?.[0]?.msg ||
        "요청을 처리하지 못했습니다.",
    );
  return data;
}
export async function download(
  build: string,
  format: "sqlite" | "csv" = "sqlite",
) {
  return downloadFile(
    `/builds/${encodeURIComponent(build)}/download?format=${format}`,
    `custom-db-${build}.${format}`,
  );
}
export async function downloadFile(path: string, filename: string) {
  if (!accessToken) {
    const link = document.createElement("a");
    link.href = "/api/v2" + path;
    link.download = filename;
    link.click();
    return;
  }
  const picker = (window as any).showSaveFilePicker;
  const handle = picker
    ? await picker.call(window, { suggestedName: filename })
    : null;
  const response = await fetch("/api/v2" + path, {
    headers: { Authorization: "Bearer " + accessToken },
    cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message || "다운로드 실패");
  }
  if (handle && response.body) {
    await response.body.pipeTo(await handle.createWritable());
    return;
  }
  // 길이를 알 수 없는 CSV 스트림도 실제 수신량을 세어 메모리 상한을 지킨다.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("파일 응답이 비어 있습니다.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 64 * 1024 * 1024) {
      await reader.cancel();
      throw new Error(
        "64MB보다 큰 파일은 스트리밍 다운로드를 지원하는 브라우저나 인증된 API 클라이언트를 사용하세요.",
      );
    }
    chunks.push(value);
  }
  const url = URL.createObjectURL(new Blob(chunks));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function useData(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data: any;
    error: string;
    loading: boolean;
  }>({ path: null, data: null, error: "", loading: false });
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, data: null, error: "", loading: true });
    api(path, undefined, controller.signal)
      .then((data) => setState({ path, data, error: "", loading: false }))
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ path, data: null, error: error.message, loading: false });
      });
    return () => controller.abort();
  }, [path, revision]);
  return {
    ...(state.path === path
      ? state
      : { data: null, error: "", loading: !!path }),
    reload: () => refresh((n) => n + 1),
  };
}
const positions = new Map<string, (string | null)[]>();
export function usePage(path: string | null, positionKey = path) {
  const [scope, setScope] = useState(positionKey);
  const [history, setHistory] = useState<(string | null)[]>(
    positions.get(positionKey || "") || [null],
  );
  const active =
    scope === positionKey
      ? history
      : positions.get(positionKey || "") || [null];
  const cursor = active[active.length - 1];
  const resource = useData(
    path
      ? path +
          (path.includes("?") ? "&" : "?") +
          "limit=30" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")
      : null,
  );
  function move(next: (string | null)[]) {
    setScope(positionKey);
    setHistory(next);
    if (positions.size > 60) positions.clear();
    positions.set(positionKey || "", next);
  }
  return {
    ...resource,
    data: resource.data as Page | null,
    number: active.length,
    prev: () => move(active.slice(0, -1)),
    next: () => move([...active, resource.data?.next_cursor]),
    reset: () => {
      move([null]);
      resource.reload();
    },
  };
}
export function Pager({ page }: { page: ReturnType<typeof usePage> }) {
  return (
    <div className="v2-pager">
      <button disabled={page.number <= 1 || page.loading} onClick={page.prev}>
        이전
      </button>
      <span>{page.number} 페이지 · 최대 30개</span>
      <button
        disabled={!page.data?.has_more || page.loading}
        onClick={page.next}
      >
        다음
      </button>
    </div>
  );
}
export function State({
  resource,
  empty = "아직 등록된 항목이 없습니다.",
}: {
  resource: { loading: boolean; error: string; data: any };
  empty?: string;
}) {
  return resource.loading ? (
    <p className="v2-muted" role="status">
      불러오는 중…
    </p>
  ) : resource.error ? (
    <p className="v2-error" role="alert">
      {resource.error}
    </p>
  ) : resource.data?.items?.length === 0 ? (
    <p className="v2-empty">{empty}</p>
  ) : null;
}
export type Route = Record<string, string>;
type Navigation = {
  route: Route;
  go: (next: Route, replace?: boolean) => void;
  refresh: number;
  changed: () => void;
};
export const NavigationContext = createContext<Navigation>(null!);
export const useNavigation = () => useContext(NavigationContext);
export function readRoute(): Route {
  const result: Route = {};
  new URLSearchParams(location.search).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
export function useRoute() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  function go(next: Route, replace = false) {
    const state: Route = { ...readRoute(), ...next, v2: "1" };
    Object.keys(state).forEach((key) => {
      if (!state[key]) delete state[key];
    });
    const query = new URLSearchParams(state);
    history[replace ? "replaceState" : "pushState"](
      {},
      "",
      "?" + query.toString(),
    );
    setRoute(state);
  }
  return { route, go, refresh, changed: () => setRefresh((n) => n + 1) };
}
type Tasks = {
  run: (path: string, body: Row, done?: (result: Row) => void) => Promise<void>;
  busy: boolean;
  job: Row | null;
  cancel: () => void;
};
const TasksContext = createContext<Tasks>(null!);
export const useTasks = () => useContext(TasksContext);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function TaskProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(path: string, body: Row, done?: (result: Row) => void) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      let current = await api(path, {
        ...body,
        request_key: crypto.randomUUID(),
      });
      setJob(current);
      while (["queued", "running"].includes(current.state)) {
        await delay(650);
        current = await api("/jobs/" + current.job_id);
        setJob(current);
      }
      if (current.state === "succeeded") done?.(current.result);
    } catch (error) {
      setJob({ state: "failed", error_message: (error as Error).message });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <TasksContext.Provider
      value={{
        run,
        busy,
        job,
        cancel: () => {
          if (job?.job_id)
            api("/jobs/" + job.job_id + "/cancel", {}).catch(() => {});
        },
      }}
    >
      {children}
    </TasksContext.Provider>
  );
}
export function JobBar() {
  const tasks = useTasks();
  const job = tasks.job;
  if (!job) return null;
  const labels: Row = {
    queued: "대기 중",
    running: "처리 중",
    succeeded: "완료",
    failed: "실패",
    cancelled: "취소됨",
  };
  return (
    <div
      className={"v2-job " + (job.state === "failed" ? "v2-error" : "")}
      role="status"
    >
      <strong>{labels[job.state]}</strong>
      <span>
        {job.error_message ||
          (job.kind === "extract"
            ? "추출 작업"
            : job.kind === "build"
              ? "통합 DB 생성"
              : "문서 등록") +
            (job.total ? ` ${job.completed}/${job.total}` : "")}
      </span>
      {tasks.busy && <button onClick={tasks.cancel}>작업 취소</button>}
    </div>
  );
}
export function useViewport(
  version: string,
  sheet: string,
  r1: number,
  c1: number,
  refresh: number,
) {
  const key = JSON.stringify([version, sheet, r1, c1, refresh]);
  const [state, setState] = useState<{
    key: string;
    data: Row | null;
    loading: boolean;
    error: string;
  }>({ key: "", data: null, loading: false, error: "" });
  useEffect(() => {
    if (!version || !sheet) return;
    let cancelled = false;
    let jobId = "";
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setState({ key, data: null, loading: true, error: "" });
    (async () => {
      try {
        let current = await api("/viewports", {
          version_id: version,
          sheet_id: sheet,
          r1,
          c1,
          rows: Math.min(40, 1048577 - r1),
          cols: Math.min(12, 16385 - c1),
          request_key: crypto.randomUUID(),
        });
        jobId = current.job_id;
        if (cancelled) {
          await api("/jobs/" + jobId + "/cancel", {});
          return;
        }
        while (["queued", "running"].includes(current.state)) {
          await delay(500);
          if (cancelled) return;
          current = await api("/jobs/" + jobId, undefined, controller.signal);
        }
        if (current.state !== "succeeded")
          throw new Error(
            current.error_message || "표시 작업을 완료하지 못했습니다.",
          );
        if (current.result.expired)
          throw new Error("표시 범위가 만료되었습니다. 새로고침하세요.");
        if (!cancelled) {
          setState({ key, data: current.result, loading: false, error: "" });
          const duration = Math.max(
            0,
            Math.min(
              60000,
              new Date(current.result.access_expires_at).getTime() - Date.now(),
            ),
          );
          expiry = setTimeout(
            () =>
              setState({
                key,
                data: null,
                loading: false,
                error: "표시 권한 확인을 위해 새로고침하세요.",
              }),
            duration,
          );
        }
      } catch (error) {
        if (!cancelled)
          setState({
            key,
            data: null,
            loading: false,
            error: (error as Error).message,
          });
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(expiry);
      controller.abort();
      if (jobId) api("/jobs/" + jobId + "/cancel", {}).catch(() => {});
    };
  }, [key]);
  return state.key === key
    ? state
    : { data: null, loading: !!(version && sheet), error: "" };
}
export function column(index: number): string {
  let result = "";
  while (index) {
    index--;
    result = String.fromCharCode(65 + (index % 26)) + result;
    index = Math.floor(index / 26);
  }
  return result;
}
export function range(r1: number, c1: number, r2 = r1, c2 = c1) {
  return (
    column(c1) + r1 + (r1 === r2 && c1 === c2 ? "" : ":" + column(c2) + r2)
  );
}
export function box(text: string): number[] | null {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(text);
  if (!m) return null;
  const col = (s: string) =>
    [...s.toUpperCase()].reduce((v, x) => v * 26 + x.charCodeAt(0) - 64, 0);
  return [+m[2], col(m[1]), +(m[4] || m[2]), col(m[3] || m[1])];
}

// 선택한 데이터는 저장하지 않고 사용자가 작성한 편집 초안만 탭 이동 동안 메모리에 유지한다.
const drafts = new Map<string, any>();
export function useDraft<T>(
  key: string,
  initial: T,
): [T, (next: T | ((old: T) => T)) => void] {
  const [, redraw] = useState(0);
  const value = drafts.has(key) ? (drafts.get(key) as T) : initial;
  function set(next: T | ((old: T) => T)) {
    const old = drafts.has(key) ? (drafts.get(key) as T) : initial;
    if (drafts.size > 100) drafts.clear();
    drafts.set(
      key,
      typeof next === "function" ? (next as (value: T) => T)(old) : next,
    );
    redraw((n) => n + 1);
  }
  return [value, set];
}
