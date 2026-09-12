/**
 * The permanent-deletion durable executor (I4): `deletion.purge_source`.
 *
 * The registered consumer of `sources.sourcePurged` (the projection this
 * lane owns in convex/platform/outbox.ts). The initiating transaction
 * already tombstoned the source, blanked its content, wrote the
 * content-free ledger row and the per-family stage rows, and invalidated
 * linked exports. This executor purges the DERIVATIVES, idempotently and
 * inspectably, inside the 24-hour window every stage row carries:
 *
 * - `findings_marking` (in transaction): findings whose current revision
 *   rested only on the purged source become explicitly unknown through the
 *   shared marking core (./marking.ts), and every marked root hands its
 *   dependents to the C5 cascade (`memory.dependentsMarkedStale` carriers).
 * - `transcripts` (in transaction): the source's transcript manifests and
 *   verbatim segment texts, vision orders, extraction versions and
 *   fragments are DELETED (this is permanent deletion, not withdrawal
 *   history); an in-flight change set of the source fails with the typed
 *   purge reason so a late AI plan cannot publish over the tombstone
 *   (E3's publish re-check stays the structural guard). R2 (issue #127):
 *   BEFORE the fragments leave, the clarification content linked through
 *   them (and through R1 resolution evidence) is purged in one idempotent
 *   per-source pass — associations removed, possibly derived text
 *   replaced with the fixed redaction copy, content-free audit metadata
 *   recorded, surviving ACTIVE references kept.
 * - `search_index` (in transaction): the source's derived search rows go
 *   through E5's own delete core (the same one the `refresh_source` drain
 *   edge calls), so this stage is the 24-hour VERIFICATION authority even
 *   if the drain reaction lagged.
 * - `notification_work` (in transaction): the source's pending or
 *   evaluating notification intents suppress with the machine purge reason
 *   (the due-time lifecycle re-check remains the structural guard).
 * - `exports` (in transaction): verifies every linked export is terminal
 *   (the eager invalidation and the per-request check did the work; this
 *   records the auditable completion).
 * - `media_objects` (external): the R2 object keys of the source's
 *   attachments and representations leave through the gateway's purge
 *   route (the Worker owns the bucket); the effect leaves the transaction
 *   (the echo/I3 external protocol) and the action records the outcome.
 *
 * Every stage is idempotent: a retry re-runs un-purged stages and skips
 * purged ones; the job succeeds only when no pending stage remains. The
 * stage rows are the administrator's pending/complete/failed status, and
 * I2's incident scan sees the exhausted job row (`ops.job.attempts_exhausted`).
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { executors, purgeSourceInput, ResultEnvelope } from "@kiero/contracts";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DurableJobDoc, JobExecutor, JobOutcome } from "../../platform/executors";
import { deleteSourceEntries } from "../../search/records";
import { purgeClarificationContentForSource } from "../../memory/findings/corrections";
import { markPurgedSupport } from "./marking";
import { sourcePurgeRecordOf } from "./purge";
import { PURGE_STAGE_KINDS, type PurgeStageKind } from "./schema";

/** The decoded input of one purge job (the registry schema authority). */
export interface PurgeJobInput {
  readonly sourceId: Id<"sources"> | string;
  readonly deletionRecordId: Id<"deletionRecords"> | string | null;
}

