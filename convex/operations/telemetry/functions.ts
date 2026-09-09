/**
 * The telemetry function surface (I2).
 *
 * What lives here:
 *
 * - Writers: `recordEvent` (the sanitized emit path for lanes and HTTP
 *   ingest), `recordHeartbeat` (backend-silence ledger), `recordCostEntry`
 *   (all-in spend accounting).
 * - Monitors: `scanIncidents` (processing/save incidents from the A3
 *   surfaces, incl. attempts-exhausted rows), `evaluateCostAlerts` (400/500
 *   PLN thresholds with per-level cooldown), `pruneExpired` (windowed
 *   retention), `forwardToSink` (best-effort Axiom delivery).
 * - `cronTick`: the orchestrator registered in convex/crons.ts (which also
 *   carries the A3 handoff note's outbox-drain safety net).
 * - Reads: `telemetryOverview` (public, redacted-by-construction composed
 *   state for diagnostics/H4/I5/I7) and `telemetryState` (internal full
 *   read used by the HTTP health surface and proofs).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../../_generated/server";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { emitDiagnosticEvent, type EmitResult } from "./emit";
import { classifyIncidents } from "./incidents";
import {
  COST_THRESHOLDS,
  costAlertDedupKey,
  evaluateCostThresholds,
  isValidPeriod,
  periodOf,
  shouldEmitCostAlert,
  sumCostEntries,
  SPEND_PROVIDERS,
  type CostAlertLevel,
} from "./costs";
import {
  HEARTBEAT_SERVICES,
  HEARTBEATS_KEPT_PER_SERVICE,
  backendSilenceState,
  silenceIncidents,
  type HeartbeatService,
} from "./heartbeat";
import { PRUNE_BATCH_SIZE, costPeriodCutoff, retentionCutoffMs } from "./retention";
import { OBSERVABILITY_HONESTY } from "./observability";

// --- explicit handler return types -------------------------------------------------
// (They break the module -> generated api -> module type cycle, the same reason
// every A3 probe handler is annotated `Promise<ResultEnvelope>`.)

export interface IncidentEmitSummary {
  readonly kind: string;
  readonly emitted: boolean;
  readonly reason?: string;
}

export interface IncidentScanSummary {
  readonly scannedAtMs: number;
  readonly incidents: number;
  readonly emitted: readonly IncidentEmitSummary[];
}

export interface CostLevelResult {
  readonly level: string;
  readonly active: boolean;
  readonly fired: boolean;
  readonly suppressed?: string;
  readonly lastFiredAtMs?: number;
}

export interface CostEvaluation {
  readonly period: string;
  readonly totalMinor: number;
  readonly perProvider: Record<string, number>;
  readonly thresholds: { readonly warning: boolean; readonly alert: boolean };
  readonly results: readonly CostLevelResult[];
}

export interface PruneSummary {
  readonly prunedDiagnostics: number;
  readonly prunedCostEntries: number;
  readonly prunedAlertStates: number;
}

export interface UnforwardedEventRow {
  readonly _id: Id<"diagnosticEvents">;
  readonly kind: string;
  readonly technicalMetadata: { key: string; value: string }[];
  readonly redactionsApplied?: number;
  readonly redactionVersion: string;
  readonly atMs: number;
  readonly serviceName?: string;
  readonly environment?: string;
}

export interface RecentDiagnosticEvent {
  readonly kind: string;
  readonly technicalMetadata: { key: string; value: string }[];
  readonly redactionsApplied?: number;
  readonly serviceName?: string;
  readonly redactionVersion: string;
  readonly forwardedAtMs: number;
  readonly atMs: number;
}

export interface CostAlertStateView {
  readonly level: string;
  readonly thresholdMinor: number;
  readonly firstFiredAtMs: number;
  readonly lastFiredAtMs: number;
  readonly fireCount: number;
  readonly lastTotalMinor: number;
}

export interface ComposedTelemetryState {
  readonly atMs: number;
  readonly observability: typeof OBSERVABILITY_HONESTY;
  readonly diagnostics: { readonly recent: readonly RecentDiagnosticEvent[] };
  readonly health: ReturnType<typeof backendSilenceState>;
  readonly costs: {
    readonly period: string;
    readonly perProvider: Record<string, number>;
    readonly totalMinor: number;
    readonly thresholds: { readonly warning: boolean; readonly alert: boolean };
    readonly alertStates: readonly CostAlertStateView[];
  };
}

// --- writers --------------------------------------------------------------------

/** Internal sanitized event writer (HTTP ingest, lanes, proof scripts). */
export const recordEvent = internalMutation({
  args: {
    payload: v.any(),
    serviceName: v.optional(v.string()),
    environment: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EmitResult> =>
    emitDiagnosticEvent(ctx, {
      kind: (args.payload as { kind?: unknown }).kind,
      metadata: (args.payload as { metadata?: unknown }).metadata,
      ...(args.serviceName === undefined ? {} : { serviceName: args.serviceName }),
      ...(args.environment === undefined ? {} : { environment: args.environment }),
      ...(args.dedupKey === undefined ? {} : { dedupKey: args.dedupKey }),
    }),
});

function isHeartbeatService(value: string): value is HeartbeatService {
  return (HEARTBEAT_SERVICES as readonly string[]).includes(value);
}

/** Records one heartbeat and prunes the bounded per-service tail. */
export const recordHeartbeat = internalMutation({
  args: { serviceName: v.string(), status: v.string() },
  handler: async (ctx, args): Promise<{ recorded: boolean; reason?: string; atMs?: number }> => {
    if (!isHeartbeatService(args.serviceName)) {
      return { recorded: false, reason: "service_unknown" };
    }
    const serviceName: HeartbeatService = args.serviceName;
    const status: "ok" | "degraded" = args.status === "degraded" ? "degraded" : "ok";
    const atMs = Date.now();
    await ctx.db.insert("healthHeartbeats", { serviceName, status, atMs });
    const tail = await ctx.db
      .query("healthHeartbeats")
      .withIndex("by_service_time", (q) => q.eq("serviceName", serviceName))
      .order("desc")
      .take(HEARTBEATS_KEPT_PER_SERVICE + 1);
    for (const row of tail.slice(HEARTBEATS_KEPT_PER_SERVICE)) {
      await ctx.db.delete(row._id);
    }
    await emitDiagnosticEvent(ctx, {
      kind: "ops.health.heartbeat",
      metadata: [
        { key: "serviceName", value: serviceName },
        { key: "status", value: status },
      ],
      serviceName,
    });
    return { recorded: true, atMs };
  },
});

export interface CostEntryInput {
  period: string;
  provider: string;
  category: string;
  amountMinor: number;
  basis: "observed" | "estimate";
  label?: string;
  dedupKey?: string;
}

const LABEL_FORMAT = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function isSpendProvider(value: string): value is (typeof SPEND_PROVIDERS)[number] {
  return (SPEND_PROVIDERS as readonly string[]).includes(value);
}

/** Validates one cost entry shape (closed providers, PLN minor, UTC month). */
export function validateCostEntry(
  input: CostEntryInput,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidPeriod(input.period)) {
    return { ok: false, reason: "period_invalid" };
  }
  if (!isSpendProvider(input.provider)) {
    return { ok: false, reason: "provider_unknown" };
  }
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(input.category)) {
    return { ok: false, reason: "category_invalid" };
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0 || input.amountMinor > 1e10) {
    return { ok: false, reason: "amount_invalid" };
  }
  if (input.basis !== "observed" && input.basis !== "estimate") {
    return { ok: false, reason: "basis_invalid" };
  }
  if (input.label !== undefined && !LABEL_FORMAT.test(input.label)) {
    return { ok: false, reason: "label_invalid" };
  }
  return { ok: true };
}

