/**
 * I2 round-1 live re-proofs (deployment brazen-cardinal-240 / dev/i2):
 *
 *   R1a one heartbeat POST produces EXACTLY ONE ops.health.heartbeat event
 *       (single emission point: recordHeartbeat).
 *   R1b the silence loop is closed: a stale heartbeat (seeded fixture) makes
 *       the tick emit ops.health.silence_detected once (episode dedup), and
 *       the composed health read shows the service silent; cleanup restores.
 *   R1c the indexed incident scan still diagnoses the standing failed
 *       outbox rows (no re-emission: deduped).
 *
 * Usage (repo root): node docs/evidence/telemetry/scripts/proof-round1.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const run = promisify(execFile);

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

async function convex(fn, args = {}) {
  const { stdout } = await run(
    "npx",
    [
      "--yes",
      "convex@1.45.0",
      "run",
      "--deployment",
      "wojtek-piskorz-jr:kiero-dev-core:dev/i2",
      fn,
      JSON.stringify(args),
    ],
    { env: { ...process.env, CONVEX_DEPLOYMENT: env.CONVEX_DEPLOYMENT } },
  );
  return JSON.parse(stdout.trim());
}

async function state() {
  const result = await convex("operations/telemetry/proof:probeState");
  return result.value;
}

function heartbeatEventCount(s) {
  return s.diagnostics.recent.filter((e) => e.kind === "ops.health.heartbeat").length;
}
function silenceEventCount(s) {
  return s.diagnostics.recent.filter((e) => e.kind === "ops.health.silence_detected").length;
}

// --- R1a: one POST -> one event ------------------------------------------------

const before = await state();
const response = await fetch(`${SITE}/platform/telemetry/heartbeat`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ serviceName: "gateway.worker", status: "ok" }),
});
console.log("R1a heartbeat POST:", response.status, JSON.stringify(await response.json()));
const after = await state();
const delta =
  heartbeatEventCount(after) - (heartbeatEventCount(before) < 20 ? heartbeatEventCount(before) : 0);
console.log(
  "R1a heartbeat events in recent window before/after POST:",
  heartbeatEventCount(before),
  "->",
  heartbeatEventCount(after),
  `(delta ${delta}: exactly one new event per ping expected)`,
);

// --- R1b: silence loop -----------------------------------------------------------

await convex("operations/telemetry/proof:probeClearHeartbeats", { serviceName: "backup.job" });
const seeded = await convex("operations/telemetry/proof:probeSeedStaleHeartbeat", {
  serviceName: "backup.job",
  ageMinutes: 60,
});
console.log("R1b seeded stale backup.job heartbeat:", JSON.stringify(seeded.value));

const silenceBefore = await state();
const tick1 = await convex("operations/telemetry/proof:probeTick");
console.log("R1b tick 1:", JSON.stringify(tick1.value.silence));
const afterTick1 = await state();
const tick2 = await convex("operations/telemetry/proof:probeTick");
const afterTick2 = await state();
console.log(
  "R1b silence events before/after tick1/after tick2:",
  silenceEventCount(silenceBefore),
  silenceEventCount(afterTick1),
  silenceEventCount(afterTick2),
  "(episode dedup: +1 on tick 1, none on tick 2)",
);
console.log(
  "R1b backup.job state in composed health:",
  afterTick1.health.services.find((s) => s.serviceName === "backup.job")?.state,
);
const cleanup = await convex("operations/telemetry/proof:probeClearHeartbeats", {
  serviceName: "backup.job",
});
console.log("R1b cleanup:", JSON.stringify(cleanup.value));

// --- R1c: indexed incident scan still works --------------------------------------

const tick3 = await convex("operations/telemetry/proof:probeTick");
console.log("R1c incident scan after index change:", JSON.stringify(tick3.value.incidents));
const afterTick3 = await state();
console.log(
  "R1c outbox delivery_failed events in recent window:",
  afterTick3.diagnostics.recent.filter((e) => e.kind === "ops.outbox.delivery_failed").length,
  "(standing rows diagnosed once each; no re-emission)",
);
