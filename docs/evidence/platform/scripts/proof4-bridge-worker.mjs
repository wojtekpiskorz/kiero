/**
 * A3 proof 4: the Worker bridge (real wrangler dev runtime + real backend).
 *
 * Runs the actual gateway Worker under `wrangler dev` (workerd) and proves:
 *   B1 gateway health + backend health passthrough (verified identity)
 *   B2 command forwarding through the verified service identity
 *   B3 unsupported operation denied with the sanitized closed error
 *   B4 unmatched platform route denied with the sanitized closed error
 *   B5 unreachable backend -> sanitized `unavailable` (no internals leak)
 *
 * Usage: node docs/evidence/platform/scripts/proof4-bridge-worker.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadEnv, record, stamp, summarize } from "./lib.mjs";

console.log(`# proof4 worker bridge :: started ${stamp()}`);
const env = loadEnv();

const ROOT = new URL("../../../../", import.meta.url).pathname;
const GATEWAY_CONFIG = "apps/gateway/wrangler.jsonc";

function startWrangler(port, siteUrl) {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      GATEWAY_CONFIG,
      "--port",
      String(port),
      "--var",
      `CONVEX_SITE_URL:${siteUrl}`,
      "--var",
      `KIERO_SERVICE_TOKEN:${env.KIERO_SERVICE_TOKEN}`,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG: "log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (process.env.KIERO_PROOF_DEBUG === "1") console.log("[wrangler]", text.trim());
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (process.env.KIERO_PROOF_DEBUG === "1") console.error("[wrangler!]", text.trim());
  });
  return child;
}

async function waitForPort(port, timeoutMs = 45_000) {
  const started = Date.now();
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/platform/health`);
      return;
    } catch {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`gateway on :${port} did not come up`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

const gateway = startWrangler(8787, "https://steady-basilisk-613.eu-west-1.convex.site");
try {
  await waitForPort(8787);

  // --- B1: gateway health + backend passthrough --------------------------------

  const health = await (await fetch("http://127.0.0.1:8787/platform/health")).json();
  record(
    "B1 gateway health reports backend reachable through the verified bridge",
    health.gateway?._tag === "ok" &&
      health.gateway?.value?.backendReachable === true &&
      health.backend?._tag === "ok"
      ? "PASS"
      : "FAIL",
    `gateway=${health.gateway?.value?.status} backendReachable=${health.gateway?.value?.backendReachable} backendRuntime=${health.backend?.value?.runtimeVersion}`,
  );

  // --- B2: command forwarding ----------------------------------------------------

  const command = await (
    await fetch("http://127.0.0.1:8787/platform/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "platform.probeEcho",
        input: { message: "bridge worker proof" },
      }),
    })
  ).json();
  record(
    "B2 gateway forwards the command through the verified service identity",
    command._tag === "ok" && command.value.echo.includes("bridge worker proof")
      ? "PASS"
      : "FAIL",
    JSON.stringify(command).slice(0, 120),
  );

  // --- B3: unsupported operation --------------------------------------------------

  const unsupported = await (
    await fetch("http://127.0.0.1:8787/platform/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "drifted.nonexistent", input: {} }),
    })
  ).json();
  record(
    "B3 gateway denies an unsupported operation with the sanitized closed error",
    unsupported._tag === "error" &&
      unsupported.error._tag === "unsupported" &&
      unsupported.error.code === "unknown_operation"
      ? "PASS"
      : "FAIL",
    JSON.stringify(unsupported).slice(0, 120),
  );

  // --- B4: unmatched route --------------------------------------------------------

  const unmatched = await fetch("http://127.0.0.1:8787/platform/does-not-exist");
  const unmatchedBody = await unmatched.json();
  record(
    "B4 unmatched platform route denied with the sanitized closed error",
    unmatched.status === 400 &&
      unmatchedBody.error?._tag === "unsupported" &&
      unmatchedBody.error?.code === "no_such_route"
      ? "PASS"
      : "FAIL",
    `status=${unmatched.status} code=${unmatchedBody?.error?.code}`,
  );
} finally {
  gateway.kill("SIGTERM");
}

// --- B5: unreachable backend ------------------------------------------------------

const dead = startWrangler(8788, "http://127.0.0.1:9/");
try {
  await waitForPort(8788);
  const unavailable = await (
    await fetch("http://127.0.0.1:8788/platform/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "platform.health", input: {} }),
    })
  ).json();
  const serialized = JSON.stringify(unavailable);
  record(
    "B5 unreachable backend -> sanitized unavailable, no internals leak",
    unavailable._tag === "error" &&
      unavailable.error._tag === "unavailable" &&
      unavailable.error.retryable === true &&
      !serialized.includes("127.0.0.1") &&
      !serialized.includes("steady-basilisk")
      ? "PASS"
      : "FAIL",
    JSON.stringify(unavailable).slice(0, 120),
  );
} finally {
  dead.kill("SIGTERM");
}

void readFileSync;
process.exit(summarize() ? 0 : 1);
