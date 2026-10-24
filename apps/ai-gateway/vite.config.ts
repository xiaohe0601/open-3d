import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["tests/**/*.test.mjs"], testTimeout: 30_000, fileParallelism: false },
});