/**
 * D5 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the D1/D2 probes; shared plumbing in
 * convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the D5 evidence can
 * run against the REAL dev deployment, the REAL Worker/R2 path and the REAL
 * normalizer. Every inspection entry resolves the CALLER's identity from
 * that caller's own verified Convex Auth credential (the proof script signs
 * in real fixture persons, B1's email-code flow — the B3/D2 evidence
 * pattern) and scopes every row to the caller's company: a person of
 * company B reading company A's attachment is the cross-tenant denial
 * proof. No identity is ever accepted from client input and the service
 * account is never substituted.
 *
 * - `probeImagesState`: the caller's tenant-scoped normalization state
 *   (image attachments, every representation row with the deterministic
 *   retained selection, and the company's normalize jobs).
 * - `probeAttachmentState`: one attachment's rows, denied typed when the
 *   attachment's upload belongs to another company (the direct
 *   cross-tenant denial).
 * - `probeDriveNormalization`: runs the executor's ONE bounded HTTP call
 *   (the production `callImagesExecutor`) against the configured images
 *   executor, optionally with the crash-window stop, and records the
 *   outcome through the same mutation the scheduled action uses. Only jobs
 *   of the caller's company.
 * - `probeRequeueNormalization`: re-queues one of the caller's company's
 *   normalize jobs through the platform executor entry (the replay-dedup
 *   proof re-enters through the real durable machinery).
 * - `probeReconcileNormalization`: the observation-based reconciliation for
 *   one of the caller's company's jobs.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { probeDisabled, probeGuardEnabled } from "../../sources/probe_shared";
import {
  callImagesExecutor,
} from "./executor";
import { recordAttemptOutcomeTransaction } from "./ledger";
import { decideRetainedSelection, type RepresentationView } from "./protocol";
import { reconcileNormalizationTransaction } from "./ledger";

/** The read surface the caller resolution needs (query and mutation ctx both fit). */
type CallerDb = Parameters<typeof resolveAccessContextFromConvexAuth>[0];
/** The auth surface the caller resolution needs (any Convex ctx fits). */
type CallerAuth = Parameters<typeof resolveAccessContextFromConvexAuth>[1];

async function callerCompanyIdOrRefuse(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; companyId: Id<"companies"> }
  | { ok: false; result: ResultEnvelope }
> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { ok: false, result: errorResult(unauthenticatedError()) };
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { ok: false, result: errorResult(forbiddenError("company_scope_unresolved")) };
  }
  return { ok: true, companyId };
}

/** The representation rows of one attachment as the pure views read. */
async function representationsOfAttachment(
  db: CallerDb,
  attachmentId: Id<"attachments">,
): Promise<RepresentationView[]> {
  const rows = await db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  return rows.map((row) => ({
    _id: row._id,
    attachmentId: row.attachmentId,
    role: row.role,
    objectKey: row.objectKey,
    contentHash: row.contentHash,
    transformVersion: row.transformVersion,
    ...(row.verifiedAtMs === undefined ? {} : { verifiedAtMs: row.verifiedAtMs }),
    ...(row.removedAtMs === undefined ? {} : { removedAtMs: row.removedAtMs }),
    ...(row.exceptionKind === undefined ? {} : { exceptionKind: row.exceptionKind }),
    ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
    ...(row.width === undefined ? {} : { width: row.width }),
    ...(row.height === undefined ? {} : { height: row.height }),
    ...(row.mimeType === undefined ? {} : { mimeType: row.mimeType }),
  }));
}

/** Loads a normalize job and refuses unless it belongs to the company. */
async function companyJobOrRefuse(
  db: CallerDb,
  companyId: Id<"companies">,
  jobKey: string,
): Promise<
  | {
      ok: true;
      job: {
        _id: Id<"durableJobs">;
        jobKey: string;
        state: string;
        attempts: number;
        maxAttempts: number;
        lastErrorKind?: string | undefined;
        externalOutcome?: string | undefined;
      };
    }
  | { ok: false; result: ResultEnvelope }
> {
  const job = await db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
    .first();
  if (
    job === null ||
    job.kind !== "processing.normalize_photo" ||
    job.companyId === undefined ||
    job.companyId !== companyId
  ) {
    return { ok: false, result: errorResult(forbiddenError("normalization_job_not_found")) };
  }
  return {
    ok: true,
    job: {
      _id: job._id,
      jobKey: job.jobKey,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      ...(job.lastErrorKind === undefined ? {} : { lastErrorKind: job.lastErrorKind }),
      ...(job.externalOutcome === undefined ? {} : { externalOutcome: job.externalOutcome }),
    },
  };
}

// --- inspection ---------------------------------------------------------------------

