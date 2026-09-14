// v3 API 클라이언트와 공용 훅(§7 client.ts). v2의 훅/API 래퍼는 import하지 않는다.
// - api(): JSON, /api/v3 접두, bearer 토큰(localStorage 'v3.token'), 오류 봉투 → ApiError
// - GET은 같은 URL의 진행 중 요청을 공유하고 60초 메모리 캐시를 쓴다. 쓰기(GET 이외)는 캐시 전체를 비운다.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { ApiErrorBody, JobResponse, Page } from "./types";

export const API_PREFIX = "/api/v3";
export const TOKEN_KEY = "v3.token";
export const PAGE_LIMIT = 50;
export const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------- 토큰

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(value: string) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 저장소를 쓸 수 없으면 이 세션에서만 유지된다.
  }
  memoryToken = value;
}
let memoryToken = "";
const token = () => memoryToken || getToken();

// ---------------------------------------------------------------- 오류

export class ApiError extends Error {
  code: string;
  status: number;
  fields: Record<string, unknown> | string[] | undefined;
  constructor(status: number, code: string, message: string, fields?: ApiError["fields"]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message || "요청을 처리하지 못했습니다.";
  return "요청을 처리하지 못했습니다.";
}

function toApiError(status: number, data: unknown): ApiError {
  const body = data as Partial<ApiErrorBody> | null;
  const envelope = body && typeof body === "object" ? body.error : undefined;
  const detail = (data as { detail?: { msg?: string }[] | string } | null)?.detail;
  const message =
    envelope?.message ||
    (Array.isArray(detail) ? detail[0]?.msg : typeof detail === "string" ? detail : "") ||
    (status === 401
      ? "서버 접근 토큰이 필요합니다."
      : status === 404
        ? "찾을 수 없습니다."
        : status === 503
          ? "서버에 연결할 수 없습니다."
          : "요청을 처리하지 못했습니다.");
  return new ApiError(status, envelope?.code || `HTTP_${status}`, message, envelope?.fields);
}

// ---------------------------------------------------------------- 요청·캐시·중복 제거

export type ApiInit = {
  method?: string;
  signal?: AbortSignal;
  // 캐시를 건너뛰고 새로 받는다(진행 중 요청은 여전히 공유).
  fresh?: boolean;
  headers?: Record<string, string>;
};

export type RawResponse<T> = {
  status: number;
  ok: boolean;
  data: T;
  headers: Headers;
};

const cache = new Map<string, { at: number; value: RawResponse<unknown> }>();
const inflight = new Map<string, Promise<RawResponse<unknown>>>();
let writeSeq = 0;
const writeListeners = new Set<() => void>();

export function invalidateCache() {
  cache.clear();
}

// 테스트·재연결용: 캐시·진행 중 요청·쓰기 카운터를 모두 비운다.
export function resetClient() {
  cache.clear();
  inflight.clear();
  writeSeq = 0;
  memoryToken = "";
}

export function subscribeWrites(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

// 쓰기(GET 이외) 호출마다 1씩 오르는 값. JobBar가 쓰기 직후 폴링을 시작하는 데 쓴다.
export function useWriteSeq(): number {
  return useSyncExternalStore(subscribeWrites, () => writeSeq, () => writeSeq);
}

// 진행 중 작업이 모두 끝난 순간(JobBar) 목록을 다시 읽게 한다: 캐시를 비우고 쓰기 알림을 보낸다.
// 대화상자를 닫으면 useJob의 promise가 resolve되지 않아(언마운트) onRegistered가 불리지 않기 때문이다.
export function notifyJobsFinished() {
  notifyWrite();
}

function notifyWrite() {
  cache.clear();
  writeSeq++;
  writeListeners.forEach((listener) => listener());
}

async function request<T>(
  url: string,
  method: string,
  body: unknown,
  init?: ApiInit,
): Promise<RawResponse<T>> {
  const bearer = token();
  const response = await fetch(url, {
    method,
    signal: init?.signal,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      ...(init?.headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  let data: unknown = null;
  if (response.status !== 204 && response.status !== 304) {
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: { code: "INVALID_RESPONSE", message: text.slice(0, 200) } };
      }
    }
  }
  return { status: response.status, ok: response.ok, data: data as T, headers: response.headers };
}

// 상태 코드가 필요한 호출(렌더 창의 200/202/4xx/503). 4xx·5xx여도 throw하지 않는다(네트워크 실패만 throw).
export function apiRaw<T = unknown>(
  path: string,
  body?: unknown,
  init?: ApiInit,
): Promise<RawResponse<T>> {
  const method = (init?.method || (body === undefined ? "GET" : "POST")).toUpperCase();
  const url = API_PREFIX + path;
  if (method === "GET") {
    if (!init?.fresh) {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value as RawResponse<T>);
    }
    const pending = inflight.get(url);
    if (pending) return pending as Promise<RawResponse<T>>;
    const promise = request<T>(url, method, undefined, { ...init, signal: undefined })
      .then((result) => {
        if (result.status === 200) cache.set(url, { at: Date.now(), value: result });
        return result;
      })
      .finally(() => {
        inflight.delete(url);
      });
    inflight.set(url, promise as Promise<RawResponse<unknown>>);
    return promise;
  }
  return request<T>(url, method, body, init).then((result) => {
    notifyWrite();
    return result;
  });
}

// JSON 응답 본문만 돌려준다. 2xx가 아니면 ApiError.
export async function api<T = any>(path: string, body?: unknown, init?: ApiInit): Promise<T> {
  const result = await apiRaw<T>(path, body, init);
  if (!result.ok) throw toApiError(result.status, result.data);
  return result.data;
}

export const withQuery = (path: string, params: Record<string, string | number | undefined | null>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  const text = query.toString();
  return text ? path + (path.includes("?") ? "&" : "?") + text : path;
};

// ---------------------------------------------------------------- 다운로드

export async function downloadFile(path: string, filename: string) {
  const url = path.startsWith("/api/") ? path : API_PREFIX + path;
  const bearer = token();
  if (!bearer) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    return;
  }
  const response = await fetch(url, { headers: { Authorization: "Bearer " + bearer }, cache: "no-store" });
  if (!response.ok) {
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    throw toApiError(response.status, data);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ---------------------------------------------------------------- useData / usePage

export type Resource<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  // 낙관적 갱신: 서버 응답을 기다리지 않고 화면 데이터를 바꾼다.
  setData: (next: T | null | ((previous: T | null) => T | null)) => void;
};

export function useData<T = any>(path: string | null, version = 0): Resource<T> {
  const [state, setState] = useState<{
    key: string | null;
    data: T | null;
    error: ApiError | null;
    loading: boolean;
  }>({ key: null, data: null, error: null, loading: false });
  const [revision, setRevision] = useState(0);
  const key = path ? path + "#" + version : null;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState({ key, data: null, error: null, loading: true });
    api<T>(path, undefined, revision ? { fresh: true } : undefined)
      .then((data) => {
        if (!cancelled) setState({ key, data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const failure = error instanceof ApiError ? error : new ApiError(0, "NETWORK", errorMessage(error));
        setState({ key, data: null, error: failure, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [key, path, revision]);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const setData = useCallback<Resource<T>["setData"]>((next) => {
    setState((previous) => ({
      ...previous,
      data: typeof next === "function" ? (next as (p: T | null) => T | null)(previous.data) : next,
    }));
  }, []);
  const current = state.key === key ? state : { data: null, error: null, loading: !!path };
  return { data: current.data, error: current.error, loading: current.loading, reload, setData };
}

export type PageResource<T> = Resource<Page<T>> & {
  items: T[];
  number: number;
  hasMore: boolean;
  next: () => void;
  prev: () => void;
  reset: () => void;
};

const cursorPositions = new Map<string, (string | null)[]>();

// keyset 페이지(limit 50). 같은 경로로 돌아오면 마지막 페이지 위치를 기억한다.
export function usePage<T = any>(path: string | null, version = 0): PageResource<T> {
  const positionKey = path || "";
  const [scope, setScope] = useState(positionKey);
  const [history, setHistory] = useState<(string | null)[]>(
    cursorPositions.get(positionKey) || [null],
  );
  const active = scope === positionKey ? history : cursorPositions.get(positionKey) || [null];
  const cursor = active[active.length - 1];
  const resource = useData<Page<T>>(
    path ? withQuery(path, { limit: PAGE_LIMIT, cursor }) : null,
    version,
  );
  function move(next: (string | null)[]) {
    setScope(positionKey);
    setHistory(next);
    if (cursorPositions.size > 60) cursorPositions.clear();
    cursorPositions.set(positionKey, next);
  }
  return {
    ...resource,
    items: resource.data?.items ?? [],
    number: active.length,
    hasMore: !!resource.data?.has_more,
    prev: () => move(active.slice(0, -1)),
    next: () => move([...active, resource.data?.next_cursor ?? null]),
    reset: () => {
      move([null]);
      resource.reload();
    },
  };
}

export function Pager({
  page,
}: {
  page: Pick<PageResource<unknown>, "number" | "hasMore" | "loading" | "prev" | "next">;
}) {
  if (page.number <= 1 && !page.hasMore) return null;
  return createElement(
    "div",
    { className: "v3-pager" },
    createElement(
      "button",
      { type: "button", className: "small", disabled: page.number <= 1 || page.loading, onClick: page.prev },
      "이전",
    ),
    createElement("span", null, `${page.number} 페이지 · 최대 ${PAGE_LIMIT}개`),
    createElement(
      "button",
      { type: "button", className: "small", disabled: !page.hasMore || page.loading, onClick: page.next },
      "다음",
    ),
  );
}

// ---------------------------------------------------------------- State(로딩·오류·빈 상태)

export function State({
  resource,
  empty = "아직 등록된 항목이 없습니다.",
  action,
  isEmpty,
}: {
  resource: { loading: boolean; error: ApiError | null; data: unknown; reload?: () => void };
  empty?: ReactNode;
  // 빈 상태 옆에 보여줄 다음 행동(버튼·링크).
  action?: ReactNode;
  isEmpty?: boolean;
}) {
  if (resource.loading)
    return createElement("p", { className: "v3-muted v3-loading", role: "status" }, "불러오는 중…");
  if (resource.error)
    return createElement(
      "div",
      { className: "v3-error", role: "alert" },
      createElement("span", null, resource.error.message),
      resource.reload
        ? createElement(
            "button",
            { type: "button", className: "small", onClick: resource.reload },
            "다시 시도",
          )
        : null,
    );
  const data = resource.data as { items?: unknown[] } | unknown[] | null;
  const emptyNow =
    isEmpty ??
    (Array.isArray(data)
      ? data.length === 0
      : !!data && Array.isArray((data as { items?: unknown[] }).items) && (data as { items: unknown[] }).items.length === 0);
  if (emptyNow)
    return createElement(
      "div",
      { className: "v3-empty" },
      createElement("p", null, empty),
      action ? createElement("div", { className: "v3-empty-action" }, action) : null,
    );
  return null;
}

// ---------------------------------------------------------------- 라우팅

export type Screen = "documents" | "profiles" | "schema" | "build" | "jobs" | "settings";
export const SCREENS: { id: Screen; label: string }[] = [
  { id: "documents", label: "문서" },
  { id: "profiles", label: "파싱 프로파일" },
  { id: "schema", label: "파싱 스키마" },
  { id: "build", label: "데이터 빌드" },
  { id: "jobs", label: "작업 내역" },
];
export const SETTINGS_SCREEN: { id: Screen; label: string } = { id: "settings", label: "설정" };
export const DEFAULT_SCREEN: Screen = "documents";

export type Route = Record<string, string>;
export type RoutePatch = Record<string, string | number | null | undefined>;

const LEGACY_KEYS = ["v1", "v2", "legacy"];

export function readRoute(): Route {
  const result: Route = {};
  new URLSearchParams(location.search).forEach((value, key) => {
    if (!LEGACY_KEYS.includes(key)) result[key] = value;
  });
  return result;
}

export function screenOf(route: Route): Screen {
  const value = route.screen as Screen;
  return SCREENS.some((s) => s.id === value) || value === "settings" ? value : DEFAULT_SCREEN;
}

function normalize(patch: RoutePatch, base: Route): Route {
  const state: Route = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === "") delete state[key];
    else state[key] = String(value);
  }
  return state;
}

export function routeQuery(route: Route): string {
  const query = new URLSearchParams(route).toString();
  return query ? "?" + query : location.pathname;
}

export function parseRouteText(text: string): Route {
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const result: Route = {};
  new URLSearchParams(query).forEach((value, key) => {
    if (!LEGACY_KEYS.includes(key)) result[key] = value;
  });
  return result;
}

export type Navigation = {
  route: Route;
  screen: Screen;
  // 현재 파라미터에 덮어쓴다(빈 값은 제거). 히스토리를 남긴다.
  go: (patch: RoutePatch) => void;
  // go와 같지만 히스토리를 남기지 않는다.
  replace: (patch: RoutePatch) => void;
  // 파라미터 전체를 바꾼다(검색 결과 이동 등).
  reset: (route: RoutePatch | string) => void;
  // 쓰기 뒤 목록을 다시 읽게 하는 카운터.
  refresh: number;
  changed: () => void;
};

export function useRoute(): Navigation {
  const [route, setRoute] = useState<Route>(readRoute);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const apply = useCallback((next: Route, replace: boolean) => {
    history[replace ? "replaceState" : "pushState"]({}, "", routeQuery(next));
    setRoute(next);
  }, []);
  const go = useCallback((patch: RoutePatch) => apply(normalize(patch, readRoute()), false), [apply]);
  const replace = useCallback((patch: RoutePatch) => apply(normalize(patch, readRoute()), true), [apply]);
  const reset = useCallback(
    (next: RoutePatch | string) =>
      apply(typeof next === "string" ? parseRouteText(next) : normalize(next, {}), false),
    [apply],
  );
  return {
    route,
    screen: screenOf(route),
    go,
    replace,
    reset,
    refresh,
    changed: () => setRefresh((n) => n + 1),
  };
}

export const NavigationContext = createContext<Navigation>(null!);
export const useNavigation = () => useContext(NavigationContext);

// ---------------------------------------------------------------- 작업(JobResponse) 폴링

export const isJobActive = (job: JobResponse | null | undefined) =>
  !!job && (job.state === "queued" || job.state === "running");

export type JobRunner = {
  job: JobResponse | null;
  busy: boolean;
  error: string;
  // POST path?wait=<초> → 완료되지 않았으면 pollMs마다 GET /jobs/{id}. 최종 JobResponse를 돌려준다.
  run: (path: string, body?: unknown, wait?: number) => Promise<JobResponse | null>;
  // 이미 받은 JobResponse(202)를 넘겨 폴링을 이어간다.
  track: (job: JobResponse) => void;
  cancel: () => void;
  reset: () => void;
};

export function useJob(pollMs = 1000): JobRunner {
  const [job, setJob] = useState<JobResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const waiters = useRef<((job: JobResponse) => void)[]>([]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!isJobActive(job)) {
      if (job) {
        waiters.current.forEach((resolve) => resolve(job));
        waiters.current = [];
        setBusy(false);
      }
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const next = await api<JobResponse>("/jobs/" + encodeURIComponent(job!.job_id), undefined, { fresh: true });
        if (alive.current) setJob(next);
      } catch (failure) {
        if (alive.current) {
          setError(errorMessage(failure));
          setBusy(false);
        }
      }
    }, pollMs);
    return () => clearTimeout(timer);
  }, [job, pollMs]);
  const track = useCallback((next: JobResponse) => {
    setError("");
    setBusy(isJobActive(next));
    setJob(next);
  }, []);
  const run = useCallback<JobRunner["run"]>(
    async (path, body = {}, wait = 10) => {
      setBusy(true);
      setError("");
      try {
        const result = await api<JobResponse>(withQuery(path, { wait }), body);
        if (!alive.current) return result;
        setJob(result);
        if (!isJobActive(result)) {
          setBusy(false);
          return result;
        }
        return await new Promise<JobResponse>((resolve) => waiters.current.push(resolve));
      } catch (failure) {
        if (alive.current) {
          setError(errorMessage(failure));
          setBusy(false);
        }
        return null;
      }
    },
    [],
  );
  const cancel = useCallback(() => {
    if (job?.job_id) api("/jobs/" + encodeURIComponent(job.job_id) + "/cancel", {}).catch(() => {});
  }, [job]);
  const reset = useCallback(() => {
    setJob(null);
    setBusy(false);
    setError("");
  }, []);
  return { job, busy, error, run, track, cancel, reset };
}

