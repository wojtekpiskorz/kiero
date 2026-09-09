/**
 * Platform module surface (A3 sequential amendment to the A2 baseline).
 *
 * The platform owns no business work. These entries exist so the composition
 * proof's functions validate through the same registry every other module
 * uses, and so the Worker bridge has honest operations to forward:
 *
 * - `platform.probeEcho` is the proof command: its transaction publishes the
 *   canonical `platform.echoRequested` event and durable work is registered
 *   from it through the outbox, exactly like a business publication would.
 * - `platform.health` exposes runtime version, registered executors and
 *   outbox counts for diagnostics (and is the live subscription target).
 * - `platform.outboxState` is the tenant-scoped observability read the
 *   evidence scripts use (delivery states, jobs, external effects).
 *
 * Amended by A3 during certification; see the certification note in
 * docs/implementation/contracts/README.md.
 */

import { Schema } from "effect";
import {
  DurableJobKeySchema,
  EventIdSchema,
  IdempotencyKeySchema,
} from "../tableIds";
import { OutboxDeliveryState } from "../events";
import { DurableJobState } from "../jobs";
import { operationEntry, eventEntry } from "./registration";

/** Bounded proof message; long enough for realistic text, bounded for honesty. */
const ProbeMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(2000)),
);

export const platformOperations = {
  "platform.probeEcho": operationEntry({
    kind: "operation",
    name: "platform.probeEcho",
    input: Schema.Struct({ message: ProbeMessage }),
    result: Schema.Struct({
      echo: Schema.NonEmptyString,
      eventId: EventIdSchema,
      dedupKey: Schema.String,
      deduplicated: Schema.Boolean,
      jobKey: DurableJobKeySchema,
    }),
    errorKinds: ["unauthenticated", "forbidden", "validation", "unavailable"],
  }),
  "platform.health": operationEntry({
    kind: "operation",
    name: "platform.health",
    input: Schema.Struct({}),
    result: Schema.Struct({
      status: Schema.Literals(["ok"]),
      runtimeVersion: Schema.NonEmptyString,
      deployment: Schema.String,
      executors: Schema.Array(
        Schema.Struct({
          executorId: Schema.NonEmptyString,
          jobKind: Schema.NonEmptyString,
        }),
      ),
      outbox: Schema.Struct({
        pending: Schema.Number,
        inFlight: Schema.Number,
        delivered: Schema.Number,
        failed: Schema.Number,
        superseded: Schema.Number,
      }),
      /** Monotone witness (total outbox rows) for the subscription proof. */
      revision: Schema.Number,
    }),
    errorKinds: [],
  }),
  "platform.outboxState": operationEntry({
    kind: "operation",
    name: "platform.outboxState",
    input: Schema.Struct({
      dedupKey: Schema.optionalKey(Schema.NonEmptyString),
    }),
    result: Schema.Struct({
      events: Schema.Array(
        Schema.Struct({
          eventId: Schema.String,
          eventName: Schema.String,
          deliveryState: OutboxDeliveryState,
          attempts: Schema.Number,
          dedupKey: Schema.optionalKey(Schema.String),
          /** Sanitized closed error kind of the delivery failure, if any. */
          lastErrorKind: Schema.optionalKey(Schema.String),
        }),
      ),
      jobs: Schema.Array(
        Schema.Struct({
          jobKey: Schema.String,
          kind: Schema.String,
          state: DurableJobState,
          attempts: Schema.Number,
          /** Outcome of the attempt that left the transaction, when one did. */
          externalOutcome: Schema.optionalKey(
            Schema.Literals(["succeeded", "failed", "timeout", "unknown"]),
          ),
          /** Sanitized closed error kind of the terminal/last failure, if any. */
          lastErrorKind: Schema.optionalKey(Schema.String),
        }),
      ),
      externalEffects: Schema.Array(
        Schema.Struct({
          dedupKey: Schema.String,
          serviceName: Schema.String,
          receivedAtMs: Schema.Number,
        }),
      ),
    }),
    errorKinds: ["unauthenticated", "forbidden"],
  }),
} as const;

export const platformEvents = {
  /**
   * The canonical record of one echo publication: written atomically with the
   * command's state, drained into the durable echo job by the registered
   * consumer edge.
   */
  "platform.echoRequested": eventEntry({
    kind: "event",
    name: "platform.echoRequested",
    payload: Schema.Struct({
      message: Schema.NonEmptyString,
      idempotencyKey: Schema.optionalKey(IdempotencyKeySchema),
    }),
  }),
} as const;
