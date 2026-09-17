/**
 * The answer loop's recording half (R25, issue #230): the durable
 * answerRuns/answerTurns rows the E6 loop writes from its existing
 * checkpoints — run start, each provider turn, run finish. Pure
 * instrumentation: NO loop behavior changes; the fix the recorded evidence
 * decides is a separate repair.
 *
 * Write discipline:
 *
 * - the loop is an ACTION, so each record lands through ONE internal
 *   mutation, replay-safe by key: the run row is insert-if-absent per
 *   `runId`, each turn row insert-if-absent per (`runId`, `turnIndex`), and
 *   the finalize step patches the run row (a patch with the same values is
 *   its own replay). Convex 1.45 has no unique indexes, so idempotency is
 *   the by-index lookup before insert inside the mutation.
 * - crashes stay honest: a run row without an outcome IS an unfinished run;
 *   turn rows exist exactly for the turns that happened.
 * - the loop-facing helpers (`noteRunStart`/`noteTurn`/`noteRunFinalized`)
 *   are BEST-EFFORT: a recording failure (transient storage, id validation)
 *   is swallowed — instrumentation must never fail an ask that would
 *   otherwise succeed.
 * - sanitization by shape (the I2 diagnosticEvents discipline): names,
 *   closed codes/classes, counts, latencies and ONE bounded excerpt enter
 *   these rows; raw payloads, arguments, prompts and transcripts have no
 *   field to land in, and the helpers bound every untrusted string before
 *   the mutation sees it.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ValueValidator } from "../schema/shared";
import {
  ANSWER_RUN_OUTCOMES,
  ANSWER_TURN_CALLS_ORIGINS,
  ANSWER_TURN_FAILURE_KINDS,
  ANSWER_TURN_FINISH_CLASSES,
  ANSWER_TURN_OUTCOMES,
  type AnswerRunOutcome,
  type AnswerTurnCallsOrigin,
  type AnswerTurnFailureKind,
  type AnswerTurnFinishClass,
  type AnswerTurnOutcome,
} from "./schema";

/** The final-text excerpt bound (the answer result's own finalText bound). */
export const ANSWER_EXCERPT_MAX_CHARS = 600 as const;

/** Defensive caps on the untrusted name/code arrays (never raw payloads). */
export const ANSWER_TURN_NAMES_MAX = 16 as const;
export const ANSWER_TURN_CODES_MAX = 16 as const;

/**
 * One closed string vocabulary's validator, built from its constant list in
 * ./schema.ts (the calendar/sync fragment's pattern: the argument validators
 * and the table columns share the single spelling, so drift fails here).
 */
function vocabularyOf<T extends string>(kinds: readonly T[]): ValueValidator<T> {
  return v.union(...kinds.map((kind) => v.literal(kind)));
}

const runOutcomeArg = vocabularyOf(ANSWER_RUN_OUTCOMES);
const turnOutcomeArg = vocabularyOf(ANSWER_TURN_OUTCOMES);
const finishClassArg = vocabularyOf(ANSWER_TURN_FINISH_CLASSES);
const failureKindArg = vocabularyOf(ANSWER_TURN_FAILURE_KINDS);
const callsOriginArg = vocabularyOf(ANSWER_TURN_CALLS_ORIGINS);

// ---------------------------------------------------------------------------
// The transactional writes (plain functions, the search/records.ts
// precedent: testable offline against the in-memory db, registered below).
// ---------------------------------------------------------------------------

/** The run-start input: what the loop knows when its context load succeeded. */
export interface AnswerRunStartInput {
  readonly runId: string;
  readonly questionSourceId: Id<"sources">;
  readonly pipelineVersion: string;
  readonly modelConfigurationVersion: string;
}

