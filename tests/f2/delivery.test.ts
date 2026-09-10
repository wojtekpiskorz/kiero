/**
 * F2 focused tests: the durable notification-intent model and evaluator
 * (issue 42's focused verification), over the REAL transaction functions
 * with the in-memory db (tests/d2/harness.ts — the D5 precedent).
 *
 * Covers:
 * - the 60-second batching window arithmetic and its boundaries;
 * - the terminal-assignment classification matrix (pending analysis is
 *   never a company source; failure and terminal unassigned are);
 * - the scope-bucket grouping (a mixed-project source stays ONE
 *   notification, never duplicated per project);
 * - the suppression matrix through the REAL evaluator: author exclusion,
 *   muted project, muted company entries, read-before-due, revoked
 *   membership, withdrawn source, resolved clarification;
 * - quiet-hours deferral across the Europe/Warsaw DST nights through F1's
 *   seam, and the collapsed ONE-current-summary re-fire (no stale replay);
 * - duplicate suppression by semantic identity (replayed acceptance,
 *   duplicate scheduling) and ordinary agent confirmations producing no
 *   intent.
 *
 * The live proofs (tests/f2/live-proof.mjs) run the same evaluator against
 * the real leased dev deployment with the same decision vocabulary.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSIGNMENT_RETRY_MS,
  BATCH_WINDOW_MS,
  batchBucketOf,
  dueAtMsOf,
  joinsBatch,
  resolveAssignment,
} from "../../convex/attention/delivery/model";
import {
  performEnsureClarificationIntents,
  performEnsureSourceIntents,
  performEvaluateDueIntents,
  performKickSourceEvaluation,
} from "../../convex/attention/delivery/operations";
import { asTx, fakeCtx, valueOf, type FakeCtx } from "../d2/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  "companies",
  "users",
  "memberships",
  "projects",
  "sources",
  "sourceProjectLinks",
  "sourceFragments",
  "extractions",
  "processingRuns",
  "readStates",
  "notificationPreferences",
  "notificationIntents",
  "clarifications",
  "outboxEvents",
  "durableJobs",
] as const;

/** A wall-clock instant pinned per scenario (the fake clock). */
const T0 = Date.parse("2026-09-09T10:00:00.000Z"); // 12:00 Warsaw: outside quiet hours
const T0_DUE = T0 + BATCH_WINDOW_MS;

let ctx: FakeCtx;
const tx = () => asTx(ctx);

interface Firm {
  readonly companyId: string;
  readonly bossA: string; // the author
  readonly bossB: string; // the muted-project boss
  readonly bossC: string; // the quiet-hours boss
  readonly bossD: string; // the revoked boss
}

async function seedFirm(): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: "F2 test firm",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const bosses = await Promise.all(
    ["f2-a", "f2-b", "f2-c", "f2-d"].map(async (label) => {
      const userId = await ctx.db.insert("users", {
        email: `${label}@kiero.invalid`,
        displayName: label,
        createdAtMs: T0,
      });
      await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "member",
        state: "active",
        createdAtMs: T0,
      });
      return userId;
    }),
  );
  return { companyId, bossA: bosses[0]!, bossB: bosses[1]!, bossC: bosses[2]!, bossD: bosses[3]! };
}

async function seedProject(firm: Firm, name: string): Promise<string> {
  return ctx.db.insert("projects", {
    companyId: firm.companyId,
    displayName: name,
    stage: "inquiry",
    createdAtMs: T0,
  });
}

interface SourceFixture {
  readonly sourceId: string;
}

/** One accepted text source with a terminal-succeeded run and optional links. */
async function seedSource(
  firm: Firm,
  options: {
    acceptedAtMs?: number;
    projectIds?: string[];
    runState?: "running" | "succeeded" | "failed" | "superseded" | "none";
    authorUserId?: string;
    lifecycle?: "active" | "withdrawn" | "purged";
  } = {},
): Promise<SourceFixture> {
  const acceptedAtMs = options.acceptedAtMs ?? T0;
  const sourceId = await ctx.db.insert("sources", {
    companyId: firm.companyId,
    authorUserId: options.authorUserId ?? firm.bossA,
    authorText: "F2 test entry",
    sentAtMs: acceptedAtMs,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: acceptedAtMs,
    lifecycle: options.lifecycle ?? "active",
  });
  for (const projectId of options.projectIds ?? []) {
    await ctx.db.insert("sourceProjectLinks", {
      sourceId,
      projectId,
      assignedByUserId: firm.bossA,
      assignedAtMs: acceptedAtMs,
      sentAtMs: acceptedAtMs,
    });
  }
  if ((options.runState ?? "succeeded") !== "none") {
    await ctx.db.insert("processingRuns", {
      companyId: firm.companyId,
      sourceId,
      kind: "initial_analysis",
      pipelineVersion: "f2.test/1",
      promptVersion: "f2.test/1",
      schemaVersion: "f2.test/1",
      modelConfigurationVersion: "f2.test/1",
      state: options.runState ?? "succeeded",
      startedAtMs: acceptedAtMs + 1,
      ...(options.runState === "running" ? {} : { finishedAtMs: acceptedAtMs + 2 }),
    });
  }
  return { sourceId };
}