// ---------------------------------------------------------------- 날짜·디바운스

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "-";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) return formatDate(value);
  if (seconds < 60) return "방금 전";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return formatDate(value);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ---------------------------------------------------------------- 표시 규칙(§7) — ID를 쓰지 않는 라벨

export function snapshotLabel(
  snapshot: { captured_at?: string | null; revision_no?: number } | null | undefined,
  options: { history?: boolean } = {},
): string {
  if (!snapshot) return "없음";
  const date = formatDate(snapshot.captured_at);
  return options.history && snapshot.revision_no !== undefined ? `r${snapshot.revision_no} · ${date}` : date;
}

export function profileLabel(
  profile:
    | { profile_name: string; rev?: number; current_rev?: number; profile_rev?: number }
    | { name: string; rev?: number }
    | null
    | undefined,
): string {
  if (!profile) return "-";
  const name = "profile_name" in profile ? profile.profile_name : profile.name;
  const rev =
    "rev" in profile && profile.rev !== undefined
      ? profile.rev
      : "current_rev" in profile && profile.current_rev !== undefined
        ? profile.current_rev
        : "profile_rev" in profile && profile.profile_rev !== undefined
          ? profile.profile_rev
          : undefined;
  return rev === undefined ? name : `${name} v${rev}`;
}

