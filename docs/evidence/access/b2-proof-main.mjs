/**
 * B2 live proof script (runs against the leased dev deployment ONLY).
 * Output is sanitized: no tokens, no keys; proof addresses use the
 * reserved .invalid TLD. Fixture codes stand in for the two BLOCKED
 * external legs (emailed delivery without RESEND_API_KEY; Google OAuth
 * without AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET) — every product-owned check
 * (both-proofs requirement, single-use codes, typed rejections,
 * exactly-once under real concurrency, revocation, recovery) runs REAL.
 *
 * Usage:
 *   KIERO_B2_URL=https://<deployment>.eu-west-1.convex.cloud \
 *   KIERO_B2_SALT=<run-salt> node b2-proof-main.mjs
 */
import { ConvexHttpClient } from "convex/browser";

const URL = process.env.KIERO_B2_URL;
if (typeof URL !== "string" || URL.length === 0) {
  throw new Error("KIERO_B2_URL is required (the dev deployment client URL)");
}
// Distinct proof-domain addresses per phase: the per-identifier issuance
// throttle (5/hour, B1) must not couple independent proof phases, and a
// re-run with a fresh SALT starts from untouched addresses.
const SALT = process.env.KIERO_B2_SALT ?? "main";
const addr = (name) => `b2-${name}-${SALT}@kiero.invalid`;
const EMAIL = addr("proof");
const RACE_EMAIL = addr("race");
const RACE2_EMAIL = addr("race2");
const CHANGE_EMAIL = addr("change");
const CHANGE_NEW_EMAIL = addr("change-new");
const DEV_EMAIL = addr("dev");
const RECOVERY_EMAIL = addr("recovery");
const FIXTURE_CODE = "27182818";

const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const ok = (label, cond, detail = "") => {
  if (!cond) throw new Error(`PROOF FAILED: ${label} ${detail}`);
  row(label, `PASS ${detail}`);
};
const blocked = (label, detail) => row(label, `BLOCKED-owner-action ${detail}`);

function anon() {
  return new ConvexHttpClient(URL, { logger: false });
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Signs in with the B1 fixture code at a proof-domain address. */
async function signInWithFixtureCode(email, code) {
  const client = anon();
  // 1. Real issuance: creates the provider account and a pending code; the
  //    delivery leg fails honestly (no RESEND_API_KEY on this deployment).
  const issuance = await errOf(() =>
    client.action("auth:signIn", { provider: "email_code", params: { email } }));
  if (issuance === null || !issuance.includes("[kiero:email_delivery_failed]")) {
    throw new Error(`PROOF FAILED: fixture issuance unexpected: ${String(issuance).slice(0, 120)}`);
  }
  // 2. Replace the pending code with the fixture value (guarded dev action).
  const set = await client.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`PROOF FAILED: fixture code not installed: ${JSON.stringify(set)}`);
  }
  // 3. REAL verification, session and token through the library.
  const result = await client.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token ?? null;
  if (typeof token !== "string") {
    throw new Error("PROOF FAILED: fixture sign-in produced no token");
  }
  return new ConvexHttpClient(URL, { logger: false, auth: token });
}

// --- Phase A: unauthenticated denial + honest availability ------------------
{
  const client = anon();
  const availability = await client.query("access/identity/functions:providerAvailability", {});
  ok("A1 provider availability honest (Google creds still absent)",
    availability.emailCode === true && availability.google === false,
    JSON.stringify(availability));
  const denied = await errOf(() => client.query("access/linking/functions:linkingStatus", {}));
  ok("A2 unauthenticated linking status denied",
    denied !== null && denied.includes("Najpierw się zaloguj"));
  const beginDenied = await errOf(() =>
    client.mutation("access/linking/functions:beginLinking", { targetMethod: "google" }));
  ok("A3 unauthenticated ceremony begin denied",
    beginDenied !== null && beginDenied.includes("Najpierw się zaloguj"));
}

