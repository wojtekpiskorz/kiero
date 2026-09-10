/**
 * D2 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the D1 probes; shared plumbing in
 * ../probe_shared.ts).
 *
 * No business work happens here; these entries exist so the D2 evidence can
 * run against the REAL dev deployment and the REAL Worker/R2 path. Every
 * entry resolves the CALLER's identity from that caller's own verified
 * Convex Auth credential (the proof script signs in real fixture persons,
 * B1's email-code flow with fixture codes — the same pattern as the B3
 * evidence): the credential propagates from the authenticated action into
 * the internal mutation/query, and the SAME canonical resolution and
 * authorization seam decides. No identity is ever accepted from client
 * input and the service account is never substituted.
 *
 * - `probeRunStep`: dispatches one uploads-channel step envelope through
 *   the checked step path AS THE CALLER — used for typed-rejection and
 *   cross-identity proofs that need the raw step envelope.
 * - `probeAcceptSourceAsCaller`: runs D1's UNCHANGED acceptance transaction
 *   with the caller's honestly re-resolved context. This exists because
 *   D1's public accept entry predates B1's identity source (its dispatch
 *   still reads the pre-B1 `identityFromConvexAuth` seam, which cannot
 *   resolve Convex Auth subjects) — the acting principal here is the real
 *   signed-in user, never the service account. Flagged to the coordinator:
 *   D1's dispatch adopting `resolveAccessContextWithProvisioning` retires
 *   this probe in favor of the certified client command.
 * - `probeAgeUpload`: fixture control for the reconciliation grace proofs —
 *   moves one of the caller's company's uploads into the past by an exact
 *   offset.
 * - `probeUploadsState`: the caller's tenant-scoped ledger inspection the
 *   evidence script asserts on (uploads, attachments, representations,
 *   accepted sources and their durable jobs — D1's own inspection probe
 *   still resolves the service session, which is NOT the acting user
 *   here).
 *
 * Revocation and tenant-isolation fixtures live in their OWNING lanes'
 * certified surfaces (B1's `access.revokeSession`, B3's
 * `access.revokeMembership`, real invitations): the evidence drives them
 * as real commands, not through server-side state edits here.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { CommandEnvelope, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextFromConvexAuth,
  resolveAccessContextWithProvisioning,
} from "../../access/identity/resolution";
import { performAcceptance, acceptSourceEntry } from "../accept/acceptance";
import { probeDisabled, probeGuardEnabled } from "../probe_shared";

/** The read surface the caller resolution needs (query and mutation ctx both fit). */
type CallerDb = Parameters<typeof resolveAccessContextFromConvexAuth>[0];
/** The auth surface the caller resolution needs (any Convex ctx fits). */
type CallerAuth = Parameters<typeof resolveAccessContextFromConvexAuth>[1];

/** Resolves the caller's read-side context, or the sanitized refusal. */
async function callerContextOrRefuse(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; context: NonNullable<Awaited<ReturnType<typeof resolveAccessContextFromConvexAuth>>> }
  | { ok: false; result: ResultEnvelope }
> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { ok: false, result: errorResult(unauthenticatedError()) };
  }
  return { ok: true, context };
}

// --- step dispatch ---------------------------------------------------------------

/** Dispatches one uploads step envelope as the CALLER (guarded). */
export const probeRunStep = action({
  args: { step: v.string(), input: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.uploads.commands.stepTransaction, {
      envelope: { step: args.step, input: args.input ?? {} },
    });
  },
});

// --- acceptance as the caller ------------------------------------------------------

/**
 * D1's acceptance transaction with the caller's honestly re-resolved
 * context (see the module docstring for why this exists).
 */
export const acceptSourceAsCaller = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    let commandValue: typeof CommandEnvelope.Type;
    try {
      commandValue = Schema.decodeUnknownSync(CommandEnvelope)(args.envelope);
    } catch {
      return errorResult(forbiddenError("probe_malformed_envelope"));
    }
    const context = await resolveAccessContextWithProvisioning(
      ctx.db,
      ctx.auth,
      Date.now(),
      DEFAULT_DEVICE_LABEL,
    );
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    let inputValue: typeof acceptSourceEntry.input.Type;
    try {
      inputValue = Schema.decodeUnknownSync(acceptSourceEntry.input)(commandValue.input);
    } catch {
      return errorResult(forbiddenError("probe_malformed_input"));
    }
    return performAcceptance(ctx, context, inputValue, commandValue.idempotencyKey);
  },
});

/** Runs the crash-proof acceptance as the CALLER (guarded wrapper). */
export const probeCrashAcceptSourceAsCaller = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    let commandValue: typeof CommandEnvelope.Type;
    try {
      commandValue = Schema.decodeUnknownSync(CommandEnvelope)(args.envelope);
    } catch {
      return errorResult(forbiddenError("probe_malformed_envelope"));
    }
    const context = await resolveAccessContextWithProvisioning(
      ctx.db,
      ctx.auth,
      Date.now(),
      DEFAULT_DEVICE_LABEL,
    );
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    let inputValue: typeof acceptSourceEntry.input.Type;
    try {
      inputValue = Schema.decodeUnknownSync(acceptSourceEntry.input)(commandValue.input);
    } catch {
      return errorResult(forbiddenError("probe_malformed_input"));
    }
    const result = await performAcceptance(ctx, context, inputValue, commandValue.idempotencyKey);
    if (result._tag === "error") {
      return result;
    }
    // Registration happened inside THIS transaction; throwing aborts it all.
    throw new Error("probe: deliberate failure after acceptance registration");
  },
});

