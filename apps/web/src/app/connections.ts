/**
 * Client connection wiring (A4).
 *
 * Builds the TanStack Query + Convex React-Query adapter stack exactly as
 * A3 proved it (docs/evidence/platform/README.md, proof1 V8): one
 * `ConvexQueryClient` owning the live WebSocket subscriptions, one
 * `QueryClient` whose default `queryKeyHashFn`/`queryFn` route
 * `convexQuery(...)` options through the adapter.
 *
 * Without a configured backend URL there is no Convex client at all: the
 * returned `convexQueryClient` is null and the host renders the
 * disconnected state. In the browser the adapter's subscription path works
 * as-is (A3 note: only Node needs the documented window shim).
 */

import { QueryClient } from "@tanstack/react-query";
import { ConvexQueryClient } from "@convex-dev/react-query";
import type { AppConfig } from "./config";

/** The connected client stack the host mounts. */
export interface AppConnections {
  readonly queryClient: QueryClient;
  /** Null when the app runs without a backend (unconfigured/misconfigured). */
  readonly convexQueryClient: ConvexQueryClient | null;
}

/**
 * Creates the client stack for one application instance. Call exactly once
 * from the bootstrap entry; the Convex client is never created without a
 * validated URL.
 */
export function createAppConnections(config: AppConfig): AppConnections {
  if (config.connection.state !== "configured") {
    return { queryClient: new QueryClient(), convexQueryClient: null };
  }
  const convexQueryClient = new ConvexQueryClient(config.connection.convexUrl);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
        // Convex queries are live subscriptions (A3 proof V8: reactive
        // push, no invalidation), so they never go stale between pushes.
        staleTime: Infinity,
      },
    },
  });
  convexQueryClient.connect(queryClient);
  return { queryClient, convexQueryClient };
}
