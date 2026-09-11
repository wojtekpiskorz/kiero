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
 *   KIERO_I5_CONVEX=<deployment-name> node --experimental-transform-types \
 *     tests/i5/live-proof.mjs
 *
 * from the operator machine (wrangler OAuth + convex CLI auth required; the
 * operator-authenticated export is the pinned documented mechanism). The
 * flag must be --experimental-transform-types: strip-only mode cannot parse
 * the TypeScript parameter properties in the imported executor modules.
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
 *      hashes/sizes; deletion ledger carried separately. When the service
 *      credential is available the run rides the REAL HTTP boundary (the
 *      same bearer-verified .site routes the EU Container uses) instead of
 *      the probe actions - production entry end to end.
 * - L3 interrupts: the proof rides the NEXT 15-minute slot (the guarded
 *      proof-only clock fixture on probeBegin - a completed current slot is
 *      `already_complete` forever, and waiting out the grid is not proof);
 *      the interrupt leaves NO manifest with a live lease, and the resume
 *      begins past that lease so the REAL takeover path
 *      (`lease_expired` -> attempt 2) completes exactly once.
 * - L4 corruption: a tampered source object fails the run typed (the proof
 *      rides the slot after L3's). The freshness tick runs FIRST, before
 *      any fresh verified snapshot exists: the seeded 125-minute-old
 *      verified manifest is the newest snapshot, so staleness is real and
 *      ops.backup.stale is emitted from snapshot age.
 * - L5 retention fixtures: a 49h-old frequent set and a 15d-old daily set
 *      are collected reference-aware (shared pool object survives while a
 *      surviving manifest references it).
 * - L6 deleted-source expiry: purge-recorded sources never enter new sets;
 *      the 14d retention bound keeps backup content inside 30 days
 *      (invariant asserted live in the state read).
 * - L7 health/cost: the HTTP boundary's own effects - backup.job
 *      heartbeats per attempt and measured cost entries (backup/export,
 *      storage, egress) recorded by the complete route - read back from
 *      the public health state. Without the service credential the routes
 *      refuse (401) and both rows are an explicit NOT RUN.
 */

import { ConvexHttpClient } from "convex/browser";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DEPLOYMENT = process.env.KIERO_I5_CONVEX;
if (DEPLOYMENT === undefined || DEPLOYMENT === "") {
  console.error("[BLOCKED] KIERO_I5_CONVEX is not set: the dev/i5 lease is required (see file header).");
  process.exit(2);
}
const MEDIA_BUCKET = "kiero-dev-media";
const BACKUP_BUCKET = "kiero-dev-backup";

// The client URL comes from the deployment's REPORTED origin, not a guessed
// regional template: fresh leases answer at https://<name>.convex.cloud
// while older EU leases answer at <name>.eu-west-1.convex.cloud. The probe
// rides the .site domain's public health route (HTTP routes live on .site,
// never on .cloud); the winning candidate's .cloud twin is what the action
// clients below use.
const ORIGIN_CANDIDATES = [
  `https://${DEPLOYMENT}.convex.cloud`,
  `https://${DEPLOYMENT}.eu-west-1.convex.cloud`,
];
let URL_ = null;
for (const candidate of ORIGIN_CANDIDATES) {
  const site = candidate.replace(".convex.cloud", ".convex.site");
  const answers = await fetch(`${site}/platform/telemetry/health`)
    .then((response) => response.ok)
    .catch(() => false);
  if (answers) {
    URL_ = candidate;
    break;
  }
}
if (URL_ === null) {
  console.error(`[BLOCKED] no origin answered for ${DEPLOYMENT}: ${ORIGIN_CANDIDATES.join(", ")}`);
  process.exit(2);
}

// HTTP routes (the backups boundary, the health read) live on the .site
// twin of the winning .cloud origin; action clients use the .cloud origin.
const SITE = URL_.replace(".convex.cloud", ".convex.site");

// The service credential the REAL HTTP boundary verifies. It comes from the
// shell env or the gitignored .env.local (the operator sets it deployment-
// side via `npx convex@1.45.0 env set KIERO_SERVICE_TOKEN`). Only its
// PRESENCE is ever reported - the value is never printed or logged.
function readServiceToken() {
  if (process.env.KIERO_SERVICE_TOKEN !== undefined && process.env.KIERO_SERVICE_TOKEN !== "") {
    return process.env.KIERO_SERVICE_TOKEN;
  }
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      if (line.startsWith("KIERO_SERVICE_TOKEN=")) {
        const value = line.slice("KIERO_SERVICE_TOKEN=".length).trim();
        return value === "" ? null : value;
      }
    }
  } catch {
    // no .env.local - probe actions only
  }
  return null;
}
const SERVICE_TOKEN = readServiceToken();
if (SERVICE_TOKEN === null) {
  console.error(
    "[NOTE] KIERO_SERVICE_TOKEN not found (env or .env.local): the HTTP boundary refuses every route (401)." +
      " L2 falls back to the guarded probe actions; L7 rows will be NOT RUN.",
  );
}

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
let exportCounter = 0;
async function exportDatabase(dir) {
  // Unique name per export: one pass runs several pipelines (L2/L3/L4) and
  // the CLI refuses to overwrite an existing --path.
  const zip = join(dir, `snapshot-${(exportCounter += 1)}.zip`);
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
// The schedule grid constant from the lane's own decision module (no drift).
const { SCHEDULE_INTERVAL_MS } = await import("../../convex/operations/backups/slot.ts");

/**
 * The guarded probe actions as the BackupProtocol port. `nowMs` is the
 * proof-only clock fixture: when given, begin targets the slot containing
 * that instant instead of the current one (see convex/operations/backups/
 * proof.ts probeBegin - the fixture is guarded and flagged there).
 */
function probeProtocol(nowMs) {
  const valueOf = async (action, args) => {
    const envelope = await probe(action, args);
    if (envelope?._tag !== "ok") {
      throw new Error(`probe ${action} failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.value;
  };
  return {
    begin: () => valueOf("probeBegin", nowMs === undefined ? {} : { nowMs }),
    complete: (input) => valueOf("probeComplete", input),
    fail: (manifestId, attempt, reason) => valueOf("probeFail", { manifestId, attempt, reason }),
    sweep: () => valueOf("probeSweep", {}),
    sweepComplete: (input) => valueOf("probeSweepComplete", input),
  };
}

/**
 * The REAL HTTP boundary as the BackupProtocol port: the same
 * bearer-verified .site routes the EU backup Container enters through
 * (convex/operations/backups/http.ts), same envelopes, same server
 * decisions - plus the boundary's own health/cost effects (backup.job
 * heartbeats, measured cost entries) that the probe actions bypass by
 * design. HTTP begins always target the REAL current slot (the run route
 * takes no clock override), so this transport is only for current-slot runs.
 */
function httpProtocol(token) {
  const call = async (path, body) => {
    const response = await fetch(`${SITE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = await response.json().catch(() => null);
    if (envelope?._tag !== "ok") {
      throw new Error(`http ${path} failed: status=${response.status} ${JSON.stringify(envelope).slice(0, 160)}`);
    }
    return envelope.value;
  };
  return {
    begin: () => call("/operations/backups/run"),
    complete: (input) => call("/operations/backups/complete", input),
    fail: (manifestId, attempt, reason) => call("/operations/backups/fail", { manifestId, attempt, reason }),
    sweep: () => call("/operations/backups/sweep"),
    sweepComplete: (input) => call("/operations/backups/sweep/complete", input),
  };
}

/** The wrangler-CLI backup store (dev-proof byte transport). */
function wranglerStore(dir) {
  let counter = 0;
  // What THIS process put (key -> hash metadata), so a takeover run's
  // head-first resume skips objects the interrupted attempt stored.
  const objects = new Map();
  return {
    async head(key) {
      const hit = objects.get(key);
      return hit === undefined
        ? { ok: true, present: false }
        : { ok: true, present: true, sha256Hex: hit.sha256Hex, bytes: hit.bytes.length };
    },
    async put(key, bytes, sha256Hex) {
      counter += 1;
      const file = join(dir, `put-${counter}`);
      await writeFile(file, bytes);
      await wranglerObjectPut(BACKUP_BUCKET, key, file);
      objects.set(key, { bytes, sha256Hex });
      return { ok: true };
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

  // Between-passes cleanup (probeClear's documented purpose): each pass must
  // be self-contained. Leftover verified rows from an earlier pass would be
  // NEWER than the stale fixture below and mask the stale verdict.
  await probe("probeClear", {});

  // L4-freshness FIRST: the stale fixture must be the NEWEST verified
  // snapshot at tick time, so this runs before any pass-own verified row
  // exists (L1/L2 create fresh ones). Seeds a 125-minute-old verified
  // manifest, ticks the real freshness check, and asserts the real stale
  // verdict + the ops.backup.stale emission. A re-run inside the same
  // 15-minute anchor slot observes the emission deduplicated - the episode
  // was already reported, which is the same rule observed.
  await probe("probeSeedManifest", { slotAgeMinutes: 125, state: "verified", mediaObjectKeys: [] });
  const tick = (await probe("probeTick", {}))?.value;
  record(
    "L4-freshness",
    tick?.freshness?.state === "stale" && (tick?.freshness?.emitted === true || tick?.freshness?.reason === "deduplicated")
      ? "PASS"
      : "FAIL",
    JSON.stringify(tick?.freshness).slice(0, 160),
  );

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
  // Release the L1 attempt so the L2 pipeline's own begin acquires the
  // slot (a typed failure ends the attempt; an interrupted run would
  // resume, never overlap).
  if (begin1?.status === "acquired") {
    await probe("probeFail", {
      manifestId: begin1.manifestId,
      attempt: begin1.attempt,
      reason: "proof_l1_overlap_released",
    });
  }

  // L2: the real pipeline. With the service credential the protocol port is
  // the REAL HTTP boundary (bearer-verified .site routes) so the run enters
  // exactly like the EU Container does and the boundary's own heartbeat/cost
  // effects exist for L7; without it, the guarded probe actions (the same
  // server functions, minus the HTTP layer).
  const protocol = SERVICE_TOKEN !== null ? httpProtocol(SERVICE_TOKEN) : probeProtocol();
  const deps = {
    protocol,
    exporter: {
      export: async () => {
        const bytes = await exportDatabase(dir);
        return { ok: true, bytes, sha256Hex: await sha256HexOf(bytes) };
      },
    },
    media: wranglerMedia(dir),
    store: wranglerStore(dir),
  };

  const l2 = await runBackup(deps);
  record(
    "L2-complete-set",
    l2.outcome === "verified" ? "PASS" : "FAIL",
    JSON.stringify(l2).slice(0, 200),
  );
  const state1 = (await probe("probeState", {}))?.value;
  // The L2 run's OWN row (by manifestId - the freshness fixture seeded a
  // past-dated verified row that must not satisfy this check).
  const verifiedRow = state1?.manifests?.find((m) => m.manifestId === l2.manifestId);
  record(
    "L2-manifest-row",
    verifiedRow !== undefined &&
      verifiedRow.state === "verified" &&
      typeof verifiedRow.manifestHash === "string" &&
      /^[a-f0-9]{64}$/.test(verifiedRow.manifestHash)
      ? "PASS"
      : "FAIL",
    JSON.stringify(verifiedRow).slice(0, 200),
  );

  // L3: a live interrupt + REAL takeover. The proof rides the NEXT slot via
  // the guarded proof-only clock fixture (L2 just verified the current slot,
  // which is `already_complete` forever). Attempt 1 begins 1 minute into
  // that slot, exports, then interrupts (after_export): the row stays
  // `building` with a live lease and NO manifest. The resume begins 14
  // minutes into the slot - past attempt 1's 12-minute lease, so the server
  // decides the real `lease_expired` takeover (attempt 2), still inside the
  // slot, with its re-anchored lease far in the future for the server's
  // real-clock completion check. The full interrupt matrix is unit-proven
  // in tests/i5/pipeline.test.ts.
  const currentSlot = Math.floor(Date.now() / SCHEDULE_INTERVAL_MS) * SCHEDULE_INTERVAL_MS;
  const l3Slot = currentSlot + SCHEDULE_INTERVAL_MS;
  const l3AttemptClock = l3Slot + 60_000;
  const l3ResumeClock = l3Slot + 14 * 60_000;
  let interrupted = false;
  try {
    await runBackup({ ...deps, protocol: probeProtocol(l3AttemptClock) }, { interruptAt: "after_export" });
  } catch (error) {
    interrupted = error instanceof Error && error.message.includes("pipeline interrupted");
  }
  const resumed = await runBackup({ ...deps, protocol: probeProtocol(l3ResumeClock) });
  const state3 = (await probe("probeState", {}))?.value;
  const l3Row = state3?.manifests?.find((m) => m.slotMs === l3Slot);
  record(
    "L3-interrupt-resume",
    interrupted && resumed.outcome === "verified" && l3Row?.state === "verified" && l3Row?.attempts === 2
      ? "PASS"
      : "FAIL",
    `interrupted=${interrupted} resume=${resumed.outcome} attempts=${l3Row?.attempts ?? "?"} state=${l3Row?.state ?? "?"}`,
  );

  // L4: corruption + typed failure. The tampered source is a FRESH fixture
  // whose pool copy does not exist yet (the copy pass is what catches it; an
  // already-stored byte-identical object would be a head-skip resume, by
  // design): the media object stops matching its inventory row's byte count
  // between seeding and the run, and the run must fail typed. The proof
  // rides the slot AFTER L3's (fresh, so begin starts attempt 1) through
  // the same guarded clock fixture.
  const corruptKey = `companies/i5-proof/uploads/corrupt-${Date.now()}/0-image`;
  const tampered = new TextEncoder().encode("tampered bytes");
  const tamperFile = join(dir, "tamper");
  await writeFile(tamperFile, tampered);
  const originalFile = join(dir, "corrupt-original");
  const originalBytes = new TextEncoder().encode("original retained fixture bytes");
  await writeFile(originalFile, originalBytes);
  await wranglerObjectPut(MEDIA_BUCKET, corruptKey, originalFile);
  await probe("probeSeedRetainedMedia", {
    objectKey: corruptKey,
    contentHash: `proof:${await sha256HexOf(originalBytes)}`,
    bytes: originalBytes.length,
    transformVersion: "i5.proof/1",
  });
  // Tamper the source AFTER the inventory row recorded it.
  await wranglerObjectPut(MEDIA_BUCKET, corruptKey, tamperFile);
  const l4Slot = currentSlot + 2 * SCHEDULE_INTERVAL_MS;
  const l4 = await runBackup({ ...deps, protocol: probeProtocol(l4Slot + 5 * 60_000) });
  record(
    "L4-corruption",
    l4.outcome === "failed" && ["media_hash_mismatch", "media_verify_failed"].includes(l4.reason) ? "PASS" : "FAIL",
    JSON.stringify(l4).slice(0, 160),
  );
  // Re-run hygiene: retained-media fixtures persist across passes (probeClear
  // clears manifests, not the D3 inventory), so the tampered object must go
  // back to the bytes its inventory row records - otherwise every LATER
  // pass's copy pass fails on this fixture instead of its own scenario.
  await wranglerObjectPut(MEDIA_BUCKET, corruptKey, originalFile);

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

  // L7: the HTTP boundary's own effects, read back from the PUBLIC health
  // state at the .site origin (HTTP routes never serve on .cloud). The
  // backup.job heartbeats are recorded by the boundary's begin/complete/fail
  // routes and the measured cost entries (provider `backup`) by the complete
  // route - effects the guarded probe actions bypass by design, so this row
  // requires L2 to have ridden the real boundary (service credential set).
  if (SERVICE_TOKEN !== null) {
    const health = await fetch(`${SITE}/platform/telemetry/health`).then((r) => r.json()).catch(() => null);
    const telemetry = health?.value?.telemetry ?? {};
    const heartbeatSeen = JSON.stringify(telemetry).includes("backup.job");
    const costSeen = JSON.stringify(telemetry?.costs ?? {}).includes("backup");
    record("L7-heartbeats", heartbeatSeen ? "PASS" : "FAIL", "backup.job present in health state");
    record("L7-costs", costSeen ? "PASS" : "FAIL", "backup provider present in cost accounting");
  } else {
    record(
      "L7-heartbeats",
      "NOT RUN",
      "KIERO_SERVICE_TOKEN absent: the HTTP boundary refuses every route (401) and the probe actions bypass the heartbeat layer by design",
    );
    record(
      "L7-costs",
      "NOT RUN",
      "KIERO_SERVICE_TOKEN absent: measured cost entries are recorded only by the HTTP complete route",
    );
  }

  process.exit(summarize() ? 0 : 1);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => null);
}