/** The caller's tenant-scoped normalization inspection (internal mutation body). */
async function inspectionBody(db: CallerDb, auth: CallerAuth): Promise<ResultEnvelope> {
  const resolved = await callerCompanyIdOrRefuse(db, auth);
  if (!resolved.ok) {
    return resolved.result;
  }
  const companyId = resolved.companyId;
  // The company's attachments through its uploads (the attachments table has
  // no company column; the upload is the tenancy root).
  const uploads = await db
    .query("uploads")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .collect();
  const imageAttachments: unknown[] = [];
  for (const upload of uploads) {
    const rows = await db
      .query("attachments")
      .withIndex("by_upload", (q) => q.eq("uploadId", upload._id))
      .collect();
    for (const row of rows) {
      if (row.kind !== "image") {
        continue;
      }
      const representations = await representationsOfAttachment(db, row._id);
      const selection = decideRetainedSelection(representations);
      imageAttachments.push({
        attachmentId: row._id,
        uploadId: upload._id,
        ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
        objectKey: row.objectKey,
        ...(row.receivedBytes === undefined ? {} : { receivedBytes: row.receivedBytes }),
        representations: representations.map((view) => ({
          representationId: view._id,
          role: view.role,
          objectKey: view.objectKey,
          transformVersion: view.transformVersion,
          ...(view.verifiedAtMs === undefined ? {} : { verifiedAtMs: view.verifiedAtMs }),
          ...(view.removedAtMs === undefined ? {} : { removedAtMs: view.removedAtMs }),
          ...(view.exceptionKind === undefined ? {} : { exceptionKind: view.exceptionKind }),
          ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
          ...(view.width === undefined ? {} : { width: view.width }),
          ...(view.height === undefined ? {} : { height: view.height }),
          ...(view.mimeType === undefined ? {} : { mimeType: view.mimeType }),
        })),
        ...(selection === null
          ? { retainedSelection: null }
          : {
              retainedSelection: {
                representationId: selection._id,
                objectKey: selection.objectKey,
                transformVersion: selection.transformVersion,
                ...(selection.width === undefined ? {} : { width: selection.width }),
                ...(selection.height === undefined ? {} : { height: selection.height }),
                ...(selection.exceptionKind === undefined ? {} : { exceptionKind: selection.exceptionKind }),
              },
            }),
      });
    }
  }
  const jobs = await db
    .query("durableJobs")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect();
  return okResult({
    attachments: imageAttachments,
    normalizeJobs: jobs
      .filter((job) => job.kind === "processing.normalize_photo")
      .map((job) => ({
        jobKey: job.jobKey,
        state: job.state,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        ...(job.dedupKey === undefined ? {} : { dedupKey: job.dedupKey }),
        ...(job.lastErrorKind === undefined ? {} : { lastErrorKind: job.lastErrorKind }),
        ...(job.externalOutcome === undefined ? {} : { externalOutcome: job.externalOutcome }),
      })),
  });
}

/** The internal mutation wrapper the guarded action calls (query body needs ctx.db+ctx.auth). */
export const imagesStateFor = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => inspectionBody(ctx.db, ctx.auth),
});

export const probeImagesState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.images.probe.imagesStateFor, {});
  },
});

/** One attachment's rows, denied typed across tenants. */
async function attachmentStateBody(
  db: CallerDb,
  auth: CallerAuth,
  attachmentIdValue: string,
): Promise<ResultEnvelope> {
  const resolved = await callerCompanyIdOrRefuse(db, auth);
  if (!resolved.ok) {
    return resolved.result;
  }
  const attachmentId = db.normalizeId("attachments", attachmentIdValue);
  if (attachmentId === null) {
    return errorResult(forbiddenError("attachment_reference_not_found"));
  }
  const attachment = await db.get(attachmentId);
  if (attachment === null) {
    return errorResult(forbiddenError("attachment_reference_not_found"));
  }
  // THE cross-tenant denial: the tenancy root (the upload) must belong to
  // the caller's company, independent of any client-supplied scope.
  const upload = await db.get(attachment.uploadId);
  if (upload === null || upload.companyId !== resolved.companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "attachments"));
  }
  const representations = await representationsOfAttachment(db, attachmentId);
  const selection = decideRetainedSelection(representations);
  return okResult({
    attachmentId,
    uploadId: attachment.uploadId,
    ...(attachment.sourceId === undefined ? {} : { sourceId: attachment.sourceId }),
    objectKey: attachment.objectKey,
    representations,
    retainedSelection: selection,
  });
}

export const attachmentStateFor = internalMutation({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    attachmentStateBody(ctx.db, ctx.auth, args.attachmentId),
});

export const probeAttachmentState = action({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.images.probe.attachmentStateFor, {
      attachmentId: args.attachmentId,
    });
  },
});

