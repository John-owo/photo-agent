import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      reporter: ["text", "html"],
      exclude: ["tests/**", "dist/**"],
    },
  },
});
