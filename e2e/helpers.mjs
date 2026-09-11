/**
 * Shared helpers of the live-proof e2e scripts (extracted in J2 review
 * round 1): the checked-dispatch envelope, the deterministic fixture-code
 * derivation and the real B1 email-code sign-in that the three proof
 * scripts (e2e/core-flow/live-proof.mjs, e2e/core-flow/browser-leg.mjs
 * and e2e/core-text/live-proof.mjs) had each copied verbatim.
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
