/**
 * Guarded C4 proof fixtures (dev deployment only).
 *
 * Same pattern as the A3/B1/B3/C1 probes: an ACTION checks the deployment
 * guard variable (`KIERO_C4_PROOF_ENABLED === "1"`) and runs internal
 * functions reachable only from this module. On a production deployment
 * the guard variable is absent and every entry fails closed.
 *
 * - `c4ProofCompanyWork`: the tenant-scoped inspection read the live
 *   evidence asserts on — raw tasks, points, events, the immutable
 *   `workRevisions` history, the company's `work.*` outbox events, its
 *   membership lifecycle rows and B3's registered revocation cleanup jobs,
 *   plus the DERIVED overview (dueness, effective coordination, timing)
 *   computed exactly as the public read computes it. It reads only; the
 *   proof writes exclusively through the checked dispatch.
 * - `c4ProofRecordEventWithTask` / `c4ProofCrashEventWithTask`: the atomic
 *   event + linked task pair under the proof person's live session, and its
 *   crash twin (FULL pair, then a deliberate throw: the D1/C2 no-orphan
 *   pattern proving both records roll back together).
 * - `c4ProofDeriveDueness`: runs the DEPLOYED pure dueness/timing
 *   derivation for explicit instants around company-timezone day
 *   boundaries (no state is touched).
 * - `c4ProofSetSignInCode` / `c4ProofSetInvitationCode` /
 *   `c4ProofSeedWitnessedSource`: the lease-workaround fixtures this lane's
 *   live evidence needs from OTHER lanes' modules (B1's code fixture, B3's
 *   invitation-code fixture, C2's witnessed-source seeding). The dev lease
 *   snapshots guard variables into module bundles at push time, so an
 *   UNCHANGED sibling module keeps answering `proof_guard_disabled` after
 *   the variables land (the C1 precedent: the same fixture runs from this
 *   lane's freshly-pushed module). Proof domains only; the REAL issuance,
 *   verification, acceptance and publication still run through their owning
 *   lanes' checked paths.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { action, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { KnowledgeState, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { deriveEventTiming, deriveTaskDueness, temporalValueOf } from "@kiero/domain";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";
import { isProofFixtureEmail } from "../access/identity/proofDomain";
import { sha256Hex } from "../access/membership/cores";
import {
  changeEventEntry,
  changeTaskEntry,
  performRecordEventWithTask,
} from "./operations";
import { readWorkOverview } from "./read";

function guardEnabled(): boolean {
  return process.env.KIERO_C4_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("work.c4Proof", "proof_guard_disabled"));
}

// --- inspection ---------------------------------------------------------------

export const companyWorkInternal = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const nowMs = Date.now();
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_company_state", (q) => q.eq("companyId", args.companyId))
      .collect();
    const items = [];
    for (const task of tasks) {
      const rows = await ctx.db
        .query("checklistItems")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      for (const row of rows) {
        items.push({
          itemId: row._id,
          taskId: row.taskId,
          description: row.description,
          state: row.state,
          promotedToTaskId: row.promotedToTaskId ?? null,
          revisionCounter: row.revisionCounter,
          checkedAtMs: row.checkedAtMs ?? null,
          createdAtMs: row.createdAtMs,
        });
      }
    }
    const events = await ctx.db
      .query("events")
      .withIndex("by_project_state", (q) => q.eq("companyId", args.companyId))
      .collect();
    const revisions = await ctx.db
      .query("workRevisions")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", args.companyId))
      .collect();
    const outbox = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const cleanupJobs = (
      await ctx.db
        .query("durableJobs")
        .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
        .collect()
    ).filter((row) => row.kind === "access.cleanup_revocation");
    const overview = await readWorkOverview(ctx.db, args.companyId, nowMs);

    const byTime = <T>(rows: readonly T[], time: (row: T) => number): T[] =>
      rows.slice().sort((a, b) => time(a) - time(b));

    return okResult({
      nowMs,
      tasks: byTime(tasks, (row) => row.createdAtMs).map((row) => ({
        taskId: row._id,
        projectId: row.projectId,
        title: row.title,
        state: row.state,
        waitingReason: row.waitingReason ?? null,
        executorContactId: row.executorContactId ?? null,
        coordinatorMembershipId: row.coordinatorMembershipId ?? null,
        deadlineFindingId: row.deadlineFindingId ?? null,
        linkedEventId: row.linkedEventId ?? null,
        parentTaskId: row.parentTaskId ?? null,
        revisionCounter: row.revisionCounter,
        stateChangedAtMs: row.stateChangedAtMs,
        createdAtMs: row.createdAtMs,
      })),
      items: byTime(items, (row) => row.createdAtMs),
      events: byTime(events, (row) => row.createdAtMs).map((row) => ({
        eventId: row._id,
        projectId: row.projectId,
        title: row.title,
        state: row.state,
        timeFindingId: row.timeFindingId ?? null,
        revisionCounter: row.revisionCounter,
        createdAtMs: row.createdAtMs,
      })),
      revisions: byTime(revisions, (row) => row.recordedAtMs).map((row) => ({
        revisionId: row._id,
        subjectKind: row.subjectKind,
        taskId: row.taskId ?? null,
        itemId: row.itemId ?? null,
        eventId: row.eventId ?? null,
        revision: row.revision,
        change: row.change,
        snapshot: row.snapshot,
        actorUserId: row.actorUserId,
        via: row.via,
        basisSourceId: row.basisSourceId ?? null,
        recordedAtMs: row.recordedAtMs,
      })),
      memberships: memberships.map((row) => ({
        membershipId: row._id,
        userId: row.userId,
        role: row.role,
        state: row.state,
      })),
      workEvents: outbox
        .filter((row) => row.eventName.startsWith("work."))
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .map((row) => ({
          eventId: row.eventId,
          eventName: row.eventName,
          deliveryState: row.deliveryState,
          dedupKey: row.dedupKey ?? null,
          payload: JSON.parse(row.envelopeJson).payload,
        })),
      cleanupJobs: cleanupJobs.map((row) => ({
        jobKey: row.jobKey,
        kind: row.kind,
        state: row.state,
        dedupKey: row.dedupKey ?? null,
      })),
      overview,
    });
  },
});

/** Inspects one company's work state, history and derived facts (guarded). */
export const c4ProofCompanyWork = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runQuery(internal.work.probe.companyWorkInternal, {
      companyId: args.companyId,
    });
  },
});

