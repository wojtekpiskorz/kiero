/**
 * @kiero/gateway: the Cloudflare Worker entry (A3).
 *
 * Routes resolve through the composition registry
 * (`./composition/registry.ts`); the platform lane's routes live in
 * `./platform/routes.ts` and call Convex through the verified bridge
 * (`./platform/bridge.ts`). Unknown paths — including unmatched
 * `/platform/*` paths — answer with the sanitized `unsupported` closed
 * error, never a fake success.
 */

import { gatewayRegistry, matchRoute } from "./composition/registry";
import { unsupportedPlatformRoute } from "./platform/routes";

export interface Env {
  /**
   * Non-secret URL of the Convex deployment's HTTP actions (set per
   * environment in wrangler.jsonc).
   */
  CONVEX_SITE_URL?: string;
  /** Service credential for the Convex bridge (secret binding). */
  KIERO_SERVICE_TOKEN?: string;
}

void gatewayRegistry;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
  },
} satisfies ExportedHandler<Env>;
