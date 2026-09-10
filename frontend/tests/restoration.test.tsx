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
import { page, workbenchFixture } from "./workbench-fixture";

describe("기존 기능과 디자인 복원", () => {
  it("하위 개념을 체크하는 동안 펼친 트리와 선택 표시를 유지한다", async () => {
    const f = workbenchFixture();
    f.open("database", { concept: "" });
    const responses: (() => void)[] = [];
    f.overrides.set(`GET /kg/${f.ids.kg}/tree`, ({ url }) => {
      const selected = url.searchParams.getAll("roots");
      const child = url.searchParams.get("parent_id") === "classification";
      const body = page([
        {
          concept_id: child ? f.ids.concept : "classification",
          name: child ? "공정온도" : "공정 분류",
          child_count: child ? 0 : 1,
          checked: child && selected.includes(f.ids.concept),
          indeterminate: !child && selected.length > 0,
          descendant_selections: selected,
        },
      ]);
      return selected.length
        ? new Promise((resolve) => responses.push(() => resolve(body)))
        : body;
    });
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByText("개념 트리 · 하위 개념 일괄 선택"),
    );
    await user.click(
      await screen.findByRole("button", { name: "공정 분류 하위 개념 펼치기" }),
    );
    await user.click(await screen.findByRole("checkbox", { name: "공정온도" }));
    await waitFor(() => expect(responses).toHaveLength(2));
    expect(
      screen.getByRole("button", { name: "공정 분류 하위 개념 접기" }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "공정온도" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await act(async () => responses.forEach((resolve) => resolve()));
    expect(
      screen.getByRole("button", { name: "공정 분류 하위 개념 접기" }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "공정온도" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
  it("제품명과 기존 탭 순서를 유지하고 문서 필터를 조회에 반영한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    const user = userEvent.setup();
    render(<Workbench />);
    expect(screen.getByText("Semantic Excel Integration")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "작업 단계" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "1. 파일 분석",
      "2. 개념 탐색",
      "3. 원본 데이터",
      "4. 통합 DB",
      "5. 템플릿 관리",
    ]);
    await user.type(
      await screen.findByLabelText("작성자", { exact: true }),
      "홍길동",
    );
    // 파일 열이 기본 정렬이므로 헤더를 다시 누르면 내림차순으로 바뀐다.
    await user.click(await screen.findByRole("button", { name: "파일" }));
    await waitFor(() =>
      expect(
        f.calls.some(
          (c) =>
            c.path === "/documents" &&
            c.url.searchParams.get("author") === "홍길동" &&
            c.url.searchParams.get("direction") === "desc",
        ),
      ).toBe(true),
    );
  });
  it("규칙이 없을 때 셀을 선택하면 안내하고, 선택한 규칙의 프리셋을 새 리비전에 저장한다", async () => {
    const f = workbenchFixture();
    f.open("source", { application: "", mapping: "", series: "" });
    const user = userEvent.setup();
    render(<Workbench />);
    const cell = await screen.findByRole("button", { name: "B3:C3 공정" });
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(screen.getByText("먼저 추출 규칙을 선택하세요.")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /공정 운전 기록 · v1/ }),
    );
    await screen.findByRole("option", { name: "자동 정규화", exact: true });
    await user.selectOptions(
      await screen.findByLabelText("전처리 프리셋"),
      "automatic",
    );
    await user.click(screen.getByRole("button", { name: "수정 버전 저장" }));
    await waitFor(() =>
      expect(
        f.state.saved?.effective_spec.value_spec.normalization,
      ).toMatchObject({
        operation: "pipeline",
        preset_id: "automatic",
        steps: [{ op: "automatic" }],
      }),
    );
  });
  it("펼치지 않은 개념도 서버 페이지를 모두 확인해 일괄 추가한다", async () => {
    const f = workbenchFixture();
    f.open("database", { concept: "" });
    f.overrides.set("GET /series", ({ url }) =>
      page(
        [
          {
            series_id: "s",
            application_id: f.ids.application,
            rule_key: "temperature",
            concept_id: f.ids.concept,
            concept_name: "공정온도",
            target_type: "decimal",
            target_unit: "°C",
          },
        ],
        url.searchParams.has("cursor") ? null : "second-page",
      ),
    );
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByText("개념 트리 · 하위 개념 일괄 선택"),
    );
    await user.click(await screen.findByRole("checkbox", { name: "공정온도" }));
    await user.click(
      screen.getByRole("button", { name: "선택한 개념의 소스 모두 추가" }),
    );
    await screen.findByLabelText("출력 열 이름");
    expect(
      f.calls.some(
        (c) =>
          c.path === "/series" &&
          c.url.searchParams.get("cursor") === "second-page",
      ),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "통합 명세 저장 · DB 생성" }),
    );
    await waitFor(() =>
      expect(f.state.integration?.spec.fields).toHaveLength(1),
    );
    expect(f.state.integration.spec.fields[0].sources).toHaveLength(1);
  });
  it("검수 큐의 승인에서 현재 편집 순번과 규칙을 보존한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    f.overrides.set("GET /review-queue", () =>
      page(
        f.state.saved
          ? []
          : [
              {
                ...f.state.mapping,
                document_id: f.ids.document,
                document_version_id: f.ids.version,
                display_name: "가상 공정.xlsx",
                template_name: "공정 운전 기록",
              },
            ],
      ),
    );
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await within(
        await screen.findByRole("region", { name: "검수 큐" }),
      ).findByRole("button", { name: "승인", exact: true }),
    );
    await waitFor(() =>
      expect(f.state.saved).toMatchObject({
        expected_seq: 3,
        status: "approved",
        concept_id: f.ids.concept,
      }),
    );
  });
});
