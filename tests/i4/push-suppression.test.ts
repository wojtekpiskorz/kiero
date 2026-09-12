/**
 * I4/R3 focused verification (issue #128): permanent deletion terminally
 * suppresses affected UNSENT push work. The exact race the 2026-09-12 map
 * review recorded (prepare, leave the transport pending, delete the
 * source, then retry) must end with ZERO post-delete transport calls and
 * no deleted canary in any stored payload.
 *
 * The state matrix this file pins:
 *
 * - a PENDING push delivery row of an affected intent is terminally
 *   suppressed with the machine purge reason, its stored payload replaced
 *   with non-content data, and it never re-enters retry;
 * - DELIVERED, FAILED and UNKNOWN rows are untouched: an already accepted
 *   external request is never claimed as recalled (unknown stays the
 *   uncertain echo state, never a blind re-send and never a recall);
 * - pending/evaluating intents of the purged source suppress (the
 *   pre-existing stage behavior, kept);
 * - a collapsed batch member whose summary covered the purged source
 *   without intent.sourceId pointing at it is suppressed too;
 * - the suppressed state survives every retry and the stale-pending
 *   safety net (adding the schema literal reactivates nothing).
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, type ResultEnvelope } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import {
  performPurgeSource,
  PURGE_CONFIRMATION_PHRASE,
} from "../../convex/operations/deletion/purge";
import { purgeSourceExecutor } from "../../convex/operations/deletion/executor";
import {
  performCompletePushLegs,
  performPreparePushDelivery,
  performStalePendingIntentIds,
} from "../../convex/attention/push/operations";
import {
  DELETION_TABLES,
  asTx,
  fakeCtx,
  fakePurgeJob,
  seedBossCompanyContext,
  seedWitnessedTextSource,
  type FakeCtx,
} from "./harness";

/** The boss actor context of an already-seeded world (no second seeding). */
function actorOf(world: {
  readonly companyId: string;
  readonly bossId: string;
  readonly sessionId: string;
}): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: world.bossId,
    companyId: world.companyId,
    membershipRole: "admin",
    isGm: false,
    sessionId: world.sessionId,
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() } as RequestContext;
}

/** Deleted-content canary: this text must never survive any stored payload. */
const CANARY_TEXT = "Kaczmarek wpłacił zaliczkę 5000 zł w piątek";

/** RFC 8291-shaped fixture keys: 65-byte 0x04-prefixed point, 16-byte auth. */
const VALID_P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const PUSH_WORLD_TABLES = [
  ...DELETION_TABLES,
  "memberships",
  "pushSubscriptions",
  "pushDeliveries",
  "notificationAttempts",
  "notificationPreferences",
] as const;

const T0 = Date.parse("2026-09-09T10:00:00.000Z");

interface PushWorld {
  readonly ctx: FakeCtx;
  readonly companyId: string;
  readonly bossId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly intentId: string;
  readonly deletionRecordId: string;
}

/** The boss push world: firm, recipient with a live device, canary source, delivered intent. */
async function seedPushWorld(): Promise<Omit<PushWorld, "deletionRecordId">> {
  const ctx = fakeCtx([...PUSH_WORLD_TABLES]);
  const { context, userId } = await seedBossCompanyContext(ctx);
  const companyId = context.actor.companyId as string;
  await ctx.db.insert("memberships", {
    companyId,
    userId,
    role: "admin",
    state: "active",
    createdAtMs: T0,
  });
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    state: "live",
    startedAtMs: T0,
    lastSeenAtMs: T0,
    deviceLabel: "telefon szefa",
  });
  await ctx.db.insert("pushSubscriptions", {
    userId,
    companyId,
    sessionId,
    endpoint: "https://push.example.net/p/i4-r3",
    p256dhKeyBase64: VALID_P256DH,
    authKeyBase64: VALID_AUTH,
    deviceLabel: "telefon szefa",
    createdAtMs: T0,
  });
  const doomed = await seedWitnessedTextSource(
    ctx,
    companyId,
    userId,
    CANARY_TEXT,
  );
  const intentId = await ctx.db.insert("notificationIntents", {
    companyId,
    recipientUserId: userId,
    semanticKind: "source_entry",
    sourceId: doomed.sourceId,
    dedupKey: `source_entry:${doomed.sourceId}:${userId}`,
    state: "delivered",
    dueAtMs: T0 + 60_000,
    deliveryJson: JSON.stringify({
      semanticKind: "source_entry",
      bucket: "company",
      scope: { kind: "company", projectIds: [] },
      sourceIds: [doomed.sourceId],
      clarificationIds: [],
      deliveredAtMs: T0 + 60_000,
    }),
    deliveredAtMs: T0 + 60_000,
    payloadJson: "{}",
    createdAtMs: T0,
  });
  return {
    ctx,
    companyId,
    bossId: userId,
    sessionId,
    sourceId: doomed.sourceId,
    intentId,
  };
}

