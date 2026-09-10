/**
 * The `attention.deliver_push` durable executor (F3).
 *
 * The certified consumer edge (A2/A3's registry, `attention.intentDelivered
 * -> attention.deliver_push`, projected by the outbox drain) lands here:
 * every delivered notification intent gets ONE bounded per-device push
 * pass. The transport POST cannot run inside a mutation transaction, so
 * the executor hands the leg to its action half (the G3 external-action
 * template); every durable decision happens in that action's
 * prepare/complete mutation pair.
 *
 * The job kind was part of the certified A2 vocabulary from the start
 * (`packages/contracts/src/jobs.ts`); this lane registers its executor
 * input and implementation (the sanctioned registry append).
 */

import { Schema } from "effect";
import { executors } from "@kiero/contracts";
import type { FunctionReference } from "convex/server";
import type { JobExecutor, JobOutcome } from "../../platform/executors";
import { internal } from "../../_generated/api";

/** The external action that performs the legs (prepare -> legs -> record). */
const pushAttemptAction: FunctionReference<"action", "internal"> =
  internal.attention.push.functions.runPushDeliveryAttempt;

export const pushDeliveryExecutor: JobExecutor = {
  jobKind: "attention.deliver_push",
  execute: async (_ctx, job): Promise<JobOutcome> => {
    // Decode authority: the registry executor schema for this kind. The
    // input's intent id is re-validated inside the action's prepare.
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    try {
      Schema.decodeUnknownSync(entry.input)(JSON.parse(job.inputJson));
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    // The effect leaves the transaction; the action records the outcome
    // itself (succeeded/failed/retryable per the per-device row states).
    return { outcome: "external", action: pushAttemptAction };
  },
};
