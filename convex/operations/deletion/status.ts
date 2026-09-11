/**
 * The administrator's deletion reads (I4): the impact preview before the
 * explicit confirmation, and the pending/complete/failed cleanup status
 * after it. Both are read-only, content-free projections (counts, opaque
 * identities and machine states only): the impact preview never shows the
 * source's text or media, and the status never shows object keys.
 *
 * Both reads check the CURRENT administrator role on every request (the
 * exports lane's administer discipline): a demoted member receives the
 * typed forbidden refusal, whatever an earlier screen promised.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  forbiddenError,
  notFoundError,
  unauthenticatedError,
  validationError,
} from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { PURGE_STAGE_KINDS, type PurgeStageKind } from "./schema";

/** The context and company an admin-gated read resolved, or its refusal. */
type AdminReader = { readonly companyId: Id<"companies"> } | { readonly refusal: ResultEnvelope };

async function adminReader(db: QueryCtx["db"], auth: QueryCtx["auth"]): Promise<AdminReader> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { refusal: errorResult(unauthenticatedError()) };
  }
  if (context.actor.membershipRole !== "admin") {
    return { refusal: errorResult(forbiddenError("requires_admin", "company")) };
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { refusal: errorResult(validationError("company_scope_unresolved")) };
  }
  return { companyId };
}

/** One derivative family's impact row (content-free counts only). */
export interface DeletionImpactRow {
  readonly sourceId: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
  readonly attachmentCount: number;
  readonly representationCount: number;
  readonly transcriptCount: number;
  readonly visionOrderCount: number;
  readonly extractionCount: number;
  readonly fragmentCount: number;
  readonly witnessLinkCount: number;
  readonly pendingNotificationCount: number;
  readonly linkedExportCount: number;
}

/**
 * The impact preview of one source of the caller's company: what permanent
 * deletion removes or invalidates, as counts. A foreign or missing source
 * answers the uniform not-found (existence is not disclosed).
 */
export async function readDeletionImpact(
  db: QueryCtx["db"],
  auth: QueryCtx["auth"],
  sourceId: string,
): Promise<ResultEnvelope> {
  const reader = await adminReader(db, auth);
  if ("refusal" in reader) {
    return reader.refusal;
  }
  const normalized = db.normalizeId("sources", sourceId);
  if (normalized === null) {
    return errorResult(notFoundError("sources", "source_not_in_company"));
  }
  const source = await db.get(normalized);
  if (source === null || source.companyId !== reader.companyId) {
    return errorResult(notFoundError("sources", "source_not_in_company"));
  }
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  let representationCount = 0;
  for (const attachment of attachments) {
    const representations = await db
      .query("mediaRepresentations")
      .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachment._id))
      .collect();
    representationCount += representations.length;
  }
  const transcripts = await db
    .query("audioTranscripts")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const visionOrders = await db
    .query("visionOrders")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const extractions = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", normalized))
    .collect();
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const evidenceLinks = await db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const intents = await db
    .query("notificationIntents")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const exportLinks = await db
    .query("exportSourceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", normalized))
    .collect();
  const row: DeletionImpactRow = {
    sourceId: normalized,
    lifecycle: source.lifecycle,
    attachmentCount: attachments.length,
    representationCount,
    transcriptCount: transcripts.length,
    visionOrderCount: visionOrders.length,
    extractionCount: extractions.length,
    fragmentCount: fragments.length,
    witnessLinkCount: evidenceLinks.length,
    pendingNotificationCount: intents.filter(
      (intent) => intent.state === "pending" || intent.state === "evaluating",
    ).length,
    linkedExportCount: exportLinks.length,
  };
  return okResult(row);
}

/** One stage's status as the administrator's screen shows it. */
export interface PurgeStageStatusRow {
  readonly stageKind: PurgeStageKind;
  readonly state: "pending" | "purged" | "failed";
  readonly attempts: number;
  readonly deadlineAtMs: number;
  readonly lastErrorKind: string | null;
  readonly purgedAtMs: number | null;
}

/** One deletion record's status with its stages (content-free). */
export interface DeletionStatusRow {
  readonly deletionRecordId: string;
  readonly targetSourceId: string;
  readonly createdAtMs: number;
  readonly purgeDeadlineAtMs: number | null;
  readonly scopeSummary: string;
  readonly stages: readonly PurgeStageStatusRow[];
}

/** The caller's company's deletion records, newest first, with stage states. */
export async function readDeletionsStatus(
  db: QueryCtx["db"],
  auth: QueryCtx["auth"],
): Promise<ResultEnvelope> {
  const reader = await adminReader(db, auth);
  if ("refusal" in reader) {
    return reader.refusal;
  }
  const records = await db
    .query("deletionRecords")
    .withIndex("by_company_time", (q) => q.eq("companyId", reader.companyId))
    .order("desc")
    .take(25);
  const rows: DeletionStatusRow[] = [];
  for (const record of records) {
    if (record.kind !== "source_purge" || record.targetSourceId === undefined) {
      continue;
    }
    const stages = await db
      .query("deletionPurgeStages")
      .withIndex("by_record", (q) => q.eq("deletionRecordId", record._id))
      .collect();
    const byKind = new Map(stages.map((stage) => [stage.stageKind as PurgeStageKind, stage]));
    rows.push({
      deletionRecordId: record._id,
      targetSourceId: record.targetSourceId,
      createdAtMs: record.createdAtMs,
      purgeDeadlineAtMs: record.purgeDeadlineAtMs ?? null,
      scopeSummary: record.scopeSummary,
      stages: PURGE_STAGE_KINDS.map((kind): PurgeStageStatusRow => {
        const stage = byKind.get(kind);
        return stage === undefined
          ? {
              stageKind: kind,
              state: "pending",
              attempts: 0,
              deadlineAtMs: record.purgeDeadlineAtMs ?? record.createdAtMs,
              lastErrorKind: null,
              purgedAtMs: null,
            }
          : {
              stageKind: kind,
              state: stage.state,
              attempts: stage.attempts,
              deadlineAtMs: stage.deadlineAtMs,
              lastErrorKind: stage.lastErrorKind ?? null,
              purgedAtMs: stage.purgedAtMs ?? null,
            };
      }),
    });
  }
  return okResult({ deletions: rows });
}