// --- Phase B: real email-person ceremony up to the Google leg ---------------
let actor = null;
{
  actor = await signInWithFixtureCode(EMAIL, FIXTURE_CODE);
  const ensured = await actor.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("B1 live session provisioned for the ceremony", ensured?.state === "live");

  const begun = await actor.mutation("access/linking/functions:beginLinking", {
    targetMethod: "google",
  });
  ok("B2 ceremony begun from the live session", begun?.begun === true, JSON.stringify(begun));

  const already = await errOf(() =>
    actor.mutation("access/linking/functions:beginLinking", { targetMethod: "google" }));
  ok("B3 second begin typed-rejected (ceremony_in_progress)",
    already !== null && already.includes("[kiero:link_rejected][ceremony_in_progress]"));

  const send = await errOf(() => actor.action("access/linking/functions:sendProofCode", {}));
  ok("B4 ceremony code send fails honestly without RESEND_API_KEY (staged; retry replaces)",
    send !== null && send.includes("[kiero:email_delivery_failed]"));

  const staged = await actor.action("access/linking/probe:b2ProofSetLinkCode", {
    code: FIXTURE_CODE,
  });
  ok("B5 fixture code installed on the ceremony (guarded dev action)",
    staged?._tag === "ok", JSON.stringify(staged?.value));

  const verified = await actor.mutation("access/linking/functions:verifyProofCode", {
    code: FIXTURE_CODE,
  });
  ok("B6 first proof verified REAL (leg=first_proof, no link yet)",
    verified?.leg === "first_proof" && verified?.linked === false, JSON.stringify(verified));

  const status = await actor.query("access/linking/functions:linkingStatus", {});
  ok("B7 status shows the pending Google proof (both-proofs requirement)",
    status?.activeAttempt?.state === "awaiting_target_proof" &&
    status?.activeAttempt?.nextLeg === "google_oauth" &&
    status?.googleLinked === false,
    JSON.stringify({ state: status?.activeAttempt?.state, nextLeg: status?.activeAttempt?.nextLeg }));

  blocked("B8 the Google OAuth leg itself",
    "AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET absent: the callback commit, the google-authoritative check and the google-direction races stay proven at the core level (tests/b2/cores.test.ts, tests/b2/policy.test.ts)");
}

// --- Phase C: concurrent begin race (real OCC) -------------------------------
{
  const c1 = await signInWithFixtureCode(RACE_EMAIL, FIXTURE_CODE);
  await c1.mutation("access/identity/functions:ensureSessionRegistry", {});
  await c1.mutation("access/linking/functions:cancelLinking", {});
  const [a, b] = await Promise.all([
    c1.mutation("access/linking/functions:beginLinking", { targetMethod: "google" }),
    errOf(() => c1.mutation("access/linking/functions:beginLinking", { targetMethod: "google" })),
  ]);
  const wins = a?.begun === true ? 1 : 0;
  const rejects = b !== null && b.includes("[kiero:link_rejected][ceremony_in_progress]") ? 1 : 0;
  ok("C1 two concurrent begins: exactly one ceremony wins",
    wins === 1 && rejects === 1,
    `ok=${wins} typed_reject=${rejects}`);
  const status = await c1.query("access/linking/functions:linkingStatus", {});
  ok("C2 one canonical ceremony row remains", status?.activeAttempt !== null);
  await c1.mutation("access/linking/functions:cancelLinking", {});
}

