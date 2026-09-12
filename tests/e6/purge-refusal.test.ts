/**
 * E6 focused verification, part 7 (R2 repair, issue #127): late
 * source-derived agent work cannot publish after the source's tombstone,
 * and deleted clarification content is already absent from the agent
 * context the moment the tombstone commits.
 *
 * The 2026-09-12 map review (standards finding S2) observed that the
 * checked executions and the staleness recheck tested source EXISTENCE
 * only: I4 retains a tombstone row, so a raise/resolve computed before the
 * deletion could still publish afterwards. These tests pin the repaired
 * contract through the real module boundaries (the dispatch-level memory
 * commands and the checked executor cores):
 *
 * - R2-P2: a late raise or resolve refuses with a typed code, writes no
 *   row and publishes no outbox event; the staleness recheck aborts.
 * - A tombstone never counts as active: every barrier interleaving
 *  (pause the model work, tombstone, resume) lands in a refusal.
 * - Deleted content is absent from the loaded answer context (evidence
 *  ledger and open clarifications) immediately after the tombstone.
 */

import { describe, expect, it } from "vitest";
import { valueOf, fakeCtx, seedActor, contextFor, type ActorFixture, type FakeCtx } from "../d2/harness";
import { DELETION_TABLES } from "../i4/harness";
import { performPurgeSource, PURGE_CONFIRMATION_PHRASE } from "../../convex/operations/deletion/purge";
import { dispatchMemoryCommand } from "../../convex/memory/findings/dispatch";
import { readClarificationRows } from "../../convex/memory/findings/exposition";
import {
  executeClarificationCore,
  executeResolveClarificationCore,
  stalenessRecheckCore,
} from "../../convex/agent/execute";
import { loadAnswerContext } from "../../convex/agent/context";
import type { ResultEnvelope } from "@kiero/contracts";
import type { Doc } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// The seeded world: a boss, an open clarification, active and doomed sources.
// ---------------------------------------------------------------------------

const SENT_AT_MS = Date.parse("2026-09-09T07:30:00.000Z");
const CANARY_SOURCE_TEXT = "Kaczmarek wpłacił zaliczkę 5000 zł w piątek";
const CANARY_QUESTION = "Ile zaliczki wpłacił Kaczmarek — 5000 zł z piątkowej wiadomości?";

const PURGE_REFUSAL_TABLES = [
  ...DELETION_TABLES,
  "memberships",
  "gmAccessGrants",
  "projects",
  "projectAliases",
  "tasks",
  "events",
  "contacts",
  "processingRuns",
] as const;

interface RefusalWorld {
  readonly ctx: FakeCtx;
  readonly boss: ActorFixture;
  readonly otherBoss: ActorFixture;
  readonly questionSourceId: string;
  /** The source whose fragments anchor the open case (will be purged). */
  readonly doomedSourceId: string;
  readonly doomedFragmentId: string;
  /** An independent active evidence source with its fragment. */
  readonly activeSourceId: string;
  readonly activeFragmentId: string;
  readonly clarificationId: string;
}

async function seedRefusalSource(
  ctx: FakeCtx,
  companyId: string,
  authorUserId: string,
  text: string,
  lifecycle: "active" | "withdrawn" = "active",
): Promise<{ sourceId: string; fragmentId: string }> {
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId,
    authorText: text,
    sentAtMs: SENT_AT_MS - 3_600_000,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: SENT_AT_MS - 3_600_000,
    lifecycle,
    ...(lifecycle === "withdrawn"
      ? { withdrawnAtMs: SENT_AT_MS - 1_800_000, withdrawnReason: "pomyłka" }
      : {}),
  });
  const extractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "text/1",
    model: "fixture",
    provider: "fixture",
    processingRunId: "kprocessingrunst0000000000000",
    createdAtMs: SENT_AT_MS,
  });
  const fragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "text_range", startOffset: 0, endOffset: 40 },
    createdAtMs: SENT_AT_MS,
  });
  return { sourceId, fragmentId: fragmentId as string };
}

async function seedRefusalWorld(): Promise<RefusalWorld> {
  const ctx = fakeCtx(PURGE_REFUSAL_TABLES);
  const boss = await seedActor(ctx, "boss");
  const otherBoss = await seedActor(ctx, "other");

  const question = await seedRefusalSource(
    ctx,
    boss.companyId,
    boss.userId,
    "Jaka zaliczka wpłynęła od Kaczmarka?",
  );
  // ONLY the doomed source ever carries the canary text.
  const doomed = await seedRefusalSource(ctx, boss.companyId, boss.userId, CANARY_SOURCE_TEXT);
  const active = await seedRefusalSource(
    ctx,
    boss.companyId,
    boss.userId,
    "Przelew zaliczki wpłynął we wtorek",
  );

  const clarificationId = await ctx.db.insert("clarifications", {
    companyId: boss.companyId,
    scopeKind: "company",
    question: CANARY_QUESTION,
    conflictingFragmentIds: [doomed.fragmentId],
    state: "open",
    raisedAtMs: SENT_AT_MS - 60_000,
  });

  return {
    ctx,
    boss,
    otherBoss,
    questionSourceId: question.sourceId,
    doomedSourceId: doomed.sourceId,
    doomedFragmentId: doomed.fragmentId,
    activeSourceId: active.sourceId,
    activeFragmentId: active.fragmentId,
    clarificationId,
  };
}

