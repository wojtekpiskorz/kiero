/**
 * I4 focused verification, part 4: the producer/consumer seams this lane
 * owns or consumes -
 *
 * - the outbox drain projection of `sources.sourcePurged` (both registered
 *   edges: this lane's `deletion.purge_source` with the null-record input,
 *   and E5's `search.index_generation` refresh; the publisher's own
 *   registration collapses onto the same dedup identity);
 * - I5's backup inventory contract over this lane's ledger rows (the
 *   content-free snapshot and the purge drops a backup set applies), the
 *   seam I6's restore replay will consume.
 */

import { describe, expect, it } from "vitest";
import { drainBatch, projectEventToJobInputs } from "../../convex/platform/outbox";
import {
  deletionLedgerSnapshot,
  purgedDropsOf,
  retainedMediaInventory,
} from "../../convex/operations/backups/inventory";
import { DELETION_TABLES, asTx, fakeCtx } from "./harness";

describe("the drain projection of sources.sourcePurged", () => {
  it("projects both registered edges: the purge job (null record) and the search refresh", () => {
    const sourceId = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
    const projections = projectEventToJobInputs(
      "sources.sourcePurged",
      { sourceId },
      `sources.purgeSource:${sourceId}`,
    );
    const jobs = projections.filter((projection) => projection.kind === "job");
    expect(jobs).toHaveLength(2);
    const purge = jobs.find(
      (projection) => projection.kind === "job" && projection.jobKind === "deletion.purge_source",
    ) as { kind: "job"; jobKind: string; input: Record<string, unknown>; dedupKey?: string };
    expect(purge.input).toEqual({ sourceId, deletionRecordId: null });
    // The publisher registered the job under the SAME dedup identity, so
    // the drain collapses onto that row instead of double-registering.
    expect(purge.dedupKey).toBe(`sources.purgeSource:${sourceId}`);
    const refresh = jobs.find(
      (projection) => projection.kind === "job" && projection.jobKind === "search.index_generation",
    ) as { kind: "job"; jobKind: string; input: Record<string, unknown> };
    expect(refresh.input).toMatchObject({ mode: "refresh_source", sourceId });
  });

  it("drains a committed purge row: one purge job row (collapsed with the publisher's), delivered", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const sourceId = await ctx.db.insert("sources", {
      companyId: "k1111111111111111111ttt",
      authorUserId: "k2222222222222222222ttt",
      authorText: "",
      sentAtMs: 1,
      sentAtTimezone: "UTC",
      fullyAcceptedAtMs: 1,
      lifecycle: "purged",
      purgedAtMs: 2,
    });
    // The publisher's atomic registration (what performPurgeSource did).
    await ctx.db.insert("durableJobs", {
      jobKey: "job_0d1e2f3a-1111-2222-3333-444455556666",
      kind: "deletion.purge_source",
      dedupKey: `sources.purgeSource:${sourceId}`,
      inputJson: JSON.stringify({ sourceId, deletionRecordId: "k9999999999999999999ttt" }),
      state: "queued",
      attempts: 0,
      maxAttempts: 6,
      createdAtMs: 2,
      updatedAtMs: 2,
    });
    await ctx.db.insert("outboxEvents", {
      eventId: "0d1e2f3a-1111-2222-3333-444455556666",
      companyId: "k1111111111111111111ttt",
      eventName: "sources.sourcePurged",
      envelopeJson: JSON.stringify({
        eventId: "0d1e2f3a-1111-2222-3333-444455556666",
        name: "sources.sourcePurged",
        occurredAt: "2026-09-11T00:00:00.000Z",
        payload: { sourceId },
      }),
      deliveryState: "pending",
      attempts: 0,
      nextAttemptAtMs: 0,
      dedupKey: `sources.purgeSource:${sourceId}`,
      createdAtMs: 2,
    });
    await drainBatch(asTx(ctx));
    // The publisher's row absorbed the drain's registration (ONE row, not two).
    const jobs = await ctx.db.query("durableJobs").collect();
    const purgeJobs = jobs.filter((job) => job.kind === "deletion.purge_source");
    expect(purgeJobs).toHaveLength(1);
    // The search refresh registered as its own row.
    expect(jobs.some((job) => job.kind === "search.index_generation")).toBe(true);
    const row = (await ctx.db.query("outboxEvents").collect())[0]!;
    expect(row.deliveryState).toBe("delivered");
  });
});

describe("the backup inventory contract over this lane's ledger", () => {
  it("I5's ledger snapshot carries the purge row verbatim (content-free), and the drops key on the source", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const companyId = await ctx.db.insert("companies", { name: "Firma" });
    const purgedSourceId = await ctx.db.insert("sources", {
      companyId,
      authorUserId: "k2222222222222222222ttt",
      authorText: "",
      sentAtMs: 1,
      sentAtTimezone: "UTC",
      fullyAcceptedAtMs: 1,
      lifecycle: "purged",
      purgedAtMs: 10,
    });
    const liveSourceId = await ctx.db.insert("sources", {
      companyId,
      authorUserId: "k2222222222222222222ttt",
      authorText: "zywe",
      sentAtMs: 2,
      sentAtTimezone: "UTC",
      fullyAcceptedAtMs: 2,
      lifecycle: "active",
    });
    const recordId = await ctx.db.insert("deletionRecords", {
      companyId,
      kind: "source_purge",
      targetSourceId: purgedSourceId,
      requestedByUserId: "k3333333333333333333ttt",
      scopeSummary: JSON.stringify({ attachmentCount: 1 }),
      createdAtMs: 10,
      purgeDeadlineAtMs: 10 + 24 * 60 * 60 * 1000,
    });
    const purgedAttachment = await ctx.db.insert("attachments", {
      uploadId: "k4444444444444444444ttt",
      sourceId: purgedSourceId,
      kind: "image",
      objectKey: "companies/x/uploads/purged/0-a",
      createdAtMs: 1,
    });
    const liveAttachment = await ctx.db.insert("attachments", {
      uploadId: "k5555555555555555555ttt",
      sourceId: liveSourceId,
      kind: "image",
      objectKey: "companies/x/uploads/live/0-a",
      createdAtMs: 1,
    });
    for (const attachmentId of [purgedAttachment, liveAttachment]) {
      await ctx.db.insert("mediaRepresentations", {
        attachmentId,
        role: "retained",
        objectKey:
          attachmentId === purgedAttachment
            ? "companies/x/uploads/purged/0-r"
            : "companies/x/uploads/live/0-r",
        contentHash: "sha256:0",
        transformVersion: "d5/1",
        verifiedAtMs: 1,
        createdAtMs: 1,
      });
    }
    const ledger = await deletionLedgerSnapshot(ctx.db as never);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      recordId,
      kind: "source_purge",
      targetSourceId: purgedSourceId,
    });
    // Content-free: no deleted text anywhere in the carried ledger.
    expect(JSON.stringify(ledger)).not.toContain("zywe");

    const inventory = await retainedMediaInventory(ctx.db as never);
    expect(inventory).toHaveLength(2);
    const drops = purgedDropsOf(inventory as never, ledger as never, Date.now());
    // Only the purged source's retained media drops from a set built now.
    expect(drops).toEqual([{ objectKey: "companies/x/uploads/purged/0-r", sourceId: purgedSourceId }]);
  });
});
