import { defineConfig } from "@playwright/test";

// v3 브라우저 시나리오. 러너(v3/serve.py)가 임시 작업 공간에 가상 문서를 만들고
// 렌더 서버(8032)와 메인 API/UI(8031)를 별도 프로세스로 띄운다. 실제 도메인 DB는 열지 않는다.
export default defineConfig({
  testDir: "./v3",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-v3" }]],
  outputDir: "test-results-v3",
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    baseURL: "http://127.0.0.1:8031",
    browserName: "chromium",
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
    command: `${process.env.KG_E2E_PYTHON || "python"} v3/serve.py`,
    url: "http://127.0.0.1:8031/api/v3/status",
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
