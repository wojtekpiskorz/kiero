/**
 * @kiero/gateway: the Cloudflare Worker entry (A3; telemetry wiring by I2).
 *
 * Routes resolve through the composition registry
 * (`./composition/registry.ts`); the platform lane's routes live in
 * `./platform/routes.ts` and call Convex through the verified bridge
 * (`./platform/bridge.ts`). Unknown paths, including unmatched
 * `/platform/*` paths, answer with the sanitized `unsupported` closed
 * error, never a fake success.
 *
 * Every request is wrapped in request-scoped redacted telemetry
 * (`./telemetry/emit.ts`, the GW -> OBS flow) and the cron trigger makes the
 * Worker the external heartbeat prober (`./telemetry/scheduled.ts`).
 */

import { matchRoute } from "./composition/registry";
import { unsupportedPlatformRoute } from "./platform/routes";
import { withGatewayTelemetry } from "./telemetry/emit";
import { telemetryScheduled } from "./telemetry/scheduled";
import type { BridgeEnv } from "./platform/bridge";
import type { TelemetryEnv } from "./telemetry/emit";

/** The Worker bindings the gateway routes consume (see platform/bridge.ts). */
export type Env = BridgeEnv & TelemetryEnv;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return withGatewayTelemetry(env, url.pathname, async () => {
      if (url.pathname.startsWith("/platform/")) {
        const route = matchRoute(request.method, url.pathname);
        if (route === undefined) {
          return unsupportedPlatformRoute(url.pathname);
        }
        return route.handle(request, env);
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
