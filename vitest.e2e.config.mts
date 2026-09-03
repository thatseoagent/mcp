import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    // Spawns a real process and reaches the public internet: slower than the unit
    // suite and separated from it so the unit suite stays offline and fast.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The listening port is a single shared resource compiled into the build, so
    // two e2e files running at once would fight over it — and the busy-port test
    // occupies it on purpose. Serial is not a speed compromise here; it is the
    // only correct setting.
    fileParallelism: false,
  },
});
