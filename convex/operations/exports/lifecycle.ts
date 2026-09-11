/**
 * The firm-export lifecycle (I3): the pure decisions and the ONE-transaction
 * cores behind request, build, publish, expiry, invalidation and cleanup.
 *
 * STATES (contracts `ExportState`): requested -> building -> available ->
 * expired | invalidated; building -> failed; any pre-terminal state ->
 * invalidated (a linked source was purged, or an administrator asked).
 * Every transition that can refuse decides BEFORE the first write; every
 * write lands in the caller's transaction (the B3/C2 discipline).
 *
 * WHY A BUILD TOKEN: the durable executor may run more than once (retry
 * after a crash, an uncertain outcome resolved by reconciliation). Each
 * attempt mints its own token in the transaction that moves the row to
 * `building`; the publish transaction accepts ONLY the current token. A
 * late first attempt therefore cannot publish over a newer second one,
 * and its object (keyed by its own token) is never linked: "retry does not
 * create divergent published snapshots" is structural.
 *
 * WHY LINKS: `exportSourceLinks` names every source whose records or media
 * an archive carries. I4's purge executor and this lane's per-request
 * download check both key on it: a purge of any linked source refuses the
 * download immediately (the check re-reads the sources) and marks the row
 * `invalidated` (the eager path below). The object bytes are then removed
 * by the cleanup action; the row stays as the auditable status.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { EXPORT_AVAILABILITY_MS } from "./protocol";
import type { PublishArchiveRequest } from "./channel";

export type ExportDoc = Doc<"exports">;

// ---------------------------------------------------------------------------
// Pure decisions (tests/i3 pin these without a deployment).
// ---------------------------------------------------------------------------

/** The states in which an export still has, or may get, downloadable bytes. */
export function isPreTerminal(state: ExportDoc["state"]): boolean {
  return state === "requested" || state === "building" || state === "available";
}

/** Whether a new request should start a build, or reuse the in-flight one. */
export function decideRequest(
  inFlight: readonly { readonly _id: Id<"exports">; readonly state: ExportDoc["state"] }[],
): { readonly decision: "start" } | { readonly decision: "reuse"; readonly exportId: Id<"exports"> } {
  const building = inFlight.find((row) => row.state === "requested" || row.state === "building");
  return building === undefined ? { decision: "start" } : { decision: "reuse", exportId: building._id };
}

/** Whether an executor attempt may begin (and mint a token) on this row. */
export function decideBeginBuild(
  row: Pick<ExportDoc, "state">,
): { readonly decision: "begin" } | { readonly decision: "already_terminal" } {
  return row.state === "requested" || row.state === "building"
    ? { decision: "begin" }
    : { decision: "already_terminal" };
}

export type PublishDecision =
  | { readonly decision: "publish" }
  | { readonly decision: "stale_token" }
  | { readonly decision: "not_building" }
  | { readonly decision: "source_purged"; readonly sourceId: string };

/**
 * The publish gate: the row must still be building under THIS token, and no
 * source the archive carries may have been purged between the snapshot
 * read and now (a purge during the build means the bytes hold deleted
 * content: the archive is invalidated instead of published).
 */
export function decidePublish(
  row: Pick<ExportDoc, "state" | "buildToken">,
  buildToken: string,
  linkedSources: readonly { readonly sourceId: string; readonly lifecycle: string | null }[],
): PublishDecision {
  if (row.state !== "building") {
    return { decision: "not_building" };
  }
  if (row.buildToken !== buildToken) {
    return { decision: "stale_token" };
  }
  const purged = linkedSources.find((source) => source.lifecycle === null || source.lifecycle === "purged");
  if (purged !== undefined) {
    return { decision: "source_purged", sourceId: purged.sourceId };
  }
  return { decision: "publish" };
}

export type DownloadDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly reason: "not_available" | "expired" | "source_purged" };

