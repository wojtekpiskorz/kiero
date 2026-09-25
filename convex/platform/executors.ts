/**
 * Executor implementation registry (the composition point).
 *
 * One file imports every executor implementation so parallel lanes register
 * under their own owned files and this map stays the single dispatch table
 * keyed by job kind. Kinds without an implementation here fail closed with
 * the sanitized `unsupported` error in ./jobs.ts: a registration never
 * claims business work (honest-failure contract).
 *
 * Current implementations:
 * - `platform.echo_delivery` (./echo.ts): the external-delivery proof
 *   executor with uncertain-outcome recording and reconciliation.
 * - `processing.analyze_change_plan` (../processing/text/analyze.ts):
 *   the real text-analysis workflow over processingRuns/processingSteps
 *   through @convex-dev/workflow - the bounded agent loop, clarifications
 *   and checked per-group publication (replaces the mechanical proof
 *   executor behind the same seam; pipeline.ts keeps the mechanical proof
 *   workflow itself for its own crash/restart evidence).
 * - `processing.extract_fragments` (../processing/text/extract.ts): the
 *   durable reaction to `sources.sourceAccepted` - deterministic text
 *   extraction bookkeeping plus the follow-on analysis registration.
 * - `access.cleanup_revocation` (../access/membership/cleanup.ts): the
 *   durable revocation fan-out the access lane owns (device-session
 *   revocation after membership removal; the declared consumer proof of
 *   `access.membershipRevoked` / `access.sessionRevoked`).
 * - `memory.recompute_dependents` (../memory/recompute/executor.ts):
 *   the durable withdrawal-recomputation executor - the withdrawal marking
 *   plus the dependency-aware updating cascade and the linked re-analysis
 *   registrations (the declared consumer proof of `sources.sourceWithdrawn`,
 *   `memory.dependentsMarkedStale` and `memory.findingRevised`).
 * - `processing.transcribe_segment` (../processing/audio/executor.ts):
 *   the resumable per-segment STT workflow over one audio transcript order
 *   (the first model-call executor; the contracts amendment provider routing named as
 *   its prerequisite, registered in @kiero/contracts).
 * - `processing.normalize_photo` (../processing/images/executor.ts):
 *   the accepted-photo normalization executor (architecture protocol step
 *   4) with the echo-template uncertain-outcome semantics.
 * - `processing.join_multimodal` (../processing/multimodal/join.ts):
 *   the multimodal join over one mixed source's extraction outcomes —
 *   partial-safe analysis groups joined from text, transcript versions
 *   and normalized-photo vision extractions (text-only sources no-op here; the
 *   analyze owns them).
 * - `calendar.reconcile_outcome` (../calendar/sync/executor.ts): the
 *   per-copy Calendar reconciliation executor (observe before any retry,
 *   one bounded leg per attempt, uncertain outcomes block blind retries).
 * - `attention.evaluate_due_intents` (../attention/delivery/executor.ts):
 *   the durable notification-intent reaction to the three consumed
 *   events (acceptance creates source intents, a raised clarification
 *   creates the addressed agent-question intent, a published change set
 *   only wakes the evaluator).
 * - `search.index_generation` (../search/executor.ts): the versioned
 *   derived-index executor. Full generation builds through the embedding
 *   adapter plus the scoped lifecycle refreshes (withdrawal/purge drops a
 *   source's rows; a revised finding rebuilds from its current revision).
 * - `attention.deliver_push` (../attention/push/executor.ts): the
 *   web-push transport executor - one bounded per-device delivery pass
 *   per delivered notification intent (the declared consumer proof of
 *   `attention.intentDelivered`).
 * - `attention.schedule_task_reminders`
 *   (../attention/reminders/executor.ts): the durable task-reminder
 *   scheduling reaction to the work task events and bound-deadline
 *   revisions (the semantic slot recompute per task change).
 */

