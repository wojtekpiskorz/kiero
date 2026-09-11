/**
 * I4 focused verification, part 1: the initiating transaction
 * `performPurgeSource` through the REAL core on the in-memory harness -
 * the guards (confirmation, idempotent replay, foreign source), the atomic
 * commit (tombstone with content removal, content-free ledger, per-family
 * stages, canonical events, durable registration, eager export
 * invalidation).
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, parseTableId, type ResultEnvelope } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import { performPurgeSource, PURGE_CONFIRMATION_PHRASE } from "../../convex/operations/deletion/purge";
import { PURGE_STAGE_KINDS } from "../../convex/operations/deletion/schema";
import { DELETION_TABLES, asTx, fakeCtx, type FakeCtx } from "./harness";

function okOf(envelope: ResultEnvelope): Record<string, unknown> {
  if (envelope._tag !== "ok") {
    throw new Error(`expected ok, got ${JSON.stringify(envelope)}`);
  }
  return envelope.value as Record<string, unknown>;
}

function errorOf(envelope: ResultEnvelope) {
  if (envelope._tag !== "error") {
    throw new Error(`expected error, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error;
}

async function seedActor(ctx: FakeCtx): Promise<RequestContext> {
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
  return { actor, resolvedAtMs: Date.now() };
}

interface SeededSource {
  readonly context: RequestContext;
  readonly sourceId: string;
}

async function seedSource(
  ctx: FakeCtx,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<SeededSource> {
  const context = await seedActor(ctx);
  const sourceId = await ctx.db.insert("sources", {
    companyId: context.actor.companyId,
    authorUserId: context.actor.userId,
    authorText: "Banan: termin oddania 15 marca",
    sentAtMs: 1000,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: 1000,
    lifecycle: "active",
    ...overrides,
  });
  return { context, sourceId };
}

const purgeInput = (sourceId: string, confirmation = PURGE_CONFIRMATION_PHRASE) => ({
  sourceId: parseTableId("sources", sourceId)!,
  confirmation,
});

describe("the initiating transaction's guards", () => {
  it("refuses a wrong confirmation phrase as a typed conflict, committing nothing", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx);
    const result = await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId, "usuń"));
    expect(errorOf(result)).toMatchObject({ _tag: "conflict", code: "purge_confirmation_mismatch" });
    const source = await ctx.db.get(seeded.sourceId);
    expect(source?.lifecycle).toBe("active");
    expect(source?.authorText).toBe("Banan: termin oddania 15 marca");
    expect(await ctx.db.query("deletionRecords").collect()).toHaveLength(0);
    expect(await ctx.db.query("outboxEvents").collect()).toHaveLength(0);
  });

  it("refuses a foreign or missing source with the uniform not-found", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const otherCompany = await ctx.db.insert("companies", { name: "Obca" });
    const foreign = await ctx.db.insert("sources", {
      companyId: otherCompany,
      authorUserId: "k0000000000000000000ttt",
      authorText: "obca",
      sentAtMs: 1,
      sentAtTimezone: "UTC",
      fullyAcceptedAtMs: 1,
      lifecycle: "active",
    });
    const seeded = await seedSource(ctx);
    const foreignResult = await performPurgeSource(asTx(ctx), seeded.context, purgeInput(foreign));
    expect(errorOf(foreignResult)).toMatchObject({ _tag: "not_found", entity: "sources" });
    const missing = await performPurgeSource(asTx(ctx), seeded.context, purgeInput("k1234567890123456789ttt"));
    expect(errorOf(missing)).toMatchObject({ _tag: "not_found", entity: "sources" });
  });

  it("replays idempotently: a repeated delete returns the SAME ledger record, never a second one", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx);
    const first = okOf(await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId)));
    const second = okOf(await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId)));
    expect(second.deletionRecordId).toBe(first.deletionRecordId);
    expect(await ctx.db.query("deletionRecords").collect()).toHaveLength(1);
    // And no second reaction was registered.
    expect(await ctx.db.query("durableJobs").collect()).toHaveLength(1);
  });
});

describe("the atomic commit", () => {
  it("tombstones the source, blanks its content, and writes the content-free ledger with six pending stages", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx);
    await ctx.db.insert("attachments", {
      uploadId: "k1111111111111111111ttt",
      sourceId: seeded.sourceId,
      kind: "image",
      objectKey: "companies/x/uploads/y/0-a",
      createdAtMs: 1,
    });
    const result = okOf(await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId)));
    const source = await ctx.db.get(seeded.sourceId);
    expect(source?.lifecycle).toBe("purged");
    expect(source?.purgedAtMs).toBeTypeOf("number");
    expect(source?.authorText).toBe("");
    const records = await ctx.db.query("deletionRecords").collect();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record._id).toBe(result.deletionRecordId);
    expect(record.kind).toBe("source_purge");
    expect(record.targetSourceId).toBe(seeded.sourceId);
    expect(record.requestedByUserId).toBe(seeded.context.actor.userId);
    // Content-free by construction: counts and kinds only, never text.
    const scope = JSON.parse(record.scopeSummary as string) as Record<string, number>;
    expect(scope).toMatchObject({ attachmentCount: 1 });
    expect(JSON.stringify(record)).not.toContain("Banan");
    expect(record.purgeDeadlineAtMs).toBeGreaterThan(Date.now());
    const stages = await ctx.db.query("deletionPurgeStages").collect();
    expect(stages.map((stage) => stage.stageKind).sort()).toEqual([...PURGE_STAGE_KINDS].sort());
    for (const stage of stages) {
      expect(stage.state).toBe("pending");
      expect(stage.deadlineAtMs).toBe(record.purgeDeadlineAtMs);
    }
  });

  it("publishes the canonical events and registers the durable purge under the shared dedup identity", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx);
    await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId));
    const events = await ctx.db.query("outboxEvents").collect();
    expect(events.map((row) => row.eventName).sort()).toEqual(
      ["operations.deletionRecorded", "sources.sourcePurged"].sort(),
    );
    const purged = events.find((row) => row.eventName === "sources.sourcePurged")!;
    const jobs = await ctx.db.query("durableJobs").collect();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("deletion.purge_source");
    expect(jobs[0]?.dedupKey).toBe(purged.dedupKey);
    expect(jobs[0]?.state).toBe("queued");
    const input = JSON.parse(jobs[0]?.inputJson as string) as { sourceId: string };
    expect(input.sourceId).toBe(seeded.sourceId);
  });

  it("invalidates a linked available export eagerly, in the SAME transaction", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx);
    const exportId = await ctx.db.insert("exports", {
      companyId: seeded.context.actor.companyId,
      state: "available",
      requestedByUserId: seeded.context.actor.userId,
      createdAtMs: 1,
      objectKey: "exports/e1",
      etag: "etag",
      bytes: 10,
      availableUntilMs: Date.now() + 3_600_000,
    });
    await ctx.db.insert("exportSourceLinks", { exportId, sourceId: seeded.sourceId });
    await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId));
    const row = await ctx.db.get(exportId);
    expect(row?.state).toBe("invalidated");
    expect(row?.invalidationReason).toBe("source_purged");
    // The transaction scheduled its reactions: three event drains (purged,
    // recorded, export-invalidated), the durable purge executor, and the
    // archive-byte cleanup of the invalidated row.
    expect(ctx.scheduled).toHaveLength(5);
  });

  it("a withdrawn source may still be permanently deleted", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const seeded = await seedSource(ctx, { lifecycle: "withdrawn", withdrawnReason: "pomyłka" });
    const result = okOf(await performPurgeSource(asTx(ctx), seeded.context, purgeInput(seeded.sourceId)));
    const source = await ctx.db.get(seeded.sourceId);
    expect(source?.lifecycle).toBe("purged");
    expect(typeof result.deletionRecordId).toBe("string");
  });
});
