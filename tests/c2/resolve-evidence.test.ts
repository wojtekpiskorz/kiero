/**
 * C2 focused verification, part 3 (R1 repair, issue #126): the clarification
 * resolution command's evidence contract at the transaction boundary.
 *
 * The resolution transaction now persists whether its basis is
 * source-backed (normalized source + optional fragment references) or a
 * manual boss decision, and refuses atomically on any invalid reference.
 * These tests drive the REAL checked command path (dispatchMemoryCommand)
 * against the shared D2 in-memory Convex emulation:
 *
 * - unknown, cross-company, inactive and mismatched-fragment references
 *   refuse the WHOLE command (typed codes) and leave the case open with
 *   nothing stored;
 * - duplicate references collapse at the command boundary too;
 * - the compatibility story: the pre-repair note-only envelope still
 *   decodes and resolves as a manual decision, and a pre-repair resolved
 *   row reads back as the explicit `legacy_unknown` — never a guessed
 *   manual boss decision;
 * - the schema fragment carries the new optional fields.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { memoryOperations } from "@kiero/contracts";
import {
  errorOf,
  fakeCtx,
  seedActor,
  contextFor,
  valueOf,
  type ActorFixture,
  type FakeCtx,
} from "../d2/harness";
import { dispatchMemoryCommand } from "../../convex/memory/findings/dispatch";
import { readClarificationRows } from "../../convex/memory/findings/exposition";
import { findingsTables } from "../../convex/memory/findings/schema";
import type { GenericValidator } from "convex/values";

const SENT_AT_MS = Date.parse("2026-09-09T07:30:00.000Z");

const TABLES = [
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

interface CommandWorld {
  readonly ctx: FakeCtx;
  readonly boss: ActorFixture;
  readonly ownSourceId: string;
  readonly ownFragmentId: string;
  readonly secondOwnSourceId: string;
  readonly withdrawnSourceId: string;
  readonly foreignSourceId: string;
  readonly clarificationId: string;
}

async function seedWorld(): Promise<CommandWorld> {
  const ctx = fakeCtx(TABLES);
  const boss = await seedActor(ctx, "boss");
  const foreign = await seedActor(ctx, "foreign");

  const seedSource = async (
    companyId: string,
    userId: string,
    lifecycle: "active" | "withdrawn",
  ): Promise<string> => {
    const sourceId = await ctx.db.insert("sources", {
      companyId,
      authorUserId: userId,
      authorText: "Wiadomość",
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: SENT_AT_MS,
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
  };

  const ownSourceId = await seedSource(boss.companyId, boss.userId, "active");
  const secondOwnSourceId = await seedSource(boss.companyId, boss.userId, "active");
  const withdrawnSourceId = await seedSource(boss.companyId, boss.userId, "withdrawn");
  const foreignSourceId = await seedSource(foreign.companyId, foreign.userId, "active");

  const extractionId = ctx.db
    .rows("extractions")
    .find((row) => row.sourceId === ownSourceId)?._id as string;
  const ownFragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId: ownSourceId,
    anchor: { _tag: "text_range", startOffset: 0, endOffset: 10 },
    createdAtMs: SENT_AT_MS,
  });

  const clarificationId = await ctx.db.insert("clarifications", {
    companyId: boss.companyId,
    scopeKind: "company",
    question: "Który termin montażu obowiązuje?",
    conflictingFragmentIds: [ownFragmentId],
    state: "open",
    raisedAtMs: SENT_AT_MS,
  });

  return {
    ctx,
    boss,
    ownSourceId,
    ownFragmentId,
    secondOwnSourceId,
    withdrawnSourceId,
    foreignSourceId,
    clarificationId,
  };
}

/** Runs memory.resolveClarification through the REAL checked dispatch. */
function resolve(
  world: CommandWorld,
  input: Record<string, unknown>,
): ReturnType<typeof dispatchMemoryCommand> {
  return dispatchMemoryCommand(world.ctx as never, {
    operation: "memory.resolveClarification",
    input,
    expectedRevisions: [],
  }, world.boss.sessionId);
}

/** The stored clarification row. */
function storedRow(world: CommandWorld): Record<string, unknown> {
  const row = world.ctx.db
    .rows("clarifications")
    .find((candidate) => candidate._id === world.clarificationId);
  if (row === undefined) {
    throw new Error("clarification row missing");
  }
  return row;
}

// ---------------------------------------------------------------------------
// R1-P3: the command-level atomic refusals.
// ---------------------------------------------------------------------------

