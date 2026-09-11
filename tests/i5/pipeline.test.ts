/**
 * I5 focused verification, part 3: the executor pipeline (apps/backup-worker
 * src/pipeline.ts) against in-memory ports - the interruption matrix
 * (export, media copy, manifest publish, cleanup, overlapping attempts),
 * idempotent resumability, corruption/omission detection and the
 * reference-aware sweep over a shared pool.
 */

import { describe, expect, it } from "vitest";
import { PipelineInterrupt } from "../../apps/backup-worker/src/ports";
import {
  runBackup,
  runSweep,
  setKey,
  mediaPoolKey,
  sha256HexOf,
} from "../../apps/backup-worker/src/pipeline";
import type {
  BackupDeps,
  BackupProtocol,
  BackupStore,
  DatabaseExporter,
  MediaReader,
  ProtocolBegin,
  ProtocolBeginAcquired,
  ProtocolBeginRefused,
  ProtocolCompleteInput,
  ProtocolSweepPlan,
} from "../../apps/backup-worker/src/ports";

const MIN = 60 * 1000;

async function sha(bytes: Uint8Array): Promise<string> {
  return sha256HexOf(bytes);
}

/** In-memory object store with metadata and mtimes (the BackupStore port). */
class MemoryStore implements BackupStore {
  readonly objects = new Map<string, { bytes: Uint8Array; sha256Hex: string; lastModifiedMs: number }>();
  /** Instrumentation: PUT count per key (the head-skip proof reads it). */
  readonly puts = new Map<string, number>();
  timeMs = Date.now();

  async head(key: string) {
    const hit = this.objects.get(key);
    return hit === undefined
      ? { ok: true as const, present: false }
      : { ok: true as const, present: true, sha256Hex: hit.sha256Hex, bytes: hit.bytes.length };
  }
  async put(key: string, bytes: Uint8Array, sha256Hex: string) {
    this.objects.set(key, { bytes, sha256Hex, lastModifiedMs: this.timeMs });
    this.puts.set(key, (this.puts.get(key) ?? 0) + 1);
    return { ok: true as const };
  }
  async get(key: string) {
    const hit = this.objects.get(key);
    return hit === undefined ? { ok: false as const, code: "store_not_found" as const } : { ok: true as const, bytes: hit.bytes };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, bytes: value.bytes.length, lastModifiedMs: value.lastModifiedMs }));
  }
}

type MediaGet = Awaited<ReturnType<MediaReader["get"]>>;

/** Scriptable media source (the MediaReader port). */
class MemoryMedia implements MediaReader {
  /** Writable so corruption tests can swap reads between copy and verify. */
  read: (objectKey: string) => Promise<MediaGet>;
  /** Instrumentation: total GET count (the no-second-read proof reads it). */
  reads = 0;
  constructor(readonly objects: Map<string, Uint8Array>) {
    this.read = async (objectKey) => {
      const hit = this.objects.get(objectKey);
      if (hit === undefined) {
        return { ok: false as const, code: "media_object_missing" as const };
      }
      return { ok: true as const, bytes: hit, sha256Hex: await sha(hit) };
    };
  }
  async get(objectKey: string): Promise<MediaGet> {
    this.reads += 1;
    return this.read(objectKey);
  }
}

/** A fixed database export (the DatabaseExporter port). */
class FixedExporter implements DatabaseExporter {
  fails = 0;
  constructor(readonly bytes: Uint8Array) {}
  async export() {
    if (this.fails > 0) {
      this.fails -= 1;
      return { ok: false as const, code: "export_failed" as const };
    }
    return { ok: true as const, bytes: this.bytes, sha256Hex: await sha(this.bytes) };
  }
}

/** The Convex protocol as an in-memory state machine mirroring the server. */
class MemoryProtocol implements BackupProtocol {
  readonly completed: ProtocolCompleteInput[] = [];
  readonly failures: { manifestId: string; attempt: number; reason: string }[] = [];
  readonly sweepsApplied: number[] = [];
  private verifiedOnce = false;
  constructor(
    public beginResult: ProtocolBegin,
    public completeResult: { ok: boolean; reason?: string } = { ok: true },
  ) {}

