import { defineConfig } from "vitest/config";

// Root test configuration owned by the bootstrap (execution charter:
// bootstrap owns reusable fixture/test helpers). The include set stays
// pinned to tests/ so workspace-local suites added by later tickets do
// not silently widen the root `npm run test` surface.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
