/**
 * The `calendar.reconcile_outcome` durable executor (G3).
 *
 * The certified consumer edge (A3's registry,
 * `calendar.copyOutcomeRecorded -> calendar.reconcile_outcome`) lands here:
 * every RECORDED OUTCOME CHANGE durably schedules ONE bounded
 * reconciliation of that copy. Together with the sync pass this is the
 * convergence loop the issue demands:
 *
 *   outcome unknown recorded -> job -> ONE observation leg -> outcome
 *   confirmed/absent recorded (a change) -> job -> ONE leg -> converged
 *   (no change) -> no event -> the loop ends.
 *
 * Uncertain legs fail the job with the uncertain `externalOutcome`, so the
 * platform's registration guard (`decideJobRegistration` /
 * `isUncertainJobFailure`) blocks every blind replay; only an observation
 * — this executor's observe legs, or the pass — may move the copy again.
 */

import type { FunctionReference } from "convex/server";
import type { JobExecutor, JobOutcome } from "../../platform/executors";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";

/** The external action that performs the leg (prepare -> leg -> record). */
const reconcileAttemptAction: FunctionReference<"action", "internal"> =
  internal.calendar.sync.functions.runReconcileOutcomeAttempt;

export const reconcileOutcomeExecutor: JobExecutor = {
  jobKind: "calendar.reconcile_outcome",
  execute: async (_ctx: MutationCtx, _job): Promise<JobOutcome> => {
    // The effect leaves the transaction; the action records the outcome
    // itself (succeeded / failed / uncertain timeout-unknown).
    return { outcome: "external", action: reconcileAttemptAction };
  },
};