  async begin(): Promise<ProtocolBegin> {
    // Server-like: once a manifest completed, the slot is already complete.
    if (this.verifiedOnce) {
      return {
        status: "refused",
        reason: "already_complete",
        ...(this.beginResult.status === "acquired"
          ? { manifestId: this.beginResult.manifestId }
          : {}),
      };
    }
    return this.beginResult;
  }
  async complete(input: ProtocolCompleteInput) {
    this.completed.push(input);
    if (!this.completeResult.ok) {
      return { ok: false, ...(this.completeResult.reason === undefined ? {} : { reason: this.completeResult.reason }) };
    }
    this.verifiedOnce = true;
    return {
      ok: true,
      ...(this.beginResult.status === "acquired" ? { tier: this.beginResult.tier } : {}),
      expiresAtMs: (this.beginResult.status === "acquired" ? this.beginResult.slotMs : 0) + 48 * 60 * MIN,
    };
  }
  async fail(manifestId: string, attempt: number, reason: string) {
    this.failures.push({ manifestId, attempt, reason });
    return { ok: true };
  }
  async sweep(): Promise<ProtocolSweepPlan> {
    return {
      plan: this.sweepPlan,
      referencedByAnyManifest: this.referenced,
    };
  }
  async sweepComplete(input: { collectedManifestIds: readonly string[] }) {
    this.sweepsApplied.push(input.collectedManifestIds.length);
    return { collected: input.collectedManifestIds.length, replayed: 0, prunedFailed: 0, skipped: 0 };
  }
  sweepPlan: ProtocolSweepPlan["plan"] = { expiredSets: [], survivingReferences: [], deletableObjectKeys: [] };
  /** Server-like default: the current inventory stays referenced. */
  referenced: string[] = [];
}

const DB_BYTES = new TextEncoder().encode("fake-convex-export-zip-bytes");
const MEDIA_A = new TextEncoder().encode("retained image A bytes");
const MEDIA_B = new TextEncoder().encode("retained audio B bytes");

interface Fixture {
  deps: BackupDeps;
  protocol: MemoryProtocol;
  store: MemoryStore;
  media: MemoryMedia;
  exporter: FixedExporter;
}

/** Fixture overrides: tweak the acquired shape, or flip to a refusal. */
type BeginOverrides =
  | (Partial<Omit<ProtocolBeginAcquired, "status">> & { status?: "acquired" })
  | (Partial<Omit<ProtocolBeginRefused, "status">> & { status: "refused" });

function fixture(beginOverrides: BeginOverrides = {}, mediaMap = new Map<string, Uint8Array>([["pool/a", MEDIA_A], ["pool/b", MEDIA_B]])): Fixture {
  const mediaKeys = [...mediaMap.keys()];
  const acquired: ProtocolBeginAcquired = {
    status: "acquired",
    manifestId: "m1",
    attempt: 1,
    slotMs: 900_000,
    snapshotAtMs: 900_100,
    tier: "frequent",
    leaseExpiresAtMs: 900_000 + 12 * MIN,
    media: mediaKeys.map((objectKey) => ({ objectKey, contentHash: "x", bytes: mediaMap.get(objectKey)!.length, sourceId: null })),
    purgedDrops: [],
    ledger: [],
  };
  const begin: ProtocolBegin =
    beginOverrides.status === "refused"
      ? {
          status: "refused",
          reason: beginOverrides.reason ?? "lease_held",
          ...(beginOverrides.manifestId === undefined ? {} : { manifestId: beginOverrides.manifestId }),
        }
      : { ...acquired, ...beginOverrides };
  const protocol = new MemoryProtocol(begin);
  // Server-like: the completed run's inventory stays referenced (survives
  // its own sweep); individual tests override for collection scenarios.
  protocol.referenced = [...mediaKeys];
  const store = new MemoryStore();
  const media = new MemoryMedia(mediaMap);
  const exporter = new FixedExporter(DB_BYTES);
  return { deps: { protocol, exporter, media, store }, protocol, store, media, exporter };
}

describe("the complete run", () => {
  it("exports, copies, verifies, publishes the manifest LAST and completes", async () => {
    const f = fixture();
    const summary = await runBackup(f.deps);
    expect(summary.outcome).toBe("verified");
    expect(summary.mediaObjects).toBe(2);
    // Pool holds both objects; the set holds db, ledger and manifest.
    expect(f.store.objects.has(mediaPoolKey("pool/a"))).toBe(true);
    expect(f.store.objects.has(mediaPoolKey("pool/b"))).toBe(true);
    expect(f.store.objects.has(setKey(900_000, "database.zip"))).toBe(true);
    expect(f.store.objects.has(setKey(900_000, "deletion-ledger.json"))).toBe(true);
    expect(f.store.objects.has(setKey(900_000, "manifest.json"))).toBe(true);
    // One complete call with exactly the copied media.
    expect(f.protocol.completed).toHaveLength(1);
    expect(f.protocol.completed[0]?.media).toHaveLength(2);
    // No failures recorded.
    expect(f.protocol.failures).toHaveLength(0);
  });

  it("a refused lease writes nothing; already-complete skips work", async () => {
    const refused = fixture({ status: "refused", reason: "lease_held" });
    const refusedSummary = await runBackup(refused.deps);
    expect(refusedSummary.outcome).toBe("refused");
    expect(refused.store.objects.size).toBe(0);

    const done = fixture({ status: "refused", reason: "already_complete", manifestId: "m1" });
    const doneSummary = await runBackup(done.deps);
    expect(doneSummary.outcome).toBe("already_complete");
    expect(done.store.objects.size).toBe(0);
    expect(done.protocol.completed).toHaveLength(0);
  });

  it("the deletion ledger is carried SEPARATELY with its own hash and count", async () => {
    const f = fixture({
      ledger: [
        {
          recordId: "kdel000000tttttttttttttttt",
          companyId: "kco000000tttttttttttttttt",
          kind: "source_purge",
          targetSourceId: "ksrc000000tttttttttttttttt",
          scopeSummary: "count=1",
          createdAtMs: 800_000,
        },
      ],
    });
    await runBackup(f.deps);
    const ledgerBytes = f.store.objects.get(setKey(900_000, "deletion-ledger.json"))!;
    expect(f.protocol.completed[0]?.ledger.count).toBe(1);
    expect(await sha(ledgerBytes.bytes)).toBe(f.protocol.completed[0]?.ledger.sha256);
  });
});