async function insertCostEntry(ctx: MutationCtx, input: CostEntryInput) {
  const validation = validateCostEntry(input);
  if (!validation.ok) {
    return { recorded: false, reason: validation.reason };
  }
  const provider = input.provider as (typeof SPEND_PROVIDERS)[number];
  if (input.dedupKey !== undefined) {
    const existing = await ctx.db
      .query("costEntries")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey as string))
      .first();
    if (existing !== null) {
      return { recorded: false, reason: "deduplicated" };
    }
  }
  const recordedAtMs = Date.now();
  await ctx.db.insert("costEntries", {
    period: input.period,
    provider,
    category: input.category,
    amountMinor: input.amountMinor,
    basis: input.basis,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
    recordedAtMs,
  });
  await emitDiagnosticEvent(ctx, {
    kind: "ops.cost.entry",
    metadata: [
      { key: "provider", value: provider },
      { key: "category", value: input.category },
      { key: "costMinor", value: String(input.amountMinor) },
      { key: "period", value: input.period },
      { key: "basis", value: input.basis },
    ],
    ...(input.dedupKey === undefined ? {} : { dedupKey: `cost:${input.dedupKey}` }),
  });
  return { recorded: true, recordedAtMs };
}

/** Records one all-in spend entry (metered-compute/AI spend accounting hook). */
export const recordCostEntry = internalMutation({
  args: {
    period: v.string(),
    provider: v.string(),
    category: v.string(),
    amountMinor: v.float64(),
    basis: v.string(),
    label: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean; reason?: string; recordedAtMs?: number }> =>
    insertCostEntry(ctx, {
      period: args.period,
      provider: args.provider,
      category: args.category,
      amountMinor: args.amountMinor,
      basis: args.basis === "observed" ? "observed" : "estimate",
      ...(args.label === undefined ? {} : { label: args.label }),
      ...(args.dedupKey === undefined ? {} : { dedupKey: args.dedupKey }),
    }),
});

