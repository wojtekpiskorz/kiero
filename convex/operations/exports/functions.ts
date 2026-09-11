/**
 * The export lane's callable entries (I3): the checked boss command surface,
 * the boss status query, the per-user download channel query, and the
 * service-credentialed build-channel queries/mutations the export Worker's
 * bridge calls.
 *
 * `dispatchExports` follows the C4/B3 pattern: envelope decode -> B1
 * identity resolution (with provisioning) -> the lane policy -> contract
 * decode -> `operations.requestExport`, whose intent is `administer`: only
 * a CURRENT administrator can start an export, decided from the resolved
 * membership role on every request.
 *
 * `exportsStatus` is the boss-facing status read (the F3 pushState
 * precedent): every export of the caller's company with its lifecycle
 * state and declared snapshot time; never the object key, etag or any
 * storage identity.
 *
 * The build-channel entries run under the deployment's service credential
 * (verified by the HTTP boundary before dispatch): `snapshotForBuild` reads
 * the whole company snapshot in ONE transaction (consistency by Convex's
 * serializable snapshot), `publishForBuild` is the only transition to
 * `available`, and the token gates keep retries from diverging.
 */

import { v } from "convex/values";
import { internal } from "../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../../_generated/server";
import { dispatchCommand, type HandlerRegistry } from "@kiero/runtime";
import { errorResult, okResult, operationsOperations, type ResultEnvelope } from "@kiero/contracts";
import { membershipPolicy, unauthenticatedError, unsupportedError, validationError } from "@kiero/runtime";
import { Schema } from "effect";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextFromConvexAuth,
  resolveAccessContextWithProvisioning,
} from "../../access/identity/resolution";
import { requestExportCore, publishArchiveCore, failBuildCore, markCleanedCore, expireExportCore, invalidateExportCore, invalidateExportsForSourceCore } from "./lifecycle";
import { readCompanySnapshot, snapshotDb } from "./snapshot";
import { resolveExportAccess, exportAccessDb } from "./access";
import { EXPORT_STATE_LABELS } from "./protocol";
import {
  BuildSnapshotRequest,
  FailBuildRequest,
  PublishArchiveRequest,
} from "./channel";

/** The Polish label type of the status screen. */
type ExportStateLabel = (typeof EXPORT_STATE_LABELS)[keyof typeof EXPORT_STATE_LABELS];

// ---------------------------------------------------------------------------
// The boss command surface (checked dispatch).
// ---------------------------------------------------------------------------

const requestExportEntry = operationsOperations["operations.requestExport"];
type RequestExportInput = Schema.Schema.Type<typeof requestExportEntry.input>;

/** The lane's policy registration (administer intent = current administrator). */
export const exportsLanePolicy = membershipPolicy;

async function performRequestExport(
  tx: MutationCtx,
  context: { readonly actor: { readonly companyId: string; readonly userId: string } },
  _input: RequestExportInput,
): Promise<ResultEnvelope> {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const result = await requestExportCore(tx, companyId, userId, Date.now());
  return okResult({ exportId: result.exportId, state: result.state });
}

/** Handler table for the company-scoped exports dispatch (exported for tests). */
export function exportsHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "operations.requestExport": {
      intent: "administer",
      run: async (tx, context, input) =>
        performRequestExport(tx, context, Schema.decodeUnknownSync(requestExportEntry.input)(input)),
    },
  };
}

/** The checked dispatch entry the web feature calls. */
export const dispatchExports = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    await dispatchCommand(
      {
        resolveContext: (tx) =>
          resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
        policy: exportsLanePolicy,
        handlers: exportsHandlers(),
      },
      ctx,
      args.envelope,
    ),
});

// ---------------------------------------------------------------------------
// The boss status read.
// ---------------------------------------------------------------------------

/** One export as the status screen shows it (no storage identities). */
export interface ExportStatusRow {
  readonly exportId: string;
  readonly state: ExportStateLabel;
  readonly stateRaw: string;
  readonly createdAtMs: number;
  readonly snapshotAtMs: number | null;
  readonly availableUntilMs: number | null;
  readonly completedAtMs: number | null;
  readonly failureKind: string | null;
  readonly invalidationReason: string | null;
  readonly cleanedAtMs: number | null;
  readonly sourceCount: number | null;
  readonly mediaCount: number | null;
}

