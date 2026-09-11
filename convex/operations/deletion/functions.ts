/**
 * The deletion lane's callable entries (I4): the boss-facing status reads
 * (administrator-checked), the 24-hour tracking tick, and the
 * service-credentialed purge bridge the gateway Worker's route consults.
 *
 * `deletionImpactFor` and `deletionsStatus` resolve the caller from their
 * own Convex Auth credential and check the CURRENT administrator role on
 * every request (the exports lane's administer discipline): the impact
 * preview is the explicit permanent-delete confirmation's counterpart, and
 * the status screen is the pending/complete/failed external-cleanup state
 * the issue requires.
 *
 * `purgeTick` (the cron safety net, the I5 backup-tick shape): bounded pass
 * over stages whose 24-hour deadline passed while still un-purged - each
 * emits the deduplicated `ops.deletion.overdue` diagnostic (I2's incident
 * surface) and pushes the stage's deadline one hour so the same episode
 * diagnoses at most once per hour while the underlying durable job's own
 * retry authority stays untouched.
 *
 * The bridge entry runs under the deployment's service credential
 * (verified by the HTTP boundary before dispatch): the gateway's purge
 * route reads the AUTHORITATIVE media key list here, never from its
 * request body (the D2 uploads-channel discipline).
 */

import { v } from "convex/values";
import { internalQuery, query } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import type { ResultEnvelope } from "@kiero/contracts";
import { emitDiagnosticEvent } from "../telemetry/emit";
import { readDeletionImpact, readDeletionsStatus } from "./status";

// ---------------------------------------------------------------------------
// The boss-facing reads.
// ---------------------------------------------------------------------------

/** The impact preview of one source (administrator-only, content-free). */
export const deletionImpactFor = query({
  args: { sourceId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    await readDeletionImpact(ctx.db, ctx.auth, args.sourceId),
});

/** The deletion records with their purge stages (administrator-only). */
export const deletionsStatus = query({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> =>
    await readDeletionsStatus(ctx.db, ctx.auth),
});

// ---------------------------------------------------------------------------
// The 24-hour tracking tick (cron safety net).
// ---------------------------------------------------------------------------

/** The overdue-diagnostic dedup window: one emission per stage per hour. */
function overdueDedupKey(stageId: string, deadlineAtMs: number): string {
  return `ops.deletion.overdue:${stageId}:${Math.floor(deadlineAtMs / (60 * 60 * 1000))}`;
}

/**
 * One bounded overdue pass (the convex mutation the cron calls): un-purged
 * stages past their deadline emit the redacted I2 diagnostic and slide
 * their tracking deadline one hour forward. Idempotent: purged stages left
 * the pending window, and the dedup key collapses repeats inside an hour.
 */
export async function runPurgeOverduePass(ctx: MutationCtx): Promise<number> {
  const nowMs = Date.now();
  const overdue = await ctx.db
    .query("deletionPurgeStages")
    .withIndex("by_state_deadline", (q) => q.eq("state", "pending").lte("deadlineAtMs", nowMs))
    .take(25);
  for (const stage of overdue) {
    await emitDiagnosticEvent(ctx, {
      kind: "ops.deletion.overdue",
      metadata: [
        { key: "sourceId", value: stage.sourceId },
        { key: "stageKind", value: stage.stageKind },
        { key: "state", value: stage.state },
        { key: "attempts", value: String(stage.attempts) },
        { key: "ageMs", value: String(nowMs - stage.createdAtMs) },
      ],
      serviceName: "convex",
      dedupKey: overdueDedupKey(stage._id, stage.deadlineAtMs),
    });
    await ctx.db.patch(stage._id, { deadlineAtMs: nowMs + 60 * 60 * 1000 });
  }
  return overdue.length;
}

// ---------------------------------------------------------------------------
// The service-credentialed purge bridge (the gateway Worker's channel).
// ---------------------------------------------------------------------------

/**
 * The bridge read the gateway's purge route consults BEFORE deleting: the
 * media stage's authoritative key list (the Worker never trusts the
 * request body's key list; the ledger row is the authority). A purged or
 * missing stage answers null - nothing to delete.
 */
export const purgeBridgeTargets = internalQuery({
  args: { deletionRecordId: v.string() },
  handler: async (ctx, args) => {
    const recordId = ctx.db.normalizeId("deletionRecords", args.deletionRecordId);
    if (recordId === null) {
      return null;
    }
    const stages = await ctx.db
      .query("deletionPurgeStages")
      .withIndex("by_record", (q) => q.eq("deletionRecordId", recordId))
      .collect();
    const stage = stages.find((row) => row.stageKind === "media_objects");
    if (stage === undefined || stage.state === "purged") {
      return null;
    }
    return {
      deletionRecordId: recordId,
      sourceId: stage.sourceId,
      objectKeys: JSON.parse(stage.objectKeysJson ?? "[]") as string[],
    };
  },
});
