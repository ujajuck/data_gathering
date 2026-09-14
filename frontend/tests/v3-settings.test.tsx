import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TOKEN_KEY } from "../src/v3/client";
import { UUID_RE, page, v3Fixture } from "./v3-fixture";

describe("v3 설정 화면", () => {
  it("읽기 전용 카드(렌더 서버 · Reader · 한도 · 작업 공간)와 정규화 프리셋 표를 보여준다", async () => {
    const f = v3Fixture();
    f.overrides.set("GET /settings", () => ({
      workspace: "/srv/workspaces/plant-a",
      render: { mode: "http", url: "http://render.internal:8811", renderer_version: "r-2026.09" },
      reader_factory: "plugins.drm:make_reader",
      limits: { render_queue: 32, body_mb: 2, custom_limit: "7일" },
      principal: "ops@plant-a",
    }));
    f.overrides.set("GET /normalization-presets", () =>
      page([
        { id: "identity", label: "원값 유지", normalization: { operation: "identity" } },
        { id: "celsius", label: "섭씨 변환", normalization: { operation: "unit", target: "°C" } },
      ]),
    );
    const { container } = f.renderApp("?screen=settings");
    const render = await screen.findByRole("region", { name: "렌더 서버" });
    expect(render.textContent).toContain("외부 서버(HTTP)");
    expect(render.textContent).toContain("http://render.internal:8811");
    expect(render.textContent).toContain("r-2026.09");
    expect(screen.getByRole("region", { name: "Reader" }).textContent).toContain("plugins.drm:make_reader");
    const limits = screen.getByRole("region", { name: "한도" });
    expect(limits.textContent).toContain("렌더 큐 상한");
    expect(limits.textContent).toContain("32");
    expect(limits.textContent).toContain("요청 본문 상한(MB)");
    expect(limits.textContent).toContain("custom_limit");
    expect(limits.textContent).toContain("7일");
    // 작업 공간 경로는 설정 화면에서만 절대 경로로 보인다; 알 수 없는 최상위 키도 여기 붙는다
    const workspace = screen.getByRole("region", { name: "작업 공간" });
    expect(workspace.textContent).toContain("/srv/workspaces/plant-a");
    expect(workspace.textContent).toContain("ops@plant-a");
    const table = screen.getByRole("table", { name: "정규화 프리셋 목록" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["이름", "키", "정의"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("섭씨 변환");
    expect(rows[1].textContent).toContain("celsius");
    expect(rows[1].textContent).toContain('"target":"°C"');
    // 진입 호출: /settings · /normalization-presets
    expect(f.callsTo(/^\/settings$/)).toHaveLength(1);
    expect(f.callsTo(/^\/normalization-presets$/)).toHaveLength(1);
    expect(container.textContent).not.toMatch(UUID_RE);
    expect(screen.getByRole("navigation", { name: "보조 메뉴" }).querySelector("[aria-current='page']")?.textContent).toBe("설정");
  });

  it("내장 렌더 모드와 빈 프리셋 목록을 안내한다", async () => {
    const f = v3Fixture();
    f.overrides.set("GET /normalization-presets", () => page([]));
    f.renderApp("?screen=settings");
    const render = await screen.findByRole("region", { name: "렌더 서버" });
    expect(render.textContent).toContain("내장(in-process)");
    expect(render.textContent).toContain("사용 안 함");
    expect(screen.getByRole("region", { name: "Reader" }).textContent).toContain("기본(XLSX)");
    await screen.findByText("프리셋이 없습니다.");
    expect(screen.queryByRole("table", { name: "정규화 프리셋 목록" })).toBeNull();
  });

  it("서버 접근 토큰은 localStorage 'v3.token'에 저장되고 다음 요청부터 헤더로 전달되며, 지우기로 삭제된다", async () => {
    const f = v3Fixture();
    f.renderApp("?screen=settings");
    const card = await screen.findByRole("region", { name: "서버 접근" });
    expect(card.textContent).toContain("토큰 없음");
    const user = userEvent.setup();
    const save = within(card).getByRole("button", { name: "저장" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.type(within(card).getByLabelText("서버 접근 토큰"), "  secret-token ");
    await user.click(save);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("secret-token");
    expect(card.textContent).toContain("토큰 저장됨");
    expect((within(card).getByLabelText("서버 접근 토큰") as HTMLInputElement).value).toBe("");
    await screen.findByText("서버 접근 토큰을 저장했습니다.");
    // 저장 뒤 응답 캐시가 비워져 다음 화면 진입은 토큰을 붙여 다시 요청한다
    await user.click(screen.getByRole("button", { name: "작업 내역" }));
    await waitFor(() => {
      const withToken = f.calls.filter((c) => c.headers.authorization === "Bearer secret-token");
      expect(withToken.length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "설정" }));
    const again = await screen.findByRole("region", { name: "서버 접근" });
    expect(again.textContent).toContain("토큰 저장됨");
    await user.click(within(again).getByRole("button", { name: "지우기" }));
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(again.textContent).toContain("토큰 없음");
    expect(within(again).getByRole("button", { name: "지우기" }).hasAttribute("disabled")).toBe(true);
  });
});
