// 작업 공간 쉘(§7 Workbench): 사이드바 · 통합 검색 · JobBar · 라우팅(React.lazy 화면) · SourceReview 오버레이 · 토스트.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ApiError,
  NavigationContext,
  SCREENS,
  SETTINGS_SCREEN,
  ToastContext,
  api,
  notifyJobsFinished,
  setToken,
  useData,
  useDebounced,
  useNavigation,
  useRoute,
  useToast,
  useToastState,
  useWriteSeq,
} from "./client";
import type { Screen } from "./client";
import type { JobResponse, Page, SearchHit, SearchKind, StatusResponse } from "./types";
import { SEARCH_KIND_LABELS } from "./types";
import { Heading } from "./ui";
import { PRODUCT_NAME } from "../product";
import "./app.css";

export { Heading } from "./ui";

export const PRODUCT_SUBTITLE = "Document-to-Table Adapter";

const screens: Record<Screen, React.LazyExoticComponent<() => React.JSX.Element>> = {
  documents: lazy(() => import("./Documents")),
  profiles: lazy(() => import("./Profiles")),
  schema: lazy(() => import("./Schema")),
  build: lazy(() => import("./Build")),
  jobs: lazy(() => import("./Jobs")),
  settings: lazy(() => import("./Settings")),
};
const SourceReview = lazy(() => import("./SourceReview"));

export default function Workbench() {
  const navigation = useRoute();
  const toast = useToastState();
  return (
    <NavigationContext.Provider value={navigation}>
      <ToastContext.Provider value={toast}>
        <Shell />
      </ToastContext.Provider>
    </NavigationContext.Provider>
  );
}

function Shell() {
  const { route, screen, go } = useNavigation();
  const status = useData<StatusResponse>("/status");
  const overlayOpen = !!(route.review || route.test);
  const Screen = screens[screen];
  return (
    <div className="app">
      <div className="app-shell">
        <aside className="app-sidebar" inert={overlayOpen || undefined}>
          <button type="button" className="app-brand" onClick={() => go({ screen: "documents", document: "", tab: "" })}>
            <strong>{PRODUCT_NAME}</strong>
            <small>{PRODUCT_SUBTITLE}</small>
          </button>
          <nav className="app-nav" aria-label="주 메뉴">
            {SCREENS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={screen === item.id ? "page" : undefined}
                onClick={() => go({ screen: item.id })}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <nav className="app-nav app-nav-bottom" aria-label="보조 메뉴">
            <button
              type="button"
              aria-current={screen === SETTINGS_SCREEN.id ? "page" : undefined}
              onClick={() => go({ screen: SETTINGS_SCREEN.id })}
            >
              {SETTINGS_SCREEN.label}
            </button>
          </nav>
        </aside>
        <header className="app-header" inert={overlayOpen || undefined}>
          <GlobalSearch />
          <div className="app-header-right">
            <JobBar initialRunning={status.data?.counts?.jobs_running ?? 0} />
          </div>
        </header>
        <main className="app-main" inert={overlayOpen || undefined}>
          {status.error ? (
            <TokenPrompt error={status.error} retry={status.reload} />
          ) : status.loading ? (
            <p className="app-muted" role="status">
              작업 공간을 불러오는 중…
            </p>
          ) : (
            <Suspense
              fallback={
                <p className="app-muted" role="status">
                  화면을 불러오는 중…
                </p>
              }
            >
              <Screen key={screen} />
            </Suspense>
          )}
        </main>
      </div>
      {overlayOpen && !status.error && (
        <Suspense
          fallback={
            <div className="app-overlay-screen">
              <p className="app-muted" role="status" style={{ padding: 20 }}>
                검수 화면을 불러오는 중…
              </p>
            </div>
          }
        >
          <SourceReview />
        </Suspense>
      )}
      <Toasts />
    </div>
  );
}

function TokenPrompt({ error, retry }: { error: ApiError; retry: () => void }) {
  const [value, setValue] = useState("");
  if (error.status !== 401 && error.status !== 403)
    return (
      <section className="app-card app-token-card">
        <Heading title="작업 공간 연결" />
        <div className="app-error" role="alert">
          <span>{error.message}</span>
          <button type="button" className="small" onClick={retry}>
            다시 시도
          </button>
        </div>
      </section>
    );
  return (
    <section className="app-card app-token-card">
      <Heading title="작업 공간 연결" description="서버 접근 토큰을 입력하면 이 브라우저에 저장됩니다." />
      <form
        className="app-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          retry();
        }}
      >
        <p className="app-error" role="alert">
          {error.message}
        </p>
        <label>
          서버 접근 토큰
          <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div>
          <button type="submit" className="primary">
            연결
          </button>
        </div>
      </form>
    </section>
  );
}

