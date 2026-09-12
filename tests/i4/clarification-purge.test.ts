/**
 * I4 focused verification, part 4 (R2 repair, issue #127): the purge of
 * clarification content linked to a permanently deleted source, and the
 * immediate read-side redaction that holds from the tombstone on, before
 * any asynchronous purge stage runs.
 *
 * The 2026-09-12 map review (standards finding S2) observed that I4 deletes
 * fragments but never handles `clarifications`: `readClarificationRows`
 * still exposed `question` and `resolutionNote` after their conflicting
 * fragments disappeared, so text quoting a deleted message stayed visible.
 * These tests pin the repaired contract:
 *
 * - R2-P1: after deletion of a contributing source, no original question,
 *   note or dead reference survives any clarification read; redacted open
 *   cases leave the actionable list (Pamięć and Co teraz ride this read).
 * - R2-P3: independent ACTIVE corroboration and unrelated cases survive
 *   without retaining any deleted content.
 * - The withdrawn-source matrix (round 3): withdrawal deletes nothing, so
 *   withdrawn-anchored cases stay visible, answerable and un-redacted;
 *   only permanent deletion (purged) triggers redaction.
 * - The immediate window: the deletion executor is PAUSED right after the
 *   tombstone (no physical cleanup yet) and every read already redacts or
 *   hides - the stored purge only freezes what the reads already show.
 * - The durable purge: stored text is replaced with the fixed Polish
 *   redaction copy, associations to the deleted source are removed,
 *   content-free audit metadata is recorded, timestamps/actor/surviving
 *   references stay, and a full stage retry changes nothing (the stage
 *   transaction is atomic; interruption means retry, and redaction is
 *   idempotent by link removal).
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, type ResultEnvelope } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import { performPurgeSource, PURGE_CONFIRMATION_PHRASE } from "../../convex/operations/deletion/purge";
import { readClarificationRows } from "../../convex/memory/findings/exposition";
import { dispatchMemoryCommand } from "../../convex/memory/findings/dispatch";
import {
  REDACTED_CLARIFICATION_QUESTION_COPY,
  REDACTED_CLARIFICATION_RESOLUTION_COPY,
} from "../../convex/memory/findings/references";
import { purgeSourceExecutor } from "../../convex/operations/deletion/executor";
import { PURGE_STAGE_KINDS } from "../../convex/operations/deletion/schema";
import { DELETION_TABLES, asTx, fakeCtx, type FakeCtx } from "./harness";
import type { DurableJobDoc } from "../../convex/platform/executors";

// ---------------------------------------------------------------------------
// The seeded world: one company, three sources, six clarifications.
// ---------------------------------------------------------------------------

/** Deleted-content canaries: this text must never survive any read or row. */
const CANARY_SOURCE_TEXT = "Kaczmarek wpłacił zaliczkę 5000 zł w piątek";
const CANARY_QUESTION = "Ile zaliczki wpłacił Kaczmarek — 5000 zł z piątkowej wiadomości?";
const CANARY_NOTE = "Obowiązuje zaliczka 5000 zł z wiadomości Kaczmarka.";
const INDEPENDENT_NOTE = "Zaliczka potwierdzona przelewem z wtorku.";
const MANUAL_NOTE = "Obowiązuje kwota z ustaleń szefów.";

const RAISED_AT_MS = Date.parse("2026-09-08T09:00:00.000Z");
const RESOLVED_AT_MS = Date.parse("2026-09-09T10:00:00.000Z");

interface SeededFragment {
  readonly sourceId: string;
  readonly fragmentId: string;
}

interface PurgeWorld {
  readonly ctx: FakeCtx;
  readonly context: RequestContext;
  readonly bossUserId: string;
  /** The source that will be permanently deleted. */
  readonly deleted: SeededFragment;
  /** An independent active source with its fragment. */
  readonly activeT: SeededFragment;
  /** Another independent active source (resolution corroboration). */
  readonly activeU: SeededFragment;
  readonly openDeadId: string;
  readonly resolvedIndependentId: string;
  readonly resolvedLegacyId: string;
  readonly resolvedManualId: string;
  readonly resolvedDeadEvidenceId: string;
  readonly unrelatedId: string;
  readonly deletionRecordId: string;
}

