/**
 * The `attention.schedule_task_reminders` executor (F4): the durable
 * reaction to the task events this lane consumes (issue 44: "Consume C4
 * current task/event contracts").
 *
 * The outbox drain projects each consumed event onto this job kind with a
 * dedup identity derived from the EVENT'S SUBJECT AND REVISION (the work
 * lane's canonical `work.<event>:<id>:<revision>` key rides the row, so
 * every distinct task change registers its own job while replays
 * collapse):
 *
 * - `work.taskChanged`: one task's identity, responsibility or deadline
 *   binding moved (creation included) - recompute its schedule.
 * - `work.taskStateChanged`: the task closed or reopened - recompute
 *   (closing removes future reminders; reopening re-derives the slots).
 * - `memory.findingRevised`: the bound deadline finding's CURRENT value
 *   moved (a date correction does not touch the task row) - recompute
 *   every task of that finding's company bound to it; the due-time
 *   re-check is the backstop for tasks not reached by the bounded scan.
 *
 * The recompute reads the task's CURRENT rows, so any number of collapsed
 * duplicate registrations converges on the same schedule.
 */

import { Schema } from "effect";
import { executors } from "@kiero/contracts";
import type { JobExecutor, JobOutcome } from "../../platform/executors";
import { performRecomputeTaskReminders } from "./operations";

/** How many bound tasks one finding-revision scan recomputes (bounded). */
const FINDING_SCAN_LIMIT = 50;

/** The decoded input of one reminder-scheduling job (single typed reader). */
export interface TaskRemindersJobInput {
  readonly trigger: "task_changed" | "task_state_changed" | "finding_revised";
  readonly taskId: string | null;
  readonly findingId: string | null;
}

/** The registered executor for `attention.schedule_task_reminders`. */
export const taskRemindersExecutor: JobExecutor = {
  jobKind: "attention.schedule_task_reminders",
  execute: async (ctx, job, input): Promise<JobOutcome> => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    // Decode authority: the registry executor schema for this kind.
    let decoded: TaskRemindersJobInput;
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(input) as TaskRemindersJobInput;
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    if (decoded.trigger !== "finding_revised") {
      if (decoded.taskId === null) {
        return { outcome: "failed", errorKind: "task_id_missing", retryable: false };
      }
      const taskId = ctx.db.normalizeId("tasks", decoded.taskId);
      if (taskId === null) {
        return { outcome: "failed", errorKind: "task_id_invalid", retryable: false };
      }
      const result = await performRecomputeTaskReminders(ctx, taskId, Date.now());
      return result._tag === "ok"
        ? { outcome: "succeeded" }
        : { outcome: "failed", errorKind: result.error.code, retryable: false };
    }
    // finding_revised: recompute every task bound to the revised finding.
    if (decoded.findingId === null) {
      return { outcome: "failed", errorKind: "finding_id_missing", retryable: false };
    }
    const findingId = ctx.db.normalizeId("findings", decoded.findingId);
    if (findingId === null) {
      return { outcome: "failed", errorKind: "finding_id_invalid", retryable: false };
    }
    const finding = await ctx.db.get(findingId);
    if (finding === null) {
      return { outcome: "failed", errorKind: "finding_missing", retryable: false };
    }
    const bound = await ctx.db
      .query("tasks")
      .withIndex("by_company_state", (q) => q.eq("companyId", finding.companyId))
      .filter((q) => q.eq(q.field("deadlineFindingId"), findingId))
      .take(FINDING_SCAN_LIMIT);
    for (const task of bound) {
      const result = await performRecomputeTaskReminders(ctx, task._id, Date.now());
      if (result._tag === "error") {
        return { outcome: "failed", errorKind: result.error.code, retryable: false };
      }
    }
    return { outcome: "succeeded" };
  },
};
