import { defineConfig } from "@playwright/test";

// 병렬 실행(에이전트·CI 매트릭스)을 위해 포트를 환경변수로 바꿀 수 있다. serve.py도 같은 변수를 읽는다.
const PORT = process.env.SCHEMA_E2E_PORT || "8031";

// 브라우저 시나리오. 러너(serve.py)가 임시 작업 공간에 가상 문서를 만들고
// 렌더 서버(8032)와 메인 API/UI(8031)를 별도 프로세스로 띄운다. 실제 사용자 작업 공간은 열지 않는다.
export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.SCHEMA_E2E_REPORT || "playwright-report" }]],
  outputDir: process.env.SCHEMA_E2E_RESULTS || "test-results",
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.SCHEMA_E2E_CHROMIUM_PATH || undefined,
    },
    viewport: { width: 1600, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `${process.env.SCHEMA_E2E_PYTHON || "python"} serve.py`,
    url: `http://127.0.0.1:${PORT}/api/status`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
