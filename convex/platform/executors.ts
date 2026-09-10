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
 *   through @convex-dev/workflow — the bounded agent loop, clarifications
 *   and checked per-group publication (replaces the A3 mechanical proof
 *   executor behind the same seam; pipeline.ts keeps the mechanical proof
 *   workflow itself for its own crash/restart evidence).
 * - `processing.extract_fragments` (../processing/text/extract.ts, E3): the
 *   durable reaction to `sources.sourceAccepted` — deterministic text
 *   extraction bookkeeping plus the follow-on analysis registration.
 * - `access.cleanup_revocation` (../access/membership/cleanup.ts, B3): the
 *   durable revocation fan-out the access lane owns (device-session
 *   revocation after membership removal; the declared consumer proof of
 *   `access.membershipRevoked` / `access.sessionRevoked`).
 */

import type { FunctionReference } from "convex/server";
import type { DurableJobKind } from "@kiero/contracts";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { echoExecutor } from "./echo";
import { analyzeChangePlanExecutor as e3AnalyzeChangePlanExecutor } from "../processing/text/analyze";
import { extractFragmentsExecutor } from "../processing/text/extract";
import { cleanupRevocationExecutor } from "../access/membership/cleanup";

/** One durable job row (the executable counterpart of an outbox event). */
export type DurableJobDoc = Doc<"durableJobs">;

/** What one executor attempt decided. */
export type JobOutcome =
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "failed"; readonly errorKind: string; readonly retryable: boolean }
  /** The effect leaves the transaction: the named action records the outcome. */
  | { readonly outcome: "external"; readonly action: FunctionReference<"action", "internal"> }
  /** Durable continuation (workflow): its onComplete records the outcome. */
  | { readonly outcome: "delegated" };

/** One durable job executor for a job kind. */
export interface JobExecutor {
  readonly jobKind: DurableJobKind;
  execute(ctx: MutationCtx, job: DurableJobDoc, input: unknown): Promise<JobOutcome>;
  onSucceeded?(ctx: MutationCtx, job: DurableJobDoc): Promise<void>;
  onFailed?(ctx: MutationCtx, job: DurableJobDoc): Promise<void>;
}

/** The composed executor table. Later lanes append their own imports here. */
export const jobExecutors: Record<string, JobExecutor> = {
  [echoExecutor.jobKind]: echoExecutor,
  [e3AnalyzeChangePlanExecutor.jobKind]: e3AnalyzeChangePlanExecutor,
  [extractFragmentsExecutor.jobKind]: extractFragmentsExecutor,
  [cleanupRevocationExecutor.jobKind]: cleanupRevocationExecutor,
};
