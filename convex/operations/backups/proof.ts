/**
 * The guarded backups proof surface (I5), the A3/I2 probe pattern: actions
 * check the deployment variable `KIERO_PROBE_ENABLED` and then run the REAL
 * internal functions, so live evidence (tests/i5/live-proof.mjs) never
 * depends on scheduler timing or the service credential while the entries
 * stay unreachable with the guard off.
 *
 * - `probeBegin` / `probeComplete` / `probeFail` / `probeSweep` /
 *   `probeSweepComplete` / `probeTick`: the exact protocol the worker's HTTP
 *   boundary runs, minus the bearer (the guard replaces it).
 * - `probeState`: the composed backups state read.
 * - `probeSeedRetainedMedia` / `probeSeedDeletion`: dev fixtures for the
 *   D3 inventory and the I4 ledger seams.
 * - `probeSeedManifest`: past-dated retention fixtures (48h/14d sweeps and
 *   deleted-source expiry verification without time travel).
 * - `probeClear`: removes this lane's proof artifacts between passes.
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
  return errorResult(unsupportedError("operations.backups.probe", "probe_guard_disabled"));
}

/** Acquires (or refuses) the current slot's run lease. */
export const probeBegin = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.functions.beginRun, {}),
    );
  },
});

/** Runs the server-side closure verification for one manifest. */
export const probeComplete = action({
  args: {
    manifestId: v.string(),
    attempt: v.float64(),
    database: v.object({ sha256: v.string(), bytes: v.float64() }),
    media: v.array(v.object({ objectKey: v.string(), sha256: v.string(), bytes: v.float64() })),
    ledger: v.object({ sha256: v.string(), bytes: v.float64(), count: v.float64() }),
    manifestHash: v.string(),
    droppedPurged: v.array(v.object({ objectKey: v.string(), sourceId: v.string() })),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.functions.completeRun, args),
    );
  },
});

/** Records a typed run failure. */
export const probeFail = action({
  args: { manifestId: v.string(), attempt: v.float64(), reason: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runMutation(internal.operations.backups.functions.failRun, args));
  },
});

/** Reads the reference-aware retention sweep plan. */
export const probeSweep = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runQuery(internal.operations.backups.functions.sweepPlan, {}));
  },
});

/** Applies a finished sweep (idempotent). */
export const probeSweepComplete = action({
  args: {
    collectedManifestIds: v.array(v.string()),
    deletedObjectKeys: v.array(v.string()),
    orphanKeysRemoved: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.functions.sweepComplete, args),
    );
  },
});

/** Runs the cron tick once (freshness check + due-slot ping). */
export const probeTick = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runAction(internal.operations.backups.functions.backupTick, {}));
  },
});

/** Reads the composed backups state. */
export const probeState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runQuery(internal.operations.backups.functions.backupsState, {}));
  },
});

/** Seeds one retained-media fixture row (D3 inventory seam; dev proof only). */
export const probeSeedRetainedMedia = action({
  args: {
    objectKey: v.string(),
    contentHash: v.string(),
    bytes: v.float64(),
    transformVersion: v.string(),
    sourceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.proofFixtures.seedRetainedMedia, args),
    );
  },
});

/** Seeds one content-free deletion/revocation ledger row (I4 seam). */
export const probeSeedDeletion = action({
  args: {
    kind: v.string(),
    targetSourceId: v.optional(v.string()),
    scopeSummary: v.string(),
    ageMinutes: v.float64(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.proofFixtures.seedDeletion, args),
    );
  },
});

/** Seeds one past-dated manifest row (retention fixtures; dev proof only). */
export const probeSeedManifest = action({
  args: {
    slotAgeMinutes: v.float64(),
    state: v.string(),
    mediaObjectKeys: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations.backups.proofFixtures.seedManifest, args),
    );
  },
});

/** Removes every recovery-manifest row (proof cleanup between passes). */
export const probeClear = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(await ctx.runMutation(internal.operations.backups.proofFixtures.clear, {}));
  },
});
