/**
 * I4 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, the D1/D3/I3 probe pattern). No business work happens here; the
 * entries let the live evidence run against the REAL dev deployment, the
 * REAL gateway Worker and the REAL EU media bucket.
 *
 * Every entry resolves the CALLER's identity from that caller's own
 * verified Convex Auth credential; no identity is ever accepted from
 * client input and the service account is never substituted.
 *
 * - `probeDeletionState`: the caller's company's deletion ledger rows and
 *   purge stage states (counts and machine states only; never content).
 * - `probePurgeAsCaller`: runs the SAME checked sources dispatch the web
 *   feature uses, as the caller, so the admin/member refusal matrix and
 *   the confirmation guard live on the real deployment.
 * - `probeImpactAsCaller`: the administrator impact preview as the caller.
 * - `probeMediaPurgeCall`: the ONE production HTTP call to the gateway's
 *   purge route, with an explicit URL override (the proof drives the REAL
 *   deployed route without touching deployment env).
 * - `probePurgeTick`: forces the 24-hour tracking pass's decision now.
 * - `probeRetryPurgeStage` (R2, issue #127): returns one COMPLETED stage
 *   of a fully purged record to the interruption state and replays the
 *   REAL executor, the per-stage idempotency evidence surface (admin
 *   caller only).
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  forbiddenError,
  notFoundError,
  unsupportedError,
  validationError,
} from "@kiero/runtime";
import { probeDisabled, probeGuardEnabled, resolveCallerContext } from "../../sources/probe_shared";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { PURGE_STAGE_KINDS, type PurgeStageKind } from "./schema";
import { callPurgeRoute, purgeSourceExecutor, syntheticPurgeJobDoc } from "./executor";
import { runPurgeOverduePass } from "./functions";

/** The caller's company's deletion ledger and purge stage states. */
export const probeDeletionState = action({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    // Actions hold no direct db reader; the status core resolves the
    // caller's own company from the caller's own credential through the
    // guarded query surface.
    return await ctx.runQuery(api.operations.deletion.functions.deletionsStatus, {});
  },
});

/** The checked purge dispatch as the caller (the exact web surface). */
export const probePurgeAsCaller = action({
  args: { sourceId: v.string(), confirmation: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runMutation(api.sources.accept.commands.acceptSourceCommand, {
      envelope: {
        operation: "sources.purgeSource",
        input: { sourceId: args.sourceId, confirmation: args.confirmation },
        expectedRevisions: [],
      },
    });
  },
});

/** The administrator impact preview as the caller. */
export const probeImpactAsCaller = action({
  args: { sourceId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runQuery(api.operations.deletion.functions.deletionImpactFor, {
      sourceId: args.sourceId,
    });
  },
});

/** The ONE production gateway purge call, with an explicit URL override. */
export const probeMediaPurgeCall = internalAction({
  args: { deletionRecordId: v.string(), url: v.string() },
  handler: async (_ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return errorResult(unsupportedError("operations.deletion.probe", "probe_guard_disabled"));
    }
    const classification = await callPurgeRoute(args.deletionRecordId, args.url);
    if (classification.kind === "succeeded") {
      return okResult({ succeeded: true });
    }
    return errorResult(unsupportedError("operations.deletion.probe", classification.errorKind));
  },
});

/** Forces the 24-hour tracking pass now (the overdue diagnostic evidence). */
export const probePurgeTick = internalMutation({
  args: {},
  handler: async (ctx, _args) => {
    if (!probeGuardEnabled()) {
      throw new Error("probe guard disabled");
    }
    return { overdue: await runPurgeOverduePass(ctx) };
  },
});

// --- R2 per-stage retry evidence surface (issue #127) ------------------------------

/**
 * The per-stage retry core (unit-tested through the I4 harness): on one
 * FULLY PURGED record, returns the named stage to the visible interruption
 * state a refused attempt leaves, then re-runs the REAL durable executor.
 * The replayed stage body must converge to the same purged state with no
 * restored content and no duplicate audit, the idempotency contract the
 * R2 purge legs prove live. In-flight records refuse typed: their retry
 * belongs to the real durable job, never to a probe. The replay re-marks
 * the stage purged, so its purgedAtMs and attempts reflect the RETRY, not
 * the original completion (the fixture-control precedent of probeAgeUpload).
 * No identity logic here; the guarded wrapper below owns authorization.
 */
export async function replayPurgeStageForRecord(
  ctx: MutationCtx,
  params: { deletionRecordId: Id<"deletionRecords">; stageKind: PurgeStageKind },
): Promise<ResultEnvelope> {
  const record = await ctx.db.get(params.deletionRecordId);
  if (record === null) {
    return errorResult(notFoundError("deletionRecords", "deletion_record_missing"));
  }
  if (record.targetSourceId === undefined) {
    return errorResult(validationError("deletion_record_without_source"));
  }
  const stages = await ctx.db
    .query("deletionPurgeStages")
    .withIndex("by_record", (q) => q.eq("deletionRecordId", record._id))
    .collect();
  const stage = stages.find((row) => row.stageKind === params.stageKind);
  if (stage === undefined) {
    return errorResult(notFoundError("deletionPurgeStages", "stage_row_missing"));
  }
  // The completed-record precondition, enforced: an in-flight record's
  // stages belong to the real durable job (and the external media path's
  // outcome is recorded by the job's own action, never a probe).
  if (!stages.every((row) => row.state === "purged")) {
    return errorResult(validationError("purge_record_not_complete"));
  }
  await ctx.db.patch(stage._id, {
    state: "failed",
    lastErrorKind: "probe_stage_retry",
  });
  const input = { sourceId: record.targetSourceId, deletionRecordId: record._id };
  const outcome = await purgeSourceExecutor.execute(
    ctx,
    syntheticPurgeJobDoc(input, `probe-retry-${record._id}-${Date.now()}`),
    input,
  );
  const after = await ctx.db
    .query("deletionPurgeStages")
    .withIndex("by_record", (q) => q.eq("deletionRecordId", record._id))
    .collect();
  return okResult({
    outcome: outcome.outcome,
    stages: after
      .map((row) => ({
        stageKind: row.stageKind,
        state: row.state,
        attempts: row.attempts,
      }))
      .sort((a, b) => a.stageKind.localeCompare(b.stageKind)),
  });
}

/** The guarded retry as the CALLER (admin of the record's company only). */
export const retryPurgeStage = internalMutation({
  args: { deletionRecordId: v.id("deletionRecords"), stageKind: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const resolved = await resolveCallerContext(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    if (resolved.context.actor.membershipRole !== "admin") {
      return errorResult(forbiddenError("purge_retry_admin_only"));
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("company_scope_unresolved", "companies"));
    }
    const record = await ctx.db.get(args.deletionRecordId);
    if (record === null || record.companyId !== companyId) {
      return errorResult(notFoundError("deletionRecords", "deletion_record_not_found"));
    }
    if (!PURGE_STAGE_KINDS.includes(args.stageKind as PurgeStageKind)) {
      return errorResult(validationError("unknown_purge_stage_kind"));
    }
    return await replayPurgeStageForRecord(ctx, {
      deletionRecordId: args.deletionRecordId,
      stageKind: args.stageKind as PurgeStageKind,
    });
  },
});

export const probeRetryPurgeStage = action({
  args: { deletionRecordId: v.id("deletionRecords"), stageKind: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.operations.deletion.probe.retryPurgeStage, args);
  },
});
