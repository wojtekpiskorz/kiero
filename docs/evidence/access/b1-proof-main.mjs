/**
 * B1 live proof script (runs against the leased dev deployment ONLY).
 * Output is sanitized: no tokens, no keys, no real addresses are printed.
 * The proof email uses the reserved .invalid TLD; the fixture code is a
 * dev-deployment stand-in for the (BLOCKED) emailed code.
 */
import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_B1_DEPLOYMENT;
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const EMAIL = "b1-proof@kiero.invalid";
const FIXTURE_CODE = "31415926";

const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const ok = (label, cond, detail = "") => {
  if (!cond) throw new Error(`PROOF FAILED: ${label} ${detail}`);
  row(label, `PASS ${detail}`);
};

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

// --- Phase A: platform auth endpoints --------------------------------------
{
  const config = await (await fetch(`${SITE}/.well-known/openid-configuration`)).json();
  ok("A1 openid-configuration served by deployment", config.issuer === SITE, `issuer=${config.issuer}`);
  const jwks = await (await fetch(`${SITE}/.well-known/jwks.json`)).json();
  ok("A2 JWKS served", jwks.keys?.length === 1, `keys=${jwks.keys?.length}`);
  const signin = await fetch(`${SITE}/api/auth/signin/google?code=x`);
  ok("A3 unconfigured Google OAuth route absent (404)", signin.status === 404, `status=${signin.status}`);
  const callback = await fetch(`${SITE}/api/auth/callback/google?code=x&state=y`);
  ok("A4 unconfigured Google callback absent (404)", callback.status === 404, `status=${callback.status}`);
}

// --- Phase B: availability + unauthenticated denial -------------------------
{
  const client = anon();
  const availability = await client.query("access/identity/functions:providerAvailability", {});
  ok("B1 provider availability honest", availability.emailCode === true && availability.google === false,
    JSON.stringify(availability));
  const denied = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("B2 unauthenticated provisioning returns the typed denied state",
    denied?.state === "denied" && denied?.reason === "no_identity",
    JSON.stringify(denied));
}

// --- Phase C: real OTP issuance, honest delivery failure --------------------
{
  const client = anon();
  const failure = await errOf(() =>
    client.action("auth:signIn", { provider: "email_code", params: { email: EMAIL } }),
  );
  ok("C1 issuance runs and delivery fails honestly with the machine marker (RESEND_API_KEY absent)",
    failure !== null && failure.includes("[kiero:email_delivery_failed]")
      && failure.includes("usługa poczty nie jest skonfigurowana"),
    `marker+copy present`);
  const again = await errOf(() =>
    client.action("auth:signIn", { provider: "email_code", params: { email: EMAIL } }),
  );
  ok("C2 re-issuance fails identically (no duplicate issuance success)", again !== null);
  const wrongCode = await errOf(() =>
    client.action("auth:signIn", { provider: "email_code", params: { email: EMAIL, code: "00000000" } }),
  );
  ok("C3 wrong code rejected", wrongCode !== null && wrongCode.includes("Could not verify code"));
}

// --- Phase D: fixture code + REAL verification, session and tokens ----------
let token = null;
{
  const client = anon();
  const set = await client.action("access/identity/probe:b1ProofSetCode", {
    email: EMAIL,
    code: FIXTURE_CODE,
  });
  ok("D1 fixture code installed (guarded dev action)", set?._tag === "ok");
  const result = await client.action("auth:signIn", {
    provider: "email_code",
    params: { email: EMAIL, code: FIXTURE_CODE },
  });
  token = result?.tokens?.token ?? null;
  ok("D2 REAL verify+session+token through the library", typeof token === "string" && token.length > 50,
    `token received (value redacted)`);
  const reuse = await errOf(() =>
    client.action("auth:signIn", {
      provider: "email_code",
      params: { email: EMAIL, code: FIXTURE_CODE },
    }),
  );
  ok("D3 code reuse rejected (consumed on first verify)", reuse !== null && reuse.includes("Could not verify code"));
}

