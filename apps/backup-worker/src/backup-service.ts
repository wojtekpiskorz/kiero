/**
 * The backup protocol surface (I5): ONE handler shared by the container's
 * HTTP entry and every test/proof driver.
 *
 * - `GET /healthz`: the honest channel summary (credential PRESENCE by
 *   name, never values) so a deployed-but-unconfigured executor is visibly
 *   pending, not silently idle.
 * - `POST /run`: bearer-verified (`KIERO_SERVICE_TOKEN`, digest-compared
 *   server side by Convex too) execution of one pipeline run.
 *
 * The Worker runtime (src/index.ts) answers /healthz itself and proxies
 * /run through the Durable Object to the EU container instance, which runs
 * this handler with the real deps (src/deps.ts).
 */

import { runBackup, type RunOptions, type RunSummary } from "./pipeline.ts";
import type { BackupDeps } from "./ports.ts";
// The ONE bearer rule (no third mirror here): serviceToken.ts is
// deliberately free of Convex imports so any runtime can use it.
import { verifyServiceBearerToken } from "../../../convex/operations/telemetry/serviceToken.ts";

export interface BackupServiceEnv {
  readonly ENVIRONMENT?: string;
  readonly KIERO_SERVICE_TOKEN?: string;
  readonly CONVEX_SITE_URL?: string;
  readonly R2_BACKUP_ENDPOINT?: string;
  readonly R2_BACKUP_BUCKET?: string;
  readonly R2_BACKUP_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly R2_MEDIA_READ_ACCESS_KEY_ID?: string;
  readonly CONVEX_EXPORT_DEPLOYMENT?: string;
  readonly CONVEX_BACKUP_ADMIN_KEY?: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Channel presence by NAME only (booleans; no values, no prefixes). */
export function healthSummary(env: BackupServiceEnv): Record<string, unknown> {
  return {
    service: "backup-worker",
    environment: env.ENVIRONMENT ?? "",
    channels: {
      convexProtocol: env.CONVEX_SITE_URL !== undefined && env.CONVEX_SITE_URL !== "" && env.KIERO_SERVICE_TOKEN !== undefined && env.KIERO_SERVICE_TOKEN !== "",
      databaseExport: env.CONVEX_EXPORT_DEPLOYMENT !== undefined && env.CONVEX_EXPORT_DEPLOYMENT !== "" && env.CONVEX_BACKUP_ADMIN_KEY !== undefined && env.CONVEX_BACKUP_ADMIN_KEY !== "",
      backupStore: env.R2_BACKUP_ENDPOINT !== undefined && env.R2_BACKUP_ENDPOINT !== "" && env.R2_BACKUP_BUCKET !== undefined && env.R2_BACKUP_BUCKET !== "" && env.R2_BACKUP_ACCESS_KEY_ID !== undefined && env.R2_BACKUP_ACCESS_KEY_ID !== "",
      mediaReader: env.R2_MEDIA_ENDPOINT !== undefined && env.R2_MEDIA_ENDPOINT !== "" && env.R2_MEDIA_BUCKET !== undefined && env.R2_MEDIA_BUCKET !== "" && env.R2_MEDIA_READ_ACCESS_KEY_ID !== undefined && env.R2_MEDIA_READ_ACCESS_KEY_ID !== "",
    },
    note: "channels false = typed not_configured refusals; owner actions in infra/backups/README.md",
  };
}

/** The shared handler; deps are injected (container: real; worker: none). */
export async function handleBackupProtocol(
  request: Request,
  env: BackupServiceEnv,
  deps?: BackupDeps,
  options?: RunOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse(200, healthSummary(env));
  }
  if (request.method === "POST" && url.pathname === "/run") {
    // Digest-compared bearer check (the shared helper; false covers a
    // missing configuration, a missing header and any mismatch).
    if (!(await verifyServiceBearerToken(request.headers.get("authorization"), env.KIERO_SERVICE_TOKEN))) {
      return jsonResponse(401, { ok: false, code: "service_credential_invalid" });
    }
    if (deps === undefined) {
      // The Worker surface never executes runs; only the container does.
      return jsonResponse(503, { ok: false, code: "executor_not_in_container" });
    }
    try {
      const summary: RunSummary = await runBackup(deps, options);
      return jsonResponse(200, summary);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("pipeline interrupted at ")) {
        // Proof interrupts are deliberate: report them as such.
        return jsonResponse(500, { ok: false, code: "interrupted", at: error.message });
      }
      return jsonResponse(500, { ok: false, code: "internal" });
    }
  }
  return jsonResponse(404, { ok: false, code: "not_found" });
}
