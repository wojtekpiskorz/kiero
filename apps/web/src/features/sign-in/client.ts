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
    // Developer-facing configuration error: English per the AGENTS.md
    // language rule (Polish is reserved for product copy).
    throw new Error(
      "Missing VITE_CONVEX_URL: run `npx convex dev` or set the variable before starting the web app.",
    );
  }
  return new ConvexReactClient(url);
}
