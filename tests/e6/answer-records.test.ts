/**
 * E6 focused verification, part 7 (R25, issue #230): the answer loop's
 * durable record family — the answerRuns/answerTurns tables, their closed
 * vocabularies, the idempotent transactional writes and the loop-facing
 * best-effort helpers.
 *
 * What MUST hold structurally is pinned here:
 *
 * - the schema composition (convex/schema.ts) admits exactly the two new
 *   tables and they are in the closed @kiero/contracts inventory (the
 *   construction-time checks run on import; a test that imports the schema
 *   and reads the tables proves both directions fired);
 * - the rows are sanitized BY SHAPE: the field sets of both tables are
 *   exactly the declared allow-list — no column exists where a raw model
 *   payload, tool argument, prompt or transcript could land;
 * - the transactional writes are idempotent per their keys (runId for the
 *   run row, runId+turnIndex for a turn row, patch-replay for finalize);
 * - each loop-facing helper reaches exactly ONE internal mutation and
 *   swallows recording failures (instrumentation never fails an ask);
 * - the untrusted strings arrive bounded (names, codes, excerpt).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import schema from "../../convex/schema";
import { TABLE_ID_NAMES } from "@kiero/contracts";
import { fakeCtx, asTx } from "../d2/harness";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { internal } from "../../convex/_generated/api";
import {
  ANSWER_RUN_OUTCOMES,
  ANSWER_TURN_CALLS_ORIGINS,
  ANSWER_TURN_FAILURE_KINDS,
  ANSWER_TURN_FINISH_CLASSES,
  ANSWER_TURN_OUTCOMES,
} from "../../convex/agent/schema";
import {
  ANSWER_EXCERPT_MAX_CHARS,
  ANSWER_TURN_NAMES_MAX,
  noteRunFinalized,
  noteRunStart,
  noteTurn,
  writeAnswerRunFinalized,
  writeAnswerRunStart,
  writeAnswerTurn,
} from "../../convex/agent/record";

// ---------------------------------------------------------------------------
// Schema composition and shape (the i2 schema-test pattern).
// ---------------------------------------------------------------------------

interface LooseValidator {
  kind: string;
  fields?: Record<string, { kind: string }>;
}

function tableValidator(table: "answerRuns" | "answerTurns"): LooseValidator {
  const validator = schema.tables[table]?.validator as unknown as
    | LooseValidator
    | undefined;
  if (
    validator === undefined ||
    validator.kind !== "object" ||
    validator.fields === undefined
  ) {
    throw new Error(`table ${table} has no object validator`);
  }
  return validator;
}

describe("the answer record family composes into the closed inventory", () => {
  it("declares exactly the two new tables, present in TABLE_ID_NAMES", () => {
    // The import above already ran convex/schema.ts's construction-time
    // checks (composed tables == TABLE_ID_NAMES in BOTH directions); this
    // pins the two names the issue declares.
    expect(schema.tables.answerRuns).toBeDefined();
    expect(schema.tables.answerTurns).toBeDefined();
    expect(TABLE_ID_NAMES).toContain("answerRuns");
    expect(TABLE_ID_NAMES).toContain("answerTurns");
  });

  it("answerRuns carries exactly the run-level allow-list (sanitized by shape)", () => {
    expect(Object.keys(tableValidator("answerRuns").fields!).sort()).toEqual([
      "companyId",
      "failureKind",
      "finalTextExcerpt",
      "finalizedAtMs",
      "modelConfigurationVersion",
      "observedModels",
      "outcome",
      "pipelineVersion",
      "questionSourceId",
      "refreshCount",
      "runId",
      "startedAtMs",
      "turnCount",
    ].sort());
  });

  it("answerTurns carries exactly the turn-level allow-list (no argument column exists)", () => {
    // No field can hold a raw payload, argument, prompt or transcript:
    // the only string array fields are NAMES and CODES.
    expect(Object.keys(tableValidator("answerTurns").fields!).sort()).toEqual([
      "argumentDecodeFailureCodes",
      "attemptCount",
      "callsOrigin",
      "failureKind",
      "finishReasonClass",
      "latencyMs",
      "observedModel",
      "outcome",
      "provider",
      "recordedAtMs",
      "runId",
      "startedAtMs",
      "finishedAtMs",
      "toolCallNames",
      "turnIndex",
    ].sort());
  });
});

// ---------------------------------------------------------------------------
// The closed vocabularies (single spellings, pinned).
// ---------------------------------------------------------------------------

describe("the record vocabularies", () => {
  it("run outcomes are exactly the four the answer result reports", () => {
    expect(ANSWER_RUN_OUTCOMES).toEqual([
      "answered",
      "clarified",
      "gave_up",
      "provider_failed",
    ]);
  });

  it("turn outcomes are decoded versus rejected", () => {
    expect(ANSWER_TURN_OUTCOMES).toEqual(["decoded", "rejected"]);
  });

  it("finish classes declare the provider seam's own classes plus the honest unknown", () => {
    expect(ANSWER_TURN_FINISH_CLASSES).toEqual([
      "stop",
      "tool_calls",
      "length",
      "content_filter",
      "unknown",
    ]);
  });

  it("calls origins name every decode path the loop has", () => {
    expect(ANSWER_TURN_CALLS_ORIGINS).toEqual(["native", "text_rescue", "none"]);
  });

  it("failure kinds are exactly E2's closed provider failure classification", () => {
    expect(ANSWER_TURN_FAILURE_KINDS).toEqual([
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
    ]);
  });
});

// ---------------------------------------------------------------------------
// The transactional writes over the in-memory db (the d2 harness).
// ---------------------------------------------------------------------------

const RUN_ID = "e6-sources_q1-1770000000000";
const START = { pipelineVersion: "e6.answer/3", modelConfigurationVersion: "e2.routing/e8.0#chat_analysis" };

const STARTED_AT_MS = 1_000;
const FINISHED_AT_MS = 2_350;

function turnInput(overrides: Partial<Parameters<typeof writeAnswerTurn>[1]> = {}) {
  return {
    runId: RUN_ID,
    turnIndex: 1,
    outcome: "decoded",
    finishReasonClass: "tool_calls",
    attemptCount: 2,
    toolCallNames: ["agent_search_evidence"],
    callsOrigin: "native",
    argumentDecodeFailureCodes: [],
    startedAtMs: STARTED_AT_MS,
    finishedAtMs: FINISHED_AT_MS,
    ...overrides,
  } as Parameters<typeof writeAnswerTurn>[1];
}

interface Seeded {
  sourceId: Id<"sources">;
  companyId: string;
}

async function seedQuestionSource(): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", {
    name: "answer-records",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  const sourceId = (await ctx.db.insert("sources", {
    companyId,
    lifecycle: "active",
  })) as Id<"sources">;
  return { sourceId, companyId };
}

let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

async function runRowOf(runId: string): Promise<Record<string, unknown> | null> {
  return ctx.db
    .query("answerRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .first();
}

async function turnRows(): Promise<Record<string, unknown>[]> {
  return ctx.db.query("answerTurns").collect();
}

beforeEach(() => {
  ctx = fakeCtx(["companies", "sources", "answerRuns", "answerTurns"]);
});

describe("writeAnswerRunStart (idempotent per runId)", () => {
  it("inserts the run row with the tenant scope resolved from the source", async () => {
    const { sourceId, companyId } = await seedQuestionSource();
    const first = await writeAnswerRunStart(tx(), {
      runId: RUN_ID,
      questionSourceId: sourceId,
      ...START,
    });
    expect(first).toEqual({ inserted: true });
    const row = await runRowOf(RUN_ID);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      runId: RUN_ID,
      questionSourceId: sourceId,
      companyId,
      pipelineVersion: START.pipelineVersion,
      modelConfigurationVersion: START.modelConfigurationVersion,
    });
    // An unfinished run honestly has no outcome yet.
    expect(row!.outcome).toBeUndefined();
    expect(row!.finalizedAtMs).toBeUndefined();
  });

  it("replays insert nothing (the crash/retry replay)", async () => {
    const { sourceId } = await seedQuestionSource();
    await writeAnswerRunStart(tx(), { runId: RUN_ID, questionSourceId: sourceId, ...START });
    const replay = await writeAnswerRunStart(tx(), { runId: RUN_ID, questionSourceId: sourceId, ...START });
    expect(replay).toEqual({ inserted: false });
    expect(ctx.db.rows("answerRuns")).toHaveLength(1);
  });

  it("records a run against a vanished source unscoped, never refuses", async () => {
    const gone = "k0001vvvvvvvvvvvvvvvvvvv" as Id<"sources">;
    const result = await writeAnswerRunStart(tx(), {
      runId: RUN_ID,
      questionSourceId: gone,
      ...START,
    });
    expect(result).toEqual({ inserted: true });
    expect((await runRowOf(RUN_ID))!.companyId).toBeUndefined();
  });
});

describe("writeAnswerTurn (idempotent per runId+turnIndex)", () => {
  it("inserts the sanitized turn row with the server-computed latency", async () => {
    await writeAnswerTurn(
      tx(),
      turnInput({
        outcome: "rejected",
        finishReasonClass: "unknown",
        failureKind: "output_rejected",
        toolCallNames: [],
        callsOrigin: "none",
      }),
    );
    const rows = await turnRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: RUN_ID,
      turnIndex: 1,
      outcome: "rejected",
      finishReasonClass: "unknown",
      failureKind: "output_rejected",
      attemptCount: 2,
      toolCallNames: [],
      callsOrigin: "none",
      latencyMs: FINISHED_AT_MS - STARTED_AT_MS,
    });
  });

  it("replaying the same turn inserts nothing; the next turn index does", async () => {
    await writeAnswerTurn(tx(), turnInput({}));
    const replay = await writeAnswerTurn(
      tx(),
      turnInput({ finishReasonClass: "stop", callsOrigin: "none" }),
    );
    expect(replay).toEqual({ inserted: false });
    expect(await turnRows()).toHaveLength(1);
    // The replay did not overwrite the first observation either.
    expect((await turnRows())[0]!.finishReasonClass).toBe("tool_calls");

    const next = await writeAnswerTurn(
      tx(),
      turnInput({ turnIndex: 2, finishReasonClass: "stop", callsOrigin: "none", toolCallNames: [] }),
    );
    expect(next).toEqual({ inserted: true });
    expect(await turnRows()).toHaveLength(2);
  });

  it("a negative clock skew never records a negative latency", async () => {
    await writeAnswerTurn(
      tx(),
      turnInput({ startedAtMs: FINISHED_AT_MS + 5, finishedAtMs: FINISHED_AT_MS }),
    );
    expect((await turnRows())[0]!.latencyMs).toBe(0);
  });
});

describe("writeAnswerRunFinalized (patch replay)", () => {
  async function startedRun(sourceId: Id<"sources">): Promise<void> {
    await writeAnswerRunStart(tx(), { runId: RUN_ID, questionSourceId: sourceId, ...START });
  }

  it("patches the outcome envelope onto the started run row", async () => {
    const { sourceId } = await seedQuestionSource();
    await startedRun(sourceId);
    const result = await writeAnswerRunFinalized(tx(), {
      runId: RUN_ID,
      outcome: "provider_failed",
      failureKind: "output_rejected",
      turnCount: 1,
      refreshCount: 0,
      observedModels: ["deepseek-chat"],
      finalTextExcerpt: "x".repeat(ANSWER_EXCERPT_MAX_CHARS + 100),
    });
    expect(result).toEqual({ finalized: true });
    const row = await runRowOf(RUN_ID);
    expect(row).toMatchObject({
      outcome: "provider_failed",
      failureKind: "output_rejected",
      turnCount: 1,
      refreshCount: 0,
      observedModels: ["deepseek-chat"],
      finalizedAtMs: expect.any(Number),
    });
    // The excerpt is bounded by the write, not by the caller's honesty.
    expect((row!.finalTextExcerpt as string).length).toBe(ANSWER_EXCERPT_MAX_CHARS);
  });

  it("replaying the finalize patches the same values (no second row, no drift)", async () => {
    const { sourceId } = await seedQuestionSource();
    await startedRun(sourceId);
    const input = {
      runId: RUN_ID,
      outcome: "answered" as const,
      turnCount: 3,
      refreshCount: 1,
      observedModels: ["deepseek-chat"],
      finalTextExcerpt: "Zaliczka 5000 PLN.",
    };
    await writeAnswerRunFinalized(tx(), input);
    await writeAnswerRunFinalized(tx(), input);
    expect(ctx.db.rows("answerRuns")).toHaveLength(1);
    expect(await runRowOf(RUN_ID)).toMatchObject({ outcome: "answered", turnCount: 3 });
  });

  it("refuses honestly when the run row never landed (no invented start)", async () => {
    const result = await writeAnswerRunFinalized(tx(), {
      runId: RUN_ID,
      outcome: "gave_up",
      turnCount: 6,
      refreshCount: 0,
      observedModels: [],
      finalTextExcerpt: "",
    });
    expect(result).toEqual({ finalized: false });
    expect(ctx.db.rows("answerRuns")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The loop-facing helpers: ONE internal mutation each, failures swallowed,
// untrusted strings bounded (the routing test's fake ActionCtx).
// ---------------------------------------------------------------------------

const RUN_START_PATH = getFunctionName(internal.agent.record.recordAnswerRunStart);
const TURN_PATH = getFunctionName(internal.agent.record.recordAnswerTurn);
const FINALIZE_PATH = getFunctionName(internal.agent.record.finalizeAnswerRun);

type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

interface RecordedCall {
  readonly path: string;
  readonly args: Record<string, unknown>;
}

function fakeActionCtx(answers: {
  mutation?: (path: string, args: Record<string, unknown>) => unknown;
}) {
  const calls: RecordedCall[] = [];
  const ctx = {
    runMutation: async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
      const path = getFunctionName(ref);
      calls.push({ path, args });
      return answers.mutation?.(path, args);
    },
  };
  return { ctx: ctx as unknown as ActionCtx, calls };
}

const SOURCE_ID = "k0002wwwwwwwwwwwwwwwwww" as Id<"sources">;

describe("the loop-facing best-effort helpers", () => {
  it("noteRunStart reaches exactly the run-start mutation", async () => {
    const { ctx: action, calls } = fakeActionCtx({ mutation: () => ({ inserted: true }) });
    await noteRunStart(action, {
      runId: RUN_ID,
      questionSourceId: SOURCE_ID,
      ...START,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(RUN_START_PATH);
    expect(calls[0]!.args).toMatchObject({
      runId: RUN_ID,
      questionSourceId: SOURCE_ID,
      pipelineVersion: START.pipelineVersion,
    });
  });

  it("noteTurn reaches exactly the turn mutation with bounded names and no arguments", async () => {
    const { ctx: action, calls } = fakeActionCtx({ mutation: () => ({ inserted: true }) });
    await noteTurn(
      action,
      turnInput({
        observedModel: "deepseek-chat",
        provider: "deepseek",
        toolCallNames: Array.from({ length: ANSWER_TURN_NAMES_MAX + 5 }, (_, i) => `t${i}`),
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(TURN_PATH);
    const args = calls[0]!.args;
    expect(args.toolCallNames).toHaveLength(ANSWER_TURN_NAMES_MAX);
    // Names and codes only: no argument payload key exists on the wire.
    expect(JSON.stringify(args)).not.toContain("arguments");
    expect(args.observedModel).toBe("deepseek-chat");
    expect(args.provider).toBe("deepseek");
  });

  it("noteRunFinalized reaches exactly the finalize mutation with the bounded excerpt", async () => {
    const { ctx: action, calls } = fakeActionCtx({ mutation: () => ({ finalized: true }) });
    await noteRunFinalized(action, {
      runId: RUN_ID,
      outcome: "provider_failed",
      failureKind: "output_rejected",
      turnCount: 1,
      refreshCount: 0,
      observedModels: ["deepseek-chat"],
      finalTextExcerpt: "y".repeat(ANSWER_EXCERPT_MAX_CHARS + 50),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(FINALIZE_PATH);
    expect((calls[0]!.args.finalTextExcerpt as string).length).toBe(ANSWER_EXCERPT_MAX_CHARS);
    expect(calls[0]!.args.failureKind).toBe("output_rejected");
  });

  it("swallows a recording failure instead of failing the ask", async () => {
    const { ctx: action } = fakeActionCtx({
      mutation: () => {
        throw new Error("transient storage error");
      },
    });
    await expect(
      noteRunStart(action, { runId: RUN_ID, questionSourceId: SOURCE_ID, ...START }),
    ).resolves.toBeUndefined();
    await expect(noteTurn(action, turnInput())).resolves.toBeUndefined();
    await expect(
      noteRunFinalized(action, {
        runId: RUN_ID,
        outcome: "gave_up",
        turnCount: 6,
        refreshCount: 0,
        observedModels: [],
        finalTextExcerpt: "",
      }),
    ).resolves.toBeUndefined();
  });
});
