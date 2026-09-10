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
  featureEntry,
  type AnyEventEntry,
  type AnyOperationEntry,
  type EventConsumerEntry,
  type ExecutorEntry,
  type FeatureEntry,
} from "./registration";
import { accessOperations, accessEvents } from "./access";
import { sourcesOperations, sourcesEvents } from "./sources";
import { memoryOperations, memoryEvents } from "./memory";
import { projectsOperations, projectsEvents } from "./projects";
import { workOperations, workEvents } from "./work";
import { attentionOperations, attentionEvents } from "./attention";
import {
  calendarOperations,
  calendarEvents,
  CalendarRemoteOutcome,
} from "./calendar";
import { operationsOperations, operationsEvents } from "./operations";
import { searchOperations, searchEvents } from "./search";
import { integrationsOperations, integrationsEvents } from "./integrations";
import { platformOperations, platformEvents } from "./platform";

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
        throw new Error(
          `Contract registry: duplicate or mis-keyed entry: ${key}`,
        );
      }
      out[entry.name] = entry;
    }
  }
  return out;
}

/** All declared operations, keyed by operation name. */
export const operations: Record<string, AnyOperationEntry> =
  collect<AnyOperationEntry>(
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
    platformOperations,
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
  platformEvents,
);

// Executor input schemas (decode authority per job kind).

export const revokedAccessCleanupInput = Schema.Struct({
  kind: Schema.Literals(["membership", "session"]),
  membershipId: Schema.NullOr(tableIdSchema("memberships")),
  sessionId: Schema.NullOr(tableIdSchema("sessions")),
  // B3 amendment (issue #22): the drain projects the event payload onto this
  // input; `access.sessionRevoked` payloads carry no timestamp, so the
  // instant is optional and the executor stamps its own completion time.
  revokedAtMs: Schema.optionalKey(Schema.Number),
});

/**
 * The recomputation input (issue #28 owns this executor's edge). C5
 * amendment on the B3 input-shape precedent (additive, flagged): `reason`
 * and `withdrawnByUserId` join the certified shape as NULLABLE fields so
 * the drain can project event payloads that do not carry them, while the
 * withdrawal transaction registers the job with the real values — the
 * marking revisions record the withdrawal's reason and actor.
 */
export const recomputeDependentsInput = Schema.Struct({
  rootFindingId: Schema.NullOr(tableIdSchema("findings")),
  sourceId: Schema.NullOr(tableIdSchema("sources")),
  cause: Schema.Literals(["source_withdrawn", "dependent_stale", "reanalysis"]),
  reason: Schema.NullOr(Schema.NonEmptyString),
  withdrawnByUserId: Schema.NullOr(tableIdSchema("users")),
});

export const purgeSourceInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  deletionRecordId: tableIdSchema("deletionRecords"),
});

export const reconcileOutcomeInput = Schema.Struct({
  copyId: tableIdSchema("calendarCopies"),
  lastKnownOutcome: CalendarRemoteOutcome,
});

/**
 * E3 amendment (issue #37): the drain projects `sources.sourceAccepted`
 * onto this input, but the certified D1 payload carries no `extractionId`
 * (the acceptance transaction registers the extract job itself with the
 * real id). The id is therefore nullable: `null` means "resolve the
 * source's text extraction in-company" (exactly one exists per D1 source),
 * and the drain's registration collapses onto the publisher's row anyway
 * through the shared dedup key. The B3 precedent for input-shape
 * amendments made by the edge-owning lane.
 */
export const extractFragmentsInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  extractionId: Schema.NullOr(tableIdSchema("extractions")),
});

export const analyzeChangePlanInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  processingRunId: tableIdSchema("processingRuns"),
  reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
});

// D5 amendment (issue #33): the photo-normalization executor input. The
// accepted source's attachment ids ride the `sources.sourceAccepted` payload
// verbatim (audio attachments are skipped by the executor); the source id
// anchors tenancy and the deterministic job dedup key.
export const normalizePhotoInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  attachmentIds: Schema.Array(tableIdSchema("attachments")),
});

