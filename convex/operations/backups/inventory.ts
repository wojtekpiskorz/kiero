/**
 * The backup inventory reads (I5): the D3 retained-media inventory and the
 * I4 content-free deletion/revocation ledger, read inside the begin
 * transaction so one run's snapshot anchor and its reference list are
 * decided atomically.
 *
 * - The retained-media inventory is every VERIFIED `retained` representation
 *   (D5's archival evidence; the received-original exception also lands in
 *   a `retained` row). Unverified rows are not archival evidence yet and
 *   are excluded; a still-building set that loses such an object is not
 *   incomplete.
 * - The deletion ledger is carried SEPARATELY from the database export
 *   (its own hashed file inside the set) so a restore can replay
 *   deletions/revocations that postdate any snapshot (I6 seam). Rows are
 *   content-free by schema; nothing here expands them.
 */

import type { QueryCtx } from "../../_generated/server";
import { isSafeObjectKey } from "./slot";

/** One retained-media object the backup set must copy and verify. */
export interface InventoryEntry {
  /** The media-bucket object key (also the backup-pool key). */
  readonly objectKey: string;
  /** The representation's recorded content hash (etag- or sha256-based). */
  readonly contentHash: string;
  /** Object size in bytes when the ledger recorded it (D5). */
  readonly bytes: number | null;
  /** The owning source when the attachment was already accepted. */
  readonly sourceId: string | null;
}

/** One content-free deletion/revocation record (I4 schema, verbatim). */
export interface LedgerEntry {
  readonly recordId: string;
  readonly companyId: string;
  readonly kind: "source_purge" | "data_revocation";
  readonly targetSourceId: string | null;
  readonly scopeSummary: string;
  readonly createdAtMs: number;
}

/** An inventory that failed its own shape rules (closed reason). */
export type InventoryRefusal = { readonly ok: false; readonly reason: string };

/**
 * Reads the retained-media inventory. A malformed object key fails the
 * WHOLE read with a closed reason (the run then fails typed instead of
 * silently backing up a partial set).
 */
export async function retainedMediaInventory(
  db: QueryCtx["db"],
): Promise<InventoryEntry[] | InventoryRefusal> {
  const representations = await db.query("mediaRepresentations").collect();
  const attachments = await db.query("attachments").collect();
  const attachmentById = new Map(attachments.map((row) => [row._id as string, row]));
  const entries: InventoryEntry[] = [];
  for (const representation of representations) {
    if (representation.role !== "retained" || representation.verifiedAtMs === undefined) {
      continue;
    }
    if (!isSafeObjectKey(representation.objectKey)) {
      return { ok: false, reason: "inventory_object_key_unsafe" };
    }
    const attachment = attachmentById.get(representation.attachmentId as string);
    entries.push({
      objectKey: representation.objectKey,
      contentHash: representation.contentHash,
      bytes: typeof representation.bytes === "number" ? representation.bytes : null,
      sourceId:
        attachment !== undefined && attachment.sourceId !== undefined
          ? (attachment.sourceId as string)
          : null,
    });
  }
  entries.sort((left, right) => (left.objectKey < right.objectKey ? -1 : 1));
  return entries;
}

/** Reads the full content-free deletion/revocation ledger. */
export async function deletionLedgerSnapshot(db: QueryCtx["db"]): Promise<LedgerEntry[]> {
  const rows = await db.query("deletionRecords").collect();
  const entries = rows.map((row) => ({
    recordId: row._id as string,
    companyId: row.companyId as string,
    kind: row.kind,
    targetSourceId:
      row.targetSourceId !== undefined ? (row.targetSourceId as string) : null,
    scopeSummary: row.scopeSummary,
    createdAtMs: row.createdAtMs,
  }));
  entries.sort((left, right) => left.createdAtMs - right.createdAtMs);
  return entries;
}

/**
 * The media keys dropped at build time because their sources have purge
 * records (I4 seam): a purge recorded at or before the run's completion
 * means the source's retained media must not enter THIS set. Keys whose
 * sourceId is unknown stay in the set (conservative: completeness first).
 */
export function purgedDropsOf(
  inventory: readonly InventoryEntry[],
  ledger: readonly LedgerEntry[],
  throughMs: number,
): readonly { objectKey: string; sourceId: string }[] {
  const purgedSources = new Set(
    ledger
      .filter((entry) => entry.kind === "source_purge" && entry.targetSourceId !== null && entry.createdAtMs <= throughMs)
      .map((entry) => entry.targetSourceId as string),
  );
  const drops: { objectKey: string; sourceId: string }[] = [];
  for (const entry of inventory) {
    if (entry.sourceId !== null && purgedSources.has(entry.sourceId)) {
      drops.push({ objectKey: entry.objectKey, sourceId: entry.sourceId });
    }
  }
  return drops;
}
