import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { page, workbenchFixture } from "./workbench-fixture";

function graphFixture(extra: Record<string, any> = {}) {
  const f = workbenchFixture();
  const graph = {
    domain: "workspace",
    nodes: [
      {
        concept_id: "plant",
        name: "공정",
        level: 1,
        parent: null,
        root: "plant",
        sources: 0,
      },
      {
        concept_id: "quality",
        name: "품질",
        level: 1,
        parent: null,
        root: "quality",
        sources: 0,
      },
      {
        concept_id: f.ids.concept,
        name: "공정온도",
        level: 2,
        parent: "plant",
        root: "plant",
        sources: 2,
      },
      {
        concept_id: f.ids.other,
        name: "운전온도",
        level: 2,
        parent: "quality",
        root: "quality",
        sources: 0,
      },
    ],
    groups: [
      { root_concept_id: "plant", name: "공정", member_document_count: 1 },
      { root_concept_id: "quality", name: "품질", member_document_count: 0 },
    ],
    edges: [
      { from_concept_id: "plant", to_concept_id: f.ids.concept },
      { from_concept_id: "quality", to_concept_id: f.ids.other },
    ],
    truncated: false,
    node_cap: 2000,
    ...extra,
  };
  f.overrides.set(`GET /kg/${f.ids.kg}/graph`, () => graph);
  f.overrides.set("GET /kg/revisions", () =>
    page([
      { kg_revision_id: f.ids.kg, revision_no: 1, created_at: "2026-09-09T00:00:00Z" },
    ]),
  );
  for (const id of [f.ids.concept, f.ids.other])
    f.overrides.set(`GET /kg/${f.ids.kg}/concepts/${id}/relations`, () =>
      page([]),
    );
  f.open("kg", { concept: "" });
  return f;
}
const query = (key: string) =>
  new URLSearchParams(location.search).get(key);

describe("개념 탐색 커버리지 그래프", () => {
  it("가짜 /graph 응답으로 노드와 문서군 hull을 그린다", async () => {
    graphFixture();
    render(<Workbench />);
    expect(
      await screen.findByRole("button", { name: "개념 공정온도" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "문서군 공정" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "문서군 품질" })).toBeTruthy();
    expect(
      screen.getByLabelText("전체 개념 트리와 문서군 커버리지"),
    ).toBeTruthy();
    expect(screen.getByText("공정 · 문서 1")).toBeTruthy();
    expect(screen.getByText("2 출처")).toBeTruthy();
    expect(screen.getByText("미연결")).toBeTruthy();
    expect(document.querySelectorAll(".v2-graph .hull")).toHaveLength(2);
    expect(document.querySelectorAll(".v2-graph .gnode")).toHaveLength(5);
  });

  it("하위 개념이 없는 L1도 문서군 hull과 출처 수로 그린다", async () => {
    graphFixture({
      nodes: [
        { concept_id: "plant", name: "공정", level: 1, parent: null, root: "plant", sources: 3 },
      ],
      groups: [{ root_concept_id: "plant", name: "공정", member_document_count: 2 }],
      edges: [],
    });
    render(<Workbench />);
    expect(
      await screen.findByRole("button", { name: "문서군 공정" }),
    ).toBeTruthy();
    expect(document.querySelectorAll(".v2-graph .hull")).toHaveLength(1);
    expect(screen.getByText("공정 · 문서 2")).toBeTruthy();
    expect(screen.getByText("3 src")).toBeTruthy();
  });

  it("노드를 클릭하면 개념 상세로 이동한다", async () => {
    const f = graphFixture();
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByRole("button", { name: "개념 공정온도" }),
    );
    await waitFor(() => expect(query("concept")).toBe(f.ids.concept));
    expect(screen.getByRole("heading", { name: f.ids.concept })).toBeTruthy();
    await waitFor(() =>
      expect(
        f.calls.some(
          (c) =>
            c.path === "/series" &&
            c.url.searchParams.get("concept_id") === f.ids.concept,
        ),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("button", { name: "개념 공정온도" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByLabelText("개념명")).toBeTruthy();
  });

  it("hull을 클릭하면 목록을 그 문서군으로 거르고 강조한다", async () => {
    const f = graphFixture();
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByRole("button", { name: "문서군 품질" }),
    );
    await waitFor(() => expect(query("root")).toBe("quality"));
    const region = screen.getByRole("region", { name: "도메인 개념" });
    expect(within(region).getByText("운전온도")).toBeTruthy();
    expect(within(region).queryByText("공정온도")).toBeNull();
    expect(within(region).getByText("문서군 필터: 품질")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "문서군 공정" })
        .querySelector("rect.hull.dim"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "문서군 품질" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "필터 해제" }));
    await waitFor(() => expect(query("root")).toBeNull());
    expect(await within(region).findByText("공정온도")).toBeTruthy();
    expect(f.calls.filter((c) => c.path.endsWith("/graph"))).toHaveLength(1);
  });

  it("목록 보기로 전환하면 그래프를 숨기고 줌을 조절한다", async () => {
    graphFixture();
    const user = userEvent.setup();
    render(<Workbench />);
    await screen.findByRole("button", { name: "개념 공정온도" });
    await user.click(screen.getByRole("button", { name: "그래프 확대" }));
    expect(
      screen.getByRole("button", { name: "원래 크기로" }).textContent,
    ).toBe("125%");
    expect(
      (
        screen.getByLabelText(
          "전체 개념 트리와 문서군 커버리지",
        ) as unknown as SVGElement
      ).style.width,
    ).toBe("1475px");
    await user.click(screen.getByRole("button", { name: "목록" }));
    expect(
      screen.queryByLabelText("전체 개념 트리와 문서군 커버리지"),
    ).toBeNull();
    expect(screen.getByLabelText("개념 검색")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "그래프" }));
    expect(
      screen.getByLabelText("전체 개념 트리와 문서군 커버리지"),
    ).toBeTruthy();
  });

  it("상한을 넘으면 부분 표시 안내를 보인다", async () => {
    graphFixture({ truncated: true, node_cap: 2000 });
    render(<Workbench />);
    expect(await screen.findByText(/2,000개를 넘어/)).toBeTruthy();
  });
});
