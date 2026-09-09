/**
 * Shared helpers for the A3 platform proof scripts.
 *
 * Everything here talks to the REAL dev deployment (steady-basilisk-613)
 * through the pinned packages. Secrets are read from the gitignored
 * .env.local by NAME and never printed.
 */

import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";

export const DEPLOYMENT = "steady-basilisk-613";
export const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
export const SITE_URL = `https://${DEPLOYMENT}.eu-west-1.convex.site`;

export function loadEnv() {
  const text = readFileSync(new URL("../../../../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match) {
      env[match[1]] = match[2].split(" #")[0].trim();
    }
  }
  if (env.KIERO_SERVICE_TOKEN === undefined || env.KIERO_SERVICE_TOKEN === "") {
    throw new Error("KIERO_SERVICE_TOKEN missing from .env.local (name check only)");
  }
  return env;
}

export function httpClient() {
  return new ConvexHttpClient(CLIENT_URL);
}

export async function bridgeCall(env, body, { token = env.KIERO_SERVICE_TOKEN } = {}) {
  const response = await fetch(`${SITE_URL}/platform/bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      expectedRevisions: [],
      ...body,
      input: body.input ?? {},
    }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { parse_error: true };
  }
  if (process.env.KIERO_PROOF_DEBUG === "1") {
    console.log("DEBUG bridgeCall:", JSON.stringify({ url: `${SITE_URL}/platform/bridge`, body: { expectedRevisions: [], ...body, input: body.input ?? {} }, tokenLen: token === null ? 0 : token.length, status: response.status }));
  }
  return { status: response.status, body: payload };
}

export async function pollUntil(
  label,
  fn,
  { timeoutMs = 30_000, intervalMs = 1_000, onTick } = {},
) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`pollUntil timeout waiting for ${label}`);
    }
    if (onTick !== undefined) {
      await onTick();
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const results = [];
export function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  const line = `[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`;
  console.log(line);
  return outcome === "PASS";
}

export function summarize() {
  const counts = results.reduce(
    (acc, entry) => {
      acc[entry.outcome] = (acc[entry.outcome] ?? 0) + 1;
      return acc;
    },
    {},
  );
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  const failed = results.filter((entry) => entry.outcome !== "PASS");
  return failed.length === 0;
}

export function stamp() {
  return new Date().toISOString();
}
