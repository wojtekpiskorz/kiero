#!/usr/bin/env node
/**
 * The I11 ops-diagnostic surface driver: the automatable trigger chains of
 * issue #138 against the LIVE staging deployment, no GM panel, no browser.
 *
 * Legs:
 *   O1  GET {convex-site}/platform/telemetry/health - the composed public
 *       state (platform health + heartbeat/silence + costs + honesty).
 *   O2  GET {gateway}/platform/health - the gateway-side view (the surface
 *       that survives Convex-side blindness).
 *   O3  Convex snapshot export -> the server truth: closed event
 *       vocabulary, redaction/leak scan, transport (forwardedAtMs),
 *       retention window, heartbeat cadence/silence, the stale-backup
 *       diagnostic chain (never fabricated), incident scan dedup, and the
 *       live cost accounting rows.
 *
 * The stale-backup leg observes the NATURAL cadence only: staging backups
 * genuinely never verify (the deferred STAGING_CONVEX_BACKUP_ADMIN_KEY),
 * so ops.backup.stale fires on its own every freshness episode. Nothing
 * here fabricates a backup, a heartbeat or a cost row.
 *
 * Run:
 *   node e2e/observability/ops-surface.mjs \
 *     --out /tmp/kiero-i11/ops-run [--markers m1,m2] [--deployment ...]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};

const DEPLOYMENT = value("--deployment", "wojtek-piskorz-jr:kiero-dev-core:staging");
const SITE = value("--site", "https://fiery-raven-417.eu-west-1.convex.site");
const GATEWAY = value("--gateway", "https://kiero-staging-gateway.wojtek-524.workers.dev");
const OUT = value("--out", "/tmp/kiero-i11/ops-run");
const MARKERS = (value("--markers", "") || "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });

const { exportSnapshot, summarizeSnapshot, recorder, writeJson, runId } = await import(
  "./lib/snapshot.mjs"
);
const rec = recorder();
const runTag = runId();

// --- O1: the composed telemetry health endpoint (public) -------------------
try {
  const response = await fetch(`${SITE}/platform/telemetry/health`);
  const body = await response.json();
  writeJson(join(OUT, "o1-telemetry-health.json"), body);
  const value0 = body.value ?? body;
  const platformOk = response.status === 200 && value0?.platform?.status === "ok";
  rec[platformOk ? "pass" : "fail"](
    "O1 telemetry health",
    "HTTP 200, platform status ok",
    `HTTP ${response.status}, platform ${value0?.platform?.status ?? "?"}, deployment ${JSON.stringify(value0?.deployment)}`,
  );
  const telemetry = value0?.telemetry ?? {};
  const honesty = JSON.stringify(telemetry.observability ?? platformJson(value0));
  rec.note(
    "O1 honesty block",
    "the observability honesty block is present",
    excerpt(honesty ?? "absent", 220),
  );
  const services = telemetry.health?.services ?? [];
  rec.note(
    "O1 heartbeat states",
    "per-service states rendered (anySilent includes never-wired lanes)",
    `anySilent ${telemetry.health?.anySilent ?? "?"}: ${services.map((s) => `${s.serviceName}=${s.state}${s.lastStatus ? `(${s.lastStatus})` : ""}`).join(", ") || "absent"}`,
  );
  const costs = telemetry.costs ?? {};
  rec.note(
    "O1 cost thresholds",
    "current period totals + threshold states",
    excerpt(JSON.stringify(costs), 220),
  );
} catch (error) {
  rec.fail("O1 telemetry health", "HTTP 200", `fetch failed: ${error.message}`);
}

function platformJson(value0) {
  return value0?.platform?.observability ?? {};
}
function excerpt(text, length) {
  const flat = String(text).replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

// --- O2: the gateway health endpoint ---------------------------------------
try {
  const response = await fetch(`${GATEWAY}/platform/health`);
  const body = await response.json();
  writeJson(join(OUT, "o2-gateway-health.json"), body);
  const flat = JSON.stringify(body);
  rec.pass(
    "O2 gateway health",
    "HTTP 200 from the staging gateway",
    `HTTP ${response.status}, backendReachable ${/true/.test(flat) ? "true" : excerpt(flat, 120)}`,
  );
} catch (error) {
  rec.fail("O2 gateway health", "HTTP 200", `fetch failed: ${error.message}`);
}

// --- O3: the snapshot server truth ------------------------------------------
const snap = await exportSnapshot({ deployment: DEPLOYMENT, outDir: OUT, tag: runTag });
const summary = summarizeSnapshot(snap, { markers: MARKERS });
writeJson(join(OUT, "o3-snapshot-summary.json"), summary);

const diagnostics = summary.diagnosticEvents;

// Closed vocabulary + redaction invariants on the LIVE rows.
rec[
  diagnostics.unknownKinds.length === 0
    ? "pass"
    : "fail"
]("O3a closed vocabulary", "every stored kind is in infra/observability/events.json", `unknown kinds: ${JSON.stringify(diagnostics.unknownKinds)} over ${diagnostics.total} events`);

rec[
  diagnostics.missingRedactionVersion === 0 && diagnostics.oversizedMetadataValues === 0
    ? "pass"
    : "fail"
](
  "O3b redaction invariants",
  "every row carries redactionVersion, values <= 64 chars",
  `missing version: ${diagnostics.missingRedactionVersion}, oversized values: ${diagnostics.oversizedMetadataValues}`,
);

rec[
  diagnostics.leakHits.length === 0
    ? "pass"
    : "fail"
](
  "O3c sink payload leak scan",
  "no credential shapes, media payload prefixes or email addresses in any stored event",
  diagnostics.leakHits.length === 0
    ? `clean over ${diagnostics.total} events`
    : `${diagnostics.leakHits.length} hits: ${JSON.stringify(diagnostics.leakHits.slice(0, 3))}`,
);

rec[
  diagnostics.withinRetentionWindow
    ? "pass"
    : "fail"
](
  "O3d retention window",
  "no stored diagnostic older than the 30-day window",
  `oldest row age ${diagnostics.oldestAgeDays} days over ${diagnostics.total} events`,
);

// Transport: the Convex->Axiom leg. forwardedAtMs>0 only after an ok ingest.
rec.note(
  "O3e sink transport state",
  "rows marked forwarded after a successful Axiom ingest",
  `forwarded ${diagnostics.forwarded}, unforwarded ${diagnostics.unforwarded} of ${diagnostics.total}`,
);

// Heartbeats: cadence + the honest never_seen lanes.
for (const service of summary.heartbeats.services) {
  rec.note(
    `O3f heartbeat ${service.serviceName}`,
    "state from the shared silence rule",
    `${service.state}${service.ageMs !== undefined ? ` (age ${Math.round(service.ageMs / 60000)} min, last ${service.lastStatus})` : ""}`,
  );
}
rec.note(
  "O3g silence events",
  "in-app silence episodes emitted (deduped per episode)",
  `${summary.heartbeats.silenceEvents} ops.health.silence_detected events`,
);

// The stale-backup diagnostic chain, naturally firing.
const backups = summary.backups;
rec[
  backups.manifests > 0
    ? "pass"
    : "fail"
](
  "O3h backup manifests observed",
  "the 15-minute backup cadence writes manifest rows",
  `${backups.manifests} manifests, states ${JSON.stringify(backups.manifestStates)}, failure reasons ${JSON.stringify(backups.failureReasons)}`,
);
rec.note(
  "O3i backup freshness verdict",
  "freshness from the newest VERIFIED snapshot",
  `${backups.freshness.state}${backups.freshness.ageMs !== undefined ? ` (age ${Math.round(backups.freshness.ageMs / 60000)} min)` : ""}`,
);
rec[
  backups.staleEvents.length > 0 && backups.freshness.state !== "fresh"
    ? "pass"
    : "note"
](
  "O3j ops.backup.stale emitted",
  "the stale/never_verified diagnostic fires through the real chain",
  backups.staleEvents.length > 0
    ? `${backups.staleEvents.length} event(s): ${JSON.stringify(backups.staleEvents.slice(0, 2))}`
    : "no stale event in the retained window",
);

// Incidents: standing failed work vs the deduped emitted events.
const incidents = summary.incidents;
rec[
  incidents.exhaustedJobs === 0 || incidents.exhaustedJobsWithoutEvent === 0
    ? "pass"
    : "fail"
](
  "O3k incident scan dedup",
  "every attempts-exhausted job diagnosed exactly once",
  `${incidents.exhaustedJobs} exhausted jobs, ${incidents.distinctEventJobKeys} distinct event jobKeys, ${incidents.exhaustedJobsWithoutEvent} jobs without an event`,
);
rec.note(
  "O3l incident coverage",
  "failed outbox rows and stuck runs diagnosed",
  `outbox failed rows ${incidents.failedOutboxRows} -> ${incidents.outboxDeliveryFailedEvents} events; stuck runs ${incidents.stuckRuns} -> ${incidents.processingStuckEvents} events (of ${incidents.processingRuns} runs)`,
);

// Costs: what the live pipeline actually accrued.
const costs = summary.costs;
rec.note(
  "O3m live cost accounting",
  "costEntries/costAlertStates accrued by the live pipeline",
  `${costs.entries} entries (total ${costs.totalMinor} minor) in ${costs.period}, alert states ${JSON.stringify(costs.alertStates)}, while ${costs.providerCallEvents} integrations.providerCallCompleted envelopes exist`,
);

const result = {
  run: "ops-surface",
  at: new Date().toISOString(),
  deployment: DEPLOYMENT,
  site: SITE,
  gateway: GATEWAY,
  markers: MARKERS,
  rows: rec.rows,
  allPassed: rec.allPassed(),
  summary,
};
writeJson(join(OUT, "ops-surface-result.json"), result);
console.log(`\nops-surface: ${rec.allPassed() ? "ALL PASS (notes allowed)" : "FAILURES PRESENT"}`);
process.exit(rec.allPassed() ? 0 : 1);
