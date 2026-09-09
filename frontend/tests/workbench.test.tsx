import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { workbenchFixture } from "./workbench-fixture";

const route = () => new URLSearchParams(location.search);
const section = (name: string) =>
  within(screen.getByRole("heading", { name }).parentElement!);

describe("원본 검수와 사용자 DB 화면", () => {
  it("병합·복수 영역 초안을 강조하고, 다른 시트의 단위와 개념을 새 검수 버전으로 저장한다", async () => {
    const f = workbenchFixture();
    f.open("source", { row: "1", col: "1", series: "" });
    const user = userEvent.setup();
    const { container } = render(<Workbench />);
    const merged = await screen.findByRole("button", { name: "B6:C6 156" });
    await screen.findByLabelText("저장 상태");
    expect(container.querySelectorAll(".v2-overlay.value")).toHaveLength(1);

    // Keyboard selection must retain the entire merged-cell extent.
    fireEvent.keyDown(merged, { key: "Enter" });
    await user.click(screen.getByRole("button", { name: "이 영역 추가" }));
    expect(screen.getByRole("button", { name: "main · B6:C6" })).toBeTruthy();
    // A reviewer must see the draft region before saving, alongside the old one.
    expect(container.querySelectorAll(".v2-overlay.value")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "키 선택" }));
    await user.click(screen.getByRole("button", { name: "key 영역 1 삭제" }));
    const start = screen.getByRole("button", { name: "B3:C3 공정" });
    const end = screen.getByRole("button", { name: "D3 온도" });
    // jsdom has no hit testing. Supply the pointer transition's relatedTarget
    // explicitly; omitting it would incorrectly mean leaving the entire grid.
    fireEvent(
      start,
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    fireEvent(
      start,
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: end }),
    );
    fireEvent(
      end,
      new MouseEvent("pointerover", { bubbles: true, relatedTarget: start }),
    );
    fireEvent(end, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    expect(screen.getByText("key · B3:D3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "이 영역 추가" }));

    await user.click(
      screen.getByRole("button", { name: "공통 정보", exact: true }),
    );
    const unit = await screen.findByRole("button", { name: "B2 °C" });
    await user.click(screen.getByRole("button", { name: "단위 선택" }));
    await user.click(screen.getByRole("button", { name: "unit 영역 1 삭제" }));
    fireEvent.keyDown(unit, { key: " " });
    await user.click(screen.getByRole("button", { name: "이 영역 추가" }));
    await user.selectOptions(
      screen.getByLabelText("개념", { exact: true }),
      f.ids.other,
    );
    await user.selectOptions(screen.getByLabelText("저장 상태"), "approved");

    // Unsaved edits survive tab changes, including their visible overlays.
    const nav = within(screen.getByRole("navigation", { name: "작업 단계" }));
    await user.click(nav.getByRole("button", { name: "1. 파일 분석" }));
    await screen.findByRole("heading", { name: "등록 문서" });
    await user.click(nav.getByRole("button", { name: "3. 원본 데이터" }));
    await screen.findByRole("button", { name: "common · B2" });
    expect(container.querySelectorAll(".v2-overlay.unit")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "수정 버전 저장" }));
    await waitFor(() =>
      expect(route().get("mapping")).toBe(`${f.ids.mapping}-saved`),
    );
    expect(f.state.saved).toMatchObject({
      expected_seq: 3,
      status: "approved",
      concept_id: f.ids.other,
      effective_spec: {
        selector: {
          key: {
            areas: [
              { sheet_role: "main", range: "D3" },
              { sheet_role: "main", range: "B3:D3" },
            ],
          },
          value: {
            cardinality: "list",
            axis: "down",
            areas: [
              { sheet_role: "main", range: "B4:C5" },
              { sheet_role: "main", range: "B6:C6" },
            ],
          },
          unit: { areas: [{ sheet_role: "common", range: "B2" }] },
        },
      },
    });
    expect(await screen.findByText("현재 발행 결과 없음")).toBeTruthy();
  });

  it("늦게 도착한 표시 작업을 취소하고 새 범위만 표시하며 확대는 다시 읽지 않는다", async () => {
    const f = workbenchFixture();
    f.open("source", { row: "1", col: "1", series: "" });
    let resolveOld!: (data: unknown) => void;
    f.overrides.set("POST /viewports", (call) =>
      call.body!.r1 === 1
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : {
            job_id: "new-view",
            state: "succeeded",
            result: f.viewport(call.body!),
          },
    );
    const user = userEvent.setup();
    const { container } = render(<Workbench />);
    await screen.findByLabelText("저장 상태");
    await user.click(screen.getByRole("button", { name: "↓ 40행" }));
    await screen.findByRole("button", { name: "B41:C41 191" });
    await act(async () => resolveOld({ job_id: "old-view", state: "queued" }));
    await waitFor(() =>
      expect(f.calls.some((c) => c.path === "/jobs/old-view/cancel")).toBe(
        true,
      ),
    );
    expect(screen.queryByRole("button", { name: "B3:C3 공정" })).toBeNull();
    const reads = f.calls.filter((c) => c.path === "/viewports");
    expect(reads.map((c) => c.body!.r1)).toEqual([1, 41]);
    expect(reads.every((c) => c.body!.rows * c.body!.cols <= 480)).toBe(true);
    await user.selectOptions(screen.getByLabelText("확대 배율"), "2");
    expect(
      (container.querySelector(".v2-sheet") as HTMLElement).style.transform,
    ).toBe("scale(2)");
    expect(f.calls.filter((c) => c.path === "/viewports")).toHaveLength(2);
  });

  it("추출 항목을 30개씩 넘기고 각 값과 별도 시트의 단위 출처로 이동한다", async () => {
    const f = workbenchFixture();
    f.open("source", { row: "1", col: "1" });
    const user = userEvent.setup();
    render(<Workbench />);
    await screen.findByRole("button", { name: "100030", exact: true });
    const items = section("항목별 값");
    expect(items.getAllByRole("row")).toHaveLength(31);
    await user.click(items.getByRole("button", { name: "다음", exact: true }));
    const value = await screen.findByRole("button", {
      name: "100031",
      exact: true,
    });
    expect(
      items.queryByRole("button", { name: "100001", exact: true }),
    ).toBeNull();
    await user.click(value);
    await waitFor(() => expect(route().get("row")).toBe("34"));
    expect(route().get("item")).toBe(f.item(31).item_id);
    await user.click(screen.getByRole("button", { name: /공통 정보!B1/ }));
    await waitFor(() => expect(route().get("sheet")).toBe(f.ids.common));
    expect(route().get("row")).toBe("1");
    expect(await screen.findByRole("button", { name: "B1 °C" })).toBeTruthy();
    const paged = f.calls.filter(
      (c) => c.path === `/series/${f.ids.series}/items`,
    );
    expect(paged.map((c) => c.url.searchParams.get("limit"))).toEqual([
      "30",
      "30",
    ]);
    expect(paged[1].url.searchParams.get("cursor")).toBe("items-page-2");
  });

  it("출력 DB 생성과 페이지 조회 후 선택한 단위의 출처를 정확히 연다", async () => {
    const f = workbenchFixture();
    f.open("database");
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByRole("button", { name: "필드에 추가" }),
    );
    const name = await screen.findByLabelText("출력 열 이름");
    await user.clear(name);
    await user.type(name, "운전 온도");
    await user.click(
      screen.getByRole("button", { name: "통합 명세 저장 · DB 생성" }),
    );
    await screen.findByRole("heading", { name: "결과 미리보기" });
    expect(f.state.integration.spec).toMatchObject({
      kg_revision_id: f.ids.kg,
      row_mode: "record_scope",
      fields: [
        {
          output_name: "운전 온도",
          target_type: "decimal",
          target_unit: "°C",
          sources: [
            {
              application_id: f.ids.application,
              rule_key: "process_temperature",
            },
          ],
        },
      ],
    });
    const preview = within(
      screen
        .getByRole("heading", { name: "결과 미리보기" })
        .closest("section")!,
    );
    await preview.findByRole("button", { name: "100030", exact: true });
    await user.click(
      preview.getByRole("button", { name: "다음", exact: true }),
    );
    await user.click(
      await preview.findByRole("button", { name: "100031", exact: true }),
    );
    await user.click(await screen.findByRole("button", { name: /^value/ }));
    const unit = await screen.findByRole("button", { name: /공통 정보!B1/ });
    await waitFor(() => expect(unit.hasAttribute("disabled")).toBe(false));
    await user.click(unit);
    await screen.findByRole("heading", { name: "매핑 검수" });
    // The source screen must respect a specific lineage region, even when the
    // same item also has a value region on another sheet.
    await screen.findByRole("button", { name: "B1 °C" });
    expect(route().get("sheet")).toBe(f.ids.common);
    expect(route().get("row")).toBe("1");
    expect(route().get("application")).toBe(f.ids.application);
    expect(route().get("mapping")).toBe(f.ids.mapping);
  });

  it.each([
    { type: "decimal", unit: "°C" },
    { type: "text", unit: null },
  ])(
    "건수 집계에서 일반 행 결합으로 돌아오면 원래 $type 타입과 단위를 복원한다",
    async ({ type, unit }) => {
      const f = workbenchFixture();
      f.state.mapping.effective_spec.value_spec = { type, unit };
      f.overrides.set(`GET /series/${f.ids.series}/items`, () => ({
        items: [{ value_text: "가상 값", unit_normalized: unit }],
        has_more: false,
        next_cursor: null,
      }));
      f.open("database");
      const user = userEvent.setup();
      render(<Workbench />);
      await user.click(
        await screen.findByRole("button", { name: "필드에 추가" }),
      );
      await screen.findByLabelText("출력 열 이름");
      await user.selectOptions(
        screen.getByLabelText("행 결합 방식"),
        "aggregate",
      );
      await user.selectOptions(
        screen.getByLabelText("집계", { exact: true }),
        "count",
      );
      await user.selectOptions(
        screen.getByLabelText("행 결합 방식"),
        "record_scope",
      );
      await user.click(
        screen.getByRole("button", { name: "통합 명세 저장 · DB 생성" }),
      );
      await waitFor(() => expect(f.state.integration).not.toBeNull());
      expect(f.state.integration.spec.fields[0].target_unit).toBe(unit);
      expect(f.state.integration.spec.fields[0].target_type).toBe(type);
    },
  );
});