async function seedPreferences(
  firm: Firm,
  userId: string,
  patch: Partial<{
    mutedProjectIds: string[];
    companyEntriesMuted: boolean;
    quietHoursStartMinute: number;
    quietHoursEndMinute: number;
  }>,
): Promise<void> {
  await ctx.db.insert("notificationPreferences", {
    companyId: firm.companyId,
    userId,
    mutedProjectIds: patch.mutedProjectIds ?? [],
    companyEntriesMuted: patch.companyEntriesMuted ?? false,
    taskRemindersMuted: false,
    hidePreviewContent: false,
    ...(patch.quietHoursStartMinute !== undefined && patch.quietHoursEndMinute !== undefined
      ? {
          quietHoursStartMinute: patch.quietHoursStartMinute,
          quietHoursEndMinute: patch.quietHoursEndMinute,
        }
      : {}),
    updatedAtMs: T0,
  });
}

/** The intents of one user in one state, sorted by dedup key. */
function intentsOf(userId: string, state?: string) {
  return ctx.db
    .rows("notificationIntents")
    .filter((row) => row.recipientUserId === userId && (state === undefined || row.state === state))
    .sort((a, b) => String(a.dedupKey).localeCompare(String(b.dedupKey)));
}

/** The delivered intent rows of a user (decoded deliveryJson each). */
function deliveredRows(userId: string) {
  return intentsOf(userId, "delivered").map((row) => JSON.parse(String(row.deliveryJson)));
}

/**
 * The DISTINCT current summaries of a user: every intent row delivered in
 * one batch fire carries the SAME collapsed summary, so F3 dedupes by
 * identity (recipient + bucket + deliveredAtMs). One notification per
 * batch is the count that matters.
 */
function deliveredSummaries(userId: string) {
  const distinct = new Set(deliveredRows(userId).map((summary) => JSON.stringify(summary)));
  return [...distinct].map((json) => JSON.parse(json));
}

/**
 * One OPEN company-scoped clarification about a source, addressed through
 * its first conflicting fragment (the checked dispatch's linkage path).
 */
async function seedClarification(firm: Firm, sourceId: string, raisedAtMs = T0): Promise<string> {
  const extractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "f2.test/1",
    model: "author-text",
    provider: "kiero",
    processingRunId: ctx.db.rows("processingRuns")[0]?._id ?? "k0test",
    createdAtMs: raisedAtMs,
  });
  const fragmentId = await ctx.db.insert("sourceFragments", {
    sourceId,
    extractionId,
    basis: { _tag: "whole_source" },
    createdAtMs: raisedAtMs,
  });
  return ctx.db.insert("clarifications", {
    companyId: firm.companyId,
    scopeKind: "company",
    question: "Który termin jest właściwy?",
    conflictingFragmentIds: [fragmentId],
    state: "open",
    raisedAtMs,
  });
}

beforeEach(() => {
  ctx = fakeCtx([...TABLES]);
});

// ---------------------------------------------------------------------------
// The pure model: window arithmetic and the assignment matrix.
// ---------------------------------------------------------------------------

