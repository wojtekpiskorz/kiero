/**
 * Connection and platform health status (A4).
 *
 * The health indicator reads the platform health surface
 * (`platform/health`, the A3 live subscription target) through the Convex
 * React-Query adapter: the canonical `convexQuery` key, hashed and fetched
 * by the QueryClient defaults wired in `connections.ts`. Without a
 * configured backend nothing subscribes and the status stays "nie
 * połączono". Connection failures render fixed Polish copy and never
 * the raw transport error.
 */

import { useQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { useAppServices } from "./providers";

/** The platform health snapshot type, derived from the generated api. */
type HealthSnapshot = FunctionReturnType<typeof api.platform.health.health>;

/** The live health read; runs only when the adapter is wired. */
function PlatformHealthStatus() {
  const options = convexQuery(api.platform.health.health, {});
  const health = useQuery<HealthSnapshot>({ queryKey: options.queryKey });
  if (health.isPending) {
    return <p>Łączenie z backendem…</p>;
  }
  if (health.isError) {
    return <p>Nie połączono z backendem.</p>;
  }
  return <p>Połączono z backendem. Wersja rdzenia: {health.data.runtimeVersion}.</p>;
}

/** The plain status line for the chrome's status/error area. */
export function ConnectionStatus() {
  const { config } = useAppServices();
  switch (config.connection.state) {
    case "unconfigured":
      return <p>Nie połączono z backendem — brak adresu (VITE_CONVEX_URL).</p>;
    case "misconfigured":
      return <p>Nie połączono z backendem — {config.connection.problem}.</p>;
    case "configured":
      return <PlatformHealthStatus />;
  }
}
