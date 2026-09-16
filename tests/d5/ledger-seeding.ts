/**
 * The D5 seeding helpers (R24 extraction from ledger.test.ts, the shared-
 * helpers ledger follow-up): one accepted image attachment with its verified
 * received representation, and one running normalization job. Later lanes
 * touching ledger.test.ts swap its private copies for these.
 */

import type { FakeCtx } from "../d2/harness";

/** Seeds one accepted image attachment + its verified received representation. */
export async function seedImageOn(
  ctx: FakeCtx,
  label: string,
  options?: { readonly company?: string },
) {
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

/** Seeds one running normalization job for the given source. */
export async function seedJobOn(
  ctx: FakeCtx,
  companyId: string,
  sourceId: string,
  attachmentIds: string[],
) {
  const jobKey = `job_${sourceId}_dims`;
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
