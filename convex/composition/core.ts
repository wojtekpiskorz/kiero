/**
 * The final core composition entry, Convex half (J2, issue #61).
 *
 * The full-flow join owns this explicit cross-module composition: ONE
 * module that names what "the complete core backend" IS at this join and
 * validates it loudly at import time, so drift between the contracts
 * inventory, the composed schema and the executor registry fails HERE,
 * in a node test or a deploy, instead of surfacing as an unsupported job
 * kind or a missing table in production.
 *
 * What this entry validates (nothing here executes business work):
 *
 * 1. SCHEMA: importing this module imports the composed schema entry
 *    (convex/schema.ts), whose own construction-time checks prove the
 *    fragments compose without duplicates and match the closed
 *    `TABLE_ID_NAMES` inventory in both directions.
 * 2. EXECUTORS: every durable job kind the CORE flow depends on (the
 *    capture -> extraction -> analysis -> publication -> retrieval ->
 *    attention chain plus the recovery/recomputation edges) has a
 *    registered executor in the platform table. Kinds the core does not
 *    exercise yet (exports, backups, purge, the I-lane scope) are
 *    explicitly NOT claimed and stay outside this set.
 * 3. OPERATIONS/EVENTS: the core's producer/consumer seams name entries
 *    that exist in the composed contracts registries (the join's declared
 *    wiring: E4 extraction feeding E5 indexing, E6 tools over C2-C4
 *    operations, C5 recomputation on withdrawal, B3 cleanup on
 *    revocation, F1/F4 attention state over the same membership reads).
 *
 * J3 consumes this module as the qualification baseline; J5's audit reads
 * its evidence.
 */

import { Schema } from "effect";
import { DurableJobKind, events, operations } from "@kiero/contracts";
// The composed schema entry: importing it runs its construction-time
// composition checks (duplicate tables, inventory equality).
import schema from "../schema";
import { jobExecutors } from "../platform/executors";

/** The schema composition this core is built on (identity re-export). */
export const composedCoreSchema = schema;

/**
 * The durable job kinds the complete core flow depends on at this join.
 * Each must have a registered executor; each executor's job kind must be
 * part of the closed contracts vocabulary.
 */
export const CORE_JOB_KINDS: readonly string[] = [
  // Capture-to-memory chain.
  "processing.transcribe_segment",
  "processing.extract_fragments",
  "processing.analyze_change_plan",
  "processing.normalize_photo",
  "processing.join_multimodal",
  // Publication/recomputation and recovery.
  "memory.recompute_dependents",
  "access.cleanup_revocation",
  // Retrieval and attention over the published core.
  "search.index_generation",
  "attention.evaluate_due_intents",
  "attention.schedule_task_reminders",
  "attention.deliver_push",
  // Calendar projection over the same work rows (the joined surface).
  "calendar.reconcile_outcome",
  // The platform's external-delivery proof executor.
  "platform.echo_delivery",
];

/** The core's declared operation seams (commands the joined flow issues). */
export const CORE_OPERATION_SEAMS: readonly string[] = [
  "sources.prepareUpload",
  "sources.acceptSource",
  "sources.withdrawSource",
  "memory.readCurrentFindings",
  "work.changeTask",
  "work.changeEvent",
  "attention.markSourceRead",
  "attention.snoozeTaskReminders",
  "search.queryEvidence",
];

/** The core's declared event seams (producer/consumer wiring anchors). */
export const CORE_EVENT_SEAMS: readonly string[] = [
  "sources.sourceAccepted",
  "sources.sourceWithdrawn",
  "memory.findingRevised",
  "operations.reanalysisRequested",
  "access.membershipRevoked",
  "access.sessionRevoked",
];

/** One problem found by {@link validateCoreComposition}. */
export interface CoreCompositionProblem {
  readonly kind: "executor_missing" | "job_kind_outside_contracts" | "operation_missing" | "event_missing";
  readonly name: string;
}

/** The validated composition summary (for tests and evidence). */
export interface CoreComposition {
  readonly jobKinds: readonly string[];
  readonly executorCount: number;
  readonly problems: readonly CoreCompositionProblem[];
}

/**
 * Validates the complete core composition. Pure over the imported
 * registries: same inputs, same problems. An empty `problems` list is the
 * join's green light; anything else is drift that must fail loudly.
 */
export function validateCoreComposition(): CoreComposition {
  const problems: CoreCompositionProblem[] = [];
  const isClosedKind = Schema.is(DurableJobKind);
  for (const kind of CORE_JOB_KINDS) {
    if (!isClosedKind(kind)) {
      problems.push({ kind: "job_kind_outside_contracts", name: kind });
    }
    if (!(kind in jobExecutors)) {
      problems.push({ kind: "executor_missing", name: kind });
    }
  }
  for (const operation of CORE_OPERATION_SEAMS) {
    if (!(operation in operations)) {
      problems.push({ kind: "operation_missing", name: operation });
    }
  }
  for (const eventName of CORE_EVENT_SEAMS) {
    if (!(eventName in events)) {
      problems.push({ kind: "event_missing", name: eventName });
    }
  }
  return {
    jobKinds: CORE_JOB_KINDS,
    executorCount: Object.keys(jobExecutors).length,
    problems,
  };
}

/** Runs the validation and THROWS on any drift (the loud gate). */
export function coreCompositionOrThrow(): CoreComposition {
  const composition = validateCoreComposition();
  if (composition.problems.length > 0) {
    const listed = composition.problems
      .map((problem) => `${problem.kind}: ${problem.name}`)
      .join("; ");
    throw new Error(`Core composition drift: ${listed}`);
  }
  return composition;
}