export const exportsStatus = query({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return errorResult(validationError("company_scope_unresolved"));
    }
    const rows = await ctx.db
      .query("exports")
      .withIndex("by_company_created", (q) => q.eq("companyId", companyId))
      .order("desc")
      .take(50);
    return okResult({
      exports: rows.map((row): ExportStatusRow => ({
        exportId: row._id,
        state: EXPORT_STATE_LABELS[row.state],
        stateRaw: row.state,
        createdAtMs: row.createdAtMs,
        snapshotAtMs: row.snapshotAtMs ?? null,
        availableUntilMs: row.availableUntilMs ?? null,
        completedAtMs: row.completedAtMs ?? null,
        failureKind: row.failureKind ?? null,
        invalidationReason: row.invalidationReason ?? null,
        cleanedAtMs: row.cleanedAtMs ?? null,
        sourceCount: row.sourceCount ?? null,
        mediaCount: row.mediaCount ?? null,
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// The per-user download channel (the HTTP boundary forwards the browser's
// credential; ctx.auth resolves the acting user).
// ---------------------------------------------------------------------------

export const exportAccessFor = internalMutation({
  args: { exportId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    const outcome = await resolveExportAccess(exportAccessDb(ctx.db), context, args, Date.now());
    if (outcome.invalidateExportId !== undefined) {
      // The linked-purge refusal: run the row through the ONE invalidation
      // transition (patch + event + cleanup schedule), so this lazy path
      // strands no archive bytes either (the refusal already happened; the
      // marking is best-effort).
      await invalidateExportCore(ctx, outcome.invalidateExportId, "source_purged", Date.now());
    }
    return outcome.result;
  },
});

// ---------------------------------------------------------------------------
// The service-credentialed build channel (the Worker bridge dispatches here).
// ---------------------------------------------------------------------------

/** The whole company snapshot of one build attempt (ONE transaction). */
export const snapshotForBuild = internalQuery({
  args: { exportId: v.string(), buildToken: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const input = Schema.decodeUnknownOption(BuildSnapshotRequest)(args);
    if (input._tag === "None") {
      return errorResult(validationError("build_reference_malformed"));
    }
    const exportId = ctx.db.normalizeId("exports", input.value.exportId);
    if (exportId === null) {
      return errorResult(validationError("build_reference_malformed"));
    }
    const row = await ctx.db.get(exportId);
    if (row === null) {
      return errorResult(validationError("export_not_found"));
    }
    if (row.state !== "building" || row.buildToken !== input.value.buildToken) {
      return errorResult(validationError("build_token_stale"));
    }
    const snapshot = await readCompanySnapshot(
      snapshotDb(ctx.db as Parameters<typeof snapshotDb>[0]),
      row.companyId,
      exportId,
      Date.now(),
    );
    if (!snapshot.ok) {
      return errorResult(validationError(`bound_exceeded:${snapshot.refusal.kind === "bound_exceeded" ? snapshot.refusal.bound : snapshot.refusal.kind}`));
    }
    return okResult(snapshot.snapshot);
  },
});

/** The Worker's publish (the only transition to `available`). */
export const publishForBuild = internalMutation({
  args: {
    exportId: v.string(),
    buildToken: v.string(),
    objectKey: v.string(),
    etag: v.string(),
    bytes: v.float64(),
    snapshotAtMs: v.float64(),
    schemaVersion: v.string(),
    sourceIds: v.array(v.string()),
    mediaCount: v.float64(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const input = Schema.decodeUnknownOption(PublishArchiveRequest)(args);
    if (input._tag === "None") {
      return errorResult(validationError("publish_reference_malformed"));
    }
    const outcome = await publishArchiveCore(ctx, input.value, Date.now());
    if (outcome.outcome === "published") {
      return okResult({ published: true, availableUntilMs: outcome.availableUntilMs });
    }
    if (outcome.outcome === "invalidated") {
      return okResult({ published: false, invalidated: true, sourceId: outcome.sourceId });
    }
    return errorResult(validationError(`publish_refused:${outcome.reason}`));
  },
});

/** The Worker's honest build failure (typed, sanitized kind). */
export const failForBuild = internalMutation({
  args: { exportId: v.string(), buildToken: v.string(), failureKind: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const input = Schema.decodeUnknownOption(FailBuildRequest)(args);
    if (input._tag === "None") {
      return errorResult(validationError("fail_reference_malformed"));
    }
    const exportId = ctx.db.normalizeId("exports", input.value.exportId);
    if (exportId === null) {
      return errorResult(validationError("export_not_found"));
    }
    const outcome = await failBuildCore(ctx, exportId, input.value.buildToken, input.value.failureKind, Date.now());
    return okResult({ failed: outcome === "failed" });
  },
});

/** What the cleanup action sends the Worker: the expired/invalidated object. */
export const cleanupTargetFor = internalQuery({
  args: { exportId: v.string() },
  handler: async (ctx, args) => {
    const exportId = ctx.db.normalizeId("exports", args.exportId);
    if (exportId === null) {
      return null;
    }
    const row = await ctx.db.get(exportId);
    if (row === null || row.objectKey === undefined || row.cleanedAtMs !== undefined) {
      return null;
    }
    if (row.state === "expired" || row.state === "invalidated" || row.state === "failed") {
      return { exportId: row._id, objectKey: row.objectKey };
    }
    return null;
  },
});

/** The Worker's confirmation that the bytes are gone. */
export const cleanupDone = internalMutation({
  args: { exportId: v.string() },
  handler: async (ctx, args) => {
    const exportId = ctx.db.normalizeId("exports", args.exportId);
    if (exportId === null) {
      return;
    }
    await markCleanedCore(ctx, exportId, Date.now());
  },
});

/** The expiry sweep (scheduled at publish time). */
export const sweepExpiry = internalMutation({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    await expireExportCore(ctx, args.exportId, Date.now());
  },
});

/** The job row's export id (the external action's lookup). */
export const jobExportFor = internalQuery({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.query("durableJobs").withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey)).first();
    if (job === null || job.kind !== "exports.build_archive") {
      return null;
    }
    return { exportId: (JSON.parse(job.inputJson) as { exportId: string }).exportId };
  },
});

/** The build attempt's current state and token (the action's re-read). */
export const buildAttemptFor = internalQuery({
  args: { exportId: v.string() },
  handler: async (ctx, args) => {
    const exportId = ctx.db.normalizeId("exports", args.exportId);
    if (exportId === null) {
      return null;
    }
    const row = await ctx.db.get(exportId);
    if (row === null) {
      return null;
    }
    return { state: row.state, buildToken: row.buildToken ?? null };
  },
});

// ---------------------------------------------------------------------------
// The seam I4 consumes: eager invalidation when a source is purged. I4's
// purge executor (and the guarded proof) calls this internal mutation; the
// per-request download check is the immediate guard either way.
// ---------------------------------------------------------------------------

export const invalidateForPurgedSource = internalMutation({
  args: { sourceId: v.id("sources"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const invalidated = await invalidateExportsForSourceCore(
      ctx,
      args.sourceId,
      args.reason ?? "source_purged",
      Date.now(),
    );
    return { invalidated };
  },
});

// ---------------------------------------------------------------------------
// The scheduled byte cleanup: the export Worker deletes the archive object
// (it owns the bucket binding); this action drives it and marks the row.
// ---------------------------------------------------------------------------

/**
 * One bounded cleanup attempt: no target (already cleaned or never
 * published) completes immediately; a configured Worker deletes the object
 * and the row records `cleanedAtMs`. Failures are retried by the scheduler.
 */
export const cleanupExport = internalAction({
  args: { exportId: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.operations.exports.functions.cleanupTargetFor, {
      exportId: args.exportId,
    });
    if (target === null) {
      return;
    }
    const url = process.env.KIERO_EXPORT_EXECUTOR_URL;
    const token = process.env.KIERO_SERVICE_TOKEN;
    if (url === undefined || url === "" || token === undefined || token === "") {
      throw new Error("cleanupExport: export executor not configured");
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/$/, "")}/exports/cleanup`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ exportId: target.exportId, objectKey: target.objectKey }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(deadline);
    }
    if (!response.ok) {
      // A retriable transport/refusal: the scheduler retries the action.
      throw new Error(`cleanupExport: worker refused (status ${response.status})`);
    }
    await ctx.runMutation(internal.operations.exports.functions.cleanupDone, {
      exportId: target.exportId,
    });
  },
});

// ---------------------------------------------------------------------------
// The guarded probe read (probe.ts exposes it to the live evidence).
// ---------------------------------------------------------------------------

export const probeStateInternal = internalQuery({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> => {
    if (process.env.KIERO_PROBE_ENABLED !== "1") {
      return errorResult(unsupportedError("operations.exports.probe", "probe_guard_disabled"));
    }
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return errorResult(validationError("company_scope_unresolved"));
    }
    const rows = await ctx.db.query("exports").withIndex("by_company_created", (q) => q.eq("companyId", companyId)).order("desc").collect();
    const links = await ctx.db.query("exportSourceLinks").collect();
    return okResult({
      exports: rows.map((row) => ({
        exportId: row._id,
        state: row.state,
        snapshotAtMs: row.snapshotAtMs ?? null,
        availableUntilMs: row.availableUntilMs ?? null,
        buildToken: row.buildToken ?? null,
        sourceCount: row.sourceCount ?? null,
        mediaCount: row.mediaCount ?? null,
        invalidationReason: row.invalidationReason ?? null,
        failureKind: row.failureKind ?? null,
        cleanedAtMs: row.cleanedAtMs ?? null,
      })),
      linksOfCompany: links.filter((link) => rows.some((row) => row._id === link.exportId)).length,
    });
  },
});
