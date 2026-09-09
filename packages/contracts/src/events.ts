/**
 * Domain event and outbox envelope.
 *
 * Operations publish their durable side-effect intents together with the
 * state change (atomic outbox write). The event carries its own id and the
 * company scope; the payload is validated by each module's event schema
 * before it is written. Delivery is a separate, retryable step — see the
 * architecture's source processing/publication protocol, steps 7–9.
 *
 * Candidate contract until A3 certifies the runtime composition.
 */

import { Schema } from "effect";
import { tableIdSchema, EventIdSchema, CorrelationIdSchema } from "./tableIds";

/** Delivery state of one outbox row. */
export const OutboxDeliveryState = Schema.Literals([
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "superseded",
]);
export type OutboxDeliveryState = Schema.Schema.Type<typeof OutboxDeliveryState>;

/** Envelope of one published domain event. */
export const DomainEventEnvelope = Schema.Struct({
  eventId: EventIdSchema,
  name: Schema.NonEmptyString,
  companyId: tableIdSchema("companies"),
  /** System time of the state change that produced this event. */
  occurredAt: Schema.DateTimeUtcFromString,
  /** Present when the event belongs to one user/agent interaction thread. */
  correlationId: Schema.optionalKey(CorrelationIdSchema),
  /** Encoded payload, validated against the event's payload schema by the publisher. */
  payload: Schema.Unknown,
});
export type DomainEventEnvelope = Schema.Schema.Type<typeof DomainEventEnvelope>;

/** The outbox row: one durable event awaiting delivery. */
export const OutboxEnvelope = Schema.Struct({
  event: DomainEventEnvelope,
  deliveryState: OutboxDeliveryState,
  /** Semantic deduplication identity for external delivery (push, Calendar, email). */
  deduplicationKey: Schema.optionalKey(Schema.NonEmptyString),
  attempts: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type OutboxEnvelope = Schema.Schema.Type<typeof OutboxEnvelope>;
