// 가상화 시트 뷰어(§5·§7). DocumentDetail(readonly)과 SourceReview(review)가 같이 쓴다.
// - 창(A1:Z60 단위) 응답을 Map<range, window>로 보관하고, 첫 응답의 rows[]/columns[](캐시 범위 전체)로
//   스크롤 영역·헤더를 만든다. 스크롤 위치 → 보이는 창 + 진행 방향 1창을 선행 요청한다.
// - DOM에는 보이는 영역 ± 여유(≤ 3,000 셀)만 그린다. 병합 셀은 한 번만 전체 크기로, 이미지는 loading="lazy".
// - 202 → 뷰어 안에서만 "렌더링 중" + 700ms 재요청, 4xx failed → error.message + 다시 시도(retry_after 뒤 활성),
//   503 → "렌더 서버에 연결할 수 없음". 다른 화면·API는 영향이 없다.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from "react";
import { apiRaw, errorMessage } from "./client";
import type {
  ApiErrorBody,
  Area,
  RenderCell,
  RenderColumn,
  RenderFailed,
  RenderImage,
  RenderPending,
  RenderRow,
  RenderStyle,
  RenderWindow,
} from "./types";
import {
  bandFor,
  boundsOf,
  cellRef,
  columnName,
  formatRange,
  parseRange,
  scrollDirection,
  tileFor,
  union,
  visibleArea,
  windowsFor,
} from "./sheetGeometry";
import type { Viewport } from "./sheetGeometry";

// 렌더 서버는 CSS 이름(background·fontWeight·fontStyle·textAlign·fontSize)으로, 픽스처·계약 예시는 짧은 이름(bg·bold·italic·align·font_size)으로
// 스타일을 준다. 둘 다 받아 뷰어가 쓰는 짧은 이름으로 맞춘다.
function normalizeStyle(raw: RenderStyle | Record<string, unknown> | null | undefined): RenderStyle | null {
  if (!raw) return null;
  const s = raw as Record<string, unknown>;
  const weight = s.fontWeight;
  return {
    ...(raw as RenderStyle),
    bg: (s.bg ?? s.background ?? null) as string | null,
    bold: s.bold !== undefined ? !!s.bold : typeof weight === "number" ? weight >= 600 : weight === "bold",
    italic: s.italic !== undefined ? !!s.italic : s.fontStyle === "italic",
    align: (s.align ?? s.textAlign) as RenderStyle["align"],
    font_size: (s.font_size ?? s.fontSize ?? null) as number | null,
  };
}

export type OverlayKind = "key" | "value" | "unit" | "context" | "focus";
export type Overlay = Area & { kind: OverlayKind; label?: string };

export type SheetViewerHandle = {
  // "B12" 또는 "B2:D9"로 이동. 형식이 틀리면 false.
  jumpTo: (ref: string) => boolean;
  scrollToArea: (area: Area) => void;
  focusCell: (row: number, col: number) => void;
};

export type SheetViewerProps = {
  snapshotId: string;
  sheetId: string;
  sheetName?: string;
  mode: "readonly" | "review";
  // 0.5–1.5
  zoom?: number;
  overlays?: Overlay[];
  // 바뀔 때마다 그 영역이 보이도록 스크롤한다.
  focus?: Area | null;
  // 드래그 선택 중 표시할 역할(overlay 색). 없으면 'drag'.
  selectionRole?: OverlayKind;
  // review 모드에서 드래그·Enter 선택이 끝나면 호출된다.
  onSelect?: (area: Area) => void;
  onCellFocus?: (cell: Area) => void;
  height?: number | string;
  // URL range= 등 진입 시 먼저 요청할 범위(창은 이 범위를 덮는 A1:Z60 단위).
  initialRange?: string;
  toolbar?: boolean;
  // 툴바 오른쪽에 넣을 추가 요소(확대 조절 등).
  toolbarExtra?: ReactNode;
  ref?: Ref<SheetViewerHandle>;
};

export const HEADING_WIDTH = 44;
export const HEADING_HEIGHT = 24;
const POLL_MS = 700;
const FALLBACK_WIDTH = 900;
const FALLBACK_HEIGHT = 520;

type Status =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "failed" | "unavailable" | "error"; message: string; retryAt: number; range: string };

type RenderResponse = RenderWindow | RenderPending | RenderFailed | ApiErrorBody;

const key = (r: number, c: number) => r + ":" + c;
const clampZoom = (z: number | undefined) => Math.min(1.5, Math.max(0.5, z || 1));