async function seedBossContext(ctx: FakeCtx): Promise<{ context: RequestContext; userId: string }> {
  const companyId = await ctx.db.insert("companies", { name: "Firma", timezone: "Europe/Warsaw" });
  const userId = await ctx.db.insert("users", { email: "szef@firma.invalid" });
  const sessionId = await ctx.db.insert("sessions", { userId, state: "live", createdAtMs: 1 });
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId,
    companyId,
    membershipRole: "admin",
    isGm: false,
    sessionId,
    via: "user",
  });
  return { context: { actor, resolvedAtMs: Date.now() }, userId };
}

/** Seeds one active source with a text extraction and one fragment. */
async function seedSourceWithFragment(
  ctx: FakeCtx,
  companyId: string,
  authorUserId: string,
  text: string,
  lifecycle: "active" | "withdrawn" = "active",
): Promise<SeededFragment> {
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId,
    authorText: text,
    sentAtMs: RAISED_AT_MS - 7_200_000,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: RAISED_AT_MS - 7_200_000,
    lifecycle,
    ...(lifecycle === "withdrawn"
      ? { withdrawnAtMs: RAISED_AT_MS - 1_800_000, withdrawnReason: "pomyłka" }
      : {}),
  });
  const extractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "text/1",
    model: "fixture",
    provider: "fixture",
    processingRunId: "kprocessingrunst0000000000000",
    createdAtMs: RAISED_AT_MS - 3_600_000,
  });
  const fragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "text_range", startOffset: 0, endOffset: text.length },
    createdAtMs: RAISED_AT_MS - 3_600_000,
  });
  return { sourceId, fragmentId: fragmentId as string };
}

async function seedClarification(
  ctx: FakeCtx,
  companyId: string,
  row: Record<string, unknown>,
): Promise<string> {
  return await ctx.db.insert("clarifications", {
    companyId,
    scopeKind: "company",
    raisedAtMs: RAISED_AT_MS,
    ...row,
  });
}

/** Seeds the world WITHOUT deleting anything yet. */
async function seedPurgeWorld(): Promise<Omit<PurgeWorld, "deletionRecordId">> {
  const ctx = fakeCtx(DELETION_TABLES);
  const { context, userId } = await seedBossContext(ctx);
  const companyId = context.actor.companyId as string;
  const deleted = await seedSourceWithFragment(ctx, companyId, userId, CANARY_SOURCE_TEXT);
  const activeT = await seedSourceWithFragment(ctx, companyId, userId, "Termin montażu 20 września");
  const activeU = await seedWithFragmentU(ctx, companyId, userId);
  const openDeadId = await seedClarification(ctx, companyId, {
    question: CANARY_QUESTION,
    conflictingFragmentIds: [deleted.fragmentId],
    state: "open",
  });
  const resolvedIndependentId = await seedClarification(ctx, companyId, {
    question: CANARY_QUESTION,
    conflictingFragmentIds: [deleted.fragmentId, activeT.fragmentId],
    state: "resolved",
    resolvedByUserId: userId,
    resolutionNote: INDEPENDENT_NOTE,
    resolvedAtMs: RESOLVED_AT_MS,
    resolutionBasis: "source_backed",
    resolutionEvidence: [{ sourceId: activeU.sourceId, sourceFragmentId: activeU.fragmentId }],
  });
  const resolvedLegacyId = await seedClarification(ctx, companyId, {
    question: CANARY_QUESTION,
    conflictingFragmentIds: [deleted.fragmentId],
    state: "resolved",
    resolvedByUserId: userId,
    resolutionNote: CANARY_NOTE,
    resolvedAtMs: RESOLVED_AT_MS,
  });
  const resolvedManualId = await seedClarification(ctx, companyId, {
    question: CANARY_QUESTION,
    conflictingFragmentIds: [deleted.fragmentId],
    state: "resolved",
    resolvedByUserId: userId,
    resolutionNote: MANUAL_NOTE,
    resolvedAtMs: RESOLVED_AT_MS,
    resolutionBasis: "manual_boss_decision",
    resolutionEvidence: [],
  });
  const resolvedDeadEvidenceId = await seedClarification(ctx, companyId, {
    question: "Który termin montażu obowiązuje?",
    conflictingFragmentIds: [activeT.fragmentId],
    state: "resolved",
    resolvedByUserId: userId,
    resolutionNote: CANARY_NOTE,
    resolvedAtMs: RESOLVED_AT_MS,
    resolutionBasis: "source_backed",
    resolutionEvidence: [
      { sourceId: deleted.sourceId, sourceFragmentId: deleted.fragmentId },
      { sourceId: activeU.sourceId, sourceFragmentId: activeU.fragmentId },
    ],
  });
  const unrelatedId = await seedClarification(ctx, companyId, {
    question: "Kto dowozi płytki na Banan?",
    conflictingFragmentIds: [activeT.fragmentId],
    state: "open",
  });
  return {
    ctx,
    context,
    bossUserId: userId,
    deleted,
    activeT,
    activeU,
    openDeadId,
    resolvedIndependentId,
    resolvedLegacyId,
    resolvedManualId,
    resolvedDeadEvidenceId,
    unrelatedId,
  };
}

