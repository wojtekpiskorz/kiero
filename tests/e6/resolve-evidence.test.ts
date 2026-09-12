/**
 * E6 focused verification, part 6 (R1 repair, issue #126): the evidence a
 * clarification resolution cites must SURVIVE the whole path — tool
 * decoding, checked dispatch, storage and readback.
 *
 * The 2026-09-12 map review (spec finding P1) observed that
 * `packages/agent/tools/tools.ts` requires `evidenceIds` on
 * `agent_resolve_clarification`, but the loop dropped them when
 * dispatching and neither the checked executor nor the resolution
 * transaction persisted any source/fragment association: a resolution had
 * no traceable new basis. These tests pin the repaired contract:
 *
 * - R1-P1: the loop forwards the resolved ledger handles (deduplicated)
 *   to `executeResolveClarification`; the checked executor validates each
 *   reference against the CURRENT ledger (company-owned ACTIVE source,
 *   matching fragment), normalizes fragment-less references to durable
 *   fragments, and the memory command stores the basis plus the
 *   normalized references; `readClarificationRows` returns them.
 * - R1-P2: a manual (note-only) resolution still resolves and stores the
 *   explicit `manual_boss_decision` basis with NO fabricated source.
 * - R1-P3: unknown, cross-company, inactive and mismatched-fragment
 *   references refuse the WHOLE execution and leave the case open.
 * - a repeated resolve cannot replace the stored evidence.
 *
 * The loop half runs against a fake ActionCtx (the routing-test pattern);
 * the executor/transaction halves run against the shared D2 in-memory
 * Convex emulation, driving the REAL checked functions.
 */

import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { valueOf, fakeCtx, seedActor, contextFor, type ActorFixture, type FakeCtx } from "../d2/harness";
import { emptyAnswerState, type AnswerContext } from "@kiero/agent/tools";
import { internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import { dispatchAnswerToolCall } from "../../convex/agent/loop";
import { executeResolveClarificationCore } from "../../convex/agent/execute";
import { dispatchMemoryCommand } from "../../convex/memory/findings/dispatch";
import { readClarificationRows } from "../../convex/memory/findings/exposition";

const RESOLVE_PATH = getFunctionName(
  internal.agent.execute.executeResolveClarification,
);

type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

/** One recorded internal call (which function, with which arguments). */
interface RecordedCall {
  readonly kind: "query" | "mutation";
  readonly path: string;
  readonly args: Record<string, unknown>;
}

/** Builds a fake ActionCtx recording every internal mutation (routing pattern). */
function fakeActionCtx(mutation: (path: string, args: Record<string, unknown>) => unknown) {
  const calls: RecordedCall[] = [];
  const ctx = {
    runMutation: async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
      const path = getFunctionName(ref);
      calls.push({ kind: "mutation", path, args });
      return mutation(path, args);
    },
  };
  return { ctx: ctx as unknown as ActionCtx, calls };
}

/** A checked-execution ResultEnvelope in the wire shape the loop unwraps. */
function okEnvelope(value: Record<string, unknown>): unknown {
  return { _tag: "ok", value };
}

// ---------------------------------------------------------------------------
// The seeded world: two companies, an open clarification, several sources.
// ---------------------------------------------------------------------------

const SENT_AT_MS = Date.parse("2026-09-09T07:30:00.000Z");

const RESOLVE_TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "gmAccessGrants",
  "sources",
  "sourceFragments",
  "extractions",
  "clarifications",
  "outboxEvents",
] as const;

interface ResolveWorld {
  readonly ctx: FakeCtx;
  readonly boss: ActorFixture;
  readonly otherBoss: ActorFixture;
  readonly questionSourceId: string;
  readonly evidenceSourceId: string;
  readonly evidenceFragmentId: string;
  readonly wholeSourceId: string;
  readonly withdrawnSourceId: string;
  readonly foreignSourceId: string;
  readonly clarificationId: string;
}

/** Seeds one active source with a D1-style text extraction. */
async function seedSource(
  ctx: FakeCtx,
  companyId: string,
  authorUserId: string,
  lifecycle: "active" | "withdrawn",
  label: string,
): Promise<string> {
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId,
    authorText: `Wiadomość ${label}`,
    sentAtMs: SENT_AT_MS - 3_600_000,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: SENT_AT_MS - 3_600_000,
    lifecycle,
  });
  await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "text/1",
    model: "fixture",
    provider: "fixture",
    processingRunId: "kprocessingrunst0000000000000",
    createdAtMs: SENT_AT_MS,
  });
  return sourceId;
}