export default function SheetViewer({
  snapshotId,
  sheetId,
  sheetName,
  mode,
  zoom: zoomProp,
  overlays = [],
  focus,
  selectionRole,
  onSelect,
  onCellFocus,
  height = FALLBACK_HEIGHT,
  initialRange,
  toolbar = true,
  toolbarExtra,
  ref,
}: SheetViewerProps) {
  const zoom = clampZoom(zoomProp);
  const [windows, setWindows] = useState<Record<string, RenderWindow>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [retryReady, setRetryReady] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  const [focusCell, setFocusCell] = useState<{ r: number; c: number } | null>(null);
  const [drag, setDrag] = useState<Area | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const pending = useRef(new Set<string>());
  const empty = useRef(new Set<string>());
  const generation = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const lastScroll = useRef({ top: 0, left: 0 });
  const dragStart = useRef<Area | null>(null);
  const pendingFocus = useRef<Area | null>(null);
  const alive = useRef(true);

  const base = useMemo(() => {
    const first = windows["A1:Z60"] || Object.values(windows)[0];
    return first || null;
  }, [windows]);
  const rows: RenderRow[] = base?.rows ?? [];
  const columns: RenderColumn[] = base?.columns ?? [];
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.index, r])), [rows]);
  const colMap = useMemo(() => new Map(columns.map((c) => [c.index, c])), [columns]);
  const bounds = boundsOf(rows, columns);
  const lastRow = rows[rows.length - 1];
  const lastCol = columns[columns.length - 1];
  const totalHeight = lastRow ? lastRow.y + lastRow.height : 0;
  const totalWidth = lastCol ? lastCol.x + lastCol.width : 0;

  // O(1) 사각형 계산(rows[].y / columns[].x). 축 밖으로 나가는 병합은 마지막 행·열에서 자른다.
  const rect = useCallback(
    (area: Area) => {
      const r1 = rowMap.get(area.r1);
      const c1 = colMap.get(area.c1);
      if (!r1 || !c1) return null;
      const r2 = rowMap.get(Math.min(area.r2, bounds.rows)) || r1;
      const c2 = colMap.get(Math.min(area.c2, bounds.cols)) || c1;
      return { left: c1.x, top: r1.y, width: c2.x + c2.width - c1.x, height: r2.y + r2.height - r1.y };
    },
    [rowMap, colMap, bounds.rows, bounds.cols],
  );

  const path = useCallback(
    (range: string) =>
      `/snapshots/${encodeURIComponent(snapshotId)}/sheets/${encodeURIComponent(sheetId)}/render?range=${encodeURIComponent(range)}`,
    [snapshotId, sheetId],
  );

  const later = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  }, []);

  const load = useCallback(
    async (range: string, fresh = false) => {
      if (!snapshotId || !sheetId) return;
      if (windowsRef.current[range] || pending.current.has(range) || empty.current.has(range)) return;
      pending.current.add(range);
      const gen = generation.current;
      try {
        const response = await apiRaw<RenderResponse>(path(range), undefined, fresh ? { fresh: true } : undefined);
        if (!alive.current || gen !== generation.current) return;
        const data = response.data as unknown as {
          error?: { code?: string; message?: string };
          retry_after?: number;
        } | null;
        if (response.status === 200) {
          setWindows((previous) => ({ ...previous, [range]: response.data as RenderWindow }));
          setStatus((s) => (s.kind === "rendering" ? { kind: "idle" } : s));
        } else if (response.status === 202) {
          setStatus({ kind: "rendering" });
          pending.current.delete(range);
          later(() => void load(range, true), POLL_MS);
          return;
        } else if (response.status === 503) {
          const header = response.headers.get("Retry-After");
          const after = header !== null && Number.isFinite(Number(header)) ? Number(header) : 5;
          setStatus({ kind: "unavailable", message: "렌더 서버에 연결할 수 없음", retryAt: Date.now() + after * 1000, range });
        } else if (response.status === 422 && data?.error?.code === "RANGE_OUT_OF_BOUNDS") {
          empty.current.add(range);
        } else {
          const message = data?.error?.message || `렌더에 실패했습니다 (HTTP ${response.status})`;
          const after = typeof data?.retry_after === "number" ? data.retry_after : 60;
          setStatus({ kind: "failed", message, retryAt: Date.now() + after * 1000, range });
        }
      } catch (failure) {
        if (!alive.current || gen !== generation.current) return;
        setStatus({ kind: "error", message: errorMessage(failure), retryAt: Date.now() + 3000, range });
      } finally {
        pending.current.delete(range);
      }
    },
    [snapshotId, sheetId, path, later],
  );

  const measure = useCallback((): Viewport => {
    const el = scroller.current;
    const numericHeight = typeof height === "number" ? height : FALLBACK_HEIGHT;
    const width = (el?.clientWidth || FALLBACK_WIDTH) / zoom;
    const h = (el?.clientHeight || numericHeight) / zoom;
    return { top: (el?.scrollTop || 0) / zoom, left: (el?.scrollLeft || 0) / zoom, width, height: h };
  }, [zoom, height]);

  // 보이는 창 + 진행 방향 1창을 요청한다(이미 있거나 요청 중이면 건너뛴다).
  const ensureWindows = useCallback(
    (view: Viewport, direction: { dr: -1 | 0 | 1; dc: -1 | 0 | 1 } = { dr: 0, dc: 0 }) => {
      const current = windowsRef.current;
      const first = current["A1:Z60"] || Object.values(current)[0];
      if (!first) return;
      for (const range of windowsFor(view, first.rows, first.columns, direction)) void load(range);
    },
    [load],
  );

  // 시트가 바뀌면 전부 비우고 첫 창을 요청한다(진입 창 ≤ 2: 초점 창 + 필요 시 A1:Z60).
  useEffect(() => {
    alive.current = true;
    generation.current++;
    pending.current.clear();
    empty.current.clear();
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    windowsRef.current = {};
    setWindows({});
    setStatus({ kind: "idle" });
    setFocusCell(null);
    setDrag(null);
    dragStart.current = null;
    if (scroller.current) {
      scroller.current.scrollTop = 0;
      scroller.current.scrollLeft = 0;
    }
    lastScroll.current = { top: 0, left: 0 };
    if (!snapshotId || !sheetId) return;
    const target = (initialRange && parseRange(initialRange)) || focus || null;
    pendingFocus.current = target;
    void load(target ? formatRange(tileFor(target.r1, target.c1)) : "A1:Z60");
    if (target && formatRange(tileFor(target.r1, target.c1)) !== "A1:Z60") void load("A1:Z60");
    return () => {
      alive.current = false;
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
    // focus 변경은 별도 효과가 처리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, sheetId, load]);

  const scrollToArea = useCallback(
    (area: Area) => {
      const el = scroller.current;
      const geometry = rect(area);
      if (!el || !geometry) {
        pendingFocus.current = area;
        return;
      }
      const view = measure();
      const top = Math.max(0, (geometry.top + HEADING_HEIGHT) * zoom - Math.max(0, (view.height * zoom) / 3));
      const left = Math.max(0, (geometry.left + HEADING_WIDTH) * zoom - Math.max(0, (view.width * zoom) / 4));
      if (typeof el.scrollTo === "function") el.scrollTo({ top, left });
      else {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
      const next = { ...measure(), top: top / zoom, left: left / zoom };
      lastScroll.current = { top: next.top, left: next.left };
      setViewport(next);
      ensureWindows(next);
      void load(formatRange(tileFor(area.r1, area.c1, bounds)));
    },
    [rect, measure, zoom, ensureWindows, load, bounds],
  );

  // 첫 창이 오면 뷰포트를 재고, 보류된 초점 이동을 적용한다.
  useEffect(() => {
    if (!base) return;
    const view = measure();
    setViewport(view);
    if (pendingFocus.current) {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      scrollToArea(target);
    } else ensureWindows(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // focus prop이 바뀌면 그 영역으로 이동한다.
  const focusKey = focus ? formatRange(focus) : "";
  useEffect(() => {
    if (!focus) return;
    if (base) scrollToArea(focus);
    else pendingFocus.current = focus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // 확대 배율이 바뀌면 보이는 영역이 달라진다.
  useEffect(() => {
    if (!base) return;
    const view = measure();
    setViewport(view);
    ensureWindows(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // 컨테이너 크기 변화(jsdom에는 ResizeObserver가 없다).
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const view = measure();
      setViewport(view);
      ensureWindows(view);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, ensureWindows]);

  // 다시 시도 버튼은 retry_after 뒤에 활성화한다.
  useEffect(() => {
    if (status.kind === "idle" || status.kind === "rendering") {
      setRetryReady(false);
      return;
    }
    const wait = Math.max(0, status.retryAt - Date.now());
    setRetryReady(wait === 0);
    if (wait === 0) return;
    const timer = setTimeout(() => setRetryReady(true), wait);
    return () => clearTimeout(timer);
  }, [status]);

  const retry = useCallback(() => {
    if (status.kind === "idle" || status.kind === "rendering") return;
    const range = status.range;
    setStatus({ kind: "idle" });
    void load(range, true);
  }, [status, load]);

  const onScroll = useCallback(() => {
    const view = measure();
    const direction = scrollDirection(lastScroll.current, view);
    lastScroll.current = { top: view.top, left: view.left };
    setViewport(view);
    ensureWindows(view, direction);
  }, [measure, ensureWindows]);

  // 창 응답을 좌표 색인으로 합친다: 앵커 셀, 병합으로 덮인 좌표, 이미지.
  const index = useMemo(() => {
    const cells = new Map<string, RenderCell>();
    const merges = new Map<string, Area>();
    const covered = new Set<string>();
    const images = new Map<string, RenderImage>();
    const cover = (area: Area) => {
      merges.set(key(area.r1, area.c1), { r1: area.r1, c1: area.c1, r2: area.r2, c2: area.c2 });
      for (let r = area.r1; r <= area.r2; r++)
        for (let c = area.c1; c <= area.c2; c++) if (r !== area.r1 || c !== area.c1) covered.add(key(r, c));
    };
    for (const window of Object.values(windows)) {
      for (const merge of window.merges || []) cover(merge);
      for (const cell of window.cells || []) {
        cells.set(key(cell.r1, cell.c1), cell);
        if (cell.r2 > cell.r1 || cell.c2 > cell.c1) cover(cell);
      }
      for (const image of window.images || [])
        images.set(image.asset_id + ":" + (image.x ?? "") + ":" + (image.y ?? ""), image);
    }
    return { cells, merges, covered, images: [...images.values()] };
  }, [windows]);

  const visible = visibleArea(viewport, rows, columns);
  const band = visible ? bandFor(visible, bounds) : null;
  const styleOf = (cell: RenderCell | undefined): RenderStyle | null => {
    // 렌더 서버 셀은 스타일 표 인덱스를 `s`로 준다(`style`은 인라인 스타일·픽스처 형태).
    const style = cell?.style ?? (cell as { s?: number } | undefined)?.s;
    if (!cell || style === undefined || style === null) return null;
    if (typeof style === "number") return normalizeStyle(base?.styles?.[style]);
    return normalizeStyle(style);
  };

  // 초점 셀은 렌더 뒤 실제 DOM 초점도 옮긴다.
  useEffect(() => {
    if (!focusCell || !scroller.current) return;
    const el = scroller.current.querySelector<HTMLElement>(`[data-ref="${cellRef(focusCell.r, focusCell.c)}"]`);
    if (el && document.activeElement !== el && scroller.current.contains(document.activeElement)) el.focus();
  }, [focusCell, band?.r1, band?.c1]);

  const moveFocus = (r: number, c: number) => {
    const next = {
      r: Math.min(Math.max(1, r), bounds.rows || r),
      c: Math.min(Math.max(1, c), bounds.cols || c),
    };
    setFocusCell(next);
    onCellFocus?.({ r1: next.r, c1: next.c, r2: next.r, c2: next.c });
    const area = { r1: next.r, c1: next.c, r2: next.r, c2: next.c };
    const geometry = rect(area);
    const el = scroller.current;
    if (geometry && el) {
      const view = measure();
      const top = geometry.top + HEADING_HEIGHT;
      const left = geometry.left + HEADING_WIDTH;
      if (top < view.top || top + geometry.height > view.top + view.height || left < view.left || left + geometry.width > view.left + view.width)
        scrollToArea(area);
    }
  };

  const extentOf = (r: number, c: number): Area => index.merges.get(key(r, c)) || { r1: r, c1: c, r2: r, c2: c };

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const ref = target.dataset.ref;
    const fromTarget = ref ? parseRange(ref) : null;
    const current = fromTarget ? { r: fromTarget.r1, c: fromTarget.c1 } : focusCell;
    if (!current) return;
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (steps[e.key]) {
      e.preventDefault();
      moveFocus(current.r + steps[e.key][0], current.c + steps[e.key][1]);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveFocus(current.r, 1);
    } else if ((e.key === "Enter" || e.key === " ") && mode === "review" && onSelect) {
      e.preventDefault();
      onSelect(extentOf(current.r, current.c));
    } else if (e.key === "Escape" && dragStart.current) {
      dragStart.current = null;
      setDrag(null);
    }
  }

  function cellPointerDown(e: ReactPointerEvent<HTMLDivElement>, extent: Area) {
    if (mode !== "review" || e.button !== 0) return;
    e.preventDefault();
    dragStart.current = extent;
    setDrag(extent);
    setFocusCell({ r: extent.r1, c: extent.c1 });
  }
  function cellPointerOver(extent: Area) {
    if (dragStart.current) setDrag(union(dragStart.current, extent));
  }
  function cellPointerUp(extent: Area) {
    if (!dragStart.current) return;
    const area = union(dragStart.current, extent);
    dragStart.current = null;
    setDrag(null);
    onSelect?.(area);
  }
  useEffect(() => {
    if (mode !== "review") return;
    const cancel = () => {
      if (dragStart.current) {
        dragStart.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("pointerup", cancel);
    return () => window.removeEventListener("pointerup", cancel);
  }, [mode]);

  useImperativeHandle(
    ref,
    () => ({
      jumpTo: (text: string) => {
        const area = parseRange(text);
        if (!area) return false;
        setFocusCell({ r: area.r1, c: area.c1 });
        scrollToArea(area);
        return true;
      },
      scrollToArea,
      focusCell: (r: number, c: number) => moveFocus(r, c),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollToArea],
  );

  const [jump, setJump] = useState("");
  const [jumpError, setJumpError] = useState("");

  // ---- 그리기
  const cellNodes: ReactNode[] = [];
  const rowHeadings: ReactNode[] = [];
  const colHeadings: ReactNode[] = [];
  if (band) {
    for (let r = band.r1; r <= band.r2; r++) {
      const row = rowMap.get(r);
      if (!row) continue;
      rowHeadings.push(
        <div className="v3-row-heading" key={r} style={{ top: row.y + HEADING_HEIGHT, height: row.height }}>
          {r}
        </div>,
      );
    }
    for (let c = band.c1; c <= band.c2; c++) {
      const col = colMap.get(c);
      if (!col) continue;
      colHeadings.push(
        <div className="v3-col-heading" key={c} style={{ left: col.x + HEADING_WIDTH, width: col.width }}>
          {columnName(c)}
        </div>,
      );
    }
    for (let r = band.r1; r <= band.r2; r++)
      for (let c = band.c1; c <= band.c2; c++) {
        const k = key(r, c);
        if (index.covered.has(k)) continue;
        const cell = index.cells.get(k);
        const extent = index.merges.get(k) || { r1: r, c1: c, r2: r, c2: c };
        const geometry = rect(extent);
        if (!geometry) continue;
        const style = styleOf(cell);
        const text = cell?.text ?? "";
        const merged = extent.r2 > extent.r1 || extent.c2 > extent.c1;
        const focused = !!focusCell && focusCell.r === r && focusCell.c === c;
        const refText = cellRef(r, c);
        const css: CSSProperties = { ...geometry };
        if (style?.bg) css.background = style.bg;
        if (style?.color) css.color = style.color;
        if (style?.font_size) css.fontSize = style.font_size;
        cellNodes.push(
          <div
            key={k}
            data-ref={refText}
            data-range={merged ? formatRange(extent) : undefined}
            className={
              "v3-cell" +
              (text ? "" : " empty") +
              (merged ? " merged" : "") +
              (focused ? " focused" : "") +
              (style?.bold ? " bold" : "") +
              (style?.italic ? " italic" : "") +
              (style?.align === "center" ? " align-center" : style?.align === "right" ? " align-right" : "")
            }
            style={css}
            title={(merged ? formatRange(extent) : refText) + (text ? " · " + text : "")}
            aria-label={(merged ? formatRange(extent) : refText) + (text ? " " + text : "")}
            tabIndex={focused ? 0 : -1}
            onFocus={() => {
              if (!focused) setFocusCell({ r, c });
            }}
            onPointerDown={(e) => cellPointerDown(e, extent)}
            onPointerOver={() => cellPointerOver(extent)}
            onPointerUp={() => cellPointerUp(extent)}
          >
            {text}
          </div>,
        );
      }
  }

  const overlayNodes = [
    ...overlays.map((o, i) => ({ ...o, id: "o" + i })),
    ...(drag ? [{ ...drag, kind: (selectionRole || "drag") as OverlayKind | "drag", id: "drag", label: undefined as string | undefined }] : []),
  ]
    .map((overlay) => {
      const geometry = rect(overlay);
      return geometry ? (
        <div
          key={overlay.id}
          className={"v3-overlay " + overlay.kind + (overlay.id === "drag" ? " drag" : "")}
          data-kind={overlay.kind}
          data-range={formatRange(overlay)}
          style={geometry}
        >
          {overlay.label ? <span className="v3-overlay-label">{overlay.label}</span> : null}
        </div>
      ) : null;
    })
    .filter(Boolean);

  const showFull = !base;
  const statusNode =
    status.kind === "rendering" ? (
      showFull ? (
        <div className="v3-rendering" role="status">
          렌더링 중
        </div>
      ) : null
    ) : status.kind !== "idle" ? (
      <div className={"v3-viewer-status " + status.kind} role="alert">
        <span>{status.message}</span>
        <button type="button" className="small" disabled={!retryReady} onClick={retry}>
          다시 시도
        </button>
      </div>
    ) : showFull && snapshotId && sheetId ? (
      <div className="v3-rendering" role="status">
        불러오는 중
      </div>
    ) : null;

  return (
    <div className={"v3-viewer " + mode} data-windows={Object.keys(windows).length}>
      {toolbar && (
        <div className="v3-viewer-toolbar">
          <form
            className="v3-inline"
            onSubmit={(e) => {
              e.preventDefault();
              const area = parseRange(jump);
              if (!area) {
                setJumpError("A1 형식으로 입력하세요");
                return;
              }
              setJumpError("");
              setFocusCell({ r: area.r1, c: area.c1 });
              scrollToArea(area);
            }}
          >
            <input
              aria-label="셀 이동"
              placeholder="A1"
              value={jump}
              onChange={(e) => setJump(e.target.value)}
              aria-invalid={jumpError ? true : undefined}
            />
            <button type="submit" className="small">
              이동
            </button>
            {jumpError && <span className="v3-error v3-small">{jumpError}</span>}
          </form>
          <span>
            {sheetName || base?.sheet.sheet_name || ""}
            {base ? ` · ${bounds.rows}행 × ${bounds.cols}열` : ""}
            {base?.truncated ? " · 일부만 표시" : ""}
          </span>
          {status.kind === "rendering" && !showFull && <span role="status">렌더링 중</span>}
          {mode === "review" && (
            <span className="v3-legend" aria-hidden="true">
              <span>
                <i className="key" />키
              </span>
              <span>
                <i className="value" />값
              </span>
              <span>
                <i className="unit" />단위
              </span>
              <span>
                <i className="context" />문맥
              </span>
            </span>
          )}
          <span style={{ marginLeft: "auto" }} className="v3-inline">
            {toolbarExtra}
          </span>
        </div>
      )}
      <div
        className="v3-viewer-scroll"
        ref={scroller}
        onScroll={onScroll}
        style={{ height: typeof height === "number" ? height : height }}
        data-testid="sheet-scroll"
      >
        {base && (
          <div
            className="v3-sheet-size"
            style={{ width: (totalWidth + HEADING_WIDTH) * zoom, height: (totalHeight + HEADING_HEIGHT) * zoom }}
          >
            <div
              className="v3-sheet"
              style={{ width: totalWidth + HEADING_WIDTH, height: totalHeight + HEADING_HEIGHT, transform: `scale(${zoom})` }}
              onKeyDown={onKeyDown}
            >
              <div className="v3-corner" />
              {colHeadings}
              {rowHeadings}
              <div
                className="v3-sheet-body"
                role="group"
                aria-label={(sheetName || base.sheet.sheet_name || "시트") + " 시트"}
                style={{ left: HEADING_WIDTH, top: HEADING_HEIGHT, width: totalWidth, height: totalHeight }}
                onPointerLeave={() => {
                  if (dragStart.current) {
                    dragStart.current = null;
                    setDrag(null);
                  }
                }}
              >
                {cellNodes}
                {index.images.map((image) => {
                  const geometry =
                    image.x !== undefined && image.y !== undefined
                      ? { left: image.x, top: image.y, width: image.width ?? 100, height: image.height ?? 60 }
                      : image.anchor
                        ? rect(image.anchor)
                        : null;
                  if (!geometry || !band) return null;
                  return (
                    <img
                      key={image.asset_id + geometry.left + ":" + geometry.top}
                      className="v3-sheet-image"
                      src={image.url}
                      loading="lazy"
                      alt="시트 이미지"
                      draggable={false}
                      style={geometry}
                    />
                  );
                })}
                {overlayNodes}
              </div>
            </div>
          </div>
        )}
        {statusNode}
      </div>
    </div>
  );
}
