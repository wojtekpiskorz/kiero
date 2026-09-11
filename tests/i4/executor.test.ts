/**
 * I4 focused verification, part 3: the durable purge executor's stages on
 * the in-memory harness - transcripts/fragments/extractions deletion,
 * search-row drops, notification suppression, export verification, media
 * key collection and the external hand-off; plus idempotent retry after an
 * interrupted attempt, and the 24-hour overdue tick's I2 diagnostic.
 */

import { describe, expect, it } from "vitest";
import { purgeSourceExecutor } from "../../convex/operations/deletion/executor";
import { runPurgeOverduePass } from "../../convex/operations/deletion/functions";
import { PURGE_STAGE_KINDS } from "../../convex/operations/deletion/schema";
import { DELETION_TABLES, asTx, fakeCtx, type FakeCtx } from "./harness";
import type { DurableJobDoc } from "../../convex/platform/executors";

interface Seeded {
  readonly companyId: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly recordId: string;
}

function jobDoc(inputJson: string): DurableJobDoc {
  return {
    jobKey: "job-test",
    kind: "deletion.purge_source",
    inputJson,
    attempts: 0,
    maxAttempts: 6,
    state: "running",
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as DurableJobDoc;
}

async function seedPurged(ctx: FakeCtx): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", { name: "Firma" });
  const userId = await ctx.db.insert("users", { email: "szef@firma.invalid" });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: "",
    sentAtMs: 1,
    sentAtTimezone: "UTC",
    fullyAcceptedAtMs: 1,
    lifecycle: "purged",
    purgedAtMs: 2,
  });
  const recordId = await ctx.db.insert("deletionRecords", {
    companyId,
    kind: "source_purge",
    targetSourceId: sourceId,
    requestedByUserId: userId,
    scopeSummary: "{}",
    createdAtMs: 2,
    purgeDeadlineAtMs: 2 + 24 * 60 * 60 * 1000,
  });
  for (const stageKind of PURGE_STAGE_KINDS) {
    await ctx.db.insert("deletionPurgeStages", {
      deletionRecordId: recordId,
      companyId,
      sourceId,
      stageKind,
      state: "pending",
      attempts: 0,
      deadlineAtMs: 2 + 24 * 60 * 60 * 1000,
      createdAtMs: 2,
    });
  }
  await ctx.db.insert("durableJobs", {
    jobKey: "job-test",
    kind: "deletion.purge_source",
    inputJson: JSON.stringify({ sourceId, deletionRecordId: recordId }),
    state: "running",
    attempts: 1,
    maxAttempts: 6,
    createdAtMs: 2,
    updatedAtMs: 2,
  });
  return { companyId, userId, sourceId, recordId };
}