export const probeAcceptSourceAsCaller = action({
  args: { envelope: v.any(), crash: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(
      args.crash === true
        ? internal.sources.uploads.probe.probeCrashAcceptSourceAsCaller
        : internal.sources.uploads.probe.acceptSourceAsCaller,
      { envelope: args.envelope },
    );
  },
});

// --- reconciliation fixture control ------------------------------------------------

/**
 * Ages one of the caller's company's uploads by an exact offset:
 * createdAtMs, lastActivityAtMs and finalizedAtMs each move back by
 * `ageMs`. This is the ONLY way the grace proofs reach expired states
 * without waiting days; the reconciliation decision itself is pure
 * (protocol.ts) and unit-tested.
 */
export const ageUpload = internalMutation({
  args: { uploadId: v.string(), ageMs: v.float64() },
  handler: async (ctx, args) => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    const uploadId = ctx.db.normalizeId("uploads", args.uploadId);
    if (companyId === null || uploadId === null) {
      return errorResult(forbiddenError("upload_reference_not_found"));
    }
    const upload = await ctx.db.get(uploadId);
    if (upload === null || upload.companyId !== companyId) {
      return errorResult(forbiddenError("upload_reference_not_found"));
    }
    const shift = (value: number): number => value - args.ageMs;
    await ctx.db.patch(uploadId, {
      createdAtMs: shift(upload.createdAtMs),
      ...(upload.lastActivityAtMs === undefined
        ? {}
        : { lastActivityAtMs: shift(upload.lastActivityAtMs) }),
      ...(upload.finalizedAtMs === undefined ? {} : { finalizedAtMs: shift(upload.finalizedAtMs) }),
    });
    return okResult({ aged: true, ageMs: args.ageMs });
  },
});

export const probeAgeUpload = action({
  args: { uploadId: v.string(), ageMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.uploads.probe.ageUpload, {
      uploadId: args.uploadId,
      ageMs: args.ageMs,
    });
  },
});

// --- inspection --------------------------------------------------------------------

/** The caller's tenant-scoped ledger state (guarded read). */
export const uploadsInspection = internalQuery({
  args: {},
  handler: async (ctx) => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
      .collect();
    const attachments = [];
    for (const upload of uploads) {
      const rows = await ctx.db
        .query("attachments")
        .withIndex("by_upload", (q) => q.eq("uploadId", upload._id))
        .collect();
      for (const row of rows) {
        const received = await ctx.db
          .query("mediaRepresentations")
          .withIndex("by_attachment_role", (q) =>
            q.eq("attachmentId", row._id).eq("role", "received"),
          )
          .first();
        attachments.push({
          attachmentId: row._id,
          uploadId: row.uploadId,
          kind: row.kind,
          objectKey: row.objectKey,
          ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
          ...(row.completedAtMs === undefined ? {} : { completedAtMs: row.completedAtMs }),
          ...(row.r2ObjectEtag === undefined ? {} : { r2ObjectEtag: row.r2ObjectEtag }),
          ...(row.receivedBytes === undefined ? {} : { receivedBytes: row.receivedBytes }),
          partsRecorded: row.partsJson === undefined ? 0 : (JSON.parse(row.partsJson) as unknown[]).length,
          representationVerifiedAtMs: received?.verifiedAtMs,
        });
      }
    }
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
      .collect();
    const jobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      sources: sources.map((source) => ({
        sourceId: source._id,
        ...(source.acceptanceKey === undefined ? {} : { acceptanceKey: source.acceptanceKey }),
        fullyAcceptedAtMs: source.fullyAcceptedAtMs,
        lifecycle: source.lifecycle,
      })),
      jobs: jobs.map((job) => ({
        jobKey: job.jobKey,
        kind: job.kind,
        state: job.state,
        ...(job.dedupKey === undefined ? {} : { dedupKey: job.dedupKey }),
      })),
      uploads: uploads.map((upload) => ({
        uploadId: upload._id,
        stage: upload.stage,
        ...(upload.draftId === undefined ? {} : { draftId: upload.draftId }),
        ...(upload.attachmentCount === undefined ? {} : { attachmentCount: upload.attachmentCount }),
        ...(upload.declaredParts === undefined ? {} : { declaredParts: upload.declaredParts }),
        ...(upload.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: upload.lastActivityAtMs }),
        ...(upload.finalizedAtMs === undefined ? {} : { finalizedAtMs: upload.finalizedAtMs }),
        ...(upload.acceptedSourceId === undefined ? {} : { acceptedSourceId: upload.acceptedSourceId }),
        ...(upload.orphanReason === undefined ? {} : { orphanReason: upload.orphanReason }),
      })),
      attachments,
    });
  },
});

export const probeUploadsState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.sources.uploads.probe.uploadsInspection, {});
  },
});
