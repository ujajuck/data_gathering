import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SheetViewer from "../src/app/SheetViewer";
import { errorBody, reply, appFixture } from "./fixture";

const renderPath = (f: ReturnType<typeof appFixture>, sheet: string) => `/snapshots/${f.ids.snapshot}/sheets/${sheet}/render`;

describe("SheetViewer", () => {
  it("첫 창을 요청하고, 스크롤하면 보이는 창과 진행 방향 1창을 선행 요청하며 같은 창은 다시 받지 않는다", async () => {
    const f = appFixture();
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheetBig} sheetName="온도실험" mode="readonly" height={600} />);
    await f.waitForApi(new RegExp(`^${renderPath(f, f.ids.sheetBig)}\\?range=A1%3AZ60$`));
    await waitFor(() => expect(container.querySelector('[data-ref="A1"]')?.textContent).toBe("실험 1"));
    expect(f.callsTo(new RegExp(`^${renderPath(f, f.ids.sheetBig)}`))).toHaveLength(1);

    const scroller = screen.getByTestId("sheet-scroll");
    fireEvent.scroll(scroller, { target: { scrollTop: 24 * 130, scrollLeft: 0 } });
    await f.waitForApi(new RegExp(`range=A121%3AZ180$`));
    await f.waitForApi(new RegExp(`range=A181%3AZ240$`));
    await waitFor(() => expect(container.querySelector('[data-ref="A131"]')?.textContent).toBe("실험 131"));
    // 이미 받은 창은 다시 요청하지 않는다
    fireEvent.scroll(scroller, { target: { scrollTop: 24 * 131, scrollLeft: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ranges = f.callsTo(new RegExp(`^${renderPath(f, f.ids.sheetBig)}`)).map((c) => c.url.searchParams.get("range"));
    expect(ranges).toEqual(["A1:Z60", "A121:Z180", "A181:Z240"]);
    expect(container.querySelector(".app-viewer")?.getAttribute("data-windows")).toBe("3");
  });

  it("셀 DOM은 3,000개를 넘지 않고 행·열 헤더를 그린다", async () => {
    const f = appFixture();
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheetBig} mode="readonly" zoom={0.5} height={600} />);
    await waitFor(() => expect(container.querySelectorAll(".app-cell").length).toBeGreaterThan(0));
    const cells = container.querySelectorAll(".app-cell").length;
    expect(cells).toBeLessThanOrEqual(3000);
    expect(cells).toBeGreaterThanOrEqual(25 * 12);
    expect(container.querySelector(".app-col-heading")?.textContent).toBe("A");
    expect(container.querySelector(".app-row-heading")?.textContent).toBe("1");
    // 스크롤 영역은 rendered_bounds 전체(2000행 × 200열)를 덮는다
    const size = container.querySelector<HTMLElement>(".app-sheet-size")!;
    expect(size.style.height).toBe(`${(2000 * 24 + 24) * 0.5}px`);
    expect(size.style.width).toBe(`${(200 * 80 + 44) * 0.5}px`);
  });

  it("overlay는 rows[].y / columns[].x로 위치를 잡고 focus 영역으로 스크롤한다", async () => {
    const f = appFixture();
    const { container } = render(
      <SheetViewer
        snapshotId={f.ids.snapshot}
        sheetId={f.ids.sheet1}
        mode="review"
        height={600}
        overlays={[
          { r1: 2, c1: 2, r2: 3, c2: 4, kind: "value", label: "값" },
          { r1: 2, c1: 1, r2: 2, c2: 1, kind: "key" },
        ]}
        focus={{ r1: 2, c1: 2, r2: 3, c2: 4 }}
      />,
    );
    const value = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".app-overlay.value");
      if (!el) throw new Error("overlay");
      return el;
    });
    expect(value.style.left).toBe("80px");
    expect(value.style.top).toBe("24px");
    expect(value.style.width).toBe("240px");
    expect(value.style.height).toBe("48px");
    expect(value.dataset.range).toBe("B2:D3");
    expect(value.textContent).toBe("값");
    expect(container.querySelector<HTMLElement>(".app-overlay.key")?.dataset.range).toBe("A2");
    expect(container.querySelector(".app-overlay.focus")).toBeNull();
  });

  it("review 모드에서 드래그 선택은 onSelect에 영역을 넘기고, Enter는 병합 셀 전체를 넘긴다", async () => {
    const f = appFixture();
    const onSelect = vi.fn();
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheet1} mode="review" height={600} onSelect={onSelect} selectionRole="value" />);
    const b2 = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-ref="B2"]');
      if (!el) throw new Error("B2");
      return el;
    });
    const c3 = container.querySelector<HTMLElement>('[data-ref="C3"]')!;
    fireEvent.pointerDown(b2, { button: 0 });
    fireEvent.pointerOver(c3);
    // 드래그 중에는 선택 overlay가 보인다
    expect(container.querySelector(".app-overlay.drag")?.getAttribute("data-range")).toBe("B2:C3");
    fireEvent.pointerUp(c3);
    expect(onSelect).toHaveBeenCalledWith({ r1: 2, c1: 2, r2: 3, c2: 3 });
    expect(container.querySelector(".app-overlay.drag")).toBeNull();

    const a1 = container.querySelector<HTMLElement>('[data-ref="A1"]')!;
    fireEvent.keyDown(a1, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ r1: 1, c1: 1, r2: 1, c2: 3 });

    // 화살표는 초점 셀을 옮긴다
    fireEvent.keyDown(a1, { key: "ArrowDown" });
    await waitFor(() => expect(container.querySelector('[data-ref="A2"]')?.className).toContain("focused"));
  });

  it("readonly 모드에서는 드래그해도 onSelect를 부르지 않는다", async () => {
    const f = appFixture();
    const onSelect = vi.fn();
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheet1} mode="readonly" height={600} onSelect={onSelect} />);
    const b2 = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-ref="B2"]');
      if (!el) throw new Error("B2");
      return el;
    });
    fireEvent.pointerDown(b2, { button: 0 });
    fireEvent.pointerUp(b2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("503은 '렌더 서버에 연결할 수 없음'과 다시 시도를, 4xx failed는 error.message와 retry_after 뒤 활성화되는 다시 시도를 보여준다", async () => {
    const f = appFixture();
    let attempts = 0;
    f.overrides.set("GET " + renderPath(f, f.ids.sheet1), (call) => {
      attempts++;
      if (attempts === 1) return reply(503, errorBody("RENDER_UNAVAILABLE", "render unavailable"), { "Retry-After": "0" });
      if (attempts === 2) return reply(403, { status: "failed", error: { code: "DRM_READER_REQUIRED", message: "DRM Reader가 필요합니다." }, retry_after: 60 });
      return f.renderWindow(f.ids.sheet1, call.url.searchParams.get("range") || "A1:Z60");
    });
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheet1} mode="readonly" height={600} />);
    await screen.findByText("렌더 서버에 연결할 수 없음");
    const retry = await waitFor(() => {
      const button = screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement;
      if (button.disabled) throw new Error("not yet");
      return button;
    });
    fireEvent.click(retry);
    await screen.findByText("DRM Reader가 필요합니다.");
    expect((screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".app-cell")).toBeNull();
    expect(attempts).toBe(2);
  });

  it("셀 이동 입력은 그 영역의 창을 요청한다", async () => {
    const f = appFixture();
    const { container } = render(<SheetViewer snapshotId={f.ids.snapshot} sheetId={f.ids.sheetBig} mode="readonly" height={600} />);
    await waitFor(() => expect(container.querySelector('[data-ref="A1"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText("셀 이동"), { target: { value: "B700" } });
    fireEvent.submit(screen.getByLabelText("셀 이동").closest("form")!);
    await f.waitForApi(/range=A661%3AZ720$/);
    await waitFor(() => expect(container.querySelector('[data-ref="B700"]')).toBeTruthy());
  });
});
