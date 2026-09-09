/**
 * Convex HTTP actions composition entry (A3).
 *
 * Convex serves the default export of the `http` module as the deployment's
 * HTTP router. Route handlers live in their owning lane files; this entry
 * only wires them (later lanes append their own route imports here, the
 * same composition pattern as `convex/schema.ts`).
 *
 * B1 addition: the Convex Auth HTTP routes (JWKS discovery, OAuth
 * sign-in/callback) come from the configured auth entry
 * (convex/access/identity/authEntry.ts) via `auth.addHttpRoutes`.
 */

import { httpRouter } from "convex/server";
import { bridgeHandler, echoHandler, healthHandler } from "./platform/http";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);
http.route({ path: "/platform/bridge", method: "POST", handler: bridgeHandler });
http.route({ path: "/platform/echo", method: "POST", handler: echoHandler });
http.route({ path: "/platform/health", method: "GET", handler: healthHandler });

export default http;
