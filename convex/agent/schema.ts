/**
 * The answer loop's durable record family (R25, issue #230 — the E6 named
 * prerequisite the loop's own header declared: "durable answer/tool-attempt
 * record rows need a shared table family the closed contracts inventory does
 * not declare yet").
 *
 * Two tables, written ONLY by the loop's recording half (./record.ts) from
 * the answer loop's existing checkpoints:
 *
 * - `answerRuns`: ONE row per ask. Created at run start (idempotent per
 *   `runId`) and finalized with the run's outcome when the loop finishes; a
 *   crash in between honestly leaves the row unfinished (no outcome).
 * - `answerTurns`: ONE row per provider turn, idempotent per
 *   (`runId`, `turnIndex`) — the loop is an ACTION, so its mutation calls
 *   are replay-safe by key, not by transaction.
 *
 * Sanitization is the diagnosticEvents discipline (I2): NO raw model
 * payloads, tool arguments, prompts or transcripts — only names, closed
 * codes/classes, counts, latencies and ONE bounded final-text excerpt (the
 * same excerpt the answer result already returns to callers).
 *
 * The vocabulary honesty note: the provider seam (E2/E8) collapses finish
 * `length`/`content_filter`, malformed tool-call JSON and schema mismatches
 * into the single `output_rejected` failure kind BEFORE the loop can observe
 * them. `finishReasonClass` therefore declares the full class vocabulary but
 * records `unknown` on rejected turns — the row states exactly what the loop
 * could see; splitting the collapsed kind is the separate repair this
 * evidence family exists to decide.
 *
 * Tables: answerRuns, answerTurns.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import type { ProviderFailureKind } from "@kiero/providers";
import { shared, type ValueValidator } from "../schema/shared";

/** The run-level outcomes (the answer result's closed outcome vocabulary). */
export const ANSWER_RUN_OUTCOMES = [
  "answered",
  "clarified",
  "gave_up",
  "provider_failed",
] as const;
export type AnswerRunOutcome = (typeof ANSWER_RUN_OUTCOMES)[number];

/** One provider turn's decode outcome as the loop observed it. */
export const ANSWER_TURN_OUTCOMES = ["decoded", "rejected"] as const;
export type AnswerTurnOutcome = (typeof ANSWER_TURN_OUTCOMES)[number];

/**
 * The finish-reason classes a provider turn can end with. `length` and
 * `content_filter` are declared because they are the two rejected-finish
 * classes the provider seam itself distinguishes; today the seam collapses
 * them (with malformed-JSON and schema-mismatch rejections) into the
 * `output_rejected` failure kind before the loop can observe the class, so
 * rejected turns record `unknown` until that seam is opened up.
 */
export const ANSWER_TURN_FINISH_CLASSES = [
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "unknown",
] as const;
export type AnswerTurnFinishClass = (typeof ANSWER_TURN_FINISH_CLASSES)[number];

/**
 * Which decode path produced the turn's dispatched calls: the provider's
 * native tool calls, the text-encoded rescue (E6's inherited flash-model
 * defect fix), or no calls at all.
 */
export const ANSWER_TURN_CALLS_ORIGINS = [
  "native",
  "text_rescue",
  "none",
] as const;
export type AnswerTurnCallsOrigin = (typeof ANSWER_TURN_CALLS_ORIGINS)[number];

/**
 * The sanitized provider failure kinds a rejected turn records — exactly
 * E2's closed classification (the `satisfies` pin rejects a name this
 * vocabulary does not own; a MISSING kind fails typecheck at the loop's
 * recording call site, where the full `ProviderFailureKind` union must
 * assign into it).
 */
export const ANSWER_TURN_FAILURE_KINDS = [
  "deadline_exceeded",
  "connection_failed",
  "rate_limited",
  "provider_unavailable",
  "unauthenticated",
  "insufficient_credits",
  "unsupported_parameters",
  "output_rejected",
  "unknown_tool",
  "internal_error",
] as const satisfies readonly ProviderFailureKind[];
export type AnswerTurnFailureKind = (typeof ANSWER_TURN_FAILURE_KINDS)[number];