/** Tombstones the canary source through the REAL initiating transaction. */
async function tombstoneSource(
  world: Omit<PushWorld, "deletionRecordId">,
): Promise<string> {
  const result = (await performPurgeSource(asTx(world.ctx), actorOf(world), {
    sourceId: world.sourceId as never,
    confirmation: PURGE_CONFIRMATION_PHRASE,
  })) as ResultEnvelope & { value: { deletionRecordId: string } };
  return result.value.deletionRecordId;
}

/** Runs the full durable purge executor (every in-transaction stage). */
async function runPurge(world: PushWorld): Promise<void> {
  const input = {
    sourceId: world.sourceId,
    deletionRecordId: world.deletionRecordId,
  };
  const outcome = await purgeSourceExecutor.execute(
    asTx(world.ctx),
    fakePurgeJob(input),
    input,
  );
  if (outcome.outcome !== "succeeded" && outcome.outcome !== "external") {
    throw new Error(`purge executor failed: ${JSON.stringify(outcome)}`);
  }
}

describe("R3-P1 prepare-delete-retry sends no preserved preview", () => {
  it("RED baseline: after the purge, a retried prepare drives ZERO legs and no canary survives storage", async () => {
    const seeded = await seedPushWorld();

    // Prepare FIRST, while the source is still active: the pending row
    // stores the canary preview (the exact race the map review recorded).
    const first = await performPreparePushDelivery(
      asTx(seeded.ctx),
      seeded.intentId as never,
    );
    if (first.kind !== "prepared") {
      throw new Error("expected prepared before deletion");
    }
    expect(first.legs).toHaveLength(1);
    expect(first.legs[0]!.payloadJson).toContain(CANARY_TEXT);

    // Delete the source (tombstone now, purge stages next).
    const deletionRecordId = await tombstoneSource(seeded);
    const world: PushWorld = { ...seeded, deletionRecordId };
    await runPurge(world);

    // The retry: whatever the prepare answers, it must carry NO leg (no
    // transport call can leave after the deletion).
    const retry = await performPreparePushDelivery(
      asTx(seeded.ctx),
      seeded.intentId as never,
    );
    expect(retry.kind === "prepared" ? retry.legs.length : 0).toBe(0);
    expect(["denied", "nothing_pending"]).toContain(retry.kind);

    // No deleted content survives any stored payload.
    const serialized = JSON.stringify(seeded.ctx.db.rows("pushDeliveries"));
    expect(serialized).not.toContain(CANARY_TEXT);
  });
});

// ---------------------------------------------------------------------------
// The deletion state matrix: what each per-device state deserves.
// ---------------------------------------------------------------------------

