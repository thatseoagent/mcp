import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Scoped to this repo's own tests, rather than left to the default glob.
    // During the extraction a sibling checkout sat inside this directory and
    // contributed several hundred test files that passed locally and did not
    // exist in CI; naming the directory is what stops anything outside it from
    // ever counting again.
    include: ["tests/**/*.test.ts"],
    // The e2e suite spawns the built server and reaches the public internet. It
    // has its own config and script so this one stays offline, fast, and runnable
    // without a build.
    exclude: ["tests/e2e/**"],
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
