/**
 * The backend version handshake (I7): how a running client learns whether
 * the deployment it talks to still supports it.
 *
 * The source is the deployment's PUBLIC health endpoint
 * (GET /platform/health, A3/I2 surface): it answers the envelope
 * { value: { runtimeVersion, ... } }. The client compares that against
 * the runtime version THIS build was certified with.
 *
 * The rule is deliberately conservative and boring: a server on the SAME
 * major runtime means the client stays supported (older, equal or newer
 * minor all fine); a server on a NEWER MAJOR means this client build may
 * face breaking protocol changes, so it must ask for an update. When a
 * deployment later wants a finer window, tools/migrations/policy.ts is
 * the one definition to extend (decideClientSupport); this module only
 * feeds it.
 *
 * DOM-free and fetch-optional (structural), so node-side tests import it.
 */

import {
  parseReleaseVersion,
} from "../../../../../tools/migrations/policy.ts";

/**
 * The runtime version this client build was certified against. Mirrors
 * @kiero/runtime's RUNTIME_VERSION; tests/i7 fail when the two drift, so
 * a runtime bump without rebuilding the client cannot pass silently.
 */
export const CLIENT_EXPECTED_RUNTIME_VERSION = "a3.0";

/** The minimal source surface the handshake needs. */
export interface VersionInfoSource {
  /** The deployment's advertised runtime version (null when unreadable). */
  readRuntimeVersion(): Promise<string | null>;
}

/** What the handshake concluded for this client against this deployment. */
export type RuntimeHandshake =
  | { readonly status: "unavailable" }
  | { readonly status: "supported" }
  | { readonly status: "unsupported" };

/**
 * Derives the HTTP-actions (site) URL from the websocket (cloud) URL:
 * `https://<slug>.<region>.convex.cloud` -> `...convex.site`. Returns
 * null for anything that is not a convex.cloud origin.
 */
export function convexSiteUrlFromCloudUrl(cloudUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(cloudUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.endsWith(".convex.cloud")) {
    return `https://${parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site")}`;
  }
  return null;
}

/** Isomorphic response-ish reader over one health body. */
function runtimeVersionFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const envelope = body as { value?: unknown };
  if (typeof envelope.value !== "object" || envelope.value === null) {
    return null;
  }
  const version = (envelope.value as { runtimeVersion?: unknown }).runtimeVersion;
  return typeof version === "string" ? version : null;
}

/**
 * The production source: fetches GET `<siteUrl>/platform/health` and
 * reads the envelope's runtimeVersion. Failures answer null (the
 * handshake then reports "unavailable"; it never guesses).
 */
export function fetchHealthVersionSource(siteUrl: string): VersionInfoSource {
  return {
    async readRuntimeVersion() {
      try {
        const response = await fetch(`${siteUrl}/platform/health`, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          return null;
        }
        return runtimeVersionFromBody(await response.json());
      } catch {
        return null;
      }
    },
  };
}

/**
 * Runtime versions carry one leading generation letter ("a3.0" = alpha
 * generation 3.0); the release-version parser is deliberately strict
 * (dotted numerics only), so this seam strips the marker before parsing.
 * Returns null when nothing parseable remains.
 */
export function normalizeRuntimeVersion(value: string): string | null {
  const match = /^([a-z])(\d.*)$/i.exec(value.trim());
  const candidate = match?.[2] ?? value.trim();
  return parseReleaseVersion(candidate) === null ? null : candidate;
}

/**
 * Decides the handshake. Unparseable server versions are "supported"
 * never: they answer "unavailable" (the client does not invent support);
 * an unparseable CLIENT expectation is a build defect and throws.
 */
export function decideRuntimeHandshake(
  clientExpectedRuntime: string,
  serverRuntimeVersion: string | null,
): RuntimeHandshake {
  const client = parseReleaseVersion(normalizeRuntimeVersion(clientExpectedRuntime) ?? "");
  if (client === null) {
    throw new Error(
      `update handshake: client runtime "${clientExpectedRuntime}" is not a version`,
    );
  }
  if (serverRuntimeVersion === null) {
    return { status: "unavailable" };
  }
  const server = parseReleaseVersion(normalizeRuntimeVersion(serverRuntimeVersion) ?? "");
  if (server === null) {
    return { status: "unavailable" };
  }
  if (server.major > client.major) {
    return { status: "unsupported" };
  }
  return { status: "supported" };
}
