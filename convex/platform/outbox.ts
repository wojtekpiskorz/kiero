/**
 * The outbox drain (A3): the bridge between published events and durable
 * consumer work.
 *
 * Drain runs as a scheduled internal mutation. For each pending outbox row
 * it looks up the registered consumer edges for that event name in the A2/A3
 * composed registry and registers the matching durable job — the reaction is
 * durable, never inline — then marks the row in_flight. A publisher that
 * already registered the work atomically in its own transaction (same dedup
 * key) is recognized and not double-registered. Events with no registered
 * consumer edge are marked delivered immediately (nothing awaits them).
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

/** Projection of one event payload to its consumer job registration. */
function projectEventToJobInput(
  eventName: string,
  payload: Record<string, unknown>,
  rowDedupKey: string,
): { jobKind: DurableJobKind; input: unknown; dedupKey?: string } | null {
  const edge = eventConsumers.find((consumer) => consumer.eventName === eventName);
  if (edge === undefined) {
    return null;
  }
  // The mechanically projectable edges in this window. Business lanes
  // register their own projections in their fragments later; an edge without
  // a projection here fails closed at execution (`unsupported`), never
  // silently does nothing.
  if (edge.jobKind === "processing.analyze_change_plan") {
    return {
      jobKind: edge.jobKind,
      input: {
        sourceId: payload.sourceId,
        processingRunId: payload.newRunId,
        reanalysisOfRunId: payload.reanalysisOfRunId ?? null,
      },
    };
  }
  if (edge.jobKind === "platform.echo_delivery") {
    // The outbox row's dedup identity anchors the delivery job; the payload
    // itself carries only the message.
    return {
      jobKind: edge.jobKind,
      input: { dedupKey: rowDedupKey, message: payload.message },
      dedupKey: rowDedupKey,
    };
  }
  return null;
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
    if (projection !== null) {
      await registerDurableJob(ctx, {
        kind: projection.jobKind,
        input: projection.input,
        companyId: row.companyId,
        policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
        jobKey: newDurableJobKey(),
        ...(projection.dedupKey === undefined ? {} : { dedupKey: projection.dedupKey }),
      });
    }
    const hasEdge = eventConsumers.some((consumer) => consumer.eventName === row.eventName);
    // in_flight: the durable reaction is registered (or was already); the
    // completing executor flips the row to delivered/failed. No edge at all:
    // nothing awaits this event.
    await ctx.db.patch(row._id, { deliveryState: hasEdge ? "in_flight" : "delivered" });
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
