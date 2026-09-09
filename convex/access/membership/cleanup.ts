/**
 * The access-revocation cleanup executor (B3): `access.cleanup_revocation`.
 *
 * This is the declared durable consumer of `access.membershipRevoked` and
 * `access.sessionRevoked` (the registry edges from A2/A3): revocation ends
 * current access IMMEDIATELY and structurally — the canonical resolution
 * re-reads the membership/session rows on every request — while this
 * executor performs the follow-up fan-out that cannot belong to any single
 * request:
 *
 * - membership revocation: the removed boss's device sessions are revoked
 *   on the app registry, so even identity-layer reads reflect the removal
 *   and a still-valid upstream token stops resolving. Their person row,
 *   authorship and audit history are untouched (issue #22).
 * - session revocation (B1's own event): the registry row was already
 *   revoked by the revoking mutation itself; the executor records that the
 *   consumer edge observed it — no derived access existed to purge yet
 *   (media/file caches belong to D3, push to F3; they recheck current
 *   authorization on every request rather than trusting cleanup).
 *
 * Every consumer checks current authorization independently of this job's
 * completion: a slow or failed cleanup never extends access by a
 * millisecond.
 */

import { Schema } from "effect";
import { revokedAccessCleanupInput } from "@kiero/contracts";
import type { JobExecutor, JobOutcome, DurableJobDoc } from "../../platform/executors";
import type { MutationCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";

/** The decoded input of one cleanup job (single typed reader). */
function cleanupJobInput(job: DurableJobDoc) {
  return Schema.decodeUnknownSync(revokedAccessCleanupInput)(JSON.parse(job.inputJson));
}

/** The durable revocation fan-out (runs inside the executor transaction). */
export const cleanupRevocationExecutor: JobExecutor = {
  jobKind: "access.cleanup_revocation",
  execute: async (ctx, job): Promise<JobOutcome> => {
    const input = cleanupJobInput(job);
    if (input.kind === "membership") {
      if (input.membershipId === null) {
        return { outcome: "failed", errorKind: "membership_id_missing", retryable: false };
      }
      // normalizeId is the proved bridge between branded contract ids and
      // Convex ids (A3); a malformed id is a hard failure, never retried.
      const membershipId = ctx.db.normalizeId("memberships", input.membershipId);
      if (membershipId === null) {
        return { outcome: "failed", errorKind: "membership_id_malformed", retryable: false };
      }
      const membership = await ctx.db.get(membershipId);
      if (membership === null) {
        // Registered atomically with the revocation patch: a missing row is
        // a hard inconsistency, never retried blindly.
        return { outcome: "failed", errorKind: "membership_not_found", retryable: false };
      }
      if (membership.state !== "revoked") {
        // The job must never resurrect or act on a live membership.
        return { outcome: "failed", errorKind: "membership_not_revoked", retryable: false };
      }
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", membership.userId))
        .collect();
      const nowMs = Date.now();
      for (const session of sessions) {
        if (session.revokedAtMs === undefined) {
          await ctx.db.patch(session._id, { revokedAtMs: nowMs });
        }
      }
      return { outcome: "succeeded" };
    }
    // Session revocation: the registry patch already happened in the
    // revoking transaction; observing the edge is the whole job.
    return { outcome: "succeeded" };
  },
  onSucceeded: async (ctx, job): Promise<void> => {
    // Flip the originating outbox row to delivered (the echo pattern): the
    // drain marked it in_flight when the edge registered this job.
    const outboxRow = await outboxRowOfJob(ctx, job);
    if (outboxRow !== null) {
      await ctx.db.patch(outboxRow._id, { deliveryState: "delivered" });
    }
  },
  onFailed: async (ctx, job): Promise<void> => {
    // A terminal failure must not strand the originating outbox row in
    // in_flight forever: land it in `failed` with the job's last error
    // kind, mirroring the platform executor's completion semantics (the
    // row's state is what outbox inspection reports; access itself ended
    // structurally at revocation time, independent of this job).
    const outboxRow = await outboxRowOfJob(ctx, job);
    if (outboxRow !== null) {
      // The passed job doc predates the failure patch: read the row for
      // the recorded error kind, and keep a machine kind regardless.
      const fresh = await ctx.db.get(job._id);
      await ctx.db.patch(outboxRow._id, {
        deliveryState: "failed",
        lastErrorKind: fresh?.lastErrorKind ?? "cleanup_failed",
      });
    }
  },
};

/** The originating outbox row of one cleanup job, when it has an identity. */
async function outboxRowOfJob(
  ctx: MutationCtx,
  job: DurableJobDoc,
): Promise<Doc<"outboxEvents"> | null> {
  const dedupKey = job.dedupKey;
  if (dedupKey === undefined) {
    return null;
  }
  return await ctx.db
    .query("outboxEvents")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
    .first();
}