describe("the 60-second batching window arithmetic", () => {
  it("anchors the due instant at durable acceptance + 60 seconds", () => {
    expect(BATCH_WINDOW_MS).toBe(60_000);
    expect(dueAtMsOf(T0)).toBe(T0 + 60_000);
  });

  it("keeps the window open until the actual fire instant", () => {
    // The window is closed [first entry, fire]: an entry accepted exactly
    // at the fire instant still joins; one accepted after it does not (it
    // keeps its own later window).
    expect(joinsBatch(T0, T0_DUE)).toBe(true);
    expect(joinsBatch(T0_DUE, T0_DUE)).toBe(true);
    expect(joinsBatch(T0_DUE + 1, T0_DUE)).toBe(false);
  });

  it("buckets company, single-project and mixed scopes deterministically", () => {
    expect(batchBucketOf({ kind: "company", projectIds: [] })).toBe("company");
    expect(batchBucketOf({ kind: "project", projectIds: ["p1"] })).toBe("project:p1");
    // A mixed-project source keeps ONE bucket of its own: sorted ids, so
    // link order never creates a second notification and the pair is never
    // mistaken for either single project's bucket.
    expect(batchBucketOf({ kind: "project", projectIds: ["p1", "p2"] })).toBe("mixed:p1|p2");
    expect(batchBucketOf({ kind: "project", projectIds: ["p2", "p1"] })).toBe("mixed:p1|p2");
  });
});

// ---------------------------------------------------------------------------
// Round-1 review regressions: the tenant bound, the shared re-check and the
// latest-run read.
// ---------------------------------------------------------------------------

describe("the tenant bound on the batch collapse", () => {
  /** A second firm whose only members are its author and firm A's boss B. */
  async function seedSecondFirm(): Promise<{ companyId: string; authorUserId: string }> {
    const companyId = await ctx.db.insert("companies", {
      name: "F2 second firm",
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: T0,
    });
    const authorUserId = await ctx.db.insert("users", {
      email: "f2-second-author@kiero.invalid",
      displayName: "f2-second-author",
      createdAtMs: T0,
    });
    await ctx.db.insert("memberships", {
      companyId,
      userId: authorUserId,
      role: "member",
      state: "active",
      createdAtMs: T0,
    });
    // Boss B is ALSO a member of the second firm: same person, two tenants.
    await ctx.db.insert("memberships", {
      companyId,
      userId: ctx.db.rows("users").find((row) => row.email === "f2-b@kiero.invalid")!._id,
      role: "member",
      state: "active",
      createdAtMs: T0,
    });
    return { companyId, authorUserId };
  }

  it("two firms' company buckets never merge for one shared boss", async () => {
    const firm = await seedFirm();
    const second = await seedSecondFirm();
    const sourceA = await seedSource(firm); // terminal unassigned -> company
    const sourceB = await seedSource(firm, { authorUserId: second.authorUserId });
    // Firm B's source belongs to the SECOND firm: re-point the fixture rows.
    await ctx.db.patch(sourceB.sourceId, { companyId: second.companyId });
    const runB = ctx.db
      .rows("processingRuns")
      .filter((row) => row.sourceId === sourceB.sourceId)[0]!;
    await ctx.db.patch(runB._id, { companyId: second.companyId });
    for (const source of [sourceA, sourceB]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    // B receives TWO separate collapsed summaries — one per firm — never a
    // cross-tenant merge under either firm's timezone/rights.
    const summaries = deliveredSummaries(firm.bossB);
    expect(summaries).toHaveLength(2);
    const byFirm = summaries.map((summary) => summary.sourceIds[0]);
    expect(new Set(byFirm)).toEqual(new Set([sourceA.sourceId, sourceB.sourceId]));
    for (const summary of summaries) {
      expect(summary.bucket).toBe("company");
      expect(summary.sourceIds).toHaveLength(1);
    }
  });

  it("a boss revoked in firm A still receives in firm B", async () => {
    const firm = await seedFirm();
    const second = await seedSecondFirm();
    const sourceA = await seedSource(firm);
    const sourceB = await seedSource(firm, { authorUserId: second.authorUserId });
    await ctx.db.patch(sourceB.sourceId, { companyId: second.companyId });
    const runB = ctx.db
      .rows("processingRuns")
      .filter((row) => row.sourceId === sourceB.sourceId)[0]!;
    await ctx.db.patch(runB._id, { companyId: second.companyId });
    for (const source of [sourceA, sourceB]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    // B is revoked in firm A BEFORE due time, still active in firm B.
    const membershipA = ctx.db
      .rows("memberships")
      .find((row) => row.userId === firm.bossB && row.companyId === firm.companyId)!;
    await ctx.db.patch(membershipA._id, { state: "revoked", revokedAtMs: T0 + 1 });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    // Firm A's intent dies on A's revocation; firm B's delivers.
    const intents = ctx.db
      .rows("notificationIntents")
      .filter((row) => row.recipientUserId === firm.bossB);
    expect(intents).toHaveLength(2);
    const inA = intents.find((row) => row.companyId === firm.companyId)!;
    const inB = intents.find((row) => row.companyId === second.companyId)!;
    expect(inA.state).toBe("suppressed");
    expect(inA.suppressedReason).toBe("membership_revoked");
    expect(inB.state).toBe("delivered");
    expect((JSON.parse(String(inB.deliveryJson)) as { sourceIds: string[] }).sourceIds).toEqual([
      sourceB.sourceId,
    ]);
  });
});

describe("the shared due/sibling re-check", () => {
  it("a clarification resolved inside the window is never absorbed by a sibling batch", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    // One OPEN question (due now, fires the author's clarification bucket)
    // and one raised 5 s later that was RESOLVED before its own due time:
    // the sibling absorption used to key it into the same bucket without
    // re-checking the open state, delivering a dead question.
    const openId = await seedClarification(firm, source.sourceId, T0);
    const resolvedId = await seedClarification(firm, source.sourceId, T0 + 5_000);
    for (const id of [openId, resolvedId]) {
      await performEnsureClarificationIntents(tx(), id as never);
    }
    await ctx.db.patch(resolvedId, {
      state: "resolved",
      resolvedByUserId: firm.bossA,
      resolutionNote: "rozstrzygnięte",
      resolvedAtMs: T0 + 10_000,
    });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    const resolvedIntent = ctx.db
      .rows("notificationIntents")
      .find((row) => row.clarificationId === resolvedId)!;
    expect(resolvedIntent.state).toBe("suppressed");
    expect(resolvedIntent.suppressedReason).toBe("clarification_resolved");
    // The OPEN question still delivers, alone in its summary.
    const summaries = deliveredSummaries(firm.bossA);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.clarificationIds).toEqual([openId]);
  });
});

