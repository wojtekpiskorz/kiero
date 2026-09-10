/**
 * The outbox drain (A3; multi-edge row semantics decided by D5): the bridge
 * between published events and durable consumer work.
 *
 * Drain runs as a scheduled internal mutation. For each pending outbox row
 * it looks up the registered consumer edges for that event name in the A2/A3
 * composed registry and registers the matching durable job (the reaction is
 * durable, never inline). A publisher that already registered the work
 * atomically in its own transaction (same dedup key) is recognized and not
 * double-registered. Events with no registered consumer edge are marked
 * delivered immediately (nothing awaits them).
 *
 * ROW SEMANTICS UNDER MULTI-EDGE FAN-OUT (the D5 decision, 2026-09-10): the
 * outbox row is the PUBLICATION RECORD, and the DRAIN owns its terminal
 * transition — `delivered` once every registered edge's reaction is
 * registered. Per-reaction outcomes live on the `durableJobs` rows (state,
 * externalOutcome, attempts, finishedAtMs — the A3 round-2 outcome
 * carriers; H3 inspects those, not this row). No row waits `in_flight` for
 * a completing executor, because under fan-out one row cannot represent
 * several executors' outcomes. Executors whose projections carry the row's
 * dedup identity (echo, B3's cleanup) still flip their own row — those
 * flips are idempotent writes on a row the drain already delivered. The
 * TERMINAL-failure path intentionally flips a delivered row to `failed`
 * as a loud per-reaction alert (the incident scan reads it); that is a
 * deliberate exception to drain-owned terminality, not an oversight. The
 * retryable-echo path may set a delivered row back to `pending`, after
 * which the drain re-runs, dedup-skips and re-delivers — bounded and
 * converging.
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
import {
  eventConsumers,
  newDurableJobKey,
  type DurableJobKind,
} from "@kiero/contracts";
import { registerDurableJob } from "./publish";

const BATCH_SIZE = 10;

/**
 * The three-way outcome of projecting one event onto one consumer edge.
 */
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

