/**
 * Transactional publication: the atomic outbox + durable registration core.
 *
 * BOTH primitives take the SAME mutation transaction the caller's state
 * change uses, so "transaction publishes a canonical record and registers
 * durable work atomically" is structural (architecture protocol steps 3, 7,
 * 9): if the transaction aborts — crash, conflict, validation throw — the
 * rows, the envelope AND the scheduled work all roll back together. There
 * can be no accepted orphan (a committed record with no registered work)
 * and no orphan work (scheduled work with no record).
 *
 * The native Convex scheduler is the registration vehicle: `runAfter`
 * inside a mutation is atomic with that mutation's writes. The workflow
 * engine (convex/platform/pipeline.ts) starts from this same transactional
 * seam via job execution.
 */

import { Schema } from "effect";
import {
  DomainEventEnvelope,
  DurableJobKind,
  DurableJobKeySchema,
  EventIdSchema,
  events,
  executors,
  newDurableJobKey,
  newEventId,
  type DurableJobKey,
  type EventId,
  type RetryPolicy,
} from "@kiero/contracts";
import { decideEventPublication, decideJobRegistration } from "@kiero/runtime";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

/** Delay before the transactional drain kick (small, deterministic). */
export const OUTBOX_DRAIN_DELAY_MS = 1_000;

/** Narrows a normalizeId result, failing loudly on malformed ids. */
function requireId<T>(id: T | null, what: string): T {
  if (id === null) {
    throw new Error(`registerDurableJob: malformed ${what} id`);
  }
  return id;
}

export interface EventPublication {
  readonly companyId: string;
  readonly eventName: string;
  /** Untyped on purpose: decoded against the event's registry payload schema. */
  readonly payload: unknown;
  /** Semantic dedup identity; replaying the same logical operation dedups. */
  readonly dedupKey?: string;
  readonly correlationId?: string;
}

export interface EventPublicationResult {
  readonly eventId: EventId;
  readonly deduplicated: boolean;
}

/**
 * Publishes one domain event: decodes the payload against the event's
 * registry schema, dedups on `dedupKey` (replays return the existing event),
 * writes the outbox row and schedules the drain — all in the caller's
 * transaction.
 */
export async function publishEvent(
  tx: MutationCtx,
  publication: EventPublication,
): Promise<EventPublicationResult> {
  const entry = events[publication.eventName];
  if (entry === undefined) {
    throw new Error(`publishEvent: unknown event ${publication.eventName}`);
  }
  const payload = Schema.decodeUnknownSync(entry.payload)(publication.payload);
  const eventId = newEventId();
  const envelope = Schema.decodeUnknownSync(DomainEventEnvelope)({
    eventId,
    name: publication.eventName,
    companyId: publication.companyId,
    occurredAt: new Date().toISOString(),
    ...(publication.correlationId === undefined ? {} : { correlationId: publication.correlationId }),
    payload: Schema.encodeSync(entry.payload)(payload),
  });

  if (publication.dedupKey !== undefined) {
    const existing = await tx.db
      .query("outboxEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", publication.dedupKey))
      .first();
    const decision = decideEventPublication(existing === null ? null : { eventId: existing.eventId });
    if (decision.decision === "deduplicated") {
      return {
        eventId: Schema.decodeUnknownSync(EventIdSchema)(decision.existingEventId),
        deduplicated: true,
      };
    }
  }

  const companyId = tx.db.normalizeId("companies", publication.companyId);
  if (companyId === null) {
    throw new Error("publishEvent: malformed company id");
  }
  await tx.db.insert("outboxEvents", {
    eventId,
    companyId,
    eventName: publication.eventName,
    envelopeJson: JSON.stringify(Schema.encodeSync(DomainEventEnvelope)(envelope)),
    deliveryState: "pending",
    attempts: 0,
    // Always set: the drain's pending range query indexes this field, and
    // Convex index ranges do not match absent optional values.
    nextAttemptAtMs: Date.now(),
    ...(publication.dedupKey !== undefined && { dedupKey: publication.dedupKey }),
    createdAtMs: Date.now(),
  });
  await tx.scheduler.runAfter(OUTBOX_DRAIN_DELAY_MS, internal.platform.outbox.drainOutbox, {});
  return { eventId, deduplicated: false };
}

export interface JobRegistration {
  readonly kind: DurableJobKind;
  /** Untyped on purpose: decoded against the kind's executor input schema. */
  readonly input: unknown;
  readonly companyId?: string;
  readonly sourceId?: string;
  readonly processingRunId?: string;
  readonly policy: RetryPolicy;
  /** Explicit key keeps replays idempotent; generated when absent. */
  readonly jobKey?: DurableJobKey;
  /**
   * Semantic dedup identity shared with the causing event: a second
   * registration for the same dedup key (publisher + drain edge) collapses
   * onto the existing row.
   */
  readonly dedupKey?: string;
}

export interface JobRegistrationResult {
  readonly jobKey: DurableJobKey;
  readonly deduplicated: boolean;
}

/**
 * Registers one durable job: decodes the input against the kind's executor
 * schema from the composed registry (the executor table is the decode
 * authority), dedups on `jobKey`, writes the `durableJobs` row and schedules
 * the executor — all in the caller's transaction.
 */
export async function registerDurableJob(
  tx: MutationCtx,
  registration: JobRegistration,
): Promise<JobRegistrationResult> {
  const executor = executors.find((candidate) => candidate.jobKind === registration.kind);
  if (executor === undefined) {
    throw new Error(`registerDurableJob: no executor registered for ${registration.kind}`);
  }
  const input = Schema.decodeUnknownSync(executor.input)(registration.input);
  const jobKey = registration.jobKey ?? newDurableJobKey();

  const byDedup =
    registration.dedupKey === undefined
      ? null
      : await tx.db
          .query("durableJobs")
          .withIndex("by_dedup", (q) => q.eq("dedupKey", registration.dedupKey))
          .first();
  const existing =
    byDedup ??
    (await tx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
      .first());
  const decision = decideJobRegistration(existing === null ? null : existing.state);
  if (decision.decision === "skip") {
    return {
      jobKey:
        existing === null ? jobKey : Schema.decodeUnknownSync(DurableJobKeySchema)(existing.jobKey),
      deduplicated: true,
    };
  }

  const companyId =
    registration.companyId === undefined
      ? undefined
      : requireId(tx.db.normalizeId("companies", registration.companyId), "company");
  const sourceId =
    registration.sourceId === undefined
      ? undefined
      : requireId(tx.db.normalizeId("sources", registration.sourceId), "source");
  const processingRunId =
    registration.processingRunId === undefined
      ? undefined
      : requireId(
          tx.db.normalizeId("processingRuns", registration.processingRunId),
          "processing run",
        );
  await tx.db.insert("durableJobs", {
    jobKey,
    kind: registration.kind,
    ...(companyId !== undefined && { companyId }),
    ...(sourceId !== undefined && { sourceId }),
    ...(processingRunId !== undefined && { processingRunId }),
    state: "queued",
    ...(registration.dedupKey !== undefined && { dedupKey: registration.dedupKey }),
    inputJson: JSON.stringify(input),
    attempts: 0,
    maxAttempts: registration.policy.maxAttempts,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
  await tx.scheduler.runAfter(0, internal.platform.jobs.runDurableJob, { jobKey });
  return { jobKey, deduplicated: false };
}