/** Tombstones one source through the REAL initiating transaction. */
async function tombstone(ctx: FakeCtx, world: RefusalWorld, sourceId: string): Promise<void> {
  const result = await performPurgeSource(ctx as never, contextFor(world.boss), {
    sourceId: sourceId as never,
    confirmation: PURGE_CONFIRMATION_PHRASE,
  });
  if ((result as ResultEnvelope)._tag !== "ok") {
    throw new Error("tombstone failed");
  }
}

/** The outbox row count (every published memory event lands here). */
function outboxCount(world: RefusalWorld): number {
  return world.ctx.db.rows("outboxEvents").length;
}

/** The stored clarification rows, straight from the table. */
function clarificationRows(world: RefusalWorld) {
  return world.ctx.db.rows("clarifications");
}

// ---------------------------------------------------------------------------
// R2-P2: late raises refuse with no row and no event.
// ---------------------------------------------------------------------------

describe("R2-P2 a late raise cannot publish after the tombstone", () => {
  it("the dispatch-level raise over a tombstoned source's fragment refuses atomically", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const eventsBefore = outboxCount(world);
    const rowsBefore = clarificationRows(world).length;

    const result = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.raiseClarification",
      input: {
        question: "Późne pytanie o usuniętą wiadomość?",
        conflictingEvidence: [world.doomedFragmentId],
        scope: { _tag: "company" },
      },
      expectedRevisions: [],
    }, world.boss.sessionId);

    expect(result._tag).toBe("error");
    expect((result as { error: { code: string } }).error.code).toBe(
      "conflicting_fragment_source_not_active",
    );
    // No row, no event: the refusal left nothing behind.
    expect(clarificationRows(world)).toHaveLength(rowsBefore);
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("the checked agent raise execution refuses a tombstoned QUESTION source", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.questionSourceId);
    const eventsBefore = outboxCount(world);
    const rowsBefore = clarificationRows(world).length;

    const outcome = await executeClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      question: "Późne pytanie agenta?",
      scopeKind: "company",
      evidence: [{ sourceId: world.activeSourceId, fragmentId: world.activeFragmentId }],
    } as never);

    expect(valueOf(outcome)).toMatchObject({
      outcome: "failed",
      error: "question_source_not_active",
    });
    expect(clarificationRows(world)).toHaveLength(rowsBefore);
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("the checked agent raise execution refuses a tombstoned EVIDENCE source", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const eventsBefore = outboxCount(world);
    const rowsBefore = clarificationRows(world).length;

    const outcome = await executeClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      question: "Pytanie o usuniętą wiadomość?",
      scopeKind: "company",
      evidence: [{ sourceId: world.doomedSourceId, fragmentId: world.doomedFragmentId }],
    } as never);

    expect(valueOf(outcome)).toMatchObject({
      outcome: "failed",
      error: "conflicting_evidence_source_not_active",
    });
    expect(clarificationRows(world)).toHaveLength(rowsBefore);
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("a raise citing only an ACTIVE fragment still lands after an unrelated tombstone", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const result = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.raiseClarification",
      input: {
        question: "Pytanie o aktywną wiadomość?",
        conflictingEvidence: [world.activeFragmentId],
        scope: { _tag: "company" },
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    expect(result._tag).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// R2-P2: late resolves refuse with no event; the case stays open.
// ---------------------------------------------------------------------------

describe("R2-P2 a late resolve cannot publish after the tombstone", () => {
  it("the question source's tombstone refuses the checked resolve execution", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.questionSourceId);
    const eventsBefore = outboxCount(world);

    const outcome = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Późne rozstrzygnięcie.",
      evidence: [{ sourceId: world.activeSourceId, fragmentId: world.activeFragmentId }],
    } as never);

    expect(valueOf(outcome)).toMatchObject({
      outcome: "failed",
      error: "question_source_not_active",
    });
    // The case stays open and nothing was published.
    const row = clarificationRows(world).find((candidate) => candidate._id === world.clarificationId)!;
    expect(row.state).toBe("open");
    expect(row.resolutionNote).toBeUndefined();
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("a tombstoned cited evidence source refuses the resolve (the barrier race)", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const eventsBefore = outboxCount(world);

    const outcome = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: world.clarificationId,
      resolutionNote: "Rozstrzygnięcie wiszące na usuniętym źródle.",
      evidence: [{ sourceId: world.doomedSourceId, fragmentId: world.doomedFragmentId }],
    } as never);

    expect(valueOf(outcome)).toMatchObject({
      outcome: "failed",
      error: "resolution_source_not_active",
    });
    expect(clarificationRows(world).find((row) => row._id === world.clarificationId)).toMatchObject({
      state: "open",
    });
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("a resolve citing only ACTIVE evidence still lands for an actionable case", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    // A NEW case anchored on the ACTIVE source stays actionable; resolving
    // it with active evidence lands (refusals are per-case, never blanket).
    const raised = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.raiseClarification",
      input: {
        question: "Pytanie o aktywną wiadomość?",
        conflictingEvidence: [world.activeFragmentId],
        scope: { _tag: "company" },
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    const clarificationId = (raised as { value: { clarificationId: string } }).value
      .clarificationId;
    const outcome = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId,
      resolutionNote: "Rozstrzygnięcie na aktywnym źródle.",
      evidence: [{ sourceId: world.activeSourceId, fragmentId: world.activeFragmentId }],
    } as never);
    expect(valueOf(outcome)).toMatchObject({ outcome: "resolved" });
    expect(clarificationRows(world).find((row) => row._id === clarificationId)).toMatchObject({
      state: "resolved",
    });
  });
});

