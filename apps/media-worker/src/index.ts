/**
 * @kiero/media-worker: the EU media Container executor entry (D6).
 *
 * What exists here (bounded, honest):
 * - the segment protocol over the S3-credential R2 reader
 *   (HEAD + ranged GET only; see ./s3r2.ts, ./segment-service.ts);
 * - a bearer-guarded HTTP surface (`/healthz`, `/probe`, `/segment`) that
 *   Convex's workflow actions call;
 * - `MediaWorkerContainer`: the Durable Object class the wrangler container
 *   config names (`class_name`). The DO is Cloudflare's container proxy:
 *   requests addressed to this app arrive through it once the container
 *   runtime is enabled. The fetch handler below serves the protocol either
 *   way.
 *
 * What honestly does NOT exist yet (owner actions, recorded in the D6
 * evidence as BLOCKED):
 * - the Containers runtime itself (Workers Paid enablement) — `wrangler
 *   deploy` of this app refuses until then;
 * - the media-bucket S3 API token (dashboard-issued) — until the values are
 *   injected, every byte operation answers `not_configured`, never a fake
 *   success;
 * - FFmpeg conversion of non-WAV containers — PCM WAV slicing is exact and
 *   served here; anything else answers `format_requires_container`.
 */

import { Container } from "@cloudflare/containers";
import { serveSegmentRequest } from "./segment-service.ts";
import { s3ObjectReader } from "./s3r2.ts";

/** The env the deployed Worker/container receives (names only, no values). */
export interface MediaWorkerEnv {
  readonly ENVIRONMENT?: string;
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly MEDIA_SEGMENT_TOKEN?: string;
  readonly R2_MEDIA_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_SECRET_ACCESS_KEY?: string;
}

/** Constant-time-ish bearer comparison (length leak is acceptable here). */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The protocol handler shared by the Worker fetch entry and the container. */
export async function handleMediaRequest(
  request: Request,
  env: MediaWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({
      ok: true,
      environment: env.ENVIRONMENT ?? "unknown",
      bytes: "s3-credentials",
      wavSlicing: "exact",
      ffmpegConversion: "container-pending",
    }, 200);
  }
  if (request.method !== "POST" || (url.pathname !== "/probe" && url.pathname !== "/segment")) {
    return json({ ok: false, code: "unknown_route" }, 404);
  }
  const expected = env.MEDIA_SEGMENT_TOKEN ?? "";
  if (expected === "") {
    return json({ ok: false, code: "segment_token_not_configured" }, 503);
  }
  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenMatches(expected, presented)) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }
  const reader = s3ObjectReader(env);
  if (!reader.ok) {
    return json({ ok: false, code: reader.code }, 503);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const response = await serveSegmentRequest(reader.read, body);
  const status = response.ok ? 200 : response.code === "object_not_found" ? 404 : 422;
  return json(response, status);
}

// --- Cloudflare Worker entry -------------------------------------------------

/** The env additions the container routing needs (the DO binding). */
export interface MediaWorkerRoutingEnv extends MediaWorkerEnv {
  readonly MEDIA_WORKER: DurableObjectNamespace<MediaWorkerContainer>;
}

export default {
  async fetch(request: Request, env: MediaWorkerRoutingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Health stays in the Worker: cheap, no container wake-up.
      return handleMediaRequest(request, env);
    }
    // Everything else routes through the container's Durable Object, which
    // proxies to the EU container instance (same protocol code inside).
    const stub = env.MEDIA_WORKER.get(env.MEDIA_WORKER.idFromName("media"));
    return stub.fetch(request);
  },
};

/**
 * The container's Durable Object class (named by `containers[].class_name`
 * in wrangler.jsonc; bound as MEDIA_WORKER). Extending the framework
 * `Container` base gives the lifecycle and port-forwarding behavior; the
 * inherited `fetch` proxies requests to the container instance, which runs
 * the SAME protocol code (src/container-main.ts) inside the EU container.
 */
export class MediaWorkerContainer extends Container<MediaWorkerEnv> {
  override defaultPort = 8080;
  override sleepAfter = "2m";

  /**
   * Container processes do NOT inherit Worker secrets or vars: the base
   * class injects exactly this map into the container instance env. The
   * media S3 credentials and the segment bearer token arrive as Worker
   * secrets (wrangler secret put) and are forwarded here by NAME — values
   * never live in the repo.
   */
  override envVars = {
    ENVIRONMENT: this.env.ENVIRONMENT ?? "",
    R2_MEDIA_ENDPOINT: this.env.R2_MEDIA_ENDPOINT ?? "",
    R2_MEDIA_BUCKET: this.env.R2_MEDIA_BUCKET ?? "",
    ...(this.env.MEDIA_SEGMENT_TOKEN === undefined
      ? {}
      : { MEDIA_SEGMENT_TOKEN: this.env.MEDIA_SEGMENT_TOKEN }),
    ...(this.env.R2_MEDIA_ACCESS_KEY_ID === undefined
      ? {}
      : { R2_MEDIA_ACCESS_KEY_ID: this.env.R2_MEDIA_ACCESS_KEY_ID }),
    ...(this.env.R2_MEDIA_SECRET_ACCESS_KEY === undefined
      ? {}
      : { R2_MEDIA_SECRET_ACCESS_KEY: this.env.R2_MEDIA_SECRET_ACCESS_KEY }),
  };
}