/**
 * The per-request download gate (after the caller was proved a CURRENT
 * administrator of the row's company): the row must be `available`, inside
 * its window, and every linked source must still exist un-purged.
 */
export function decideDownload(
  row: Pick<ExportDoc, "state" | "availableUntilMs" | "objectKey" | "etag" | "bytes">,
  linkedSources: readonly { readonly lifecycle: string | null }[],
  nowMs: number,
): DownloadDecision {
  if (row.state !== "available" || row.objectKey === undefined || row.etag === undefined || row.bytes === undefined) {
    return { decision: "refuse", reason: "not_available" };
  }
  if (row.availableUntilMs === undefined || nowMs >= row.availableUntilMs) {
    return { decision: "refuse", reason: "expired" };
  }
  if (linkedSources.some((source) => source.lifecycle === null || source.lifecycle === "purged")) {
    return { decision: "refuse", reason: "source_purged" };
  }
  return { decision: "allow" };
}

/** Whether the expiry sweep should move the row to `expired` now. */
export function decideExpiry(
  row: Pick<ExportDoc, "state" | "availableUntilMs">,
  nowMs: number,
): boolean {
  return row.state === "available" && row.availableUntilMs !== undefined && nowMs >= row.availableUntilMs;
}

/** A fresh build token: unique per attempt (Convex seeds Math.random per transaction). */
export function mintBuildToken(nowMs: number): string {
  const random = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${nowMs.toString(36)}-${random()}${random()}`;
}

// ---------------------------------------------------------------------------
// Transaction cores (each runs inside the caller's ONE mutation).
// ---------------------------------------------------------------------------

/** The dedup identity of one export's build job (one job row per export). */
export const buildJobDedupKey = (exportId: string): string => `exports.build_archive:${exportId}`;

/**
 * Starts (or reuses) the company's export: inserts the `requested` row and
 * registers the durable build job atomically. An in-flight export of the
 * same company is reused instead of starting a parallel build.
 */
export async function requestExportCore(
  tx: MutationCtx,
  companyId: Id<"companies">,
  requestedByUserId: Id<"users">,
  nowMs: number,
): Promise<{ readonly exportId: Id<"exports">; readonly state: ExportDoc["state"]; readonly reused: boolean }> {
  const requested = await tx.db
    .query("exports")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId).eq("state", "requested"))
    .collect();
  const building = await tx.db
    .query("exports")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId).eq("state", "building"))
    .collect();
  const decision = decideRequest([...requested, ...building]);
  if (decision.decision === "reuse") {
    const row = await tx.db.get(decision.exportId);
    return { exportId: decision.exportId, state: row?.state ?? "requested", reused: true };
  }
  const exportId = await tx.db.insert("exports", {
    companyId,
    state: "requested",
    requestedByUserId,
    createdAtMs: nowMs,
  });
  await registerDurableJob(tx, {
    kind: "exports.build_archive",
    input: { exportId },
    companyId,
    policy: { maxAttempts: 3, backoffBaseMs: 5_000 },
    dedupKey: buildJobDedupKey(exportId),
  });
  return { exportId, state: "requested", reused: false };
}

/**
 * The executor's transactional half: moves the row to `building` under a
 * fresh token. Returns the token the external action must carry, or null
 * when the row is already terminal (the job then completes as a no-op).
 */
export async function beginBuildCore(
  tx: MutationCtx,
  exportId: Id<"exports">,
  nowMs: number,
): Promise<{ readonly buildToken: string } | null> {
  const row = await tx.db.get(exportId);
  if (row === null || decideBeginBuild(row).decision === "already_terminal") {
    return null;
  }
  const buildToken = mintBuildToken(nowMs);
  await tx.db.patch(exportId, { state: "building", buildToken, buildStartedAtMs: nowMs });
  return { buildToken };
}

/** Reads the lifecycles of the sources an archive links (null = row gone). */
export async function linkedSourceLifecycles(
  db: MutationCtx["db"],
  exportId: Id<"exports">,
): Promise<{ readonly sourceId: string; readonly lifecycle: string | null }[]> {
  const links = await tx_links(db, exportId);
  const out: { sourceId: string; lifecycle: string | null }[] = [];
  for (const link of links) {
    const source = await db.get(link.sourceId);
    out.push({ sourceId: link.sourceId, lifecycle: source === null ? null : source.lifecycle });
  }
  return out;
}

async function tx_links(db: MutationCtx["db"], exportId: Id<"exports">) {
  return await db.query("exportSourceLinks").withIndex("by_export", (q) => q.eq("exportId", exportId)).collect();
}

export type PublishOutcome =
  | { readonly outcome: "published"; readonly availableUntilMs: number }
  | { readonly outcome: "refused"; readonly reason: "stale_token" | "not_building" | "export_not_found" }
  | { readonly outcome: "invalidated"; readonly sourceId: string };

/**
 * The ONE transition to `available`: gate, links, row, event, expiry timer,
 * all in one transaction. A refusal writes nothing (the Worker deletes its
 * object); a purge-during-build invalidates the row and schedules cleanup.
 */
export async function publishArchiveCore(
  tx: MutationCtx,
  request: PublishArchiveRequest,
  nowMs: number,
): Promise<PublishOutcome> {
  const exportId = tx.db.normalizeId("exports", request.exportId);
  if (exportId === null) {
    return { outcome: "refused", reason: "export_not_found" };
  }
  const row = await tx.db.get(exportId);
  if (row === null) {
    return { outcome: "refused", reason: "export_not_found" };
  }
  const sources: { sourceId: string; lifecycle: string | null }[] = [];
  const sourceIds: Id<"sources">[] = [];
  for (const raw of request.sourceIds) {
    const sourceId = tx.db.normalizeId("sources", raw);
    if (sourceId === null) {
      sources.push({ sourceId: raw, lifecycle: null });
      continue;
    }
    const source = await tx.db.get(sourceId);
    // A source of ANOTHER company can never be linked: the snapshot reader
    // only lists this company's rows, and the gate re-checks here.
    if (source === null || source.companyId !== row.companyId) {
      sources.push({ sourceId: raw, lifecycle: null });
      continue;
    }
    sourceIds.push(sourceId);
    sources.push({ sourceId: raw, lifecycle: source.lifecycle });
  }
  const decision = decidePublish(row, request.buildToken, sources);
  if (decision.decision === "stale_token" || decision.decision === "not_building") {
    return { outcome: "refused", reason: decision.decision };
  }
  if (decision.decision === "source_purged") {
    await tx.db.patch(exportId, {
      state: "invalidated",
      invalidationReason: "source_purged_during_build",
      invalidatedAtMs: nowMs,
      objectKey: request.objectKey,
      etag: request.etag,
      bytes: request.bytes,
    });
    await publishEvent(tx, {
      companyId: row.companyId,
      eventName: "operations.exportInvalidated",
      payload: { exportId },
      dedupKey: `operations.exportInvalidated:${exportId}`,
    });
    await tx.scheduler.runAfter(0, internal.operations.exports.functions.cleanupExport, { exportId });
    return { outcome: "invalidated", sourceId: decision.sourceId };
  }
  for (const sourceId of sourceIds) {
    await tx.db.insert("exportSourceLinks", { exportId, sourceId });
  }
  const availableUntilMs = nowMs + EXPORT_AVAILABILITY_MS;
  await tx.db.patch(exportId, {
    state: "available",
    objectKey: request.objectKey,
    etag: request.etag,
    bytes: request.bytes,
    snapshotAtMs: request.snapshotAtMs,
    schemaVersion: request.schemaVersion,
    sourceCount: sourceIds.length,
    mediaCount: request.mediaCount,
    completedAtMs: nowMs,
    availableUntilMs,
  });
  await publishEvent(tx, {
    companyId: row.companyId,
    eventName: "operations.exportCompleted",
    payload: { exportId },
    dedupKey: `operations.exportCompleted:${exportId}`,
  });
  await tx.scheduler.runAt(availableUntilMs, internal.operations.exports.functions.sweepExpiry, { exportId });
  return { outcome: "published", availableUntilMs };
}

/** A build that cannot produce an archive: `failed` with its sanitized kind. */
export async function failBuildCore(
  tx: MutationCtx,
  exportId: Id<"exports">,
  buildToken: string,
  failureKind: string,
  nowMs: number,
): Promise<"failed" | "ignored"> {
  const row = await tx.db.get(exportId);
  if (row === null || row.state !== "building" || row.buildToken !== buildToken) {
    return "ignored";
  }
  await tx.db.patch(exportId, { state: "failed", failureKind, failedAtMs: nowMs });
  return "failed";
}

/** The expiry sweep: `available` past its window becomes `expired` + cleanup. */
export async function expireExportCore(
  tx: MutationCtx,
  exportId: Id<"exports">,
  nowMs: number,
): Promise<"expired" | "unchanged"> {
  const row = await tx.db.get(exportId);
  if (row === null || !decideExpiry(row, nowMs)) {
    return "unchanged";
  }
  await tx.db.patch(exportId, { state: "expired" });
  await tx.scheduler.runAfter(0, internal.operations.exports.functions.cleanupExport, { exportId });
  return "expired";
}

/**
 * The ONE one-row invalidation transition: patch the row to `invalidated`,
 * publish `operations.exportInvalidated`, and schedule the byte cleanup
 * when the row has an object. Every path that invalidates an export runs
 * through here (the eager core below and the lazy per-request download
 * refusal in functions.ts `exportAccessFor`), so no invalidation ever
 * strands archive bytes in R2. A terminal or missing row is a no-op.
 */
export async function invalidateExportCore(
  tx: MutationCtx,
  exportId: Id<"exports">,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const row = await tx.db.get(exportId);
  if (row === null || !isPreTerminal(row.state)) {
    return false;
  }
  await tx.db.patch(exportId, {
    state: "invalidated",
    invalidationReason: reason,
    invalidatedAtMs: nowMs,
  });
  await publishEvent(tx, {
    companyId: row.companyId,
    eventName: "operations.exportInvalidated",
    payload: { exportId },
    dedupKey: `operations.exportInvalidated:${exportId}`,
  });
  if (row.objectKey !== undefined) {
    await tx.scheduler.runAfter(0, internal.operations.exports.functions.cleanupExport, { exportId });
  }
  return true;
}

/**
 * The eager invalidation path (I4's purge executor and this lane's proof
 * call it): every pre-terminal export linked to the source runs through
 * the one-row core above. Returns the invalidated export ids (the
 * per-request download check is the immediate guard even before this
 * runs).
 */
export async function invalidateExportsForSourceCore(
  tx: MutationCtx,
  sourceId: Id<"sources">,
  reason: string,
  nowMs: number,
): Promise<Id<"exports">[]> {
  const links = await tx.db.query("exportSourceLinks").withIndex("by_source", (q) => q.eq("sourceId", sourceId)).collect();
  const invalidated: Id<"exports">[] = [];
  for (const link of links) {
    if (await invalidateExportCore(tx, link.exportId, reason, nowMs)) {
      invalidated.push(link.exportId);
    }
  }
  return invalidated;
}

/** Records that the archive bytes are gone (the row stays as the audit). */
export async function markCleanedCore(
  tx: MutationCtx,
  exportId: Id<"exports">,
  nowMs: number,
): Promise<void> {
  const row = await tx.db.get(exportId);
  if (row === null || row.cleanedAtMs !== undefined) {
    return;
  }
  await tx.db.patch(exportId, { cleanedAtMs: nowMs });
}
