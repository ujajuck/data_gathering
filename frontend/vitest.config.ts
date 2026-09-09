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
    },
  }),
);
