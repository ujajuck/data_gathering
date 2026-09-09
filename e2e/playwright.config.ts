import { defineConfig } from "@playwright/test";

// v1 러너(helpers.mjs)와 같은 이름의 환경변수. 미설정 시 `npx playwright install`이 설치한 chromium을 쓴다.
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: "./v2",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Stateful workflow uses a fresh server workspace per run. Retry the whole CI job.
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    baseURL: "http://127.0.0.1:8021",
    browserName: "chromium",
    viewport: { width: 1600, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `${process.env.KG_E2E_PYTHON || "python"} v2/serve.py`,
    url: "http://127.0.0.1:8021/api/v2/status",
    timeout: 120_000,
    // Existing user workspaces or servers are never used by this test.
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
