/**
 * @kiero/media-worker: the EU media Container executor entry (D6).
 *
 * This file is deliberately THIN: the entire protocol — bearer guard, the
 * S3-credential reader construction, ranged byte discipline and the status
 * map — lives once in ./segment-service.ts (`handleMediaProtocol`). The
 * Worker fetch entry and the container's Durable Object both call exactly
 * that handler, and the container image (./container-main.ts) calls the
 * same one: three surfaces, one boundary, no drift.
 *
 * - `/healthz` is answered in the Worker (no container wake-up); everything
 *   else routes through the DO to the EU container instance.
 * - `MediaWorkerContainer` extends the framework `Container` base (lifecycle
 *   + port forwarding) and injects the Worker's secret names into the
 *   container process env — values never live in the repo.
 *
 * Deploy state (observed live by D6): the container builds, deploys and
 * serves on the current account — no Workers-Paid blocker exists. What
 * honestly does NOT exist yet:
 * - the media-bucket S3 API token (dashboard-issued) — until the values are
 *   injected, every byte operation answers the typed `not_configured`
 *   refusal, never a fake success;
 * - FFmpeg conversion of non-WAV containers — PCM WAV slicing is exact and
 *   served here; anything else answers `format_requires_container`.
 */

import { Container } from "@cloudflare/containers";
import { handleMediaProtocol, type MediaWorkerEnv } from "./segment-service.ts";

/** The env additions the container routing needs (the DO binding). */
export interface MediaWorkerRoutingEnv extends MediaWorkerEnv {
  readonly MEDIA_WORKER: DurableObjectNamespace<MediaWorkerContainer>;
}

export default {
  async fetch(request: Request, env: MediaWorkerRoutingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Health stays in the Worker: cheap, no container wake-up, same
      // shared handler as every other surface.
      return handleMediaProtocol(request, env);
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
 * the SAME protocol (src/container-main.ts) inside the EU container.
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
