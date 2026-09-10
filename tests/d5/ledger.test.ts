/**
 * D5 focused tests, part 2: the normalization ledger transactions
 * (convex/processing/images/ledger.ts) over the in-memory emulation of the
 * Convex db surface (tests/d2/harness.ts, D2's harness with the D5 `delete`
 * append).
 *
 * These drive the REAL transaction functions — prepare/record/verify/
 * cleanup/reconcile plus the executor outcome recording — including the
 * job-scoped tenancy chain, the idempotent replay semantics, the
 * retained-original exception path, the received-referenced-by-extraction
 * refusal, and the observation-based reconciliation decisions. The
 * crash-atomicity and live-chain proofs run against the real deployment.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanupReceivedTransaction,
  prepareNormalizationTransaction,
  reconcileNormalizationTransaction,
  recordAttemptOutcomeTransaction,
  recordNormalizationTransaction,
  verifyNormalizationTransaction,
} from "../../convex/processing/images/ledger";
import { executeNormalizationHalf } from "../../convex/processing/images/ledger";
import {
  NORMALIZE_TRANSFORM_VERSION,
  RETAINED_ORIGINAL_TRANSFORM_VERSION,
  THUMBNAIL_TRANSFORM_VERSION,
} from "../../convex/processing/images/protocol";
import { asTx, errorOf, fakeCtx, seedActor, valueOf, type FakeCtx } from "../d2/harness";

let ctx: FakeCtx;

const tx = () => asTx(ctx);

const RUN = "d5ledger";

/** Seeds one accepted image attachment + its verified received representation. */
async function seedImage(label: string, options?: { readonly company?: string }) {
  const companyId = options?.company;
  const uploadId = await ctx.db.insert("uploads", {
    companyId,
    userId: "u-any",
    stage: "finalized",
    partCount: 1,
    createdAtMs: 1,
    acceptedSourceId: "placeholder",
  });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: "u-any",
    authorText: `wifi ${label}`,
    sentAtMs: 1,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: 1,
    lifecycle: "active",
  });
  const attachmentId = await ctx.db.insert("attachments", {
    uploadId,
    sourceId,
    kind: "image",
    objectKey: `companies/${companyId}/uploads/${uploadId}/0-${label}`,
    receivedBytes: 1024,
    contentHash: "r2:etag:received",
    createdAtMs: 1,
    completedAtMs: 1,
    r2ObjectEtag: "etag-received",
  });
  await ctx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "received",
    objectKey: `companies/${companyId}/uploads/${uploadId}/0-${label}`,
    contentHash: "r2:etag:received",
    transformVersion: "d2.received/1",
    verifiedAtMs: 1,
    createdAtMs: 1,
  });
  await ctx.db.patch(uploadId, { acceptedSourceId: sourceId });
  return { uploadId, sourceId, attachmentId, companyId };
}