/** Projects one event payload onto ONE registered consumer edge. */
function projectOneEdge(
  eventName: string,
  jobKind: DurableJobKind,
  payload: Record<string, unknown>,
  rowDedupKey: string,
): EventProjection {
  if (jobKind === "processing.analyze_change_plan") {
    return {
      kind: "job",
      jobKind,
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
  if (jobKind === "processing.extract_fragments") {
    return {
      kind: "job",
      jobKind,
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
  if (jobKind === "access.cleanup_revocation") {
    if (eventName === "access.membershipRevoked") {
      return {
        kind: "job",
        jobKind,
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
      jobKind,
      input: {
        kind: "session",
        membershipId: null,
        sessionId: payload.sessionId,
      },
      dedupKey: rowDedupKey,
    };
  }
  if (jobKind === "platform.echo_delivery") {
    // The outbox row's dedup identity anchors the delivery job; the payload
    // itself carries only the message.
    return {
      kind: "job",
      jobKind,
      input: { dedupKey: rowDedupKey, message: payload.message },
      dedupKey: rowDedupKey,
    };
  }
  // C5 registration (issue #28 owns these edges' projections): withdrawal
  // and every finding revision drain into `memory.recompute_dependents`.
  // The withdrawal payload carries its reason; the publisher (the withdrawal
  // transaction) already registered the job itself with the real actor
  // under the SAME dedup key, so this projection collapses onto that row.
  // AMPLIFICATION NOTE (for H3's incident scanning): the `memory.findingRevised`
  // edge fires one durable walk per revision — including the cascade's own
  // markings, most of which no-op. Accepted for alpha volume; per-reaction
  // outcomes live on the durableJobs rows, and the walk is one bounded
  // indexed query per job.
  if (jobKind === "memory.recompute_dependents") {
    if (eventName === "sources.sourceWithdrawn") {
      return {
        kind: "job",
        jobKind,
        input: {
          rootFindingId: null,
          sourceId: payload.sourceId,
          cause: "source_withdrawn",
          reason: payload.reason,
          withdrawnByUserId: null,
        },
        dedupKey: rowDedupKey,
      };
    }
    if (eventName === "memory.dependentsMarkedStale") {
      return {
        kind: "job",
        jobKind,
        input: {
          rootFindingId: payload.rootFindingId,
          sourceId: null,
          cause: "dependent_stale",
          reason: null,
          withdrawnByUserId: payload.withdrawnByUserId ?? null,
        },
        dedupKey: rowDedupKey,
      };
    }
    // memory.findingRevised: the revalidation walk — registrations only
    // when the revised basis became known again.
    return {
      kind: "job",
      jobKind,
      input: {
        rootFindingId: payload.findingId,
        sourceId: null,
        cause: "reanalysis",
        reason: null,
        withdrawnByUserId: null,
      },
      dedupKey: rowDedupKey,
    };
  }
  // D5 registration (issue #33 owns the declared consumer proof): the
  // accepted-source payload projects onto `processing.normalize_photo`
  // (architecture protocol step 4: normalize accepted photos before ordinary
  // vision). The dedup key is derived from the PAYLOAD's source id, NOT the
  // row's dedup identity: the acceptance transaction already registered the
  // extract job under the row's key, and one dedup key may never carry two
  // job kinds.
  if (jobKind === "processing.normalize_photo") {
    return {
      kind: "job",
      jobKind,
      input: {
        sourceId: payload.sourceId,
        attachmentIds: payload.attachmentIds ?? [],
      },
      dedupKey: `processing.normalize_photo:${String(payload.sourceId)}`,
    };
  }
  // G3 registration (issue #47 owns this declared consumer proof): a
  // recorded Calendar outcome change projects onto ONE bounded
  // reconciliation of that copy — the durable observation that resolves
  // unknown outcomes (never a blind retry; the executor's uncertain
  // failures re-block registration). The row's dedup identity is the
  // job's, so one outcome change registers one job.
  if (jobKind === "calendar.reconcile_outcome") {
    return {
      kind: "job",
      jobKind,
      input: { copyId: payload.copyId, lastKnownOutcome: payload.outcome },
      dedupKey: rowDedupKey,
    };
  }
  // F2 registration (issue #42 owns these edges' projections): the three
  // intent-source events project onto `attention.evaluate_due_intents`.
  // The dedup keys are derived from each event's SUBJECT (source,
  // clarification, change set), never the outbox row — the acceptance row's
  // key already carries the extract job, and a differently-keyed duplicate
  // event still collapses onto the same semantic intents. The
  // change-set-published payload carries no source id; the executor
  // resolves the change set's source itself.
  if (jobKind === "attention.evaluate_due_intents") {
    if (eventName === "sources.sourceAccepted") {
      return {
        kind: "job",
        jobKind,
        input: {
          trigger: "source_accepted",
          sourceId: payload.sourceId,
          clarificationId: null,
          changeSetId: null,
        },
        dedupKey: `attention.evaluate_due_intents:source:${String(payload.sourceId)}`,
      };
    }
    if (eventName === "memory.clarificationRaised") {
      return {
        kind: "job",
        jobKind,
        input: {
          trigger: "clarification_raised",
          sourceId: null,
          clarificationId: payload.clarificationId,
          changeSetId: null,
        },
        dedupKey: `attention.evaluate_due_intents:clarification:${String(payload.clarificationId)}`,
      };
    }
    return {
      kind: "job",
      jobKind,
      input: {
        trigger: "change_set_published",
        sourceId: null,
        clarificationId: null,
        changeSetId: payload.changeSetId,
      },
      dedupKey: `attention.evaluate_due_intents:changeset:${String(payload.changeSetId)}`,
    };
  }
  // E5 registration (issue #39 owns these declared consumer proofs): the
  // derived search rows' lifecycle refreshes. The dedup keys derive from each
  // event's SUBJECT plus the refresh mode (the F2 precedent), never the
  // outbox row: a withdrawal drops the source's index rows in every
  // non-retired generation, a purge does the same, and a revised finding
  // rebuilds its rows from the CURRENT revision. `generationId: null` is the
  // drain's honest "no generation named" (the payloads carry none); the
  // executor refreshes every non-retired generation.
  if (jobKind === "search.index_generation") {
    if (eventName === "sources.sourceWithdrawn" || eventName === "sources.sourcePurged") {
      return {
        kind: "job",
        jobKind,
        input: {
          generationId: null,
          mode: "refresh_source",
          sourceId: payload.sourceId,
          findingId: null,
        },
        dedupKey: `search.index_generation:refresh_source:${String(payload.sourceId)}`,
      };
    }
    return {
      kind: "job",
      jobKind,
      input: {
        generationId: null,
        mode: "refresh_finding",
        sourceId: null,
        findingId: payload.findingId,
      },
      dedupKey: `search.index_generation:refresh_finding:${String(payload.findingId)}`,
    };
  }
  return { kind: "unprojected_edge", jobKind };
}

/**
 * Projects one event payload onto EVERY registered consumer edge of that
 * event (one projection per edge; events without edges report themselves as
 * `no_consumer`). D5 amendment: an event may now carry SEVERAL consumer
 * edges (`sources.sourceAccepted` fans out to both extract and normalize);
 * the drain registers each edge's durable reaction independently. Edges
 * whose owning lane has not registered a projection yet still report
 * themselves as `unprojected_edge` so the drain can fail them LOUDLY.
 */
export function projectEventToJobInputs(
  eventName: string,
  payload: Record<string, unknown>,
  rowDedupKey: string,
): EventProjection[] {
  const edges = eventConsumers.filter(
    (consumer) => consumer.eventName === eventName,
  );
  if (edges.length === 0) {
    return [{ kind: "no_consumer" }];
  }
  return edges.map((edge) =>
    projectOneEdge(eventName, edge.jobKind, payload, rowDedupKey),
  );
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
    const projections = projectEventToJobInputs(
      row.eventName,
      decodePayload(row.envelopeJson),
      dedupKey,
    );
    let registeredAny = false;
    let sawConsumerEdge = false;
    for (const projection of projections) {
      if (projection.kind === "job") {
        await registerDurableJob(ctx, {
          kind: projection.jobKind,
          input: projection.input,
          companyId: row.companyId,
          policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
          jobKey: newDurableJobKey(),
          ...(projection.dedupKey === undefined
            ? {}
            : { dedupKey: projection.dedupKey }),
        });
        registeredAny = true;
        sawConsumerEdge = true;
        continue;
      }
      if (projection.kind === "unprojected_edge") {
        // A registered edge without a projection: loud, per-edge, and the
        // drain keeps going (the OTHER edges' reactions still register).
        sawConsumerEdge = true;
        console.error(
          `outbox drain: consumer projection missing for ${row.eventName} -> ${projection.jobKind} (row ${row.eventId})`,
        );
      }
    }
    if (registeredAny) {
      // The publication record is terminal: every registered edge's durable
      // reaction is registered (per-reaction outcomes live on the job rows).
      await ctx.db.patch(row._id, { deliveryState: "delivered" });
      continue;
    }
    if (!sawConsumerEdge) {
      // No registered edge awaits this event; publication is complete.
      await ctx.db.patch(row._id, { deliveryState: "delivered" });
      continue;
    }
    // Registered edges exist but NONE has a projection: fail the row LOUDLY.
    // The error kind is machine-readable on the row.
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
      await ctx.scheduler.runAfter(
        1_000,
        internal.platform.outbox.drainOutbox,
        {},
      );
    }
  },
});
