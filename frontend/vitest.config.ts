import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://component.test/" } },
      include: ["tests/**/*.test.tsx"],
      setupFiles: ["./tests/setup.ts"],
      restoreMocks: true,
      // 느린 CI에서도 화면 전환·폴링 회귀 테스트가 기본 5초에 끊기지 않게 한다.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);