function decodePurgeInput(input: unknown): PurgeJobInput | null {
  try {
    return Schema.decodeUnknownSync(purgeSourceInput)(input) as PurgeJobInput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage bookkeeping.
// ---------------------------------------------------------------------------

type StageRow = Doc<"deletionPurgeStages">;

/** Loads the stage rows of one deletion record, keyed by kind. */
async function stagesOf(
  db: MutationCtx["db"],
  deletionRecordId: Id<"deletionRecords">,
): Promise<Map<PurgeStageKind, StageRow>> {
  const rows = await db
    .query("deletionPurgeStages")
    .withIndex("by_record", (q) => q.eq("deletionRecordId", deletionRecordId))
    .collect();
  const map = new Map<PurgeStageKind, StageRow>();
  for (const row of rows) {
    map.set(row.stageKind as PurgeStageKind, row);
  }
  return map;
}

/** Marks one stage purged (idempotent: a purged row never moves again). */
async function markStagePurged(tx: MutationCtx, stage: StageRow): Promise<void> {
  if (stage.state === "purged") {
    return;
  }
  await tx.db.patch(stage._id, {
    state: "purged",
    attempts: stage.attempts + 1,
    lastErrorKind: undefined,
    purgedAtMs: Date.now(),
  });
}

/** Marks one stage failed with its sanitized kind (the visible retry state). */
async function markStageFailed(tx: MutationCtx, stage: StageRow, errorKind: string): Promise<void> {
  if (stage.state === "purged") {
    return;
  }
  await tx.db.patch(stage._id, {
    state: "failed",
    attempts: stage.attempts + 1,
    lastErrorKind: errorKind,
  });
}

/** Re-opens a failed stage when a retry begins (pending = retryable). */
async function markStagePending(tx: MutationCtx, stage: StageRow): Promise<void> {
  if (stage.state !== "failed") {
    return;
  }
  await tx.db.patch(stage._id, { state: "pending", lastErrorKind: undefined });
}

// ---------------------------------------------------------------------------
// The in-transaction stage bodies.
// ---------------------------------------------------------------------------

/** The ledger record's requesting user (the marking's honest author). */
async function requestingUserOf(
  tx: MutationCtx,
  deletionRecordId: Id<"deletionRecords">,
): Promise<Id<"users">> {
  const record = await tx.db.get(deletionRecordId);
  if (record === null) {
    throw new Error("deletion purge: ledger record missing");
  }
  return record.requestedByUserId;
}

/** The findings marking stage (the shared marking core + cascade carriers). */
async function purgeFindingsMarking(tx: MutationCtx, stage: StageRow): Promise<void> {
  const outcome = await markPurgedSupport(tx, {
    companyId: stage.companyId,
    actorUserId: await requestingUserOf(tx, stage.deletionRecordId),
    sourceId: stage.sourceId,
  });
  if (outcome._tag === "error") {
    throw new Error(`deletion purge: findings marking refused (${outcome.error.code})`);
  }
  await markStagePurged(tx, stage);
}

/** The transcripts/extractions/fragments stage (permanent row deletion). */
async function purgeTranscripts(tx: MutationCtx, stage: StageRow): Promise<void> {
  // R2 (issue #127): FIRST the clarifications the fragments anchor. Their
  // content purge must run while the fragment rows still exist (it finds
  // linked cases through them): links to the deleted source are removed,
  // possibly derived text is replaced with the fixed redaction copy, and
  // content-free audit metadata is recorded — idempotently, so a stage
  // retry after an interrupted transaction redacts nothing twice.
  await purgeClarificationContentForSource(tx, {
    companyId: stage.companyId,
    sourceId: stage.sourceId,
  });
  const sourceId = stage.sourceId;
  const transcripts = await tx.db
    .query("audioTranscripts")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const transcript of transcripts) {
    const segments = await tx.db
      .query("audioSegments")
      .withIndex("by_transcript_index", (q) => q.eq("transcriptId", transcript._id))
      .collect();
    for (const segment of segments) {
      await tx.db.delete(segment._id);
    }
    await tx.db.delete(transcript._id);
  }
  const visionOrders = await tx.db
    .query("visionOrders")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const order of visionOrders) {
    await tx.db.delete(order._id);
  }
  const extractions = await tx.db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const extraction of extractions) {
    await tx.db.delete(extraction._id);
  }
  const fragments = await tx.db
    .query("sourceFragments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const fragment of fragments) {
    await tx.db.delete(fragment._id);
  }
  // In-flight publication plans of the purged source fail honestly; E3's
  // publish re-check keeps this belt from ever being load-bearing.
  const changeSets = await tx.db
    .query("changeSets")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const changeSet of changeSets) {
    if (changeSet.state === "prepared" || changeSet.state === "publishing") {
      await tx.db.patch(changeSet._id, {
        state: "failed",
        failedReason: "source_purged",
      });
    }
  }
  await markStagePurged(tx, stage);
}

/** The search stage (E5's delete core; the 24-hour verification authority). */
async function purgeSearchIndex(tx: MutationCtx, stage: StageRow): Promise<void> {
  await deleteSourceEntries(tx, stage.sourceId);
  await markStagePurged(tx, stage);
}

/** The notification stage (pending/evaluating intents suppress). */
async function purgeNotificationWork(tx: MutationCtx, stage: StageRow): Promise<void> {
  const intents = await tx.db
    .query("notificationIntents")
    .withIndex("by_source", (q) => q.eq("sourceId", stage.sourceId))
    .collect();
  const nowMs = Date.now();
  for (const intent of intents) {
    if (intent.state === "pending" || intent.state === "evaluating") {
      await tx.db.patch(intent._id, {
        state: "suppressed",
        suppressedReason: "source_purged",
        lastEvaluatedAtMs: nowMs,
      });
    }
  }
  await markStagePurged(tx, stage);
}

