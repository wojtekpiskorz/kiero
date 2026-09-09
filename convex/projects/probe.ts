/**
 * Guarded C1 proof fixtures (dev deployment only).
 *
 * Same pattern as the A3/B1/B3 probes: an ACTION checks the deployment
 * guard variable (`KIERO_C1_PROOF_ENABLED === "1"`) and runs internal
 * mutations reachable only from this module. On a production deployment the
 * guard variable is absent and every entry fails closed.
 *
 * `c1ProofCompanyProjects` is the tenant-scoped inspection read the live
 * evidence asserts on: raw projects, retained alias rows, contacts, role
 * rows, D1 source-link rows and the company's published `projects.*` outbox
 * events (stable ids and preserved history after closure/reopen). It reads
 * only; the proof writes exclusively through the checked dispatch.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";

function guardEnabled(): boolean {
  return process.env.KIERO_C1_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("projects.c1Proof", "proof_guard_disabled"));
}

export const companyProjectsInternal = internalMutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", args.companyId))
      .collect();
    const aliases = await ctx.db
      .query("projectAliases")
      .withIndex("by_company_codename", (q) => q.eq("companyId", args.companyId))
      .collect();
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const roles = await ctx.db
      .query("contactRoles")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const projectIds = new Set(projects.map((row) => row._id));
    const sourceLinks = [];
    for (const projectId of projectIds) {
      const rows = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_project_source", (q) => q.eq("projectId", projectId))
        .collect();
      for (const row of rows) {
        sourceLinks.push({ projectId, sourceId: row.sourceId });
      }
    }
    const outbox = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const projectEvents = outbox
      .filter((row) => row.eventName.startsWith("projects."))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((row) => ({
        eventId: row.eventId,
        eventName: row.eventName,
        deliveryState: row.deliveryState,
        dedupKey: row.dedupKey ?? null,
        occurredAt: JSON.parse(row.envelopeJson).occurredAt,
        payload: JSON.parse(row.envelopeJson).payload,
      }));

    const byTime = <T>(rows: readonly T[], time: (row: T) => number): T[] =>
      rows.slice().sort((a, b) => time(a) - time(b));

    return okResult({
      projects: byTime(projects, (row) => row.createdAtMs).map((row) => ({
        projectId: row._id,
        displayName: row.displayName,
        stage: row.stage,
        stageRevision: row.stageRevision,
        paused: row.paused ?? null,
        clientId: row.clientId ?? null,
        closedAtMs: row.closedAtMs ?? null,
        createdAtMs: row.createdAtMs,
      })),
      aliases: byTime(aliases, (row) => row.assignedAtMs).map((row) => ({
        aliasId: row._id,
        projectId: row.projectId,
        codename: row.codename,
        active: row.active,
        assignedAtMs: row.assignedAtMs,
        retiredAtMs: row.retiredAtMs ?? null,
      })),
      contacts: byTime(contacts, (row) => row.createdAtMs).map((row) => ({
        contactId: row._id,
        kind: row.kind,
        displayName: row.displayName,
      })),
      roles: byTime(roles, (row) => row.createdAtMs).map((row) => ({
        contactRoleId: row._id,
        projectId: row.projectId,
        contactId: row.contactId,
        role: row.role,
      })),
      sourceLinks,
      projectEvents,
    });
  },
});

/** Inspects one company's projects state and retained history (guarded). */
export const c1ProofCompanyProjects = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.projects.probe.companyProjectsInternal, {
      companyId: args.companyId,
    });
  },
});

export const seedDraftUploadInternal = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    // The session id comes only from this guarded module's callers; the row
    // belongs to whoever that live session resolves to (proof persons),
    // through the SAME canonical chain the checked dispatch uses.
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.sessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(unsupportedError("projects.c1Proof", "no_live_session"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return errorResult(unsupportedError("projects.c1Proof", "no_live_session"));
    }
    const uploadId = await ctx.db.insert("uploads", {
      companyId,
      userId,
      stage: "draft",
      partCount: 0,
      createdAtMs: Date.now(),
    });
    return okResult({ uploadId });
  },
});

/**
 * Seeds one draft upload for the proof person's live session (guarded), so
 * the live evidence can drive D1's REAL `sources.acceptSource` against a
 * C1-identified project (the source-link half of the closure proof). The
 * row shape mirrors D1's own guarded seeding exactly.
 */
export const c1ProofSeedDraftUpload = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.projects.probe.seedDraftUploadInternal, {
      sessionId: args.sessionId,
    });
  },
});

// --- sign-in code fixture (lease workaround, guarded like B1's own) ---------
//
// B1's `b1ProofSetCode` fixture lives in an UNCHANGED module whose deployed
// bundle on this shared lease predates the deployment's proof-guard
// variables, so it keeps answering `proof_guard_disabled` (Convex snapshots
// env vars into the bundle at push time; only content-changed modules
// re-bundle). This lane's probe module is freshly pushed, so the SAME
// fixture — proof-domain addresses only, hashed exactly like the library
// hashes codes — is offered here for C1's live evidence. The REAL issuance
// and the REAL verification still run through B1's library path.

const OTP_MAX_AGE_SECONDS = 15 * 60;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isProofFixtureEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@kiero.invalid");
}

export const setSignInCodeInternal = internalMutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    // The proof-domain rule is uniform: no fixture may ever target a real
    // person's address, even with the dev guard on.
    if (!isProofFixtureEmail(args.email)) {
      return errorResult(unsupportedError("projects.c1Proof", "proof_domain_required"));
    }
    // The account lookup matches B1's own fixture exactly: the library stores
    // providerAccountId as the address was passed, so the lookup uses the
    // exact string (no case folding — a folded lookup would miss the mixed
    // case a real issuance stores).
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "email_code").eq("providerAccountId", args.email),
      )
      .unique();
    if (account === null) {
      return errorResult(unsupportedError("projects.c1Proof", "no_email_code_account"));
    }
    const existing = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .unique();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("authVerificationCodes", {
      accountId: account._id,
      provider: "email_code",
      code: await sha256Hex(args.code),
      expirationTime: Date.now() + OTP_MAX_AGE_SECONDS * 1000,
      emailVerified: args.email,
    });
    return okResult({ set: true });
  },
});

/** Installs a known sign-in code for a proof-domain person (guarded). */
export const c1ProofSetSignInCode = action({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.projects.probe.setSignInCodeInternal, {
      email: args.email,
      code: args.code,
    });
  },
});
