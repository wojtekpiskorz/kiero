/**
 * @kiero/backup-worker: the EU backup Container executor entry (I5).
 *
 * THIN on purpose (the media-worker D6 pattern): the protocol lives once in
 * ./backup-service.ts (`handleBackupProtocol`) and the pipeline in
 * ./pipeline.ts. Three surfaces, one boundary:
 *
 * - the Worker `fetch` answers `/healthz` locally (cheap, no container
 *   wake-up) and proxies everything else through the Durable Object to the
 *   EU container instance;
 * - the Worker `scheduled` handler (the every-15-minutes cron trigger in
 *   wrangler.jsonc) drives one `/run` through the same DO;
 * - the container (src/container-main.ts + src/deps.ts) executes the run
 *   with the real exporter/stores/protocol.
 *
 * The DO class injects the Worker's secret NAMES into the container process
 * env - values never live in the repo. Until the owner injects the R2/
 * export credentials, runs honestly fail typed (`*_not_configured`) while
 * the lease/heartbeat/freshness machinery keeps observing.
 */

import { Container } from "@cloudflare/containers";
import { handleBackupProtocol, type BackupServiceEnv } from "./backup-service.ts";
import type { BackupWorkerEnv } from "./ports.ts";

/** The env additions the container routing needs (the DO binding). */
export interface BackupWorkerRoutingEnv extends BackupServiceEnv, BackupWorkerEnv {
  readonly BACKUP_WORKER: DurableObjectNamespace<BackupWorkerContainer>;
}

export default {
  async fetch(request: Request, env: BackupWorkerRoutingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Health stays in the Worker: same summary, no container wake-up.
      return handleBackupProtocol(request, env);
    }
    const stub = env.BACKUP_WORKER.get(env.BACKUP_WORKER.idFromName("backup"));
    return stub.fetch(request);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: BackupWorkerRoutingEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const stub = env.BACKUP_WORKER.get(env.BACKUP_WORKER.idFromName("backup"));
        await stub.fetch(new Request("https://backup-worker/run", { method: "POST" }));
      })(),
    );
  },
};

/**
 * The container's Durable Object class (named by `containers[].class_name`
 * in wrangler.jsonc; bound as BACKUP_WORKER). The inherited `fetch` proxies
 * to the EU container instance, which runs the same protocol with the real
 * deps (src/container-main.ts).
 */
export class BackupWorkerContainer extends Container<BackupWorkerEnv> {
  override defaultPort = 8080;
  override sleepAfter = "2m";

  /**
   * Container processes do NOT inherit Worker secrets or vars: the base
   * class injects exactly this map into the container instance env. The
   * backup/media-read credentials and the service token arrive as Worker
   * secrets (wrangler secret put) and are forwarded here by NAME.
   */
  override envVars = {
    ENVIRONMENT: this.env.ENVIRONMENT ?? "",
    CONVEX_SITE_URL: this.env.CONVEX_SITE_URL ?? "",
    CONVEX_EXPORT_DEPLOYMENT: this.env.CONVEX_EXPORT_DEPLOYMENT ?? "",
    R2_BACKUP_ENDPOINT: this.env.R2_BACKUP_ENDPOINT ?? "",
    R2_BACKUP_BUCKET: this.env.R2_BACKUP_BUCKET ?? "",
    R2_MEDIA_ENDPOINT: this.env.R2_MEDIA_ENDPOINT ?? "",
    R2_MEDIA_BUCKET: this.env.R2_MEDIA_BUCKET ?? "",
    ...(this.env.KIERO_SERVICE_TOKEN === undefined
      ? {}
      : { KIERO_SERVICE_TOKEN: this.env.KIERO_SERVICE_TOKEN }),
    ...(this.env.CONVEX_BACKUP_ADMIN_KEY === undefined
      ? {}
      : { CONVEX_BACKUP_ADMIN_KEY: this.env.CONVEX_BACKUP_ADMIN_KEY }),
    ...(this.env.R2_BACKUP_ACCESS_KEY_ID === undefined
      ? {}
      : { R2_BACKUP_ACCESS_KEY_ID: this.env.R2_BACKUP_ACCESS_KEY_ID }),
    ...(this.env.R2_BACKUP_SECRET_ACCESS_KEY === undefined
      ? {}
      : { R2_BACKUP_SECRET_ACCESS_KEY: this.env.R2_BACKUP_SECRET_ACCESS_KEY }),
    ...(this.env.R2_MEDIA_READ_ACCESS_KEY_ID === undefined
      ? {}
      : { R2_MEDIA_READ_ACCESS_KEY_ID: this.env.R2_MEDIA_READ_ACCESS_KEY_ID }),
    ...(this.env.R2_MEDIA_READ_SECRET_ACCESS_KEY === undefined
      ? {}
      : { R2_MEDIA_READ_SECRET_ACCESS_KEY: this.env.R2_MEDIA_READ_SECRET_ACCESS_KEY }),
  };
}