/** One provider turn's sanitized observation, as the loop saw it. */
export interface AnswerTurnInput {
  readonly runId: string;
  readonly turnIndex: number;
  readonly outcome: AnswerTurnOutcome;
  readonly finishReasonClass: AnswerTurnFinishClass;
  readonly failureKind?: AnswerTurnFailureKind;
  readonly provider?: "deepseek" | "openrouter";
  readonly observedModel?: string;
  readonly attemptCount: number;
  readonly toolCallNames: readonly string[];
  readonly callsOrigin: AnswerTurnCallsOrigin;
  readonly argumentDecodeFailureCodes: readonly string[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/** The finalize input: the finished run's outcome envelope. */
export interface AnswerRunFinalizedInput {
  readonly runId: string;
  readonly outcome: AnswerRunOutcome;
  readonly failureKind?: AnswerTurnFailureKind;
  readonly turnCount: number;
  readonly refreshCount: number;
  readonly observedModels: readonly string[];
  readonly finalTextExcerpt: string;
}

/** Looks up the run row by its idempotency key. */
async function runRow(tx: MutationCtx, runId: string) {
  return tx.db
    .query("answerRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

/**
 * Writes the run-start row, insert-if-absent per `runId`. The tenant scope
 * is resolved server-side from the question source row (the action never
 * supplies it); a vanished source still records the run, just unscoped.
 */
export async function writeAnswerRunStart(
  tx: MutationCtx,
  input: AnswerRunStartInput,
): Promise<{ inserted: boolean }> {
  const existing = await runRow(tx, input.runId);
  if (existing !== null) {
    return { inserted: false };
  }
  const source = await tx.db.get(input.questionSourceId);
  await tx.db.insert("answerRuns", {
    runId: input.runId,
    questionSourceId: input.questionSourceId,
    ...(source === null ? {} : { companyId: source.companyId }),
    pipelineVersion: input.pipelineVersion,
    modelConfigurationVersion: input.modelConfigurationVersion,
    startedAtMs: Date.now(),
  });
  return { inserted: true };
}

/**
 * Writes one provider-turn row, insert-if-absent per (`runId`, `turnIndex`)
 * — replaying the same turn's mutation inserts nothing. The latency is
 * computed server-side from the loop's two trusted timestamps.
 */
export async function writeAnswerTurn(
  tx: MutationCtx,
  input: AnswerTurnInput,
): Promise<{ inserted: boolean }> {
  const existing = await tx.db
    .query("answerTurns")
    .withIndex("by_run_turn", (q) => q.eq("runId", input.runId).eq("turnIndex", input.turnIndex))
    .unique();
  if (existing !== null) {
    return { inserted: false };
  }
  await tx.db.insert("answerTurns", {
    runId: input.runId,
    turnIndex: input.turnIndex,
    outcome: input.outcome,
    finishReasonClass: input.finishReasonClass,
    ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.observedModel === undefined ? {} : { observedModel: input.observedModel }),
    attemptCount: input.attemptCount,
    toolCallNames: [...input.toolCallNames],
    callsOrigin: input.callsOrigin,
    argumentDecodeFailureCodes: [...input.argumentDecodeFailureCodes],
    startedAtMs: input.startedAtMs,
    finishedAtMs: input.finishedAtMs,
    latencyMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
    recordedAtMs: Date.now(),
  });
  return { inserted: true };
}

/**
 * Finalizes the run row with its outcome. Patch-only and therefore its own
 * replay; a finalize with no run row (its start recording was dropped by a
 * defensive failure) refuses honestly instead of inventing a start time.
 */
export async function writeAnswerRunFinalized(
  tx: MutationCtx,
  input: AnswerRunFinalizedInput,
): Promise<{ finalized: boolean }> {
  const existing = await runRow(tx, input.runId);
  if (existing === null) {
    return { finalized: false };
  }
  await tx.db.patch(existing._id, {
    outcome: input.outcome,
    ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
    turnCount: input.turnCount,
    refreshCount: input.refreshCount,
    observedModels: [...input.observedModels],
    finalTextExcerpt: input.finalTextExcerpt.slice(0, ANSWER_EXCERPT_MAX_CHARS),
    finalizedAtMs: Date.now(),
  });
  return { finalized: true };
}

// ---------------------------------------------------------------------------
// The registered internal mutations (the loop's only durable writers of
// these tables).
// ---------------------------------------------------------------------------

/** Records the run's start (idempotent per runId). */
export const recordAnswerRunStart = internalMutation({
  args: {
    runId: v.string(),
    questionSourceId: v.id("sources"),
    pipelineVersion: v.string(),
    modelConfigurationVersion: v.string(),
  },
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx, args) => writeAnswerRunStart(ctx, args),
});

/** Records one provider turn (idempotent per runId+turnIndex). */
export const recordAnswerTurn = internalMutation({
  args: {
    runId: v.string(),
    turnIndex: v.float64(),
    outcome: turnOutcomeArg,
    finishReasonClass: finishClassArg,
    failureKind: v.optional(failureKindArg),
    provider: v.optional(v.union(v.literal("deepseek"), v.literal("openrouter"))),
    observedModel: v.optional(v.string()),
    attemptCount: v.float64(),
    toolCallNames: v.array(v.string()),
    callsOrigin: callsOriginArg,
    argumentDecodeFailureCodes: v.array(v.string()),
    startedAtMs: v.float64(),
    finishedAtMs: v.float64(),
  },
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx, args) => writeAnswerTurn(ctx, args),
});

/** Finalizes the run row with the finished run's outcome. */
export const finalizeAnswerRun = internalMutation({
  args: {
    runId: v.string(),
    outcome: runOutcomeArg,
    failureKind: v.optional(failureKindArg),
    turnCount: v.float64(),
    refreshCount: v.float64(),
    observedModels: v.array(v.string()),
    finalTextExcerpt: v.string(),
  },
  returns: v.object({ finalized: v.boolean() }),
  handler: async (ctx, args) => writeAnswerRunFinalized(ctx, args),
});

// ---------------------------------------------------------------------------
// The loop-facing best-effort helpers: bound the untrusted fields, run the
// ONE mutation, swallow every recording failure.
// ---------------------------------------------------------------------------

/** Runs one recording mutation defensively; instrumentation never fails the ask. */
async function note<T>(run: () => Promise<T>): Promise<void> {
  try {
    await run();
  } catch {
    // A dropped record is a degraded diagnostics state, never an answer
    // failure; the run's honest rows are whatever did land.
  }
}

/** Bounds one untrusted string field (model names, tool names, codes). */
function bounded(value: string, max: number): string {
  return value.slice(0, max);
}

/** The loop's run-start checkpoint (after its context load succeeded). */
export async function noteRunStart(
  ctx: ActionCtx,
  input: AnswerRunStartInput,
): Promise<void> {
  await note(() =>
    ctx.runMutation(internal.agent.record.recordAnswerRunStart, {
      runId: input.runId,
      questionSourceId: input.questionSourceId,
      pipelineVersion: bounded(input.pipelineVersion, 64),
      modelConfigurationVersion: bounded(input.modelConfigurationVersion, 128),
    }),
  );
}

/** The loop's per-turn checkpoint (ONE mutation, idempotent per run+turn). */
export async function noteTurn(
  ctx: ActionCtx,
  input: AnswerTurnInput,
): Promise<void> {
  await note(() =>
    ctx.runMutation(internal.agent.record.recordAnswerTurn, {
      runId: input.runId,
      turnIndex: input.turnIndex,
      outcome: input.outcome,
      finishReasonClass: input.finishReasonClass,
      ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.observedModel === undefined
        ? {}
        : { observedModel: bounded(input.observedModel, 128) }),
      attemptCount: input.attemptCount,
      toolCallNames: input.toolCallNames
        .slice(0, ANSWER_TURN_NAMES_MAX)
        .map((name) => bounded(name, 64)),
      callsOrigin: input.callsOrigin,
      argumentDecodeFailureCodes: input.argumentDecodeFailureCodes
        .slice(0, ANSWER_TURN_CODES_MAX)
        .map((code) => bounded(code, 64)),
      startedAtMs: input.startedAtMs,
      finishedAtMs: input.finishedAtMs,
    }),
  );
}

/** The loop's finish checkpoint (the run's outcome, failure kind, excerpt). */
export async function noteRunFinalized(
  ctx: ActionCtx,
  input: AnswerRunFinalizedInput,
): Promise<void> {
  await note(() =>
    ctx.runMutation(internal.agent.record.finalizeAnswerRun, {
      runId: input.runId,
      outcome: input.outcome,
      ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
      turnCount: input.turnCount,
      refreshCount: input.refreshCount,
      observedModels: input.observedModels
        .slice(0, 16)
        .map((model) => bounded(model, 128)),
      finalTextExcerpt: input.finalTextExcerpt.slice(0, ANSWER_EXCERPT_MAX_CHARS),
    }),
  );
}