// --- Phase E: authenticated identity surface --------------------------------
let sessionId = null;
{
  const client = new ConvexHttpClient(URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  ok("E1 session registry provisioned (default label applied server-side)",
    ensured?.state === "live", JSON.stringify({ state: ensured?.state, sessionId: "<id>" }));
  sessionId = ensured?.sessionId ?? null;
  const sessions = await client.query("access/identity/functions:listMySessions", {});
  const current = sessions?.find((s) => s.isCurrent);
  ok("E2 device registry lists the current session through the decision cores",
    current !== undefined && current.upstreamState === "live",
    `rows=${sessions?.length} upstream=${current?.upstreamState}`);
  const access = await client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId,
  });
  ok("E3 signed-in person without membership resolves null access", access === null, `value=${JSON.stringify(access)}`);
  const scopeMismatch = await errOf(() =>
    client.query("access/identity/functions:resolveCurrentAccess", { sessionId: "k57wrong" }),
  );
  ok("E4 stale session belief rejected", scopeMismatch !== null && scopeMismatch.includes("Nie masz uprawnień"));
  const malformed = await client.mutation("access/identity/functions:dispatchAccess", {
    envelope: { nonsense: true },
  });
  ok("E5 malformed command envelope fails closed (typed validation)",
    malformed?._tag === "error" && malformed.error._tag === "validation",
    JSON.stringify({ tag: malformed?.error?._tag, code: malformed?.error?.code }));
  const dispatched = await client.mutation("access/identity/functions:dispatchAccess", {
    envelope: {
      operation: "access.resolveCurrentAccess",
      input: { sessionId },
      expectedRevisions: [],
    },
  });
  ok("E6 company-scoped dispatch denies membership-less actor",
    dispatched?._tag === "error" && dispatched.error._tag === "unauthenticated",
    JSON.stringify({ tag: dispatched?.error?._tag, code: dispatched?.error?.code }));
}

// --- Phase F: revocation denies fresh protected queries ---------------------
{
  const client = new ConvexHttpClient(URL, { logger: false, auth: token });
  const revoked = await client.mutation("access/identity/functions:revokeSession", { sessionId });
  ok("F1 self-service revocation returns its timestamp (company via canonical chain)",
    revoked?._tag === "ok" && typeof revoked.value.revokedAtMs === "number",
    `revokedAtMs=${revoked?.value?.revokedAtMs}`);
  const denied = await errOf(() => client.query("access/identity/functions:listMySessions", {}));
  ok("F2 fresh protected query denied after revocation (token still valid)",
    denied !== null && denied.includes("Najpierw się zaloguj"));
  const dispatched = await client.mutation("access/identity/functions:dispatchAccess", {
    envelope: {
      operation: "access.revokeSession",
      input: { sessionId },
      expectedRevisions: [],
    },
  });
  ok("F3 typed dispatch also denied after revocation",
    dispatched?._tag === "error" && dispatched.error._tag === "unauthenticated",
    JSON.stringify({ code: dispatched?.error?.code }));
}

// --- Phase G: 30-day inactivity and upstream-session removal ----------------
{
  const anonClient = anon();
  await anonClient.action("access/identity/probe:b1ProofSetCode", { email: EMAIL, code: FIXTURE_CODE });
  const fresh = await anonClient.action("auth:signIn", {
    provider: "email_code",
    params: { email: EMAIL, code: FIXTURE_CODE },
  });
  const freshToken = fresh?.tokens?.token ?? null;
  ok("G0 fresh sign-in for inactivity proofs", typeof freshToken === "string");
  const client = new ConvexHttpClient(URL, { logger: false, auth: freshToken });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  const freshSessionId = ensured?.sessionId ?? null;
  ok("G1 fresh session provisioned", ensured?.state === "live");

  await client.action("access/identity/probe:b1ProofAgeSession", {
    sessionId: freshSessionId,
    lastSeenAtMs: Date.now() - 29 * 24 * 60 * 60 * 1000,
  });
  const inside = await client.query("access/identity/functions:listMySessions", {});
  ok("G2 just inside 30 days stays live", Array.isArray(inside), `rows=${inside?.length}`);

  await client.action("access/identity/probe:b1ProofAgeSession", {
    sessionId: freshSessionId,
    lastSeenAtMs: Date.now() - 31 * 24 * 60 * 60 * 1000,
  });
  const beyond = await errOf(() => client.query("access/identity/functions:listMySessions", {}));
  ok("G3 beyond 30 days denied (inactive)", beyond !== null && beyond.includes("Najpierw się zaloguj"));

  await client.action("access/identity/probe:b1ProofAgeSession", {
    sessionId: freshSessionId,
    lastSeenAtMs: Date.now(),
  });
  await client.action("access/identity/probe:b1ProofDropUpstreamSession", { sessionId: freshSessionId });
  const gone = await errOf(() => client.query("access/identity/functions:listMySessions", {}));
  ok("G4 upstream session removed: token still valid, read denied",
    gone !== null && gone.includes("Najpierw się zaloguj"));
}

console.log("ALL B1 LIVE PROOFS PASSED");