// --- the durable drive, requeue and reconcile (proof entries) ------------------------

/** The tenancy + fixture-control half of the proof drive (mutation). */
export const drivePrepare = internalMutation({
  args: {
    jobKey: v.string(),
    /** Proof-only fixture control: enter the running state before driving. */
    forceRunning: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyIdOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const job = await companyJobOrRefuse(ctx.db, resolved.companyId, args.jobKey);
    if (!job.ok) {
      return job.result;
    }
    if (args.forceRunning === true && job.job.state !== "running") {
      // Fixture control (the probeAgeUpload pattern): the crash-window
      // proofs stop the scheduled machinery first, which leaves the job
      // outside `running`; the drive itself re-enters the real state.
      await ctx.db.patch(job.job._id, {
        state: "running",
        externalOutcome: undefined,
        finishedAtMs: undefined,
        updatedAtMs: Date.now(),
      });
    }
    return okResult({ jobKey: args.jobKey });
  },
});

/** The outcome-recording half of the proof drive (mutation). */
export const driveRecord = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.string(),
    retryable: v.boolean(),
    errorKind: v.string(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyIdOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const job = await companyJobOrRefuse(ctx.db, resolved.companyId, args.jobKey);
    if (!job.ok) {
      return job.result;
    }
    const outcome =
      args.outcome === "succeeded" || args.outcome === "failed" || args.outcome === "timeout" || args.outcome === "unknown"
        ? args.outcome
        : "unknown";
    await recordAttemptOutcomeTransaction(ctx, args.jobKey, outcome, args.retryable, args.errorKind);
    return okResult({ jobKey: args.jobKey });
  },
});

/** Runs the executor's production HTTP call (optionally crash-stopped). */
export const driveNormalization = action({
  args: {
    jobKey: v.string(),
    crashAfter: v.optional(v.string()),
    /** Proof-only: exercise the real gateway while the scheduled URL is dead. */
    executorUrl: v.optional(v.string()),
    /** Proof-only fixture control: enter the running state before driving. */
    forceRunning: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    // The tenancy/fixture half must be transactional; the HTTP call itself
    // runs in the ACTION (like the scheduled executor action: external
    // calls with deadlines never run inside a mutation).
    const prepared = await ctx.runMutation(internal.processing.images.probe.drivePrepare, {
      jobKey: args.jobKey,
      ...(args.forceRunning === undefined ? {} : { forceRunning: args.forceRunning }),
    });
    if (prepared?._tag === "error") {
      return prepared;
    }
    const crashAfter =
      args.crashAfter === "record" || args.crashAfter === "verify" ? args.crashAfter : undefined;
    const classification = await callImagesExecutor(
      args.jobKey,
      crashAfter,
      args.executorUrl === undefined || args.executorUrl === "" ? undefined : args.executorUrl,
    );
    await ctx.runMutation(internal.processing.images.probe.driveRecord, {
      jobKey: args.jobKey,
      outcome: classification.kind,
      retryable: classification.kind === "failed" ? classification.retryable : false,
      errorKind: classification.kind === "succeeded" ? "" : classification.errorKind,
    });
    return okResult({
      jobKey: args.jobKey,
      classification: {
        kind: classification.kind,
        ...(classification.kind === "succeeded" ? {} : { errorKind: classification.errorKind }),
        ...(classification.kind === "failed" ? { retryable: classification.retryable } : {}),
      },
    });
  },
});

export const probeDriveNormalization = driveNormalization;

/** Re-queues one of the caller's jobs through the platform executor entry. */
export const requeueNormalization = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyIdOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const job = await companyJobOrRefuse(ctx.db, resolved.companyId, args.jobKey);
    if (!job.ok) {
      return job.result;
    }
    if (job.job.state === "running") {
      return errorResult(forbiddenError("job_currently_running"));
    }
    await ctx.db.patch(job.job._id, { state: "queued", updatedAtMs: Date.now() });
    await ctx.scheduler.runAfter(0, internal.platform.jobs.runDurableJob, {
      jobKey: args.jobKey,
    });
    return okResult({ jobKey: args.jobKey, requeued: true });
  },
});

export const probeRequeueNormalization = action({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.images.probe.requeueNormalization, {
      jobKey: args.jobKey,
    });
  },
});

/** The observation-based reconciliation for one of the caller's jobs. */
export const reconcileFor = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyIdOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const job = await companyJobOrRefuse(ctx.db, resolved.companyId, args.jobKey);
    if (!job.ok) {
      return job.result;
    }
    return reconcileNormalizationTransaction(ctx, args.jobKey);
  },
});

export const probeReconcileNormalization = action({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.images.probe.reconcileFor, {
      jobKey: args.jobKey,
    });
  },
});