/** Seeds one running normalize job for a source's attachments. */
async function seedJob(companyId: string, sourceId: string, attachmentIds: string[]) {
  const jobKey = `job_${sourceId}_${RUN}`;
  const jobId = await ctx.db.insert("durableJobs", {
    jobKey,
    kind: "processing.normalize_photo",
    companyId,
    sourceId,
    dedupKey: `processing.normalize_photo:${sourceId}`,
    inputJson: JSON.stringify({ sourceId, attachmentIds }),
    state: "running",
    attempts: 1,
    maxAttempts: 3,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  return { jobId, jobKey, sourceId, dedupKey: `processing.normalize_photo:${sourceId}` };
}

/** The recorded normalized outcome shape the gateway executor sends. */
function normalizedOutcome(companyId: string, attachmentId: string, hash: string, thumbHash: string) {
  return {
    _tag: "normalized" as const,
    retained: {
      objectKey: `companies/${companyId}/retained/${attachmentId}/${NORMALIZE_TRANSFORM_VERSION}/retained.webp`,
      contentHash: hash,
      bytes: 640,
      width: 3024,
      height: 4032,
      mimeType: "image/webp",
    },
    thumbnail: {
      objectKey: `companies/${companyId}/retained/${attachmentId}/${THUMBNAIL_TRANSFORM_VERSION}/thumbnail.webp`,
      contentHash: thumbHash,
      bytes: 32,
      width: 384,
      height: 512,
      mimeType: "image/webp",
    },
  };
}

function evidenceFor(outcome: ReturnType<typeof normalizedOutcome>) {
  return {
    objectKey: outcome.retained.objectKey,
    contentHash: outcome.retained.contentHash,
    bytes: outcome.retained.bytes,
  };
}

function thumbEvidenceFor(outcome: ReturnType<typeof normalizedOutcome>) {
  return {
    objectKey: outcome.thumbnail.objectKey,
    contentHash: outcome.thumbnail.contentHash,
    bytes: outcome.thumbnail.bytes,
  };
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

describe("prepare", () => {
  it("marks the in-progress processing row and hands over the deterministic key plan", async () => {
    const actor = await seedActor(ctx, "d5prep");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const result = valueOf(
      await prepareNormalizationTransaction(tx(), job.jobKey),
    );
    expect(result.attachments).toHaveLength(1);
    const plan = (result.attachments as Record<string, unknown>[])[0]!;
    expect(plan.state).toBe("awaiting");
    expect(plan.step).toBe("normalize");
    expect(plan.receivedObjectKey).toContain("uploads/");
    expect(plan.retainedObjectKey).toBe(
      `companies/${actor.companyId}/retained/${seeded.attachmentId}/${NORMALIZE_TRANSFORM_VERSION}/retained.webp`,
    );
    const processing = ctx.db.rows("mediaRepresentations").find((row) => row.role === "processing");
    expect(processing?.transformVersion).toBe(NORMALIZE_TRANSFORM_VERSION);
  });

  it("prepare is idempotent (a crashed attempt's processing row is reused)", async () => {
    const actor = await seedActor(ctx, "d5prep2");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    await prepareNormalizationTransaction(tx(), job.jobKey);
    await prepareNormalizationTransaction(tx(), job.jobKey);
    const processing = ctx.db.rows("mediaRepresentations").filter((row) => row.role === "processing");
    expect(processing).toHaveLength(1);
  });

  it("audio attachments in the payload are skipped, never planned", async () => {
    const actor = await seedActor(ctx, "d5prep3");
    const seeded = await seedImage("one", { company: actor.companyId });
    const audioId = await ctx.db.insert("attachments", {
      uploadId: seeded.uploadId,
      sourceId: seeded.sourceId,
      kind: "audio",
      objectKey: "companies/x/uploads/a1",
      createdAtMs: 1,
    });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId, audioId]);
    const result = valueOf(await prepareNormalizationTransaction(tx(), job.jobKey));
    expect(result.attachments).toHaveLength(1);
    expect(result.skippedAudio).toEqual([audioId]);
  });

  it("tenancy is job-derived: an attachment of another company is a typed conflict", async () => {
    const actorA = await seedActor(ctx, "d5tena");
    const actorB = await seedActor(ctx, "d5tenb");
    const seededB = await seedImage("foreign", { company: actorB.companyId });
    // A job registered for company A whose payload names an attachment that
    // claims the job's source while its UPLOAD belongs to company B (the
    // corruption the second hop of the scoping chain defends against; the
    // source-binding hop alone would pass).
    const sourceA = await ctx.db.insert("sources", {
      companyId: actorA.companyId,
      authorUserId: "u-any",
      authorText: "a",
      sentAtMs: 1,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: 1,
      lifecycle: "active",
    });
    await ctx.db.patch(seededB.attachmentId, { sourceId: sourceA });
    const job = await seedJob(actorA.companyId, sourceA, [seededB.attachmentId]);
    const error = errorOf(await prepareNormalizationTransaction(tx(), job.jobKey));
    expect(error.code).toBe("attachment_outside_job_company");
  });
});

describe("record", () => {
  it("writes the UNVERIFIED retained and thumbnail rows with hashes, dimensions, bytes and content type", async () => {
    const actor = await seedActor(ctx, "d5rec");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "a".repeat(64), "b".repeat(64));
    const result = valueOf(
      await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome),
    );
    expect(result.deduplicated).toBe(false);
    const retained = ctx.db.rows("mediaRepresentations").find((row) => row.role === "retained");
    expect(retained?.contentHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(retained?.width).toBe(3024);
    expect(retained?.height).toBe(4032);
    expect(retained?.bytes).toBe(640);
    expect(retained?.mimeType).toBe("image/webp");
    expect(retained?.verifiedAtMs).toBeUndefined();
    // The in-progress row made way for its successor.
    expect(ctx.db.rows("mediaRepresentations").find((row) => row.role === "processing")).toBeUndefined();
  });

  it("record replays are idempotent (no second row, the original id returns)", async () => {
    const actor = await seedActor(ctx, "d5rec2");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "b".repeat(64), "c".repeat(64));
    const first = valueOf(
      await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome),
    );
    const second = valueOf(
      await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.representationId).toBe(first.representationId);
    expect(ctx.db.rows("mediaRepresentations").filter((row) => row.role === "retained")).toHaveLength(1);
  });

  it("the exception outcome writes the explicit retained-original row, verified and published", async () => {
    const actor = await seedActor(ctx, "d5rec3");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const result = valueOf(
      await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, {
        _tag: "exception",
        exceptionKind: "oversized_input",
      }),
    );
    expect(result.exception).toBe("oversized_input");
    const retained = ctx.db.rows("mediaRepresentations").find((row) => row.role === "retained");
    expect(retained?.transformVersion).toBe(RETAINED_ORIGINAL_TRANSFORM_VERSION);
    expect(retained?.objectKey).toBe(
      ctx.db.rows("attachments").find((row) => row._id === seeded.attachmentId)?.objectKey,
    );
    // The exception's archive IS the received bytes: the object key equals
    // the received representation's key.
    const received = ctx.db.rows("mediaRepresentations").find((row) => row.role === "received");
    expect(retained?.objectKey).toBe(received?.objectKey);
    expect(retained?.exceptionKind).toBe("oversized_input");
    expect(retained?.verifiedAtMs).toBeDefined();
    // Published as retained (the event E4/I3 consume).
    const published = ctx.db.rows("outboxEvents").filter((row) => row.eventName === "sources.representationRetained");
    expect(published).toHaveLength(1);
  });
});

