/**
 * Feature entry signatures and executor/event registration.
 *
 * These are registration shapes, not implementations. A module lane fills its
 * own fragment and registers: which operations it provides, which events it
 * publishes or consumes, and which durable job kinds it executes. Until a
 * lane implements an entry, dispatching it fails closed with the
 * `unsupported` closed error — a registration never claims business work.
 *
 * The composed registry (see `./registry`) checks at construction that every
 * registered name actually exists in a module surface, so a typo'd
 * producer/consumer edge fails loudly instead of silently never firing.
 *
 * Candidate contracts until A3 certifies the runtime composition.
 */

import { Schema } from "effect";
import type { ClosedErrorKind } from "../errors";
import type { DurableJobKind } from "../jobs";

/** Module-qualified operation name, e.g. `access.resolveCurrentAccess`. */
export const OperationName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_]*$/)),
  Schema.brand("OperationName"),
);
export type OperationName = Schema.Schema.Type<typeof OperationName>;

/** Module-qualified event name, e.g. `sources.sourceAccepted`. */
export const EventName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_]*$/)),
  Schema.brand("EventName"),
);
export type EventName = Schema.Schema.Type<typeof EventName>;

/** Feature identifier used by registration and composition (e.g. `access.identity`). */
export const FeatureId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)),
  Schema.brand("FeatureId"),
);
export type FeatureId = Schema.Schema.Type<typeof FeatureId>;

/**
 * One declared operation: its name, the schema its input must decode against,
 * the schema its successful result decodes against, and the operation-specific
 * error kinds. Every operation can additionally fail `unsupported` until its
 * owning lane implements it.
 */
export interface OperationEntry<
  Name extends string = string,
  Input = unknown,
  Result = unknown,
> {
  readonly kind: "operation";
  readonly name: Name;
  readonly input: Schema.Codec<Input, unknown, never, never>;
  readonly result: Schema.Codec<Result, unknown, never, never>;
  readonly errorKinds: readonly ClosedErrorKind[];
}

/** Declares one operation entry (identity helper: keeps entries homogeneous). */
export function operationEntry<Name extends string, Input, Result>(
  entry: OperationEntry<Name, Input, Result>,
): OperationEntry<Name, Input, Result> {
  return entry;
}

/** Widened entry type used when composing heterogeneous module surfaces. */
export type AnyOperationEntry = OperationEntry<string, unknown, unknown>;
export type AnyEventEntry = EventEntry<string, unknown>;

/** One declared domain event and the schema its payload decodes against. */
export interface EventEntry<Name extends string = string, Payload = unknown> {
  readonly kind: "event";
  readonly name: Name;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
}

/** Declares one event entry (identity helper). */
export function eventEntry<Name extends string, Payload>(
  entry: EventEntry<Name, Payload>,
): EventEntry<Name, Payload> {
  return entry;
}

/**
 * Registration of one feature: what it provides and what it consumes.
 * Names must exist in the composed module surfaces (checked in `./registry`).
 */
export interface FeatureEntry {
  readonly kind: "feature";
  readonly featureId: FeatureId;
  readonly providesOperations: readonly string[];
  readonly publishesEvents: readonly string[];
  readonly consumesEvents: readonly string[];
  readonly executesJobs: readonly DurableJobKind[];
}

/** Declares one feature registration (identity helper). */
export function featureEntry(entry: FeatureEntry): FeatureEntry {
  return entry;
}

/** Registration of a durable executor for one job kind. */
export interface ExecutorEntry {
  readonly kind: "executor";
  readonly executorId: FeatureId;
  readonly jobKind: DurableJobKind;
  /** The executor's decode authority for job input of this kind. */
  readonly input: Schema.Codec<unknown, unknown, never, never>;
}

/** Declares one executor registration (identity helper). */
export function executorEntry(entry: ExecutorEntry): ExecutorEntry {
  return entry;
}

/**
 * Registration of one durable event consumer: when `eventName` is published,
 * a job of `jobKind` runs (the reaction is durable, not inline).
 */
export interface EventConsumerEntry {
  readonly kind: "event_consumer";
  readonly consumerId: FeatureId;
  readonly eventName: string;
  readonly jobKind: DurableJobKind;
}

/** Declares one event consumer registration (identity helper). */
export function eventConsumerEntry(entry: EventConsumerEntry): EventConsumerEntry {
  return entry;
}
