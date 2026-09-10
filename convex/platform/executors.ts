/**
 * Executor implementation registry (A3 composition point).
 *
 * One file imports every executor implementation so parallel lanes register
 * under their own owned files and this map stays the single dispatch table
 * keyed by job kind. Kinds without an implementation here fail closed with
 * the sanitized `unsupported` error in ./jobs.ts: a registration never
 * claims business work (A2 honest-failure contract).
 *
 * Current implementations:
 * - `platform.echo_delivery` (./echo.ts): the external-delivery proof
 *   executor with uncertain-outcome recording and reconciliation.
 * - `processing.analyze_change_plan` (../processing/text/analyze.ts, E3):
 *   the real text-analysis workflow over processingRuns/processingSteps
 *   through @convex-dev/workflow - the bounded agent loop, clarifications
 *   and checked per-group publication (replaces the A3 mechanical proof
 *   executor behind the same seam; pipeline.ts keeps the mechanical proof
 *   workflow itself for its own crash/restart evidence).
 * - `processing.extract_fragments` (../processing/text/extract.ts, E3): the
 *   durable reaction to `sources.sourceAccepted` - deterministic text
 *   extraction bookkeeping plus the follow-on analysis registration.
 * - `access.cleanup_revocation` (../access/membership/cleanup.ts, B3): the
 *   durable revocation fan-out the access lane owns (device-session
 *   revocation after membership removal; the declared consumer proof of
 *   `access.membershipRevoked` / `access.sessionRevoked`).
 * - `memory.recompute_dependents` (../memory/recompute/executor.ts, C5):
 *   the durable withdrawal-recomputation executor - the withdrawal marking
 *   plus the dependency-aware updating cascade and the linked re-analysis
 *   registrations (the declared consumer proof of `sources.sourceWithdrawn`,
 *   `memory.dependentsMarkedStale` and `memory.findingRevised`).
 * - `processing.transcribe_segment` (../processing/audio/executor.ts, D6):
 *   the resumable per-segment STT workflow over one audio transcript order
 *   (the first model-call executor; the contracts amendment E2 named as
 *   its prerequisite, registered in @kiero/contracts by D6, flagged).
 * - `processing.normalize_photo` (../processing/images/executor.ts, D5):
 *   the accepted-photo normalization executor (architecture protocol step
 *   4) with the echo-template uncertain-outcome semantics.
 * - `processing.join_multimodal` (../processing/multimodal/join.ts, E4):
 *   the multimodal join over one mixed source's extraction outcomes —
 *   partial-safe analysis groups joined from text, D6 transcript versions
 *   and D5-backed vision extractions (text-only sources no-op here; E3's
 *   analyze owns them).
 * - `calendar.reconcile_outcome` (../calendar/sync/executor.ts, G3): the
 *   per-copy Calendar reconciliation executor (observe before any retry,
 *   one bounded leg per attempt, uncertain outcomes block blind retries).
 * - `attention.evaluate_due_intents` (../attention/delivery/executor.ts,
 *   F2): the durable notification-intent reaction to the three consumed
 *   events (acceptance creates source intents, a raised clarification
 *   creates the addressed agent-question intent, a published change set
 *   only wakes the evaluator).
 * - `attention.deliver_push` (../attention/push/executor.ts, F3): the
 *   web-push transport executor - one bounded per-device delivery pass
 *   per delivered notification intent (the declared consumer proof of
 *   `attention.intentDelivered`).
 * - `attention.schedule_task_reminders`
 *   (../attention/reminders/executor.ts, F4): the durable task-reminder
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
// E4 amendment (flagged coordinated change): the multimodal-join executor.
import { joinMultimodalExecutor as e4JoinMultimodalExecutor } from "../processing/multimodal/join";
import { attentionIntentsExecutor } from "../attention/delivery/executor";
// F4 append (flagged shared-file change, the F2 precedent): the
// task-reminder scheduling executor implementation lives in F4's owned
// path; this registry entry is its composition point.
import { taskRemindersExecutor } from "../attention/reminders/executor";

// F3 append (flagged shared-file change, the G3 precedent): the web-push
// transport executor implementation lives in F3's owned path; this
// registry entry is its composition point.
import { pushDeliveryExecutor } from "../attention/push/executor";

// G3 append (flagged shared-file change, the D5/D6 precedent): the
// calendar.reconcile_outcome executor implementation lives in G3's owned
// path; this registry entry is its composition point.
import { reconcileOutcomeExecutor } from "../calendar/sync/executor";

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

  [pushDeliveryExecutor.jobKind]: pushDeliveryExecutor,
  [taskRemindersExecutor.jobKind]: taskRemindersExecutor,
};
