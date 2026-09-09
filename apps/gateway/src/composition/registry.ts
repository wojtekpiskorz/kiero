/**
 * Gateway composition registry (A3; uploads provider appended by D2).
 *
 * The single place route providers and executor registrations compose, so
 * parallel lanes add their own provider files here (imports only) without
 * editing shared handler code:
 *
 * - `routeProviders`: each provider owns its routes and, when it has
 *   parameterized paths, its own `match` for them; the platform lane's
 *   provider and the D2 uploads lane's provider are imported below.
 *   `matchRoute` stays generic: exact match over all providers' route
 *   tables first, then each provider's optional `match`. D3's range reads
 *   become the next provider using this seam.
 * - `schedulerConsumers`: what this Worker consumes from durable execution
 *   (the Convex-side executors own the work; the gateway currently hosts
 *   none; media/export/backup executors join in later lanes and are the
 *   first consumers of this seam).
 */

import { platformRoutes, type GatewayRoute } from "../platform/routes";
import { uploadsRouteProvider } from "../uploads/routes";

/** One lane's route provider. */
export interface RouteProvider {
  readonly providerId: string;
  readonly routes: readonly GatewayRoute[];
  /**
   * Optional matching for this provider's parameterized paths, consulted
   * after exact matching. Returning a `GatewayRoute` with the captured
   * parameters closed over the handler keeps the shared route type
   * untouched while the provider owns its own path grammar.
   */
  readonly match?: (method: string, path: string) => GatewayRoute | undefined;
}

/** Route providers registered so far (imports are the only edit point). */
export const routeProviders: readonly RouteProvider[] = [
  { providerId: "platform", routes: platformRoutes },
  uploadsRouteProvider,
];

/**
 * Durable executors and scheduler consumers this Worker hosts, exposed for
 * health/diagnostics. Names come from the A2/A3 registry vocabulary; the
 * Convex-side executor table (`convex/platform/executors.ts`) is the
 * authority; this list only reports what runs HERE.
 */
export const schedulerConsumers: readonly string[] = [];

/** All registered routes, flattened in registration order. */
export function registeredRoutes(): readonly GatewayRoute[] {
  return routeProviders.flatMap((provider) => provider.routes);
}

/** Finds the registered route matching a method/path pair. */
export function matchRoute(
  method: string,
  path: string,
): GatewayRoute | undefined {
  const exact = registeredRoutes().find(
    (route) => route.method === method && route.path === path,
  );
  if (exact !== undefined) {
    return exact;
  }
  for (const provider of routeProviders) {
    const matched = provider.match?.(method, path);
    if (matched !== undefined) {
      return matched;
    }
  }
  return undefined;
}
