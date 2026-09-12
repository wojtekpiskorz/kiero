/**
 * R4 focused tests (issue #129): the stale complete-replacement refusal.
 *
 * The map review's P2 finding, as a deterministic transaction proof:
 * `sources.reassignSource` replaced the WHOLE link set with no precondition,
 * so a stale editor form silently overwrote another boss's newer
 * reassignment. These tests drive the REAL `performReassignment` transaction
 * body through the shared in-memory Convex emulation (tests/d2/harness.ts,
 * the I4/D2 precedent) — no deployment needed for the transaction halves;
 * the live proof (tests/e7/live-proof.mjs) rides the same scenarios against
 * the real dev deployment.
 *
 * Covered, per the issue's acceptance criteria:
 *
 * - RED first (kept as the permanent regression): two independently loaded
 *   observed sets reproduce the race — A succeeds, B's stale form must be
 *   refused `source_placement_stale`, and A's placement survives;
 * - R4-P2: an accepted replacement stays atomic — exactly ONE
 *   `sources.sourceReassigned` event and ONE recomputation registration per
 *   accepted command, under the SAME dedup identity;
 * - R4-P3 + the E7 regression: a stale refusal writes NOTHING (zero events,
 *   zero jobs, links untouched);
 * - ordering and duplicates in the declared or observed set can neither
 *   create a false stale conflict nor a duplicate link;
 * - cross-tenant and unknown project references in EITHER set refuse
 *   before any write and never expose foreign placement;
 * - a no-op replacement (observed == current, desired == current) stays the
 *   typed `source_links_unchanged` conflict it was since E7.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { fakeCtx, asTx, seedActor, contextFor, type FakeCtx } from "../d2/harness";
import {
  performReassignment,
  type ReassignSourceReceipt,
} from "../../convex/sources/reassign/reassignment";
import { sourcesHandlers } from "../../convex/sources/accept/dispatch";
import type { MutationCtx } from "../../convex/_generated/server";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import {
  ActorContext,
  okResult,
  parseTableId,
  type ResultEnvelope,
  type TableId,
} from "@kiero/contracts";

/** Brands a fixture row id as a projects reference (it is a plain string). */
function projectRef(id: string): TableId<"projects"> {
  const branded = parseTableId("projects", id);
  if (branded === null) {
    throw new Error(`fixture: malformed project id ${id}`);
  }
  return branded;
}

/** Brands a fixture row id as a sources reference (it is a plain string). */
function sourceRef(id: string): TableId<"sources"> {
  const branded = parseTableId("sources", id);
  if (branded === null) {
    throw new Error(`fixture: malformed source id ${id}`);
  }
  return branded;
}

/** The tables the reassignment transaction, its registrations and the shared
 * actor fixture touch. */
const REASSIGN_TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "sources",
  "sourceProjectLinks",
  "projects",
  "outboxEvents",
  "durableJobs",
] as const;