// --- monitors -------------------------------------------------------------------

/**
 * Monitor scan 1 (processing/save incidents): reads the A3 surfaces and
 * emits one deduplicated redacted diagnostic per standing incident
 * (attempts-exhausted durable jobs, failed outbox rows, stuck runs).
 */
export const scanIncidents = internalMutation({
  args: {},
  handler: async (ctx): Promise<IncidentScanSummary> => {
    const nowMs = Date.now();
    const jobs = await ctx.db.query("durableJobs").collect();
    // Indexed scan: only failed rows can be delivery incidents (the
    // by_delivery index leads with deliveryState).
    const outbox = await ctx.db
      .query("outboxEvents")
      .withIndex("by_delivery", (q) => q.eq("deliveryState", "failed"))
      .collect();
    const runs = await ctx.db.query("processingRuns").collect();
    const incidents = classifyIncidents(
      {
        jobs: jobs.map((job) => ({
          jobKey: job.jobKey,
          kind: job.kind,
          state: job.state,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          ...(job.lastErrorKind === undefined ? {} : { lastErrorKind: job.lastErrorKind }),
        })),
        outbox: outbox.map((row) => ({
          eventId: row.eventId,
          eventName: row.eventName,
          deliveryState: row.deliveryState,
          attempts: row.attempts,
          ...(row.lastErrorKind === undefined ? {} : { lastErrorKind: row.lastErrorKind }),
        })),
        runs: runs.map((run) => ({
          runId: run._id,
          state: run.state,
          startedAtMs: run.startedAtMs,
        })),
      },
      nowMs,
    );
    const emitted = [];
    for (const incident of incidents) {
      const result = await emitDiagnosticEvent(ctx, {
        kind: incident.kind,
        metadata: incident.metadata,
        dedupKey: incident.dedupKey,
      });
      emitted.push({
        kind: incident.kind,
        emitted: result.emitted,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    }
    return { scannedAtMs: nowMs, incidents: incidents.length, emitted };
  },
});

/**
 * Monitor scan 3 (costs/limits): aggregates the current UTC month, evaluates
 * the 400/500 PLN thresholds and emits alerts under the per-level cooldown.
 */
export const evaluateCostAlerts = internalMutation({
  args: {},
  handler: async (ctx): Promise<CostEvaluation> => {
    const nowMs = Date.now();
    const period = periodOf(nowMs);
    const entries = await ctx.db
      .query("costEntries")
      .withIndex("by_period_provider", (q) => q.eq("period", period))
      .collect();
    const { perProvider, totalMinor } = sumCostEntries(entries);
    const thresholds = evaluateCostThresholds(totalMinor);

    const alertState = async (level: CostAlertLevel) =>
      ctx.db
        .query("costAlertStates")
        .withIndex("by_period_level", (q) => q.eq("period", period).eq("level", level))
        .first();

    const levels: readonly { level: CostAlertLevel; active: boolean; thresholdMinor: number; kind: "ops.cost.threshold_warning" | "ops.cost.threshold_alert" }[] = [
      { level: "warning_400", active: thresholds.warning, thresholdMinor: COST_THRESHOLDS.warningMinor, kind: "ops.cost.threshold_warning" },
      { level: "alert_500", active: thresholds.alert, thresholdMinor: COST_THRESHOLDS.alertMinor, kind: "ops.cost.threshold_alert" },
    ];

    const results = [];
    for (const entry of levels) {
      const existing = await alertState(entry.level);
      const cooldown = shouldEmitCostAlert(
        existing === null
          ? null
          : { level: existing.level as CostAlertLevel, lastFiredAtMs: existing.lastFiredAtMs },
        entry.level,
        nowMs,
      );
      let fired = false;
      if (entry.active && cooldown.emit) {
        await emitDiagnosticEvent(ctx, {
          kind: entry.kind,
          metadata: [
            { key: "period", value: period },
            { key: "totalMinor", value: String(totalMinor) },
            { key: "thresholdMinor", value: String(entry.thresholdMinor) },
            { key: "level", value: entry.level },
          ],
          dedupKey: costAlertDedupKey(
            entry.level,
            period,
            existing === null ? 1 : existing.fireCount + 1,
          ),
        });
        fired = true;
        const fireCount = existing === null ? 1 : existing.fireCount + 1;
        if (existing === null) {
          await ctx.db.insert("costAlertStates", {
            period,
            level: entry.level,
            thresholdMinor: entry.thresholdMinor,
            firstFiredAtMs: nowMs,
            lastFiredAtMs: nowMs,
            fireCount,
            lastTotalMinor: totalMinor,
          });
        } else {
          await ctx.db.patch(existing._id, {
            lastFiredAtMs: nowMs,
            fireCount,
            lastTotalMinor: totalMinor,
          });
        }
      }
      results.push({
        level: entry.level,
        active: entry.active,
        fired,
        ...(cooldown.emit ? {} : { suppressed: cooldown.reason }),
        ...(existing === null ? {} : { lastFiredAtMs: existing.lastFiredAtMs }),
      });
    }

    return { period, totalMinor, perProvider, thresholds, results };
  },
});

/** Windowed retention: prunes expired diagnostics and stale cost history. */
export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<PruneSummary> => {
    const nowMs = Date.now();
    const expiredEvents = await ctx.db
      .query("diagnosticEvents")
      .withIndex("by_time", (q) => q.lt("atMs", retentionCutoffMs(nowMs)))
      .take(PRUNE_BATCH_SIZE);
    for (const row of expiredEvents) {
      await ctx.db.delete(row._id);
    }
    const periodCutoff = costPeriodCutoff(nowMs);
    const expiredCosts = await ctx.db
      .query("costEntries")
      .withIndex("by_period_provider", (q) => q.lt("period", periodCutoff))
      .take(PRUNE_BATCH_SIZE);
    for (const row of expiredCosts) {
      await ctx.db.delete(row._id);
    }
    const expiredAlertStates = await ctx.db
      .query("costAlertStates")
      .withIndex("by_period_level", (q) => q.lt("period", periodCutoff))
      .take(PRUNE_BATCH_SIZE);
    for (const row of expiredAlertStates) {
      await ctx.db.delete(row._id);
    }
    return {
      prunedDiagnostics: expiredEvents.length,
      prunedCostEntries: expiredCosts.length,
      prunedAlertStates: expiredAlertStates.length,
    };
  },
});