describe("the latest-run read", () => {
  /** Seeds `count` runs for one source, ascending startedAtMs by insertion. */
  async function seedRuns(
    firm: Firm,
    sourceId: string,
    states: readonly ("running" | "succeeded" | "failed" | "superseded")[],
  ): Promise<void> {
    for (const [index, state] of states.entries()) {
      await ctx.db.insert("processingRuns", {
        companyId: firm.companyId,
        sourceId,
        kind: index === 0 ? "initial_analysis" : "reanalysis",
        pipelineVersion: "f2.test/1",
        promptVersion: "f2.test/1",
        schemaVersion: "f2.test/1",
        modelConfigurationVersion: "f2.test/1",
        state,
        startedAtMs: T0 + index,
        ...(state === "running" ? {} : { finishedAtMs: T0 + index + 1 }),
      });
    }
  }

  it("reads the LATEST run even past twenty earlier terminal runs", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    // Twenty terminal-succeeded runs, then a NEWEST running reanalysis: the
    // bounded-take read would resolve terminal off the twentieth row and
    // bypass the pending classification (and the project mute).
    await seedPreferences(firm, firm.bossB, { mutedProjectIds: [p1] });
    const source = await seedSource(firm, { projectIds: [p1], runState: "none" });
    await seedRuns(firm, source.sourceId, [
      ...Array.from({ length: 20 }, () => "succeeded" as const),
      "running",
    ]);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    // The latest run is RUNNING: assignment is pending, nothing delivers or
    // dies — and the muted project is never bypassed by a company read.
    const intent = intentsOf(firm.bossB, "pending")[0]!;
    expect(intent.dueAtMs).toBe(T0_DUE + ASSIGNMENT_RETRY_MS);
    expect(ctx.db.rows("notificationIntents").filter((row) => row.state !== "pending")).toHaveLength(0);
  });

  it("a stale superseded row does not defer a terminal newest run", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm, { runState: "none" });
    await seedRuns(firm, source.sourceId, ["superseded", "succeeded"]);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    // The LATEST run succeeded: the entry delivers (company scope), it does
    // not wait on the older superseded row.
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    expect(deliveredSummaries(firm.bossB)[0]!.bucket).toBe("company");
  });
});

describe("the terminal assignment classification", () => {
  const links = ["p1"];

  it("pending analysis is never an unassigned company source", () => {
    expect(resolveAssignment(null, [])).toEqual({ state: "pending" });
    expect(resolveAssignment({ state: "running" }, [])).toEqual({ state: "pending" });
    expect(resolveAssignment({ state: "superseded" }, links)).toEqual({ state: "pending" });
  });

  it("terminal failure applies company-entry rules", () => {
    expect(resolveAssignment({ state: "failed" }, links)).toEqual({ state: "company" });
  });

  it("terminal success classifies by the current links", () => {
    expect(resolveAssignment({ state: "succeeded" }, [])).toEqual({ state: "company" });
    expect(resolveAssignment({ state: "succeeded" }, ["p2", "p1"])).toEqual({
      state: "projects",
      projectIds: ["p2", "p1"],
    });
  });
});

