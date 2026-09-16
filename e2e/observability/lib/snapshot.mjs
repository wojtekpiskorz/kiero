/**
 * Shared staging-truth helpers for the I11 observability drivers.
 *
 * SERVER TRUTH WITHOUT GM: a Convex snapshot export of the staging
 * deployment (`npx convex export`), parsed locally. No dashboard, no
 * privileged query, no env-var values are read anywhere here - table
 * documents only. Snapshots stay under the run's --out directory (tmp).
 *
 * Usage from the drivers:
 *   const snap = await exportSnapshot({ deployment, outDir, tag });
 *   const rows = snap.read("diagnosticEvents");
 *   const summary = summarizeSnapshot(snap, { markers: [...] });
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** The closed diagnostic event vocabulary from the I2 descriptor. */
export const EVENT_KINDS = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "infra", "observability", "events.json"), "utf8"),
).kinds;

/** The heartbeat model constants (mirrors convex/operations/telemetry/heartbeat.ts). */
export const HEARTBEAT_CADENCE_MS = {
  "gateway.worker": 5 * 60 * 1000,
  "backup.job": 15 * 60 * 1000,
  "media.worker": 15 * 60 * 1000,
  "export.worker": 15 * 60 * 1000,
};
export const SILENCE_TOLERANCE = 3;

/** The accepted diagnostic retention window (30 days) - retention.ts. */
export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Exports one staging snapshot and returns a reader over its tables.
 * The zip + extracted tree stay under `outDir` (never committed).
 */