/** Bounded read of unforwarded events inside the forward window. */
export const unforwardedRecent = internalQuery({
  args: { sinceMs: v.float64() },
  handler: async (ctx, args): Promise<UnforwardedEventRow[]> => {
    const rows = await ctx.db
      .query("diagnosticEvents")
      .withIndex("by_time", (q) => q.gte("atMs", args.sinceMs))
      .order("desc")
      .take(50);
    const mapped: UnforwardedEventRow[] = [];
    for (const row of rows) {
      if (row.forwardedAtMs !== 0) {
        continue;
      }
      mapped.push({
        _id: row._id,
        kind: row.kind,
        technicalMetadata: row.technicalMetadata,
        redactionVersion: row.redactionVersion,
        atMs: row.atMs,
        ...(row.redactionsApplied === undefined ? {} : { redactionsApplied: row.redactionsApplied }),
        ...(row.serviceName === undefined ? {} : { serviceName: row.serviceName }),
        ...(row.environment === undefined ? {} : { environment: row.environment }),
      });
    }
    return mapped;
  },
});

/** Marks events delivered to the sink (idempotent). */
export const markForwarded = internalMutation({
  args: { ids: v.array(v.id("diagnosticEvents")), atMs: v.float64() },
  handler: async (ctx, args): Promise<{ marked: number }> => {
    for (const id of args.ids) {
      await ctx.db.patch(id, { forwardedAtMs: args.atMs });
    }
    return { marked: args.ids.length };
  },
});

