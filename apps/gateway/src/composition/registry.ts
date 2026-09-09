/**
 * Gateway composition registry (A3; uploads provider appended by D2).
 *
 * The single place route providers and executor registrations compose, so
 * parallel lanes add their own provider files here (imports only) without
 * editing shared handler code:
 *
 * - `routeProviders`: each provider owns its routes; the platform lane's
 *   provider and the D2 uploads lane's static routes are imported below.
 *   The uploads lane's parameterized routes register through
 *   `matchUploadsRoute` (captured-parameter handlers that are structurally
 *   `GatewayRoute`), so exact matching and the shared route type stay
 *   unchanged.
 * - `schedulerConsumers`: what this Worker consumes from durable execution
 *   (the Convex-side executors own the work; the gateway currently hosts
 *   none; media/export/backup executors join in later lanes and are the
 *   first consumers of this seam).
 */

import { platformRoutes, type GatewayRoute } from "../platform/routes";
import { matchUploadsRoute, uploadsStaticRoutes } from "../uploads/routes";

/** One lane's route provider. */
export interface RouteProvider {
  readonly providerId: string;
  readonly routes: readonly GatewayRoute[];
}

/** Route providers registered so far (imports are the only edit point). */
export const routeProviders: readonly RouteProvider[] = [
  { providerId: "platform", routes: platformRoutes },
  { providerId: "uploads", routes: uploadsStaticRoutes },
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
  // Parameterized uploads routes (D2): captured-parameter handlers that are
  // structurally GatewayRoute, so this signature and its callers are intact.
  return matchUploadsRoute(method, path);
}
