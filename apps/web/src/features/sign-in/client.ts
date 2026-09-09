/**
 * Convex client wiring for the sign-in feature.
 *
 * Reads the deployment URL from the client-safe VITE_CONVEX_URL variable
 * (never a secret; see .env.example) and builds the ConvexReactClient the
 * ConvexAuthProvider wraps. Server-only credentials never enter this
 * module.
 */

import { ConvexReactClient } from "convex/react";

export function createConvexClient(url: string | undefined): ConvexReactClient {
  if (url === undefined || url.length === 0) {
    throw new Error(
      "Brak adresu backendu Kiero (VITE_CONVEX_URL). Uruchom `npx convex dev` lub ustaw zmienną.",
    );
  }
  return new ConvexReactClient(url);
}