describe("the deletion state matrix", () => {
  interface MatrixWorld {
    readonly ctx: FakeCtx;
    readonly companyId: string;
    readonly bossId: string;
    readonly sessionId: string;
    readonly sourceId: string;
    readonly intentId: string;
    readonly deliveryId: string;
  }

  /** Seeds the world and one push delivery row forced into a given state. */
  async function seedMatrixWorld(
    state: "pending" | "delivered" | "failed" | "unknown",
  ): Promise<MatrixWorld> {
    const seeded = await seedPushWorld();
    const prepared = await performPreparePushDelivery(
      asTx(seeded.ctx),
      seeded.intentId as never,
    );
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const deliveryId = prepared.legs[0]!.deliveryId;
    if (state !== "pending") {
      const report: import("../../convex/attention/push/protocol").PushLegReport =
        state === "delivered"
          ? { kind: "delivered" }
          : state === "failed"
            ? { kind: "gone" }
            : { kind: "unknown", cause: "timeout" };
      await performCompletePushLegs(asTx(seeded.ctx), [
        {
          deliveryId,
          subscriptionId: prepared.legs[0]!.subscriptionId,
          report,
        },
      ]);
    }
    return { ...seeded, deliveryId };
  }

  it("a PENDING row of the purged source is terminally suppressed with non-content payload", async () => {
    const world = await seedMatrixWorld("pending");
    const recordId = await tombstoneSource(world);
    await runPurge({ ...world, deletionRecordId: recordId });

    const row = world.ctx.db
      .rows("pushDeliveries")
      .find((candidate) => candidate._id === world.deliveryId)!;
    expect(row.state).toBe("suppressed");
    expect(row.lastErrorKind).toBe("source_purged");
    expect(JSON.stringify(row.payloadJson)).not.toContain(CANARY_TEXT);
    expect(row.finishedAtMs).toBeTypeOf("number");
  });

  it("a DELIVERED row is untouched: an already accepted push is never claimed as recalled", async () => {
    const world = await seedMatrixWorld("delivered");
    const recordId = await tombstoneSource(world);
    await runPurge({ ...world, deletionRecordId: recordId });
    const row = world.ctx.db
      .rows("pushDeliveries")
      .find((candidate) => candidate._id === world.deliveryId)!;
    expect(row.state).toBe("delivered");
    expect(row.payloadJson).toContain(CANARY_TEXT);
  });

  it("a FAILED row is untouched (it already settled before the deletion)", async () => {
    const world = await seedMatrixWorld("failed");
    const recordId = await tombstoneSource(world);
    await runPurge({ ...world, deletionRecordId: recordId });
    const row = world.ctx.db
      .rows("pushDeliveries")
      .find((candidate) => candidate._id === world.deliveryId)!;
    expect(row.state).toBe("failed");
    expect(row.lastErrorKind).toBe("push_subscription_gone");
  });

  it("an UNKNOWN row stays unknown: the uncertain echo state is never rewritten", async () => {
    const world = await seedMatrixWorld("unknown");
    const recordId = await tombstoneSource(world);
    await runPurge({ ...world, deletionRecordId: recordId });
    const row = world.ctx.db
      .rows("pushDeliveries")
      .find((candidate) => candidate._id === world.deliveryId)!;
    expect(row.state).toBe("unknown");
    expect(row.lastErrorKind).toBe("push_timeout_after_send");
  });

  it("pending/evaluating intents of the purged source still suppress (the stage's original rule)", async () => {
    const seeded = await seedPushWorld();
    // A second, still-undelivered intent about the same source.
    await seeded.ctx.db.insert("notificationIntents", {
      companyId: seeded.companyId,
      recipientUserId: seeded.bossId,
      semanticKind: "source_entry",
      sourceId: seeded.sourceId,
      dedupKey: `source_entry:${seeded.sourceId}:${seeded.bossId}:pending`,
      state: "pending",
      dueAtMs: T0 + 120_000,
      payloadJson: "{}",
      createdAtMs: T0,
    });
    const recordId = await tombstoneSource(seeded);
    await runPurge({ ...seeded, deletionRecordId: recordId });
    const pendingIntent = seeded.ctx.db
      .rows("notificationIntents")
      .find((row) => row.state === "suppressed")!;
    expect(pendingIntent.suppressedReason).toBe("source_purged");
  });

  it("a collapsed-batch member whose summary covered the purged source suppresses too", async () => {
    const seeded = await seedPushWorld();
    // An independent active source with its own delivered intent; its
    // collapsed summary ALSO covers the doomed source (the batch case the
    // by_source index cannot find).
    const survivor = await seedWitnessedTextSource(
      seeded.ctx,
      seeded.companyId,
      seeded.bossId,
      "Niezależna wiadomość",
    );
    const batchIntentId = await seeded.ctx.db.insert("notificationIntents", {
      companyId: seeded.companyId,
      recipientUserId: seeded.bossId,
      semanticKind: "source_entry",
      sourceId: survivor.sourceId,
      dedupKey: `source_entry:${survivor.sourceId}:${seeded.bossId}`,
      state: "delivered",
      dueAtMs: T0 + 60_000,
      deliveryJson: JSON.stringify({
        semanticKind: "source_entry",
        bucket: "company",
        scope: { kind: "company", projectIds: [] },
        sourceIds: [seeded.sourceId, survivor.sourceId],
        clarificationIds: [],
        deliveredAtMs: T0 + 60_000,
      }),
      deliveredAtMs: T0 + 60_000,
      payloadJson: "{}",
      createdAtMs: T0,
    });
    const prepared = await performPreparePushDelivery(
      asTx(seeded.ctx),
      batchIntentId as never,
    );
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const recordId = await tombstoneSource(seeded);
    await runPurge({ ...seeded, deletionRecordId: recordId });
    const row = seeded.ctx.db
      .rows("pushDeliveries")
      .find((candidate) => candidate.intentId === batchIntentId)!;
    expect(row.state).toBe("suppressed");
    expect(row.lastErrorKind).toBe("source_purged");
    expect(JSON.stringify(row.payloadJson)).not.toContain(CANARY_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Suppressed work never reactivates: retries, the safety net, new prepares.
// ---------------------------------------------------------------------------

describe("suppressed work never reactivates", () => {
  /** Seeds, prepares, purges: the delivery row ends terminally suppressed. */
  async function suppressedWorld(): Promise<PushWorld> {
    const seeded = await seedPushWorld();
    const prepared = await performPreparePushDelivery(
      asTx(seeded.ctx),
      seeded.intentId as never,
    );
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const recordId = await tombstoneSource(seeded);
    const world: PushWorld = { ...seeded, deletionRecordId: recordId };
    await runPurge(world);
    return world;
  }

  it("a replayed purge and a replayed event prepare keep the row suppressed", async () => {
    const world = await suppressedWorld();
    await runPurge(world);
    const replay = await performPreparePushDelivery(
      asTx(world.ctx),
      world.intentId as never,
    );
    expect(replay.kind === "prepared" ? replay.legs.length : 0).toBe(0);
    const row = world.ctx.db.rows("pushDeliveries")[0]!;
    expect(row.state).toBe("suppressed");
  });

  it("the stale-pending safety net never lists suppressed work", async () => {
    const world = await suppressedWorld();
    // Even a forged old updatedAtMs cannot bring suppressed work back.
    const row = world.ctx.db.rows("pushDeliveries")[0]!;
    await world.ctx.db.patch(row._id, { updatedAtMs: Date.now() - 120_000 });
    expect(await performStalePendingIntentIds(asTx(world.ctx))).toEqual([]);
  });

  it("the source-intent preflight denies the deleted source outright (no row, no fetch)", async () => {
    const world = await suppressedWorld();
    expect(
      await performPreparePushDelivery(
        asTx(world.ctx),
        world.intentId as never,
      ),
    ).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });
});

describe("clarification pushes neutralize eagerly at purge time", () => {
  /**
   * F2 writes clarification summaries with NO source ids: the purge's
   * source matching cannot see them. The pending row's stored payload
   * (the question text the transport would send) must already be
   * replaced when the notification stage runs, not lazily at the next
   * prepare: the transcripts stage redacts the anchored case first, the
   * eager R2-rule check sees it non-actionable, and the row terminally
   * suppresses through the SAME production suppressor the prepare path
   * uses. An unaffected delivered clarification row stays untouched.
   */
  it("a pending clarification push of a purged-anchored case suppresses with non-content payload during the purge", async () => {
    const seeded = await seedPushWorld();
    const ctx = seeded.ctx;
    const fragment = ctx.db.rows("sourceFragments").find(
      (row) => row.sourceId === seeded.sourceId,
    )!;
    const clarificationId = (await ctx.db.insert("clarifications", {
      companyId: seeded.companyId,
      scopeKind: "company",
      question: "Ile zaliczki wpłacił Kaczmarek — 5000 zł z piątkowej wiadomości?",
      conflictingFragmentIds: [fragment._id],
      state: "open",
      raisedAtMs: T0 + 30_000,
    })) as string;
    const clarificationIntent = (await ctx.db.insert("notificationIntents", {
      companyId: seeded.companyId,
      recipientUserId: seeded.bossId,
      semanticKind: "clarification",
      dedupKey: `clarification:${clarificationId}:${seeded.bossId}`,
      state: "delivered",
      dueAtMs: T0 + 90_000,
      deliveryJson: JSON.stringify({
        semanticKind: "clarification",
        bucket: "company",
        scope: { kind: "company", projectIds: [] },
        sourceIds: [],
        clarificationIds: [clarificationId],
        deliveredAtMs: T0 + 90_000,
      }),
      deliveredAtMs: T0 + 90_000,
      payloadJson: "{}",
      createdAtMs: T0,
    })) as string;
    const pendingRow = (await ctx.db.insert("pushDeliveries", {
      intentId: clarificationIntent,
      subscriptionId: ctx.db.rows("pushSubscriptions")[0]!._id,
      companyId: seeded.companyId,
      recipientUserId: seeded.bossId,
      state: "pending",
      attempts: 0,
      payloadJson: JSON.stringify({
        title: "Sprawa do wyjaśnienia",
        body: "Ile zaliczki wpłacił Kaczmarek — 5000 zł z piątkowej wiadomości?",
      }),
      createdAtMs: T0 + 95_000,
      updatedAtMs: T0 + 95_000,
    })) as string;

    const deletionRecordId = await tombstoneSource(seeded);
    const world: PushWorld = { ...seeded, deletionRecordId };
    await runPurge(world);

    const row = ctx.db.rows("pushDeliveries").find((candidate) => candidate._id === pendingRow)!;
    expect(row.state).toBe("suppressed");
    expect(row.lastErrorKind).toBe("source_purged");
    expect(row.payloadJson).not.toContain("Kaczmarek");
    expect(row.payloadJson).not.toContain("5000");
  });
});