// ---------------------------------------------------------------------------
// Intent creation: author exclusion and semantic identity.
// ---------------------------------------------------------------------------

describe("durable source-intent creation", () => {
  it("creates one intent per active member EXCEPT the author", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    const result = valueOf(
      await performEnsureSourceIntents(tx(), source.sourceId as never),
    ) as { recipientCount: number; createdIntentIds: string[] };
    expect(result.recipientCount).toBe(3);
    expect(result.createdIntentIds).toHaveLength(3);
    expect(intentsOf(firm.bossA)).toHaveLength(0);
    expect(intentsOf(firm.bossB, "pending")).toHaveLength(1);
    expect(intentsOf(firm.bossC, "pending")).toHaveLength(1);
    expect(intentsOf(firm.bossD, "pending")).toHaveLength(1);
  });

  it("schedules the evaluator hop at the window close", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    // The generated anyApi reference carries no inspectable path in tests,
    // so the hop is identified by its evaluator args.
    const hop = ctx.scheduled.find(
      (entry) =>
        typeof entry.args === "object" &&
        entry.args !== null &&
        "nowMs" in entry.args &&
        (entry.args as { nowMs: number }).nowMs === T0_DUE,
    );
    expect(hop).toBeDefined();
  });

  it("collapses a replayed acceptance onto the same semantic intents", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    const second = valueOf(
      await performEnsureSourceIntents(tx(), source.sourceId as never),
    ) as { createdIntentIds: string[] };
    expect(second.createdIntentIds).toHaveLength(0);
    expect(ctx.db.rows("notificationIntents")).toHaveLength(3);
    // The semantic identity is per source and recipient.
    expect(intentsOf(firm.bossB)[0]?.dedupKey).toBe(`source_entry:${source.sourceId}:${firm.bossB}`);
  });
});

// ---------------------------------------------------------------------------
// The evaluator: suppression matrix, batching, quiet hours.
// ---------------------------------------------------------------------------

