/**
 * The run pipeline (I5): one complete-backup run against the ports.
 *
 * Order of operations is the completeness contract:
 *
 * 1. lease (server decision; refusals/already-complete exit without writes),
 * 2. database export (the pinned documented mechanism),
 * 3. media copy into the shared pool, head-first: an object already stored
 *    with its sha256 metadata and the inventory's byte size is a verified
 *    resume (interrupted runs skip it without re-reading the source),
 * 4. verification pass: every stored object is read back and re-hashed;
 *    the readback hash must equal the copy-time hash the pool recorded
 *    (source metadata on resume, the source read otherwise),
 * 5. set files: database.zip and deletion-ledger.json first, the immutable
 *    manifest.json LAST - a set without a manifest is never complete,
 * 6. server-side closure verification (complete), then
 * 7. the reference-aware retention sweep (idempotent; never deletes an
 *    object a surviving manifest still references).
 *
 * Interrupt points let proofs crash the run at each boundary; every step is
 * idempotent, so a takeover attempt produces the same set, one verified
 * manifest and no duplicate effects.
 *
 * P12 measurement: the run counts the S3 Class A ops (PUTs/DELETEs) and
 * Class B ops (GETs/HEADs/LISTs) it issues through the ports - one op per
 * port call; a LIST counts one op even when the store paginates it - and
 * carries the counts to complete so the monthly allowance comparison in
 * the state read is fed by real numbers (plan-limits.json).
 */

import {
  PipelineInterrupt,
  type BackupDeps,
  type InterruptPoint,
  type PipelineFailureCode,
} from "./ports.ts";
// The grace constant, the orphan rule and the canonical JSON form come from
// the lane's own PURE decision module (convex/operations/backups/slot.ts -
// an I5-owned path on both sides of this import): ONE definition, no
// executor/server drift.
import {
  canonicalJson,
  isOrphanCandidate,
  ORPHAN_GRACE_MS,
} from "../../../convex/operations/backups/slot.ts";
import { sha256BytesHex } from "./hash.ts";

