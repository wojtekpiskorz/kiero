#!/usr/bin/env node
/**
 * I8: inject worker RUNTIME secrets after a successful deploy.
 *
 * The transports deploy code and configuration (vars); the worker
 * SECRETS are a separate Cloudflare plane (wrangler secret), set per
 * worker after it exists. This executable is the committed half of that
 * plane, so the release keeps its architecture promise: names come from
 * the descriptor's `runtimeSecrets` map (validated by
 * target-descriptor.mjs), worker names resolve from each component's
 * `transport.workerName`, values flow process environment -> stdin of
 * `wrangler secret bulk` (never argv, never logged), and every terminal
 * outcome lands in a JSON outcomes file beside the deploy outcomes.
 *
 * Outcome vocabulary (names only, never values):
 * - injected  { worker, count }  one bulk call, one worker version bump
 * - deferred  { worker, name }   `deferred: true` with an unset source:
 *                                an explicitly recorded pending owner
 *                                decision (e.g. CONVEX_BACKUP_ADMIN_KEY
 *                                until I10), not a silent skip
 * - refused   { worker, ... }      either a non-deferred secret whose
 *                                source is unset ({ name, source }) or a
 *                                failed bulk call ({ reason, exitCode,
 *                                outputTail }); both EXIT 1, because a
 *                                green release must mean the runtime
 *                                carries its service bearers
 *
 * Usage:
 *   node infra/release/inject-worker-secrets.mjs
 *     --descriptor infra/release/targets/staging.json
 *     --outcomes runtime-secrets-outcomes.json
 */

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseTargetDescriptor } from "./target-descriptor.mjs";

function usage(message) {
  process.stderr.write(`${message}\nusage: inject-worker-secrets.mjs --descriptor <path> --outcomes <path>\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    descriptor: { type: "string" },
    outcomes: { type: "string" },
  },
});
if (values.descriptor === undefined) usage("--descriptor is required");
if (values.outcomes === undefined) usage("--outcomes is required");

const parsed = parseTargetDescriptor(readFileSync(values.descriptor, "utf8"));
if (parsed.violations !== undefined) {
  process.stderr.write(`descriptor violations:\n${parsed.violations.map((v) => `  - ${v}`).join("\n")}\n`);
  process.exit(2);
}
const descriptor = parsed.descriptor;

/** Groups one worker's secrets into the bulk payload plus deferred names. */
function planComponent(component) {
  const entries = component.runtimeSecrets ?? [];
  const payload = {};
  const deferred = [];
  const refused = [];
  for (const entry of entries) {
    const raw = process.env[entry.source];
    // R19: `format` composes the value (exactly one {} placeholder,
    // validated by the descriptor) — e.g. the EU R2 endpoint URL from the
    // nonsecret account id. Without it the source value passes as-is.
    const value = raw === undefined || raw === "" || entry.format === undefined
      ? raw
      : entry.format.replace("{}", raw);
    if (value === undefined || value === "") {
      if (entry.deferred === true) {
        deferred.push({ worker: component.transport.workerName, name: entry.name });
      } else {
        refused.push({
          worker: component.transport.workerName,
          name: entry.name,
          source: entry.source,
        });
      }
      continue;
    }
    payload[entry.name] = value;
  }
  return { payload, deferred, refused };
}

const outcomes = [];
let failed = false;
for (const component of descriptor.components) {
  if (component.included !== true) continue;
  if ((component.runtimeSecrets ?? []).length === 0) continue;
  // parseTargetDescriptor already rejects runtimeSecrets on non
  // wrangler-deploy transports, so the worker name is present here.
  const { payload, deferred, refused } = planComponent(component);
  outcomes.push(...deferred.map((d) => ({ outcome: "deferred", ...d })));
  if (refused.length > 0) {
    failed = true;
    outcomes.push(...refused.map((r) => ({ outcome: "refused", ...r })));
    continue;
  }
  if (Object.keys(payload).length === 0) continue;
  // One bulk call per worker: one version bump, values on stdin only.
  const result = spawnSync(
    "npx",
    ["--no-install", "wrangler", "secret", "bulk", "--name", component.transport.workerName],
    {
      cwd: component.transport.cwd,
      encoding: "utf8",
      input: JSON.stringify(payload),
      timeout: 10 * 60_000,
    },
  );
  if (result.status !== 0) {
    failed = true;
    outcomes.push({
      outcome: "refused",
      worker: component.transport.workerName,
      reason: "wrangler_secret_bulk_failed",
      exitCode: result.status,
      // wrangler prints names and progress, never the stdin values.
      outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-500),
    });
    continue;
  }
  outcomes.push({
    outcome: "injected",
    worker: component.transport.workerName,
    count: Object.keys(payload).length,
  });
}

writeFileSync(values.outcomes, `${JSON.stringify(outcomes, null, 2)}\n`);
for (const outcome of outcomes) {
  process.stdout.write(
    outcome.outcome === "injected"
      ? `[injected] ${outcome.worker}: ${outcome.count} secret(s) (names in the descriptor)\n`
      : `[${outcome.outcome}] ${outcome.worker}/${outcome.name ?? ""}${outcome.source ? ` source=${outcome.source}` : ""}\n`,
  );
}
if (failed) {
  process.stderr.write("runtime secret injection REFUSED; a green release must carry its service bearers\n");
  process.exit(1);
}
