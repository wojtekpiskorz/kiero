/**
 * I5 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/i5, EU) and the REAL EU R2 backup
 * bucket (kiero-dev-backup) + media bucket (kiero-dev-media).
 *
 * BLOCKED NOTE (2026-09-11): the Convex team deployment quota (40/40) was
 * reached when this script was authored, so dev/i5 could not be created and
 * these rows are NOT RUN. The script is the repeatable procedure: the moment
 * the owner frees a deployment slot (or raises the quota), run
 *
 *   KIERO_I5_CONVEX=<deployment-name> node --experimental-strip-types \
 *     tests/i5/live-proof.mjs
 *
 * from the operator machine (wrangler OAuth + convex CLI auth required; the
 * operator-authenticated export is the pinned documented mechanism).
 *
 * Byte transport: until the per-bucket R2 S3 tokens exist (owner action,
 * dashboard-only), the wrangler CLI moves the bytes (get/put) and the
 * operator-authenticated convex CLI performs the export. The SAME pipeline
 * (apps/backup-worker src/pipeline.ts) runs with those transports through
 * the guarded probe actions - only the byte transport differs from
 * production, and that substitution is the named owner action.
 *
 * Proof rows (P10/P12):
 * - L1 lease + overlap: begin acquires; a second begin inside the lease is
 *      refused (no overlapping writers).
 * - L2 complete set: real export zip + real retained media copied into the
 *      real EU backup bucket; manifest published LAST; row verified with
 *      hashes/sizes; deletion ledger carried separately.
 * - L3 interrupts: deterministic interrupt points (after_export, mid_media,
 *      before_manifest) leave NO manifest; takeover resumes and completes
 *      exactly once.
 * - L4 corruption: a tampered source object fails the run typed; the
 *      freshness tick emits ops.backup.stale from snapshot age.
 * - L5 retention fixtures: a 49h-old frequent set and a 15d-old daily set
 *      are collected reference-aware (shared pool object survives while a
 *      surviving manifest references it).
 * - L6 deleted-source expiry: purge-recorded sources never enter new sets;
 *      the 14d retention bound keeps backup content inside 30 days
 *      (invariant asserted live in the state read).
 * - L7 health/cost: backup.job heartbeats per attempt; measured cost entries
 *      (backup/export, storage, egress) recorded in the month's accounting.
 */

import { ConvexHttpClient } from "convex/browser";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DEPLOYMENT = process.env.KIERO_I5_CONVEX;
if (DEPLOYMENT === undefined || DEPLOYMENT === "") {
  console.error("[BLOCKED] KIERO_I5_CONVEX is not set: the dev/i5 lease is required (see file header).");
  process.exit(2);
}
const URL_ = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const MEDIA_BUCKET = "kiero-dev-media";
const BACKUP_BUCKET = "kiero-dev-backup";

const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}

const anon = () => new ConvexHttpClient(URL_, { logger: false });
const probe = (fn, args = {}) => anon().action(`operations/backups/proof:${fn}`, args);

// --- transports (wrangler CLI bytes; operator-authenticated export) --------