describe("verify", () => {
  async function recordedFixture(label: string) {
    const actor = await seedActor(ctx, label);
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "c".repeat(64), "d".repeat(64));
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome);
    return { actor, seeded, job, outcome };
  }

  it("stamps verifiedAtMs on cross-checked evidence, publishes both events, allows cleanup", async () => {
    const { seeded, job, outcome } = await recordedFixture("d5ver");
    const result = valueOf(
      await verifyNormalizationTransaction(
        tx(),
        job.jobKey,
        seeded.attachmentId,
        evidenceFor(outcome),
        thumbEvidenceFor(outcome),
      ),
    );
    expect(result.deduplicated).toBe(false);
    expect(result.cleanupObjectKey).toBe(
      ctx.db.rows("mediaRepresentations").find((row) => row.role === "received")?.objectKey,
    );
    expect(
      ctx.db.rows("mediaRepresentations").filter((row) => row.verifiedAtMs !== undefined),
    ).toHaveLength(3);
    expect(
      ctx.db.rows("outboxEvents").filter((row) => row.eventName === "sources.representationRetained"),
    ).toHaveLength(2);
  });

  it("evidence that does not match the recorded row refuses typed, stamps nothing", async () => {
    const { seeded, job } = await recordedFixture("d5ver2");
    const error = errorOf(
      await verifyNormalizationTransaction(
        tx(),
        job.jobKey,
        seeded.attachmentId,
        { objectKey: "other", contentHash: "d".repeat(64), bytes: 1 },
        { objectKey: "other", contentHash: "e".repeat(64), bytes: 1 },
      ),
    );
    expect(error.code).toBe("verification_evidence_mismatch");
    expect(
      ctx.db.rows("mediaRepresentations").filter((row) => row.role === "retained" && row.verifiedAtMs !== undefined),
    ).toHaveLength(0);
  });

  it("verify refuses to schedule received cleanup while an extraction still references the received row", async () => {
    const { actor, seeded, job, outcome } = await recordedFixture("d5ver3");
    const received = ctx.db.rows("mediaRepresentations").find((row) => row.role === "received");
    await ctx.db.insert("extractions", {
      sourceId: seeded.sourceId,
      representationId: received?._id,
      kind: "vision",
      pipelineVersion: "test/1",
      model: "m",
      provider: "p",
      processingRunId: "k" + "r".repeat(23),
      createdAtMs: 1,
    });
    const result = valueOf(
      await verifyNormalizationTransaction(
        tx(),
        job.jobKey,
        seeded.attachmentId,
        evidenceFor(outcome),
        thumbEvidenceFor(outcome),
      ),
    );
    expect(result.cleanupObjectKey).toBeUndefined();
    expect(result.cleanupRefusalReason).toBe("received_referenced_by_extraction");
    void actor;
  });

  it("verify replays are idempotent (one event pair, the original decision)", async () => {
    const { seeded, job, outcome } = await recordedFixture("d5ver4");
    const first = valueOf(
      await verifyNormalizationTransaction(
        tx(),
        job.jobKey,
        seeded.attachmentId,
        evidenceFor(outcome),
        thumbEvidenceFor(outcome),
      ),
    );
    const second = valueOf(
      await verifyNormalizationTransaction(
        tx(),
        job.jobKey,
        seeded.attachmentId,
        evidenceFor(outcome),
        thumbEvidenceFor(outcome),
      ),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.cleanupObjectKey).toBe(first.cleanupObjectKey);
    expect(
      ctx.db.rows("outboxEvents").filter((row) => row.eventName === "sources.representationRetained"),
    ).toHaveLength(2);
  });
});

