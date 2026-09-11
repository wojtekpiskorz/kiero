/**
 * The run pipeline (I5): one complete-backup run against the ports.
 *
 * Order of operations is the completeness contract:
 *
 * 1. lease (server decision; refusals/already-complete exit without writes),
 * 2. database export (the pinned documented mechanism),
 * 3. media copy into the shared pool (head-first, content-addressed, so
 *    interrupted runs resume without duplicating objects),
 * 4. verification pass (every stored object is read back and re-hashed),
 * 5. set files: database.zip and deletion-ledger.json first, the immutable
 *    manifest.json LAST - a set without a manifest is never complete,
 * 6. server-side closure verification (complete), then
 * 7. the reference-aware retention sweep (idempotent; never deletes an
 *    object a surviving manifest still references).
 *
 * Interrupt points let proofs crash the run at each boundary; every step is
 * idempotent, so a takeover attempt produces the same set, one verified
 * manifest and no duplicate effects.
 */

import {
  PipelineInterrupt,
  type BackupDeps,
  type InterruptPoint,
  type PipelineFailureCode,
} from "./ports.ts";
// The grace constant and the orphan rule come from the lane's own PURE
// decision module (convex/operations/backups/slot.ts - an I5-owned path on
// both sides of this import): ONE definition, no executor/server drift.
import { isOrphanCandidate, ORPHAN_GRACE_MS } from "../../../convex/operations/backups/slot.ts";