// A3 certification amendment: the platform's external-delivery proof executor.
export const echoDeliveryInput = Schema.Struct({
  dedupKey: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
});

// D6 amendment (flagged coordinated change, the B3 precedent): the first
// model-call job kind gets its executor registration — the prerequisite E2's
// dispatch named. Per-segment STT executes through the durable path; the
// transcript row is the order the workflow owns.
export const transcribeSegmentInput = Schema.Struct({
  transcriptId: tableIdSchema("audioTranscripts"),
});

// E4 amendment (flagged coordinated change, the D6 precedent): the
// multimodal-join executor input. `processingRunId` is the run the join
// anchors its steps to (the drain hands the reanalysis kicker's NEW run;
// null means "resolve the source's initial analysis run", exactly the way
// D6's orders anchor). The join composes E3 text planning with D5 vision
// representations and D6 transcript versions (issue #38).
export const joinMultimodalInput = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  processingRunId: Schema.NullOr(tableIdSchema("processingRuns")),
  reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
});
// F2 amendment (issue #42, flagged coordinated change on the B3/D5
// precedent): the notification-intent executor input. The drain projects
// the three consumed events onto this shape; the nullable ids let every
// trigger share one closed input (the B3 optional-field precedent), and
// the trigger vocabulary IS the generic assignment/agent-message state
// contract (E4 later emits the same terminal states through these edges).
export const attentionIntentsInput = Schema.Struct({
  trigger: Schema.Literals([
    "source_accepted",
    "clarification_raised",
    "change_set_published",
  ]),
  sourceId: Schema.NullOr(tableIdSchema("sources")),
  clarificationId: Schema.NullOr(tableIdSchema("clarifications")),
  changeSetId: Schema.NullOr(tableIdSchema("changeSets")),
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
  // D5 amendment (issue #33): the accepted-photo normalization executor
  // (architecture protocol step 4 — normalize before ordinary vision). It
  // consumes `sources.sourceAccepted` through its own edge; the extraction
  // job the acceptance transaction registers stays E3's.
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("processing.normalize"),
    jobKind: "processing.normalize_photo",
    input: normalizePhotoInput,
  }),
  // A3 certification amendment: the platform's external-delivery proof
  // executor (echo stand-in; business lanes keep their own kinds).
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("platform.echo"),
    jobKind: "platform.echo_delivery",
    input: echoDeliveryInput,
  }),
  // D6 amendment (flagged coordinated change): the durable per-segment STT
  // executor over one transcript order (resumable, checkpointed per
  // segment; `convex/processing/audio/executor.ts` implements it).
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("processing.transcribe"),
    jobKind: "processing.transcribe_segment",
    input: transcribeSegmentInput,
  }),
  // E4 amendment (flagged coordinated change): the multimodal-join executor
  // (`convex/processing/multimodal/join.ts` implements it). It no-ops
  // text-only sources (E3's analyze owns those) and joins extraction
  // outcomes into partial-safe analysis groups for mixed ones.
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("processing.join"),
    jobKind: "processing.join_multimodal",
    input: joinMultimodalInput,
  }),
  // F2 amendment (issue #42, flagged coordinated change): the durable
  // notification-intent executor — intent creation from the consumed
  // events plus the due-time evaluator kick
  // (`convex/attention/delivery/executor.ts` implements it).
  executorEntry({
    kind: "executor",
    executorId: decodeFeatureId("attention.evaluate"),
    jobKind: "attention.evaluate_due_intents",
    input: attentionIntentsInput,
  }),
];

function consumer(
  eventName: string,
  jobKind: EventConsumerEntry["jobKind"],
): EventConsumerEntry {
  return eventConsumerEntry({ kind: "event_consumer", eventName, jobKind });
}

