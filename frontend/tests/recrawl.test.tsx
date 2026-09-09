import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { page, workbenchFixture } from "./workbench-fixture";

type Fixture = ReturnType<typeof workbenchFixture>;

function templateFixture(f: Fixture) {
  f.open("templates");
  f.overrides.set("GET /templates", () =>
    page([
      {
        template_id: "t1",
        name: "공정 운전 기록",
        revision_no: 1,
        template_version_id: "tv1",
        kg_revision_id: f.ids.kg,
      },
    ]),
  );
  f.overrides.set("GET /template-versions/tv1", () => ({
    template_version_id: "tv1",
    template_id: "t1",
    revision_no: 1,
    kg_revision_id: f.ids.kg,
    definition: {
      kg_revision_id: f.ids.kg,
      sheet_roles: { main: { cardinality: "one" } },
      rules: [],
    },
  }));
  f.overrides.set("GET /templates/t1/versions", () =>
    page([{ template_version_id: "tv1", revision_no: 1 }]),
  );
}

const GROUP = { name: "템플릿 재크롤링" };

describe("템플릿 재크롤링", () => {
  // useDraft는 모듈 전역 Map이므로 선택 전 상태를 보는 이 테스트를 파일의 첫 번째에 둔다.
  it("템플릿을 선택하기 전에는 재크롤링을 표시하지 않는다", async () => {
    const f = workbenchFixture();
    templateFixture(f);
    render(<Workbench />);
    await screen.findByText("공정 운전 기록");
    expect(screen.queryByRole("group", GROUP)).toBeNull();
  });

  it("선택한 템플릿 버전을 재크롤링하고 대기·건너뜀 결과와 작업 상태를 표시한다", async () => {
    const f = workbenchFixture();
    templateFixture(f);
    f.overrides.set("POST /template-versions/tv1/recrawl", ({ body }) => ({
      template_version_id: "tv1",
      mode: body.mode,
      request_key: body.request_key,
      queued: [{ application_id: f.ids.application, job_id: "job-1" }],
      skipped: [{ application_id: "app-2", reason: "review_required" }],
    }));
    f.overrides.set("GET /template-versions/tv1/recrawl-status", () => ({
      ...page([
        {
          job_id: "job-1",
          application_id: f.ids.application,
          state: "succeeded",
        },
      ]),
      summary: { succeeded: 1 },
    }));
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(await screen.findByText("공정 운전 기록"));
    const group = await screen.findByRole("group", GROUP);
    await user.selectOptions(within(group).getByRole("combobox"), "reset_auto");
    await user.click(within(group).getByRole("button", { name: "실행" }));
    await screen.findByText("대기열 1건 · 건너뜀 1건");
    const post = f.calls.find(
      (c) => c.method === "POST" && c.path === "/template-versions/tv1/recrawl",
    );
    expect(post?.body.mode).toBe("reset_auto");
    expect(typeof post?.body.request_key).toBe("string");
    expect(post?.body.request_key.length).toBeGreaterThan(0);
    expect(within(group).getByText(/검수 필요/)).toBeTruthy();
    expect(within(group).getByText(f.ids.application)).toBeTruthy();
    await waitFor(() => {
      const status = f.calls.find(
        (c) => c.path === "/template-versions/tv1/recrawl-status",
      );
      expect(status?.url.searchParams.get("request_key")).toBe(
        post?.body.request_key,
      );
    });
    await within(group).findByText(/완료 1/);
  });

  it("재크롤링 오류를 표시하고 재시도마다 새 요청 키를 만든다", async () => {
    const f = workbenchFixture();
    templateFixture(f);
    let attempts = 0;
    f.overrides.set("POST /template-versions/tv1/recrawl", ({ body }) => {
      if (++attempts === 1) throw new Error("대기 작업이 많습니다.");
      return {
        template_version_id: "tv1",
        mode: body.mode,
        request_key: body.request_key,
        queued: [],
        skipped: [],
      };
    });
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(await screen.findByText("공정 운전 기록"));
    const group = await screen.findByRole("group", GROUP);
    await user.click(within(group).getByRole("button", { name: "실행" }));
    await within(group).findByText("대기 작업이 많습니다.");
    expect(within(group).getByRole("alert").textContent).toBe(
      "대기 작업이 많습니다.",
    );
    await user.click(within(group).getByRole("button", { name: "실행" }));
    await screen.findByText("대기열 0건 · 건너뜀 0건");
    expect(within(group).getByRole("alert").textContent).toBe("");
    const posts = f.calls.filter(
      (c) => c.method === "POST" && c.path === "/template-versions/tv1/recrawl",
    );
    expect(posts).toHaveLength(2);
    expect(posts.map((c) => c.body.mode)).toEqual(["fill", "fill"]);
    expect(posts[0].body.request_key).not.toBe(posts[1].body.request_key);
    expect(
      f.calls.some((c) => c.path === "/template-versions/tv1/recrawl-status"),
    ).toBe(false);
  });
});
