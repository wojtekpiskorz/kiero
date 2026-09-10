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

/** The Worker bindings the gateway routes consume (see platform/bridge.ts). */
export type Env = BridgeEnv & TelemetryEnv & UploadsEnv & MediaEnv & NormalizerEnv;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Telemetry is scheduled through ctx.waitUntil: never on the critical path.
    return withGatewayTelemetry(env, ctx, url.pathname, async () => {
      if (
        url.pathname.startsWith("/platform/") ||
        url.pathname.startsWith("/uploads/") ||
        url.pathname.startsWith("/images/") ||
        url.pathname.startsWith("/media/")
      ) {
        const route = matchRoute(request.method, url.pathname);
        if (route === undefined) {
          return unsupportedRoute(url.pathname);
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
