import { defineConfig } from "vitest/config";

// Root test configuration owned by the bootstrap (execution charter:
// bootstrap owns reusable fixture/test helpers). The include set stays
// pinned to tests/ so workspace-local suites added by later tickets do
// not silently widen the root `npm run test` surface.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several suites import the whole app or run the in-process Convex
    // backend (tests/integration); on a loaded machine they pass 5 s.
    testTimeout: 30_000,
  },
});
