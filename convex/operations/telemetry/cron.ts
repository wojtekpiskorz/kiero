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
 *
 * R27 (issue #235): the sink forward's outcome is recorded durably - the
 * closed status class of every attempt (refused, unreachable, ok) persists
 * on the attempted event rows and on the `telemetry.sink` tick ledger row
 * (see ./forward.ts), so a failing Convex->Axiom leg is diagnosable from
 * the health surfaces instead of indistinguishable from a dead cron.
 */

import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import {
  axiomHttpSink,
  nullSink,
  toSinkEvent,
  SINK_REASON_NOT_CONFIGURED,
  type SinkIngestResult,
} from "./sink";
import { FORWARD_WINDOW_MS } from "./retention";
import { classifySinkResult, type ForwardStatus } from "./forward";
import { deploymentEnvironment } from "@kiero/runtime";

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
  readonly forwarded: SinkIngestResult & {
    readonly attempted: number;
    /** R27: the attempt's closed status class (the durable copy is persisted). */
    readonly status: ForwardStatus;
  };
}

async function forwardRecentToSink(
  ctx: ActionCtx,
): Promise<SinkIngestResult & { attempted: number; status: ForwardStatus }> {
  const apiToken = process.env.AXIOM_API_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  const sink =
    apiToken !== undefined && apiToken !== "" && dataset !== undefined && dataset !== ""
      ? axiomHttpSink({ apiToken, dataset })
      : nullSink(SINK_REASON_NOT_CONFIGURED);

  // The deployment's closed environment label through the ONE shared rule
  // (R13: this read previously lived as one of five drifting copies).
  const environment = deploymentEnvironment(process.env.KIERO_ENVIRONMENT);

  const nowMs = Date.now();
  const recent = await ctx.runQuery(internal.operations.telemetry.functions.unforwardedRecent, {
    sinceMs: nowMs - FORWARD_WINDOW_MS,
  });
  if (recent.length === 0) {
    // No attempt happened, but the tick itself ran: record the liveness row
    // (no status class claimed) so an empty window never looks like silence.
    await ctx.runMutation(internal.operations.telemetry.functions.markForwarded, {
      ids: [],
      atMs: nowMs,
    });
    return { ok: true, ingested: 0, attempted: 0, status: "ok" };
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
  // R27 (issue #235): the outcome is no longer dropped. Both classes land in
  // markForwarded - "ok" marks the rows delivered, a refusal persists the
  // class on them and on the telemetry.sink tick row the health surface reads.
  const status = classifySinkResult(result);
  await ctx.runMutation(internal.operations.telemetry.functions.markForwarded, {
    ids: recent.map((row) => row._id),
    atMs: nowMs,
    status,
  });
  return { ...result, attempted: events.length, status };
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