// --- Phase D: concurrent first-proof race (single-use code) ------------------
{
  const c1 = await signInWithFixtureCode(RACE2_EMAIL, FIXTURE_CODE);
  await c1.mutation("access/identity/functions:ensureSessionRegistry", {});
  await c1.mutation("access/linking/functions:beginLinking", { targetMethod: "google" });
  await c1.action("access/linking/probe:b2ProofSetLinkCode", { code: FIXTURE_CODE });
  const [first, second] = await Promise.all([
    c1.mutation("access/linking/functions:verifyProofCode", { code: FIXTURE_CODE }),
    errOf(() => c1.mutation("access/linking/functions:verifyProofCode", { code: FIXTURE_CODE })),
  ]);
  const secondTyped =
    second !== null &&
    (second.includes("[kiero:link_rejected][code_wrong_or_expired]") ||
      second.includes("[kiero:link_rejected][no_active_ceremony]"));
  ok("D1 same code redeemed exactly once under real concurrency",
    first?.leg === "first_proof" && secondTyped,
    `first=${JSON.stringify(first)} second_marker=${secondTyped ? "link_rejected" : "none"} (the OCC-lost retry observes the advanced ceremony: single-use code gone or the leg already done)`);
  const reuse = await errOf(() =>
    c1.mutation("access/linking/functions:verifyProofCode", { code: FIXTURE_CODE }));
  ok("D2 code reuse after the race still typed-rejected",
    reuse !== null && reuse.includes("[kiero:link_rejected]"));
  await c1.mutation("access/linking/functions:cancelLinking", {});
}

// --- Phase E: typed dispatch envelopes ---------------------------------------
{
  const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
  const malformed = await actor.mutation("access/identity/functions:dispatchAccess", {
    envelope: { nonsense: true },
  });
  ok("E1 malformed command envelope fails closed (typed validation)",
    malformed?._tag === "error" && malformed.error._tag === "validation");
  const recovery = await actor.mutation("access/identity/functions:dispatchAccess", {
    envelope: envelope("access.recoverAccount", { userId: "k57x" }),
  });
  ok("E2 recovery command invoker UNAVAILABLE (fail-closed unknown_operation)",
    recovery?._tag === "error" && recovery.error._tag === "unsupported" &&
    recovery.error.code === "unknown_operation",
    JSON.stringify({ tag: recovery?.error?._tag, code: recovery?.error?.code }));
  const link = await actor.mutation("access/identity/functions:dispatchAccess", {
    envelope: envelope("access.linkVerifiedMethod", {
      userId: "k57notown",
      method: "email_code",
      verifiedIdentity: "31415926",
    }),
  });
  ok("E3 typed link op needs the full actor chain (membership-less actor: unauthenticated)",
    link?._tag === "error" && link.error._tag === "unauthenticated",
    JSON.stringify({ tag: link?.error?._tag, code: link?.error?.code }));
}

// --- Phase F: email change end-to-end ----------------------------------------
{
  const c1 = await signInWithFixtureCode(CHANGE_EMAIL, FIXTURE_CODE);
  await c1.mutation("access/identity/functions:ensureSessionRegistry", {});
  const send = await errOf(() =>
    c1.action("access/linking/functions:requestEmailChange", { newEmail: CHANGE_NEW_EMAIL }));
  ok("F1 request stages; delivery fails honestly without RESEND_API_KEY",
    send !== null && send.includes("[kiero:email_delivery_failed]"));
  const fixture = await c1.action("access/linking/probe:b2ProofSetEmailChangeCode", {
    code: FIXTURE_CODE,
  });
  ok("F2 fixture code installed on the pending change (guarded)", fixture?._tag === "ok");

  const wrong = await errOf(() =>
    c1.mutation("access/linking/functions:confirmEmailChange", { code: "00000000" }));
  ok("F3 failed confirmation typed-rejected",
    wrong !== null && wrong.includes("[kiero:link_rejected][code_wrong_or_expired]"));
  const unchanged = await c1.query("access/linking/functions:linkingStatus", {});
  ok("F4 old address unchanged after the failed confirmation",
    unchanged?.email === CHANGE_EMAIL, `email=${unchanged?.email}`);

  const confirmed = await c1.mutation("access/linking/functions:confirmEmailChange", {
    code: FIXTURE_CODE,
  });
  ok("F5 confirmation moves the address", confirmed?.newEmail === CHANGE_NEW_EMAIL,
    JSON.stringify(confirmed));
  const moved = await c1.query("access/linking/functions:linkingStatus", {});
  ok("F6 status serves the new canonical address", moved?.email === CHANGE_NEW_EMAIL);
  // The old address no longer owns the email-code credential: a fresh code
  // request there behaves like a separate issuance (honest failure), and a
  // verification there would create a SEPARATE person (B1's policy) —
  // never a merge back into this account.
  const oldAddress = await errOf(() =>
    anon().action("auth:signIn", { provider: "email_code", params: { email: CHANGE_EMAIL } }));
  ok("F7 old-address code request behaves like a fresh issuance (honest failure)",
    oldAddress !== null && oldAddress.includes("[kiero:email_delivery_failed]"));
}