/** The committed link set, read the way the transaction reads it. */
async function committedPlacement(ctx: FakeCtx, sourceId: string): Promise<string[]> {
  const links = await ctx.db
    .query("sourceProjectLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  return links.map((link) => link.projectId as string).sort();
}

interface Fixture {
  readonly ctx: FakeCtx;
  readonly sourceId: string;
  readonly p1: string;
  readonly p2: string;
  readonly p3: string;
  readonly foreignProject: string;
  readonly run: (input: {
    readonly sourceId: string;
    readonly projectIds: readonly string[];
    readonly expectedProjectIds: readonly string[];
    /** Names the logical operation (two accepts need distinct identities). */
    readonly idempotencyKey?: string;
  }) => Promise<ResultEnvelope>;
  readonly committed: () => Promise<string[]>;
  readonly eventCount: () => number;
  readonly jobCount: () => number;
}

/**
 * One company, one active source linked to project 1, and a runner over the
 * REAL transaction with the fixture actor's request context.
 */
async function reassignmentFixture(): Promise<Fixture> {
  const ctx = fakeCtx(REASSIGN_TABLES);
  const actor = await seedActor(ctx, "e7-r4");
  const foreignCompanyId = await ctx.db.insert("companies", {
    name: "Obca firma",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: Date.now(),
  });
  const project = (displayName: string, companyId = actor.companyId) =>
    ctx.db.insert("projects", {
      companyId,
      displayName,
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: Date.now(),
    });
  const p1 = await project("Banan");
  const p2 = await project("Kaczmarek");
  const p3 = await project("Rybacka");
  const foreignProject = await project("Projekt obcej firmy", foreignCompanyId);
  const sourceId = await ctx.db.insert("sources", {
    companyId: actor.companyId,
    authorUserId: actor.userId,
    authorText: "Termin dostawy na Budowlanej, piątek.",
    sentAtMs: Date.parse("2026-09-10T09:00:00.000Z"),
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: Date.parse("2026-09-10T09:00:01.000Z"),
    lifecycle: "active",
  });
  await ctx.db.insert("sourceProjectLinks", {
    sourceId,
    projectId: p1,
    assignedByUserId: actor.userId,
    assignedAtMs: Date.now(),
    sentAtMs: Date.parse("2026-09-10T09:00:00.000Z"),
  });
  const context = contextFor(actor);
  return {
    ctx,
    sourceId,
    p1,
    p2,
    p3,
    foreignProject,
    run: ({ idempotencyKey, ...input }) =>
      performReassignment(
        asTx(ctx),
        context,
        {
          sourceId: sourceRef(input.sourceId),
          projectIds: input.projectIds.map(projectRef),
          expectedProjectIds: input.expectedProjectIds.map(projectRef),
        },
        idempotencyKey,
      ),
    committed: () => committedPlacement(ctx, sourceId),
    eventCount: () =>
      ctx.db
        .rows("outboxEvents")
        .filter((row) => row.eventName === "sources.sourceReassigned").length,
    jobCount: () =>
      ctx.db
        .rows("durableJobs")
        .filter(
          (row) =>
            row.kind === "memory.recompute_dependents" &&
            typeof row.dedupKey === "string" &&
            row.dedupKey.startsWith("sources.reassignSource:"),
        ).length,
  };
}

/** Narrows an envelope to its typed error (fails the test when it is ok). */
function errorOf(envelope: ResultEnvelope) {
  if (envelope._tag !== "error") {
    throw new Error(`expected error envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error;
}

/** Narrows an envelope to its receipt (fails the test when it is an error). */
function receiptOf(envelope: ResultEnvelope): ReassignSourceReceipt {
  if (envelope._tag !== "ok") {
    throw new Error(`expected ok envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.value as ReassignSourceReceipt;
}

describe("R4-P1 two independently loaded forms cannot silently overwrite each other", () => {
  it("refuses B's stale complete set and keeps A's committed placement (the RED race)", async () => {
    const fx = await reassignmentFixture();

    // Two editors independently load the SAME observed placement ([P1]):
    // each form snapshot is its own read of the committed set.
    const observedByA = await fx.committed();
    const observedByB = await fx.committed();
    expect(observedByA).toEqual([fx.p1]);
    expect(observedByB).toEqual([fx.p1]);

    // A moves the source to P2 with the set A observed.
    const movedByA = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: observedByA,
    });
    expect(receiptOf(movedByA).projectIds).toEqual([fx.p2]);

    // B's still-open form submits its stale desired set (P1 + P3) declaring
    // the placement B observed. This must be refused as a typed stale
    // conflict: on pre-repair main this command silently REMOVED A's P2.
    const staleByB = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p1, fx.p3],
      expectedProjectIds: observedByB,
    });
    const error = errorOf(staleByB);
    expect(error._tag).toBe("conflict");
    expect(error.code).toBe("source_placement_stale");

    // A's assignment survives B's refused stale replacement.
    expect(await fx.committed()).toEqual([fx.p2]);
  });

  it("writes nothing on the stale refusal: zero events, zero recomputation jobs", async () => {
    const fx = await reassignmentFixture();
    await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
    });
    const eventsBefore = fx.eventCount();
    const jobsBefore = fx.jobCount();
    expect(eventsBefore).toBe(1);
    expect(jobsBefore).toBe(1);

    const refused = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p1, fx.p3],
      expectedProjectIds: [fx.p1], // stale: the committed set is [P2]
    });
    errorOf(refused);
    // The E7 regression: a stale refusal produces NO event and NO job.
    expect(fx.eventCount()).toBe(eventsBefore);
    expect(fx.jobCount()).toBe(jobsBefore);
    expect(await fx.committed()).toEqual([fx.p2]);
  });
});

