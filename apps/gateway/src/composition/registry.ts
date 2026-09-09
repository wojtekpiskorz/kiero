/**
 * Gateway composition registry (A3; Calendar OAuth provider appended by G1).
 *
 * The single place route providers and executor registrations compose, so
 * parallel lanes add their own provider files here (imports only) without
 * editing shared handler code:
 *
 * - `routeProviders`: each provider owns its routes; the platform lane's
 *   provider is imported below, the Calendar OAuth lane's (G1) after it.
 * - `schedulerConsumers`: what this Worker consumes from durable execution
 *   (the Convex-side executors own the work; the gateway currently hosts
 *   none; media/export/backup executors join in later lanes and are the
 *   first consumers of this seam).
 */

import { platformRoutes, type GatewayRoute } from "../platform/routes";
import { calendarOAuthProvider } from "../calendar-oauth/routes";

/** One lane's route provider. */
export interface RouteProvider {
  readonly providerId: string;
  readonly routes: readonly GatewayRoute[];
}

/** Route providers registered so far (imports are the only edit point). */
export const routeProviders: readonly RouteProvider[] = [
  { providerId: "platform", routes: platformRoutes },
  calendarOAuthProvider,
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
  return registeredRoutes().find(
    (route) => route.method === method && route.path === path,
  );
}