describe("cleanup", () => {
  async function verifiedFixture(label: string) {
    const actor = await seedActor(ctx, label);
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "f".repeat(64), "9".repeat(64));
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome);
    await verifyNormalizationTransaction(
      tx(),
      job.jobKey,
      seeded.attachmentId,
      evidenceFor(outcome),
      thumbEvidenceFor(outcome),
    );
    return { actor, seeded, job };
  }

  it("marks the received bytes removed after the verified pair exists", async () => {
    const { seeded, job } = await verifiedFixture("d5cln");
    const result = valueOf(await cleanupReceivedTransaction(tx(), job.jobKey, seeded.attachmentId));
    expect(result.removedAtMs).toBeGreaterThan(0);
    const received = ctx.db.rows("mediaRepresentations").find((row) => row.role === "received");
    expect(received?.removedAtMs).toBe(result.removedAtMs);
  });

  it("cleanup replays are idempotent (the original time returns)", async () => {
    const { seeded, job } = await verifiedFixture("d5cln2");
    const first = valueOf(await cleanupReceivedTransaction(tx(), job.jobKey, seeded.attachmentId));
    const second = valueOf(await cleanupReceivedTransaction(tx(), job.jobKey, seeded.attachmentId));
    expect(second.idempotent).toBe(true);
    expect(second.removedAtMs).toBe(first.removedAtMs);
  });

  it("cleanup without a verified retained pair is a typed refusal", async () => {
    const actor = await seedActor(ctx, "d5cln3");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const error = errorOf(await cleanupReceivedTransaction(tx(), job.jobKey, seeded.attachmentId));
    expect(error.code).toBe("received_cleanup_refused_retained_not_verified");
  });
});