describe("R4-P2 the accepted replacement stays atomic with recomputation", () => {
  it("commits exactly one event and one recomputation identity per accepted command", async () => {
    const fx = await reassignmentFixture();

    // Two distinct logical commands carry distinct idempotency keys (the
    // in-memory harness runs both inside one millisecond, where the
    // fallback `source:nowMs` identity would legitimately collapse).
    const first = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
      idempotencyKey: "r4-p2-first",
    });
    expect(receiptOf(first).projectIds).toEqual([fx.p2]);

    // B reloads the authoritative placement ([P2]) and DELIBERATELY submits
    // P1 + P3: a fresh observed set makes the same desired set acceptable.
    const second = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p1, fx.p3],
      expectedProjectIds: [fx.p2],
      idempotencyKey: "r4-p2-second",
    });
    const receipt = receiptOf(second);
    expect([...receipt.projectIds].sort()).toEqual([fx.p1, fx.p3]);
    expect(await fx.committed()).toEqual([fx.p1, fx.p3]);

    // Exactly two accepted commands: two events, two recomputation jobs,
    // each accepted change carrying ONE dedup identity shared by its event
    // and its job (the atomic publication invariant).
    expect(fx.eventCount()).toBe(2);
    expect(fx.jobCount()).toBe(2);
    const eventKeys = fx.ctx.db
      .rows("outboxEvents")
      .filter((row) => row.eventName === "sources.sourceReassigned")
      .map((row) => row.dedupKey);
    const jobKeys = fx.ctx.db
      .rows("durableJobs")
      .filter((row) => row.kind === "memory.recompute_dependents")
      .map((row) => row.dedupKey);
    expect(new Set(eventKeys).size).toBe(2);
    expect(new Set(jobKeys).size).toBe(2);
    for (const key of eventKeys) {
      expect(jobKeys).toContain(key);
    }
  });
});

describe("R4-P3 the stale refusal reloads the authoritative placement", () => {
  it("keeps the current committed set untouched and refuses again while still stale", async () => {
    const fx = await reassignmentFixture();
    await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
    });

    // The refused editor's RELOADED observed set is the committed set; any
    // submit that still declares the old observed set stays refused.
    const stillStale = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2, fx.p3],
      expectedProjectIds: [fx.p1],
    });
    expect(errorOf(stillStale).code).toBe("source_placement_stale");
    expect(await fx.committed()).toEqual([fx.p2]);
  });

  it("accepts the reload-and-resubmit path against the refreshed set", async () => {
    const fx = await reassignmentFixture();
    await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
    });
    const authoritative = await fx.committed();
    const resubmitted = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2, fx.p3],
      expectedProjectIds: authoritative,
    });
    expect([...receiptOf(resubmitted).projectIds].sort()).toEqual([fx.p2, fx.p3]);
    expect(await fx.committed()).toEqual([fx.p2, fx.p3]);
  });
});

describe("ordering and duplicates never forge a stale conflict or a duplicate link", () => {
  it("ignores ordering and duplicates in the observed set (no false stale conflict)", async () => {
    const fx = await reassignmentFixture();
    await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p1, fx.p2],
      expectedProjectIds: [fx.p1],
    });
    // Observed declared out of order and with a duplicate against the
    // committed [P1, P2] set: still current, so the change proceeds.
    const accepted = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2, fx.p3],
      expectedProjectIds: [fx.p2, fx.p1, fx.p2],
    });
    expect([...receiptOf(accepted).projectIds].sort()).toEqual([fx.p2, fx.p3]);
  });

  it("commits one link per project when the declared set carries duplicates", async () => {
    const fx = await reassignmentFixture();
    const accepted = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2, fx.p2, fx.p1],
      expectedProjectIds: [fx.p1],
    });
    expect([...receiptOf(accepted).projectIds].sort()).toEqual([fx.p1, fx.p2]);
    expect(await fx.committed()).toEqual([fx.p1, fx.p2]);
  });
});

