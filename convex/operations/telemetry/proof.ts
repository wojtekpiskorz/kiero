/**
 * The guarded telemetry proof surface (I2), same pattern as A3's probe
 * (`KIERO_PROBE_ENABLED` deployment variable; actions check the variable and
 * run internal functions, so evidence scripts never depend on scheduler
 * timing while the entries stay unreachable with the guard off).
 *
 * - `probeEmit`: emits one raw payload through the REAL sanitized write path.
 * - `probeState`: reads the composed telemetry state back.
 * - `probeTick`: runs the cron orchestrator once (incidents, costs, prune,
 *   forward) and returns the summary.
 * - `probeSeedCost` / `probeClearCosts`: seed and remove labeled synthetic
 *   cost entries for threshold-crossing proofs without polluting accounting.
 */

import { v } from "convex/values";
import { action } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("operations.telemetry.probe", "probe_guard_disabled"));
}

/** Emits one raw payload through the real sanitized path (guarded). */
export const probeEmit = action({
  args: { payload: v.any(), dedupKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.telemetry.functions.recordEvent, {
        payload: args.payload,
        ...(args.dedupKey === undefined ? {} : { dedupKey: args.dedupKey }),
      }),
    );
  },
});

/** Reads the composed telemetry state (guarded). */
export const probeState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runQuery(internal.operations.telemetry.functions.telemetryState, {}));
  },
});

/** Runs the cron orchestrator once (guarded). */
export const probeTick = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runAction(internal.operations.telemetry.cron.cronTick, {}));
  },
});

/** Seeds one labeled synthetic cost entry (guarded; staging proofs only). */
export const probeSeedCost = action({
  args: {
    period: v.string(),
    provider: v.string(),
    category: v.string(),
    amountMinor: v.float64(),
    basis: v.optional(v.string()),
    label: v.string(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.telemetry.functions.recordCostEntry, {
        period: args.period,
        provider: args.provider,
        category: args.category,
        amountMinor: args.amountMinor,
        basis: args.basis === "observed" ? "observed" : "estimate",
        label: args.label,
        dedupKey: `probe:${args.label}:${args.provider}:${args.category}:${args.amountMinor}`,
      }),
    );
  },
});

/** Seeds one stale heartbeat row (guarded; silence-loop proofs). */
export const probeSeedStaleHeartbeat = action({
  args: { serviceName: v.string(), ageMinutes: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.telemetry.functions.seedStaleHeartbeat, {
        serviceName: args.serviceName,
        ageMinutes: args.ageMinutes,
      }),
    );
  },
});

/** Clears all heartbeat rows of one service (guarded; cleanup). */
export const probeClearHeartbeats = action({
  args: { serviceName: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.telemetry.functions.clearHeartbeats, {
        serviceName: args.serviceName,
      }),
    );
  },
});

/** Removes labeled synthetic cost entries and the period's alert states (guarded). */
export const probeClearCosts = action({
  args: { label: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.telemetry.functions.clearCostsByLabel, {
        label: args.label,
      }),
    );
  },
});
