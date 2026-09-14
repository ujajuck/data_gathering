import { describe, expect, it } from "vitest";
import {
  WINDOW_COLS,
  WINDOW_ROWS,
  bandFor,
  cellRef,
  columnIndex,
  columnName,
  formatRange,
  parseRange,
  rectFor,
  tileFor,
  visibleArea,
  windowFor,
  windowsFor,
} from "../src/v3/sheetGeometry";

const rows = (n: number, h = 24) => Array.from({ length: n }, (_, i) => ({ index: i + 1, y: i * h, height: h }));
const cols = (n: number, w = 80) => Array.from({ length: n }, (_, i) => ({ index: i + 1, x: i * w, width: w }));

describe("sheetGeometry", () => {
  it("열 이름과 A1 범위를 왕복 변환한다", () => {
    expect(columnName(1)).toBe("A");
    expect(columnName(26)).toBe("Z");
    expect(columnName(27)).toBe("AA");
    expect(columnName(702)).toBe("ZZ");
    expect(columnIndex("AA")).toBe(27);
    expect(cellRef(3, 2)).toBe("B3");
    expect(parseRange("B3")).toEqual({ r1: 3, c1: 2, r2: 3, c2: 2 });
    expect(parseRange("$D$9:$b$2")).toEqual({ r1: 2, c1: 2, r2: 9, c2: 4 });
    expect(parseRange("a1:z60")).toEqual({ r1: 1, c1: 1, r2: 60, c2: 26 });
    expect(parseRange("1A")).toBeNull();
    expect(parseRange("")).toBeNull();
    expect(formatRange({ r1: 1, c1: 1, r2: 1, c2: 1 })).toBe("A1");
    expect(formatRange({ r1: 1, c1: 1, r2: 60, c2: 26 })).toBe("A1:Z60");
  });

  it("스크롤 위치를 A1:Z60 단위 창으로 환산하고 경계에서 자른다", () => {
    expect(WINDOW_ROWS).toBe(60);
    expect(WINDOW_COLS).toBe(26);
    expect(windowFor(0, 0, rows(200), cols(40))).toBe("A1:Z60");
    expect(windowFor(24 * 59, 0, rows(200), cols(40))).toBe("A1:Z60");
    expect(windowFor(24 * 60, 0, rows(200), cols(40))).toBe("A61:Z120");
    expect(windowFor(24 * 130, 80 * 27, rows(200), cols(40))).toBe("AA121:AN180");
    // 마지막 창은 캐시 범위 끝까지만
    expect(windowFor(24 * 190, 0, rows(200), cols(40))).toBe("A181:Z200");
    // 축 목록이 없으면 기본 크기로 추정한다
    expect(windowFor(24 * 61, 0, [], [])).toBe("A61:Z120");
    expect(tileFor(1, 1)).toEqual({ r1: 1, c1: 1, r2: 60, c2: 26 });
    expect(tileFor(61, 27, { rows: 100, cols: 30 })).toEqual({ r1: 61, c1: 27, r2: 100, c2: 30 });
  });

  it("뷰포트와 교차하는 창 + 진행 방향 1창을 돌려준다", () => {
    const r = rows(2000);
    const c = cols(200);
    expect(visibleArea({ top: 0, left: 0, width: 900, height: 600 }, r, c)).toEqual({ r1: 1, c1: 1, r2: 25, c2: 12 });
    expect(windowsFor({ top: 0, left: 0, width: 900, height: 600 }, r, c)).toEqual(["A1:Z60"]);
    expect(windowsFor({ top: 24 * 130, left: 0, width: 900, height: 600 }, r, c, { dr: 1, dc: 0 })).toEqual(["A121:Z180", "A181:Z240"]);
    // 창 경계에 걸친 뷰포트(행 51~75, 열 21~32)는 창 4개, 오른쪽 진행이면 열 방향 선행 창(열 47~58)
    expect(windowsFor({ top: 24 * 50, left: 80 * 20, width: 900, height: 600 }, r, c, { dr: 0, dc: 1 })).toEqual([
      "A1:Z60",
      "AA1:AZ60",
      "A61:Z120",
      "AA61:AZ120",
      "BA1:BZ60",
      "BA61:BZ120",
    ]);
    // 시트 끝에서는 앞 창을 요청하지 않는다
    expect(windowsFor({ top: 24 * 1990, left: 0, width: 900, height: 600 }, r, c, { dr: 1, dc: 0 })).toEqual(["A1981:Z2000"]);
  });

  it("영역의 px 사각형을 rows[].y / columns[].x로 계산한다", () => {
    const r = [
      { index: 1, y: 0, height: 20 },
      { index: 2, y: 20, height: 30 },
      { index: 3, y: 50, height: 24 },
    ];
    const c = [
      { index: 1, x: 0, width: 60 },
      { index: 2, x: 60, width: 100 },
      { index: 3, x: 160, width: 80 },
    ];
    expect(rectFor({ r1: 2, c1: 2, r2: 3, c2: 3 }, r, c)).toEqual({ left: 60, top: 20, width: 180, height: 54 });
    expect(rectFor({ r1: 1, c1: 1, r2: 1, c2: 1 }, r, c)).toEqual({ left: 0, top: 0, width: 60, height: 20 });
    expect(rectFor({ r1: 9, c1: 9, r2: 9, c2: 9 }, r, c)).toBeNull();
  });

  it("렌더 밴드는 DOM 상한 3,000셀을 넘지 않는다", () => {
    const small = bandFor({ r1: 1, c1: 1, r2: 25, c2: 12 }, { rows: 2000, cols: 200 });
    expect((small.r2 - small.r1 + 1) * (small.c2 - small.c1 + 1)).toBeLessThanOrEqual(3000);
    expect(small.r1).toBe(1);
    expect(small.r2).toBeGreaterThan(25);
    const huge = bandFor({ r1: 1, c1: 1, r2: 200, c2: 100 }, { rows: 2000, cols: 200 });
    expect((huge.r2 - huge.r1 + 1) * (huge.c2 - huge.c1 + 1)).toBeLessThanOrEqual(3000);
    const clipped = bandFor({ r1: 190, c1: 35, r2: 200, c2: 40 }, { rows: 200, cols: 40 });
    expect(clipped.r2).toBe(200);
    expect(clipped.c2).toBe(40);
  });
});