// --- the atomic pair and its crash twin ------------------------------------------

async function pairUnderSession(
  ctx: MutationCtx,
  sessionId: string,
  event: unknown,
  task: unknown,
): Promise<ResultEnvelope> {
  // The session id comes only from this guarded module's callers; the pair
  // is recorded as whoever that live session resolves to (the proof
  // person), through the SAME canonical chain the checked dispatch uses.
  const context = await resolveRequestContext(ctx.db, bridgeIdentity(sessionId, Date.now()));
  if (context === null) {
    return errorResult(unsupportedError("work.c4Proof", "no_live_session"));
  }
  return performRecordEventWithTask(ctx, context, {
    event: Schema.decodeUnknownSync(changeEventEntry.input)(event),
    task: Schema.decodeUnknownSync(changeTaskEntry.input)(task),
  });
}

export const recordEventWithTaskInternal = internalMutation({
  args: { sessionId: v.string(), event: v.any(), task: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    pairUnderSession(ctx, args.sessionId, args.event, args.task),
});

/** Records one event + linked task atomically under the live session (guarded). */
export const c4ProofRecordEventWithTask = action({
  args: { sessionId: v.string(), event: v.any(), task: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.work.probe.recordEventWithTaskInternal, {
      sessionId: args.sessionId,
      event: args.event,
      task: args.task,
    });
  },
});

export const crashEventWithTaskInternal = internalMutation({
  args: { sessionId: v.string(), event: v.any(), task: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const result = await pairUnderSession(ctx, args.sessionId, args.event, args.task);
    if (result._tag === "error") {
      return result; // the pair itself refused; nothing was committed
    }
    throw new Error("probe: deliberate failure after the event + task pair writes");
  },
});

/** The FULL pair, then a deliberate throw: proves both roll back (guarded). */
export const c4ProofCrashEventWithTask = action({
  args: { sessionId: v.string(), event: v.any(), task: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.work.probe.crashEventWithTaskInternal, {
      sessionId: args.sessionId,
      event: args.event,
      task: args.task,
    });
  },
});

// --- the deployed pure derivation ------------------------------------------------

/**
 * Runs the deployed dueness and timing derivation for one explicit instant
 * (guarded; no state touched). `findingValue` is a finding value in wire
 * form (or null for "no binding"); `knowledgeState` likewise.
 */
export const c4ProofDeriveDueness = action({
  args: {
    taskState: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("waiting"),
      v.literal("done"),
      v.literal("cancelled"),
    ),
    eventState: v.union(v.literal("planned"), v.literal("occurred"), v.literal("cancelled")),
    findingValue: v.any(),
    knowledgeState: v.any(),
    nowMs: v.float64(),
    companyTimezone: v.string(),
  },
  handler: async (_ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    const binding =
      args.findingValue === null
        ? null
        : {
            // Checked through the contract codec, so the derivation sees a
            // real wire-shaped knowledge state, not arbitrary action input.
            knowledgeState: Schema.encodeSync(KnowledgeState)(
              Schema.decodeUnknownSync(KnowledgeState)(args.knowledgeState),
            ),
            temporal: temporalValueOf(args.findingValue),
          };
    const dueness = deriveTaskDueness({
      state: args.taskState,
      deadline: binding,
      nowMs: args.nowMs,
      companyTimezone: args.companyTimezone,
    });
    const timing = deriveEventTiming({
      state: args.eventState,
      time: binding,
      nowMs: args.nowMs,
      companyTimezone: args.companyTimezone,
    });
    return okResult({ dueness, timing });
  },
});

