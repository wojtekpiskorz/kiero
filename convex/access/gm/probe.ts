/**
 * Guarded B4 proof fixtures (dev deployment only).
 *
 * Same pattern as the B1/B2/B3 probes: an ACTION checks the deployment
 * guard variable (`KIERO_B4_PROOF_ENABLED === "1"`) and runs internal
 * mutations reachable only from this module. Nothing here is a product
 * surface: the entries exist so the evidence script can (1) read the
 * sanitized GM state (grants, activations, audit tail) the live proofs
 * assert on, and (2) seed the one processingRuns row the inspection proof
 * needs (no processing lane ships on this window yet; durableJobs rows
 * already appear through B3's revocation cleanup). On a production
 * deployment the guard variable is absent and every entry fails closed.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";

function guardEnabled(): boolean {
  return process.env.KIERO_B4_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("access.b4Proof", "proof_guard_disabled"));
}

export const gmStateInternal = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const grants = await ctx.db.query("gmAccessGrants").withIndex("by_entered").order("desc").take(10);
    const activations = await ctx.db
      .query("gmCompanyActivations")
      .withIndex("by_activated")
      .order("desc")
      .take(10);
    return okResult({
      grants: grants.map((row) => ({
        grantId: row._id,
        userId: row.userId,
        reason: row.reason,
        enteredAtMs: row.enteredAtMs,
        closedAtMs: row.closedAtMs ?? null,
      })),
      activations: activations.map((row) => ({
        activationId: row._id,
        companyId: row.companyId,
        activatedAtMs: row.activatedAtMs,
        endedAtMs: row.endedAtMs ?? null,
      })),
    });
  },
});

export const gmAuditTailInternal = internalMutation({
  // sinceMs windows the read to this evidence run: the by_grant_time index
  // orders by (grant id, time), so a global "newest 20" mixes grants and can
  // miss the current run's rows entirely. A filtered table scan is the
  // honest dev-probe shape (bounded by the window).
  args: { sinceMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const rows = await ctx.db
      .query("auditRecords")
      .filter((q) => q.gte(q.field("atMs"), args.sinceMs))
      .collect();
    return okResult({
      records: rows.map((row) => ({
        auditId: row._id,
        gmGrantId: row.gmGrantId ?? null,
        actorUserId: row.actorUserId ?? null,
        companyId: row.companyId ?? null,
        operationName: row.operationName,
        gmBasis: row.gmBasis ?? null,
        outcome: row.outcome ?? null,
        atMs: row.atMs,
      })),
    });
  },
});

export const seedProcessingRunInternal = internalMutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    // Dev-evidence stand-in for the (not-yet-shipped) processing lane: one
    // bounded processingRuns row so the audited inspection surface reads a
    // REAL row through the REAL projection. Guarded, dev deployment only.
    // A run row references a source of the firm (the table's integrity
    // rule); with no source on the proof firm the fixture fails closed and
    // the inspection proof asserts the honest empty projection instead.
    const source = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", args.companyId))
      .first();
    if (source === null) {
      return errorResult(unsupportedError("access.b4Proof", "no_source_to_seed"));
    }
    const runId = await ctx.db.insert("processingRuns", {
      companyId: args.companyId,
      sourceId: source._id,
      kind: "initial_analysis",
      pipelineVersion: "dev-proof",
      promptVersion: "dev-proof",
      schemaVersion: "dev-proof",
      modelConfigurationVersion: "dev-proof",
      state: "failed",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return okResult({ runId });
  },
});

/** Reads the sanitized GM state (grants + activations) for evidence. */
export const b4ProofGmState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.gm.probe.gmStateInternal, {});
  },
});

/** Reads the sanitized GM audit tail since a timestamp (evidence). */
export const b4ProofGmAuditTail = action({
  args: { sinceMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.gm.probe.gmAuditTailInternal, {
      sinceMs: args.sinceMs,
    });
  },
});

/** Seeds one bounded processingRuns row for the inspection proof. */
export const b4ProofSeedProcessingRun = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.gm.probe.seedProcessingRunInternal, {
      companyId: args.companyId,
    });
  },
});
