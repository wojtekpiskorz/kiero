/**
 * Calendar sync transactions (G3): the write halves of the pure decision
 * cores, each inside ONE Convex mutation.
 *
 * The A3 echo template, applied per copy: `prepareCopyAttempt` decides the
 * ONE bounded leg and durably records the attempt with outcome `unknown`
 * BEFORE the external call runs (a crash in between honestly leaves an
 * uncertain attempt — the effect may have happened); the action executes
 * the leg; `completeCopyAttempt` re-reads the copy (the stale-attempt
 * guard), records the attempt's definite outcome, applies the remote-ledger
 * transition and publishes `calendar.copyOutcomeRecorded` when the outcome
 * CHANGED — the certified consumer edge that accelerates the next
 * observation durably.
 *
 * Desire fields (desiredState, payload, withdrawReason) are NEVER written
 * here: G2's projection pass is their only writer. G3 owns exactly the
 * remote ledger (googleEventId, remoteOutcome), the detected-personal-hide
 * columns (hidden/hiddenOrigin/hiddenAtMs — the same columns
 * `calendar.setCopyHidden` writes; the projection pass never touches them)
 * and its own attempt rows.
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { earliestActiveCompanyId } from "../connection/operations";
import {
  decideMutationTransition,
  decideObservationTransition,
  observationFromMutation,
  canonicalJson,
  decideCopyLeg,
  type AbsenceContext,
  type AttemptStats,
  type ConnectionSyncView,
  type CopySyncView,
  type HideOrigin,
  type ManagedFields,
  type MutationReport,
  type ObservationResult,
  type ObservedEvent,
  type RemoteOutcome,
  type SyncLeg,
  type SyncSuspensionReason,
} from "./cores";
import type { DesiredGoogleEvent } from "@kiero/domain";

// ---------------------------------------------------------------------------
// Row plumbing.
// ---------------------------------------------------------------------------

/** The pure-module view of one copy row. */
function copySyncView(row: Doc<"calendarCopies">): CopySyncView {
  return {
    copyId: row._id,
    semanticId: row.semanticId,
    desiredState: row.desiredState,
    hidden: row.hidden,
    payload: (row.payload as DesiredGoogleEvent | undefined) ?? null,
    googleEventId: row.googleEventId ?? null,
    remoteOutcome: row.remoteOutcome,
  };
}

/** The connection recheck view (state + dedicated calendar). */
function connectionSyncView(row: Doc<"calendarConnections">): ConnectionSyncView {
  return {
    state: row.state,
    googleCalendarId: row.googleCalendarId ?? null,
  };
}

/** One attempt row's JSON blob (the cached observation). */
function observedJsonOf(observation: ObservedEvent): string {
  return canonicalJson({
    eventId: observation.eventId,
    status: observation.status,
    managed: observation.managed,
    observedAtMs: observation.observedAtMs,
  });
}

/** Parses an attempt row's cached observation blob. */
export function parseObservedJson(value: string | undefined): ObservedEvent | null {
  if (value === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      eventId?: unknown;
      status?: unknown;
      managed?: unknown;
      observedAtMs?: unknown;
    };
    if (
      typeof parsed.eventId !== "string" ||
      (parsed.status !== "confirmed" && parsed.status !== "cancelled") ||
      typeof parsed.managed !== "object" ||
      parsed.managed === null ||
      typeof parsed.observedAtMs !== "number"
    ) {
      return null;
    }
    return {
      eventId: parsed.eventId,
      status: parsed.status,
      managed: parsed.managed as ManagedFields,
      observedAtMs: parsed.observedAtMs,
    };
  } catch {
    return null;
  }
}

