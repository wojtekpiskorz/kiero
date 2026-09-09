/**
 * G1 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/g1, instance different-cat-230, EU).
 *
 * Output is sanitized: no tokens, no keys, no service credentials. Proof
 * persons use the reserved @kiero.invalid domain (B1 fixture codes). The
 * Google legs run against the deployment's OWN clearly-labeled fake
 * endpoints (guarded by KIERO_G1_PROOF_ENABLED), because the real Google
 * OAuth client credentials are ABSENT — the same owner action B1 recorded.
 * Every LIVE Google leg therefore stays BLOCKED-owner-action; what is
 * proven live here is the full server-side protocol: authorization URL
 * construction, single-use state consumption, PKCE exchange, scope
 * enforcement, dedicated-calendar find-or-create with uncertain outcomes,
 * disconnect lifecycle persistence, cross-tenant isolation, and encrypted
 * credential storage.
 *
 * Run: node tests/g1/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_G1_DEPLOYMENT ?? "different-cat-230";
const URL_API = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = process.env.KIERO_G1_SITE_URL ?? `https://${DEPLOYMENT}.eu-west-1.convex.site`;
// Each persona gets its OWN fixture code value: the library's code lookup
// is unique by hash, so two simultaneously-pending proof codes with one
// value would break that uniqueness.
const FIXTURE_CODE = "42424242";
const FIXTURE_CLIENT_ID = "kiero-g1-proof-fixture.apps.googleusercontent.com";
// The service credential is read from the environment or the ignored local
// stash; it is never printed.
const SERVICE_TOKEN = process.env.KIERO_G1_SERVICE_TOKEN ?? (() => {
  try {
    return readFileSync(process.env.KIERO_SERVICE_TOKEN_FILE ?? "/tmp/g1-service-token.txt", "utf8").trim();
  } catch {
    return "";
  }
})();

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_G1_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `g1-${name}-${RUN}@kiero.invalid`;
const SZEF0 = person("bez-firmy");
const SZEF1 = person("szef1");
const SZEF2 = person("szef2");
const SZEF3 = person("szef3");
const SZEF4 = person("szef4");
const SZEF5 = person("szef5");
const SZEF6 = person("szef6");
const SZEF7 = person("szef7");

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);

function anon() {
  return new ConvexHttpClient(URL_API, { logger: false });
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", { envelope: envelope(operation, input) });
const dispatch = (client, operation, input) =>
  client.mutation("calendar/connection/functions:dispatchCalendar", { envelope: envelope(operation, input) });
const dispatchMembership = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", { envelope: envelope(operation, input) });
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", { envelope: envelope("access.createInvitation", input) });

const isOk = (result) => result?._tag === "ok";
const errTag = (result) => (result?._tag === "error" ? result.error._tag : "ok");
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;

/** Real B1 sign-in with a per-persona fixture code (proof-domain only). */
async function signInFixture(email, persona) {
  const code = `${FIXTURE_CODE.slice(0, 6)}${persona}`;
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(URL_API, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}`);
  }
  return { client, token, sessionId: ensured.sessionId, email };
}

// --- HTTP surface helpers ----------------------------------------------------

async function httpStart(actor, body = {}) {
  const response = await fetch(`${SITE}/calendar/oauth/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${actor?.token ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function httpCallback(state, code, error = null) {
  const params = new URLSearchParams({ state });
  if (code !== null) params.set("code", code);
  if (error !== null) params.set("error", error);
  const response = await fetch(`${SITE}/calendar/oauth/callback?${params.toString()}`, {
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function httpBridgeComplete(state, code, token = SERVICE_TOKEN) {
  const response = await fetch(`${SITE}/calendar/oauth/callback/complete`, {
    method: "POST",
    headers:
      token === null
        ? { "content-type": "application/json" }
        : { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ state, code }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function proofState(dedupKey) {
  const response = await fetch(`${SITE}/calendar/oauth/proof/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dedupKey === null ? {} : { dedupKey }),
  });
  return await response.json();
}

async function proofRefresh(connectionId) {
  const response = await fetch(`${SITE}/calendar/oauth/proof/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId }),
  });
  return await response.json();
}

const statusOf = (client) => client.query("calendar/connection/functions:calendarStatus", {});

/**
 * Proof codes are RUN-scoped so effect-ledger counts stay per-run (the
 * script is re-runnable on the shared dev lease without resetting data).
 * The fake endpoints derive their behavior selectors from the code's
 * `!t-…`/`!c-…`/`!r-…` suffixes and their effect subjects from the code
 * BASE, so the keys below are the exact fixtures' vocabulary.
 */
const proofCode = (account, behaviors = "") => `proof-code-${RUN}-${account}${behaviors}`;
/** The fake Calendar API's per-run create-effect key for one account. */
const calendarCreateKey = (account) => `g1-proof-calendar-create:proof-google-${proofCode(account)}`;
/** The fake token endpoint's effect key for one authorization code. */
const tokenExchangeKey = (code) => `g1-proof-token:authorization_code:${code}`;
/** The fake token endpoint's effect key for one refresh attempt. */
const refreshTokenKey = (code) => `g1-proof-token:refresh_token:proof-refresh-${code}`;

/** Starts a flow and returns { state, code } extracted from the URL. */
async function startFlow(actor, body = {}) {
  const started = await httpStart(actor, body);
  if (!isOk(started.payload)) {
    return { failed: started.payload };
  }
  const url = new URL(started.payload.value.authorizationUrl);
  return { state: url.searchParams.get("state"), url: started.payload.value.authorizationUrl, started };
}

console.log(`# G1 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("site", SITE);
row("google client credentials", "ABSENT (owner action; fixture client in proof mode)");
row("proof fixtures", "enabled on this deployment only (KIERO_G1_PROOF_ENABLED)");

// --- Phase 0: honest surfaces ------------------------------------------------
{
  const anonymous = await fetch(`${SITE}/calendar/oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("0a anonymous start denied unauthenticated (no URL leaked)",
    anonymous.status === 401 && (await anonymous.text()).includes("unauthenticated"));

  const stranger = await signInFixture(SZEF0, 0);
  const noCompany = await httpStart(stranger);
  check("0b membership-less person cannot start (no company scope; sign-in itself works)",
    noCompany.status === 403 && noCompany.payload?.error?.code === "no_company_scope",
    JSON.stringify({ status: noCompany.status, code: noCompany.payload?.error?.code }));
  const strangerStatus = await statusOf(stranger.client);
  check("0c membership-less status is honestly unavailable (never a connection)",
    strangerStatus?.state === "unavailable_no_company",
    JSON.stringify({ state: strangerStatus?.state }));

  const bad = await httpCallback("definitely-not-a-state-value", "proof-code-x");
  check("0d callback with unknown state rejected in Polish, no token material",
    bad.status === 400 && bad.text.includes("Nieprawidłowe") && !bad.text.includes("token"),
    `status=${bad.status}`);
}

// --- Phase 1: authorization start (the URL construction proof) ---------------
let szef1 = null;
let companyA = null;
{
  szef1 = await signInFixture(SZEF1, 1);
  const created = await admit(szef1.client, "access.createCompany", {
    name: `Budowa G1 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  companyA = created?.value?.companyId ?? null;
  row("szef1 admin of firm A", companyA);

  const started = await httpStart(szef1);
  const url = isOk(started.payload) ? new URL(started.payload.value.authorizationUrl) : null;
  check("1a start returns a correctly-constructed Google authorization URL",
    url !== null && url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth",
    url === null ? errCode(started.payload) : `${url.origin}${url.pathname}`);
  const params = url?.searchParams;
  check("1b URL carries the fixture client, offline access and consent prompt",
    params?.get("client_id") === FIXTURE_CLIENT_ID &&
      params?.get("access_type") === "offline" &&
      params?.get("prompt") === "consent",
    JSON.stringify({ client: params?.get("client_id") }));
  check("1c URL scope is exactly the least required set (dedicated calendar + identity)",
    params?.get("scope") ===
      "openid email https://www.googleapis.com/auth/calendar.app.created",
    params?.get("scope"));
  check("1d URL carries a one-time state and an S256 PKCE challenge",
    /^[A-Za-z0-9_-]{43}$/.test(params?.get("state") ?? "") &&
      /^[A-Za-z0-9_-]{43}$/.test(params?.get("code_challenge") ?? "") &&
      params?.get("code_challenge_method") === "S256",
    `state=${(params?.get("state") ?? "").length}c challenge=${(params?.get("code_challenge") ?? "").length}c`);
  check("1e redirect_uri is the deployment's own callback route",
    params?.get("redirect_uri") === `${SITE}/calendar/oauth/callback`,
    params?.get("redirect_uri"));
  const raw = JSON.stringify(started.payload);
  check("1f the response leaks no verifier, state hash or secret",
    !raw.includes("verifier") && !raw.includes("stateHash") && !raw.includes("SECRET"),
    "checked: verifier/stateHash/secret absent");

  const second = await httpStart(szef1);
  check("1g a second live flow is refused (one pending authorization per user)",
    second.status === 409 && second.payload?.error?.code === "authorization_already_pending",
    JSON.stringify({ status: second.status, code: second.payload?.error?.code }));
  const pending = await statusOf(szef1.client);
  check("1h status shows the pending flow with disconnect as the only action",
    pending?.state === "pending_authorization" &&
      JSON.stringify(pending?.availableActions) === JSON.stringify(["disconnect"]),
    JSON.stringify({ state: pending?.state, actions: pending?.availableActions }));

  globalThis.__flow1 = { state: params?.get("state"), url: url?.toString() };
}

// --- Phase 2: happy path, replay, encrypted storage --------------------------
{
  const { state } = globalThis.__flow1;
  const done = await httpCallback(state, proofCode(1));
  check("2a callback completes the connection (Polish success page)",
    done.status === 200 && done.text.includes("połączony"), `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("2b connection recorded: dedicated calendar id, Google account, scopes, capability",
    status?.state === "connected" &&
      status?.googleCalendarId === "kiero-proof-calendar" &&
      status?.googleAccountEmail === `g1-google-1@kiero.invalid` &&
      (status?.grantedScopes ?? []).includes("https://www.googleapis.com/auth/calendar.app.created") &&
      status?.credentialCapability === "ready",
    JSON.stringify({ state: status?.state, cal: status?.googleCalendarId, account: status?.googleAccountEmail }));
  check("2c credentials are sealed AES-GCM at rest (key configured on the lease)",
    status?.credentialStorage === "encrypted_aesgcm",
    JSON.stringify({ storage: status?.credentialStorage }));

  const state2 = await proofState(null);
  const own = (state2?.value?.connections ?? []).find((c) => c.userId !== undefined && c.googleAccountEmail === `g1-google-1@kiero.invalid`);
  const rowJson = JSON.stringify(own ?? {});
  check("2d the stored row contains no plaintext Google token value",
    own !== undefined && !rowJson.includes("proof-access-") && !rowJson.includes("proof-refresh-") && (own.credentialCiphertext ?? "").length > 0,
    `ciphertextLen=${(own?.credentialCiphertext ?? "").length}`);

  const replay = await httpCallback(state, proofCode(1));
  check("2e callback REPLAY rejected: the single-use state is consumed",
    replay.status === 400 && replay.text.includes("Nieprawidłowe"), `status=${replay.status}`);
  const effects = await proofState(tokenExchangeKey(proofCode(1)));
  check("2f exactly one token exchange ever ran for that code (no double exchange)",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);

  const again = await httpStart(szef1);
  check("2g plain connect while connected is refused (switch is the entry)",
    again.status === 409 && again.payload?.error?.code === "already_connected",
    JSON.stringify({ code: again.payload?.error?.code }));
}

// --- Phase 3: switch account (and a denied switch restores) -------------------
{
  const flow = await startFlow(szef1, { mode: "switch" });
  const done = await httpCallback(flow.state, proofCode(2));
  check("3a switch completes with the OTHER Google account",
    done.status === 200 && done.text.includes("połączony"), `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("3b the new account is bound and cleanup of the old calendar is unconfirmed",
    status?.googleAccountEmail === `g1-google-2@kiero.invalid` && status?.cleanupStatus === "unconfirmed",
    JSON.stringify({ account: status?.googleAccountEmail, cleanup: status?.cleanupStatus }));
  const effects = await proofState(calendarCreateKey(2));
  check("3c the switch created exactly one new calendar (no duplicates)",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);

  const flow2 = await startFlow(szef1, { mode: "switch" });
  const denied = await httpCallback(flow2.state, null, "access_denied");
  check("3d a denied switch leaves the previous connection working",
    denied.status === 400);
  const restored = await statusOf(szef1.client);
  check("3e status after a denied switch is still connected to the old account",
    restored?.state === "connected" && restored?.googleAccountEmail === `g1-google-2@kiero.invalid`,
    JSON.stringify({ state: restored?.state, account: restored?.googleAccountEmail }));
}

// --- Phase 4: disconnect-during-pending, disconnect persistence, identity ----
{
  const flow = await startFlow(szef1, { mode: "switch" });
  const status0 = await statusOf(szef1.client);
  const cancelled = await dispatch(szef1.client, "calendar.disconnectCalendar", {
    connectionId: status0?.connectionId,
  });
  check("4a disconnect during a pending switch cancels it and restores connected",
    isOk(cancelled), errCode(cancelled));
  const afterCancel = await statusOf(szef1.client);
  check("4b the cancelled switch left the connection usable",
    afterCancel?.state === "connected", JSON.stringify({ state: afterCancel?.state }));
  const late = await httpCallback(flow.state, proofCode(3));
  check("4c the cancelled flow's late callback is rejected (disconnect wins the race)",
    late.status === 400 && late.text.includes("Nieprawidłowe"), `status=${late.status}`);

  const disconnected = await dispatch(szef1.client, "calendar.disconnectCalendar", {
    connectionId: afterCancel?.connectionId,
  });
  check("4d disconnect from connected succeeds",
    isOk(disconnected), errCode(disconnected));
  const stopped = await statusOf(szef1.client);
  check("4e the disconnected state persists with credentials gone and cleanup recorded",
    stopped?.state === "disconnected" &&
      stopped?.disconnectedAtMs !== null &&
      stopped?.credentialCapability === "absent",
    JSON.stringify({ state: stopped?.state, disconnectedAt: stopped?.disconnectedAtMs }));
  const access = await szef1.client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId: szef1.sessionId,
  });
  check("4f CALENDAR DISCONNECT LEAVES LOGIN USABLE (same session, same company scope)",
    access?.companyId === companyA && access?.membershipRole === "admin",
    JSON.stringify({ companyId: access?.companyId, role: access?.membershipRole }));
  const sessions = await szef1.client.query("access/identity/functions:listMySessions", {});
  check("4g the session registry is untouched by the calendar disconnect",
    Array.isArray(sessions) && sessions.some((s) => s.isCurrent), `sessions=${sessions?.length}`);
}

// --- Phase 5: recovery of the same account without a duplicate calendar -------
{
  const flow = await startFlow(szef1);
  const done = await httpCallback(flow.state, proofCode(2));
  check("5a reconnect of the same Google account completes",
    done.status === 200, `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("5b the SAME dedicated calendar was recovered by verification",
    status?.googleCalendarId === "kiero-proof-calendar" && status?.googleAccountEmail === `g1-google-2@kiero.invalid`,
    JSON.stringify({ cal: status?.googleCalendarId }));
  const effects = await proofState(calendarCreateKey(2));
  check("5c still exactly one calendar for that account (no duplicate creation)",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);
}

// --- Phase 6: exchange uncertainty (never a blind retry) ----------------------
{
  await dispatch(szef1.client, "calendar.disconnectCalendar", { connectionId: (await statusOf(szef1.client))?.connectionId });
  const flow = await startFlow(szef1);
  const t0 = Date.now();
  const done = await httpCallback(flow.state, proofCode(9, "!t-timeout"));
  const elapsed = Date.now() - t0;
  check("6a a stalled token exchange records the uncertain outcome honestly (200 page; upstream 5xx bodies are edge-replaced)",
    done.status === 200 && done.text.includes("niepewny"), `status=${done.status} elapsedMs=${elapsed}`);
  const status = await statusOf(szef1.client);
  check("6b the connection is error/exchange_unknown (NOT connected, NOT retried)",
    status?.state === "error" && status?.reconnectReason === "exchange_unknown",
    JSON.stringify({ state: status?.state, reason: status?.reconnectReason }));
  const effects = await proofState(tokenExchangeKey(proofCode(9, "!t-timeout")));
  check("6c exactly one exchange ran for the stalled code",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);
}

// --- Phase 7: scope enforcement -----------------------------------------------
{
  const flow = await startFlow(szef1);
  const done = await httpCallback(flow.state, proofCode(10, "!t-missing_scope"));
  check("7a a grant without the dedicated-calendar scope is refused",
    done.status === 400 && done.text.includes("uprawnień"), `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("7b the connection records scopes_missing and stays disconnected from Google",
    status?.state === "error" && status?.reconnectReason === "scopes_missing",
    JSON.stringify({ state: status?.state, reason: status?.reconnectReason }));
  const effects = await proofState(calendarCreateKey(10));
  check("7c no calendar was created for the scope-less grant",
    (effects?.value?.effectCount ?? 0) === 0, `count=${effects?.value?.effectCount}`);
}

// --- Phase 8: creation uncertainty (the no-blind-duplicate rule) --------------
{
  const flow = await startFlow(szef1);
  const done = await httpCallback(flow.state, proofCode(6, "!t-ok!c-create_timeout"));
  check("8a a stalled calendar creation records creation_unknown (200 page; upstream 5xx bodies are edge-replaced)",
    done.status === 200 && done.text.includes("niepewny"), `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("8b the connection is error/creation_unknown with NO calendar id recorded",
    status?.state === "error" && status?.reconnectReason === "creation_unknown" && status?.googleCalendarId === null,
    JSON.stringify({ state: status?.state, reason: status?.reconnectReason, cal: status?.googleCalendarId }));
  const effects = await proofState(calendarCreateKey(6));
  check("8c the fake DID create the calendar (the effect exists) while Kiero honestly recorded unknown",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);
  const refused = await httpStart(szef1);
  check("8d reconnect after an unknown creation is refused without acknowledgement",
    refused.status === 409 && refused.payload?.error?.code === "creation_unresolved",
    JSON.stringify({ code: refused.payload?.error?.code }));
  const effectsStill = await proofState(calendarCreateKey(6));
  check("8e still exactly one creation (no blind duplicate was attempted)",
    effectsStill?.value?.effectCount === 1, `count=${effectsStill?.value?.effectCount}`);

  const flow2 = await startFlow(szef1, { acknowledgeUnknownCreation: true });
  check("8f the acknowledged reconnect is admitted",
    flow2.state !== undefined, flow2.failed ? errCode(flow2.failed) : "started");
  const done2 = await httpCallback(flow2.state, proofCode(6, "!t-ok!c-ok"));
  check("8g the acknowledged attempt creates the calendar and connects",
    done2.status === 200 && done2.text.includes("połączony"), `status=${done2.status}`);
  const effects2 = await proofState(calendarCreateKey(6));
  check("8h exactly two creations total: the uncertain one plus the acknowledged one",
    effects2?.value?.effectCount === 2, `count=${effects2?.value?.effectCount}`);
}

// --- Phase 9: ambiguous 404 -> explicit Odtwórz ------------------------------
{
  await dispatch(szef1.client, "calendar.disconnectCalendar", { connectionId: (await statusOf(szef1.client))?.connectionId });
  const flow = await startFlow(szef1);
  const done = await httpCallback(flow.state, proofCode(6, "!t-ok!c-ambiguous404"));
  check("9a an ambiguous 404 on the known calendar is NOT treated as confirmed deletion",
    done.status === 409 && done.text.includes("niedostępny"), `status=${done.status}`);
  const status = await statusOf(szef1.client);
  check("9b the connection records calendar_access_lost and offers Odtwórz",
    status?.state === "error" &&
      status?.reconnectReason === "calendar_access_lost" &&
      status?.availableActions?.includes("recreate"),
    JSON.stringify({ state: status?.state, reason: status?.reconnectReason, actions: status?.availableActions }));
  const flow2 = await startFlow(szef1, { mode: "recreate" });
  // The recreate callback verifies first (the calendar is still ambiguous
  // in Google), THEN creates — exactly what a confirmed deletion looks like.
  const done2 = await httpCallback(flow2.state, proofCode(6, "!t-ok!c-ambiguous404"));
  check("9c the explicit recreate (Odtwórz) verifies, finds it gone, and creates fresh",
    done2.status === 200 && done2.text.includes("połączony"), `status=${done2.status}`);
  const effects = await proofState(calendarCreateKey(6));
  check("9d three creations total: uncertain + acknowledged + explicit recreate",
    effects?.value?.effectCount === 3, `count=${effects?.value?.effectCount}`);
}

// --- Phase 10: membership revoked during a pending flow ------------------------
let szef2 = null;
{
  szef2 = await signInFixture(SZEF2, 2);
  const invited = await invite(szef1.client, { email: SZEF2, role: "member" });
  const setCode = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
    invitationId: invited.value.invitationId,
    code: FIXTURE_CODE,
  });
  const accepted = await admit(szef2.client, "access.acceptInvitation", {
    invitationId: invited.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  row("szef2 member of firm A", `${isOk(accepted)} (${setCode?._tag})`);
  const flow = await startFlow(szef2);
  // Captured BEFORE the revocation: szef2's own session stops working the
  // moment B3's cleanup runs, so the connection id must be in hand already
  // (the membership-lost row never carries a Google account identity).
  const szef2ConnectionId = (await statusOf(szef2.client))?.connectionId;
  const overview = await szef1.client.query("access/membership/functions:membershipOverview", {});
  const szef2Membership = (overview?.members ?? []).find((m) => m.email === SZEF2);
  const revoked = await dispatchMembership(szef1.client, "access.revokeMembership", {
    membershipId: szef2Membership?.membershipId,
  });
  check("10a the administrator revoked szef2's membership (B3 path)",
    isOk(revoked), errCode(revoked));
  const done = await httpCallback(flow.state, proofCode(11));
  check("10b the pending callback is REJECTED after membership loss",
    done.status === 403 && done.text.includes("członkostwo"), `status=${done.status}`);
  const stateAll = await proofState(null);
  const szef2Row = (stateAll?.value?.connections ?? []).find(
    (c) => c.connectionId === szef2ConnectionId,
  );
  check("10c szef2's connection row records the membership-lost stop",
    szef2Row?.state === "error" && szef2Row?.reconnectReason === "membership_lost",
    JSON.stringify({ state: szef2Row?.state, reason: szef2Row?.reconnectReason }));
  const denied = await errOf(() =>
    szef2.client.query("access/identity/functions:resolveCurrentAccess", { sessionId: szef2.sessionId }),
  );
  check("10d szef2's session is revoked by the B3 membership cleanup (identity separate from calendar)",
    denied !== null && denied.includes("revoked"), String(denied).slice(0, 80));
}

// --- Phase 11: cross-tenant isolation -----------------------------------------
let szef3 = null;
let szef3ConnectionId = null;
{
  szef3 = await signInFixture(SZEF3, 3);
  await admit(szef3.client, "access.createCompany", {
    name: `Firma B G1 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const flow = await startFlow(szef3);
  const done = await httpCallback(flow.state, proofCode(12));
  check("11a the second firm's boss connects his own calendar",
    done.status === 200, `status=${done.status}`);
  const status = await statusOf(szef3.client);
  szef3ConnectionId = status?.connectionId;
  check("11b szef3's status shows HIS connection (own Google account)",
    status?.googleAccountEmail === `g1-google-12@kiero.invalid`,
    JSON.stringify({ account: status?.googleAccountEmail }));
  const szef1Status = await statusOf(szef1.client);
  const foreign = await dispatch(szef3.client, "calendar.disconnectCalendar", {
    connectionId: szef1Status?.connectionId,
  });
  check("11c szef3 cannot disconnect szef1's connection (not_found, no leak)",
    foreign?._tag === "error" && foreign.error._tag === "not_found",
    JSON.stringify({ tag: errTag(foreign), code: errCode(foreign) }));
  const szef1After = await statusOf(szef1.client);
  check("11d szef1's connection is untouched by the foreign attempt",
    szef1After?.state === szef1Status?.state, JSON.stringify({ state: szef1After?.state }));
}

// --- Phase 12: the certified contract operations (typed dispatch) -------------
let szef5 = null;
{
  szef5 = await signInFixture(SZEF5, 5);
  await admit(szef5.client, "access.createCompany", {
    name: `Firma D G1 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const flow = await startFlow(szef5);
  check("12a szef5 has a pending authorization", flow.state !== undefined, "started");
  const connected = await dispatch(szef5.client, "calendar.connectCalendar", {
    googleCalendarId: "kiero-manual-calendar",
  });
  check("12b calendar.connectCalendar completes the actor's pending flow",
    isOk(connected) && typeof connected.value.connectionId === "string",
    JSON.stringify({ tag: errTag(connected), id: connected?.value?.connectionId }));
  const status = await statusOf(szef5.client);
  check("12c the contract completion is honest about the absent credential capability",
    status?.state === "connected" &&
      status?.googleCalendarId === "kiero-manual-calendar" &&
      status?.credentialCapability === "absent",
    JSON.stringify({ state: status?.state, cal: status?.googleCalendarId, capability: status?.credentialCapability }));
  const foreign = await dispatch(szef3.client, "calendar.connectCalendar", {
    googleCalendarId: "someone-elses-calendar",
  });
  check("12d a foreign actor without a pending flow is refused (conflict)",
    foreign?._tag === "error" && foreign.error._tag === "conflict",
    JSON.stringify({ tag: errTag(foreign), code: errCode(foreign) }));
  const disconnected = await dispatch(szef5.client, "calendar.disconnectCalendar", {
    connectionId: status?.connectionId,
  });
  check("12e calendar.disconnectCalendar stops the connection",
    isOk(disconnected), errCode(disconnected));
}

// --- Phase 13: token refresh uncertainty (the echo template) ------------------
let szef4 = null;
{
  szef4 = await signInFixture(SZEF4, 4);
  await admit(szef4.client, "access.createCompany", {
    name: `Firma C G1 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const flow = await startFlow(szef4);
  const done = await httpCallback(flow.state, proofCode(13, "!t-ok!c-ok!r-invalid_grant"));
  check("13a szef4 connects with a grant whose refresh will be refused",
    done.status === 200, `status=${done.status}`);
  const status = await statusOf(szef4.client);
  const refreshed = await proofRefresh(status?.connectionId);
  check("13b a definite refresh refusal marks the connection error/refresh_failed (the >1-week shape)",
    refreshed?.value?.outcome === "definitely_lost",
    JSON.stringify({ outcome: refreshed?.value?.outcome }));
  const after = await statusOf(szef4.client);
  check("13c the connection state records refresh_failed with credentials cleared",
    after?.state === "error" && after?.reconnectReason === "refresh_failed" && after?.credentialCapability === "absent",
    JSON.stringify({ state: after?.state, reason: after?.reconnectReason }));

  const flow2 = await startFlow(szef4);
  const done2 = await httpCallback(flow2.state, proofCode(14, "!t-ok!c-ok!r-timeout"));
  check("13d szef4 reconnects with a grant whose refresh will stall",
    done2.status === 200, `status=${done2.status}`);
  const status2 = await statusOf(szef4.client);
  const refreshed2 = await proofRefresh(status2?.connectionId);
  check("13e the stalled refresh reports unknown (no blind retry)",
    refreshed2?.value?.outcome === "unknown",
    JSON.stringify({ outcome: refreshed2?.value?.outcome }));
  const after2 = await statusOf(szef4.client);
  check("13f an uncertain refresh leaves the connection CONNECTED (stopped only by evidence)",
    after2?.state === "connected" && after2?.credentialCapability === "ready",
    JSON.stringify({ state: after2?.state, capability: after2?.credentialCapability }));
  const effects = await proofState(refreshTokenKey(proofCode(14, "!t-ok!c-ok!r-timeout")));
  check("13g exactly one refresh attempt ran for the stalled grant",
    effects?.value?.effectCount === 1, `count=${effects?.value?.effectCount}`);
}

// --- Phase 14: the bridge completion leg (the gateway's data path) ------------
{
  // szef4 is connected after phase 13: the switch mode is the honest entry.
  const flow = await startFlow(szef4, { mode: "switch" });
  const noToken = await httpBridgeComplete(flow.state, proofCode(15), null);
  check("14a the bridge completion route denies requests without the service credential",
    noToken.status === 401, `status=${noToken.status}`);
  const bridged = await httpBridgeComplete(flow.state, proofCode(15));
  check("14b the verified bridge completion connects (what the gateway callback forwards)",
    bridged.status === 200 && bridged.payload?._tag === "ok" && bridged.payload?.value?.connected === true,
    JSON.stringify({ status: bridged.status, code: bridged.payload?.value?.code }));
  const status = await statusOf(szef4.client);
  check("14c the bridge-completed connection is recorded like the browser leg",
    status?.state === "connected" && status?.googleAccountEmail === `g1-google-15@kiero.invalid`,
    JSON.stringify({ state: status?.state, account: status?.googleAccountEmail }));
}

// --- Phase 15: firm change re-scopes the row (the rejoin happy path) ----------
let szef6 = null;
{
  szef6 = await signInFixture(SZEF6, 6);
  // szef6's FIRST (earliest-active) membership: member of szef3's firm B.
  const invited = await invite(szef3.client, { email: SZEF6, role: "member" });
  const setCode = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
    invitationId: invited.value.invitationId,
    code: FIXTURE_CODE,
  });
  const accepted = await admit(szef6.client, "access.acceptInvitation", {
    invitationId: invited.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  row("szef6 member of firm B", `${isOk(accepted)} (${setCode?._tag})`);

  const flow1 = await startFlow(szef6);
  const done1 = await httpCallback(flow1.state, proofCode(16));
  check("15a szef6 connects for firm B", done1.status === 200, `status=${done1.status}`);
  const status1 = await statusOf(szef6.client);
  const szef6ConnectionId = status1?.connectionId;
  check("15b connected with a dedicated calendar for firm B",
    status1?.state === "connected" && status1?.googleCalendarId === "kiero-proof-calendar",
    JSON.stringify({ state: status1?.state, cal: status1?.googleCalendarId }));
  const firmBRow = (await proofState(null))?.value?.connections?.find(
    (c) => c.connectionId === szef6ConnectionId,
  );
  row("szef6 row firm (firm B)", firmBRow?.companyId);
  check("15c exactly one calendar created so far for that Google account",
    (await proofState(calendarCreateKey(16)))?.value?.effectCount === 1,
    `count=${(await proofState(calendarCreateKey(16)))?.value?.effectCount}`);

  // Revoked from B, then founds firm Y: the active firm becomes Y while the
  // row still records B.
  const overview = await szef3.client.query("access/membership/functions:membershipOverview", {});
  const szef6Membership = (overview?.members ?? []).find((m) => m.email === SZEF6);
  const revoked = await dispatchMembership(szef3.client, "access.revokeMembership", {
    membershipId: szef6Membership?.membershipId,
  });
  check("15d szef3 revoked szef6 from firm B", isOk(revoked), errCode(revoked));
  // B3's revocation cleanup revoked szef6's session: a fresh sign-in (new
  // session, same person) is the honest path before founding firm Y.
  szef6 = await signInFixture(SZEF6, 6);
  const created = await admit(szef6.client, "access.createCompany", {
    name: `Firma Y G1 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const firmY = created?.value?.companyId;
  row("szef6 founded firm Y", firmY);

  const stopped = await statusOf(szef6.client);
  check("15e the status read reports the membership-lost stop for the stale-firm row",
    stopped?.state === "error" &&
      stopped?.reconnectReason === "membership_lost" &&
      stopped?.credentialCapability === "absent" &&
      stopped?.availableActions?.includes("reconnect"),
    JSON.stringify({ state: stopped?.state, reason: stopped?.reconnectReason, capability: stopped?.credentialCapability }));

  const flow2 = await startFlow(szef6);
  check("15f the restart under the new firm is admitted (the row re-scopes)",
    flow2.state !== undefined, flow2.failed ? errCode(flow2.failed) : "started");
  // The SAME Google account: only a fresh create (not a reuse of firm B's
  // calendar) proves the stale binding was dropped with the re-scope.
  const done2 = await httpCallback(flow2.state, proofCode(16));
  check("15g the callback completes for the new firm", done2.status === 200, `status=${done2.status}`);
  const after = (await proofState(null))?.value?.connections?.find(
    (c) => c.connectionId === szef6ConnectionId,
  );
  check("15h the row is now scoped to firm Y", after?.companyId === firmY,
    JSON.stringify({ companyId: after?.companyId }));
  const status2 = await statusOf(szef6.client);
  check("15i connected for the new firm with the same Google account",
    status2?.state === "connected" && status2?.googleAccountEmail === "g1-google-16@kiero.invalid",
    JSON.stringify({ state: status2?.state, account: status2?.googleAccountEmail }));
  check("15j a FRESH calendar was created for the new firm (no cross-firm reuse)",
    (await proofState(calendarCreateKey(16)))?.value?.effectCount === 2,
    `count=${(await proofState(calendarCreateKey(16)))?.value?.effectCount}`);
}

// --- Phase 16: connected row, membership lost -> the refresh stop -------------
let szef7 = null;
{
  szef7 = await signInFixture(SZEF7, 7);
  const invited = await invite(szef3.client, { email: SZEF7, role: "member" });
  const setCode = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
    invitationId: invited.value.invitationId,
    code: FIXTURE_CODE,
  });
  const accepted = await admit(szef7.client, "access.acceptInvitation", {
    invitationId: invited.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  row("szef7 member of firm B", `${isOk(accepted)} (${setCode?._tag})`);

  const flow = await startFlow(szef7);
  const done = await httpCallback(flow.state, proofCode(17));
  check("16a szef7 (member of firm B) connects", done.status === 200, `status=${done.status}`);
  const status = await statusOf(szef7.client);
  const szef7ConnectionId = status?.connectionId;
  check("16b connected with ready credentials",
    status?.state === "connected" && status?.credentialCapability === "ready",
    JSON.stringify({ state: status?.state, capability: status?.credentialCapability }));
  const memberRefresh = await proofRefresh(szef7ConnectionId);
  check("16c refresh while still a member succeeds",
    memberRefresh?.value?.outcome === "refreshed",
    JSON.stringify({ outcome: memberRefresh?.value?.outcome }));

  // Revoked while CONNECTED: the refresh capability is the immediate check.
  const overview = await szef3.client.query("access/membership/functions:membershipOverview", {});
  const szef7Membership = (overview?.members ?? []).find((m) => m.email === SZEF7);
  const revoked = await dispatchMembership(szef3.client, "access.revokeMembership", {
    membershipId: szef7Membership?.membershipId,
  });
  check("16d the administrator revoked szef7 while connected", isOk(revoked), errCode(revoked));

  const refreshed = await proofRefresh(szef7ConnectionId);
  check("16e refresh reports membership_lost (the revocation path)",
    refreshed?.value?.outcome === "membership_lost",
    JSON.stringify({ outcome: refreshed?.value?.outcome }));
  const szef7Row = (await proofState(null))?.value?.connections?.find(
    (c) => c.connectionId === szef7ConnectionId,
  );
  check("16f the row is durably stopped: disconnected/membership_lost, credentials gone, unconfirmed cleanup",
    szef7Row?.state === "disconnected" &&
      szef7Row?.reconnectReason === "membership_lost" &&
      szef7Row?.credentialStorage === "none" &&
      (szef7Row?.credentialCiphertext ?? null) === null &&
      szef7Row?.cleanupStatus === "unconfirmed",
    JSON.stringify({ state: szef7Row?.state, reason: szef7Row?.reconnectReason, storage: szef7Row?.credentialStorage, cleanup: szef7Row?.cleanupStatus }));
  const again = await proofRefresh(szef7ConnectionId);
  check("16g a second refresh after the stop is an honest no_connection",
    again?.value?.outcome === "no_connection",
    JSON.stringify({ outcome: again?.value?.outcome }));
}

// --- Summary -------------------------------------------------------------------
const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`\n# G1 live proof summary: ${results.length - failed.length}/${results.length} PASS`);
for (const f of failed) {
  console.log(`# FAILED: ${f.id}`);
}
process.exit(failed.length === 0 ? 0 : 1);