describe("tenant and reference checks precede every write and leak nothing", () => {
  it("refuses a foreign project in the declared set before any write", async () => {
    const fx = await reassignmentFixture();
    const refused = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.foreignProject],
      expectedProjectIds: [fx.p1],
    });
    const error = errorOf(refused);
    expect(error._tag === "forbidden" ? error.code : null).toBe("tenant_scope_mismatch");
    expect(await fx.committed()).toEqual([fx.p1]);
    expect(fx.eventCount()).toBe(0);
    expect(fx.jobCount()).toBe(0);
  });

  it("refuses an unknown project reference in either set before any write", async () => {
    const fx = await reassignmentFixture();
    const unknownDeclared = await fx.run({
      sourceId: fx.sourceId,
      projectIds: ["not-a-convex-id"],
      expectedProjectIds: [fx.p1],
    });
    expect(
      errorOf(unknownDeclared)._tag === "validation" ? errorOf(unknownDeclared).code : null,
    ).toBe("project_reference_not_found");

    const unknownObserved = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: ["not-a-convex-id"],
    });
    expect(
      errorOf(unknownObserved)._tag === "validation" ? errorOf(unknownObserved).code : null,
    ).toBe("project_reference_not_found");
    expect(await fx.committed()).toEqual([fx.p1]);
    expect(fx.eventCount()).toBe(0);
    expect(fx.jobCount()).toBe(0);
  });

  it("refuses a foreign project in the OBSERVED set without exposing placement", async () => {
    const fx = await reassignmentFixture();
    const refused = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1, fx.foreignProject],
    });
    const error = errorOf(refused);
    expect(error._tag).toBe("forbidden");
    expect(error.code).toBe("tenant_scope_mismatch");
    // Nothing was written and the committed placement never left the wire.
    expect(await fx.committed()).toEqual([fx.p1]);
    expect(fx.eventCount()).toBe(0);
    expect(fx.jobCount()).toBe(0);
  });
});

describe("the no-op current replacement stays E7's typed conflict", () => {
  it("refuses a set equal to the current links (nothing to change, no reaction)", async () => {
    const fx = await reassignmentFixture();
    const refused = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p1],
      expectedProjectIds: [fx.p1],
    });
    expect(errorOf(refused).code).toBe("source_links_unchanged");
    expect(await fx.committed()).toEqual([fx.p1]);
    expect(fx.eventCount()).toBe(0);
    expect(fx.jobCount()).toBe(0);
  });

  it("prefers the stale refusal when the observed set no longer matches, even if the desired set is current", async () => {
    const fx = await reassignmentFixture();
    await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
    });
    // Desired equals the committed [P2], but the editor observed [P1]:
    // the stale precondition fires first (the editor never saw the move).
    const refused = await fx.run({
      sourceId: fx.sourceId,
      projectIds: [fx.p2],
      expectedProjectIds: [fx.p1],
    });
    expect(errorOf(refused).code).toBe("source_placement_stale");
  });
});

describe("a pre-repair client omitting the precondition gets a typed refusal", () => {
  it("fails the checked dispatch's input decode and the handler never runs", async () => {
    const actor = Schema.decodeUnknownSync(ActorContext)({
      userId: "u1",
      companyId: "c1",
      membershipRole: "member",
      isGm: false,
      sessionId: "s1",
      via: "user",
    });
    const context: RequestContext = { actor, resolvedAtMs: Date.now() };
    let handlerRan = false;
    const handlers = sourcesHandlers();
    // A tripwire binding: if the checked path ever let a precondition-less
    // envelope through, the handler would run and fail this test.
    handlers["sources.reassignSource"] = {
      intent: "write",
      run: async () => {
        handlerRan = true;
        return okResult({});
      },
    };
    // The pre-repair envelope: the complete replacement set without any
    // observed-placement precondition.
    const result = await dispatchCommand(
      { resolveContext: async () => context, policy: membershipPolicy, handlers },
      null as unknown as MutationCtx,
      {
        operation: "sources.reassignSource",
        input: { sourceId: "s1", projectIds: ["p2"] },
        expectedRevisions: [],
      },
    );
    expect(result._tag).toBe("error");
    const error = errorOf(result);
    expect(error._tag).toBe("validation");
    expect(error.code).toBe("input_rejected_by_contract_schema");
    expect(handlerRan).toBe(false);
  });
});
