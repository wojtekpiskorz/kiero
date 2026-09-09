/**
 * D2 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the D1 probes; shared plumbing in
 * ../probe_shared.ts).
 *
 * No business work happens here; these entries exist so the D2 evidence can
 * run against the REAL dev deployment and the REAL Worker/R2 path without a
 * development-auth shortcut: every actor is the service account's own
 * session or an explicitly seeded second-company session, resolved through
 * the SAME canonical resolution and authorization seam as production calls.
 * Sessions are created server-side here; no identity is ever accepted from
 * client input.
 *
 * - `probeRunStep`: dispatches one uploads-channel step envelope through the
 *   checked step path as the service identity (or a seeded session) — used
 *   for typed-rejection, cross-tenant and revocation proofs.
 * - `probeSeedIsolation`: idempotent second-company fixture (user, active
 *   membership, live session) for tenant isolation proofs.
 * - `probeRevokeSession` / `probeSuspendMembership`: server-side state
 *   changes proving revoked sessions/memberships cannot dispatch steps.
 * - `probeAgeUpload`: fixture control for the reconciliation grace proofs —
 *   moves one upload's timestamps into the past by an exact offset.
 * - `probeUploadsState`: the tenant-scoped ledger inspection the evidence
 *   script asserts on (uploads, attachments, representations).
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError } from "@kiero/runtime";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

/** The D2 tenant-isolation fixture identity (seeded server-side below). */
const D2_ISOLATION_EMAIL = "d2-isolation@kiero.invalid";
const D2_ISOLATION_COMPANY = "Kiero Dev Proof B (D2 uploads)";

/**
 * One isolation tenant per proof run: the revocation proofs (session,
 * membership) permanently disable their fixture, so a fresh suffix keeps
 * later runs independent instead of resurrecting revoked state.
 */
const isolationEmail = (suffix: string): string =>
  suffix === "" ? D2_ISOLATION_EMAIL : `d2-isolation-${suffix}@kiero.invalid`;
const isolationCompany = (suffix: string): string =>
  suffix === "" ? D2_ISOLATION_COMPANY : `Kiero Dev Proof B (D2 uploads ${suffix})`;

// --- step dispatch ---------------------------------------------------------------

/** Dispatches one uploads step envelope as a verified session (guarded). */
export const probeRunStep = action({
  args: { step: v.string(), input: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.sources.uploads.commands.stepTransaction, {
      envelope: { step: args.step, input: args.input ?? {} },
      serviceSessionId: sessionId,
    });
  },
});

// --- fixtures --------------------------------------------------------------------

/**
 * Ensures the D2 second-company fixture: user, company, active membership
 * and a live session — no upload rows (the isolation proofs prepare their
 * own drafts through the checked step path).
 */
export const seedIsolation = internalMutation({
  args: { suffix: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const email = isolationEmail(args.suffix ?? "");
    const companyName = isolationCompany(args.suffix ?? "");
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", {
        email,
        displayName: "D2 isolation proof",
        createdAtMs: Date.now(),
      }));
    const existingCompany = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("name"), companyName))
      .first();
    const companyId =
      existingCompany?._id ??
      (await ctx.db.insert("companies", {
        name: companyName,
        timezone: "Europe/Warsaw",
        defaultCurrency: "PLN",
        createdAtMs: Date.now(),
      }));
    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
      .first();
    let membershipId = existingMembership === null ? undefined : existingMembership._id;
    if (existingMembership === null) {
      membershipId = await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "admin",
        state: "active",
        createdAtMs: Date.now(),
      });
    }
    const existingSession = await ctx.db
      .query("sessions")
      .withIndex("by_user_started", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
      .first();
    const sessionId =
      existingSession?._id ??
      (await ctx.db.insert("sessions", {
        userId,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: "d2-isolation-bridge",
      }));
    return okResult({ companyId, userId, membershipId, sessionId});
  },
});

export const probeSeedIsolation = action({
  args: { suffix: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.uploads.probe.seedIsolation, {
      ...(args.suffix === undefined ? {} : { suffix: args.suffix }),
    });
  },
});

/** Revokes one session server-side (proof: revoked sessions cannot dispatch). */
export const revokeSession = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("sessions", args.sessionId);
    if (id === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    await ctx.db.patch(id, { revokedAtMs: Date.now() });
    return okResult({ revoked: true });
  },
});

export const probeRevokeSession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.uploads.probe.revokeSession, {
      sessionId: args.sessionId,
    });
  },
});

/** Revokes one membership server-side (proof: no step without active membership). */
export const revokeMembership = internalMutation({
  args: { membershipId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("memberships", args.membershipId);
    if (id === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    await ctx.db.patch(id, { state: "revoked" });
    return okResult({ revoked: true });
  },
});

export const probeRevokeMembership = action({
  args: { membershipId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.uploads.probe.revokeMembership, {
      membershipId: args.membershipId,
    });
  },
});

// --- reconciliation fixture control ------------------------------------------------

/**
 * Ages one service-company upload by an exact offset: createdAtMs,
 * lastActivityAtMs and finalizedAtMs each move back by `ageMs`. This is the
 * ONLY way the grace proofs reach expired states without waiting days; the
 * reconciliation decision itself is pure (protocol.ts) and unit-tested.
 */
export const ageUpload = internalMutation({
  args: { uploadId: v.string(), ageMs: v.float64() },
  handler: async (ctx, args) => {
    const context = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const uploadId = ctx.db.normalizeId("uploads", args.uploadId);
    if (uploadId === null) {
      return errorResult(forbiddenError("upload_reference_not_found"));
    }
    const upload = await ctx.db.get(uploadId);
    if (upload === null || upload.companyId !== ctx.db.normalizeId("companies", context.actor.companyId)) {
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

/** Tenant-scoped ledger state for the evidence script (guarded read). */
export const uploadsInspection = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const context = await resolveRequestContext(ctx.db, bridgeIdentity(args.serviceSessionId, Date.now()));
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
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
    return okResult({
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
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.uploads.probe.uploadsInspection, {
      serviceSessionId: sessionId,
    });
  },
});
