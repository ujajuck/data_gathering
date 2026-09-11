import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { page, workbenchFixture } from "./workbench-fixture";

function fixture() {
  const f = workbenchFixture();
  f.open("kg", { concept: "", kg_view: "explore" });
  const root = {
    concept_id: "root",
    name: "공정 분류",
    level: 1,
    status: "active",
    canonical_unit: null,
    coverage: null,
  };
  const concept = {
    concept_id: f.ids.concept,
    name: "공정온도",
    level: 2,
    status: "active",
    canonical_unit: "°C",
    coverage: { proposed: 0, approved: 1, rejected: 0, published_series: 1 },
  };
  const graphPath = `/kg/${f.ids.kg}/explore`;
  f.overrides.set(`GET ${graphPath}`, ({ url }) => {
    const focused = !!url.searchParams.get("focus_id");
    const last = url.searchParams.has("cursor");
    const scoped = !!url.searchParams.get("document_version_id");
    return {
      ...page(
        focused
          ? [root]
          : last
            ? [{ ...concept, coverage: scoped ? concept.coverage : null }]
            : [root],
        focused || last ? null : "graph-page-2",
      ),
      focus: focused ? concept : null,
      edges: focused
        ? [
            {
              from_concept_id: "root",
              to_concept_id: f.ids.concept,
              relation_type: "parent_of",
            },
          ]
        : [],
      edges_truncated: false,
      coverage_version: scoped
        ? { filename: "가상 공정.xlsx", revision_no: 1, is_current: true }
        : null,
    };
  });
  f.overrides.set(
    `GET /kg/${f.ids.kg}/concepts/${f.ids.concept}`,
    () => concept,
  );
  f.overrides.set(
    `GET /kg/${f.ids.kg}/concepts/${f.ids.concept}/relations`,
    () => page([]),
  );
  f.overrides.set(
    `GET /kg/${f.ids.kg}/concepts/${f.ids.concept}/mappings`,
    () =>
      page([
        {
          ...f.state.mapping,
          document_id: f.ids.document,
          document_version_id: f.ids.version,
          sheet_id: f.ids.sheet,
          template_name: "공정 운전 기록",
        },
      ]),
  );
  return { ...f, graphPath };
}

describe("유한 KG 커버리지 탐색", () => {
  it("다음 페이지의 노드를 키보드로 선택해 상세·검수로 이동하고 확대는 재조회하지 않는다", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(<Workbench />);
    const graph = await screen.findByRole("region", {
      name: "KG 커버리지 그래프",
    });
    await within(graph).findByRole("button", {
      name: /공정 분류 · 문서 미선택/,
    });
    await user.click(
      within(
        within(graph).getByRole("group", { name: "그래프 페이지" }),
      ).getByRole("button", { name: "다음", exact: true }),
    );
    const node = await within(graph).findByRole("button", {
      name: /공정온도 · 승인 1/,
    });
    fireEvent.keyDown(node, { key: "Enter" });
    const detail = screen.getByRole("region", { name: "선택 개념 상세" });
    await within(detail).findByRole("heading", {
      name: "공정온도",
      exact: true,
    });
    expect(within(detail).getByText("개념 편집 · 동의어 추가")).toBeTruthy();
    const before = f.calls.filter((c) => c.path === f.graphPath).length;
    await user.selectOptions(screen.getByLabelText("그래프 확대"), "0.5");
    expect(
      within(graph)
        .getByRole("group", { name: "도메인 관계와 문서 커버리지" })
        .getAttribute("width"),
    ).toBe("280");
    expect(f.calls.filter((c) => c.path === f.graphPath)).toHaveLength(before);
    await user.click(
      within(graph).getByRole("button", { name: "선택 개념 주변" }),
    );
    await waitFor(() =>
      expect(
        f.calls.some(
          (c) =>
            c.path === f.graphPath &&
            c.url.searchParams.get("focus_id") === f.ids.concept,
        ),
      ).toBe(true),
    );
    expect(new URLSearchParams(location.search).get("graph_focus")).toBe(
      f.ids.concept,
    );
    await user.click(
      await within(detail).findByRole("button", { name: /검수 →/ }),
    );
    const route = new URLSearchParams(location.search);
    expect(route.get("tab")).toBe("source");
    expect(route.get("mapping")).toBe(f.ids.mapping);
    expect(route.get("version")).toBe(f.ids.version);
    expect(route.get("sheet")).toBe(f.ids.sheet);
  });

  it("권한 오류를 빈 커버리지로 표시하지 않고 문서 선택 해제로 KG 탐색을 복구한다", async () => {
    const f = fixture();
    const normal = f.overrides.get(`GET ${f.graphPath}`)!;
    f.overrides.set(`GET ${f.graphPath}`, (call) => {
      if (call.url.searchParams.has("document_version_id"))
        throw new Error("이 작업에 필요한 원본 접근 권한이 없습니다.");
      return normal(call);
    });
    const user = userEvent.setup();
    render(<Workbench />);
    const graph = await screen.findByRole("region", {
      name: "KG 커버리지 그래프",
    });
    expect((await within(graph).findByRole("alert")).textContent).toContain(
      "접근 권한",
    );
    expect(
      within(graph).queryByRole("button", { name: /공정 분류/ }),
    ).toBeNull();
    await user.click(
      within(graph).getByRole("button", { name: "문서 선택 해제" }),
    );
    await within(graph).findByRole("button", {
      name: /공정 분류 · 문서 미선택/,
    });
    expect(new URLSearchParams(location.search).get("coverage")).toBe("none");
    const call = f.calls.filter((c) => c.path === f.graphPath).at(-1)!;
    expect(call.url.searchParams.has("document_version_id")).toBe(false);
    expect(call.url.searchParams.get("limit")).toBe("30");
  });
});