async function wranglerObjectPut(bucket, key, file) {
  await run("npx", ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file], {});
}
async function wranglerObjectGet(bucket, key, file) {
  await run("npx", ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", file], {});
}
async function wranglerObjectDelete(bucket, key) {
  await run("npx", ["wrangler", "r2", "object", "delete", `${bucket}/${key}`, "--force"], {});
}

/** The pinned documented export: operator-authenticated convex CLI. */
async function exportDatabase(dir) {
  const zip = join(dir, "snapshot.zip");
  await run("npx", ["--yes", "convex@1.45.0", "export", "--path", zip, "--deployment", DEPLOYMENT], {
    env: { ...process.env },
  });
  const bytes = new Uint8Array(await readFile(zip));
  return bytes;
}

// The pipeline + ports from the real executor (node type stripping).
const { runBackup, setKey, mediaPoolKey, sha256HexOf } = await import(
  "../../apps/backup-worker/src/pipeline.ts"
);

/** The guarded probe actions as the BackupProtocol port. */
function probeProtocol() {
  const valueOf = async (action, args) => {
    const envelope = await probe(action, args);
    if (envelope?._tag !== "ok") {
      throw new Error(`probe ${action} failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.value;
  };
  return {
    begin: () => valueOf("probeBegin", {}),
    complete: (input) => valueOf("probeComplete", input),
    fail: (manifestId, attempt, reason) => valueOf("probeFail", { manifestId, attempt, reason }),
    sweep: () => valueOf("probeSweep", {}),
    sweepComplete: (input) => valueOf("probeSweepComplete", input),
  };
}

/** The wrangler-CLI backup store (dev-proof byte transport). */
function wranglerStore(dir) {
  let counter = 0;
  const objects = new Map();
  return {
    async head(key) {
      return { present: objects.has(key) };
    },
    async put(key, bytes) {
      counter += 1;
      const file = join(dir, `put-${counter}`);
      await writeFile(file, bytes);
      await wranglerObjectPut(BACKUP_BUCKET, key, file);
      objects.set(key, bytes);
      return { ok: true, skipped: false };
    },
    async get(key) {
      const file = join(dir, `get-${counter++}`);
      await wranglerObjectGet(BACKUP_BUCKET, key, file);
      return { ok: true, bytes: new Uint8Array(await readFile(file)) };
    },
    async delete(key) {
      await wranglerObjectDelete(BACKUP_BUCKET, key);
      objects.delete(key);
    },
    async list() {
      return [];
    },
  };
}

/** The wrangler-CLI media reader (dev-proof copy source). */
function wranglerMedia(dir) {
  let counter = 0;
  return {
    async get(objectKey) {
      const file = join(dir, `media-${counter++}`);
      try {
        await wranglerObjectGet(MEDIA_BUCKET, objectKey, file);
      } catch {
        return { ok: false, code: "media_object_missing" };
      }
      const bytes = new Uint8Array(await readFile(file));
      return { ok: true, bytes, sha256Hex: await sha256HexOf(bytes) };
    },
  };
}

// --- the procedure ----------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), "kiero-i5-proof-"));
try {
  // Fixtures: real bytes in the real media bucket + inventory rows.
  const seedKey = `companies/i5-proof/uploads/fixture-${Date.now()}/0-image`;
  const seedBytes = new TextEncoder().encode("I5 retained-media fixture bytes");
  const seedFile = join(dir, "seed");
  await writeFile(seedFile, seedBytes);
  await wranglerObjectPut(MEDIA_BUCKET, seedKey, seedFile);
  const seeded = await probe("probeSeedRetainedMedia", {
    objectKey: seedKey,
    contentHash: `proof:${await sha256HexOf(seedBytes)}`,
    bytes: seedBytes.length,
    transformVersion: "i5.proof/1",
  });
  record("L0-fixture", seeded?.value?.seeded === true ? "PASS" : "FAIL", JSON.stringify(seeded?.value ?? seeded).slice(0, 120));

  // L1: lease + overlap.
  const begin1 = (await probe("probeBegin", {}))?.value;
  record(
    "L1-lease",
    begin1?.status === "acquired" ? "PASS" : "FAIL",
    begin1?.status === "acquired" ? `slot=${begin1.slotMs} attempt=${begin1.attempt} tier=${begin1.tier}` : JSON.stringify(begin1).slice(0, 160),
  );
  const begin2 = (await probe("probeBegin", {}))?.value;
  record(
    "L1-overlap",
    begin2?.status === "refused" && begin2?.reason === "lease_held" ? "PASS" : "FAIL",
    JSON.stringify(begin2).slice(0, 160),
  );

  // L2/L3: the real pipeline over the probe protocol + CLI transports.
  const protocol = probeProtocol();
  const deps = {
    protocol,
    exporter: { export: async () => ({ ok: true, bytes: await exportDatabase(dir), sha256Hex: "" }) },
    media: wranglerMedia(dir),
    store: wranglerStore(dir),
  };
  deps.exporter.export = async () => {
    const bytes = await exportDatabase(dir);
    return { ok: true, bytes, sha256Hex: await sha256HexOf(bytes) };
  };

  const l2 = await runBackup(deps);
  record(
    "L2-complete-set",
    l2.outcome === "verified" ? "PASS" : "FAIL",
    JSON.stringify(l2).slice(0, 200),
  );
  const state1 = (await probe("probeState", {}))?.value;
  const verifiedRow = state1?.manifests?.find((m) => m.state === "verified");
  record(
    "L2-manifest-row",
    verifiedRow !== undefined && typeof verifiedRow.manifestHash === "string" ? "PASS" : "FAIL",
    JSON.stringify(verifiedRow).slice(0, 200),
  );

  // L3: a live interrupt + takeover (needs an acquirable slot; the full
  // matrix is unit-proven in tests/i5/pipeline.test.ts).
  const l3begin = (await probe("probeBegin", {}))?.value;
  if (l3begin?.status === "acquired") {
    let interrupted = false;
    try {
      await runBackup(deps, { interruptAt: "after_export" });
    } catch (error) {
      interrupted = error instanceof Error && error.message.includes("pipeline interrupted");
    }
    const resumed = await runBackup(deps);
    record(
      "L3-interrupt-resume",
      interrupted && resumed.outcome === "verified" ? "PASS" : "FAIL",
      `interrupted=${interrupted} resume=${resumed.outcome}`,
    );
  } else {
    record("L3-interrupt-resume", "NOT RUN", `slot not acquirable: ${JSON.stringify(l3begin).slice(0, 120)}`);
  }

  // L4: corruption + freshness.
  const tampered = new TextEncoder().encode("tampered bytes");
  const tamperFile = join(dir, "tamper");
  await writeFile(tamperFile, tampered);
  await wranglerObjectPut(MEDIA_BUCKET, seedKey, tamperFile);
  // Next slot: wait or reuse after lease expiry is not practical live; the
  // corruption row uses the CURRENT pipeline against the tampered source.
  const l4begin = (await probe("probeBegin", {}))?.value;
  if (l4begin?.status === "acquired") {
    const l4 = await runBackup(deps);
    record(
      "L4-corruption",
      l4.outcome === "failed" && ["media_hash_mismatch", "media_verify_failed"].includes(l4.reason) ? "PASS" : "FAIL",
      JSON.stringify(l4).slice(0, 160),
    );
  } else {
    record("L4-corruption", "NOT RUN", `slot not acquirable: ${JSON.stringify(l4begin).slice(0, 120)}`);
  }
  // Freshness: seed a stale verified manifest (2h old) and run the tick.
  await probe("probeSeedManifest", { slotAgeMinutes: 125, state: "verified", mediaObjectKeys: [] });
  const tick = (await probe("probeTick", {}))?.value;
  record(
    "L4-freshness",
    tick?.freshness?.state === "stale" && tick?.freshness?.emitted === true ? "PASS" : "FAIL",
    JSON.stringify(tick?.freshness).slice(0, 160),
  );

  // L5: retention fixtures (frequent 49h, daily 15d, shared key with a survivor).
  const oldShared = "companies/i5-proof/uploads/old/shared-object";
  await probe("probeSeedManifest", { slotAgeMinutes: 49 * 60, state: "verified", mediaObjectKeys: [oldShared, "companies/i5-proof/uploads/old/only-old"] });
  await probe("probeSeedManifest", { slotAgeMinutes: 15 * 24 * 60, state: "verified", mediaObjectKeys: ["companies/i5-proof/uploads/daily/only-daily"] });
  await probe("probeSeedManifest", { slotAgeMinutes: 30, state: "verified", mediaObjectKeys: [oldShared] });
  const sweepPlan = (await probe("probeSweep", {}))?.value;
  const sharedProtected = sweepPlan?.plan?.deletableObjectKeys?.includes(oldShared) === false;
  const dailyCollected = sweepPlan?.plan?.expiredSets?.length >= 2;
  record(
    "L5-reference-aware",
    sharedProtected && dailyCollected ? "PASS" : "FAIL",
    JSON.stringify(sweepPlan?.plan?.deletableObjectKeys).slice(0, 200),
  );
  // Apply the sweep with the CLI transport and confirm idempotent complete.
  const applied = await protocol.sweepComplete({
    collectedManifestIds: sweepPlan.plan.expiredSets.map((s) => s.manifestId),
    deletedObjectKeys: sweepPlan.plan.deletableObjectKeys,
    orphanKeysRemoved: [],
  });
  record("L5-sweep-applied", applied.collected >= 2 ? "PASS" : "FAIL", JSON.stringify(applied));

  // L6: deleted-source 30-day expiry fixtures.
  const purgeSeedKey = `companies/i5-proof/uploads/purge-${Date.now()}/0-image`;
  await wranglerObjectPut(MEDIA_BUCKET, purgeSeedKey, tamperFile);
  const purgedSeed = (await probe("probeSeedRetainedMedia", {
    objectKey: purgeSeedKey,
    contentHash: "proof:purged",
    bytes: tampered.length,
    transformVersion: "i5.proof/1",
  }))?.value;
  await probe("probeSeedDeletion", {
    kind: "source_purge",
    targetSourceId: purgedSeed?.sourceId,
    scopeSummary: "count=1",
    ageMinutes: 31 * 24 * 60,
  });
  const state6 = (await probe("probeState", {}))?.value;
  record(
    "L6-deleted-content-invariant",
    state6?.deletedContentInvariantHolds === true ? "PASS" : "FAIL",
    `invariant=${state6?.deletedContentInvariantHolds} (no set outlives 14d < 30d; purge drops exclude new sets)`,
  );

  // L7: health/cost events.
  const healthUrl = `${URL_}/platform/telemetry/health`;
  const health = await fetch(healthUrl).then((r) => r.json()).catch(() => null);
  const telemetry = health?.value?.telemetry ?? {};
  const heartbeatSeen = JSON.stringify(telemetry).includes("backup.job");
  const costSeen = JSON.stringify(telemetry?.costs ?? {}).includes("backup");
  record("L7-heartbeats", heartbeatSeen ? "PASS" : "FAIL", "backup.job present in health state");
  record("L7-costs", costSeen ? "PASS" : "FAIL", "backup provider present in cost accounting");

  process.exit(summarize() ? 0 : 1);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => null);
}
