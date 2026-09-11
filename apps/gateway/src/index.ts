/**
 * @kiero/gateway: the Cloudflare Worker entry (A3; telemetry wiring by I2;
 * uploads lane routing by D2; images lane routing by D5).

 * uploads lane routing by D2; media read routing by D3).
 *
 * Routes resolve through the composition registry
 * (`./composition/registry.ts`); the platform lane's routes live in
 * `./platform/routes.ts`, the uploads lane's in `./uploads/routes.ts`, the
 * images lane's in `./images/routes.ts`, and all call Convex through their
 * verified bridges. Unknown paths, including unmatched `/platform/*`,
 * `/uploads/*` and `/images/*` paths, answer with the sanitized

 * media lane's in `./media/routes.ts`, and all call Convex through their
 * verified bridges. Unknown paths, including unmatched `/platform/*`,
 * `/uploads/*` and `/media/*` paths, answer with the sanitized
 * `unsupported` closed error, never a fake success.
 *
 * Every request is wrapped in request-scoped redacted telemetry
 * (`./telemetry/emit.ts`, the GW -> OBS flow) and the cron trigger makes the
 * Worker the external heartbeat prober (`./telemetry/scheduled.ts`).
 */

import { matchRoute } from "./composition/registry";
import { unsupportedRoute } from "./platform/routes";
import { withGatewayTelemetry } from "./telemetry/emit";
import { telemetryScheduled } from "./telemetry/scheduled";
import type { BridgeEnv } from "./platform/bridge";
import type { UploadsEnv } from "./uploads/r2";
import type { MediaEnv } from "./media/r2";
import type { TelemetryEnv } from "./telemetry/emit";
import type { NormalizerEnv } from "./images/normalizer";

/**
 * D4 append (minimal, flagged to the coordinator): browser CORS for the
 * upload channel. D4's composer is the FIRST cross-origin consumer of the
 * gateway (D2's proofs drove the Worker from node, where CORS does not
 * apply): the browser's part/complete/finalize fetches carry Authorization
 * and non-simple content types, so every request preflights.
 *
 * The policy is deliberately closed by default: CORS headers are emitted
 * ONLY when the request's Origin is listed in the ALLOWED_APP_ORIGINS
 * worker var (comma-separated full origins; set per deployment, e.g.
 * http://localhost:5173 for dev). Without the var the gateway behaves
 * exactly as before (no headers, browsers refuse) — no open reflector.
 */
interface CorsEnv {
  readonly ALLOWED_APP_ORIGINS?: string;
}

/** The Worker bindings the gateway routes consume (see platform/bridge.ts). */
export type Env = BridgeEnv & TelemetryEnv & UploadsEnv & MediaEnv & NormalizerEnv & CorsEnv;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) {
    return {};
  }
  const configured = env.ALLOWED_APP_ORIGINS ?? "";
  const allowed = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!allowed.includes(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  };
}

function withCors(response: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) {
    return response;
  }
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Telemetry is scheduled through ctx.waitUntil: never on the critical path.
    return withGatewayTelemetry(env, ctx, url.pathname, async () => {
      const cors = corsHeaders(request, env);
      if (
        request.method === "OPTIONS" &&
        (url.pathname.startsWith("/uploads/") ||
          url.pathname.startsWith("/media/") ||
          url.pathname.startsWith("/images/") ||
          url.pathname.startsWith("/exports/"))
      ) {
        // Preflight: answered without touching any route or Convex/R2.
        return withCors(new Response(null, { status: 204 }), cors);
      }
      if (
        url.pathname.startsWith("/platform/") ||
        url.pathname.startsWith("/uploads/") ||
        url.pathname.startsWith("/images/") ||
        url.pathname.startsWith("/media/") ||
        // I3 append (flagged, the D3 precedent): the export download route.
        url.pathname.startsWith("/exports/")
      ) {
        const route = matchRoute(request.method, url.pathname);
        if (route === undefined) {
          return withCors(unsupportedRoute(url.pathname), cors);
        }
        return withCors(await route.handle(request, env), cors);
      }

      return new Response(
        JSON.stringify({
          _tag: "error",
          error: {
            _tag: "unsupported",
            code: "no_such_route",
            message: "Ta operacja nie jest jeszcze dostępna.",
            operation: url.pathname,
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });
  },
  scheduled: telemetryScheduled,
} satisfies ExportedHandler<Env>;
