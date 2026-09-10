/**
 * D5 focused tests, part 3: the outbox drain's ROW-TERMINAL semantics under
 * multi-edge fan-out (the D5 decision — convex/platform/outbox.ts).
 *
 * The outbox row is the PUBLICATION RECORD: the drain owns its terminal
 * transition — `delivered` once every registered edge's reaction is
 * registered; `failed` + consumer_projection_missing when any registered
 * edge lacks a projection (loud); `delivered` when no edge is registered.
 * Per-reaction outcomes live on the durableJobs rows. These drive the REAL
 * drainBatch over the in-memory db (tests/d2/harness.ts) with the composed
 * registry's real edges.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { drainBatch } from "../../convex/platform/outbox";
import { asTx, fakeCtx } from "../d2/harness";

let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

/** Inserts one pending publication row. */
async function seedRow(eventName: string, payload: Record<string, unknown>, dedupKey: string) {
  const companyId = await ctx.db.insert("companies", {
    name: `drain-${eventName}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  await ctx.db.insert("outboxEvents", {
    eventId: `evt-${eventName}-${dedupKey}`,
    companyId,
    eventName,
    envelopeJson: JSON.stringify({ payload }),
    deliveryState: "pending",
    attempts: 0,
    nextAttemptAtMs: 1,
    dedupKey,
    createdAtMs: 1,
  });
  return companyId;
}

beforeEach(() => {
  ctx = fakeCtx([
    "companies",
    "users",
    "sessions",
    "memberships",
    "sources",
    "sourceProjectLinks",
    "processingRuns",
    "extractions",
    "uploads",
    "attachments",
    "mediaRepresentations",
    "outboxEvents",
    "durableJobs",
  ]);
});

describe("drain row semantics (the multi-edge decision)", () => {
  it("an event whose edges are ALL projected ends delivered with one job per edge", async () => {
    // platform.echoRequested has exactly one edge, with a projection.
    await seedRow("platform.echoRequested", { message: "m" }, "dk-echo");
    await drainBatch(tx());
    const row = ctx.db.rows("outboxEvents")[0]!;
    expect(row.deliveryState).toBe("delivered");
    const jobs = ctx.db.rows("durableJobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("platform.echo_delivery");
  });

  it("sourceAccepted fans out to BOTH edges and the row ends delivered (never in_flight)", async () => {
    // E3 owns the extract projection (row dedup identity) and D5 the
    // normalize projection (payload-derived identity); both register.
    await seedRow(
      "sources.sourceAccepted",
      { sourceId: "k" + "s".repeat(31), attachmentIds: ["k" + "a".repeat(31)] },
      "sources.acceptSource:company:key",
    );
    await drainBatch(tx());
    const row = ctx.db.rows("outboxEvents")[0]!;
    expect(row.deliveryState).toBe("delivered");
    expect(row.lastErrorKind).toBeUndefined();
    const kinds = ctx.db
      .rows("durableJobs")
      .map((job) => job.kind)
      .sort();
    // F2's notification-intent edge (issue #42, flagged coordinated
    // append) joins the fan-out with its payload-derived dedup identity.
    expect(kinds).toEqual([
      "attention.evaluate_due_intents",
      "processing.extract_fragments",
      "processing.normalize_photo",
    ]);
    // The normalize job's dedup identity is payload-derived (distinct from
    // the row's, so one key never carries two job kinds).
    const normalize = ctx.db.rows("durableJobs").find((job) => job.kind === "processing.normalize_photo");
    expect(normalize?.dedupKey).toMatch(/^processing\.normalize_photo:k/);
  });

  it("a pending publication replays without duplicating jobs (drain-side dedup)", async () => {
    await seedRow("platform.echoRequested", { message: "m" }, "dk-echo-replay");
    await drainBatch(tx());
    // Force the row back to pending (the retryable-echo path can do this)
    // and drain again: dedup-skips, stays delivered, still ONE job row.
    const row = ctx.db.rows("outboxEvents")[0]!;
    await ctx.db.patch(row._id, { deliveryState: "pending", nextAttemptAtMs: 1 });
    await drainBatch(tx());
    expect(ctx.db.rows("outboxEvents")[0]?.deliveryState).toBe("delivered");
    expect(ctx.db.rows("durableJobs")).toHaveLength(1);
  });

  it("an event with NO registered consumer edge ends delivered immediately", async () => {
    await seedRow("operations.diagnosticEmitted", {}, "dk-none");
    await drainBatch(tx());
    expect(ctx.db.rows("outboxEvents")[0]?.deliveryState).toBe("delivered");
    expect(ctx.db.rows("durableJobs")).toHaveLength(0);
  });

  it("a registered edge WITHOUT a projection fails the row LOUDLY (machine-readable)", async () => {
    // Find an event whose single edge has no projection in this window.
    // (The composed registry currently projects every projected kind's
    // edge; the unprojected case is exercised through the same code path
    // as the platform tests. Here we assert the loud failure when it
    // occurs by temporarily relying on an event with a registered but
    // unprojected edge: sources.sourcePurged -> deletion.purge_source.)
    // deletion.purge_source is I4's edge and stays unprojected until then;
    // assert unconditionally so a silently-gained projection fails here
    // instead of degrading the loud-failure branch to a delivered check.
    await seedRow("sources.sourcePurged", { sourceId: "k" + "s".repeat(31) }, "dk-purged");
    await drainBatch(tx());
    const row = ctx.db.rows("outboxEvents")[0]!;
    expect(row.deliveryState).toBe("failed");
    expect(row.lastErrorKind).toBe("consumer_projection_missing");
    expect(ctx.db.rows("durableJobs")).toHaveLength(0);
  });
});
