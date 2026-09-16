#!/usr/bin/env node
/**
 * Assembles the I11 evidence bundle from the sanitized run artifacts of the
 * two drivers into docs/evidence/observability/ (results.json + per-run
 * copies). Reads only the -result.json files the drivers wrote; nothing
 * here touches the live deployment.
 *
 * Run after both drivers:
 *   node e2e/observability/collect-evidence.mjs \
 *     --ops /tmp/kiero-i11/ops-run/ops-surface-result.json \
 *     --funnel /tmp/kiero-i11/funnel-run/funnel-result.json
 */

import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const opsPath = value("--ops");
const funnelPath = value("--funnel");
const evidenceDir = join(here, "..", "..", "docs", "evidence", "observability");
mkdirSync(join(evidenceDir, "runs"), { recursive: true });

const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(here, "..", "..") })
  .toString()
  .trim();

/** The owner-side rows: everything this session cannot verify itself. */
const OWNER_ROWS = [
  {
    id: "Axiom receipt verification",
    status: "BLOCKED",
    actor: "owner",
    action:
      "Open the Axiom dataset (kiero-staging, EU) and verify ingested events carry environment=staging and the closed kind vocabulary. NOTE: the Convex-side marker forwardedAtMs is 0 on every stored event while the AXIOM_API_TOKEN/AXIOM_DATASET names are present on the staging deployment, so the Convex->Axiom ingest leg has never succeeded within the 1h forward window; the owner check must start from the Axiom ingest monitor/API, and a 401/404 there is the likely live transport failure, not a missing token name.",
    resumption: "owner dashboard/API access to the dataset",
  },
  {
    id: "Axiom monitor creation + alert destination",
    status: "BLOCKED",
    actor: "owner",
    action:
      "Create the three monitors exactly as infra/observability/monitors.json defines (Axiom Personal permits exactly three), replace OWNER_PLACEHOLDER with the owner-decided recipient (wojtek@honestly.design, docs/evidence/staging/candidate.json ownerDecisions), and point the APL dataset filter at the live dataset name. The committed APL reads kiero-staging (corrected in this lane); verify it still matches the provisioned dataset before creating the monitors.",
    resumption: "Axiom account access (owner)",
  },
  {
    id: "Actual owner alert delivery",
    status: "BLOCKED",
    actor: "owner",
    action:
      "After the monitors exist and the ingest leg works, record one real delivered alert email (processing incidents and/or cost threshold) at the recipient, with timestamp and message id, into docs/evidence/observability/. The Convex-side events that would trigger them already exist on staging (11 deduped ops.job.attempts_exhausted, 1 ops.backup.stale).",
    resumption: "monitor creation + working ingest",
  },
  {
    id: "Metered all-in cost report",
    status: "BLOCKED",
    actor: "owner",
    action:
      "Read the provider dashboards (Convex usage, Cloudflare Workers/R2/Containers/Images, OpenRouter, DeepSeek, Resend, Axiom) for 2026-09 and append the actual PLN/USD amounts to docs/evidence/observability/cost-report-2026-09.md. Convex-side costEntries carry none of it (see the cost report).",
    resumption: "dashboard access (owner)",
  },
  {
    id: "400/500 PLN threshold crossing on staging",
    status: "BLOCKED",
    actor: "owner/coordinator",
    action:
      "The controlled accounting fixture (operations/telemetry/proof:probeSeedCost) is guarded by KIERO_PROBE_ENABLED, which must stay unset on the qualification user path (infra/bindings/convex-functions.md). Crossing the thresholds on staging requires an owner-approved isolated window with the guard set (then unset), or acceptance of the dev/i2 fixture proof in docs/evidence/telemetry/README.md as the logic evidence. No env var was touched by this session.",
    resumption: "owner decision on the guarded window",
  },
  {
    id: "Independent external heartbeat prober",
    status: "BLOCKED",
    actor: "coordinator (gateway owner lane)",
    action:
      "apps/gateway/wrangler.jsonc carries no triggers.crons block, so the Worker cron external-prober role (the missing-heartbeat detector independent of Convex) is inert on staging: gateway.worker is never_seen. Add the */5 cron trigger to the staging env block and redeploy; then the sink-side silence monitor (owner row above) covers total backend silence.",
    resumption: "gateway wrangler edit + release",
  },
  {
    id: "Physical web-push delivery",
    status: "NOT RUN",
    actor: "J4 #63",
    action:
      "Push delivery proof needs VAPID at runtime plus real device push services (physical iPhone+Android); J4 owns it. This session exercised only the designed enable path and its honest in-browser states.",
    resumption: "J4 devices",
  },
  {
    id: "In-app silence episode on staging",
    status: "NOT RUN",
    actor: "-",
    action:
      "No natural silence window occurred: backup.job heartbeats every 15 minutes without gaps (oldest gap well under the 45-minute threshold) and the never_seen lanes never emit by design. Fabricating one needs KIERO_PROBE_ENABLED (guarded) or stopping the backup container (an owner infrastructure action). The detector logic is proven in tests/i2 and the dev/i2 round-1 proof.",
    resumption: "natural incident or owner-approved window",
  },
];

const result = {
  issue: "I11 #138",
  generatedAt: new Date().toISOString(),
  candidate: revision,
  environment: {
    web: "https://kiero-staging-web.wojtek-524.workers.dev",
    convex: "wojtek-piskorz-jr:kiero-dev-core:staging (fiery-raven-417)",
    gateway: "https://kiero-staging-gateway.wojtek-524.workers.dev",
    axiom: "dataset kiero-staging (EU), names AXIOM_API_TOKEN/AXIOM_DATASET present on the deployment (values never read)",
    note: "KIERO_GM_EMAILS untouched; no GM-panel flow; no staging env var changed; no wrangler deploy",
  },
  runs: {},
  ownerRows: OWNER_ROWS,
};

/**
 * Sanitizes a run artifact for the committed copy: the deliberately fake
 * credential-shaped leak-scan marker (a synthetic `sk-proj-` token that
 * must NEVER appear in any diagnostic event) is replaced by a placeholder
 * so no secret scanner ever trips over the evidence bundle.
 */
function sanitizedCopy(path, destination) {
  const raw = readFileSync(path, "utf8").replace(/sk-proj-I11OBS[a-z0-9]+/g, "sk-proj-I11OBS<synthetic-marker>");
  writeFileSync(destination, raw);
}

if (opsPath !== undefined) {
  const ops = JSON.parse(readFileSync(opsPath, "utf8"));
  result.runs.opsSurface = {
    at: ops.at,
    rows: ops.rows,
    allPassed: ops.allPassed,
    sanitized: "runs/ops-surface.json",
  };
  sanitizedCopy(opsPath, join(evidenceDir, "runs", "ops-surface.json"));
}
if (funnelPath !== undefined) {
  const funnel = JSON.parse(readFileSync(funnelPath, "utf8"));
  result.runs.funnelReminders = {
    at: funnel.at,
    runId: funnel.runId,
    rows: funnel.rows,
    allPassed: funnel.allPassed,
    sanitized: "runs/funnel-reminders.json",
  };
  sanitizedCopy(funnelPath, join(evidenceDir, "runs", "funnel-reminders.json"));
}

writeFileSync(join(evidenceDir, "results.json"), JSON.stringify(result, null, 2));
console.log(`results.json written (${result.runs.opsSurface?.rows.length ?? 0} ops rows, ${result.runs.funnelReminders?.rows.length ?? 0} funnel rows)`);