// ---------------------------------------------------------------------------
// A redacted open case is not actionable: even an honest late resolve over
// ACTIVE evidence refuses, because the question itself must stay gone.
// ---------------------------------------------------------------------------

describe("a redacted open case refuses resolution", () => {
  it("the tombstone of the case's conflict source makes the case unanswerable", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const result = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.resolveClarification",
      input: {
        clarificationId: world.clarificationId,
        resolutionNote: "Odpowiedź na usunięte pytanie.",
        evidence: [{ sourceId: world.activeSourceId, fragmentId: world.activeFragmentId }],
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    expect(result._tag).toBe("error");
    expect((result as { error: { code: string } }).error.code).toBe("clarification_redacted");
    const row = clarificationRows(world).find((candidate) => candidate._id === world.clarificationId)!;
    expect(row.state).toBe("open");
    expect(row.resolutionNote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The staleness recheck: a tombstone never counts as active.
// ---------------------------------------------------------------------------

describe("the staleness recheck aborts on a tombstoned question source", () => {
  it("returns the typed abort for a retained tombstone (row exists, lifecycle purged)", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.questionSourceId);
    const outcome = await stalenessRecheckCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      loadRevisions: [],
    } as never);
    expect(outcome.decision).toEqual({
      decision: "abort",
      reason: "question_source_not_active",
    });
  });

  it("still reports current for an ACTIVE question source", async () => {
    const world = await seedRefusalWorld();
    const outcome = await stalenessRecheckCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      loadRevisions: [],
    } as never);
    expect(outcome.decision).toEqual({ decision: "current" });
  });
});

// ---------------------------------------------------------------------------
// The agent context: deleted content and dead references are already absent.
// ---------------------------------------------------------------------------

describe("the answer context after the tombstone (before any purge stage)", () => {
  it("hides the redacted open case and carries no dead reference", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);

    const source = (await world.ctx.db.get(world.questionSourceId)) as Doc<"sources">;
    const context = await loadAnswerContext(world.ctx.db as never, {
      source,
      runId: "r2-purge-refusal",
      nowMs: Date.now(),
    });
    if (context === null) {
      throw new Error("loadAnswerContext refused an active question source");
    }
    // The redacted open case is gone from the actionable clarifications.
    expect(context.clarifications.find(
      (row) => row.clarificationId === world.clarificationId,
    )).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain(CANARY_SOURCE_TEXT);
    expect(JSON.stringify(context)).not.toContain(CANARY_QUESTION);
    // No evidence handle may point at the tombstoned source.
    expect(context.evidence.every((entry) => entry.sourceId !== world.doomedSourceId)).toBe(true);
    expect(context.sources.every((row) => row.sourceId !== world.doomedSourceId || row.preview === "")).toBe(true);
  });

  it("refuses the whole load when the QUESTION source itself is tombstoned", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.questionSourceId);
    const source = (await world.ctx.db.get(world.questionSourceId)) as Doc<"sources">;
    const context = await loadAnswerContext(world.ctx.db as never, {
      source,
      runId: "r2-purge-refusal",
      nowMs: Date.now(),
    });
    expect(context).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The boss-facing read the Co teraz surface rides: hidden immediately.
// ---------------------------------------------------------------------------

