import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 25000,
    hookTimeout: 25000,
    fileParallelism: false,
  },
});
