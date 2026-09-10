/**
 * The outbox drain (A3): the bridge between published events and durable
 * consumer work.
 *
 * Drain runs as a scheduled internal mutation. For each pending outbox row
 * it looks up the registered consumer edges for that event name in the A2/A3
 * composed registry and registers the matching durable job (the reaction is
 * durable, never inline), then marks the row in_flight. A publisher that
 * already registered the work atomically in its own transaction (same dedup
 * key) is recognized and not double-registered. Events with no registered
 * consumer edge are marked delivered immediately (nothing awaits them).
 *
 * An edge WITHOUT a projection fails LOUDLY: the row is marked failed with
 * `lastErrorKind: "consumer_projection_missing"` and the drain keeps
 * processing. Unprojected edges are edges whose owning lane has not
 * registered a payload projection yet; they must be visible in the outbox
 * state, never silently stranded as in_flight.
 *
 * Scheduling: publishing an event schedules a drain atomically (publish.ts);
 * a drain that leaves work behind schedules its own successor. No cron table
 * is needed.
 */

import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { eventConsumers, newDurableJobKey, type DurableJobKind } from "@kiero/contracts";
import { registerDurableJob } from "./publish";

const BATCH_SIZE = 10;

/** The three-way outcome of projecting one event onto its consumer edge. */
export type EventProjection =
  | {
      readonly kind: "job";
      readonly jobKind: DurableJobKind;
      readonly input: unknown;
      readonly dedupKey?: string;
    }
  | { readonly kind: "no_consumer" }
  | { readonly kind: "unprojected_edge"; readonly jobKind: DurableJobKind };

/** Error kind recorded on rows whose consumer edge has no projection yet. */
export const CONSUMER_PROJECTION_MISSING = "consumer_projection_missing";

/**
 * Projects one event payload onto its registered consumer edge (a single
 * registry scan per call). The mechanically projectable edges in this
 * window are handled; every other registered edge reports itself as
 * `unprojected_edge` so the drain can fail it LOUDLY: its owning lane has
 * not registered a payload projection yet.
 */
export function projectEventToJobInput(
  eventName: string,
  payload: Record<string, unknown>,
  rowDedupKey: string,
): EventProjection {
  const edge = eventConsumers.find((consumer) => consumer.eventName === eventName);
  if (edge === undefined) {
    return { kind: "no_consumer" };
  }
  if (edge.jobKind === "processing.analyze_change_plan") {
    return {
      kind: "job",
      jobKind: edge.jobKind,
      input: {
        sourceId: payload.sourceId,
        processingRunId: payload.newRunId,
        reanalysisOfRunId: payload.reanalysisOfRunId ?? null,
      },
    };
  }
  // E3 registration (issue #37 owns this edge's projection): an accepted
  // source drains into `processing.extract_fragments`. The certified D1
  // payload carries no extractionId (the acceptance transaction already
  // registered the job itself, with the real id, under the SAME dedup
  // key), so the projection hands `null` and the executor resolves the
  // source's text extraction in-company; the registration collapses onto
  // the publisher's row through the shared dedup identity.
  if (edge.jobKind === "processing.extract_fragments") {
    return {
      kind: "job",
      jobKind: edge.jobKind,
      input: {
        sourceId: payload.sourceId,
        extractionId: payload.extractionId ?? null,
      },
      dedupKey: rowDedupKey,
    };
  }
  // B3 registration (issue #22 owns the declared consumer proof): the two
  // access-revocation edges project onto `access.cleanup_revocation`. The
  // membership payload carries its revocation instant and the successor
  // policy; the session payload (B1's shape) leaves the instant to the
  // executor. The row's dedup identity is also the job's, so a publisher
  // that already registered the cleanup atomically (revocation transaction,
  // convex/access/membership/operations.ts) collapses onto that row here.
  if (edge.jobKind === "access.cleanup_revocation") {
    if (eventName === "access.membershipRevoked") {
      return {
        kind: "job",
        jobKind: edge.jobKind,
        input: {
          kind: "membership",
          membershipId: payload.membershipId,
          sessionId: null,
          revokedAtMs: payload.revokedAtMs,
        },
        dedupKey: rowDedupKey,
      };
    }
    return {
      kind: "job",
      jobKind: edge.jobKind,
      input: { kind: "session", membershipId: null, sessionId: payload.sessionId },
      dedupKey: rowDedupKey,
    };
  }
  if (edge.jobKind === "platform.echo_delivery") {
    // The outbox row's dedup identity anchors the delivery job; the payload
    // itself carries only the message.
    return {
      kind: "job",
      jobKind: edge.jobKind,
      input: { dedupKey: rowDedupKey, message: payload.message },
      dedupKey: rowDedupKey,
    };
  }
  return { kind: "unprojected_edge", jobKind: edge.jobKind };
}

/** Processes one batch of pending outbox rows. */
export async function drainBatch(ctx: MutationCtx): Promise<void> {
  const nowMs = Date.now();
  const pending = await ctx.db
    .query("outboxEvents")
    .withIndex("by_delivery", (q) =>
      q.eq("deliveryState", "pending").lte("nextAttemptAtMs", nowMs),
    )
    .take(BATCH_SIZE);
  for (const row of pending) {
    const dedupKey = row.dedupKey ?? row.eventId;
    const projection = projectEventToJobInput(
      row.eventName,
      decodePayload(row.envelopeJson),
      dedupKey,
    );
    if (projection.kind === "job") {
      await registerDurableJob(ctx, {
        kind: projection.jobKind,
        input: projection.input,
        companyId: row.companyId,
        policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
        jobKey: newDurableJobKey(),
        ...(projection.dedupKey === undefined ? {} : { dedupKey: projection.dedupKey }),
      });
      // in_flight: the durable reaction is registered (or was already); the
      // completing executor flips the row to delivered/failed.
      await ctx.db.patch(row._id, { deliveryState: "in_flight" });
      continue;
    }
    if (projection.kind === "no_consumer") {
      // No registered edge awaits this event; publication is complete.
      await ctx.db.patch(row._id, { deliveryState: "delivered" });
      continue;
    }
    // A registered edge without a projection: fail the row LOUDLY and keep
    // draining. The error kind is machine-readable on the row.
    console.error(
      `outbox drain: consumer projection missing for ${row.eventName} -> ${projection.jobKind} (row ${row.eventId})`,
    );
    await ctx.db.patch(row._id, {
      deliveryState: "failed",
      lastErrorKind: CONSUMER_PROJECTION_MISSING,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePayload(envelopeJson: string): Record<string, unknown> {
  const envelope = JSON.parse(envelopeJson) as { payload?: unknown };
  return isRecord(envelope.payload) ? envelope.payload : {};
}

/** The scheduled drain entry (also callable synchronously from the probe). */
export const drainOutbox = internalMutation({
  args: {},
  handler: async (ctx) => {
    await drainBatch(ctx);
    const remaining = await ctx.db
      .query("outboxEvents")
      .withIndex("by_delivery", (q) => q.eq("deliveryState", "pending"))
      .take(1);
    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(1_000, internal.platform.outbox.drainOutbox, {});
    }
  },
});