describe("the interruption matrix (resumable, idempotent)", () => {
  const points = ["after_lease", "after_export", "mid_media", "after_media", "before_manifest", "after_manifest", "before_sweep"] as const;

  for (const point of points) {
    it(`interrupting ${point} then resuming completes exactly once with no duplicate effects`, async () => {
      const f = fixture();
      await expect(runBackup(f.deps, { interruptAt: point })).rejects.toBeInstanceOf(PipelineInterrupt);
      // Before the manifest point, no completion and no published manifest;
      // at/after it the manifest exists exactly once.
      if (point === "after_manifest" || point === "before_sweep") {
        // after_manifest throws between the manifest PUT and the complete
        // call; before_sweep between complete and the sweep.
        if (point === "before_sweep") {
          expect(f.protocol.completed).toHaveLength(1);
        }
        expect(f.store.objects.has(setKey(900_000, "manifest.json"))).toBe(true);
      } else {
        expect(f.protocol.completed).toHaveLength(0);
        expect(f.store.objects.has(setKey(900_000, "manifest.json"))).toBe(false);
      }
      // Resume over the same state machine: server-verified idempotence.
      const summary = await runBackup(f.deps);
      expect(["verified", "already_complete"]).toContain(summary.outcome);
      expect(f.protocol.completed).toHaveLength(1);
      // Pool objects are content-addressed: one copy each, no duplicates.
      expect(f.store.objects.get(mediaPoolKey("pool/a"))?.bytes).toEqual(MEDIA_A);
    });
  }

  it("an export failure records the typed failure and keeps the row visible to freshness alerting", async () => {
    const f = fixture();
    f.exporter.fails = 1;
    const summary = await runBackup(f.deps);
    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toBe("export_failed");
    expect(f.protocol.failures[0]?.reason).toBe("export_failed");
  });

  it("a missing source object fails typed (omission never becomes a partial complete)", async () => {
    const mediaMap = new Map<string, Uint8Array>([["pool/a", MEDIA_A]]);
    const f = fixture({}, mediaMap);
    f.media.objects.delete("pool/a");
    const summary = await runBackup(f.deps);
    expect(summary).toMatchObject({ outcome: "failed", reason: "media_object_missing" });
    expect(f.protocol.completed).toHaveLength(0);
  });

  it("a corrupted source object fails the copy pass (size cross-check)", async () => {
    // The source claims bytes it does not have: the size cross-check fails.
    const f = fixture({
      media: [{ objectKey: "pool/a", contentHash: "x", bytes: 999_999, sourceId: null }],
    }, new Map<string, Uint8Array>([["pool/a", MEDIA_A]]));
    const summary = await runBackup(f.deps);
    expect(summary).toMatchObject({ outcome: "failed", reason: "media_hash_mismatch" });
  });

  it("a corrupted STORE object fails the readback verification (copy-time hash)", async () => {
    // The pool object mutated between the copy pass and the read-back
    // verification: the readback hash no longer equals the copy-time hash
    // the copy pass recorded -> typed failure, without a second source GET.
    const f = fixture({}, new Map<string, Uint8Array>([["pool/a", MEDIA_A]]));
    const originalGet = f.store.get.bind(f.store);
    const corruption = new Uint8Array([1, 2, 3]);
    let readbacks = 0;
    f.store.get = async (key: string) => {
      const result = await originalGet(key);
      if (result.ok && key === mediaPoolKey("pool/a")) {
        readbacks += 1;
        return { ok: true as const, bytes: corruption };
      }
      return result;
    };
    const summary = await runBackup(f.deps);
    expect(summary).toMatchObject({ outcome: "failed", reason: "media_verify_failed" });
    expect(readbacks).toBe(1);
    // The source was read exactly once (the copy pass): verification no
    // longer re-downloads every object.
    expect(f.media.reads).toBe(1);
  });

  it("a takeover HEAD-skips objects a previous attempt already stored", async () => {
    const f = fixture({}, new Map<string, Uint8Array>([["pool/a", MEDIA_A]]));
    // The interrupted attempt copied pool/a into the pool but never completed.
    await expect(runBackup(f.deps, { interruptAt: "after_media" })).rejects.toBeInstanceOf(PipelineInterrupt);
    const sourceReadsBefore = f.media.reads;
    const summary = await runBackup(f.deps);
    expect(summary.outcome).toBe("verified");
    // The resume re-read no source object and re-PUT no pool object.
    expect(f.media.reads).toBe(sourceReadsBefore);
    expect(f.store.puts.get(mediaPoolKey("pool/a"))).toBe(1);
  });

  it("counts Class A/B S3 ops and carries them to complete (P12)", async () => {
    const f = fixture();
    const summary = await runBackup(f.deps);
    expect(summary.outcome).toBe("verified");
    // Complete receives the run's own counts (before the sweep): 2 media
    // PUTs + db/ledger/manifest PUTs = 5 Class A; 2 HEADs + 2 source GETs +
    // 2 readbacks + the database readback = 7 Class B.
    expect(f.protocol.completed[0]).toMatchObject({ classAOps: 5, classBOps: 7 });
    // The summary adds the sweep: 1 Class B LIST, no deletes, no orphans
    // (the inventory stays referenced).
    expect(summary).toMatchObject({ classAOps: 5, classBOps: 8 });
  });

  it("a server closure rejection fails the run honestly", async () => {
    const f = fixture();
    f.protocol.completeResult = { ok: false };
    const summary = await runBackup(f.deps);
    expect(summary).toMatchObject({ outcome: "failed", reason: "complete_rejected" });
  });
});