/** The single hash helper re-exported under its established pipeline name. */
export { sha256BytesHex as sha256HexOf };

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
export { canonicalJson };

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
  readonly classAOps?: number;
  readonly classBOps?: number;
  readonly sweep?: {
    readonly collectedManifests: number;
    readonly deletedObjects: number;
    readonly orphansRemoved: number;
    readonly classAOps: number;
    readonly classBOps: number;
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

/** One media object as the copy pass staged it (the verify input). */
interface StagedObject {
  readonly objectKey: string;
  readonly storageKey: string;
  readonly sourceId: string | null;
  /** The copy-time hash: the source read's hash, or the resumed object's. */
  readonly sha256: string;
  readonly bytes: number;
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
  const ops = { classA: 0, classB: 0 };
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
        classAOps: sweep.classAOps,
        classBOps: sweep.classBOps,
        sweep,
      };
    }
    // A live lease means another writer is mid-run: no sweep either (its
    // objects may be freshly written and unreferenced so far).
    return {
      outcome: "refused",
      reason: begin.reason,
      ...(begin.manifestId === undefined ? {} : { manifestId: begin.manifestId }),
    };
  }
  const manifestId = begin.manifestId;
  const attempt = begin.attempt;
  const fail = async (code: PipelineFailureCode): Promise<RunSummary> => {
    // A failure the server could not record (e.g. lease already gone) is
    // still returned honestly; the freshness monitor owns visibility.
    await deps.protocol.fail(manifestId, attempt, code).catch(() => null);
    return { outcome: "failed", reason: code, manifestId, classAOps: ops.classA, classBOps: ops.classB };
  };
  interrupt(options, "after_lease");

  // 2. database export (the pinned documented mechanism).
  const exported = await deps.exporter.export();
  if (!exported.ok) {
    return fail(exported.code);
  }
  interrupt(options, "after_export");

  // 3. media copy into the shared pool, HEAD-first: an object already stored
  //    with its sha256 metadata and the inventory's byte size was verified
  //    by a previous attempt of this slot, so a takeover skips it instead of
  //    re-reading and re-writing every source object.
  const staged: StagedObject[] = [];
  for (let index = 0; index < begin.media.length; index += 1) {
    const entry = begin.media[index]!;
    const poolKey = mediaPoolKey(entry.objectKey);
    const head = await deps.store.head(poolKey);
    ops.classB += 1;
    if (!head.ok) {
      return fail(head.code);
    }
    if (
      head.present &&
      head.sha256Hex !== undefined &&
      (entry.bytes === null || head.bytes === entry.bytes)
    ) {
      staged.push({
        objectKey: entry.objectKey,
        storageKey: poolKey,
        sourceId: entry.sourceId,
        sha256: head.sha256Hex,
        bytes: head.bytes ?? entry.bytes ?? 0,
      });
    } else {
      const read = await deps.media.get(entry.objectKey);
      ops.classB += 1;
      if (!read.ok) {
        return fail(read.code);
      }
      if (entry.bytes !== null && entry.bytes !== read.bytes.length) {
        return fail("media_hash_mismatch");
      }
      const stored = await deps.store.put(poolKey, read.bytes, read.sha256Hex);
      ops.classA += 1;
      if (!stored.ok) {
        return fail(stored.code);
      }
      staged.push({
        objectKey: entry.objectKey,
        storageKey: poolKey,
        sourceId: entry.sourceId,
        sha256: read.sha256Hex,
        bytes: read.bytes.length,
      });
    }
    if (index === 0) {
      interrupt(options, "mid_media");
    }
  }
  interrupt(options, "after_media");

  // 4. verification pass: every object read back and re-hashed (durably
  //    stored, not just uploaded). The readback hash and size must equal the
  //    copy-time values the pool recorded - identical store-corruption
  //    coverage to re-reading every source, at N reads instead of 2N.
  const verifiedMedia: { objectKey: string; sha256: string; bytes: number }[] = [];
  for (const stagedObject of staged) {
    const back = await deps.store.get(stagedObject.storageKey);
    ops.classB += 1;
    if (!back.ok) {
      return fail("store_verify_failed");
    }
    const hash = await sha256BytesHex(back.bytes);
    if (hash !== stagedObject.sha256 || back.bytes.length !== stagedObject.bytes) {
      return fail("media_verify_failed");
    }
    verifiedMedia.push({ objectKey: stagedObject.objectKey, sha256: hash, bytes: back.bytes.length });
  }

  // 5. the deletion ledger carried SEPARATELY (I4 seam, content-free).
  const ledger = begin.ledger;
  const ledgerBytes = new TextEncoder().encode(canonicalJson(ledger));
  const ledgerSha = await sha256BytesHex(ledgerBytes);

  const manifestDoc: ManifestDocument = {
    manifestVersion: "i5.complete.1",
    slotMs: begin.slotMs,
    snapshotAtMs: begin.snapshotAtMs,
    tier: begin.tier,
    database: {
      key: setKey(begin.slotMs, "database.zip"),
      sha256: exported.sha256Hex,
      bytes: exported.bytes.length,
    },
    media: [...staged].sort((left, right) => (left.objectKey < right.objectKey ? -1 : 1)),
    deletionLedger: {
      key: setKey(begin.slotMs, "deletion-ledger.json"),
      sha256: ledgerSha,
      bytes: ledgerBytes.length,
      count: ledger.length,
    },
    droppedPurged: begin.purgedDrops,
  };
  interrupt(options, "before_manifest");

  const dbPut = await deps.store.put(
    setKey(begin.slotMs, "database.zip"),
    exported.bytes,
    exported.sha256Hex,
  );
  ops.classA += 1;
  if (!dbPut.ok) {
    return fail(dbPut.code);
  }
  const ledgerPut = await deps.store.put(
    setKey(begin.slotMs, "deletion-ledger.json"),
    ledgerBytes,
    ledgerSha,
  );
  ops.classA += 1;
  if (!ledgerPut.ok) {
    return fail(ledgerPut.code);
  }
  const dbVerify = await deps.store.get(setKey(begin.slotMs, "database.zip"));
  ops.classB += 1;
  if (!dbVerify.ok || (await sha256BytesHex(dbVerify.bytes)) !== exported.sha256Hex) {
    return fail("store_verify_failed");
  }

  const manifestBytesDoc = new TextEncoder().encode(canonicalJson(manifestDoc));
  const manifestSha = await sha256BytesHex(manifestBytesDoc);
  // The manifest is published LAST: until it exists, the set is partial by
  // construction (no reader can mistake it for complete).
  const manifestPut = await deps.store.put(
    setKey(begin.slotMs, "manifest.json"),
    manifestBytesDoc,
    manifestSha,
  );
  ops.classA += 1;
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
    droppedPurged: begin.purgedDrops,
    classAOps: ops.classA,
    classBOps: ops.classB,
  });
  if (!complete.ok) {
    return fail("complete_rejected");
  }

  // 7. the reference-aware retention sweep (idempotent; also on refusals it
  // is skipped - another writer may be mid-run).
  interrupt(options, "before_sweep");
  const sweepSummary = await runSweep(deps);
  return {
    outcome: "verified",
    manifestId,
    slotMs: begin.slotMs,
    ...(complete.tier === undefined ? {} : { tier: complete.tier }),
    ...(complete.expiresAtMs === undefined ? {} : { expiresAtMs: complete.expiresAtMs }),
    mediaObjects: verifiedMedia.length,
    databaseBytes: exported.bytes.length,
    mediaBytes: verifiedMedia.reduce((total, entry) => total + entry.bytes, 0),
    classAOps: ops.classA + sweepSummary.classAOps,
    classBOps: ops.classB + sweepSummary.classBOps,
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
  classAOps: number;
  classBOps: number;
}> {
  const { plan, referencedByAnyManifest } = await deps.protocol.sweep();
  const ops = { classA: 0, classB: 0 };
  // Pool-key form of the ANY-manifest reference set (the orphan guard: an
  // in-flight or failed attempt's inventory still counts as a reference).
  const referencedPoolKeys = referencedByAnyManifest.map((key) => mediaPoolKey(key));
  const deleted: string[] = [];
  for (const set of plan.expiredSets) {
    await deps.store.delete(setKey(set.slotMs, "manifest.json"));
    await deps.store.delete(setKey(set.slotMs, "database.zip"));
    await deps.store.delete(setKey(set.slotMs, "deletion-ledger.json"));
    ops.classA += 3;
  }
  for (const key of plan.deletableObjectKeys) {
    const poolKey = mediaPoolKey(key);
    await deps.store.delete(poolKey);
    ops.classA += 1;
    deleted.push(poolKey);
  }
  const nowMs = Date.now();
  const listed = await deps.store.list("media/");
  ops.classB += 1;
  const orphans: string[] = [];
  for (const object of listed) {
    if (isOrphanCandidate(object.key, referencedPoolKeys, object.lastModifiedMs, nowMs, ORPHAN_GRACE_MS)) {
      await deps.store.delete(object.key);
      ops.classA += 1;
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
    classAOps: ops.classA,
    classBOps: ops.classB,
  };
}