async function seedWithFragmentU(
  ctx: FakeCtx,
  companyId: string,
  userId: string,
): Promise<SeededFragment> {
  return await seedSourceWithFragment(ctx, companyId, userId, "Przelew zaliczki wpłynął we wtorek");
}

/** Tombstones the deleted source through the REAL initiating transaction. */
async function tombstoneDeletedSource(world: Omit<PurgeWorld, "deletionRecordId">): Promise<string> {
  const result = await performPurgeSource(asTx(world.ctx), world.context, {
    sourceId: world.deleted.sourceId as never,
    confirmation: PURGE_CONFIRMATION_PHRASE,
  });
  const record = (result as ResultEnvelope & { value: { deletionRecordId: string } }).value
    .deletionRecordId;
  return record;
}

/** The boss-facing clarifications read of the company scope. */
async function readRows(world: PurgeWorld | Omit<PurgeWorld, "deletionRecordId">) {
  const rows = await readClarificationRows(world.ctx.db as never, world.context, {
    scope: { _tag: "company" },
  } as never);
  if (!rows.ok) {
    throw new Error(`readClarifications failed: ${JSON.stringify(rows.error)}`);
  }
  return rows.rows;
}

/** The stored clarification row, straight from the seeded table. */
function storedRow(world: PurgeWorld | Omit<PurgeWorld, "deletionRecordId">, id: string) {
  const row = world.ctx.db.rows("clarifications").find((candidate) => candidate._id === id);
  if (row === undefined) {
    throw new Error(`clarification row ${id} missing`);
  }
  return row;
}

