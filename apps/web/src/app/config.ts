/**
 * Typed client configuration seam (A4).
 *
 * The client has NO secrets by construction (AGENTS.md): only `VITE_*`
 * names ever reach the bundle. The names defined today are
 * `VITE_CONVEX_URL` and — for the media surfaces — the optional
 * `VITE_GATEWAY_URL` (see the root `.env.example`). This module is the one
 * place that reads the environment, so every component downstream gets a
 * validated connection state instead of probing `import.meta.env`
 * on its own.
 *
 * A missing or invalid URL is a legitimate state, not an error: the host
 * runs without a backend and says so ("nie połączono") instead of faking a
 * connection.
 */

/** How the client reaches the Convex deployment, if at all. */
export type ConnectionConfig =
  | { readonly state: "configured"; readonly convexUrl: string }
  | { readonly state: "unconfigured" }
  | {
      readonly state: "misconfigured";
      /** Safe-to-show Polish explanation; never the raw value. */
      readonly problem: string;
    };

/**
 * The media-gateway connection (H3 append, flagged on the same seam): how
 * the client reaches the Cloudflare Worker that serves authorized media
 * reads (D3's `/media/*` routes). Optional by design — a backend without
 * a gateway keeps every non-media surface working, and media surfaces say
 * so honestly instead of guessing a URL.
 */
export type GatewayConfig =
  | { readonly state: "configured"; readonly gatewayUrl: string }
  | { readonly state: "unconfigured" };

/** The whole client-side application configuration. */
export interface AppConfig {
  readonly connection: ConnectionConfig;
  readonly gateway: GatewayConfig;
}

/**
 * Minimal env shape this seam reads; `import.meta.env` (whose known keys
 * carry no overlap with ours by default) satisfies the index signature.
 */
export interface AppEnvSource {
  readonly [key: string]: unknown;
  readonly VITE_CONVEX_URL?: unknown;
  readonly VITE_GATEWAY_URL?: unknown;
}

/**
 * Accepts only http(s) URLs and normalizes the trailing slash, matching
 * what `ConvexReactClient` expects. Returns null for anything else.
 */
function parseBackendUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return url.toString().replace(/\/+$/, "");
}

/** Reads the environment once and produces the typed application config. */
export function loadAppConfig(env: AppEnvSource): AppConfig {
  const gatewayRaw = typeof env.VITE_GATEWAY_URL === "string" ? env.VITE_GATEWAY_URL.trim() : "";
  const gatewayUrl = gatewayRaw === "" ? null : parseBackendUrl(gatewayRaw);
  const gateway: GatewayConfig =
    gatewayUrl === null
      ? { state: "unconfigured" }
      : { state: "configured", gatewayUrl };
  const raw = typeof env.VITE_CONVEX_URL === "string" ? env.VITE_CONVEX_URL.trim() : "";
  if (raw === "") {
    return { connection: { state: "unconfigured" }, gateway };
  }
  const convexUrl = parseBackendUrl(raw);
  if (convexUrl === null) {
    return {
      connection: {
        state: "misconfigured",
        problem: "nieprawidłowy adres backendu (VITE_CONVEX_URL)",
      },
      gateway,
    };
  }
  return { connection: { state: "configured", convexUrl }, gateway };
}
