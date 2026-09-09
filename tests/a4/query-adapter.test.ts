/**
 * Convex TanStack Query adapter seam tests (A4).
 *
 * Mirrors the adapter wiring A3 proved live (docs/evidence/platform/README.md
 * proof1 V8) and the exact wiring apps/web/src/app/connections.ts performs:
 * `ConvexQueryClient` + `QueryClient` defaults (hashFn/queryFn) + the
 * generated `platform/health` function reference through `convexQuery`.
 * No network: constructing the clients and hashing keys subscribes to
 * nothing.
 *
 * Node needs the documented window shim BEFORE importing the adapter (its
 * live-subscription path is gated on `typeof window !== "undefined"`); in
 * the browser the adapter works as-is. The shim is supplied first, exactly
 * like the A3 proof scripts.
 */

import { describe, expect, it } from "vitest";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  (globalThis as { document?: unknown }).document = { hasFocus: () => true };
}

const [{ ConvexQueryClient, convexQuery }, { QueryClient }, { api }] = await Promise.all([
  import("@convex-dev/react-query"),
  import("@tanstack/react-query"),
  import("../../convex/_generated/api"),
]);

describe("convexQuery options for the platform health surface", () => {
  it("builds a convexQuery key over platform/health with live-subscription defaults", () => {
    const options = convexQuery(api.platform.health.health, {});
    const [marker, functionName, args] = options.queryKey;
    expect(marker).toBe("convexQuery");
    expect(functionName).toContain("platform/health");
    expect(args).toEqual({});
    expect(options.staleTime).toBe(Infinity);
  });

  it("supports the documented 'skip' form used for the disconnected state", () => {
    const options = convexQuery(api.platform.health.health, "skip" as const);
    expect("enabled" in options).toBe(true);
    if ("enabled" in options) {
      expect(options.enabled).toBe(false);
    }
  });
});

describe("the app's QueryClient wiring", () => {
  it("hashes convexQuery keys deterministically through the adapter hashFn", () => {
    const convexQueryClient = new ConvexQueryClient("https://example.convex.cloud");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          queryKeyHashFn: convexQueryClient.hashFn(),
          queryFn: convexQueryClient.queryFn(),
        },
      },
    });
    convexQueryClient.connect(queryClient);

    const options = convexQuery(api.platform.health.health, {});
    const hashFn = queryClient.getDefaultOptions().queries?.queryKeyHashFn;
    expect(hashFn).toBeTypeOf("function");
    const first = hashFn?.(options.queryKey);
    const second = hashFn?.(options.queryKey);
    expect(first).toBeTypeOf("string");
    expect(first).toMatch(/^convexQuery\|/);
    expect(first).toBe(second);

    queryClient.clear();
  });
});