async function seedResolveWorld(): Promise<ResolveWorld> {
  const ctx = fakeCtx(RESOLVE_TABLES);
  const boss = await seedActor(ctx, "boss");
  const otherBoss = await seedActor(ctx, "other");

  const questionSourceId = await seedSource(ctx, boss.companyId, boss.userId, "active", "pytanie");
  const evidenceSourceId = await seedSource(ctx, boss.companyId, boss.userId, "active", "zaliczka");
  const wholeSourceId = await seedSource(ctx, boss.companyId, boss.userId, "active", "calosc");
  const withdrawnSourceId = await seedSource(ctx, boss.companyId, boss.userId, "withdrawn", "wycofana");
  const foreignSourceId = await seedSource(ctx, otherBoss.companyId, otherBoss.userId, "active", "obca");

  // One existing fragment on the evidence source (a text range).
  const extractionRows = ctx.db.rows("extractions").filter((row) => row.sourceId === evidenceSourceId);
  const extractionId = extractionRows[0]?._id as string;
  const evidenceFragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId: evidenceSourceId,
    anchor: { _tag: "text_range", startOffset: 0, endOffset: 28 },
    createdAtMs: SENT_AT_MS,
  });

  const clarificationId = await ctx.db.insert("clarifications", {
    companyId: boss.companyId,
    scopeKind: "company",
    question: "Który termin montażu obowiązuje?",
    conflictingFragmentIds: [evidenceFragmentId],
    state: "open",
    raisedAtMs: SENT_AT_MS - 60_000,
  });

  return {
    ctx,
    boss,
    otherBoss,
    questionSourceId,
    evidenceSourceId,
    evidenceFragmentId,
    wholeSourceId,
    withdrawnSourceId,
    foreignSourceId,
    clarificationId,
  };
}

/** One answer context whose ledger holds the seeded handles. */
function answerContextOf(world: ResolveWorld): AnswerContext {
  return {
    question: {
      sourceId: world.questionSourceId,
      authorText: "Jaka zaliczka wpłynęła od Kaczmarka?",
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: "Europe/Warsaw",
    },
    projects: [],
    findings: [],
    sources: [
      { sourceId: world.evidenceSourceId, sentAtMs: SENT_AT_MS - 3_600_000, preview: "", lifecycle: "active", processing: "complete" },
      { sourceId: world.wholeSourceId, sentAtMs: SENT_AT_MS - 3_600_000, preview: "", lifecycle: "active", processing: "complete" },
    ],
    tasks: [],
    events: [],
    clarifications: [
      {
        clarificationId: world.clarificationId,
        question: "Który termin montażu obowiązuje?",
        scopeKind: "company",
        scopeProjectId: null,
      },
    ],
    contacts: [],
    memberships: [],
    evidence: [
      {
        evidenceId: "ev1",
        sourceId: world.evidenceSourceId,
        sourceSentAtMs: SENT_AT_MS - 3_600_000,
        fragmentId: world.evidenceFragmentId,
        quote: "Kaczmarek wpłacił zaliczkę 5000",
        startOffset: 0,
        endOffset: 28,
        groundsFindingId: null,
        groundsUpdating: false,
      },
      {
        evidenceId: "ev2",
        sourceId: world.wholeSourceId,
        sourceSentAtMs: SENT_AT_MS - 3_600_000,
        fragmentId: null,
        quote: "cała wiadomość",
        startOffset: null,
        endOffset: null,
        groundsFindingId: null,
        groundsUpdating: false,
      },
    ],
    run: { runId: "r1-resolve-evidence", nowMs: SENT_AT_MS },
  };
}

/** Dispatches one resolve call through the loop and returns the recorded executor args. */
async function dispatchResolve(
  world: ResolveWorld,
  evidenceIds: string[],
): Promise<{ toolResult: string; args: Record<string, unknown> | undefined }> {
  const { ctx, calls } = fakeActionCtx((path) => {
    if (path === RESOLVE_PATH) {
      return okEnvelope({ outcome: "resolved", clarificationId: world.clarificationId });
    }
    throw new Error(`unexpected mutation ${path}`);
  });
  const context = answerContextOf(world);
  const dispatched = await dispatchAnswerToolCall(
    ctx,
    world.questionSourceId as never,
    "r1-resolve-evidence",
    context,
    emptyAnswerState(context),
    0,
    {
      id: "call_resolve",
      name: "agent_resolve_clarification",
      arguments: {
        clarificationId: world.clarificationId,
        resolutionNote: "Piątek — potwierdzone nową wiadomością.",
        evidenceIds,
      },
    },
  );
  if (dispatched.kind !== "executed") {
    throw new Error(`expected executed, got ${dispatched.kind}`);
  }
  const resolveCall = calls.find((call) => call.path === RESOLVE_PATH);
  return { toolResult: dispatched.result.toolResult, args: resolveCall?.args };
}