/** The answer turns' failure-kind validator, pinned to the closed list. */
const answerFailureKindValue: ValueValidator<AnswerTurnFailureKind> = v.union(
  ...ANSWER_TURN_FAILURE_KINDS.map((kind) => v.literal(kind)),
);

export const answerTables = {
  /**
   * ONE recorded answer run per ask: created at run start (the loop's
   * context-load checkpoint), finalized with the outcome when the loop
   * finishes. An absent outcome is the honest unfinished row a crash
   * leaves behind; per-turn evidence lives in `answerTurns`.
   */
  answerRuns: defineTable({
    /** The loop's run id (`e6-<sourceId>-<startMs>`); the idempotency key. */
    runId: v.string(),
    /** The question source ("Wypowiedź") this run answers. */
    questionSourceId: shared.sourceId,
    /** Tenant scope, resolved server-side from the question source row. */
    companyId: v.optional(shared.companyId),
    /** Interpretability labels (the answer result's version envelope). */
    pipelineVersion: v.string(),
    modelConfigurationVersion: v.string(),
    startedAtMs: shared.tsMs,
    // Finalize-time fields (absent until the run finished).
    outcome: v.optional(
      v.union(...ANSWER_RUN_OUTCOMES.map((outcome) => v.literal(outcome))),
    ),
    /** The E2 failure kind; present exactly on a `provider_failed` run. */
    failureKind: v.optional(answerFailureKindValue),
    turnCount: v.optional(shared.counter),
    refreshCount: v.optional(shared.counter),
    /** The models that actually served the run's turns, as observed. */
    observedModels: v.optional(v.array(v.string())),
    /** Bounded excerpt of the last observed turn text (600 chars). */
    finalTextExcerpt: v.optional(v.string()),
    finalizedAtMs: v.optional(shared.tsMs),
  })
    .index("by_run", ["runId"])
    .index("by_source_time", ["questionSourceId", "startedAtMs"])
    .index("by_company_time", ["companyId", "startedAtMs"]),

  /**
   * ONE recorded provider turn of a run: what the loop asked (which turn
   * index), what came back (decoded or rejected, the finish class, the
   * sanitized failure kind), which route served it (supplier, observed
   * model, attempt count) and how long it took. Tool calls appear as NAMES
   * ONLY — never raw payloads or arguments.
   */
  answerTurns: defineTable({
    /** The run this turn belongs to (with `turnIndex`: the replay key). */
    runId: v.string(),
    /** 1-based position in the run (the loop's own turn counter). */
    turnIndex: shared.counter,
    outcome: v.union(...ANSWER_TURN_OUTCOMES.map((o) => v.literal(o))),
    finishReasonClass: v.union(
      ...ANSWER_TURN_FINISH_CLASSES.map((c) => v.literal(c)),
    ),
    /** Present exactly when the turn was rejected. */
    failureKind: v.optional(answerFailureKindValue),
    /** The supplier of the attempt that served (or last failed) the turn. */
    provider: v.optional(v.union(v.literal("deepseek"), v.literal("openrouter"))),
    /** The model that actually served the turn, as observed in it. */
    observedModel: v.optional(v.string()),
    /** Attempts the ordered route burned for this turn (fallback visible). */
    attemptCount: shared.counter,
    /** The decoded calls' names, in order (names only, never arguments). */
    toolCallNames: v.array(v.string()),
    callsOrigin: v.union(...ANSWER_TURN_CALLS_ORIGINS.map((o) => v.literal(o))),
    /**
     * Closed codes for argument-decode failures, codes only. Empty today:
     * the provider seam collapses per-call decode failures into the turn's
     * `output_rejected` kind before the loop can see them; the column is
     * the durable landing place once that seam exposes per-call causes.
     */
    argumentDecodeFailureCodes: v.array(v.string()),
    startedAtMs: shared.tsMs,
    finishedAtMs: shared.tsMs,
    /** `finishedAtMs - startedAtMs`, computed server-side at insert. */
    latencyMs: shared.counter,
    recordedAtMs: shared.tsMs,
  })
    .index("by_run_turn", ["runId", "turnIndex"])
    .index("by_outcome_time", ["outcome", "recordedAtMs"]),
} as const;
