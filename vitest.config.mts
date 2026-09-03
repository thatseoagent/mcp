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
    coverage: {
      provider: "v8",
      // `src/` in full, so a module no test imports is a 0% row rather than an
      // absent one. Every estimate of this suite's reach before this existed was
      // made by counting `it(` blocks against file lengths.
      include: ["src/**/*.ts"],
      // Not code, and each would read as an untested file: the Tool and resource
      // manifests xmcp discovers, and the type-only modules.
      exclude: ["src/**/*.d.ts", "src/lib/db/schema.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      /**
       * A floor, not a target.
       *
       * Set a little under what the suite already reaches (88% of statements,
       * 74% of branches) so the number's job is to catch a module landing with
       * no test rather than to be negotiated with. Raising a threshold is a
       * decision; drifting under one is an accident, and this is the only thing
       * that can tell them apart.
       *
       * Branches sits lowest on purpose: a three-state check has arms that only
       * a specific upstream failure reaches, and several are deliberately
       * unreachable from a test that does not stub a network refusal.
       */
      thresholds: {
        statements: 85,
        branches: 72,
        functions: 85,
        lines: 87,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