/**
 * Monitor scan 2's emission half: reports services whose latest heartbeat
 * is beyond the silence threshold (`ops.health.silence_detected`), deduped
 * per silence episode (anchor = newest heartbeat atMs). Only services with
 * heartbeat history are emitted - never-seen lanes are the sink-side
 * absence monitor's coverage, not permanent in-app noise.
 */
export const detectSilence = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ silent: number; emitted: readonly { serviceName: string; emitted: boolean; reason?: string }[] }> => {
    const nowMs = Date.now();
    const latest = await latestHeartbeats(ctx);
    const incidents = silenceIncidents(latest, nowMs);
    const emitted: { serviceName: string; emitted: boolean; reason?: string }[] = [];
    for (const incident of incidents) {
      const result = await emitDiagnosticEvent(ctx, {
        kind: incident.kind,
        metadata: incident.metadata,
        dedupKey: incident.dedupKey,
      });
      const serviceName = incident.metadata[0]?.value ?? "unknown";
      emitted.push({
        serviceName,
        emitted: result.emitted,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    }
    return { silent: incidents.length, emitted };
  },
});

/** Seeds one stale heartbeat row (staging-proof fixture, guarded callers only). */
export const seedStaleHeartbeat = internalMutation({
  args: { serviceName: v.string(), ageMinutes: v.float64() },
  handler: async (ctx, args): Promise<{ seeded: boolean; atMs?: number; reason?: string }> => {
    if (!isHeartbeatService(args.serviceName)) {
      return { seeded: false, reason: "service_unknown" };
    }
    if (!Number.isInteger(args.ageMinutes) || args.ageMinutes < 1 || args.ageMinutes > 60 * 24 * 30) {
      return { seeded: false, reason: "age_invalid" };
    }
    const serviceName: HeartbeatService = args.serviceName;
    const atMs = Date.now() - args.ageMinutes * 60 * 1000;
    await ctx.db.insert("healthHeartbeats", { serviceName, status: "ok", atMs });
    return { seeded: true, atMs };
  },
});