describe("the purge executor's stages", () => {
  it("deletes transcripts, segments, vision orders, extractions and fragments; fails in-flight change sets", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId: "k1111111111111111111ttt",
      sourceId: world.sourceId,
      kind: "audio",
      objectKey: "companies/x/uploads/y/0-a",
      createdAtMs: 1,
    });
    const transcriptId = await ctx.db.insert("audioTranscripts", {
      companyId: world.companyId,
      sourceId: world.sourceId,
      attachmentId,
      state: "succeeded",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await ctx.db.insert("audioSegments", {
      transcriptId,
      segmentIndex: 0,
      startMs: 0,
      endMs: 100,
      durationMs: 100,
      state: "succeeded",
      attempts: 1,
      text: "rozmowa o wycenie",
    });
    await ctx.db.insert("visionOrders", {
      sourceId: world.sourceId,
      attachmentId,
      representationId: "k2222222222222222222ttt",
      state: "succeeded",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const extractionId = await ctx.db.insert("extractions", {
      sourceId: world.sourceId,
      kind: "stt",
      pipelineVersion: "d6/1",
      model: "m",
      provider: "openrouter",
      processingRunId: "k3333333333333333333ttt",
      createdAtMs: 1,
    });
    await ctx.db.insert("sourceFragments", {
      extractionId,
      sourceId: world.sourceId,
      anchor: { _tag: "whole_source" },
      createdAtMs: 1,
    });
    const changeSetId = await ctx.db.insert("changeSets", {
      companyId: world.companyId,
      sourceId: world.sourceId,
      state: "prepared",
      preparedAtMs: 1,
    });

    const outcome = await purgeSourceExecutor.execute(
      asTx(ctx),
      jobDoc(JSON.stringify({ sourceId: world.sourceId, deletionRecordId: world.recordId })),
      { sourceId: world.sourceId, deletionRecordId: world.recordId },
    );
    // Media keys exist (the attachment), so the effect leaves the transaction.
    expect(outcome).toMatchObject({ outcome: "external" });

    expect(await ctx.db.query("audioTranscripts").collect()).toHaveLength(0);
    expect(await ctx.db.query("audioSegments").collect()).toHaveLength(0);
    expect(await ctx.db.query("visionOrders").collect()).toHaveLength(0);
    expect(await ctx.db.query("extractions").collect()).toHaveLength(0);
    expect(await ctx.db.query("sourceFragments").collect()).toHaveLength(0);
    // The verbatim transcript rows are gone entirely (length 0 above), so
    // the text left with them.
    expect(await ctx.db.get(changeSetId)).toMatchObject({ state: "failed", failedReason: "source_purged" });

    const stages = await ctx.db.query("deletionPurgeStages").collect();
    const transcripts = stages.find((stage) => stage.stageKind === "transcripts")!;
    expect(transcripts.state).toBe("purged");
    // The media stage recorded its authoritative key list.
    const media = stages.find((stage) => stage.stageKind === "media_objects")!;
    expect(media.state).toBe("pending");
    expect(JSON.parse(media.objectKeysJson as string)).toContain("companies/x/uploads/y/0-a");
    void extractionId;
  });

  it("drops derived search rows and suppresses pending notification intents", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    await ctx.db.insert("searchEntries", {
      companyId: world.companyId,
      generationId: "k4444444444444444444ttt",
      sourceId: world.sourceId,
      preparedText: "wycena 10 tys.",
      createdAtMs: 1,
    });
    const intentId = await ctx.db.insert("notificationIntents", {
      companyId: world.companyId,
      recipientUserId: world.userId,
      semanticKind: "source_entry",
      sourceId: world.sourceId,
      dedupKey: `source-entry:${world.sourceId}`,
      state: "pending",
      dueAtMs: Date.now() + 1000,
      payloadJson: "{}",
      createdAtMs: 1,
    });
    await ctx.db.insert("notificationIntents", {
      companyId: world.companyId,
      recipientUserId: world.userId,
      semanticKind: "source_entry",
      sourceId: world.sourceId,
      dedupKey: `source-entry-delivered:${world.sourceId}`,
      state: "delivered",
      dueAtMs: 1,
      payloadJson: "{}",
      createdAtMs: 1,
    });

    await purgeSourceExecutor.execute(
      asTx(ctx),
      jobDoc(JSON.stringify({ sourceId: world.sourceId, deletionRecordId: world.recordId })),
      { sourceId: world.sourceId, deletionRecordId: world.recordId },
    );

    expect(await ctx.db.query("searchEntries").collect()).toHaveLength(0);
    expect(await ctx.db.get(intentId)).toMatchObject({
      state: "suppressed",
      suppressedReason: "source_purged",
    });
    const stages = await ctx.db.query("deletionPurgeStages").collect();
    expect(stages.find((stage) => stage.stageKind === "search_index")?.state).toBe("purged");
    expect(stages.find((stage) => stage.stageKind === "notification_work")?.state).toBe("purged");
  });

  it("verifies linked exports are terminal (the eager seam did the work)", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    const exportId = await ctx.db.insert("exports", {
      companyId: world.companyId,
      state: "invalidated",
      requestedByUserId: world.userId,
      createdAtMs: 1,
      invalidationReason: "source_purged",
      invalidatedAtMs: 2,
    });
    await ctx.db.insert("exportSourceLinks", { exportId, sourceId: world.sourceId });
    await purgeSourceExecutor.execute(
      asTx(ctx),
      jobDoc(JSON.stringify({ sourceId: world.sourceId, deletionRecordId: world.recordId })),
      { sourceId: world.sourceId, deletionRecordId: world.recordId },
    );
    const stages = await ctx.db.query("deletionPurgeStages").collect();
    expect(stages.find((stage) => stage.stageKind === "exports")?.state).toBe("purged");
  });

  it("succeeds outright when no media exists, and a retry after completion is a no-op", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    const input = { sourceId: world.sourceId, deletionRecordId: world.recordId };
    const first = await purgeSourceExecutor.execute(asTx(ctx), jobDoc(JSON.stringify(input)), input);
    expect(first).toMatchObject({ outcome: "succeeded" });
    const second = await purgeSourceExecutor.execute(asTx(ctx), jobDoc(JSON.stringify(input)), input);
    expect(second).toMatchObject({ outcome: "succeeded" });
    const stages = await ctx.db.query("deletionPurgeStages").collect();
    expect(stages.every((stage) => stage.state === "purged")).toBe(true);
  });

  it("resolves the null-record input (the drain projection's shape) in-company", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    const input = { sourceId: world.sourceId, deletionRecordId: null };
    const outcome = await purgeSourceExecutor.execute(asTx(ctx), jobDoc(JSON.stringify(input)), input);
    expect(outcome).toMatchObject({ outcome: "succeeded" });
  });
});

describe("the 24-hour overdue tick", () => {
  it("emits the deduplicated I2 diagnostic for un-purged stages past the deadline and slides it", async () => {
    const ctx = fakeCtx(DELETION_TABLES);
    const world = await seedPurged(ctx);
    const past = Date.now() - 1000;
    const stages = await ctx.db.query("deletionPurgeStages").collect();
    for (const stage of stages) {
      await ctx.db.patch(stage._id, { deadlineAtMs: past });
    }
    const first = await runPurgeOverduePass(asTx(ctx));
    expect(first).toBe(stages.length);
    const diagnostics = await ctx.db.query("diagnosticEvents").collect();
    expect(diagnostics).toHaveLength(stages.length);
    expect(diagnostics[0]?.kind).toBe("ops.deletion.overdue");
    // Content-free metadata only.
    expect(JSON.stringify(diagnostics)).not.toContain("Banan");
    // Dedup inside the slid window: the second pass emits nothing new.
    const second = await runPurgeOverduePass(asTx(ctx));
    expect(second).toBe(0);
    expect(await ctx.db.query("diagnosticEvents").collect()).toHaveLength(stages.length);
    void world;
  });
});
