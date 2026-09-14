// SheetViewer의 순수 좌표 계산. 렌더 창(§5)의 rows[]/columns[](캐시 범위 전체, 원점 0 누적 px)를 기준으로
// 스크롤 위치 ↔ 시트 좌표 ↔ 창(A1:Z60 단위)을 환산한다. React·DOM에 의존하지 않는다.
import type { Area, RenderColumn, RenderRow } from "./types";

export const WINDOW_ROWS = 60;
export const WINDOW_COLS = 26;
export const CELL_DOM_CAP = 3000;
export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_COLUMN_WIDTH = 80;

export type Rect = { left: number; top: number; width: number; height: number };
export type Viewport = { top: number; left: number; width: number; height: number };

export function columnName(index: number): string {
  let result = "";
  let n = index;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

export function columnIndex(letters: string): number {
  return [...letters.toUpperCase()].reduce(
    (value, ch) => value * 26 + ch.charCodeAt(0) - 64,
    0,
  );
}

export function cellRef(row: number, col: number): string {
  return columnName(col) + row;
}

// "A1", "a1:c3", "$B$2:$D$9" → 정규화된 영역(r1<=r2, c1<=c2). 실패 시 null.
export function parseRange(text: string): Area | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d+)(?:\s*:\s*\$?([A-Za-z]{1,3})\$?(\d+))?\s*$/.exec(
    text || "",
  );
  if (!m) return null;
  const r1 = Number(m[2]);
  const c1 = columnIndex(m[1]);
  const r2 = m[4] ? Number(m[4]) : r1;
  const c2 = m[3] ? columnIndex(m[3]) : c1;
  if (r1 < 1 || c1 < 1 || r2 < 1 || c2 < 1) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

export function formatRange(area: Area): string {
  const start = cellRef(area.r1, area.c1);
  return area.r1 === area.r2 && area.c1 === area.c2
    ? start
    : start + ":" + cellRef(area.r2, area.c2);
}

export function intersects(a: Area, b: Area): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function union(a: Area, b: Area): Area {
  return {
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
    r2: Math.max(a.r2, b.r2),
    c2: Math.max(a.c2, b.c2),
  };
}

export function sameArea(a: Area | null | undefined, b: Area | null | undefined) {
  return !!a && !!b && a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
}

// 마지막 축 좌표(rows[].index / columns[].index). 목록이 비어 있으면 0.
export function lastIndex(axis: { index: number }[]): number {
  return axis.length ? axis[axis.length - 1].index : 0;
}

