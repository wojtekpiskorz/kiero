/**
 * @kiero/export-worker: the EU export Container executor entry (I3).
 *
 * Thin by design (the D6 media-worker discipline): the whole protocol —
 * the service bearer guard, the Convex build-channel client, the streaming
 * ZIP assembly and the cleanup route — lives once in ./service.ts
 * (`handleBuild`, `handleCleanup`, `handleHealth`). Three surfaces, one
 * boundary, no drift:
 *
 * - the Worker fetch entry answers /healthz itself and routes everything
 *   else through the Durable Object to the EU container instance;
 * - the container process (./container-main.ts) runs the SAME handlers
 *   inside the EU container with the S3 media token in its runtime env;
 * - tests and the guarded proof drive the handler functions directly.
 *
 * The environment contract (I1, infra/bindings/media-export-workers.md):
 * this worker holds NO R2 binding and NO backup-bucket credentials — the
 * bucket is addressed via the media S3 token only (R2_MEDIA_*), forwarded
 * into the container env by NAME; values never live in the repo.
 */

import { Container } from "@cloudflare/containers";
import { handleHealth, type ExportWorkerEnv } from "./service.ts";

/** The env additions the container routing needs (the DO binding). */
export interface ExportWorkerRoutingEnv extends ExportWorkerEnv {
  readonly EXPORT_WORKER: DurableObjectNamespace<ExportWorkerContainer>;
}

export default {
  async fetch(request: Request, env: ExportWorkerRoutingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Health stays in the Worker: cheap, no container wake-up.
      return handleHealth(env);
    }
    // Everything else routes through the container's Durable Object, which
    // proxies to the EU container instance (same protocol code inside).
    const stub = env.EXPORT_WORKER.get(env.EXPORT_WORKER.idFromName("exports"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<ExportWorkerRoutingEnv>;

/**
 * The container's Durable Object class (named by `containers[].class_name`
 * in wrangler.jsonc; bound as EXPORT_WORKER). The framework `Container`
 * base provides lifecycle and port-forwarding; container processes do NOT
 * inherit Worker secrets or vars, so exactly this map is injected — the
 * media S3 credentials and the service token arrive as Worker secrets
 * (wrangler secret put) and are forwarded here by NAME.
 */
export class ExportWorkerContainer extends Container<ExportWorkerEnv> {
  override defaultPort = 8080;
  override sleepAfter = "2m";
  override envVars = {
    ENVIRONMENT: this.env.ENVIRONMENT ?? "",
    R2_MEDIA_ENDPOINT: this.env.R2_MEDIA_ENDPOINT ?? "",
    R2_MEDIA_BUCKET: this.env.R2_MEDIA_BUCKET ?? "",
    CONVEX_SITE_URL: this.env.CONVEX_SITE_URL ?? "",
    ...(this.env.KIERO_SERVICE_TOKEN === undefined
      ? {}
      : { KIERO_SERVICE_TOKEN: this.env.KIERO_SERVICE_TOKEN }),
    ...(this.env.R2_MEDIA_ACCESS_KEY_ID === undefined
      ? {}
      : { R2_MEDIA_ACCESS_KEY_ID: this.env.R2_MEDIA_ACCESS_KEY_ID }),
    ...(this.env.R2_MEDIA_SECRET_ACCESS_KEY === undefined
      ? {}
      : { R2_MEDIA_SECRET_ACCESS_KEY: this.env.R2_MEDIA_SECRET_ACCESS_KEY }),
  };
}