/** The immutable manifest document (published last; versioned for I6). */
export interface ManifestDocument {
  readonly manifestVersion: "i5.complete.1";
  readonly slotMs: number;
  readonly snapshotAtMs: number;
  readonly tier: "frequent" | "daily";
  readonly database: { readonly key: string; readonly sha256: string; readonly bytes: number };
  readonly media: readonly {
    readonly objectKey: string;
    readonly storageKey: string;
    readonly sourceId: string | null;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly deletionLedger: { readonly key: string; readonly sha256: string; readonly bytes: number; readonly count: number };
  readonly droppedPurged: readonly { objectKey: string; sourceId: string }[];
}

/** The pool/set key layout (part of the I6 restore contract). */
export function mediaPoolKey(objectKey: string): string {
  return `media/${objectKey}`;
}
export function setKey(slotMs: number, file: "database.zip" | "deletion-ledger.json" | "manifest.json"): string {
  return `sets/${slotMs}/${file}`;
}

/** Stable canonical JSON (sorted keys) so manifest bytes are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface RunSummary {
  readonly outcome: "verified" | "refused" | "already_complete" | "failed";
  readonly reason?: string;
  readonly manifestId?: string;
  readonly slotMs?: number;
  readonly tier?: string;
  readonly expiresAtMs?: number;
  readonly mediaObjects?: number;
  readonly databaseBytes?: number;
  readonly mediaBytes?: number;
  readonly sweep?: {
    readonly collectedManifests: number;
    readonly deletedObjects: number;
    readonly orphansRemoved: number;
  };
}

/** Options: where to interrupt (proofs) - the run then throws PipelineInterrupt. */
export interface RunOptions {
  readonly interruptAt?: InterruptPoint | null;
}

function interrupt(options: RunOptions, at: InterruptPoint): void {
  if (options.interruptAt === at) {
    throw new PipelineInterrupt(at);
  }
}

/**
 * Executes one 15-minute run. NEVER fabricates success: every port failure
 * becomes a typed server-side failure record (the row goes `failed`, the
 * freshness monitor keeps alerting), and completeness is decided only by
 * the server's closure verification.
 */
export async function runBackup(
  deps: BackupDeps,
  options: RunOptions = {},
): Promise<RunSummary> {
  const begin = await deps.protocol.begin();
  if (begin.status === "refused") {
    if (begin.reason === "already_complete") {
      // The slot's set is verified, but the retention sweep still converges
      // (an interrupted cleanup is resumed by the next attempt, idempotent).
      const sweep = await runSweep(deps);
      return {
        outcome: "already_complete",
        reason: begin.reason,
        ...(begin.manifestId === undefined ? {} : { manifestId: begin.manifestId }),
        sweep,
      };
    }
    // A live lease means another writer is mid-run: no sweep either (its
    // objects may be freshly written and unreferenced so far).
    return {
      outcome: "refused",
      ...(begin.reason === undefined ? {} : { reason: begin.reason }),
      ...(begin.manifestId === undefined ? {} : { manifestId: begin.manifestId }),
    };
  }
  const manifestId = begin.manifestId!;
  const attempt = begin.attempt!;
  const fail = async (code: PipelineFailureCode): Promise<RunSummary> => {
    // A failure the server could not record (e.g. lease already gone) is
    // still returned honestly; the freshness monitor owns visibility.
    await deps.protocol.fail(manifestId, attempt, code).catch(() => null);
    return { outcome: "failed", reason: code, manifestId };
  };
  interrupt(options, "after_lease");

  // 2. database export (the pinned documented mechanism).
  const exported = await deps.exporter.export();
  if (!exported.ok) {
    return fail(exported.code);
  }
  interrupt(options, "after_export");

  // 3. media copy into the shared pool (head-first: resume skips verified).
  const media = begin.media ?? [];
  const copied: {
    objectKey: string;
    storageKey: string;
    sourceId: string | null;
    sha256: string;
    bytes: number;
  }[] = [];
  for (let index = 0; index < media.length; index += 1) {
    const entry = media[index]!;
    const read = await deps.media.get(entry.objectKey);
    if (!read.ok) {
      return fail(read.code);
    }
    if (entry.bytes !== null && entry.bytes !== read.bytes.length) {
      return fail("media_hash_mismatch");
    }
    const stored = await deps.store.put(mediaPoolKey(entry.objectKey), read.bytes, read.sha256Hex);
    if (!stored.ok) {
      return fail(stored.code);
    }
    if (index === 0) {
      interrupt(options, "mid_media");
    }
  }
  interrupt(options, "after_media");

  // 4. verification pass: every object read back and re-hashed (durably
  //    stored, not just uploaded). Bytes and hashes must match exactly.
  const verifiedMedia: { objectKey: string; sha256: string; bytes: number }[] = [];
  for (const entry of media) {
    const back = await deps.store.get(mediaPoolKey(entry.objectKey));
    if (!back.ok) {
      return fail("store_verify_failed");
    }
    const hash = await sha256HexOf(back.bytes);
    const read = await deps.media.get(entry.objectKey);
    if (!read.ok || hash !== read.sha256Hex || read.bytes.length !== back.bytes.length) {
      return fail("media_verify_failed");
    }
    verifiedMedia.push({ objectKey: entry.objectKey, sha256: hash, bytes: back.bytes.length });
    copied.push({
      objectKey: entry.objectKey,
      storageKey: mediaPoolKey(entry.objectKey),
      sourceId: entry.sourceId,
      sha256: hash,
      bytes: back.bytes.length,
    });
  }

  // 5. the deletion ledger carried SEPARATELY (I4 seam, content-free).
  const ledger = begin.ledger ?? [];
  const ledgerBytes = new TextEncoder().encode(canonicalJson(ledger));
  const ledgerSha = await sha256HexOf(ledgerBytes);

  const manifestDoc: ManifestDocument = {
    manifestVersion: "i5.complete.1",
    slotMs: begin.slotMs!,
    snapshotAtMs: begin.snapshotAtMs!,
    tier: begin.tier ?? "frequent",
    database: {
      key: setKey(begin.slotMs!, "database.zip"),
      sha256: exported.sha256Hex,
      bytes: exported.bytes.length,
    },
    media: [...copied].sort((left, right) => (left.objectKey < right.objectKey ? -1 : 1)),
    deletionLedger: {
      key: setKey(begin.slotMs!, "deletion-ledger.json"),
      sha256: ledgerSha,
      bytes: ledgerBytes.length,
      count: ledger.length,
    },
    droppedPurged: begin.purgedDrops ?? [],
  };
  interrupt(options, "before_manifest");

  const dbPut = await deps.store.put(
    setKey(begin.slotMs!, "database.zip"),
    exported.bytes,
    exported.sha256Hex,
  );
  if (!dbPut.ok) {
    return fail(dbPut.code);
  }
  const ledgerPut = await deps.store.put(
    setKey(begin.slotMs!, "deletion-ledger.json"),
    ledgerBytes,
    ledgerSha,
  );
  if (!ledgerPut.ok) {
    return fail(ledgerPut.code);
  }
  const dbVerify = await deps.store.get(setKey(begin.slotMs!, "database.zip"));
  if (!dbVerify.ok || (await sha256HexOf(dbVerify.bytes)) !== exported.sha256Hex) {
    return fail("store_verify_failed");
  }

  const manifestBytesDoc = new TextEncoder().encode(canonicalJson(manifestDoc));
  const manifestSha = await sha256HexOf(manifestBytesDoc);
  // The manifest is published LAST: until it exists, the set is partial by
  // construction (no reader can mistake it for complete).
  const manifestPut = await deps.store.put(
    setKey(begin.slotMs!, "manifest.json"),
    manifestBytesDoc,
    manifestSha,
  );
  if (!manifestPut.ok) {
    return fail(manifestPut.code);
  }
  interrupt(options, "after_manifest");

  // 6. server-side closure verification: only the server can flip verified.
  const complete = await deps.protocol.complete({
    manifestId,
    attempt,
    database: { sha256: exported.sha256Hex, bytes: exported.bytes.length },
    media: verifiedMedia,
    ledger: { sha256: ledgerSha, bytes: ledgerBytes.length, count: ledger.length },
    manifestHash: manifestSha,
    droppedPurged: begin.purgedDrops ?? [],
  });
  if (!complete.ok) {
    return fail("complete_rejected");
  }

  // 7. the reference-aware retention sweep (idempotent; also on refusals it
  //    is skipped - another writer may be mid-run).
  interrupt(options, "before_sweep");
  const sweepSummary = await runSweep(deps);
  return {
    outcome: "verified",
    manifestId,
    ...(begin.slotMs === undefined ? {} : { slotMs: begin.slotMs }),
    ...(complete.tier === undefined ? {} : { tier: complete.tier }),
    ...(complete.expiresAtMs === undefined ? {} : { expiresAtMs: complete.expiresAtMs }),
    mediaObjects: verifiedMedia.length,
    databaseBytes: exported.bytes.length,
    mediaBytes: verifiedMedia.reduce((total, entry) => total + entry.bytes, 0),
    sweep: sweepSummary,
  };
}

/**
 * Applies one retention sweep: expired sets' files go, pooled objects are
 * deleted only when the SERVER plan says no surviving manifest references
 * them, and orphaned pool objects (no manifest, older than the grace
 * window - the orphan rule stated once in convex/operations/backups/
 * slot.ts `isOrphanCandidate`) are collected. Every step is idempotent.
 */
export async function runSweep(deps: BackupDeps): Promise<{
  collectedManifests: number;
  deletedObjects: number;
  orphansRemoved: number;
}> {
  const { plan, referencedByAnyManifest } = await deps.protocol.sweep();
  // Pool-key form of the ANY-manifest reference set (the orphan guard: an
  // in-flight or failed attempt's inventory still counts as a reference).
  const referencedPoolKeys = referencedByAnyManifest.map((key) => mediaPoolKey(key));
  const deleted: string[] = [];
  for (const set of plan.expiredSets) {
    await deps.store.delete(setKey(set.slotMs, "manifest.json"));
    await deps.store.delete(setKey(set.slotMs, "database.zip"));
    await deps.store.delete(setKey(set.slotMs, "deletion-ledger.json"));
  }
  for (const key of plan.deletableObjectKeys) {
    const poolKey = mediaPoolKey(key);
    await deps.store.delete(poolKey);
    deleted.push(poolKey);
  }
  const nowMs = Date.now();
  const listed = await deps.store.list("media/");
  const orphans: string[] = [];
  for (const object of listed) {
    if (isOrphanCandidate(object.key, referencedPoolKeys, object.lastModifiedMs, nowMs, ORPHAN_GRACE_MS)) {
      await deps.store.delete(object.key);
      orphans.push(object.key);
    }
  }
  const applied = await deps.protocol.sweepComplete({
    collectedManifestIds: plan.expiredSets.map((set) => set.manifestId),
    deletedObjectKeys: deleted,
    orphanKeysRemoved: orphans,
  });
  return {
    collectedManifests: applied.collected,
    deletedObjects: deleted.length,
    orphansRemoved: orphans.length,
  };
}
