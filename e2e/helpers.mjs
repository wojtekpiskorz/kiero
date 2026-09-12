/**
 * Shared helpers of the live-proof e2e scripts (extracted in J2 review
 * round 1): the checked-dispatch envelope, the deterministic fixture-code
 * derivation and the real B1 email-code sign-in that the three proof
 * scripts (e2e/core-flow/live-proof.mjs, e2e/core-flow/browser-leg.mjs
 * and e2e/core-text/live-proof.mjs) had each copied verbatim.
 *
 * R5 round 2 (the advisory consolidation): the sanitized evidence
 * recorder and the authenticated-browser bootstrap the leg scripts had
 * also copied verbatim. `chromium` stays caller-injected so this module
 * imports no browser dependency of its own.
 *
 * Not a vitest file: live-evidence support only, run manually with node.
 * Everything here is sanitized: routing metadata, states and ids only; no
 * tokens and no secrets are printed (the sign-in RETURNS the session
 * tokens to the caller script; it never logs them).
 */

import { ConvexHttpClient } from "convex/browser";

/** A checked-dispatch envelope (the public command bridge's wire shape). */
export const envelope = (operation, input, idempotencyKey) => ({
  operation,
  input,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

/** Deterministic fixture verification code for a seed (the C1/C4 lease workaround). */
export const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

/**
 * Real B1 sign-in with a fixture code (proof-domain addresses only):
 * installs the code through the guarded dev probe, signs in through the
 * real email-code flow and provisions the session registry. Returns the
 * authenticated client, both session tokens (the browser leg seeds
 * localStorage with the refresh token) and the live session id.
 */
export async function signInWithFixtureCode(url, email, code) {
  const bootstrap = new ConvexHttpClient(url, { logger: false });
  await bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }).catch(() => {});
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") throw new Error(`fixture code install failed for ${email}`);
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") throw new Error(`sign-in failed for ${email}`);
  const refreshToken = result?.tokens?.refreshToken;
  const client = new ConvexHttpClient(url, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, token, refreshToken, sessionId: ensured.sessionId, email };
}

/** The sanitized evidence recorder (the live-proof tally core, extracted). */
export function recorder() {
  const results = [];
  return {
    results,
    record(id, outcome, detail) {
      results.push({ id, outcome });
      console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
      return outcome === "PASS";
    },
    note(line) {
      console.log(`NOTE | ${line}`);
    },
    counts() {
      return results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
    },
    allPassed() {
      return results.every((r) => r.outcome === "PASS");
    },
  };
}

/**
 * Opens the real Chromium with the persona's Convex auth pre-seeded into
 * localStorage (the authenticated-browser bootstrap the browser legs had
 * copied verbatim). `chromium` is caller-injected (playwright-core from
 * the caller's context); tokens are written to the browser profile only,
 * never logged.
 */
export async function openAuthenticatedBrowser({
  chromium,
  executablePath,
  convexUrl,
  token,
  refreshToken,
  locale = "pl-PL",
}) {
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale });
  await context.addInitScript(
    ({ url, t, r }) => {
      const ns = url.replace(/[^a-zA-Z0-9]/g, "");
      localStorage.setItem(`__convexAuthJWT_${ns}`, t);
      localStorage.setItem(`__convexAuthRefreshToken_${ns}`, r);
    },
    { url: convexUrl, t: token, r: refreshToken },
  );
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * The ONE bounded model-stage restart of a FAILED interpretation run
 * (the J1/E3 sanctioned recovery live-proof.mjs established): resolves
 * the run and its workflow checkpoint, restarts the model stage exactly
 * once, and reports the outcome code. The caller owns the polling and
 * the exactly-once policy around it; never retried into fake success.
 */
export async function boundedModelRestart(anonClient, { sourceId, sessionId }) {
  const value = (result) => (result?._tag === "ok" ? result.value : null);
  const errCode = (result) => (result?._tag === "error" ? result.error.code : "ok");
  const latest = await anonClient.action("processing/text/probe:probeLatestRunForSource", { sourceId });
  const runId = value(latest)?.runId ?? null;
  const state = runId === null
    ? null
    : value(await anonClient.action("processing/text/probe:probeAnalysisState", { runId, sessionId }));
  const checkpoint = state === null ? {} : JSON.parse(state.run.checkpoint ?? "{}");
  if (typeof checkpoint.workflowId !== "string") {
    return { restarted: false, reason: "no workflow checkpoint on the run" };
  }
  const restarted = await anonClient.action("processing/text/probe:probeRestartAnalysis", {
    workflowId: checkpoint.workflowId,
    from: "model",
    runId,
  });
  return { restarted: restarted?._tag === "ok", code: errCode(restarted) };
}