/** The exports stage (verification: every linked export is terminal). */
async function purgeExports(tx: MutationCtx, stage: StageRow): Promise<void> {
  const links = await tx.db
    .query("exportSourceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", stage.sourceId))
    .collect();
  for (const link of links) {
    const exportRow = await tx.db.get(link.exportId);
    if (
      exportRow !== null &&
      (exportRow.state === "requested" ||
        exportRow.state === "building" ||
        exportRow.state === "available")
    ) {
      throw new Error(
        `deletion purge: linked export still pre-terminal (${exportRow.state})`,
      );
    }
  }
  await markStagePurged(tx, stage);
}

// ---------------------------------------------------------------------------
// The media stage (the external R2 deletion through the gateway).
// ---------------------------------------------------------------------------

/**
 * Collects every R2 object key the purged source's media occupies: the
 * attachments' received objects and every representation's derived bytes.
 * Server-owned opaque identities only, never content.
 */
export async function mediaObjectKeysOf(
  db: MutationCtx["db"],
  sourceId: Id<"sources">,
): Promise<string[]> {
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const keys = new Set<string>();
  for (const attachment of attachments) {
    keys.add(attachment.objectKey);
    const representations = await db
      .query("mediaRepresentations")
      .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachment._id))
      .collect();
    for (const representation of representations) {
      keys.add(representation.objectKey);
    }
  }
  return [...keys].sort();
}

/** Persists the media stage's key list and re-opens it for this attempt. */
async function prepareMediaStage(tx: MutationCtx, stage: StageRow): Promise<string[]> {
  const keys = await mediaObjectKeysOf(tx.db, stage.sourceId);
  const refreshKeys = stage.objectKeysJson === undefined || stage.state === "failed";
  await tx.db.patch(stage._id, {
    attempts: stage.attempts + 1,
    ...(refreshKeys ? { objectKeysJson: JSON.stringify(keys) } : {}),
    ...(stage.state === "failed"
      ? { state: "pending" as const, lastErrorKind: undefined }
      : {}),
  });
  return keys;
}

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

/**
 * A synthetic purge job document for evidence replays: the guarded retry
 * probe and the focused tests drive the executor with the same shape the
 * scheduler hands it. It is NEVER inserted into durableJobs; the real job
 * row remains the retry authority.
 */
export function syntheticPurgeJobDoc(
  input: { sourceId: Id<"sources">; deletionRecordId: Id<"deletionRecords"> },
  jobKey: string,
): DurableJobDoc {
  return {
    jobKey,
    kind: "deletion.purge_source",
    inputJson: JSON.stringify(input),
    attempts: 0,
    maxAttempts: 6,
    state: "running",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  } as unknown as DurableJobDoc;
}

/** The registered executor for `deletion.purge_source`. */
export const purgeSourceExecutor: JobExecutor = {
  jobKind: "deletion.purge_source",
  execute: async (ctx: MutationCtx, job: DurableJobDoc, input: unknown): Promise<JobOutcome> => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    const decoded = decodePurgeInput(input);
    if (decoded === null) {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    const sourceId = ctx.db.normalizeId("sources", String(decoded.sourceId));
    if (sourceId === null) {
      return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
    }
    const recordId =
      decoded.deletionRecordId === null
        ? await sourcePurgeRecordOf(ctx.db, sourceId)
        : ctx.db.normalizeId("deletionRecords", String(decoded.deletionRecordId));
    if (recordId === null) {
      return { outcome: "failed", errorKind: "deletion_record_missing", retryable: false };
    }
    const stages = await stagesOf(ctx.db, recordId);
    if (stages.size === 0) {
      return { outcome: "failed", errorKind: "purge_stages_missing", retryable: false };
    }
    // The in-transaction stages, each idempotent and independently visible.
    // A stage that refuses records its visible failure on its own row and
    // fails the job retryably (bounded by maxAttempts; the tick re-kicks).
    // Derived from the schema's vocabulary minus the one external stage, so
    // a stage kind added to the schema can never be silently absent here
    // (the compiler forces its body via InTransactionStage).
    const inTransaction: readonly InTransactionStage[] = PURGE_STAGE_KINDS.filter(
      (kind): kind is InTransactionStage => kind !== "media_objects",
    );
    for (const kind of inTransaction) {
      const failure = await runStage(ctx, stages, kind, STAGE_BODIES[kind]);
      if (failure !== null) {
        return { outcome: "failed", errorKind: failure, retryable: true };
      }
    }
    // The media stage's keys persist now; the bytes leave through the
    // gateway action (the effect leaves the transaction).
    const mediaStage = stages.get("media_objects");
    if (mediaStage === undefined) {
      return { outcome: "failed", errorKind: "media_stage_missing", retryable: false };
    }
    if (mediaStage.state === "purged") {
      return { outcome: "succeeded" };
    }
    await markStagePending(ctx, mediaStage);
    const keys = await prepareMediaStage(ctx, mediaStage);
    if (keys.length === 0) {
      await markStagePurged(ctx, mediaStage);
      return { outcome: "succeeded" };
    }
    return { outcome: "external", action: internal.operations.deletion.executor.runMediaPurge };
  },
};