/** Clears all heartbeat rows of one service (staging-proof cleanup, guarded). */
export const clearHeartbeats = internalMutation({
  args: { serviceName: v.string() },
  handler: async (ctx, args): Promise<{ removed: number }> => {
    if (!isHeartbeatService(args.serviceName)) {
      return { removed: 0 };
    }
    const serviceName: HeartbeatService = args.serviceName;
    const rows = await ctx.db
      .query("healthHeartbeats")
      .withIndex("by_service_time", (q) => q.eq("serviceName", serviceName))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { removed: rows.length };
  },
});

/** Removes labeled synthetic cost entries (staging-proof cleanup, guarded callers only). */
export const clearCostsByLabel = internalMutation({
  args: { label: v.string() },
  handler: async (ctx, args): Promise<{ removed: number; reason?: string }> => {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(args.label)) {
      return { removed: 0, reason: "label_invalid" };
    }
    const rows = await ctx.db.query("costEntries").collect();
    const affectedPeriods = new Set<string>();
    let removed = 0;
    for (const row of rows) {
      if (row.label === args.label) {
        affectedPeriods.add(row.period);
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    // Alert states of the affected periods are proof artifacts too.
    const alertStates = await ctx.db.query("costAlertStates").collect();
    for (const state of alertStates) {
      if (affectedPeriods.has(state.period)) {
        await ctx.db.delete(state._id);
      }
    }
    return { removed };
  },
});

// --- reads -------------------------------------------------------------------------

async function latestHeartbeats(ctx: QueryCtx) {
  const latest: Record<string, { atMs: number; status: "ok" | "degraded" }> = {};
  for (const service of HEARTBEAT_SERVICES) {
    const row = await ctx.db
      .query("healthHeartbeats")
      .withIndex("by_service_time", (q) => q.eq("serviceName", service))
      .order("desc")
      .first();
    if (row !== null) {
      latest[service] = { atMs: row.atMs, status: row.status };
    }
  }
  return latest;
}

async function composedState(ctx: QueryCtx): Promise<ComposedTelemetryState> {
  const nowMs = Date.now();
  const period = periodOf(nowMs);
  const recentEvents = await ctx.db
    .query("diagnosticEvents")
    .withIndex("by_time")
    .order("desc")
    .take(20);
  const costEntries = await ctx.db
    .query("costEntries")
    .withIndex("by_period_provider", (q) => q.eq("period", period))
    .collect();
  const { perProvider, totalMinor } = sumCostEntries(costEntries);
  const thresholds = evaluateCostThresholds(totalMinor);
  const alertStates = await ctx.db
    .query("costAlertStates")
    .withIndex("by_period_level", (q) => q.eq("period", period))
    .collect();
  const silence = backendSilenceState(await latestHeartbeats(ctx), nowMs);
  return {
    atMs: nowMs,
    observability: OBSERVABILITY_HONESTY,
    diagnostics: {
      recent: recentEvents.map((row) => ({
        kind: row.kind,
        technicalMetadata: row.technicalMetadata,
        ...(row.redactionsApplied === undefined ? {} : { redactionsApplied: row.redactionsApplied }),
        ...(row.serviceName === undefined ? {} : { serviceName: row.serviceName }),
        redactionVersion: row.redactionVersion,
        forwardedAtMs: row.forwardedAtMs,
        atMs: row.atMs,
      })),
    },
    health: silence,
    costs: {
      period,
      perProvider,
      totalMinor,
      thresholds,
      alertStates: alertStates.map((row) => ({
        level: row.level,
        thresholdMinor: row.thresholdMinor,
        firstFiredAtMs: row.firstFiredAtMs,
        lastFiredAtMs: row.lastFiredAtMs,
        fireCount: row.fireCount,
        lastTotalMinor: row.lastTotalMinor,
      })),
    },
  };
}

/** Public composed telemetry state (redacted by construction; no tenant content). */
export const telemetryOverview = query({
  args: {},
  handler: async (ctx): Promise<ComposedTelemetryState> => composedState(ctx),
});

/** Internal composed read (HTTP surface, proof scripts, later GM panels). */
export const telemetryState = internalQuery({
  args: {},
  handler: async (ctx): Promise<ComposedTelemetryState> => composedState(ctx),
});