// 누적 좌표 목록에서 pos(px)를 덮는 항목의 배열 위치(이진 탐색). pos가 끝을 넘으면 마지막 항목.
function axisAt(
  pos: number,
  axis: { start: number; size: number }[],
): number {
  if (!axis.length) return -1;
  let lo = 0;
  let hi = axis.length - 1;
  if (pos <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (axis[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const rowAxis = (rows: RenderRow[]) => rows.map((r) => ({ start: r.y, size: r.height }));
const colAxis = (columns: RenderColumn[]) => columns.map((c) => ({ start: c.x, size: c.width }));

export function rowAt(y: number, rows: RenderRow[]): RenderRow | null {
  const i = axisAt(y, rowAxis(rows));
  return i < 0 ? null : rows[i];
}

export function columnAt(x: number, columns: RenderColumn[]): RenderColumn | null {
  const i = axisAt(x, colAxis(columns));
  return i < 0 ? null : columns[i];
}

// 시트 좌표(1부터)를 덮는 창. bounds(rows/columns 마지막 index)가 있으면 그 안으로 자른다.
export function tileFor(
  row: number,
  col: number,
  bounds?: { rows: number; cols: number } | null,
): Area {
  const ti = Math.floor((Math.max(1, row) - 1) / WINDOW_ROWS);
  const tj = Math.floor((Math.max(1, col) - 1) / WINDOW_COLS);
  const area = {
    r1: ti * WINDOW_ROWS + 1,
    c1: tj * WINDOW_COLS + 1,
    r2: (ti + 1) * WINDOW_ROWS,
    c2: (tj + 1) * WINDOW_COLS,
  };
  if (bounds) {
    if (bounds.rows > 0) area.r2 = Math.min(area.r2, Math.max(area.r1, bounds.rows));
    if (bounds.cols > 0) area.c2 = Math.min(area.c2, Math.max(area.c1, bounds.cols));
  }
  return area;
}

export function boundsOf(rows: RenderRow[], columns: RenderColumn[]) {
  return { rows: lastIndex(rows), cols: lastIndex(columns) };
}

// 스크롤 위치(시트 px, 확대 반영 전)가 놓인 창의 range 문자열. 첫 창은 항상 "A1:Z60".
export function windowFor(
  scrollTop: number,
  scrollLeft: number,
  rows: RenderRow[],
  columns: RenderColumn[],
): string {
  const row = rows.length ? rowAt(scrollTop, rows)!.index : Math.floor(scrollTop / DEFAULT_ROW_HEIGHT) + 1;
  const col = columns.length
    ? columnAt(scrollLeft, columns)!.index
    : Math.floor(scrollLeft / DEFAULT_COLUMN_WIDTH) + 1;
  return formatRange(tileFor(row, col, rows.length && columns.length ? boundsOf(rows, columns) : null));
}

// 뷰포트(시트 px)와 교차하는 시트 영역(1부터). 축 목록이 비어 있으면 null.
export function visibleArea(
  viewport: Viewport,
  rows: RenderRow[],
  columns: RenderColumn[],
): Area | null {
  if (!rows.length || !columns.length) return null;
  const top = rowAt(viewport.top, rows)!;
  const bottom = rowAt(viewport.top + Math.max(0, viewport.height - 1), rows)!;
  const left = columnAt(viewport.left, columns)!;
  const right = columnAt(viewport.left + Math.max(0, viewport.width - 1), columns)!;
  return { r1: top.index, c1: left.index, r2: bottom.index, c2: right.index };
}

// 영역과 교차하는 창 목록(행 우선 정렬).
export function windowsForArea(area: Area, bounds?: { rows: number; cols: number } | null): string[] {
  const result: string[] = [];
  const first = tileFor(area.r1, area.c1, bounds);
  for (let r = first.r1; r <= area.r2; r += WINDOW_ROWS)
    for (let c = first.c1; c <= area.c2; c += WINDOW_COLS)
      result.push(formatRange(tileFor(r, c, bounds)));
  return result;
}

// 뷰포트와 교차하는 창 + 진행 방향 1창 선행.
export function windowsFor(
  viewport: Viewport,
  rows: RenderRow[],
  columns: RenderColumn[],
  direction: { dr: -1 | 0 | 1; dc: -1 | 0 | 1 } = { dr: 0, dc: 0 },
): string[] {
  const visible = visibleArea(viewport, rows, columns);
  if (!visible) return ["A1:Z60"];
  const bounds = boundsOf(rows, columns);
  const result = windowsForArea(visible, bounds);
  if (direction.dr || direction.dc) {
    const ahead = {
      r1: visible.r1 + direction.dr * WINDOW_ROWS,
      r2: visible.r2 + direction.dr * WINDOW_ROWS,
      c1: visible.c1 + direction.dc * WINDOW_COLS,
      c2: visible.c2 + direction.dc * WINDOW_COLS,
    };
    if (ahead.r1 >= 1 && ahead.c1 >= 1 && ahead.r1 <= bounds.rows && ahead.c1 <= bounds.cols)
      for (const key of windowsForArea(ahead, bounds))
        if (!result.includes(key)) result.push(key);
  }
  return result;
}

// 영역의 px 사각형(rows[].y / columns[].x 기준). 축 밖이면 null.
export function rectFor(area: Area, rows: RenderRow[], columns: RenderColumn[]): Rect | null {
  const inRows = rows.filter((r) => r.index >= area.r1 && r.index <= area.r2);
  const inCols = columns.filter((c) => c.index >= area.c1 && c.index <= area.c2);
  if (!inRows.length || !inCols.length) return null;
  const firstRow = inRows[0];
  const lastRow = inRows[inRows.length - 1];
  const firstCol = inCols[0];
  const lastCol = inCols[inCols.length - 1];
  return {
    left: firstCol.x,
    top: firstRow.y,
    width: lastCol.x + lastCol.width - firstCol.x,
    height: lastRow.y + lastRow.height - firstRow.y,
  };
}

// 보이는 영역 ± 여유를 DOM 상한(cap) 안에서 넓힌 렌더 밴드.
export function bandFor(
  visible: Area,
  bounds: { rows: number; cols: number },
  cap = CELL_DOM_CAP,
): Area {
  const clamp = (a: Area): Area => ({
    r1: Math.max(1, a.r1),
    c1: Math.max(1, a.c1),
    r2: Math.min(bounds.rows || a.r2, a.r2),
    c2: Math.min(bounds.cols || a.c2, a.c2),
  });
  const size = (a: Area) => (a.r2 - a.r1 + 1) * (a.c2 - a.c1 + 1);
  let padRows = Math.floor(WINDOW_ROWS / 2);
  let padCols = Math.floor(WINDOW_COLS / 2);
  let band = clamp({
    r1: visible.r1 - padRows,
    c1: visible.c1 - padCols,
    r2: visible.r2 + padRows,
    c2: visible.c2 + padCols,
  });
  while (size(band) > cap && (padRows > 0 || padCols > 0)) {
    padRows = Math.max(0, padRows - 5);
    padCols = Math.max(0, padCols - 2);
    band = clamp({
      r1: visible.r1 - padRows,
      c1: visible.c1 - padCols,
      r2: visible.r2 + padRows,
      c2: visible.c2 + padCols,
    });
  }
  if (size(band) > cap) {
    // 여유 없이도 넘치면(아주 큰 뷰포트) 보이는 영역 자체를 상한에 맞춘다.
    const cols = Math.max(1, Math.min(band.c2 - band.c1 + 1, cap));
    const rows = Math.max(1, Math.floor(cap / cols));
    band = { r1: band.r1, c1: band.c1, r2: band.r1 + rows - 1, c2: band.c1 + cols - 1 };
  }
  return band;
}

export function scrollDirection(
  previous: { top: number; left: number },
  next: { top: number; left: number },
): { dr: -1 | 0 | 1; dc: -1 | 0 | 1 } {
  return {
    dr: next.top > previous.top ? 1 : next.top < previous.top ? -1 : 0,
    dc: next.left > previous.left ? 1 : next.left < previous.left ? -1 : 0,
  };
}