/** The attempts of one copy for its CURRENT semantic id, plus the caches. */
async function attemptFactsOf(
  db: MutationCtx["db"],
  copy: Doc<"calendarCopies">,
): Promise<{
  stats: AttemptStats;
  lastObservation: ObservedEvent | null;
  absence: AbsenceContext;
  legCounts: Map<string, number>;
}> {
  const rows = await db
    .query("calendarSyncAttempts")
    .withIndex("by_copy", (q) => q.eq("copyId", copy._id))
    .collect();
  const own = rows
    .filter((row) => row.semanticId === copy.semanticId)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  const legCounts = new Map<string, number>();
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  // The chronological presence walk: a successful delete authors the
  // CURRENT absence; a successful create or a present observation
  // re-establishes presence (and proves the event ever existed).
  let authoredByKiero = false;
  let everConfirmed = false;
  let lastObservation: ObservedEvent | null = null;
  for (const row of own) {
    legCounts.set(row.legKind, (legCounts.get(row.legKind) ?? 0) + 1);
    if (row.legKind === "create") {
      creates += 1;
      if (row.outcome === "succeeded") {
        authoredByKiero = false;
        everConfirmed = true;
      }
    } else if (row.legKind === "update") {
      updates += 1;
    } else if (row.legKind === "delete") {
      deletes += 1;
      if (row.outcome === "succeeded") {
        authoredByKiero = true;
      }
    }
    const observed = parseObservedJson(row.observedJson);
    if (
      row.outcome === "succeeded" &&
      observed !== null &&
      (lastObservation === null || observed.observedAtMs > lastObservation.observedAtMs)
    ) {
      lastObservation = observed;
      if (observed.status === "confirmed") {
        authoredByKiero = false;
        everConfirmed = true;
      }
    }
  }
  return {
    stats: { creates, updates, deletes },
    lastObservation,
    absence: { authoredByKiero, everConfirmed },
    legCounts,
  };
}

// ---------------------------------------------------------------------------
// Prepare: decide the one bounded leg and durably open the attempt.
// ---------------------------------------------------------------------------

/** What the prepare mutation answers the action runner. */
export type PreparedAttempt =
  | { readonly kind: "copy_missing" }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "suspend"; readonly reason: SyncSuspensionReason }
  | {
      readonly kind: "leg";
      readonly leg: SyncLeg;
      readonly reason: string;
      readonly attemptDedupKey: string;
      /** The connection whose credential the runner must open. */
      readonly connectionId: Id<"calendarConnections">;
      /** The copy's semantic id (the observe_get disambiguation filter). */
      readonly semanticId: string;
      readonly accessTokenExpiresAtMs: number | null;
    };

