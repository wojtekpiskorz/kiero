/**
 * Guarded H4 proof fixtures (dev deployment only).
 *
 * Same pattern as the B1..B4/E3 probes: an ACTION checks the deployment
 * guard variable (`KIERO_H4_PROOF_ENABLED === "1"`) and runs internal reads
 * reachable only from this module. Nothing here is a product surface: the
 * entries exist so the evidence script can assert on (1) the protected GM
 * audit trail this lane writes (actor, grant, basis, outcome, target
 * revision, run), and (2) the immutable-source snapshot the inspection
 * invariants compare before/after every GM action. On a production
 * deployment the guard variable is absent and every entry fails closed.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { sha256Hex } from "../../access/membership/cores";

function guardEnabled(): boolean {
  return process.env.KIERO_H4_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("operations.h4Proof", "proof_guard_disabled"));
}

/**
 * The sanitized GM audit tail since a timestamp (this lane's rows carry
 * gmGrantId; the read stays bounded by the window like B4's tail read).
 */
export const h4AuditTailInternal = internalMutation({
  args: { sinceMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const rows = await ctx.db
      .query("auditRecords")
      .filter((q) => q.gte(q.field("atMs"), args.sinceMs))
      .collect();
    return okResult({
      records: rows.map((row) => ({
        auditId: row._id,
        operationName: row.operationName,
        gmGrantId: row.gmGrantId ?? null,
        actorUserId: row.actorUserId ?? null,
        companyId: row.companyId ?? null,
        processingRunId: row.processingRunId ?? null,
        gmBasis: row.gmBasis ?? null,
        gmTargetRevision: row.gmTargetRevision ?? null,
        outcome: row.outcome ?? null,
        atMs: row.atMs,
      })),
    });
  },
});

/**
 * The immutable-source snapshot: content identity as a SHA-256 (the raw
 * text never leaves the database), plus the timestamps and lifecycle the
 * inspection result mirrors. Comparing snapshots before and after GM
 * actions proves the bytes/text never change.
 */
export const h4SourceSnapshotInternal = internalMutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(unsupportedError("operations.h4Proof", "source_not_found"));
    }
    return okResult({
      sourceId: source._id,
      textSha256: await sha256Hex(source.authorText),
      sentAtMs: source.sentAtMs,
      fullyAcceptedAtMs: source.fullyAcceptedAtMs,
      lifecycle: source.lifecycle,
    });
  },
});

/** Reads the sanitized GM audit tail since a timestamp (evidence). */
export const h4ProofAuditTail = action({
  args: { sinceMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.operations.processing.probe.h4AuditTailInternal, {
      sinceMs: args.sinceMs,
    });
  },
});

/** Reads the immutable-source snapshot (evidence). */
export const h4ProofSourceSnapshot = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.operations.processing.probe.h4SourceSnapshotInternal, {
      sourceId: args.sourceId,
    });
  },
});
