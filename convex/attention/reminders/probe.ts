/**
 * F4 task-reminder dev proofs (guarded by the deployment's
 * KIERO_PROBE_ENABLED variable; shared plumbing in
 * convex/attention/probe_shared.ts).
 *
 * - `probeRecomputeTaskReminders`: runs the REAL recompute transaction for
 *   one task at a CALLER-CHOSEN instant (the fake-clock surface for slot
 *   boundaries and the missed-slot clamp), tenant-checked against the
 *   verified service identity.
 * - `probeEvaluateDueReminders`: dispatches one evaluation sweep through
 *   the checked path as the service identity (or a seeded session) at a
 *   caller-chosen instant.
 * - `probeSnoozeTaskReminders`: dispatches the personal snooze through the
 *   checked path as a seeded session (the snoozing person is the session's
 *   user, never client input).
 * - `probeReminderState`: the company-wide reminder diagnostic read the
 *   evidence script asserts on.
 * - `probeSeedDatedTask`: the dated-task fixture the live evidence needs
 *   from OTHER lanes' modules (a deadline finding + its current revision +
 *   the task row, written directly - the C4 `c4ProofSeedWitnessedSource`
 *   lease-workaround precedent; proof domains only, the REAL task and
 *   finding flows stay their owning lanes' checked paths).
 * - `probeRepublishTaskChanged`: duplicate-event injection - republishes a
 *   canonical `work.taskChanged` for a fixture task so the real drain ->
 *   durable job -> executor edge runs.
 * - `probeReviseDeadlineFinding`: the fixture deadline-value revision (a
 *   correction of the bound term without touching the task row) feeding
 *   the finding_revised recompute edge.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, notFoundError } from "@kiero/runtime";
import type { Id } from "../../_generated/dataModel";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";
import { resolveBridgeQueryScope } from "../context";
import { publishEvent } from "../../platform/publish";
import { performRecomputeTaskReminders } from "./operations";

/** Dispatches the recompute transaction for one task (guarded, tenant-checked). */
export const recomputeTaskReminders = internalMutation({
  args: { taskId: v.id("tasks"), nowMs: v.float64(), serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return errorResult(notFoundError("tasks", "task_not_found"));
    }
    if (task.companyId !== scope.companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "tasks"));
    }
    return performRecomputeTaskReminders(ctx, args.taskId, args.nowMs);
  },
});

export const probeRecomputeTaskReminders = action({
  args: { sessionId: v.optional(v.string()), taskId: v.id("tasks"), nowMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.probe.recomputeTaskReminders, {
      taskId: args.taskId,
      nowMs: args.nowMs,
      serviceSessionId: sessionId,
    });
  },
});

/** Dispatches one evaluation sweep at a chosen instant (guarded). */
export const probeEvaluateDueReminders = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.commands.evaluateDueRemindersTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** Dispatches the personal snooze as a seeded session's user (guarded). */
export const probeSnoozeTaskReminders = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.commands.snoozeTaskRemindersTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The company-wide reminder state (guarded diagnostic read). */
export const probeReminderState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.reminders.queries.taskReminderOverviewFor, {
      serviceSessionId: sessionId,
    });
  },
});

// ---------------------------------------------------------------------------
// The cross-lane fixtures the live evidence needs (lease-workaround rows).
// ---------------------------------------------------------------------------

/** The dated-task fixture shape: a deadline term and a coordinator. */
interface DatedTaskFixture {
  readonly projectId: Id<"projects">;
  readonly title: string;
  /** The deadline term: null = undated, a day string = date-only, an ISO zoned string = timed. */
  readonly deadlineDay: string | null;
  readonly deadlineIso: string | null;
  /** The coordinator membership (null = unassigned, targeting every boss). */
  readonly coordinatorMembershipId: Id<"memberships"> | null;
  readonly state?: "todo" | "in_progress" | "waiting" | "done" | "cancelled";
}

/** Seeds one finding (+ current revision) and the task bound to it (guarded). */
export const seedDatedTask = internalMutation({
  args: {
    serviceSessionId: v.string(),
    projectId: v.id("projects"),
    title: v.string(),
    deadlineDay: v.union(v.string(), v.null()),
    deadlineIso: v.union(v.string(), v.null()),
    coordinatorMembershipId: v.union(v.id("memberships"), v.null()),
    state: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.companyId !== scope.companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "projects"));
    }
    const companyId = project.companyId;
    const nowMs = Date.now();

    let deadlineFindingId: Id<"findings"> | undefined;
    if (args.deadlineDay !== null || args.deadlineIso !== null) {
      const shape =
        args.deadlineIso !== null
          ? { _tag: "date_time" as const, value: args.deadlineIso }
          : { _tag: "day" as const, day: args.deadlineDay! };
      const value = {
        _tag: "temporal" as const,
        temporal: {
          shape,
          originalExpression: "f4 fixture term",
          role: "agreed" as const,
        },
      };
      const findingId = await ctx.db.insert("findings", {
        companyId,
        scopeKind: "project" as const,
        scopeProjectId: args.projectId,
        semanticKey: `f4-deadline:${nowMs}:${ctx.db.normalizeId("projects", args.projectId) ?? "p"}`,
        knowledgeState: { _tag: "known" as const },
        revisionCounter: 1,
        updatedAtMs: nowMs,
      });
      const revisionId = await ctx.db.insert("findingRevisions", {
        findingId,
        revision: 1,
        value,
        knowledgeState: { _tag: "known" as const },
        origin: "publication" as const,
        recordedByUserId: scope.userId,
        recordedAtMs: nowMs,
      });
      await ctx.db.patch(findingId, { currentRevisionId: revisionId });
      deadlineFindingId = findingId;
    }

    const taskId = await ctx.db.insert("tasks", {
      companyId,
      projectId: args.projectId,
      title: args.title,
      state: (args.state as DatedTaskFixture["state"] | undefined) ?? "todo",
      ...(args.coordinatorMembershipId !== null
        ? { coordinatorMembershipId: args.coordinatorMembershipId }
        : {}),
      ...(deadlineFindingId !== undefined ? { deadlineFindingId } : {}),
      revisionCounter: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      stateChangedAtMs: nowMs,
    });
    return okResult({ taskId, deadlineFindingId: deadlineFindingId ?? null });
  },
});

