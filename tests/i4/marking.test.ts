/**
 * I4 focused verification, part 2: the purge support-removal marking
 * `markPurgedSupport` through the REAL core on the in-memory harness -
 * the sole-witness rule (unknown marking with the purge origin and
 * by-SOURCE-ID attribution), the survivors (explicit corrections,
 * independent corroboration), replay safety and the cascade carrier into
 * C5's recompute.
 */

import { describe, expect, it } from "vitest";
import { parseTableId } from "@kiero/contracts";
import type { Id } from "../../convex/_generated/dataModel";
import { markPurgedSupport } from "../../convex/operations/deletion/marking";
import { PURGED_SUPPORT_REASON } from "../../convex/operations/deletion/purge";
import { DELETION_TABLES, asTx, fakeCtx, type FakeCtx } from "./harness";

const KNOWN = { _tag: "known" } as const;
const MONEY_VALUE = {
  _tag: "money",
  money: {
    role: "agreed_price",
    amount: { _tag: "exact", value: "10000" },
    currency: "PLN",
    currencyOrigin: "stated",
    taxBasis: "not_specified",
    certainty: "exact",
  },
} as const;

interface Seeded {
  readonly companyId: Id<"companies">;
  readonly userId: Id<"users">;
  readonly sourceId: Id<"sources">;
  readonly otherSourceId: Id<"sources">;
}

async function seedWorld(ctx: FakeCtx): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", { name: "Firma" });
  const userId = await ctx.db.insert("users", { email: "szef@firma.invalid" });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: "wycena 10 tys.",
    sentAtMs: 1,
    sentAtTimezone: "UTC",
    fullyAcceptedAtMs: 1,
    lifecycle: "purged",
    purgedAtMs: 2,
  });
  const otherSourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: "potwierdzenie",
    sentAtMs: 2,
    sentAtTimezone: "UTC",
    fullyAcceptedAtMs: 2,
    lifecycle: "active",
  });
  return {
    companyId: parseTableId("companies", companyId) as unknown as Id<"companies">,
    userId: parseTableId("users", userId) as unknown as Id<"users">,
    sourceId: parseTableId("sources", sourceId) as unknown as Id<"sources">,
    otherSourceId: parseTableId("sources", otherSourceId) as unknown as Id<"sources">,
  };
}

/** One finding whose CURRENT revision rests on the given evidence set. */
async function seedFinding(
  ctx: FakeCtx,
  world: Seeded,
  options: {
    readonly evidence: ReadonlyArray<{ sourceId: string; supportKind: "support" | "independent_corroboration" }>;
    readonly origin?: string;
    readonly dependsOnFindingIds?: readonly string[];
  },
): Promise<string> {
  const findingId = await ctx.db.insert("findings", {
    companyId: world.companyId,
    scopeKind: "company",
    semanticKey: `cena.${Math.random().toString(36).slice(2, 8)}`,
    knowledgeState: KNOWN,
    revisionCounter: 1,
    updatedAtMs: 1,
  });
  const revisionId = await ctx.db.insert("findingRevisions", {
    findingId,
    revision: 1,
    value: MONEY_VALUE,
    knowledgeState: KNOWN,
    origin: options.origin ?? "publication",
    recordedByUserId: world.userId,
    recordedAtMs: 1,
  });
  await ctx.db.patch(findingId, { currentRevisionId: revisionId });
  for (const entry of options.evidence) {
    await ctx.db.insert("evidenceLinks", {
      findingRevisionId: revisionId,
      sourceId: entry.sourceId,
      supportKind: entry.supportKind,
      createdAtMs: 1,
    });
  }
  for (const rootId of options.dependsOnFindingIds ?? []) {
    await ctx.db.insert("findingDependencies", {
      companyId: world.companyId,
      dependentFindingId: findingId,
      dependsOnFindingId: rootId,
      cause: "derivation",
      createdAtMs: 1,
    });
  }
  return findingId;
}