// 헤더 통합 검색: 250ms 디바운스 → GET /search?q= → 종류별 묶음. Enter/클릭은 hit.route로 이동.
const SEARCH_ORDER: SearchKind[] = ["document", "profile", "schema", "field"];
function GlobalSearch() {
  const { reset } = useNavigation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query.trim(), 250);
  const [hits, setHits] = useState<{ q: string; items: SearchHit[]; error: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!debounced) {
      setHits(null);
      return;
    }
    let cancelled = false;
    api<Page<SearchHit> | SearchHit[]>("/search?q=" + encodeURIComponent(debounced))
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data) ? data : data.items;
        setHits({ q: debounced, items, error: "" });
        setActive(0);
        setOpen(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHits({ q: debounced, items: [], error: (error as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const items = hits?.q === debounced ? hits.items : [];
  const ordered = SEARCH_ORDER.flatMap((kind) => items.filter((h) => h.kind === kind)).concat(
    items.filter((h) => !SEARCH_ORDER.includes(h.kind)),
  );
  function choose(hit: SearchHit) {
    setOpen(false);
    setQuery("");
    setHits(null);
    reset(hit.route);
  }
  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(ordered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (ordered[active]) {
        e.preventDefault();
        choose(ordered[active]);
      }
    } else if (e.key === "Escape") setOpen(false);
  }
  const listId = "app-search-results";
  return (
    <div className="app-search" ref={box} role="search">
      <input
        type="search"
        aria-label="통합 검색"
        placeholder="문서, 프로파일, 스키마, 데이터 검색..."
        value={query}
        role="combobox"
        aria-expanded={open && !!hits}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && ordered[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => hits && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && hits && hits.q === debounced && (
        <div className="app-search-results" id={listId} role="listbox" aria-label="검색 결과">
          {hits.error ? (
            <div className="app-search-empty" role="alert">
              {hits.error}
            </div>
          ) : ordered.length === 0 ? (
            <div className="app-search-empty">검색 결과가 없습니다.</div>
          ) : (
            SEARCH_ORDER.filter((kind) => ordered.some((h) => h.kind === kind)).map((kind) => (
              <div key={kind} role="group" aria-label={SEARCH_KIND_LABELS[kind]}>
                <div className="app-search-group">{SEARCH_KIND_LABELS[kind]}</div>
                {ordered
                  .map((hit, i) => [hit, i] as const)
                  .filter(([hit]) => hit.kind === kind)
                  .map(([hit, i]) => (
                    <button
                      type="button"
                      role="option"
                      id={`${listId}-${i}`}
                      key={hit.kind + hit.id}
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(hit)}
                    >
                      <span>{hit.label}</span>
                      {hit.sublabel && <small>{hit.sublabel}</small>}
                    </button>
                  ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// 진행 중 작업 수. GET /jobs?state=running은 진행 중 작업이 있거나 쓰기 직후에만 2초 간격으로 폴링한다.
export function JobBar({ initialRunning = 0 }: { initialRunning?: number }) {
  const { go } = useNavigation();
  const writeSeq = useWriteSeq();
  const [running, setRunning] = useState<number | null>(null);
  const count = running ?? initialRunning;
  const shouldPoll = count > 0 || writeSeq > 0;
  // 직전 폴링에서 본 진행 중 작업 수. >0에서 0으로 떨어지는 순간이 '작업이 끝났다'는 신호다.
  const previous = useRef(0);
  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const page = await api<Page<JobResponse>>("/jobs?state=running", undefined, { fresh: true });
        if (cancelled) return;
        setRunning(page.items.length);
        // 대화상자를 닫은 뒤 끝난 작업(폴더 일괄 등록 등)의 결과가 목록에 보이도록 캐시를 비우고 알린다.
        if (previous.current > 0 && page.items.length === 0) notifyJobsFinished();
        previous.current = page.items.length;
        if (page.items.length > 0) timer = setTimeout(tick, 2000);
      } catch {
        if (!cancelled) setRunning(0);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // writeSeq가 바뀔 때마다(쓰기 직후) 새로 시작한다.
  }, [shouldPoll, writeSeq]);
  if (count <= 0) return null;
  return (
    <div className="app-jobbar" role="status">
      <span>진행 중 작업 {count}</span>
      <button type="button" className="small" onClick={() => go({ screen: "jobs" })}>
        보기
      </button>
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useToast();
  if (!toasts.length) return null;
  return (
    <div className="app-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className="app-toast" key={toast.id}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                dismiss(toast.id);
                toast.action!.onClick();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" aria-label="알림 닫기" onClick={() => dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
