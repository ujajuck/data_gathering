import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../src/product";
import { UUID_RE, SHA_RE, appFixture } from "./fixture";

const route = () => new URLSearchParams(location.search);

describe("작업 공간 쉘", () => {
  it("제품명·메뉴 순서·aria-current를 갖고, 메뉴 클릭으로 화면과 URL이 바뀐다", async () => {
    const f = appFixture();
    f.renderApp("/");
    expect(screen.getByText(PRODUCT_NAME)).toBeTruthy();
    expect(screen.getByText("Document-to-Table Adapter")).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "주 메뉴" }));
    expect(nav.getAllByRole("button").map((b) => b.textContent)).toEqual(["문서", "파싱 프로파일", "파싱 스키마", "데이터 빌드", "작업 내역"]);
    expect(nav.getByRole("button", { name: "문서" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("navigation", { name: "보조 메뉴" })).getByRole("button", { name: "설정" })).toBeTruthy();
    await screen.findByRole("heading", { name: "문서" });
    await f.waitForApi(/^\/documents\?/);

    const user = userEvent.setup();
    await user.click(nav.getByRole("button", { name: "파싱 프로파일" }));
    expect(route().get("screen")).toBe("profiles");
    expect(nav.getByRole("button", { name: "파싱 프로파일" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("button", { name: "문서" }).getAttribute("aria-current")).toBeNull();
    await screen.findByRole("heading", { name: "파싱 프로파일" });
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    // 화면 진입 API 호출 ≤ 3 (status 포함).
    expect(f.calls.filter((c) => c.path === "/profiles" || c.path === "/status").length).toBeLessThanOrEqual(3);
  });

  it("통합 검색은 250ms 디바운스 뒤 한 번만 호출하고, 종류별로 묶으며, 선택하면 hit.route로 이동한다", async () => {
    const f = appFixture();
    f.renderApp("/");
    await screen.findByRole("heading", { name: "문서" });
    const user = userEvent.setup();
    const box = screen.getByRole("combobox", { name: "통합 검색" });
    await user.type(box, "공정데이터");
    await f.waitForApi(/^\/search\?q=/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const searches = f.callsTo(/^\/search/);
    expect(searches).toHaveLength(1);
    expect(searches[0].url.searchParams.get("q")).toBe("공정데이터");
    const list = await screen.findByRole("listbox", { name: "검색 결과" });
    expect(within(list).getByRole("group", { name: "문서" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "파싱 프로파일" })).toBeTruthy();
    await user.click(within(list).getByRole("option", { name: /공정데이터_2024_02\.xlsx/ }));
    expect(route().get("screen")).toBe("documents");
    expect(route().get("document")).toBe(f.ids.document(2));
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    await within(dialog).findByRole("heading", { name: "공정데이터_2024_02.xlsx" });

    // Enter는 강조된 첫 결과로 이동한다.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 상세" })).toBeNull());
    await user.type(box, "B양식");
    // 검색 결과 목록 안으로 한정한다(문서 화면의 프로파일 필터 <select>에도 같은 이름의 option이 있다).
    await within(await screen.findByRole("listbox", { name: "검색 결과" })).findByRole("option", { name: /공정데이터_B양식/ });
    await user.keyboard("{Enter}");
    expect(route().get("screen")).toBe("profiles");
    expect(route().get("profile")).toBe(f.ids.profile2);
  });

  it("/status가 401이면 토큰 입력을 보여주고, 연결하면 토큰을 저장해 다시 요청한다", async () => {
    const f = appFixture();
    f.state.requireToken = true;
    f.renderApp("/");
    const user = userEvent.setup();
    const input = await screen.findByLabelText("서버 접근 토큰");
    expect(screen.queryByRole("heading", { name: "문서" })).toBeNull();
    await user.type(input, "secret-token");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await screen.findByRole("heading", { name: "문서" });
    expect(localStorage.getItem("schema.token")).toBe("secret-token");
    const authorized = f.calls.filter((c) => c.path === "/status" && c.headers.authorization === "Bearer secret-token");
    expect(authorized.length).toBeGreaterThan(0);
  });

  it("진행 중 작업이 있으면 JobBar에 수를 보여주고, 없으면 /jobs를 폴링하지 않는다", async () => {
    const f = appFixture();
    f.renderApp("/");
    await screen.findByRole("heading", { name: "문서" });
    await f.waitForApi(/^\/documents\?/);
    expect(f.callsTo(/^\/jobs/)).toHaveLength(0);

    const g = appFixture();
    g.state.jobsRunning = 1;
    g.state.running = [
      {
        job_id: g.ids.job,
        kind: "extract",
        state: "running",
        completed: 0,
        total: 1,
        result: null,
        error_code: null,
        error_message: null,
        target_kind: "document",
        target_id: g.ids.document(1),
        label: "공정데이터_2024_01.xlsx",
        created_at: "2026-09-14T09:00:00Z",
        started_at: "2026-09-14T09:00:01Z",
        finished_at: null,
      },
    ];
    g.renderApp("/");
    await screen.findByText("진행 중 작업 1");
    await g.waitForApi(/^\/jobs\?state=running/);
  });

  it("문서 화면 텍스트에 UUID·SHA-256이 보이지 않는다", async () => {
    const f = appFixture();
    const { container } = f.renderApp("/");
    await screen.findByRole("table", { name: "문서 목록" });
    const text = container.textContent || "";
    expect(text).not.toMatch(UUID_RE);
    expect(text).not.toMatch(SHA_RE);
  });
});