describe("the purge marking's sole-witness rule", () => {
  it("marks a finding supported only by the purged source unknown, with the purge origin and attribution", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    const findingId = await seedFinding(ctx, world, {
      evidence: [{ sourceId: world.sourceId, supportKind: "support" }],
    });
    const outcome = await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    expect(outcome._tag).toBe("ok");
    const finding = await ctx.db.get(findingId);
    expect(finding?.revisionCounter).toBe(2);
    const revisions = await ctx.db.query("findingRevisions").collect();
    const marking = revisions.find((row) => row.origin === "purge_marking")!;
    expect(marking).toBeDefined();
    expect(marking.findingId).toBe(findingId);
    expect(marking.purgedSourceId).toBe(world.sourceId);
    expect(marking.reason).toBe(PURGED_SUPPORT_REASON);
    expect(marking.knowledgeState).toMatchObject({ _tag: "unknown" });
    // The marking's knowledge state is the finding's current projection.
    expect(finding?.knowledgeState).toMatchObject({ _tag: "unknown" });
    // The revision event drained C5/E5/F4's shared seam.
    const events = await ctx.db.query("outboxEvents").collect();
    expect(events.some((row) => row.eventName === "memory.findingRevised")).toBe(true);
  });

  it("keeps a finding standing on an independent witness of another source", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    const findingId = await seedFinding(ctx, world, {
      evidence: [
        { sourceId: world.sourceId, supportKind: "support" },
        { sourceId: world.otherSourceId, supportKind: "independent_corroboration" },
      ],
    });
    const outcome = await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    expect(outcome._tag).toBe("ok");
    if (outcome._tag !== "ok") {
      return;
    }
    expect(outcome.markedFindingIds).not.toContain(findingId);
    expect(await ctx.db.get(findingId)).toMatchObject({ revisionCounter: 1 });
  });

  it("keeps an explicit correction standing (its own resolution, not borrowed support)", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    const findingId = await seedFinding(ctx, world, {
      evidence: [{ sourceId: world.sourceId, supportKind: "support" }],
      origin: "correction",
    });
    await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    expect(await ctx.db.get(findingId)).toMatchObject({ revisionCounter: 1 });
  });

  it("is replay-safe: a second run over the same purge marks nothing again", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    await seedFinding(ctx, world, {
      evidence: [{ sourceId: world.sourceId, supportKind: "support" }],
    });
    const first = await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    const second = await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    expect(second._tag).toBe("ok");
    if (first._tag !== "ok" || second._tag !== "ok") {
      return;
    }
    expect(second.markedFindingIds).toHaveLength(0);
    const revisions = await ctx.db.query("findingRevisions").collect();
    expect(revisions.filter((row) => row.origin === "purge_marking")).toHaveLength(1);
  });

  it("refuses when the source is not purged (marking follows the committed tombstone)", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    await ctx.db.patch(world.sourceId, { lifecycle: "active", purgedAtMs: undefined });
    const outcome = await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error._tag).toBe("conflict");
    }
  });

  it("hands every marked root's dependents to the C5 cascade carrier", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedWorld(ctx);
    const rootId = await seedFinding(ctx, world, {
      evidence: [{ sourceId: world.sourceId, supportKind: "support" }],
    });
    const dependentId = await seedFinding(ctx, world, {
      evidence: [{ sourceId: world.otherSourceId, supportKind: "support" }],
      dependsOnFindingIds: [rootId],
    });
    void dependentId;
    await markPurgedSupport(asTx(ctx), {
      companyId: world.companyId,
      actorUserId: world.userId,
      sourceId: world.sourceId,
    });
    const events = await ctx.db.query("outboxEvents").collect();
    const carriers = events.filter((row) => row.eventName === "memory.dependentsMarkedStale");
    expect(carriers).toHaveLength(1);
    const envelope = JSON.parse(carriers[0]!.envelopeJson as string) as {
      payload: { rootFindingId: string; dependentFindingIds: string[] };
    };
    expect(envelope.payload.rootFindingId).toBe(rootId);
  });
});
