/**
 * The `attention.evaluate_due_intents` executor (F2): the durable reaction
 * to the three intent-source events this lane consumes (issue 42:
 * "Consume F1 eligibility and E3 source assignment/agent-message events").
 *
 * The outbox drain projects each consumed event onto this job kind with a
 * dedup identity derived from the EVENT'S SUBJECT (source, clarification,
 * change set) — never from the outbox row — because the acceptance
 * transaction already registers `processing.extract_fragments` under the
 * row's key and one dedup key may never carry two job kinds. A replayed or
 * differently-keyed duplicate event therefore collapses onto the SAME job
 * row and the SAME semantic intents: duplicate suppression is structural.
 *
 * The trigger vocabulary is the generic assignment/agent-message state
 * contract (E4 later emits the same terminal states through these edges):
 *
 * - `source_accepted`: create the per-recipient `source_entry` intents
 *   (author excluded) anchored at durable all-attachment acceptance.
 * - `clarification_raised`: create the addressed agent-question intent
 *   (the source author may receive it about their own entry).
 * - `change_set_published`: create NOTHING (ordinary agent confirmations
 *   produce no push) and only wake the evaluator — the assignment
 *   classification may have gone terminal, and after analysis no new
 *   60-second window starts.
 */

import { Schema } from "effect";
import { executors } from "@kiero/contracts";
import type { Id } from "../../_generated/dataModel";
import type { JobExecutor, JobOutcome } from "../../platform/executors";
import {
  performEnsureClarificationIntents,
  performEnsureSourceIntents,
  performKickSourceEvaluation,
} from "./operations";

/** The decoded input of one attention-intents job (single typed reader). */
export interface AttentionIntentsJobInput {
  readonly trigger: "source_accepted" | "clarification_raised" | "change_set_published";
  readonly sourceId: string | null;
  readonly clarificationId: string | null;
  readonly changeSetId: string | null;
}

/** The registered executor for `attention.evaluate_due_intents`. */
export const attentionIntentsExecutor: JobExecutor = {
  jobKind: "attention.evaluate_due_intents",
  execute: async (ctx, job, input): Promise<JobOutcome> => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    // Decode authority: the registry executor schema for this kind.
    let decoded: AttentionIntentsJobInput;
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(input) as AttentionIntentsJobInput;
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    if (decoded.trigger === "source_accepted") {
      if (decoded.sourceId === null) {
        return { outcome: "failed", errorKind: "source_id_missing", retryable: false };
      }
      const sourceId = ctx.db.normalizeId("sources", decoded.sourceId);
      if (sourceId === null) {
        return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
      }
      const result = await performEnsureSourceIntents(ctx, sourceId);
      return result._tag === "ok"
        ? { outcome: "succeeded" }
        : { outcome: "failed", errorKind: result.error.code, retryable: false };
    }
    if (decoded.trigger === "clarification_raised") {
      if (decoded.clarificationId === null) {
        return { outcome: "failed", errorKind: "clarification_id_missing", retryable: false };
      }
      const clarificationId = ctx.db.normalizeId("clarifications", decoded.clarificationId);
      if (clarificationId === null) {
        return { outcome: "failed", errorKind: "clarification_id_invalid", retryable: false };
      }
      const result = await performEnsureClarificationIntents(ctx, clarificationId);
      return result._tag === "ok"
        ? { outcome: "succeeded" }
        : { outcome: "failed", errorKind: result.error.code, retryable: false };
    }
    // change_set_published: resolve the change set's source, wake nothing else.
    if (decoded.changeSetId === null) {
      return { outcome: "failed", errorKind: "change_set_id_missing", retryable: false };
    }
    const changeSetId = ctx.db.normalizeId("changeSets", decoded.changeSetId);
    if (changeSetId === null) {
      return { outcome: "failed", errorKind: "change_set_id_invalid", retryable: false };
    }
    const changeSet = await ctx.db.get(changeSetId);
    if (changeSet === null) {
      return { outcome: "failed", errorKind: "change_set_missing", retryable: false };
    }
    const result = await performKickSourceEvaluation(ctx, changeSet.sourceId as Id<"sources">);
    return result._tag === "ok"
      ? { outcome: "succeeded" }
      : { outcome: "failed", errorKind: result.error.code, retryable: false };
  },
};