import type { FunctionReference } from "convex/server";
import type { DurableJobKind } from "@kiero/contracts";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { echoExecutor } from "./echo";
import { analyzeChangePlanExecutor as e3AnalyzeChangePlanExecutor } from "../processing/text/analyze";
import { extractFragmentsExecutor } from "../processing/text/extract";
import { cleanupRevocationExecutor } from "../access/membership/cleanup";
import { recomputeDependentsExecutor } from "../memory/recompute/executor";
import { transcribeSegmentExecutor } from "../processing/audio/executor";
import { normalizePhotoExecutor } from "../processing/images/executor";
// The multimodal-join executor.
import { joinMultimodalExecutor as e4JoinMultimodalExecutor } from "../processing/multimodal/join";
import { attentionIntentsExecutor } from "../attention/delivery/executor";
// The
// task-reminder scheduling executor implementation lives in the owned
// path; this registry entry is its composition point.
import { taskRemindersExecutor } from "../attention/reminders/executor";

// The web-push
// transport executor implementation lives in the owned path; this
// registry entry is its composition point.
import { pushDeliveryExecutor } from "../attention/push/executor";

// The
// calendar.reconcile_outcome executor implementation lives in the owned
// path; this registry entry is its composition point.
import { reconcileOutcomeExecutor } from "../calendar/sync/executor";

// The firm-export
// archive build executor implementation lives in the owned path
// (convex/operations/exports/executor.ts); this registry entry is its
// composition point.
import { buildArchiveExecutor } from "../operations/exports/executor";

// The
// search.index_generation executor implementation lives in the owned path
// (convex/search/executor.ts); this registry entry is its composition point.
import { searchIndexExecutor } from "../search/executor";

// The
// deletion.purge_source executor implementation lives in the owned path
// (convex/operations/deletion/executor.ts); this registry entry is its
// composition point.
import { purgeSourceExecutor } from "../operations/deletion/executor";

/** One durable job row (the executable counterpart of an outbox event). */
export type DurableJobDoc = Doc<"durableJobs">;

/** What one executor attempt decided. */
export type JobOutcome =
  | { readonly outcome: "succeeded" }
  | {
      readonly outcome: "failed";
      readonly errorKind: string;
      readonly retryable: boolean;
    }
  /** The effect leaves the transaction: the named action records the outcome. */
  | {
      readonly outcome: "external";
      readonly action: FunctionReference<"action", "internal">;
    }
  /** Durable continuation (workflow): its onComplete records the outcome. */
  | { readonly outcome: "delegated" };

/** One durable job executor for a job kind. */
export interface JobExecutor {
  readonly jobKind: DurableJobKind;
  execute(
    ctx: MutationCtx,
    job: DurableJobDoc,
    input: unknown,
  ): Promise<JobOutcome>;
  onSucceeded?(ctx: MutationCtx, job: DurableJobDoc): Promise<void>;
  onFailed?(ctx: MutationCtx, job: DurableJobDoc): Promise<void>;
}

/** The composed executor table. Later lanes append their own imports here. */
export const jobExecutors: Record<string, JobExecutor> = {
  [echoExecutor.jobKind]: echoExecutor,
  [e3AnalyzeChangePlanExecutor.jobKind]: e3AnalyzeChangePlanExecutor,
  [extractFragmentsExecutor.jobKind]: extractFragmentsExecutor,
  [cleanupRevocationExecutor.jobKind]: cleanupRevocationExecutor,
  [recomputeDependentsExecutor.jobKind]: recomputeDependentsExecutor,
  [transcribeSegmentExecutor.jobKind]: transcribeSegmentExecutor,
  [normalizePhotoExecutor.jobKind]: normalizePhotoExecutor,

  [e4JoinMultimodalExecutor.jobKind]: e4JoinMultimodalExecutor,
  [reconcileOutcomeExecutor.jobKind]: reconcileOutcomeExecutor,
  [attentionIntentsExecutor.jobKind]: attentionIntentsExecutor,

  // The derived-search executor.
  [searchIndexExecutor.jobKind]: searchIndexExecutor,
  [pushDeliveryExecutor.jobKind]: pushDeliveryExecutor,
  [taskRemindersExecutor.jobKind]: taskRemindersExecutor,

  // The firm-export archive build.
  [buildArchiveExecutor.jobKind]: buildArchiveExecutor,

  // The permanent-deletion purge.
  [purgeSourceExecutor.jobKind]: purgeSourceExecutor,
};