// --- Phase G: multi-device revocation across devices -------------------------
{
  const d1 = await signInWithFixtureCode(DEV_EMAIL, FIXTURE_CODE);
  const d2 = await signInWithFixtureCode(DEV_EMAIL, FIXTURE_CODE);
  const e1 = await d1.mutation("access/identity/functions:ensureSessionRegistry", {});
  const e2 = await d2.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("G1 two device sessions provisioned", e1?.state === "live" && e2?.state === "live");
  const sessions = await d1.query("access/identity/functions:listMySessions", {});
  const active = (sessions ?? []).filter((s) => s.revokedAtMs === null);
  ok("G2 multi-device session view lists both devices", active.length === 2, `rows=${sessions?.length}`);

  const outcome = await d1.mutation("access/linking/functions:revokeOtherSessions", {});
  ok("G3 revoke-other-devices through B1's canonical core",
    outcome?.revokedCount === 1, JSON.stringify(outcome));
  const otherDenied = await errOf(() => d2.query("access/identity/functions:listMySessions", {}));
  ok("G4 revoked device denied on a fresh protected query (token still valid)",
    otherDenied !== null && otherDenied.includes("Najpierw się zaloguj"));
  const survivor = await d1.query("access/identity/functions:listMySessions", {});
  ok("G5 revoking device keeps working", Array.isArray(survivor));
}

// --- Phase H: manual recovery (guarded invoker; B4 owns the real one) --------
{
  const d1 = await signInWithFixtureCode(RECOVERY_EMAIL, FIXTURE_CODE);
  const ensured = await d1.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("H0 pre-recovery session live", ensured?.state === "live");

  const refused = await anon().action("access/linking/probe:b2ProofRecoverAccount", {
    email: "victim@example.com",
    verificationBasis: "probe",
  });
  ok("H1 recovery fixture REFUSES non-proof-domain accounts",
    refused?._tag === "error" && refused.error.code === "proof_domain_required",
    JSON.stringify({ code: refused?.error?.code }));

  const recovery = await anon().action("access/linking/probe:b2ProofRecoverAccount", {
    email: RECOVERY_EMAIL,
    verificationBasis: "dev proof: fixture-verified mailbox + owner instruction",
  });
  ok("H2 recovery runs the REAL core (sessions revoked, accounts cleared)",
    recovery?._tag === "ok" && recovery.value.revokedSessions >= 1 && recovery.value.clearedAccounts >= 1,
    JSON.stringify(recovery?.value));

  const denied = await errOf(() => d1.query("access/identity/functions:listMySessions", {}));
  ok("H3 pre-recovery token denied after recovery (both layers invalidated)",
    denied !== null && denied.includes("Najpirwaj się zaloguj") ||
    denied !== null && denied.includes("Najpierw się zaloguj"));
  const dispatchDenied = await d1.mutation("access/identity/functions:dispatchAccess", {
    envelope: { operation: "access.resolveCurrentAccess", input: { sessionId: "k57x" }, expectedRevisions: [] },
  });
  ok("H4 protected typed dispatch also denied",
    dispatchDenied?._tag === "error" && dispatchDenied.error._tag === "unauthenticated",
    JSON.stringify({ tag: dispatchDenied?.error?._tag }));

  // Fresh method setup after recovery: a new code at the address signs in
  // again (the account row survived; B1's orphan-resume path).
  const fresh = await signInWithFixtureCode(RECOVERY_EMAIL, FIXTURE_CODE);
  const freshEnsured = await fresh.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("H5 fresh method setup works after recovery (account row survived)",
    freshEnsured?.state === "live");
}

console.log("ALL B2 LIVE PROOFS PASSED");
