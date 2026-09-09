/**
 * The telemetry cron orchestrator (I2).
 *
 * Kept in its own module (not `functions.ts`) deliberately: a Convex module
 * whose own exports are referenced through `internal` from INSIDE the same
 * module creates a type cycle through the generated api and those exports
 * drop out of the generated type. Cross-module references (this file) are
 * the sanctioned pattern - the same reason A3's probe actions live apart
 * from the mutations they drive.
 *
 * `cronTick` runs every minute from convex/crons.ts: incident scan, cost
 * threshold evaluation, windowed retention, then best-effort sink forward.
 */

import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { axiomHttpSink, nullSink, toSinkEvent, type SinkIngestResult } from "./sink";
import { FORWARD_WINDOW_MS } from "./retention";

/** Summary of one telemetry tick. */
export interface CronTickSummary {
  readonly incidents: number;
  readonly silence: { readonly silent: number };
  readonly costs: { readonly period: string; readonly totalMinor: number };
  readonly pruned: {
    readonly prunedDiagnostics: number;
    readonly prunedCostEntries: number;
    readonly prunedAlertStates: number;
  };
  readonly forwarded: SinkIngestResult & { readonly attempted: number };
}

async function forwardRecentToSink(
  ctx: ActionCtx,
): Promise<SinkIngestResult & { attempted: number }> {
  const apiToken = process.env.AXIOM_API_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  const sink =
    apiToken !== undefined && apiToken !== "" && dataset !== undefined && dataset !== ""
      ? axiomHttpSink({ apiToken, dataset })
      : nullSink("axiom_not_configured");

  const rawEnvironment = process.env.KIERO_ENVIRONMENT ?? "dev";
  const environment = /^(dev|staging|alpha-production)$/.test(rawEnvironment)
    ? rawEnvironment
    : "dev";

  const nowMs = Date.now();
  const recent = await ctx.runQuery(internal.operations.telemetry.functions.unforwardedRecent, {
    sinceMs: nowMs - FORWARD_WINDOW_MS,
  });
  if (recent.length === 0) {
    return { ok: true, ingested: 0, attempted: 0 };
  }
  const events = recent.map((row) =>
    toSinkEvent(
      {
        kind: row.kind,
        metadata: row.technicalMetadata.map((entry) => ({ key: entry.key, value: entry.value })),
        redactionsApplied: row.redactionsApplied ?? 0,
        redactionVersion: row.redactionVersion,
        ...(row.serviceName === undefined ? {} : { serviceName: row.serviceName }),
        ...(row.environment === undefined ? {} : { environment: row.environment }),
      },
      row.atMs,
      "convex",
      environment,
    ),
  );
  const result = await sink.ingest(events);
  if (result.ok) {
    await ctx.runMutation(internal.operations.telemetry.functions.markForwarded, {
      ids: recent.map((row) => row._id),
      atMs: nowMs,
    });
  }
  return { ...result, attempted: events.length };
}

/** The every-minute telemetry tick registered in convex/crons.ts. */
export const cronTick = internalAction({
  args: {},
  handler: async (ctx): Promise<CronTickSummary> => {
    const incidents = await ctx.runMutation(
      internal.operations.telemetry.functions.scanIncidents,
      {},
    );
    const silence = await ctx.runMutation(
      internal.operations.telemetry.functions.detectSilence,
      {},
    );
    const costs = await ctx.runMutation(
      internal.operations.telemetry.functions.evaluateCostAlerts,
      {},
    );
    const pruned = await ctx.runMutation(internal.operations.telemetry.functions.pruneExpired, {});
    const forwarded = await forwardRecentToSink(ctx);
    return {
      incidents: incidents.incidents,
      silence: { silent: silence.silent },
      costs: { period: costs.period, totalMinor: costs.totalMinor },
      pruned,
      forwarded,
    };
  },
});
