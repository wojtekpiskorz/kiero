/**
 * The backups HTTP boundary (I5): the EU backup Container's verified entry
 * into Convex. The bearer rule is the ONE shared digest-compare helper
 * (`../telemetry/serviceToken.ts`, the platform-bridge precedent): the
 * worker presents the deployment's `KIERO_SERVICE_TOKEN` and every route
 * below runs the REAL internal functions - no second decision path.
 *
 * Health/cost events around the protocol (I2 seam):
 * - every begin attempt records a `backup.job` heartbeat (ok when work is
 *   possible, degraded on refusal/failure) so silence detection (3x15m)
 *   fires well before the one-hour freshness limit;
 * - a verified manifest records the run's measured cost entries (provider
 *   `backup`, categories export/storage/egress, observed amounts - 0 minor
 *   while inside the free allowances) into the 400/500 PLN accounting.
 */

import { httpAction } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult } from "@kiero/contracts";
import { unauthenticatedError, validationError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../telemetry/serviceToken";
import { periodOf } from "../telemetry/costs";

async function verifyServiceToken(authorizationHeader: string | null): Promise<boolean> {
  return verifyServiceBearerToken(authorizationHeader, process.env.KIERO_SERVICE_TOKEN);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
}

async function heartbeat(ctx: ActionCtx, status: "ok" | "degraded"): Promise<void> {
  // Best effort: a heartbeat failure must not mask the protocol result.
  await ctx.runMutation(internal.operations.telemetry.functions.recordHeartbeat, {
    serviceName: "backup.job",
    status,
  });
}

/** One measured cost entry for the run's accounting (free tier = 0 minor observed). */
async function recordCost(
  ctx: ActionCtx,
  input: { category: string; amountMinor: number; basis: "observed" | "estimate"; label: string; dedupKey: string },
): Promise<void> {
  await ctx.runMutation(internal.operations.telemetry.functions.recordCostEntry, {
    period: periodOf(Date.now()),
    provider: "backup",
    category: input.category,
    amountMinor: input.amountMinor,
    basis: input.basis,
    label: input.label,
    dedupKey: input.dedupKey,
  });
}

/** POST /operations/backups/run: acquire the single-run lease for this slot. */
export const backupsRunHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  const begin = await ctx.runMutation(internal.operations.backups.functions.beginRun, {});
  await heartbeat(ctx, begin.status === "acquired" ? "ok" : "degraded");
  return jsonResponse(200, okResult(begin));
});

/**
 * POST /operations/backups/complete: server-side closure verification; on
 * success the set is verified and its measured cost entries are recorded.
 */
export const backupsCompleteHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, errorResult(validationError("complete_body_not_json")));
  }
  const complete = await ctx.runMutation(
    internal.operations.backups.functions.completeRun,
    body as never,
  );
  if (!complete.ok) {
    await heartbeat(ctx, "degraded");
    return jsonResponse(200, okResult(complete));
  }
  // The deployment knows its own environment (KIERO_ENVIRONMENT, the same
  // server-side read the telemetry cron uses); the container never sends
  // the field, so a body-supplied value must not relabel cost entries.
  const rawEnvironment = process.env.KIERO_ENVIRONMENT ?? "dev";
  const environment = /^(dev|staging|alpha-production)$/.test(rawEnvironment) ? rawEnvironment : "dev";
  await recordCost(ctx, {
    category: "export",
    amountMinor: 0,
    basis: "observed",
    label: environment,
    dedupKey: `backup_export:${complete.manifestId}`,
  });
  await recordCost(ctx, {
    category: "storage",
    amountMinor: 0,
    basis: "observed",
    label: environment,
    dedupKey: `backup_storage:${complete.manifestId}`,
  });
  await recordCost(ctx, {
    category: "egress",
    amountMinor: 0,
    basis: "observed",
    label: environment,
    dedupKey: `backup_egress:${complete.manifestId}`,
  });
  await heartbeat(ctx, "ok");
  return jsonResponse(200, okResult(complete));
});

/** POST /operations/backups/fail: record a typed run failure. */
export const backupsFailHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, errorResult(validationError("fail_body_not_json")));
  }
  const failed = await ctx.runMutation(internal.operations.backups.functions.failRun, body as never);
  await heartbeat(ctx, "degraded");
  return jsonResponse(200, okResult(failed));
});

/** POST /operations/backups/sweep: the reference-aware retention plan. */
export const backupsSweepHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  return jsonResponse(
    200,
    okResult(await ctx.runQuery(internal.operations.backups.functions.sweepPlan, {})),
  );
});

/** POST /operations/backups/sweep/complete: apply a finished sweep. */
export const backupsSweepCompleteHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, errorResult(validationError("sweep_body_not_json")));
  }
  return jsonResponse(
    200,
    okResult(await ctx.runMutation(internal.operations.backups.functions.sweepComplete, body as never)),
  );
});

/** GET /operations/backups/state: the composed backups state (I6/J5 seam). */
export const backupsStateHandler = httpAction(async (ctx, request) => {
  if (!(await verifyServiceToken(request.headers.get("authorization")))) {
    return unauthorized();
  }
  return jsonResponse(
    200,
    okResult(await ctx.runQuery(internal.operations.backups.functions.backupsState, {})),
  );
});