export function schemaLabel(
  schema:
    | { schema_name: string; rev?: number; current_rev?: number }
    | { name: string; rev?: number; current_rev?: number }
    | null
    | undefined,
): string {
  if (!schema) return "-";
  const name = "schema_name" in schema ? schema.schema_name : schema.name;
  const rev = schema.rev ?? schema.current_rev;
  return rev === undefined ? name : `${name} v${rev}`;
}

export function regionLabel(sheetName: string | null | undefined, range: string | null | undefined): string {
  if (!range) return "-";
  return sheetName ? `${sheetName}!${range}` : range;
}

export function mappingRevisionLabel(revision: { revision_no: number; created_at?: string | null }): string {
  return `#${revision.revision_no}${revision.created_at ? " · " + formatDateTime(revision.created_at) : ""}`;
}

export function jobLabel(job: Pick<JobResponse, "label" | "kind">): string {
  return job.label || job.kind;
}

// ---------------------------------------------------------------- 토스트

export type ToastAction = { label: string; onClick: () => void };
export type Toast = { id: number; message: string; action?: ToastAction };
export type ToastApi = {
  notify: (message: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
  toasts: Toast[];
};
export const ToastContext = createContext<ToastApi>({ notify: () => {}, dismiss: () => {}, toasts: [] });
export const useToast = () => useContext(ToastContext);

export function useToastState(ttlMs = 6000): ToastApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback<ToastApi["notify"]>(
    (message, action) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-2), { id, message, action }]);
      setTimeout(() => dismiss(id), ttlMs);
    },
    [dismiss, ttlMs],
  );
  return { notify, dismiss, toasts };
}

// ---------------------------------------------------------------- '원본 보기' 진입 파라미터

// 모든 화면의 '원본 보기'는 같은 조합으로 Source Review를 연다: review(+rule·sheet·range).
// 테스트 모드 파라미터(test·snapshot)와 이전에 남은 rule/range는 항상 지운다.
export type ReviewTarget = {
  application_id: string;
  rule_key?: string | null;
  sheet_id?: string | null;
  range?: string | null;
};
export function reviewRoute(target: ReviewTarget): RoutePatch {
  return {
    review: target.application_id,
    rule: target.rule_key || "",
    sheet: target.sheet_id || "",
    range: target.range || "",
    test: "",
    snapshot: "",
  };
}
