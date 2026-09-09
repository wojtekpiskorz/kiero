/**
 * I2 live proof: real redacted diagnostics through the real Convex
 * deployment (wojtek-piskorz-jr:kiero-dev-core:dev/i2, brazen-cardinal-240).
 *
 * Rows proved (issue #54 acceptance + focused verification):
 *
 *   T1 adversarial payloads emitted through the REAL function boundary are
 *      redacted/rejected, and the stored rows (read back through the query
 *      surface) carry no sensitive value.
 *   T2 the incident scan diagnoses a REAL failed outbox row (unprojected
 *      consumer edge, produced through A3's own machinery) exactly once.
 *   T3 an external heartbeat lands in the ledger; the composed health
 *      endpoint returns heartbeat state, costs and the honesty block.
 *   T4 the 400 PLN warning and 500 PLN alert fire with cooldown suppression;
 *      synthetic entries are cleaned up afterwards.
 *   T5 sink forwarding reports the honest not-configured reason (no Axiom
 *      account exists; PENDING owner action).
 *
 * Usage (repo root): node docs/evidence/telemetry/scripts/proof-telemetry.mjs
 * Requires .env.local with CONVEX_DEPLOYMENT + KIERO_SERVICE_TOKEN and
 * KIERO_PROBE_ENABLED=1 on the deployment.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const run = promisify(execFile);
const CONVEX_CLI = "npx";
const CONVEX_CLI_ARGS = [
  "--yes",
  "convex@1.45.0",
  "run",
  "--deployment",
  "wojtek-piskorz-jr:kiero-dev-core:dev/i2",
];

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }),
);

const SITE = "https://brazen-cardinal-240.eu-west-1.convex.site";
const TOKEN = env.KIERO_SERVICE_TOKEN;

async function convex(fn, args) {
  const { stdout } = await run(CONVEX_CLI, [...CONVEX_CLI_ARGS, fn, JSON.stringify(args)], {
    env: { ...process.env, CONVEX_DEPLOYMENT: env.CONVEX_DEPLOYMENT },
  });
  return stdout.trim();
}

async function post(path, body, withAuth = true) {
  const response = await fetch(`${SITE}${path}`, {
    method: "POST",
    headers: {
      ...(withAuth ? { authorization: `Bearer ${TOKEN}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getHealth() {
  const response = await fetch(`${SITE}/platform/telemetry/health`);
  return { status: response.status, body: await response.json() };
}

const PERIOD = new Date().toISOString().slice(0, 7);
const LABEL = "i2-proof";

function summarizeState(state) {
  return {
    atMs: state.atMs,
    recentKinds: state.diagnostics.recent.map((e) => e.kind),
    recentRedactions: state.diagnostics.recent.map((e) => e.redactionsApplied ?? 0),
    healthServices: state.health.services.map(
      (s) => `${s.serviceName}:${s.state}${s.lastStatus === "degraded" ? ":degraded" : ""}`,
    ),
    costs: {
      period: state.costs.period,
      totalMinor: state.costs.totalMinor,
      thresholds: state.costs.thresholds,
      alertStates: state.costs.alertStates,
    },
    observability: state.observability,
  };
}

// --- T1: adversarial payloads through the real sanitized write path ---------

console.log("== T1: adversarial emit through the real boundary ==");
const adversarial = await convex("operations/telemetry/proof:probeEmit", {
  payload: {
    kind: "ops.processing.failed",
    metadata: [
      { key: "errorKind", value: "429 Too Many Requests: rate limit exceeded" },
      { key: "state", value: "wycena dachu Baniewice za 45 tysięcy netto" },
      { key: "runId", value: "sk-proj-4f8a9b2c1d6e7f80a9b2c1d6e7f80a9b2" },
      { key: "message", value: "UklGRh4AAAA3 raw audio marker" },
    ],
  },
});
console.log("adversarial emit:", adversarial);

const honest = await convex("operations/telemetry/proof:probeEmit", {
  payload: {
    kind: "ops.processing.completed",
    metadata: [
      { key: "runId", value: "p97bxdbr9x2jd9x73ha8dtc9hkchm0f1" },
      { key: "pipelineVersion", value: "a3-mechanical-1" },
      { key: "latencyMs", value: "1840" },
      { key: "state", value: "succeeded" },
    ],
  },
});
console.log("honest emit:", honest);

const rejected = await convex("operations/telemetry/proof:probeEmit", {
  payload: { kind: "ops.evil.kind", metadata: [] },
});
console.log("unknown-kind emit:", rejected);

// --- T2: a real incident through A3's own machinery ---------------------------

console.log("\n== T2: incident scan over a real failed outbox row ==");
await convex("platform/probe:probeSeed", {});
const publication = await convex("platform/probe:probePublishEvent", {
  eventName: "sources.sourceAccepted",
  payload: { sourceId: "seeded", attachmentIds: [] },
});
console.log("published unprojected-edge event:", publication);
await convex("platform/probe:probeDrainNow", {});
const tick1 = await convex("operations/telemetry/proof:probeTick", {});
console.log("tick 1 (scan):", tick1);
const tick2 = await convex("operations/telemetry/proof:probeTick", {});
console.log("tick 2 (dedup - same incident must NOT re-emit):", tick2);

// --- T3: external heartbeat + composed health endpoint -----------------------

console.log("\n== T3: heartbeat + composed health ==");
const heartbeat = await post("/platform/telemetry/heartbeat", {
  serviceName: "gateway.worker",
  status: "ok",
});
console.log("heartbeat POST:", heartbeat.status, JSON.stringify(heartbeat.body));

// --- T4: 400/500 PLN thresholds with cooldown ---------------------------------

console.log("\n== T4: cost thresholds ==");
await convex("operations/telemetry/proof:probeSeedCost", {
  period: PERIOD,
  provider: "convex",
  category: "compute",
  amountMinor: 39999,
  basis: "estimate",
  label: LABEL,
});
const belowTick = await convex("operations/telemetry/proof:probeTick", {});
console.log(`below 400 PLN (399.99):`, belowTick);

await convex("operations/telemetry/proof:probeSeedCost", {
  period: PERIOD,
  provider: "ai_openrouter",
  category: "inference",
  amountMinor: 101,
  basis: "estimate",
  label: LABEL,
});
const warningTick = await convex("operations/telemetry/proof:probeTick", {});
console.log(`crossing 400 PLN (400.00):`, warningTick);

const suppressedTick = await convex("operations/telemetry/proof:probeTick", {});
console.log("immediate re-tick (cooldown must suppress):", suppressedTick);

await convex("operations/telemetry/proof:probeSeedCost", {
  period: PERIOD,
  provider: "workers",
  category: "compute",
  amountMinor: 10000,
  basis: "estimate",
  label: LABEL,
});
const alertTick = await convex("operations/telemetry/proof:probeTick", {});
console.log("crossing 500 PLN (500.00):", alertTick);

// --- read back through the query surface --------------------------------------

console.log("\n== composed health read-back ==");
const health = await getHealth();
const summary = health.body._tag === "ok" ? health.body.value : health.body;
console.log("HTTP status:", health.status);
console.log("deployment:", summary.deployment);
console.log("platform health:", JSON.stringify({
  status: summary.platform.status,
  runtimeVersion: summary.platform.runtimeVersion,
  observability: summary.platform.observability,
  outbox: summary.platform.outbox,
}));
console.log("telemetry state:", JSON.stringify(summarizeState(summary.telemetry)));

// sensitive-content scan over everything read back
const serialized = JSON.stringify(summary);
const forbidden = ["wycena", "Baniewice", "UklGR", "sk-proj", "429 Too Many", "rate limit"];
const leaked = forbidden.filter((needle) => serialized.includes(needle));
console.log("sensitive-content scan leaks:", leaked.length === 0 ? "NONE (PASS)" : leaked);

// --- T5 + cleanup --------------------------------------------------------------

console.log("\n== T5: sink forward status ==");
console.log("forward reason in ticks above (axiom_not_configured expected).");

const cleanup = await convex("operations/telemetry/proof:probeClearCosts", { label: LABEL });
console.log("cleanup:", cleanup);
