/**
 * Composed operation/event registry and the initial producer/consumer
 * registration entries.
 *
 * This is the single composition point of the candidate contracts: every
 * module's operations and events are gathered here, and the load-bearing
 * durable consumer edges named in the architecture are registered once:
 * access-revocation cleanup, reanalysis, deletion purge and Calendar outcome
 * reconciliation. Constructing the registry checks that every registered
 * operation/event name exists in exactly one module surface and that no
 * executor claims a job kind twice: a typo'd edge fails here, not silently
 * in production.
 *
 * Registrations are candidates: they declare seams, not implementations.
 * Dispatching any unimplemented entry fails closed with `unsupported`.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import {
  FeatureId,
  eventConsumerEntry,
  executorEntry,
  type AnyEventEntry,
  type AnyOperationEntry,
  type EventConsumerEntry,
  type ExecutorEntry,
} from "./registration";
import { accessOperations, accessEvents } from "./access";
import { sourcesOperations, sourcesEvents } from "./sources";
import { memoryOperations, memoryEvents } from "./memory";
import { projectsOperations, projectsEvents } from "./projects";
import { workOperations, workEvents } from "./work";
import { attentionOperations, attentionEvents } from "./attention";
import { calendarOperations, calendarEvents } from "./calendar";
import { operationsOperations, operationsEvents } from "./operations";
import { searchOperations, searchEvents } from "./search";
import { integrationsOperations, integrationsEvents } from "./integrations";

interface Nameable {
  readonly name: string;
}

function collect<E extends Nameable>(
  ...groups: Readonly<Record<string, E>>[]
): Record<string, E> {
  const out: Record<string, E> = {};
  for (const group of groups) {
    for (const key of Object.keys(group)) {
      const entry = group[key];
      if (entry === undefined || entry.name in out || entry.name !== key) {
        throw new Error(`Contract registry: duplicate or mis-keyed entry: ${key}`);
      }
      out[entry.name] = entry;
    }
  }
  return out;
}

/** All declared operations, keyed by operation name. */
export const operations: Record<string, AnyOperationEntry> = collect<AnyOperationEntry>(
  accessOperations,
  sourcesOperations,
  memoryOperations,
  projectsOperations,
  workOperations,
  attentionOperations,
  calendarOperations,
  operationsOperations,
  searchOperations,
  integrationsOperations,
);

/** All declared events, keyed by event name. */
export const events: Record<string, AnyEventEntry> = collect<AnyEventEntry>(
  accessEvents,
  sourcesEvents,
  memoryEvents,
  projectsEvents,
  workEvents,
  attentionEvents,
  calendarEvents,
  operationsEvents,
  searchEvents,
  integrationsEvents,
);

// Executor input schemas (decode authority per job kind).

const revokedAccessCleanupInput = Schema.Struct({
  kind: Schema.Literals(["membership", "session"]),
  membershipId: Schema.NullOr(tableIdSchema("memberships")),
  sessionId: Schema.NullOr(tableIdSchema("sessions")),
  revokedAtMs: Schema.Number,
});

const recomputeDependentsInput = Schema.Struct({
  rootFindingId: Schema.NullOr(tableIdSchema("findings")),
  sourceId: Schema.NullOr(tableIdSchema("sources")),
  cause: Schema.Literals(["source_withdrawn", "dependent_stale", "reanalysis"]),
});

const purgeSourceInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  deletionRecordId: tableIdSchema("deletionRecords"),
});

const reconcileOutcomeInput = Schema.Struct({
  copyId: tableIdSchema("calendarCopies"),
  lastKnownOutcome: Schema.Literals(["confirmed", "absent", "unknown"]),
});

const extractFragmentsInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  extractionId: tableIdSchema("extractions"),
});

const analyzeChangePlanInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  processingRunId: tableIdSchema("processingRuns"),
  reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
});

function decodeFeatureId(value: string): Schema.Schema.Type<typeof FeatureId> {
  return Schema.decodeUnknownSync(FeatureId)(value);
}