describe("the Co teraz read after the tombstone", () => {
  it("lists no redacted open case and no deleted reference", async () => {
    const world = await seedRefusalWorld();
    await tombstone(world.ctx, world, world.doomedSourceId);
    const rows = await readClarificationRows(world.ctx.db as never, contextFor(world.boss), {
      scope: { _tag: "company" },
    } as never);
    if (!rows.ok) {
      throw new Error("readClarifications failed");
    }
    const open = rows.rows.filter((row) => row.state === "open");
    expect(open.find((row) => row.clarificationId === world.clarificationId)).toBeUndefined();
    expect(JSON.stringify(rows.rows)).not.toContain(CANARY_SOURCE_TEXT);
    expect(JSON.stringify(rows.rows)).not.toContain(CANARY_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// The withdrawn-source matrix (R2 round 3): withdrawal deletes nothing, so
// withdrawn-anchored cases stay answerable — while GROUNDING new work on a
// withdrawn source still refuses (the grounding/content predicate split).
// ---------------------------------------------------------------------------

describe("the withdrawn-source matrix", () => {
  /** Seeds a boss world with a withdrawn source and an ACTIVE anchor pair. */
  async function seedWithdrawnWorld() {
    const world = await seedRefusalWorld();
    const withdrawn = await seedRefusalSource(
      world.ctx,
      world.boss.companyId,
      world.boss.userId,
      "Wiadomość wycofana: zaliczka 3000 zł",
      "withdrawn",
    );
    const withdrawnCaseId = await world.ctx.db.insert("clarifications", {
      companyId: world.boss.companyId,
      scopeKind: "company",
      question: "Czy zaliczka wynosi 3000 zł?",
      conflictingFragmentIds: [withdrawn.fragmentId],
      state: "open",
      raisedAtMs: SENT_AT_MS - 30_000,
    });
    return { world, withdrawn, withdrawnCaseId };
  }

  it("an open case anchored on a withdrawn source stays in the agent context with its real question", async () => {
    const { world, withdrawnCaseId } = await seedWithdrawnWorld();
    const source = (await world.ctx.db.get(world.questionSourceId)) as Doc<"sources">;
    const context = await loadAnswerContext(world.ctx.db as never, {
      source,
      runId: "r2-withdrawn-matrix",
      nowMs: Date.now(),
    });
    if (context === null) {
      throw new Error("loadAnswerContext refused an active question source");
    }
    const row = context.clarifications.find(
      (candidate) => candidate.clarificationId === withdrawnCaseId,
    );
    if (row === undefined) {
      throw new Error("withdrawn-anchored open case missing from agent context");
    }
    expect(row.question).toBe("Czy zaliczka wynosi 3000 zł?");
  });

  it("a withdrawn-anchored open case resolves normally on ACTIVE evidence", async () => {
    const { world, withdrawnCaseId } = await seedWithdrawnWorld();
    const outcome = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: withdrawnCaseId,
      resolutionNote: "Obowiązuje kwota z przelewu.",
      evidence: [{ sourceId: world.activeSourceId, fragmentId: world.activeFragmentId }],
    } as never);
    expect(valueOf(outcome)).toMatchObject({ outcome: "resolved" });
    const stored = clarificationRows(world).find((row) => row._id === withdrawnCaseId)!;
    expect(stored.state).toBe("resolved");
    expect(stored.resolutionNote).toBe("Obowiązuje kwota z przelewu.");
  });

  it("RAISING a new case that grounds on a withdrawn source's fragment still refuses", async () => {
    const { world, withdrawn } = await seedWithdrawnWorld();
    const eventsBefore = outboxCount(world);
    const result = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.raiseClarification",
      input: {
        question: "Pytanie oparte na wycofanej wiadomości?",
        conflictingEvidence: [withdrawn.fragmentId],
        scope: { _tag: "company" },
      },
      expectedRevisions: [],
    }, world.boss.sessionId);
    expect(result._tag).toBe("error");
    expect((result as { error: { code: string } }).error.code).toBe(
      "conflicting_fragment_source_not_active",
    );
    expect(outboxCount(world)).toBe(eventsBefore);
  });

  it("RESOLVING with evidence that grounds on a withdrawn source still refuses (R1 stance)", async () => {
    const { world, withdrawn, withdrawnCaseId } = await seedWithdrawnWorld();
    const outcome = await executeResolveClarificationCore(world.ctx as never, {
      questionSourceId: world.questionSourceId,
      clarificationId: withdrawnCaseId,
      resolutionNote: "Rozstrzygnięcie na wycofanej wiadomości.",
      evidence: [{ sourceId: withdrawn.sourceId, fragmentId: withdrawn.fragmentId }],
    } as never);
    expect(valueOf(outcome)).toMatchObject({
      outcome: "failed",
      error: "resolution_source_not_active",
    });
    expect(
      clarificationRows(world).find((row) => row._id === withdrawnCaseId),
    ).toMatchObject({ state: "open" });
  });
});