export async function exportSnapshot({ deployment, outDir, tag }) {
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `snapshot-${tag}.zip`);
  const treePath = join(outDir, `snapshot-${tag}`);
  rmSync(zipPath, { force: true });
  rmSync(treePath, { recursive: true, force: true });
  await run("npx", ["--yes", "convex@1.45.0", "export", "--path", zipPath, "--deployment", deployment], {
    cwd: join(here, "..", "..", ".."),
    maxBuffer: 32 * 1024 * 1024,
  });
  await run("unzip", ["-o", "-q", zipPath, "-d", treePath]);
  const read = (table) => {
    try {
      return readFileSync(join(treePath, table, "documents.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { read, zipPath, treePath, at: new Date().toISOString() };
}

/** The metadata map of one diagnostic event row. */
function metaOf(event) {
  const map = {};
  for (const entry of event.technicalMetadata ?? []) {
    map[entry.key] = entry.value;
  }
  return map;
}

/** One PASS/FAIL/NOTE row of the recorder convention (e2e/helpers.mjs). */
export function recorder() {
  const rows = [];
  const push = (status, id, expected, observed) => {
    rows.push({ status, id, expected, observed });
    const mark = status === "PASS" ? "[PASS]" : status === "FAIL" ? "[FAIL]" : `[${status}]`;
    console.log(`${mark} ${id}: ${observed}`);
    if (status === "FAIL") console.log(`       expected: ${expected}`);
    return rows[rows.length - 1];
  };
  return {
    rows,
    pass: (id, expected, observed) => push("PASS", id, expected, observed),
    fail: (id, expected, observed) => push("FAIL", id, expected, observed),
    note: (id, expected, observed) => push("NOTE", id, expected, observed),
    blocked: (id, expected, observed) => push("BLOCKED", id, expected, observed),
    notRun: (id, expected, observed) => push("NOT RUN", id, expected, observed),
    allPassed: () => rows.every((row) => row.status === "PASS" || row.status === "NOTE"),
  };
}

/**
 * The leak scan over every diagnostic event: source-text markers, media
 * payload prefixes and credential shapes must never appear in the rows
 * that get forwarded to the sink (the sink payload is the same content).
 */
export function leakScan(events, markers) {
  const hits = [];
  const credentialShapes = [
    /sk-[A-Za-z0-9_-]{8,}/,
    /ghp_[A-Za-z0-9]{8,}/,
    /AKIA[0-9A-Z]{12,}/,
    /xox[baprs]-/,
    /Bearer\s+[A-Za-z0-9._-]{12,}/i,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
  ];
  const mediaShapes = [/UklGR/, /^\/9j\//, /R0lGODlh/, /iVBORw0KGgo/];
  const emailShape = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
  for (const event of events) {
    const blob = JSON.stringify(event);
    for (const marker of markers) {
      if (blob.includes(marker)) hits.push({ id: event._id, kind: event.kind, marker });
    }
    for (const shape of [...credentialShapes, ...mediaShapes]) {
      const match = shape.exec(blob);
      if (match) hits.push({ id: event._id, kind: event.kind, shape: String(shape) });
    }
    for (const [key, value] of Object.entries(metaOf(event))) {
      if (emailShape.test(value)) hits.push({ id: event._id, kind: event.kind, key, shape: "email" });
    }
  }
  return hits;
}

/**
 * The full server-truth summary of one snapshot: diagnostics, transport,
 * heartbeats/silence, backups, incidents, costs and the notification
 * lanes. Pure over the parsed tables; drivers assert on its fields.
 */
export function summarizeSnapshot(snap, options = {}) {
  const markers = options.markers ?? [];
  const events = snap.read("diagnosticEvents");
  const nowMs = Date.now();

  const byKind = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;

  // Transport state: forwardedAtMs is the Convex-side proof the sink leg
  // succeeded (cronTick marks rows only after an ok ingest).
  const forwarded = events.filter((e) => (e.forwardedAtMs ?? 0) > 0).length;

  // Retention: every stored row must sit inside the 30-day window.
  const atMsValues = events.map((e) => e.atMs).sort((a, b) => a - b);
  const oldestAgeDays = atMsValues.length
    ? Math.round(((nowMs - atMsValues[0]) / (24 * 60 * 60 * 1000)) * 100) / 100
    : null;

  // Closed vocabulary: every stored kind must be in events.json.
  const unknownKinds = [...new Set(events.map((e) => e.kind))].filter((k) => !EVENT_KINDS.includes(k));

  // Redaction: every row carries the sanitizer version; values bounded.
  const missingVersion = events.filter((e) => !e.redactionVersion).length;
  const oversized = events.filter((e) =>
    (e.technicalMetadata ?? []).some((m) => (m.value ?? "").length > 64),
  ).length;

  // Heartbeat ledger + per-service freshness from the same rule as the app.
  const heartbeats = snap.read("healthHeartbeats");
  const latest = {};
  for (const row of heartbeats) {
    const current = latest[row.serviceName];
    if (current === undefined || row.atMs > current.atMs) latest[row.serviceName] = row;
  }
  const services = Object.keys(HEARTBEAT_CADENCE_MS).map((serviceName) => {
    const last = latest[serviceName];
    if (last === undefined) return { serviceName, state: "never_seen" };
    const cadence = HEARTBEAT_CADENCE_MS[serviceName];
    const ageMs = Math.max(0, nowMs - last.atMs);
    const state = ageMs <= cadence * 2 ? "ok" : ageMs <= cadence * SILENCE_TOLERANCE ? "late" : "silent";
    return { serviceName, state, ageMs, lastStatus: last.status, atMs: last.atMs };
  });

  // Backups: manifest states, failure reasons and the freshness verdict the
  // 15-minute tick derives (never a fabricated verified snapshot).
  const manifests = snap.read("recoveryManifests");
  const manifestStates = {};
  const failureReasons = {};
  let newestVerified = null;
  let newestFailed = null;
  for (const row of manifests) {
    manifestStates[row.state] = (manifestStates[row.state] ?? 0) + 1;
    if (row.state === "failed") {
      failureReasons[row.failureReason ?? "none"] = (failureReasons[row.failureReason ?? "none"] ?? 0) + 1;
      if (newestFailed === null || row.snapshotAtMs > newestFailed) newestFailed = row.snapshotAtMs;
    }
    if (row.state === "verified" && (newestVerified === null || row.snapshotAtMs > newestVerified)) {
      newestVerified = row.snapshotAtMs;
    }
  }
  const anyAttempt = manifests.length > 0;
  const backupFreshness =
    newestVerified === null
      ? anyAttempt
        ? { state: "never_verified", emittedKind: "ops.backup.stale" }
        : { state: "no_attempts" }
      : nowMs - newestVerified > 60 * 60 * 1000
        ? { state: "stale", ageMs: nowMs - newestVerified, emittedKind: "ops.backup.stale" }
        : { state: "fresh", ageMs: nowMs - newestVerified };

  // Incidents: standing failed jobs/outbox rows vs the emitted deduped events.
  const jobs = snap.read("durableJobs");
  const exhaustedJobs = jobs.filter((j) => j.state === "failed" && j.attempts >= j.maxAttempts);
  const exhaustedEvents = events.filter((e) => e.kind === "ops.job.attempts_exhausted");
  const exhaustedEventJobKeys = new Set(
    exhaustedEvents.map((e) => metaOf(e).jobKey).filter(Boolean),
  );
  const outbox = snap.read("outboxEvents");
  const failedOutbox = outbox.filter((o) => o.deliveryState === "failed");
  const outboxFailedEvents = events.filter((e) => e.kind === "ops.outbox.delivery_failed");
  const processingRuns = snap.read("processingRuns");
  const stuckRuns = processingRuns.filter(
    (r) => r.state === "running" && nowMs - r.startedAtMs > 30 * 60 * 1000,
  );
  const stuckEvents = events.filter((e) => e.kind === "ops.processing.stuck");
  const silenceEvents = events.filter((e) => e.kind === "ops.health.silence_detected");
  const staleEvents = events.filter((e) => e.kind === "ops.backup.stale");
  const incidentJobsWithoutEvent = exhaustedJobs.filter((j) => !exhaustedEventJobKeys.has(j.jobKey));

  // Costs: the live accounting rows and the provider-call volume that
  // SHOULD be feeding them (metered AI/media spend evidence).
  const costEntries = snap.read("costEntries");
  const costAlertStates = snap.read("costAlertStates");
  const costByProvider = {};
  let costTotalMinor = 0;
  for (const entry of costEntries) {
    costByProvider[entry.provider] = (costByProvider[entry.provider] ?? 0) + entry.amountMinor;
    costTotalMinor += entry.amountMinor;
  }
  const providerCalls = outbox.filter((o) => (o.dedupKey ?? "").startsWith("integrations.modelCall"));
  const costPeriod = new Date().toISOString().slice(0, 7);

  // The notification lanes (task reminders, intents, push) - full table
  // state plus the optional one-company slice the funnel driver passes.
  const intents = snap.read("notificationIntents");
  const intentsBy = {};
  for (const intent of intents) {
    const key = `${intent.semanticKind}:${intent.state}`;
    intentsBy[key] = (intentsBy[key] ?? 0) + 1;
  }
  const reminderSchedules = snap.read("reminderSchedules");
  const schedulesByStatus = {};
  for (const row of reminderSchedules) {
    schedulesByStatus[row.status] = (schedulesByStatus[row.status] ?? 0) + 1;
  }
  const pushSubscriptions = snap.read("pushSubscriptions");
  const pushDeliveries = snap.read("pushDeliveries");
  const pushByState = {};
  for (const row of pushDeliveries) {
    pushByState[row.state] = (pushByState[row.state] ?? 0) + 1;
  }

  const summary = {
    snapshotAt: snap.at,
    diagnosticEvents: {
      total: events.length,
      byKind,
      unknownKinds,
      forwarded,
      unforwarded: events.length - forwarded,
      missingRedactionVersion: missingVersion,
      oversizedMetadataValues: oversized,
      oldestAgeDays,
      withinRetentionWindow: oldestAgeDays === null || oldestAgeDays <= 30,
      leakHits: leakScan(events, markers),
    },
    heartbeats: {
      ledgerRows: heartbeats.length,
      services,
      silenceEvents: silenceEvents.length,
    },
    backups: {
      manifests: manifests.length,
      manifestStates,
      failureReasons,
      newestVerifiedAtMs: newestVerified,
      newestFailedAtMs: newestFailed,
      freshness: backupFreshness,
      staleEvents: staleEvents.map((e) => ({
        atMs: e.atMs,
        state: metaOf(e).state,
        ageMs: metaOf(e).ageMs,
        dedupKey: e.dedupKey,
      })),
    },
    incidents: {
      exhaustedJobs: exhaustedJobs.length,
      attemptsExhaustedEvents: exhaustedEvents.length,
      distinctEventJobKeys: exhaustedEventJobKeys.size,
      exhaustedJobsWithoutEvent: incidentJobsWithoutEvent.length,
      failedOutboxRows: failedOutbox.length,
      outboxDeliveryFailedEvents: outboxFailedEvents.length,
      stuckRuns: stuckRuns.length,
      processingStuckEvents: stuckEvents.length,
      processingRuns: processingRuns.length,
    },
    costs: {
      period: costPeriod,
      entries: costEntries.length,
      byProvider: costByProvider,
      totalMinor: costTotalMinor,
      alertStates: costAlertStates,
      providerCallEvents: providerCalls.length,
    },
    notifications: {
      intents: intents.length,
      intentsBy,
      reminderSchedules: reminderSchedules.length,
      schedulesByStatus,
      pushSubscriptions: pushSubscriptions.length,
      pushDeliveries: pushDeliveries.length,
      pushByState,
      snoozes: snap.read("reminderSnoozes").length,
    },
  };

  if (options.companyId !== undefined) {
    summary.session = sessionSlice(snap, options.companyId, markers);
  }
  return summary;
}

/** The one-company slice for the funnel run's own namespaced records. */
export function sessionSlice(snap, companyId, markers = []) {
  const owned = (rows, field = "companyId") => rows.filter((row) => row[field] === companyId);
  const intents = owned(snap.read("notificationIntents"));
  const tasks = owned(snap.read("tasks"));
  return {
    companyId,
    tasks: tasks.map((t) => ({
      taskId: t._id,
      title: t.title,
      state: t.state,
      hasDeadline: t.deadlineFindingId !== undefined,
      coordinatorAssigned: t.coordinatorMembershipId !== undefined,
      createdAtMs: t._creationTime,
    })),
    reminderSchedules: owned(snap.read("reminderSchedules")).map((s) => ({
      taskId: s.taskId,
      status: s.status,
      scheduleEpoch: s.scheduleEpoch ?? null,
      pendingKeys: s.pendingKeys ?? [],
    })),
    reminderIntents: intents
      .filter((i) => i.semanticKind === "task_reminder")
      .map((i) => ({
        intentId: i._id,
        state: i.state,
        dueAtMs: i.dueAtMs,
        deliveredAtMs: i.deliveredAtMs ?? null,
        suppressedReason: i.suppressedReason ?? null,
        dedupKey: i.dedupKey,
        deliveryJson: i.deliveryJson ?? null,
        lastEvaluatedAtMs: i.lastEvaluatedAtMs ?? null,
      })),
    otherIntents: intents
      .filter((i) => i.semanticKind !== "task_reminder")
      .map((i) => ({ kind: i.semanticKind, state: i.state, dueAtMs: i.dueAtMs })),
    snoozes: owned(snap.read("reminderSnoozes")).length,
    pushSubscriptions: owned(snap.read("pushSubscriptions")).length,
    pushDeliveries: owned(snap.read("pushDeliveries")).length,
    markerLeakHits: leakScan(snap.read("diagnosticEvents"), markers),
  };
}

/** Finds the company id of the funnel run by company name (namespaced). */
export function companyIdByName(snap, name) {
  const match = snap.read("companies").filter((c) => c.name === name);
  return match.length === 1 ? match[0]._id : null;
}

/** Short stable run id for namespacing synthetic records. */
export function runId() {
  return createHash("sha256")
    .update(`${Date.now()}${process.pid}${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

/** Writes one JSON artifact (sanitized: no credential values anywhere). */
export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}