/**
 * Durable event consumers declared so far: the four cross-module outcomes the
 * architecture names explicitly (access-revocation cleanup, reanalysis,
 * deletion, Calendar outcomes) plus the publication pipeline seams. Each
 * edge belongs to whichever executor owns its job kind; the feature
 * attribution below is derived from that, never hand-written.
 */
export const eventConsumers: readonly EventConsumerEntry[] = [
  // Access revocation must invalidate derived access and media checks.
  consumer("access.membershipRevoked", "access.cleanup_revocation"),
  consumer("access.sessionRevoked", "access.cleanup_revocation"),
  // Withdrawal/purge re-evaluates dependent findings; history retained.
  consumer("sources.sourceWithdrawn", "memory.recompute_dependents"),
  consumer("memory.dependentsMarkedStale", "memory.recompute_dependents"),
  // C5 registration (issue #28 owns the revalidation half of this edge):
  // every revised finding drains into one bounded dependent walk — a basis
  // that became non-known propagates updating markings through the
  // dependentsMarkedStale cascade; a basis that became known again
  // revalidates its updating dependents by registering their linked
  // re-analysis. Later independent confirmations and explicit corrections
  // keep their authority; the walk never writes over a newer revision.
  consumer("memory.findingRevised", "memory.recompute_dependents"),
  // Permanent deletion purges derivatives within the accepted window.
  consumer("sources.sourcePurged", "deletion.purge_source"),
  // Unknown Calendar outcomes always reconcile before another POST.
  consumer("calendar.copyOutcomeRecorded", "calendar.reconcile_outcome"),
  // Accepted sources register durable extraction atomically; the extract
  // executor owns `processing.extract_fragments`, so this edge belongs to
  // the processing.extract feature (the earlier hand-written attribution to
  // processing.analyze was the inconsistency; the executor table is the
  // authority and its input shape is extraction, not change-plan analysis).
  consumer("sources.sourceAccepted", "processing.extract_fragments"),
  // D5 amendment (issue #33): acceptance also fans out photo normalization
  // (protocol step 4) through its own consumer edge; the drain projects the
  // event payload onto both edges and each job carries a distinct dedup key.
  consumer("sources.sourceAccepted", "processing.normalize_photo"),
  // Requested reanalysis runs as a linked new analysis run.
  consumer("operations.reanalysisRequested", "processing.analyze_change_plan"),
  // E4 amendment (flagged coordinated change): acceptance also fans out the
  // multimodal join (STT ordering + the joined partial-safe analysis), and
  // a requested reanalysis of a MIXED source re-joins it through the same
  // edge (text-only sources no-op inside the executor).
  consumer("sources.sourceAccepted", "processing.join_multimodal"),
  consumer("operations.reanalysisRequested", "processing.join_multimodal"),
  // A3 certification amendment: the platform's echo publication drains into
  // its own durable delivery job through the same edge mechanism.
  consumer("platform.echoRequested", "platform.echo_delivery"),
  // F2 amendment (issue #42, flagged coordinated change): the three
  // intent-source events drain into the notification-intent executor.
  // Acceptance creates the per-recipient source intents; a raised
  // clarification creates the addressed agent-question intent; a published
  // change set creates NOTHING (ordinary agent confirmations produce no
  // push) and only wakes the evaluator because the assignment may have
  // gone terminal. Each edge's projection derives its own dedup identity
  // from the event's SUBJECT, never the outbox row (the acceptance row's
  // key already carries `processing.extract_fragments`).
  consumer("sources.sourceAccepted", "attention.evaluate_due_intents"),
  consumer("memory.clarificationRaised", "attention.evaluate_due_intents"),
  consumer("memory.changeSetPublished", "attention.evaluate_due_intents"),
];

/**
 * The initial feature registrations, DERIVED from the executor table: one
 * feature per executor, keyed by its id. `consumesEvents` groups the
 * registered consumer edges on job kind (an edge belongs to the executor
 * owning its job kind) and `executesJobs` is exactly that job kind, so the
 * three encodings cannot disagree. Only `providesOperations` and
 * `publishesEvents` are hand-written; they stay empty until the owning
 * lanes declare their surface.
 */
