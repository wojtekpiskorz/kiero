/**
 * Convex HTTP actions composition entry (A3; telemetry routes appended by
 * I2, Calendar OAuth routes by G1).
 *
 * Convex serves the default export of the `http` module as the deployment's
 * HTTP router. Route handlers live in their owning lane files; this entry
 * only wires them (later lanes append their own route imports here, the
 * same composition pattern as `convex/schema.ts`).
 *
 * B1 addition: the Convex Auth HTTP routes (JWKS discovery, OAuth
 * sign-in/callback) come from the configured auth entry
 * (convex/access/identity/authEntry.ts) via `auth.addHttpRoutes`.
 *
 * G1 addition: the Calendar OAuth boundary (authorization start, callback,
 * bridge completion, guarded proof fixtures) from
 * convex/calendar/connection/http.ts.
 */

import { httpRouter } from "convex/server";
import { bridgeHandler, echoHandler, healthHandler } from "./platform/http";
import { auth } from "./auth";
import {
  heartbeatHandler,
  ingestHandler,
  telemetryHealthHandler,
} from "./operations/telemetry/http";
import {
  calendarStartHandler,
  calendarCallbackHandler,
  calendarCallbackCompleteHandler,
  proofFakeTokenEndpoint,
  proofFakeCalendarCreate,
  proofFakeCalendarRead,
  proofRefreshHandler,
  proofStateHandler,
} from "./calendar/connection/http";

const http = httpRouter();

auth.addHttpRoutes(http);
http.route({ path: "/platform/bridge", method: "POST", handler: bridgeHandler });
http.route({ path: "/platform/echo", method: "POST", handler: echoHandler });
http.route({ path: "/platform/health", method: "GET", handler: healthHandler });
http.route({ path: "/platform/telemetry/ingest", method: "POST", handler: ingestHandler });
http.route({ path: "/platform/telemetry/heartbeat", method: "POST", handler: heartbeatHandler });
http.route({ path: "/platform/telemetry/health", method: "GET", handler: telemetryHealthHandler });
http.route({ path: "/calendar/oauth/start", method: "POST", handler: calendarStartHandler });
http.route({ path: "/calendar/oauth/callback", method: "GET", handler: calendarCallbackHandler });
http.route({
  path: "/calendar/oauth/callback/complete",
  method: "POST",
  handler: calendarCallbackCompleteHandler,
});
http.route({
  path: "/calendar/oauth/proof/fake-google/token",
  method: "POST",
  handler: proofFakeTokenEndpoint,
});
http.route({
  path: "/calendar/oauth/proof/fake-google/api/calendars",
  method: "POST",
  handler: proofFakeCalendarCreate,
});
http.route({
  path: "/calendar/oauth/proof/fake-google/api/calendars/kiero-proof-calendar",
  method: "GET",
  handler: proofFakeCalendarRead,
});
http.route({ path: "/calendar/oauth/proof/refresh", method: "POST", handler: proofRefreshHandler });
http.route({ path: "/calendar/oauth/proof/state", method: "POST", handler: proofStateHandler });

export default http;
