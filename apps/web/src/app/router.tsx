/**
 * Host router composition (A4).
 *
 * The route tree is derived from the composed feature registry: one
 * root-level route per entry, the first entry ("/", the company
 * conversation) being the default. Unknown paths and render failures get
 * explicit Polish screens with a working control back to the default
 * route — no raw error text crosses the boundary.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { AppShell } from "./app-shell";
import { appFeatures } from "./app-features";

/** Plain not-found screen for drifted URLs. */
function NotFoundScreen() {
  return (
    <section>
      <h1>Nie ma takiej strony</h1>
      <p>
        <Link to="/">Wróć do rozmowy firmy</Link>
      </p>
    </section>
  );
}

/** Plain error screen; the exception detail is deliberately not shown. */
function ErrorScreen({ reset }: ErrorComponentProps) {
  return (
    <section>
      <h1>Coś się nie udało</h1>
      <p>Wyświetlenie tej strony nie udało się. Spróbuj ponownie.</p>
      <button type="button" onClick={reset}>
        Spróbuj ponownie
      </button>
    </section>
  );
}

/** Builds the application router from the composed feature registry. */
export function createAppRouter() {
  const rootRoute = createRootRoute({ component: AppShell });
  const featureRoutes = appFeatures.map((feature) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: feature.routePath,
      component: feature.screen,
    }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(featureRoutes),
    defaultNotFoundComponent: NotFoundScreen,
    defaultErrorComponent: ErrorScreen,
  });
}
