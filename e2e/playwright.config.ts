import { defineConfig } from "@playwright/test";

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
    // 승인된 실행 환경에 설치된 Chromium 경로를 명시할 수 있다. 미설정 시 Playwright 기본값.
    launchOptions: {
      executablePath:
        process.env.KG_E2E_CHROMIUM_PATH ||
        process.env.CHROMIUM_PATH ||
        undefined,
    },
    viewport: { width: 1600, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