export const features: readonly FeatureEntry[] = executors.map((executor) =>
  featureEntry({
    kind: "feature",
    featureId: executor.executorId,
    providesOperations: [],
    publishesEvents: [],
    consumesEvents: eventConsumers
      .filter((edge) => edge.jobKind === executor.jobKind)
      .map((edge) => edge.eventName),
    executesJobs: [executor.jobKind],
  }),
);

// Fail fast on impossible registrations (module surface name drift).

/**
 * Throws if two executors claim the same job kind. Exported so the
 * construction-time guarantee itself is under test: a silent Set collapse
 * here would let two lanes believe they own one job kind.
 */
export function assertNoDuplicateExecutors(
  list: readonly ExecutorEntry[],
): Set<string> {
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

/**
 * Throws if a hand-written part of a feature registration (provided
 * operations, published events) references a name no module surface
 * declared. Exported so the construction-time guarantee itself is under
 * test. The derived parts (consumed events, executed job kinds) are checked
 * by {@link assertFeaturesCoverRegistrations} instead.
 */
export function assertFeaturesCoherent(
  list: readonly FeatureEntry[],
  knownOperations: Readonly<Record<string, unknown>>,
  knownEvents: Readonly<Record<string, unknown>>,
): void {
  for (const feature of list) {
    for (const name of feature.providesOperations) {
      if (!(name in knownOperations)) {
        throw new Error(
          `Contract registry: feature ${feature.featureId} provides unknown operation ${name}`,
        );
      }
    }
    for (const name of [
      ...feature.publishesEvents,
      ...feature.consumesEvents,
    ]) {
      if (!(name in knownEvents)) {
        throw new Error(
          `Contract registry: feature ${feature.featureId} references unknown event ${name}`,
        );
      }
    }
  }
}

/**
 * Cross-check that the derived feature edges equal the declared
 * registrations: every executor's job kind appears in exactly one feature
 * with exactly that feature's consumed edges for the kind, and every
 * consumer edge is covered. Throws otherwise. Exported so the
 * construction-time guarantee itself is under test.
 */
export function assertFeaturesCoverRegistrations(
  list: readonly FeatureEntry[],
  registeredExecutors: readonly ExecutorEntry[],
  registeredConsumers: readonly EventConsumerEntry[],
): void {
  for (const executor of registeredExecutors) {
    const owning = list.filter((feature) =>
      feature.executesJobs.includes(executor.jobKind),
    );
    if (owning.length !== 1) {
      throw new Error(
        `Contract registry: job kind ${executor.jobKind} is executed by ${owning.length} features, expected exactly 1`,
      );
    }
    const feature = owning[0];
    if (feature === undefined) {
      throw new Error(
        `Contract registry: job kind ${executor.jobKind} has no feature`,
      );
    }
    const derivedEdges = registeredConsumers
      .filter((edge) => edge.jobKind === executor.jobKind)
      .map((edge) => edge.eventName)
      .sort();
    const declaredEdges = [...feature.consumesEvents].sort();
    if (
      derivedEdges.length !== declaredEdges.length ||
      derivedEdges.some((name, i) => name !== declaredEdges[i])
    ) {
      throw new Error(
        `Contract registry: feature ${feature.featureId} consumed edges diverge from the registered consumer edges for ${executor.jobKind}`,
      );
    }
  }
}

const registeredJobKinds = assertNoDuplicateExecutors(executors);
for (const entry of eventConsumers) {
  if (!(entry.eventName in events)) {
    throw new Error(
      `Contract registry: consumer references unknown event ${entry.eventName}`,
    );
  }
  if (!registeredJobKinds.has(entry.jobKind)) {
    throw new Error(
      `Contract registry: consumer of ${entry.eventName} references unregistered job kind ${entry.jobKind}`,
    );
  }
}
assertFeaturesCoherent(features, operations, events);
assertFeaturesCoverRegistrations(features, executors, eventConsumers);
