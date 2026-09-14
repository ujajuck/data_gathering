import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",           // 하위 경로에 마운트해도 에셋 경로가 깨지지 않게
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8010" } },
});