describe("the reference-aware sweep (executor side)", () => {
  it("deletes only objects no surviving manifest references; orphans past grace go", async () => {
    const f = fixture();
    f.protocol.sweepPlan = {
      expiredSets: [
        { manifestId: "m1", slotMs: 900_000, mediaObjectKeys: ["shared/a", "old/a"] },
      ],
      survivingReferences: ["shared/a"],
      deletableObjectKeys: ["old/a"],
    };
    f.protocol.referenced = ["shared/a", "old/a"];
    // The pool holds a live shared object, a deletable one, and an orphan.
    await f.store.put(mediaPoolKey("shared/a"), MEDIA_A, await sha(MEDIA_A));
    await f.store.put(mediaPoolKey("old/a"), MEDIA_B, await sha(MEDIA_B));
    const orphan = new Uint8Array([9]);
    await f.store.put(mediaPoolKey("orphan/x"), orphan, await sha(orphan));
    f.store.objects.get(mediaPoolKey("orphan/x"))!.lastModifiedMs = 1; // ancient
    // Expired set files exist.
    await f.store.put(setKey(900_000, "manifest.json"), new Uint8Array([1]), await sha(new Uint8Array([1])));
    await f.store.put(setKey(900_000, "database.zip"), new Uint8Array([2]), await sha(new Uint8Array([2])));

    const summary = await runSweep(f.deps);
    expect(summary.collectedManifests).toBe(1);
    expect(summary.deletedObjects).toBe(1); // old/a only
    expect(summary.orphansRemoved).toBe(1); // orphan/x
    expect(f.store.objects.has(mediaPoolKey("shared/a"))).toBe(true);
    expect(f.store.objects.has(mediaPoolKey("old/a"))).toBe(false);
    expect(f.store.objects.has(mediaPoolKey("orphan/x"))).toBe(false);
    expect(f.store.objects.has(setKey(900_000, "manifest.json"))).toBe(false);
    expect(f.store.objects.has(setKey(900_000, "database.zip"))).toBe(false);
  });

  it("the orphan grace window spares freshly written unreferenced objects", async () => {
    const f = fixture();
    f.protocol.sweepPlan = { expiredSets: [], survivingReferences: [], deletableObjectKeys: [] };
    f.protocol.referenced = [];
    const fresh = new Uint8Array([7]);
    await f.store.put(mediaPoolKey("fresh-unref"), fresh, await sha(fresh));
    f.store.timeMs = Date.now();
    f.store.objects.get(mediaPoolKey("fresh-unref"))!.lastModifiedMs = Date.now();
    const summary = await runSweep(f.deps);
    expect(summary.orphansRemoved).toBe(0);
    expect(f.store.objects.has(mediaPoolKey("fresh-unref"))).toBe(true);
  });
});