describe("reconcile (observation-based) and the executor half", () => {
  it("completes the job when every image is terminal, without an external call", async () => {
    const actor = await seedActor(ctx, "d5rec4");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "1".repeat(64), "2".repeat(64));
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome);
    await verifyNormalizationTransaction(
      tx(),
      job.jobKey,
      seeded.attachmentId,
      evidenceFor(outcome),
      thumbEvidenceFor(outcome),
    );
    await cleanupReceivedTransaction(tx(), job.jobKey, seeded.attachmentId);
    const result = valueOf(await reconcileNormalizationTransaction(tx(), job.jobKey));
    expect(result.reconciled).toBe("completed");
    const jobRow = ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey);
    expect(jobRow?.state).toBe("succeeded");
    expect(jobRow?.externalOutcome).toBe("succeeded");
  });

  it("the exception outcome is terminal for reconcile too", async () => {
    const actor = await seedActor(ctx, "d5rec5");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, {
      _tag: "exception",
      exceptionKind: "unsupported_input",
    });
    const result = valueOf(await reconcileNormalizationTransaction(tx(), job.jobKey));
    expect(result.reconciled).toBe("completed");
    const jobRow = ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey);
    expect(jobRow?.state).toBe("succeeded");
  });

  it("verified-but-uncleaned work reports pending cleanup (the crash-after-verify window)", async () => {
    const actor = await seedActor(ctx, "d5rec6");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "2".repeat(64), "3".repeat(64));
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome);
    await verifyNormalizationTransaction(
      tx(),
      job.jobKey,
      seeded.attachmentId,
      evidenceFor(outcome),
      thumbEvidenceFor(outcome),
    );
    const result = valueOf(await reconcileNormalizationTransaction(tx(), job.jobKey));
    expect(result.reconciled).toBe("pending_cleanup");
    expect(result.pendingCleanup).toEqual([
      {
        attachmentId: seeded.attachmentId,
        objectKey: ctx.db.rows("attachments").find((row) => row._id === seeded.attachmentId)?.objectKey,
      },
    ]);
  });

  it("recorded-but-unverified work with attempts left re-queues (the crash-after-record window)", async () => {
    const actor = await seedActor(ctx, "d5rec7");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const outcome = normalizedOutcome(actor.companyId, seeded.attachmentId, "3".repeat(64), "4".repeat(64));
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, outcome);
    const result = valueOf(await reconcileNormalizationTransaction(tx(), job.jobKey));
    expect(result.reconciled).toBe("retrying");
    const jobRow = ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey);
    expect(jobRow?.state).toBe("queued");
    expect(ctx.scheduled.length).toBeGreaterThan(0);
  });

  it("exhausted attempts fail terminally", async () => {
    const actor = await seedActor(ctx, "d5rec8");
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const jobRow = ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey);
    await ctx.db.patch(jobRow!._id, { attempts: 3 });
    const result = valueOf(await reconcileNormalizationTransaction(tx(), job.jobKey));
    expect(result.reconciled).toBe("max_attempts");
    expect(ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey)?.state).toBe("failed");
  });

  it("the executor half succeeds without an external call for terminal or audio-only work", async () => {
    const actor = await seedActor(ctx, "d5half");
    const audioOnlySource = await ctx.db.insert("sources", {
      companyId: actor.companyId,
      authorUserId: "u-any",
      authorText: "a",
      sentAtMs: 1,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: 1,
      lifecycle: "active",
    });
    const audioJob = await seedJob(actor.companyId, audioOnlySource, []);
    expect(await executeNormalizationHalf(tx(), { jobKey: audioJob.jobKey })).toEqual({
      outcome: "succeeded",
    });
    const seeded = await seedImage("one", { company: actor.companyId });
    const freshJob = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    expect(await executeNormalizationHalf(tx(), { jobKey: freshJob.jobKey })).toEqual({
      outcome: "needs_external",
    });
  });
});

describe("the attempt outcome recording (echo-template semantics)", () => {
  async function jobFixture(label: string) {
    const actor = await seedActor(ctx, label);
    const seeded = await seedImage("one", { company: actor.companyId });
    const job = await seedJob(actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    await ctx.db.insert("outboxEvents", {
      eventId: `evt-${label}`,
      companyId: actor.companyId,
      eventName: "sources.sourceAccepted",
      envelopeJson: "{}",
      deliveryState: "in_flight",
      attempts: 0,
      nextAttemptAtMs: 1,
      dedupKey: `processing.normalize_photo:${job.sourceId}`,
      createdAtMs: 1,
    });
    return { job, sourceId: job.sourceId };
  }

  it("succeeded completes the job and delivers the outbox row", async () => {
    const { job } = await jobFixture("d5out1");
    const result = valueOf(await recordAttemptOutcomeTransaction(tx(), job.jobKey, "succeeded", false, ""));
    expect(result.state).toBe("succeeded");
    expect(ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey)?.externalOutcome).toBe("succeeded");
    expect(ctx.db.rows("outboxEvents")[0]?.deliveryState).toBe("delivered");
  });

  it("a definite failure with attempts left re-queues with backoff", async () => {
    const { job } = await jobFixture("d5out2");
    const result = valueOf(
      await recordAttemptOutcomeTransaction(tx(), job.jobKey, "failed", true, "unavailable:backend_unreachable"),
    );
    expect(result.state).toBe("queued");
    expect(ctx.scheduled.length).toBeGreaterThan(0);
  });

  it("an uncertain timeout NEVER auto-retries (reconciliation owns the next move)", async () => {
    const { job } = await jobFixture("d5out3");
    const result = valueOf(
      await recordAttemptOutcomeTransaction(tx(), job.jobKey, "timeout", false, "images_executor_deadline_exceeded"),
    );
    expect(result.state).toBe("failed");
    const jobRow = ctx.db.rows("durableJobs").find((row) => row.jobKey === job.jobKey);
    expect(jobRow?.externalOutcome).toBe("timeout");
    expect(ctx.scheduled).toHaveLength(0);
  });
});