/** The stored clarification row, straight from the seeded table. */
function storedRow(world: ResolveWorld): Record<string, unknown> {
  const row = world.ctx.db
    .rows("clarifications")
    .find((candidate) => candidate._id === world.clarificationId);
  if (row === undefined) {
    throw new Error("clarification row missing");
  }
  return row;
}

/** The seeded clarification as the boss-facing read returns it. */
async function readBack(world: ResolveWorld) {
  const rows = await readClarificationRows(
    world.ctx.db as never,
    contextFor(world.boss),
    { scope: { _tag: "company" } } as never,
  );
  if (!rows.ok) {
    throw new Error(`readClarifications failed: ${JSON.stringify(rows.error)}`);
  }
  const row = rows.rows.find((candidate) => candidate.clarificationId === world.clarificationId);
  if (row === undefined) {
    throw new Error("clarification missing from readback");
  }
  return row;
}

// ---------------------------------------------------------------------------
// R1-P1: the evidence survives dispatch, storage and readback.
// ---------------------------------------------------------------------------

describe("R1-P1 agent resolution evidence survives the whole path", () => {
  it("the loop forwards the resolved ledger handles to the checked execution", async () => {
    const world = await seedResolveWorld();
    const { args } = await dispatchResolve(world, ["ev1", "ev2"]);
    expect(args).toBeDefined();
    const evidence = args?.evidence as
      | { sourceId: string; fragmentId?: string; startOffset?: number; endOffset?: number }[]
      | undefined;
    // RED on the pre-repair loop: evidenceIds were dropped here.
    expect(evidence).toBeInstanceOf(Array);
    expect(evidence).toHaveLength(2);
    expect(evidence?.[0]).toMatchObject({
      sourceId: world.evidenceSourceId,
      fragmentId: world.evidenceFragmentId,
    });
    expect(evidence?.[1]).toMatchObject({ sourceId: world.wholeSourceId });
    expect(evidence?.[1]?.fragmentId).toBeUndefined();
  });

  it("the checked executor persists the basis and normalized evidence, and the readback returns them", async () => {
    const world = await seedResolveWorld();
    const dispatched = await dispatchResolve(world, ["ev1", "ev2"]);
    expect(dispatched.toolResult).toContain("Sprawa rozstrzygnięta");

    // The exact args shape the loop captured, replayed against the real
    // checked executor on the seeded world.
    const result = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek — potwierdzone nową wiadomością.",
      evidence: [
        {
          sourceId: world.evidenceSourceId,
          fragmentId: world.evidenceFragmentId,
          startOffset: 0,
          endOffset: 28,
        },
        {
          sourceId: world.wholeSourceId,
          startOffset: null,
          endOffset: null,
        },
      ],
    } as never);
    expect(valueOf(result)).toMatchObject({ outcome: "resolved" });

    // Storage: the transaction wrote the basis and the references.
    const stored = storedRow(world);
    expect(stored.state).toBe("resolved");
    expect(stored.resolutionBasis).toBe("source_backed");
    expect(stored.resolutionEvidence).toEqual([
      { sourceId: world.evidenceSourceId, sourceFragmentId: world.evidenceFragmentId },
      // The whole-source entry normalized to a durable whole_source fragment.
      { sourceId: world.wholeSourceId, sourceFragmentId: expect.any(String) },
    ]);

    // Readback: the boss-facing row carries basis and evidence.
    const row = await readBack(world);
    expect(row.state).toBe("resolved");
    expect(row.resolutionBasis).toBe("source_backed");
    expect(row.resolutionEvidence).toHaveLength(2);
    expect(row.resolutionEvidence[0]).toEqual({
      sourceId: world.evidenceSourceId,
      fragmentId: world.evidenceFragmentId,
    });
    expect(row.resolutionEvidence[1]?.sourceId).toBe(world.wholeSourceId);
    expect(row.resolutionEvidence[1]?.fragmentId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R1-P2: manual (note-only) resolution stays accepted, without a fabricated
// source.
// ---------------------------------------------------------------------------

describe("R1-P2 manual resolution remains note-only", () => {
  it("resolves with a note alone and records the manual basis with no evidence", async () => {
    const world = await seedResolveWorld();
    const result = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.resolveClarification",
      input: {
        clarificationId: world.clarificationId,
        resolutionNote: "Obowiązuje kwota z czwartkowej rozmowy.",
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    expect(valueOf(result)).toMatchObject({ clarificationId: world.clarificationId });

    const stored = storedRow(world);
    expect(stored.resolutionBasis).toBe("manual_boss_decision");
    expect(stored.resolutionEvidence ?? []).toEqual([]);

    const row = await readBack(world);
    expect(row.resolutionBasis).toBe("manual_boss_decision");
    expect(row.resolutionEvidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R1-P3: tenant, lifecycle and fragment refusals are atomic (the case stays
// open, nothing is stored).
// ---------------------------------------------------------------------------

async function executeResolve(
  world: ResolveWorld,
  evidence: unknown,
): Promise<Record<string, unknown>> {
  return valueOf(
    await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence,
    } as never),
  );
}

describe("R1-P3 tenant, lifecycle and fragment refusals are atomic", () => {
  it("refuses an unknown source and leaves the case open", async () => {
    const world = await seedResolveWorld();
    const outcome = await executeResolve(world, [
      { sourceId: "kmissingmissingmissingmi00", startOffset: null, endOffset: null },
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", error: "resolution_source_not_found" });
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses a cross-company source and leaves the case open", async () => {
    const world = await seedResolveWorld();
    const outcome = await executeResolve(world, [
      { sourceId: world.foreignSourceId, startOffset: null, endOffset: null },
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", error: "resolution_source_not_in_company" });
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses an inactive (withdrawn) source and leaves the case open", async () => {
    const world = await seedResolveWorld();
    const outcome = await executeResolve(world, [
      { sourceId: world.withdrawnSourceId, startOffset: null, endOffset: null },
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", error: "resolution_source_not_active" });
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses a fragment that does not match its cited source and leaves the case open", async () => {
    const world = await seedResolveWorld();
    const outcome = await executeResolve(world, [
      // A real fragment of ANOTHER source (the whole-source one).
      { sourceId: world.evidenceSourceId, fragmentId: world.evidenceFragmentId },
      { sourceId: world.wholeSourceId, fragmentId: world.evidenceFragmentId },
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", error: "resolution_fragment_mismatch" });
    expect(storedRow(world).state).toBe("open");
    expect(storedRow(world).resolutionBasis).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A repeated resolve cannot replace evidence.
// ---------------------------------------------------------------------------

describe("a repeated resolve cannot replace evidence", () => {
  it("refuses a second resolve and keeps the first basis and evidence", async () => {
    const world = await seedResolveWorld();
    const first = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [{ sourceId: world.evidenceSourceId, fragmentId: world.evidenceFragmentId }],
    } as never);
    expect(valueOf(first)).toMatchObject({ outcome: "resolved" });

    const second = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.resolveClarification",
      input: {
        clarificationId: world.clarificationId,
        resolutionNote: "Jednak środa.",
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    expect(second._tag).toBe("error");

    const stored = storedRow(world);
    expect(stored.resolutionBasis).toBe("source_backed");
    expect(stored.resolutionEvidence).toEqual([
      { sourceId: world.evidenceSourceId, sourceFragmentId: world.evidenceFragmentId },
    ]);
  });
});

// ---------------------------------------------------------------------------
// E6 mapping: duplicates, whole-source and fragment evidence.
// ---------------------------------------------------------------------------

describe("E6 resolve-evidence mapping", () => {
  it("deduplicates repeated handles before dispatching", async () => {
    const world = await seedResolveWorld();
    const { args } = await dispatchResolve(world, ["ev1", "ev1", "ev2"]);
    const evidence = args?.evidence as { sourceId: string }[];
    expect(evidence).toHaveLength(2);
  });

  it("maps a whole-source handle to a durable whole_source fragment", async () => {
    const world = await seedResolveWorld();
    await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Cała wiadomość rozstrzyga.",
      evidence: [{ sourceId: world.wholeSourceId, startOffset: null, endOffset: null }],
    } as never);
    const stored = storedRow(world);
    const references = stored.resolutionEvidence as { sourceId: string; sourceFragmentId: string }[];
    expect(references).toHaveLength(1);
    const fragment = world.ctx.db
      .rows("sourceFragments")
      .find((row) => row._id === references[0]?.sourceFragmentId);
    expect(fragment?.anchor).toEqual({ _tag: "whole_source" });
  });

  it("maps a fragment handle to the exact existing fragment (no duplicate row)", async () => {
    const world = await seedResolveWorld();
    const before = world.ctx.db.rows("sourceFragments").length;
    await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Fragment rozstrzyga.",
      evidence: [{ sourceId: world.evidenceSourceId, fragmentId: world.evidenceFragmentId }],
    } as never);
    expect(world.ctx.db.rows("sourceFragments")).toHaveLength(before);
    const row = await readBack(world);
    expect(row.resolutionEvidence).toEqual([
      { sourceId: world.evidenceSourceId, fragmentId: world.evidenceFragmentId },
    ]);
  });
});
