/**
 * Convex HTTP actions composition entry (A3; telemetry routes appended by
 * I2; sources/uploads routes appended by D2).
 *
 * Convex serves the default export of the `http` module as the deployment's
 * HTTP router. Route handlers live in their owning lane files; this entry
 * only wires them (later lanes append their own route imports here, the
 * same composition pattern as `convex/schema.ts`).
 */

import { httpRouter } from "convex/server";
import { bridgeHandler, echoHandler, healthHandler } from "./platform/http";
import {
  heartbeatHandler,
  ingestHandler,
  telemetryHealthHandler,
} from "./operations/telemetry/http";
import { uploadsBridgeHandler, uploadsStateHandler } from "./sources/uploads/http";

const http = httpRouter();

http.route({ path: "/platform/bridge", method: "POST", handler: bridgeHandler });
http.route({ path: "/platform/echo", method: "POST", handler: echoHandler });
http.route({ path: "/platform/health", method: "GET", handler: healthHandler });
http.route({ path: "/platform/telemetry/ingest", method: "POST", handler: ingestHandler });
http.route({ path: "/platform/telemetry/heartbeat", method: "POST", handler: heartbeatHandler });
http.route({ path: "/platform/telemetry/health", method: "GET", handler: telemetryHealthHandler });
http.route({ path: "/sources/uploads/bridge", method: "POST", handler: uploadsBridgeHandler });
http.route({ path: "/sources/uploads/state", method: "POST", handler: uploadsStateHandler });

export default http;