export const prepareCopyAttempt = internalMutation({
  args: { copyId: v.id("calendarCopies"), forceObservation: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<PreparedAttempt> => {
    const copy = await ctx.db.get(args.copyId);
    if (copy === null) {
      return { kind: "copy_missing" };
    }
    const connection = await ctx.db.get(copy.connectionId);
    if (connection === null) {
      return { kind: "suspend", reason: "connection_not_connected" };
    }
    // The per-attempt stop rules (issue #47): no leg leaves the
    // transaction for a row whose firm is no longer the boss's active firm
    // (membership revocation) or whose connection is not healthy.
    const activeCompanyId = await earliestActiveCompanyId(ctx.db, connection.userId);
    if (activeCompanyId === null || activeCompanyId !== connection.companyId) {
      return { kind: "suspend", reason: "membership_or_firm_changed" };
    }
    if (connection.state !== "connected") {
      return { kind: "suspend", reason: "connection_not_connected" };
    }
    const facts = await attemptFactsOf(ctx.db, copy);
    const decision = decideCopyLeg(
      copySyncView(copy),
      connectionSyncView(connection),
      facts.stats,
      facts.lastObservation,
      Date.now(),
      args.forceObservation ?? false,
    );
    if (decision.action === "none") {
      return { kind: "none", reason: decision.reason };
    }
    if (decision.action === "suspend") {
      return { kind: "suspend", reason: decision.reason };
    }
    const leg = decision.leg;
    const prior = facts.legCounts.get(leg.leg) ?? 0;
    const attemptDedupKey = `calendar-sync-attempt:${copy._id}:${copy.semanticId}:${leg.leg}:${prior}`;
    const nowMs = Date.now();
    // The attempt opens UNCERTAIN: if the action dies mid-leg, this row is
    // the honest record that an effect may have happened (architecture
    // step 9: record attempts and known/unknown outcome). The basis
    // columns (semantic id, revision, desire state, hide, payload hash)
    // are the stale-attempt guard's durable snapshot.
    await ctx.db.insert("calendarSyncAttempts", {
      connectionId: connection._id,
      copyId: copy._id,
      semanticId: copy.semanticId,
      legKind: leg.leg,
      decisionReason: decision.reason,
      outcome: "unknown",
      desiredRevisionId: copy.desiredRevisionId,
      desiredState: copy.desiredState,
      hiddenBasis: copy.hidden,
      ...(copy.payload === undefined ? {} : { desiredPayloadHash: canonicalJson(copy.payload) }),
      desiredAtMs: copy.updatedAtMs,
      startedAtMs: nowMs,
      dedupKey: attemptDedupKey,
      createdAtMs: nowMs,
    });
    return {
      kind: "leg",
      leg,
      reason: decision.reason,
      attemptDedupKey,
      connectionId: connection._id,
      semanticId: copy.semanticId,
      accessTokenExpiresAtMs: connection.accessTokenExpiresAtMs ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Complete: record the outcome, apply the transition, publish the change.
// ---------------------------------------------------------------------------

/** The leg result the action runner reports (protocol outcomes mapped). */
export type LegResult =
  | { readonly kind: "observation"; readonly observation: ObservationResult }
  | { readonly kind: "mutation"; readonly report: MutationReport; readonly eventId?: string };

/** What the completion recorded (for the runner's/job's own state). */
export interface CompletionRecord {
  readonly remoteOutcome: RemoteOutcome;
  readonly accessLost: boolean;
  /** Whether the completion is still authoritative (not a stale attempt). */
  readonly wanted: boolean;
  readonly detectedHide: HideOrigin | null;
}

/**
 * The stale-attempt guard (pure half, exported for tests): the durable
 * basis columns on the attempt row versus the copy row as it reads NOW. A
 * job that went stale (a newer correction, withdrawal, hide or restore
 * landed while its external call was in flight) may still record its
 * LEDGER FACTS but never its desire-derived effects (hide detection).
 */
export function attemptBasisMatches(
  attempt: Pick<Doc<"calendarSyncAttempts">, "semanticId" | "desiredRevisionId" | "desiredState" | "hiddenBasis" | "desiredPayloadHash">,
  copy: Doc<"calendarCopies">,
): boolean {
  return (
    attempt.semanticId === copy.semanticId &&
    attempt.desiredRevisionId === copy.desiredRevisionId &&
    attempt.desiredState === copy.desiredState &&
    attempt.hiddenBasis === copy.hidden &&
    (attempt.desiredPayloadHash ?? null) ===
      (copy.payload === undefined ? null : canonicalJson(copy.payload))
  );
}

export const completeCopyAttempt = internalMutation({
  args: {
    attemptDedupKey: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("timeout"),
      v.literal("unknown"),
    ),
    errorKind: v.optional(v.string()),
    result: v.any(),
  },
  handler: async (ctx, args): Promise<CompletionRecord | null> => {
    const attempt = await ctx.db
      .query("calendarSyncAttempts")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", args.attemptDedupKey))
      .first();
    if (attempt === null) {
      return null;
    }
    const copy = await ctx.db.get(attempt.copyId);
    if (copy === null) {
      await ctx.db.patch(attempt._id, {
        outcome: args.outcome,
        completedAtMs: Date.now(),
        ...(args.errorKind === undefined ? {} : { errorKind: args.errorKind }),
      });
      return null;
    }
    const result = args.result as LegResult;
    const nowMs = Date.now();
    const view = copySyncView(copy);
    const facts = await attemptFactsOf(ctx.db, copy);
    const stale = !attemptBasisMatches(attempt, copy);

    let googleEventId: string | null = copy.googleEventId ?? null;
    let remoteOutcome: RemoteOutcome = copy.remoteOutcome;
    let detectedHide: HideOrigin | null = null;
    let accessLost = false;
    let observedJson: string | undefined;

    if (result.kind === "observation") {
      const transition = decideObservationTransition(
        result.observation,
        view,
        nowMs,
        facts.absence,
      );
      googleEventId = transition.googleEventId;
      remoteOutcome = transition.remoteOutcome;
      detectedHide = transition.detectedHide;
      if (transition.observation !== null) {
        observedJson = observedJsonOf(transition.observation);
      }
      accessLost = result.observation.kind === "calendar_gone";
    } else {
      const transition = decideMutationTransition(
        attempt.legKind as "create" | "update" | "delete",
        result.report,
        view,
      );
      googleEventId = transition.googleEventId;
      remoteOutcome = transition.remoteOutcome;
      accessLost = transition.accessLost;
      if (result.report.kind === "applied" && attempt.legKind !== "delete") {
        const eventId =
          attempt.legKind === "create" ? (result.eventId ?? null) : (copy.googleEventId ?? null);
        if (eventId !== null) {
          const implied = observationFromMutation(view, eventId, nowMs);
          if (implied !== null) {
            observedJson = observedJsonOf(implied);
          }
        }
      }
    }

    const outcomeChanged = remoteOutcome !== copy.remoteOutcome;
    // The certified consumer edge trigger: every CHANGED outcome
    // accelerates one durable observation, and so does an UNCERTAIN
    // MUTATION (a timeout after a possible success) even when the ledger
    // word stays `unknown` — G2 initializes new copies as unknown, so the
    // uncertain signal itself is the reconcile trigger. An uncertain
    // OBSERVATION deliberately publishes nothing: nothing was written,
    // the mutation gate already blocks on it, and publishing would let a
    // flaky network loop events and jobs (the cron safety net owns the
    // retry cadence there).
    const uncertainMutation =
      (attempt.legKind === "create" ||
        attempt.legKind === "update" ||
        attempt.legKind === "delete") &&
      (args.outcome === "unknown" || args.outcome === "timeout");
    // LEDGER FACTS always record (facts about Google, not about desire);
    // the personal-hide detection is desire-derived and only applies to a
    // still-wanted attempt.
    await ctx.db.patch(copy._id, {
      ...(googleEventId === null ? { googleEventId: undefined } : { googleEventId }),
      remoteOutcome,
      updatedAtMs: nowMs,
      ...(!stale && detectedHide !== null
        ? { hidden: true, hiddenOrigin: detectedHide, hiddenAtMs: nowMs }
        : {}),
    });
    await ctx.db.patch(attempt._id, {
      outcome: args.outcome,
      completedAtMs: nowMs,
      ...(googleEventId === null ? {} : { googleEventId }),
      ...(observedJson === undefined ? {} : { observedJson }),
      ...(args.errorKind === undefined ? {} : { errorKind: args.errorKind }),
    });

    if (accessLost) {
      await markConnectionAccessLost(ctx, copy.connectionId);
    }
    const connection = await ctx.db.get(copy.connectionId);
    if ((outcomeChanged || uncertainMutation) && connection !== null) {
      await publishEvent(ctx, {
        companyId: connection.companyId,
        eventName: "calendar.copyOutcomeRecorded",
        payload: { copyId: copy._id, outcome: remoteOutcome },
        dedupKey: `calendar.copy-outcome-recorded:${copy._id}:${nowMs}`,
      });
    }
    const sync = await ctx.db
      .query("calendarSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", copy.connectionId))
      .first();
    if (sync !== null && args.outcome === "succeeded") {
      await ctx.db.patch(sync._id, { lastSyncedAtMs: nowMs, updatedAtMs: nowMs });
    }
    return { remoteOutcome, accessLost, wanted: !stale, detectedHide: stale ? null : detectedHide };
  },
});

// ---------------------------------------------------------------------------
// The calendar_access_lost stop (the explicit recreate path's record).
// ---------------------------------------------------------------------------

/**
 * Marks the connection `error/calendar_access_lost`: the dedicated
 * calendar answered 401/403/404 at its own scope, which Google documents
 * as deleted OR inaccessible — recovery is the boss's explicit RECREATE
 * decision (G1's authorization mode), never an automatic second calendar
 * (docs/research/google-calendar-reconnect-facts.md).
 *
 * FLAGGED cross-lane write: the connection row is G1's table, and the
 * issue's own scope sanctions exactly this transition ("404-ambiguity ->
 * calendar_access_lost + the explicit recreate path"). Only the state
 * reason columns are patched; credentials and identity stay untouched (the
 * boss may still hold a working token — the calendar is what went).
 */
async function markConnectionAccessLost(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const row = await ctx.db.get(connectionId);
  if (row === null || row.state === "error") {
    return;
  }
  await ctx.db.patch(row._id, {
    state: "error",
    reconnectReason: "calendar_access_lost",
    updatedAtMs: Date.now(),
  });
}

export const markCalendarAccessLostTransaction = internalMutation({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args) => {
    await markConnectionAccessLost(ctx, args.connectionId);
  },
});

// ---------------------------------------------------------------------------
// The durable job completion (calendar.reconcile_outcome's action half).
// ---------------------------------------------------------------------------

/**
 * Records the `calendar.reconcile_outcome` job's terminal state. A job
 * whose leg was UNCERTAIN fails with `externalOutcome: unknown/timeout` —
 * the platform's `isUncertainJobFailure` then blocks every blind replay;
 * only reconciliation by observation (a later pass or outcome event) may
 * re-queue work.
 */
export const completeReconcileJob = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.union(v.literal("succeeded"), v.literal("failed")),
    externalOutcome: v.optional(
      v.union(v.literal("succeeded"), v.literal("failed"), v.literal("timeout"), v.literal("unknown")),
    ),
    errorKind: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null) {
      return;
    }
    const nowMs = Date.now();
    await ctx.db.patch(job._id, {
      state: args.outcome,
      externalOutcome:
        args.outcome === "succeeded" ? "succeeded" : (args.externalOutcome ?? "failed"),
      ...(args.errorKind === "" ? { lastErrorKind: undefined } : { lastErrorKind: args.errorKind }),
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    });
  },
});

// ---------------------------------------------------------------------------
// Sync-state transitions (G3's half of the shared sync row).
// ---------------------------------------------------------------------------

export const beginSyncPassTransaction = internalMutation({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    const nowMs = Date.now();
    if (row === null) {
      await ctx.db.insert("calendarSyncState", {
        connectionId: args.connectionId,
        state: "syncing",
        lastPassAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      return;
    }
    await ctx.db.patch(row._id, { state: "syncing", updatedAtMs: nowMs });
  },
});

export const finishSyncPassTransaction = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    state: v.union(v.literal("idle"), v.literal("needs_reconcile")),
    suspendedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    const nowMs = Date.now();
    if (row === null) {
      await ctx.db.insert("calendarSyncState", {
        connectionId: args.connectionId,
        state: args.state,
        ...(args.suspendedReason === undefined ? {} : { suspendedReason: args.suspendedReason }),
        lastPassAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      return;
    }
    await ctx.db.patch(row._id, {
      state: args.state,
      ...(args.suspendedReason === undefined
        ? { suspendedReason: undefined }
        : { suspendedReason: args.suspendedReason }),
      updatedAtMs: nowMs,
    });
  },
});
