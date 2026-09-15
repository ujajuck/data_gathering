import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UUID_RE, page, appFixture } from "./fixture";

describe("설정 화면", () => {
  it("읽기 전용 카드(렌더 서버 · Reader · 한도 · 작업 공간)와 정규화 프리셋 표를 보여준다", async () => {
    const f = appFixture();
    f.overrides.set("GET /settings", () => ({
      version: "3",
      workspace: "/srv/workspaces/plant-a",
      render: { mode: "http", url: "http://render.internal:8811", renderer_version: "r-2026.09" },
      reader: {
        factory: "plugins.drm:make_reader",
        revision: "r7",
        timeout_seconds: 60,
        memory_mb: 512,
        drm: { available: true, temp_dir_ok: true, ttl_seconds: 900, cache_mb: 2048, magics: 1 },
      },
      limits: { render_queue: 32, body_mb: 2, custom_limit: "7일" },
      paths: { sources: "/srv/workspaces/plant-a/sources" },
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
    const reader = screen.getByRole("region", { name: "Reader" });
    expect(reader.textContent).toContain("plugins.drm:make_reader");
    expect(within(reader).getByText("연결됨", { selector: ".app-chip" })).toBeTruthy();
    expect(reader.textContent).toContain("등록된 보호 문서 시그니처");
    expect(reader.textContent).toContain("1개");
    // 어댑터가 연결돼 있으면 "설정하세요" 안내는 띄우지 않는다.
    expect(reader.textContent).not.toContain("SCHEMA_READER_FACTORY를 설정하고");
    expect(reader.textContent).toContain("이 서버는 기본으로 127.0.0.1에만 열립니다.");
    const limits = screen.getByRole("region", { name: "한도" });
    expect(limits.textContent).toContain("렌더 큐 상한");
    expect(limits.textContent).toContain("32");
    expect(limits.textContent).toContain("요청 본문 상한(MB)");
    expect(limits.textContent).toContain("custom_limit");
    expect(limits.textContent).toContain("7일");
    // 작업 공간 경로는 설정 화면에서만 절대 경로로 보인다; 알 수 없는 최상위 키도 여기 붙는다
    const workspace = screen.getByRole("region", { name: "작업 공간" });
    expect(workspace.textContent).toContain("/srv/workspaces/plant-a");
    expect(workspace.textContent).toContain("/srv/workspaces/plant-a/sources");
    expect(workspace.textContent).toContain("ops@plant-a");
    // 서버 접근 토큰 영역은 사라졌다(메인 API는 인증하지 않는다).
    expect(screen.queryByRole("region", { name: "서버 접근" })).toBeNull();
    expect(screen.queryByLabelText("서버 접근 토큰")).toBeNull();
    expect(f.calls.filter((c) => c.headers.authorization)).toHaveLength(0);
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
    const f = appFixture();
    f.overrides.set("GET /normalization-presets", () => page([]));
    f.renderApp("?screen=settings");
    const render = await screen.findByRole("region", { name: "렌더 서버" });
    expect(render.textContent).toContain("내장(in-process)");
    expect(render.textContent).toContain("사용 안 함");
    const reader = screen.getByRole("region", { name: "Reader" });
    // §7: 어댑터 줄은 factory 또는 '연결 안 됨'이다.
    expect(within(reader).getByText("보안 읽기 어댑터").nextElementSibling?.textContent).toBe("연결 안 됨");
    expect(within(reader).getByText("연결 안 됨", { selector: ".app-chip" })).toBeTruthy();
    // 연결 안 됨일 때만 무엇을 설정해야 하는지 안내한다.
    expect(reader.textContent).toContain("SCHEMA_READER_FACTORY를 설정하고");
    await screen.findByText("프리셋이 없습니다.");
    expect(screen.queryByRole("table", { name: "정규화 프리셋 목록" })).toBeNull();
  });

  // 서버가 어댑터를 알려 주는데도 카드가 "설정하세요"라고 말하면 카드가 스스로와 어긋난다(drm 블록이 없는 응답).
  it("drm 블록 없이 어댑터만 온 응답도 연결됨으로 읽고 설정 안내를 띄우지 않는다", async () => {
    const f = appFixture();
    f.overrides.set("GET /settings", () => ({
      version: "3",
      workspace: "/tmp/ws",
      render: { mode: "inprocess", url: null, renderer_version: "r1" },
      reader: { factory: "plugins.drm:make_reader", revision: "r7", timeout_seconds: 60, memory_mb: 512 },
      limits: {},
      paths: {},
    }));
    f.overrides.set("GET /normalization-presets", () => page([]));
    f.renderApp("?screen=settings");
    const reader = await screen.findByRole("region", { name: "Reader" });
    expect(within(reader).getByText("연결됨", { selector: ".app-chip" })).toBeTruthy();
    expect(reader.textContent).toContain("plugins.drm:make_reader");
    expect(reader.textContent).not.toContain("SCHEMA_READER_FACTORY를 설정하고");
  });

  // §7 해제본 임시 폴더 칩: `정상` / `작업 공간 안(위험)`.
  it("해제본 임시 폴더가 작업 공간 안이면 위험 칩을 보인다", async () => {
    const f = appFixture();
    f.overrides.set("GET /settings", () => ({
      version: "3",
      workspace: "/tmp/ws",
      render: { mode: "inprocess", url: null, renderer_version: "r1" },
      reader: { factory: "plugins.drm:make_reader", drm: { available: true, temp_dir_ok: false, ttl_seconds: 900, cache_mb: 2048, magics: 2 } },
      limits: {},
      paths: {},
    }));
    f.overrides.set("GET /normalization-presets", () => page([]));
    f.renderApp("?screen=settings");
    const reader = await screen.findByRole("region", { name: "Reader" });
    expect(within(reader).getByText("작업 공간 안(위험)", { selector: ".app-chip" })).toBeTruthy();
    // 시그니처는 개수로만 말한다(§6 `magics: n`).
    expect(within(reader).getByText("등록된 보호 문서 시그니처").nextElementSibling?.textContent).toBe("2개");
  });
});