/**
 * Durable executors declared so far. Each later lane registers its own
 * executors in its fragment; this initial set names the seams the
 * architecture requires to exist before consumers begin.
 */
export const executors: readonly ExecutorEntry[] = [
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("access.cleanup"),
    jobKind: "access.cleanup_revocation",
    input: revokedAccessCleanupInput,
  }),
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("memory.recompute"),
    jobKind: "memory.recompute_dependents",
    input: recomputeDependentsInput,
  }),
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("deletion.purge"),
    jobKind: "deletion.purge_source",
    input: purgeSourceInput,
  }),
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("calendar.reconcile"),
    jobKind: "calendar.reconcile_outcome",
    input: reconcileOutcomeInput,
  }),
  // The durable publication pipeline seams (E3 and later lanes implement).
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("processing.extract"),
    jobKind: "processing.extract_fragments",
    input: extractFragmentsInput,
  }),
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("processing.analyze"),
    jobKind: "processing.analyze_change_plan",
    input: analyzeChangePlanInput,
  }),
];

function consumer(
  consumerId: string,
  eventName: string,
  jobKind: EventConsumerEntry["jobKind"],
): EventConsumerEntry {
  return eventConsumerEntry({
    kind: "event_consumer",
    consumerId: decodeFeatureId(consumerId),
    eventName,
    jobKind,
  });
}

/**
 * Durable event consumers declared so far: the four cross-module outcomes the
 * architecture names explicitly (access-revocation cleanup, reanalysis,
 * deletion, Calendar outcomes) plus the publication pipeline seams.
 */
export const eventConsumers: readonly EventConsumerEntry[] = [
  // Access revocation must invalidate derived access and media checks.
  consumer("access.cleanup", "access.membershipRevoked", "access.cleanup_revocation"),
  consumer("access.cleanup", "access.sessionRevoked", "access.cleanup_revocation"),
  // Withdrawal/purge re-evaluates dependent findings; history retained.
  consumer("memory.recompute", "sources.sourceWithdrawn", "memory.recompute_dependents"),
  consumer("memory.recompute", "memory.dependentsMarkedStale", "memory.recompute_dependents"),
  // Permanent deletion purges derivatives within the accepted window.
  consumer("deletion.purge", "sources.sourcePurged", "deletion.purge_source"),
  // Unknown Calendar outcomes always reconcile before another POST.
  consumer("calendar.reconcile", "calendar.copyOutcomeRecorded", "calendar.reconcile_outcome"),
  // Accepted sources register durable processing atomically.
  consumer("processing.analyze", "sources.sourceAccepted", "processing.extract_fragments"),
  // Requested reanalysis runs as a linked new run.
  consumer("processing.analyze", "operations.reanalysisRequested", "processing.analyze_change_plan"),
];

// Fail fast on impossible registrations (module surface name drift).

/**
 * Throws if two executors claim the same job kind. Exported so the
 * construction-time guarantee itself is under test: a silent Set collapse
 * here would let two lanes believe they own one job kind.
 */
export function assertNoDuplicateExecutors(list: readonly ExecutorEntry[]): Set<string> {
  const seen = new Set<string>();
  for (const executor of list) {
    if (seen.has(executor.jobKind)) {
      throw new Error(
        `Contract registry: duplicate executor for job kind ${executor.jobKind}`,
      );
    }
    seen.add(executor.jobKind);
  }
  return seen;
}

const registeredJobKinds = assertNoDuplicateExecutors(executors);
for (const entry of eventConsumers) {
  if (!(entry.eventName in events)) {
    throw new Error(`Contract registry: consumer references unknown event ${entry.eventName}`);
  }
  if (!registeredJobKinds.has(entry.jobKind)) {
    throw new Error(
      `Contract registry: consumer of ${entry.eventName} references unregistered job kind ${entry.jobKind}`,
    );
  }
}