describe("resolve evidence refusals are atomic at the command boundary", () => {
  it("refuses an unknown source with a typed validation code", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [{ sourceId: "kmissingmissingmissingmi00", fragmentId: null }],
    });
    expect(errorOf(result).code).toBe("resolution_source_not_found");
    expect(storedRow(world).state).toBe("open");
    expect(storedRow(world).resolutionBasis).toBeUndefined();
  });

  it("refuses a cross-company source with a typed forbidden code", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [{ sourceId: world.foreignSourceId, fragmentId: null }],
    });
    expect(errorOf(result).code).toBe("resolution_source_not_in_company");
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses an inactive (withdrawn) source with a typed validation code", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [{ sourceId: world.withdrawnSourceId, fragmentId: null }],
    });
    expect(errorOf(result).code).toBe("resolution_source_not_active");
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses a fragment belonging to another source with a typed code", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [{ sourceId: world.secondOwnSourceId, fragmentId: world.ownFragmentId }],
    });
    expect(errorOf(result).code).toBe("resolution_fragment_mismatch");
    expect(storedRow(world).state).toBe("open");
  });

  it("refuses the WHOLE command when any reference is invalid (no partial storage)", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [
        { sourceId: world.ownSourceId, fragmentId: world.ownFragmentId },
        { sourceId: world.withdrawnSourceId, fragmentId: null },
      ],
    });
    expect(result._tag).toBe("error");
    const stored = storedRow(world);
    expect(stored.state).toBe("open");
    expect(stored.resolutionBasis).toBeUndefined();
    expect(stored.resolutionEvidence).toBeUndefined();
    expect(stored.resolvedByUserId).toBeUndefined();
  });

  it("collapses duplicate references at the command boundary", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Piątek.",
      evidence: [
        { sourceId: world.ownSourceId, fragmentId: world.ownFragmentId },
        { sourceId: world.ownSourceId, fragmentId: world.ownFragmentId },
      ],
    });
    expect(valueOf(result)).toMatchObject({ clarificationId: world.clarificationId });
    expect(storedRow(world).resolutionEvidence).toEqual([
      { sourceId: world.ownSourceId, sourceFragmentId: world.ownFragmentId },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The compatibility story: old envelopes and pre-repair rows.
// ---------------------------------------------------------------------------

describe("compatibility: old manual envelopes and pre-repair rows", () => {
  it("decodes the pre-repair note-only envelope (the field is optional)", () => {
    const input = memoryOperations["memory.resolveClarification"].input;
    const decoded = Schema.decodeUnknownSync(input)({
      clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
      resolutionNote: "Obowiązuje kwota z czwartkowej rozmowy.",
    });
    expect(decoded.evidence).toBeUndefined();
    // The evidence-carrying shape decodes too (the agent path).
    const withEvidence = Schema.decodeUnknownSync(input)({
      clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
      resolutionNote: "Nowe źródło rozstrzyga.",
      evidence: [{ sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2s", fragmentId: null }],
    });
    expect(withEvidence.evidence).toHaveLength(1);
  });

  it("resolves the old envelope as an explicit manual decision (no fabricated source)", async () => {
    const world = await seedWorld();
    const result = await resolve(world, {
      clarificationId: world.clarificationId,
      resolutionNote: "Obowiązuje kwota z czwartkowej rozmowy.",
    });
    expect(valueOf(result)).toMatchObject({ clarificationId: world.clarificationId });
    const stored = storedRow(world);
    expect(stored.resolutionBasis).toBe("manual_boss_decision");
    expect(stored.resolutionEvidence).toEqual([]);
  });

  it("reads a pre-repair resolved row as legacy_unknown, never as a manual decision", async () => {
    const world = await seedWorld();
    // The pre-repair write shape: state, resolver, note, time — no basis.
    await world.ctx.db.patch(world.clarificationId, {
      state: "resolved",
      resolvedByUserId: world.boss.userId,
      resolutionNote: "Starsze rozstrzygnięcie.",
      resolvedAtMs: SENT_AT_MS + 1,
    });
    const rows = await readClarificationRows(
      world.ctx.db as never,
      contextFor(world.boss),
      { scope: { _tag: "company" } } as never,
    );
    if (!rows.ok) {
      throw new Error("read failed");
    }
    const row = rows.rows.find((candidate) => candidate.clarificationId === world.clarificationId);
    expect(row?.resolutionBasis).toBe("legacy_unknown");
    expect(row?.resolutionEvidence).toEqual([]);
    // The documented default decodes through the read contract.
    const decoded = Schema.decodeUnknownSync(memoryOperations["memory.readClarifications"].result)([
      {
        clarificationId: world.clarificationId,
        question: "Który termin montażu obowiązuje?",
        state: "resolved",
        raisedAtMs: SENT_AT_MS,
        resolvedByUserId: world.boss.userId,
        resolutionNote: "Starsze rozstrzygnięcie.",
        resolvedAtMs: SENT_AT_MS + 1,
        conflictingEvidence: [],
        resolutionBasis: "legacy_unknown",
        resolutionEvidence: [],
      },
    ]);
    expect(decoded[0]?.resolutionBasis).toBe("legacy_unknown");
  });

  it("requires the new read fields (the server always provides them, with the default)", () => {
    const result = memoryOperations["memory.readClarifications"].result;
    // A wire row WITHOUT the new fields is not a shape the server may emit.
    expect(() =>
      Schema.decodeUnknownSync(result)([
        {
          clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
          question: "Pytanie",
          state: "open",
          raisedAtMs: 1,
          resolvedByUserId: null,
          resolutionNote: null,
          resolvedAtMs: null,
          conflictingEvidence: [],
        },
      ]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The schema fragment: additive optional fields on the clarifications table.
// ---------------------------------------------------------------------------

describe("the clarifications schema fragment carries the resolution evidence", () => {
  const clarificationFields = (
    findingsTables.clarifications.validator.kind === "object"
      ? findingsTables.clarifications.validator.fields
      : {}
  ) as Record<string, GenericValidator>;

  it("adds the optional basis and evidence fields (additive, pre-repair rows stay valid)", () => {
    expect(clarificationFields.resolutionBasis?.isOptional).toBe("optional");
    expect(clarificationFields.resolutionEvidence?.isOptional).toBe("optional");
    // The stored basis vocabulary excludes the read-side-only default
    // (`legacy_unknown` is the documented read default, never stored).
    const basis = clarificationFields.resolutionBasis;
    expect(basis?.kind).toBe("union");
    if (basis?.kind === "union") {
      const literals = basis.members
        .map((member) => (member.kind === "literal" ? String(member.value) : null))
        .filter((value): value is string => value !== null)
        .sort();
      expect(literals).toEqual(["manual_boss_decision", "source_backed"]);
    }
  });
});