// --- lease-workaround fixtures (C1 precedent; guarded like their owners) ------

const OTP_MAX_AGE_SECONDS = 15 * 60;

export const setSignInCodeInternal = internalMutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!isProofFixtureEmail(args.email)) {
      return errorResult(unsupportedError("work.c4Proof", "proof_domain_required"));
    }
    // The account lookup matches B1's own fixture exactly: the library
    // stores providerAccountId as the address was passed, so the lookup
    // uses the exact string (no case folding).
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "email_code").eq("providerAccountId", args.email),
      )
      .unique();
    if (account === null) {
      return errorResult(unsupportedError("work.c4Proof", "no_email_code_account"));
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
export const c4ProofSetSignInCode = action({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.work.probe.setSignInCodeInternal, {
      email: args.email,
      code: args.code,
    });
  },
});

export const setInvitationCodeInternal = internalMutation({
  args: { invitationId: v.id("invitations"), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const invitation = await ctx.db.get(args.invitationId);
    if (invitation === null || !isProofFixtureEmail(invitation.email)) {
      return errorResult(unsupportedError("work.c4Proof", "proof_domain_required"));
    }
    if (invitation.state !== "pending") {
      return errorResult(unsupportedError("work.c4Proof", "invitation_not_pending"));
    }
    await ctx.db.patch(args.invitationId, { codeHash: await sha256Hex(args.code) });
    return okResult({ set: true });
  },
});

/** Replaces one proof-domain invitation's code hash with a known code (guarded). */
export const c4ProofSetInvitationCode = action({
  args: { invitationId: v.id("invitations"), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.work.probe.setInvitationCodeInternal, {
      invitationId: args.invitationId,
      code: args.code,
    });
  },
});

const WITNESS_PIPELINE_VERSION = "c4.proof/1";

/**
 * Ensures one ACTIVE witnessed source (run + text extraction + whole-source
 * fragment) owned by whoever the live session resolves to — the C2 seeding
 * pattern, session-scoped like C1's draft-upload fixture. The row is the
 * evidence basis for work changes and the evidence source for C2 change
 * sets; it never impersonates D1's acceptance transaction.
 */
export const seedWitnessedSourceInternal = internalMutation({
  args: { sessionId: v.string(), acceptanceKey: v.string(), authorText: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.sessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(unsupportedError("work.c4Proof", "no_live_session"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return errorResult(unsupportedError("work.c4Proof", "no_live_session"));
    }
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_company_acceptance_key", (q) =>
        q.eq("companyId", companyId).eq("acceptanceKey", args.acceptanceKey),
      )
      .first();
    if (existing !== null) {
      const fragment = await ctx.db
        .query("sourceFragments")
        .withIndex("by_source", (q) => q.eq("sourceId", existing._id))
        .first();
      return okResult({
        sourceId: existing._id,
        fragmentId: fragment?._id ?? null,
      });
    }
    const nowMs = Date.now();
    const sourceId = await ctx.db.insert("sources", {
      companyId,
      authorUserId: userId,
      authorText: args.authorText,
      sentAtMs: nowMs,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: nowMs,
      lifecycle: "active",
      acceptanceKey: args.acceptanceKey,
      acceptanceFingerprint: `c4-proof:${args.acceptanceKey}`,
    });
    const runId = await ctx.db.insert("processingRuns", {
      companyId,
      sourceId,
      kind: "initial_analysis",
      pipelineVersion: WITNESS_PIPELINE_VERSION,
      promptVersion: "none",
      schemaVersion: "none",
      modelConfigurationVersion: "none",
      state: "succeeded",
      startedAtMs: nowMs,
    });
    const extractionId = await ctx.db.insert("extractions", {
      sourceId,
      kind: "text",
      pipelineVersion: WITNESS_PIPELINE_VERSION,
      model: "author-text",
      provider: "kiero",
      processingRunId: runId,
      createdAtMs: nowMs,
    });
    const fragmentId = await ctx.db.insert("sourceFragments", {
      extractionId,
      sourceId,
      anchor: { _tag: "whole_source" },
      createdAtMs: nowMs,
    });
    return okResult({ sourceId, fragmentId });
  },
});

/** Seeds one active witnessed source for the proof person (guarded). */
export const c4ProofSeedWitnessedSource = action({
  args: { sessionId: v.string(), acceptanceKey: v.string(), authorText: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.work.probe.seedWitnessedSourceInternal, {
      sessionId: args.sessionId,
      acceptanceKey: args.acceptanceKey,
      authorText: args.authorText,
    });
  },
});