/** Runs the full durable purge executor (every stage, in transaction). */
async function runExecutor(world: PurgeWorld): Promise<void> {
  const input = { sourceId: world.deleted.sourceId, deletionRecordId: world.deletionRecordId };
  const job = {
    jobKey: `job-${world.deletionRecordId}`,
    kind: "deletion.purge_source",
    inputJson: JSON.stringify(input),
    attempts: 0,
    maxAttempts: 6,
    state: "running",
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as DurableJobDoc;
  const outcome = await purgeSourceExecutor.execute(asTx(world.ctx), job, input);
  if (outcome.outcome !== "succeeded" && outcome.outcome !== "external") {
    throw new Error(`purge executor failed: ${JSON.stringify(outcome)}`);
  }
}

// ---------------------------------------------------------------------------
// R2-P1: the red canary — deleted clarification text cannot survive the read.
// ---------------------------------------------------------------------------

describe("R2-P1 deleted clarification text cannot survive deletion of a contributing source", () => {
  it("the red canary: after the tombstone (before any purge stage), no read exposes deleted text", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    // Deleted content never appears in any read row.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(CANARY_SOURCE_TEXT);
    expect(serialized).not.toContain(CANARY_QUESTION);
    expect(serialized).not.toContain(CANARY_NOTE);
  });

  it("a redacted open case is absent from the actionable list (Pamięć and Co teraz)", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    expect(rows.find((row) => row.clarificationId === world.openDeadId)).toBeUndefined();
  });

  it("affected resolved rows redact the question but keep actor, timestamps and surviving references", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    const independent = rows.find((row) => row.clarificationId === world.resolvedIndependentId)!;
    expect(independent.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    // Surviving ACTIVE conflicting reference stays; the deleted one is gone.
    expect(independent.conflictingEvidence).toEqual([
      { fragmentId: world.activeT.fragmentId, sourceId: world.activeT.sourceId },
    ]);
    // Independent active resolution corroboration stays, note and all.
    expect(independent.resolutionNote).toBe(INDEPENDENT_NOTE);
    expect(independent.resolutionEvidence).toEqual([
      { sourceId: world.activeU.sourceId, fragmentId: world.activeU.fragmentId },
    ]);
    expect(independent.resolvedByUserId).toBe(world.bossUserId);
    expect(independent.resolvedAtMs).toBe(RESOLVED_AT_MS);
  });

  it("a source-backed resolution whose evidence included the deleted source redacts the note and drops the dead reference", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    const deadEvidence = rows.find((row) => row.clarificationId === world.resolvedDeadEvidenceId)!;
    expect(deadEvidence.resolutionNote).toBe(REDACTED_CLARIFICATION_RESOLUTION_COPY);
    expect(deadEvidence.resolutionEvidence).toEqual([
      { sourceId: world.activeU.sourceId, fragmentId: world.activeU.fragmentId },
    ]);
  });

  it("a legacy (pre-R1) resolution whose conflict included the deleted source redacts question and note", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    const legacy = rows.find((row) => row.clarificationId === world.resolvedLegacyId)!;
    expect(legacy.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    expect(legacy.resolutionNote).toBe(REDACTED_CLARIFICATION_RESOLUTION_COPY);
    expect(legacy.resolutionBasis).toBe("legacy_unknown");
  });

  it("a manual boss decision keeps its note (its basis never rested on the deleted source)", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    const manual = rows.find((row) => row.clarificationId === world.resolvedManualId)!;
    expect(manual.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    expect(manual.resolutionNote).toBe(MANUAL_NOTE);
    expect(manual.resolutionBasis).toBe("manual_boss_decision");
  });

  it("R2-P3: unrelated cases and their active references survive untouched", async () => {
    const world = await seedPurgeWorld();
    await tombstoneDeletedSource(world);
    const rows = await readRows(world);
    const unrelated = rows.find((row) => row.clarificationId === world.unrelatedId)!;
    expect(unrelated.question).toBe("Kto dowozi płytki na Banan?");
    expect(unrelated.conflictingEvidence).toEqual([
      { fragmentId: world.activeT.fragmentId, sourceId: world.activeT.sourceId },
    ]);
    expect(unrelated.questionRedacted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The durable purge: stored rows, audit metadata, idempotent batches.
// ---------------------------------------------------------------------------

describe("the durable clarification purge inside the deletion executor", () => {
  async function seedAndRun(): Promise<PurgeWorld> {
    const seeded = await seedPurgeWorld();
    const deletionRecordId = await tombstoneDeletedSource(seeded);
    const world: PurgeWorld = { ...seeded, deletionRecordId };
    await runExecutor(world);
    return world;
  }

  it("replaces stored question/note text with the fixed copy and records content-free audit metadata", async () => {
    const world = await seedAndRun();

    const openDead = storedRow(world, world.openDeadId);
    expect(openDead.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    expect(openDead.conflictingFragmentIds).toEqual([]);
    expect(openDead.purgeAudit).toMatchObject({
      redactedSourceIds: [world.deleted.sourceId],
    });
    const audit = openDead.purgeAudit as {
      redactedSourceIds: string[];
      questionRedactedAtMs?: number;
    };
    expect(audit.questionRedactedAtMs).toBeTypeOf("number");

    const deadEvidence = storedRow(world, world.resolvedDeadEvidenceId);
    expect(deadEvidence.resolutionNote).toBe(REDACTED_CLARIFICATION_RESOLUTION_COPY);
    expect(deadEvidence.resolutionEvidence).toEqual([
      { sourceId: world.activeU.sourceId, sourceFragmentId: world.activeU.fragmentId },
    ]);
    expect(
      (deadEvidence.purgeAudit as { resolutionNoteRedactedAtMs?: number })
        .resolutionNoteRedactedAtMs,
    ).toBeTypeOf("number");

    const legacy = storedRow(world, world.resolvedLegacyId);
    expect(legacy.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    expect(legacy.resolutionNote).toBe(REDACTED_CLARIFICATION_RESOLUTION_COPY);

    // Timestamps and actor survive the purge.
    expect(legacy.resolvedByUserId).toBe(world.bossUserId);
    expect(legacy.resolvedAtMs).toBe(RESOLVED_AT_MS);
    expect(legacy.raisedAtMs).toBe(RAISED_AT_MS);

    const independent = storedRow(world, world.resolvedIndependentId);
    expect(independent.resolutionNote).toBe(INDEPENDENT_NOTE);
    expect(independent.conflictingFragmentIds).toEqual([world.activeT.fragmentId]);

    const unrelated = storedRow(world, world.unrelatedId);
    expect(unrelated.purgeAudit).toBeUndefined();
    expect(unrelated.question).toBe("Kto dowozi płytki na Banan?");

    // The stored rows (the export snapshot projects them verbatim) never
    // carry deleted content, and they DO carry the purge state.
    const serialized = JSON.stringify(world.ctx.db.rows("clarifications"));
    expect(serialized).not.toContain(CANARY_SOURCE_TEXT);
    expect(serialized).not.toContain(CANARY_QUESTION);
    expect(serialized).not.toContain(CANARY_NOTE);
    expect(serialized).toContain("purgeAudit");
  });

  it("deletes the purged source's fragments and leaves the independent ones", async () => {
    const world = await seedAndRun();
    const fragments = world.ctx.db.rows("sourceFragments");
    expect(fragments.find((row) => row._id === world.deleted.fragmentId)).toBeUndefined();
    expect(fragments.find((row) => row._id === world.activeT.fragmentId)).toBeDefined();
    expect(fragments.find((row) => row._id === world.activeU.fragmentId)).toBeDefined();
    const stages = world.ctx.db.rows("deletionPurgeStages");
    expect(stages.every((stage) => stage.state === "purged")).toBe(true);
  });

  it("reads stay consistent after the stored purge (redaction is sticky)", async () => {
    const world = await seedAndRun();
    const rows = await readRows(world);
    expect(rows.find((row) => row.clarificationId === world.openDeadId)).toBeUndefined();
    const legacy = rows.find((row) => row.clarificationId === world.resolvedLegacyId)!;
    expect(legacy.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    expect(legacy.resolutionNote).toBe(REDACTED_CLARIFICATION_RESOLUTION_COPY);
    expect(legacy.questionRedacted).toBe(true);
    expect(legacy.resolutionNoteRedacted).toBe(true);
  });

  it("a full retry after completion changes nothing (idempotent across every stage)", async () => {
    const world = await seedAndRun();
    const before = JSON.stringify(
      world.ctx.db.rows("clarifications").map((row) => ({ ...row })),
    );
    await runExecutor(world);
    await runExecutor(world);
    const after = JSON.stringify(world.ctx.db.rows("clarifications"));
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The withdrawn-source matrix (R2 round 3): withdrawal deletes nothing.
// ---------------------------------------------------------------------------

describe("a withdrawn source keeps its content, links and answerable cases", () => {
  /** Seeds a boss world with one withdrawn source (text and fragment kept). */
  async function seedWithdrawnWorld() {
    // The resolve leg dispatches through the real command path, which
    // resolves the actor's membership like every dispatch does.
    const ctx = fakeCtx([...DELETION_TABLES, "memberships", "gmAccessGrants"]);
    const { context, userId } = await seedBossContext(ctx);
    const companyId = context.actor.companyId as string;
    await ctx.db.insert("memberships", {
      companyId,
      userId,
      role: "admin",
      state: "active",
      createdAtMs: 1,
    });
    const withdrawn = await seedSourceWithFragment(
      ctx,
      companyId,
      userId,
      "Wiadomość wycofana: termin 10 października",
      "withdrawn",
    );
    return { ctx, context, companyId, userId, withdrawn };
  }

  it("an OPEN case anchored on a withdrawn source stays visible, actionable and resolvable", async () => {
    const world = await seedWithdrawnWorld();
    const openId = await world.ctx.db.insert("clarifications", {
      companyId: world.companyId,
      scopeKind: "company",
      question: "Który termin obowiązuje — 10 października?",
      conflictingFragmentIds: [world.withdrawn.fragmentId],
      state: "open",
      raisedAtMs: RAISED_AT_MS,
    });
    const rows = await readClarificationRows(world.ctx.db as never, world.context, {
      scope: { _tag: "company" },
    } as never);
    if (!rows.ok) {
      throw new Error("readClarifications failed");
    }
    const row = rows.rows.find((candidate) => candidate.clarificationId === openId)!;
    // The REAL question and the withdrawn source's reference stay.
    expect(row.question).toBe("Który termin obowiązuje — 10 października?");
    expect(row.questionRedacted).toBe(false);
    expect(row.conflictingEvidence).toEqual([
      { fragmentId: world.withdrawn.fragmentId, sourceId: world.withdrawn.sourceId },
    ]);

    // Actionable: the boss resolves it normally (manual decision, note kept).
    const sessionId = (world.ctx.db.rows("sessions")[0] as { _id: string })._id;
    const resolved = await dispatchMemoryCommand(world.ctx as never, {
      operation: "memory.resolveClarification",
      input: {
        clarificationId: openId,
        resolutionNote: "Obowiązuje 10 października — ustaliliśmy telefonicznie.",
      },
      expectedRevisions: [],
    }, sessionId);
    expect(resolved._tag).toBe("ok");
    const stored = world.ctx.db.rows("clarifications").find((candidate) => candidate._id === openId)!;
    expect(stored.state).toBe("resolved");
    expect(stored.resolutionNote).toBe("Obowiązuje 10 października — ustaliliśmy telefonicznie.");
    expect(stored.purgeAudit).toBeUndefined();
  });

  it("a RESOLVED row citing a withdrawn source keeps its real note and evidence (no false redaction copy)", async () => {
    const world = await seedWithdrawnWorld();
    const active = await seedSourceWithFragment(world.ctx, world.companyId, world.userId, "Termin 20 września");
    const resolvedId = await world.ctx.db.insert("clarifications", {
      companyId: world.companyId,
      scopeKind: "company",
      question: "Który termin montażu obowiązuje?",
      conflictingFragmentIds: [world.withdrawn.fragmentId, active.fragmentId],
      state: "resolved",
      resolvedByUserId: world.userId,
      resolutionNote: INDEPENDENT_NOTE,
      resolvedAtMs: RESOLVED_AT_MS,
      resolutionBasis: "source_backed",
      resolutionEvidence: [
        { sourceId: world.withdrawn.sourceId, sourceFragmentId: world.withdrawn.fragmentId },
        { sourceId: active.sourceId, sourceFragmentId: active.fragmentId },
      ],
    });
    const rows = await readClarificationRows(world.ctx.db as never, world.context, {
      scope: { _tag: "company" },
    } as never);
    if (!rows.ok) {
      throw new Error("readClarifications failed");
    }
    const row = rows.rows.find((candidate) => candidate.clarificationId === resolvedId)!;
    expect(row.question).toBe("Który termin montażu obowiązuje?");
    expect(row.questionRedacted).toBe(false);
    expect(row.resolutionNoteRedacted).toBe(false);
    expect(row.resolutionNote).toBe(INDEPENDENT_NOTE);
    // Both references stay, the withdrawn one included.
    expect(row.resolutionEvidence).toEqual([
      { sourceId: world.withdrawn.sourceId, fragmentId: world.withdrawn.fragmentId },
      { sourceId: active.sourceId, fragmentId: active.fragmentId },
    ]);
    expect(row.conflictingEvidence).toHaveLength(2);
  });

  it("a purge of an UNRELATED source never touches withdrawn-anchored rows (storage converges only for deletion)", async () => {
    const world = await seedWithdrawnWorld();
    const openId = await world.ctx.db.insert("clarifications", {
      companyId: world.companyId,
      scopeKind: "company",
      question: "Który termin obowiązuje — 10 października?",
      conflictingFragmentIds: [world.withdrawn.fragmentId],
      state: "open",
      raisedAtMs: RAISED_AT_MS,
    });
    // An unrelated source gets permanently deleted and fully purged.
    const doomed = await seedSourceWithFragment(world.ctx, world.companyId, world.userId, CANARY_SOURCE_TEXT);
    await world.ctx.db.insert("clarifications", {
      companyId: world.companyId,
      scopeKind: "company",
      question: CANARY_QUESTION,
      conflictingFragmentIds: [doomed.fragmentId],
      state: "open",
      raisedAtMs: RAISED_AT_MS + 1,
    });
    const record = (await performPurgeSource(asTx(world.ctx), world.context, {
      sourceId: doomed.sourceId as never,
      confirmation: PURGE_CONFIRMATION_PHRASE,
    }) as ResultEnvelope & { value: { deletionRecordId: string } }).value.deletionRecordId;
    const job = {
      jobKey: `job-${record}`,
      kind: "deletion.purge_source",
      inputJson: JSON.stringify({ sourceId: doomed.sourceId, deletionRecordId: record }),
      attempts: 0,
      maxAttempts: 6,
      state: "running",
      createdAtMs: 1,
      updatedAtMs: 1,
    } as unknown as DurableJobDoc;
    await purgeSourceExecutor.execute(
      asTx(world.ctx),
      job,
      { sourceId: doomed.sourceId, deletionRecordId: record },
    );

    const stored = world.ctx.db.rows("clarifications").find((candidate) => candidate._id === openId)!;
    expect(stored.question).toBe("Który termin obowiązuje — 10 października?");
    expect(stored.purgeAudit).toBeUndefined();
    expect(stored.conflictingFragmentIds).toEqual([world.withdrawn.fragmentId]);
  });
});

// ---------------------------------------------------------------------------
// Malformed and cross-company references never leak into reads.
// ---------------------------------------------------------------------------

describe("cross-company and malformed conflicting references", () => {
  it("a fragment of another company's source is a dead link: the open case hides", async () => {
    const world = await seedPurgeWorld();
    const foreignCompany = await world.ctx.db.insert("companies", { name: "Obca", timezone: "UTC" });
    const foreignUserId = await world.ctx.db.insert("users", { email: "szef@obca.invalid" });
    const foreign = await seedSourceWithFragment(
      world.ctx,
      foreignCompany,
      foreignUserId,
      "Obca firma: tajne ustalenie",
    );
    await world.ctx.db.insert("clarifications", {
      companyId: world.context.actor.companyId as string,
      scopeKind: "company",
      question: "Obca sprawa z obcym fragmentem?",
      conflictingFragmentIds: [foreign.fragmentId],
      state: "open",
      raisedAtMs: RAISED_AT_MS,
    });
    const rows = await readRows(world);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("Obca firma: tajne ustalenie");
    expect(rows.every((row) => row.conflictingEvidence.every(
      (entry) => entry.sourceId !== foreign.sourceId,
    ))).toBe(true);
  });

  it("a dangling fragment id is a dead link too: the open case hides", async () => {
    const world = await seedPurgeWorld();
    const id = await world.ctx.db.insert("clarifications", {
      companyId: world.context.actor.companyId as string,
      scopeKind: "company",
      question: "Sprawa o wiszącym fragmencie?",
      conflictingFragmentIds: ["k1234567890123456789zz"],
      state: "open",
      raisedAtMs: RAISED_AT_MS,
    });
    const rows = await readRows(world);
    expect(rows.find((row) => row.clarificationId === id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The stage inventory stays the shared schema's (no new stage kinds).
// ---------------------------------------------------------------------------

describe("purge stage inventory", () => {
  it("the clarification purge rides the existing transcripts stage", async () => {
    const world = await seedPurgeWorld();
    const recordId = await tombstoneDeletedSource(world);
    const stages = world.ctx.db.rows("deletionPurgeStages");
    expect(stages.map((stage) => stage.stageKind).sort()).toEqual([...PURGE_STAGE_KINDS].sort());
    void recordId;
  });
});