export const probeSeedDatedTask = action({
  args: {
    sessionId: v.optional(v.string()),
    projectId: v.id("projects"),
    title: v.string(),
    deadlineDay: v.union(v.string(), v.null()),
    deadlineIso: v.union(v.string(), v.null()),
    coordinatorMembershipId: v.union(v.id("memberships"), v.null()),
    state: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.probe.seedDatedTask, {
      serviceSessionId: sessionId,
      projectId: args.projectId,
      title: args.title,
      deadlineDay: args.deadlineDay,
      deadlineIso: args.deadlineIso,
      coordinatorMembershipId: args.coordinatorMembershipId,
      ...(args.state === undefined ? {} : { state: args.state }),
    });
  },
});

/** Republishes one canonical task-changed event for a fixture task (guarded). */
export const republishTaskChanged = internalMutation({
  args: { taskId: v.id("tasks"), revision: v.float64(), serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const task = await ctx.db.get(args.taskId);
    if (task === null || task.companyId !== scope.companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "tasks"));
    }
    return okResult(
      await publishEvent(ctx, {
        companyId: task.companyId,
        eventName: "work.taskChanged",
        payload: { taskId: task._id },
        dedupKey: `work.taskChanged:${task._id}:${args.revision}`,
      }),
    );
  },
});

export const probeRepublishTaskChanged = action({
  args: { sessionId: v.optional(v.string()), taskId: v.id("tasks"), revision: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.probe.republishTaskChanged, {
      taskId: args.taskId,
      revision: args.revision,
      serviceSessionId: sessionId,
    });
  },
});

/**
 * Revises one fixture finding's deadline value in place (guarded): the
 * term moves WITHOUT touching the task row, exactly like a real date
 * correction through the memory lane.
 */
export const reviseDeadlineFinding = internalMutation({
  args: {
    findingId: v.id("findings"),
    deadlineDay: v.union(v.string(), v.null()),
    deadlineIso: v.union(v.string(), v.null()),
    serviceSessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const finding = await ctx.db.get(args.findingId);
    if (finding === null || finding.companyId !== scope.companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "findings"));
    }
    const nowMs = Date.now();
    const shape =
      args.deadlineIso !== null
        ? { _tag: "date_time" as const, value: args.deadlineIso }
        : { _tag: "day" as const, day: args.deadlineDay! };
    const revisionId = await ctx.db.insert("findingRevisions", {
      findingId: args.findingId,
      revision: finding.revisionCounter + 1,
      value: {
        _tag: "temporal" as const,
        temporal: { shape, originalExpression: "f4 fixture correction", role: "agreed" as const },
      },
      knowledgeState: { _tag: "known" as const },
      origin: "correction" as const,
      recordedByUserId: scope.userId,
      recordedAtMs: nowMs,
    });
    await ctx.db.patch(args.findingId, {
      currentRevisionId: revisionId,
      revisionCounter: finding.revisionCounter + 1,
      updatedAtMs: nowMs,
    });
    return okResult(
      await publishEvent(ctx, {
        companyId: finding.companyId,
        eventName: "memory.findingRevised",
        payload: {
          findingId: args.findingId,
          revisionId,
          supersedesRevisionId: finding.currentRevisionId ?? null,
        },
        dedupKey: `memory.findingRevised:${revisionId}`,
      }),
    );
  },
});

export const probeReviseDeadlineFinding = action({
  args: {
    sessionId: v.optional(v.string()),
    findingId: v.id("findings"),
    deadlineDay: v.union(v.string(), v.null()),
    deadlineIso: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.reminders.probe.reviseDeadlineFinding, {
      findingId: args.findingId,
      deadlineDay: args.deadlineDay,
      deadlineIso: args.deadlineIso,
      serviceSessionId: sessionId,
    });
  },
});

/** The task row's current state (guarded helper read for evidence). */
export const taskState = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return errorResult(notFoundError("tasks", "task_not_found"));
    }
    return okResult({
      taskId: task._id,
      state: task.state,
      revisionCounter: task.revisionCounter,
      deadlineFindingId: task.deadlineFindingId ?? null,
      coordinatorMembershipId: task.coordinatorMembershipId ?? null,
    });
  },
});
