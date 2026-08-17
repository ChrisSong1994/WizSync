import { defineConfig } from "vitest/config";
import path from "node:path";

// 独立的测试配置：不加载 vite.config.ts 中的 electron 插件，
// 避免 vitest 启动时触发 electron 主进程构建。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(__dirname, "src/render"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