/** The one kind the gateway action owns (the bytes leave the transaction). */
type ExternalStage = "media_objects";
/** Every stage the executor runs inside its transaction, by construction total. */
type InTransactionStage = Exclude<PurgeStageKind, ExternalStage>;

/** The in-transaction stage bodies, keyed by stage kind (total by construction). */
const STAGE_BODIES: Readonly<Record<InTransactionStage, (tx: MutationCtx, stage: StageRow) => Promise<void>>> = {
  findings_marking: purgeFindingsMarking,
  transcripts: purgeTranscripts,
  search_index: purgeSearchIndex,
  notification_work: purgeNotificationWork,
  exports: purgeExports,
};

/**
 * Runs one in-transaction stage unless it is already purged. Returns the
 * sanitized failure kind when the stage refused (never throws: the job
 * outcome records the retry, the stage row records the visibility).
 */
async function runStage(
  ctx: MutationCtx,
  stages: ReadonlyMap<PurgeStageKind, StageRow>,
  kind: PurgeStageKind,
  body: (tx: MutationCtx, stage: StageRow) => Promise<void>,
): Promise<string | null> {
  const stage = stages.get(kind);
  if (stage === undefined) {
    return `stage_row_missing:${kind}`;
  }
  if (stage.state === "purged") {
    return null;
  }
  await markStagePending(ctx, stage);
  try {
    await body(ctx, stage);
  } catch (cause) {
    const errorKind =
      cause instanceof Error ? cause.message.slice(0, 120) : "stage_failed";
    await markStageFailed(ctx, stage, errorKind);
    return errorKind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The external media purge action (the echo/I3 external protocol).
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 30_000;

/** What the action's preparation read (one bounded read, no transaction). */
interface MediaPurgeWork {
  readonly jobKey: string;
  readonly deletionRecordId: Id<"deletionRecords">;
  readonly stageId: Id<"deletionPurgeStages">;
  readonly objectKeys: readonly string[];
}

/** Loads the pending media stage of one job (the action's own read). */
export const mediaPurgeWorkFor = internalQuery({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<MediaPurgeWork | null> => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state !== "running" || job.kind !== "deletion.purge_source") {
      return null;
    }
    const input = decodePurgeInput(JSON.parse(job.inputJson));
    if (input === null) {
      return null;
    }
    const sourceId = ctx.db.normalizeId("sources", String(input.sourceId));
    if (sourceId === null) {
      return null;
    }
    const recordId =
      input.deletionRecordId === null
        ? await sourcePurgeRecordOf(ctx.db, sourceId)
        : ctx.db.normalizeId("deletionRecords", String(input.deletionRecordId));
    if (recordId === null) {
      return null;
    }
    const stages = await ctx.db
      .query("deletionPurgeStages")
      .withIndex("by_record", (q) => q.eq("deletionRecordId", recordId))
      .collect();
    const stage = stages.find((row) => row.stageKind === "media_objects");
    if (stage === undefined || stage.state === "purged") {
      return null;
    }
    return {
      jobKey: job.jobKey,
      deletionRecordId: recordId,
      stageId: stage._id,
      objectKeys: JSON.parse(stage.objectKeysJson ?? "[]") as string[],
    };
  },
});

/** The classification of one gateway purge call (the I3 shape). */
export type PurgeCallClassification =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly retryable: boolean; readonly errorKind: string }
  | { readonly kind: "timeout" | "unknown"; readonly errorKind: string };

/**
 * THE one bounded HTTP call to the gateway's purge route. Shared by the
 * scheduled action and the guarded proof action, so the live evidence
 * exercises exactly the production path. The request names the ledger
 * record only: the WORKER pulls the authoritative key list through the
 * deletion bridge (never the request body).
 */