describe("the due-time evaluator", () => {
  it("delivers one collapsed summary per recipient and project bucket", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const s1 = await seedSource(firm, { projectIds: [p1] });
    const s2 = await seedSource(firm, { projectIds: [p1], acceptedAtMs: T0 + 5_000 });
    for (const source of [s1, s2]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    const result = valueOf(await performEvaluateDueIntents(tx(), { nowMs: T0_DUE })) as {
      evaluatedIntentIds: string[];
    };
    // Three due intents plus the three absorbed siblings (one per boss) —
    // every evaluated intent is reported exactly once.
    expect(result.evaluatedIntentIds).toHaveLength(6);
    for (const boss of [firm.bossB, firm.bossC, firm.bossD]) {
      // ONE current summary covering BOTH entries — collapsed, not spammed.
      // (The second entry's own due time is 5 s later; the open window
      // absorbs it into the first entry's fire.)
      expect(deliveredSummaries(boss)).toHaveLength(1);
      const rows = deliveredRows(boss);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(rows[1]); // the shared collapsed summary
      expect(new Set(rows[0]!.sourceIds)).toEqual(new Set([s1.sourceId, s2.sourceId]));
      expect(rows[0]!.bucket).toBe(`project:${p1}`);
    }
    // The terminal events publish once per intent (six intents delivered:
    // the three due and the three absorbed siblings).
    const events = ctx.db
      .rows("outboxEvents")
      .filter((row) => row.eventName === "attention.intentDelivered");
    expect(events).toHaveLength(6);
  });

  it("keeps a mixed-project source ONE notification, not one per project", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const p2 = await seedProject(firm, "Kaczmarek");
    const mixed = await seedSource(firm, { projectIds: [p1, p2] });
    const single = await seedSource(firm, { projectIds: [p1], acceptedAtMs: T0 + 5_000 });
    for (const source of [mixed, single]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    // The mixed source fires at its window close; the single-project entry
    // (accepted 5 s later) is a DIFFERENT bucket and keeps its own window.
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE + 5_000 });
    const summaries = deliveredSummaries(firm.bossB);
    expect(summaries).toHaveLength(2);
    const mixedSummary = summaries.find((s: { sourceIds: string[] }) =>
      s.sourceIds.includes(mixed.sourceId),
    );
    expect(mixedSummary?.bucket).toBe(`mixed:${[p1, p2].sort().join("|")}`);
    expect(mixedSummary?.sourceIds).toEqual([mixed.sourceId]);
    const projectSummary = summaries.find((s: { sourceIds: string[] }) =>
      s.sourceIds.includes(single.sourceId),
    );
    expect(projectSummary?.bucket).toBe(`project:${p1}`);
  });

  it("a muted project kills the whole bucket for that boss only", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    await seedPreferences(firm, firm.bossB, { mutedProjectIds: [p1] });
    const s1 = await seedSource(firm, { projectIds: [p1] });
    const mixed = await seedSource(firm, { projectIds: [p1, await seedProject(firm, "Kaczmarek")] });
    for (const source of [s1, mixed]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    // B muted P1: the P1 bucket dies, and the mixed source (any-muted rule)
    // dies with it; B receives nothing.
    expect(intentsOf(firm.bossB, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "muted_project",
      "muted_project",
    ]);
    expect(deliveredSummaries(firm.bossB)).toHaveLength(0);
    // The other bosses still receive both summaries.
    expect(deliveredSummaries(firm.bossC)).toHaveLength(2);
    expect(deliveredSummaries(firm.bossD)).toHaveLength(2);
  });

  it("company-entry mutes apply only after terminal unassigned classification", async () => {
    const firm = await seedFirm();
    await seedPreferences(firm, firm.bossB, { companyEntriesMuted: true });
    // Pending analysis: NEVER a company source (no run yet).
    const pendingSource = await seedSource(firm, { runState: "none" });
    await performEnsureSourceIntents(tx(), pendingSource.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    const pendingIntent = intentsOf(firm.bossB, "pending")[0]!;
    expect(pendingIntent.dueAtMs).toBe(T0_DUE + ASSIGNMENT_RETRY_MS);
    // Terminal unassigned classification: company rules apply.
    const companySource = await seedSource(firm, { runState: "succeeded" });
    await performEnsureSourceIntents(tx(), companySource.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE + 1 });
    expect(intentsOf(firm.bossB, "suppressed").map((row) => row.suppressedReason)).toContain(
      "muted_company_entries",
    );
    expect(deliveredSummaries(firm.bossC)).toHaveLength(1);
    // Terminal analysis failure: company rules too.
    const failedSource = await seedSource(firm, { runState: "failed" });
    await performEnsureSourceIntents(tx(), failedSource.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE + 2 });
    expect(intentsOf(firm.bossB, "suppressed").filter((row) => row.suppressedReason === "muted_company_entries")).toHaveLength(2);
  });

  it("a revoked member's intent dies; others still receive", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    // Revoke D before due time.
    const membership = ctx.db
      .rows("memberships")
      .find((row) => row.userId === firm.bossD)!;
    await ctx.db.patch(membership._id, { state: "revoked", revokedAtMs: T0 + 1 });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossD, "suppressed")[0]?.suppressedReason).toBe("membership_revoked");
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    expect(deliveredSummaries(firm.bossC)).toHaveLength(1);
  });

  it("a source read just before due time leaves the batch", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const s1 = await seedSource(firm, { projectIds: [p1] });
    const s2 = await seedSource(firm, { projectIds: [p1], acceptedAtMs: T0 + 5_000 });
    for (const source of [s1, s2]) {
      await performEnsureSourceIntents(tx(), source.sourceId as never);
    }
    // B reads s1 after acceptance, before due time.
    await ctx.db.insert("readStates", {
      companyId: firm.companyId,
      userId: firm.bossB,
      sourceId: s1.sourceId,
      read: true,
      readAtMs: T0 + 10_000,
    });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossB, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "already_read",
    ]);
    // The batch still fires at the first entry's window close, carrying the
    // unread sibling only — read entries are removed before delivery.
    const summaries = deliveredSummaries(firm.bossB);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.sourceIds).toEqual([s2.sourceId]);
    expect(summaries[0]!.deliveredAtMs).toBe(T0_DUE);
  });

  it("a withdrawn source notifies nobody", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm, { lifecycle: "withdrawn" });
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(
      intentsOf(firm.bossB, "suppressed").every((row) => row.suppressedReason === "source_no_longer_valid"),
    ).toBe(true);
    expect(deliveredSummaries(firm.bossB)).toHaveLength(0);
  });

  it("defers overnight through the company default quiet hours, then collapses", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    // Accepted at 20:30 Warsaw — inside the default 20:00-06:00 window.
    const acceptedAt = Date.parse("2026-09-09T18:30:00.000Z");
    const quietEnd = Date.parse("2026-09-10T04:00:00.000Z"); // 06:00 Warsaw
    const s1 = await seedSource(firm, { projectIds: [p1], acceptedAtMs: acceptedAt });
    await performEnsureSourceIntents(tx(), s1.sourceId as never);
    const dueAt = acceptedAt + BATCH_WINDOW_MS; // 20:31 Warsaw, still quiet
    await performEvaluateDueIntents(tx(), { nowMs: dueAt });
    const deferred = intentsOf(firm.bossB, "pending")[0]!;
    expect(deferred.dueAtMs).toBe(quietEnd);
    // A second entry accepted later that night joins the SAME deferral.
    const s2 = await seedSource(firm, { projectIds: [p1], acceptedAtMs: acceptedAt + 300_000 });
    await performEnsureSourceIntents(tx(), s2.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: quietEnd });
    // ONE current summary at the window end covering BOTH entries — no
    // stale replay of the first deferral.
    const summaries = deliveredSummaries(firm.bossB);
    expect(summaries).toHaveLength(1);
    expect(new Set(summaries[0]!.sourceIds)).toEqual(new Set([s1.sourceId, s2.sourceId]));
    expect(summaries[0]!.deliveredAtMs).toBe(quietEnd);
  });

  it("defers across the Europe/Warsaw DST fall-back night to the correct instant", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    // 01:30 CEST on the fall-back night (03:00 -> 02:00): quiet until
    // 06:00 CET, which is 05:00Z — an 8.5-hour absolute deferral.
    const acceptedAt = Date.parse("2026-10-24T23:20:00.000Z"); // 01:20 CEST
    const dueAt = acceptedAt + BATCH_WINDOW_MS; // 01:21 CEST, inside quiet hours
    const expectedEnd = Date.parse("2026-10-25T05:00:00.000Z");
    const source = await seedSource(firm, { projectIds: [p1], acceptedAtMs: acceptedAt });
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: dueAt });
    expect(intentsOf(firm.bossB, "pending")[0]!.dueAtMs).toBe(expectedEnd);
    await performEvaluateDueIntents(tx(), { nowMs: expectedEnd });
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
  });

  it("defers across the spring-forward night to the correct instant", async () => {
    const firm = await seedFirm();
    // 00:30 CET on the spring-forward night (02:00 -> 03:00): quiet until
    // 06:00 CEST = 04:00Z.
    const dueAt = Date.parse("2026-03-28T23:30:00.000Z");
    const expectedEnd = Date.parse("2026-03-29T04:00:00.000Z");
    const source = await seedSource(firm, { acceptedAtMs: dueAt - BATCH_WINDOW_MS });
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: dueAt });
    expect(intentsOf(firm.bossB, "pending")[0]!.dueAtMs).toBe(expectedEnd);
  });

  it("a personal quiet-hours window overrides the company default", async () => {
    const firm = await seedFirm();
    // C personally quiet 11:00-15:00 Warsaw; T0_DUE is 12:01 Warsaw.
    await seedPreferences(firm, firm.bossC, {
      quietHoursStartMinute: 11 * 60,
      quietHoursEndMinute: 15 * 60,
    });
    const source = await seedSource(firm);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossC, "pending")[0]!.dueAtMs).toBe(
      Date.parse("2026-09-09T13:00:00.000Z"),
    );
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1); // B unaffected
  });

  it("waits past the window while assignment is pending, then delivers without a new window", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const source = await seedSource(firm, { projectIds: [p1], runState: "running" });
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    // At due time the analysis is still running: wait, never company bypass.
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossB, "pending")[0]!.dueAtMs).toBe(T0_DUE + ASSIGNMENT_RETRY_MS);
    // The run goes terminal later; the NEXT sweep delivers at that later
    // instant (no new 60-second window from the analysis).
    const run = ctx.db.rows("processingRuns")[0]!;
    await ctx.db.patch(run._id, { state: "succeeded", finishedAtMs: T0 + 120_000 });
    const later = T0_DUE + ASSIGNMENT_RETRY_MS;
    await performEvaluateDueIntents(tx(), { nowMs: later });
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    expect(deliveredSummaries(firm.bossB)[0]!.deliveredAtMs).toBe(later);
  });

  it("later assignment after a delivered company entry sends no second notification", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const source = await seedSource(firm); // terminal unassigned -> company
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    expect(deliveredSummaries(firm.bossB)[0]!.bucket).toBe("company");
    // A later assignment links the source: all intents are terminal, so
    // nothing re-fires and no intent appears.
    await ctx.db.insert("sourceProjectLinks", {
      sourceId: source.sourceId,
      projectId: p1,
      assignedByUserId: firm.bossA,
      assignedAtMs: T0_DUE + 1,
      sentAtMs: T0,
    });
    await performEnsureSourceIntents(tx(), source.sourceId as never); // replay: nothing
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE + 120_000 });
    expect(deliveredSummaries(firm.bossB)).toHaveLength(1);
    expect(ctx.db.rows("notificationIntents")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Clarification intents: the addressed agent question.
// ---------------------------------------------------------------------------

describe("durable clarification-intent creation", () => {
  it("addresses the source author, who may receive it about their own entry", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    const clarificationId = await seedClarification(firm, source.sourceId);
    const result = valueOf(
      await performEnsureClarificationIntents(tx(), clarificationId as never),
    ) as { addressedToAuthor: boolean; createdIntentIds: string[] };
    expect(result.addressedToAuthor).toBe(true);
    expect(result.createdIntentIds).toHaveLength(1);
    // ONLY the author holds a clarification intent.
    const all = ctx.db.rows("notificationIntents");
    expect(all).toHaveLength(1);
    expect(all[0]?.recipientUserId).toBe(firm.bossA);
    expect(all[0]?.semanticKind).toBe("clarification");
    // The author may receive it: evaluation delivers despite isAuthor.
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossA, "delivered")).toHaveLength(1);
    expect(deliveredSummaries(firm.bossA)[0]!.semanticKind).toBe("clarification");
  });

  it("dies when the author read the source before due time", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    const clarificationId = await seedClarification(firm, source.sourceId);
    await performEnsureClarificationIntents(tx(), clarificationId as never);
    await ctx.db.insert("readStates", {
      companyId: firm.companyId,
      userId: firm.bossA,
      sourceId: source.sourceId,
      read: true,
      readAtMs: T0 + 5_000,
    });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossA, "suppressed")[0]?.suppressedReason).toBe("already_read");
  });

  it("dies when the clarification was resolved before due time", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    const clarificationId = await seedClarification(firm, source.sourceId);
    await performEnsureClarificationIntents(tx(), clarificationId as never);
    await ctx.db.patch(clarificationId, {
      state: "resolved",
      resolvedByUserId: firm.bossA,
      resolutionNote: "rozstrzygnięte",
      resolvedAtMs: T0 + 5_000,
    });
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    expect(intentsOf(firm.bossA, "suppressed")[0]?.suppressedReason).toBe("clarification_resolved");
  });

  it("collapses a replayed clarification onto the same semantic intent", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    const clarificationId = await seedClarification(firm, source.sourceId);
    await performEnsureClarificationIntents(tx(), clarificationId as never);
    const second = valueOf(
      await performEnsureClarificationIntents(tx(), clarificationId as never),
    ) as { createdIntentIds: string[] };
    expect(second.createdIntentIds).toHaveLength(0);
    expect(ctx.db.rows("notificationIntents")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The agent-confirmation seam: published changes push nothing.
// ---------------------------------------------------------------------------

describe("the change-set wake-up (ordinary confirmations push nothing)", () => {
  it("creates no intent and schedules no new window", async () => {
    const firm = await seedFirm();
    const p1 = await seedProject(firm, "Banan");
    const source = await seedSource(firm, { projectIds: [p1] });
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    const before = ctx.db.rows("notificationIntents").length;
    const result = valueOf(
      await performKickSourceEvaluation(tx(), source.sourceId as never),
    ) as { pendingIntents: boolean };
    expect(result.pendingIntents).toBe(true);
    expect(ctx.db.rows("notificationIntents")).toHaveLength(before);
    // The pending intents keep their acceptance-anchored due time.
    expect(intentsOf(firm.bossB, "pending")[0]!.dueAtMs).toBe(T0_DUE);
  });

  it("never creates a confirmation-kind intent", async () => {
    const firm = await seedFirm();
    const source = await seedSource(firm);
    await performEnsureSourceIntents(tx(), source.sourceId as never);
    await performKickSourceEvaluation(tx(), source.sourceId as never);
    await performEvaluateDueIntents(tx(), { nowMs: T0_DUE });
    const kinds = new Set(
      ctx.db.rows("notificationIntents").map((row) => String(row.semanticKind)),
    );
    expect(kinds.has("confirmation")).toBe(false);
  });
});