export async function callPurgeRoute(
  deletionRecordId: string,
  urlOverride?: string,
): Promise<PurgeCallClassification> {
  const target = urlOverride ?? process.env.KIERO_PURGE_EXECUTOR_URL;
  if (target === undefined || target === "") {
    return { kind: "failed", retryable: false, errorKind: "purge_executor_not_configured" };
  }
  const token = process.env.KIERO_SERVICE_TOKEN;
  if (token === undefined || token === "") {
    return { kind: "failed", retryable: false, errorKind: "service_credential_missing" };
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${target.replace(/\/$/, "")}/purge/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deletionRecordId }),
      signal: controller.signal,
    });
    clearTimeout(deadline);
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { kind: "timeout", errorKind: "purge_deadline_exceeded" };
    }
    return { kind: "failed", retryable: true, errorKind: "purge_connection_failed" };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "unknown", errorKind: "purge_response_not_json" };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return { kind: "unknown", errorKind: "purge_response_invalid" };
  }
  if (decoded.value._tag === "ok") {
    return { kind: "succeeded" };
  }
  const error = decoded.value.error;
  return {
    kind: "failed",
    retryable: error._tag === "unavailable" && error.retryable,
    errorKind: `${error._tag}:${error.code}`,
  };
}

/** The scheduled external media purge attempt (records its own outcome). */
export const runMediaPurge = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const work = await ctx.runQuery(internal.operations.deletion.executor.mediaPurgeWorkFor, {
      jobKey: args.jobKey,
    });
    if (work === null) {
      // Already purged, or the job moved on: complete as a no-op.
      await ctx.runMutation(internal.operations.deletion.executor.recordOutcome, {
        jobKey: args.jobKey,
        outcome: "succeeded",
        retryable: false,
        errorKind: "",
      });
      return;
    }
    const classification = await callPurgeRoute(work.deletionRecordId);
    if (classification.kind === "succeeded") {
      await ctx.runMutation(internal.operations.deletion.executor.mediaPurgeDone, {
        jobKey: args.jobKey,
        stageId: work.stageId,
      });
      return;
    }
    await ctx.runMutation(internal.operations.deletion.executor.recordOutcome, {
      jobKey: args.jobKey,
      outcome: classification.kind === "failed" ? "failed" : classification.kind,
      retryable: classification.kind === "failed" ? classification.retryable : false,
      errorKind: classification.errorKind,
      stageId: work.stageId,
    });
  },
});

/** Marks the media stage purged and completes the job (ONE mutation). */
export const mediaPurgeDone = internalMutation({
  args: { jobKey: v.string(), stageId: v.id("deletionPurgeStages") },
  handler: async (ctx, args) => {
    const stage = await ctx.db.get(args.stageId);
    if (stage !== null && stage.state !== "purged") {
      await ctx.db.patch(args.stageId, {
        state: "purged",
        purgedAtMs: Date.now(),
        lastErrorKind: undefined,
      });
    }
    await recordPurgeOutcome(ctx, {
      jobKey: args.jobKey,
      outcome: "succeeded",
      retryable: false,
      errorKind: "",
    });
  },
});

/** Records one external attempt's classification on the job (and stage). */
export const recordOutcome = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("timeout"),
      v.literal("unknown"),
    ),
    retryable: v.boolean(),
    errorKind: v.string(),
    stageId: v.optional(v.id("deletionPurgeStages")),
  },
  handler: async (ctx, args) => {
    await recordPurgeOutcome(ctx, args);
  },
});

/** The outcome-recording core (job row + the stage's visible failure). */
async function recordPurgeOutcome(
  ctx: MutationCtx,
  args: {
    readonly jobKey: string;
    readonly outcome: "succeeded" | "failed" | "timeout" | "unknown";
    readonly retryable: boolean;
    readonly errorKind: string;
    readonly stageId?: string;
  },
): Promise<void> {
  const job = await ctx.db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
    .first();
  if (job === null || job.state === "succeeded" || job.state === "cancelled") {
    return;
  }
  const nowMs = Date.now();
  if (args.outcome === "succeeded") {
    await ctx.db.patch(job._id, {
      state: "succeeded",
      externalOutcome: "succeeded",
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    });
    return;
  }
  if (args.stageId !== undefined) {
    const stageId = ctx.db.normalizeId("deletionPurgeStages", args.stageId);
    const stage = stageId === null ? null : await ctx.db.get(stageId);
    if (stage !== null && stage.state !== "purged") {
      await ctx.db.patch(stage._id, {
        state: "failed",
        lastErrorKind: args.errorKind,
      });
    }
  }
  if (args.outcome !== "failed" || !args.retryable) {
    await ctx.db.patch(job._id, {
      state: "failed",
      externalOutcome: args.outcome === "failed" ? "failed" : args.outcome,
      ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    });
    return;
  }
  await ctx.db.patch(job._id, {
    state: "queued",
    ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
    updatedAtMs: nowMs,
  });
  await ctx.scheduler.runAfter(5_000, internal.platform.jobs.runDurableJob, {
    jobKey: args.jobKey,
  });
}
