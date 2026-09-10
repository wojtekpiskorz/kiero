/**
 * G4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/g4, instance elated-fish-725).
 *
 * Output is sanitized: no tokens, no keys, no service credentials. Proof
 * persons use the reserved @kiero.invalid domain. The Google legs run
 * against the deployment's OWN clearly-labeled fake endpoints (G1's
 * guarded fake Google with G3's Calendar EVENTS API), because the real
 * Google OAuth client credentials are ABSENT — the same owner action
 * B1/G1/G2/G3 recorded. Every LIVE REAL-Google leg stays
 * BLOCKED-owner-action.
 *
 * Lease environment (names only; the dev lease snapshots guard variables
 * into module bundles at push time, so every variable below landed BEFORE
 * the recorded `npx convex dev --once` push): JWT_PRIVATE_KEY, JWKS (a
 * fresh dev keypair for this lease), KIERO_PROBE_ENABLED (the sources/
 * memory probe domain), KIERO_B3_PROOF_ENABLED, KIERO_C4_PROOF_ENABLED,
 * KIERO_G1_PROOF_ENABLED, KIERO_G2_PROOF_ENABLED, KIERO_G3_PROOF_ENABLED,
 * KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE and
 * KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE (both pointing at the
 * deployment's own fake Google endpoints).
 *
 * What is proven live here is the settings surface's producer/consumer
 * seam end to end: the exact reads the /kalendarz screen consumes
 * (calendarStatus, G2 projectionOverview, G3 syncOverview) and the exact
 * commands it issues (the startAuthorization mutation — the browser leg,
 * not the gateway HTTP boundary — plus the typed dispatches
 * calendar.disconnectCalendar, calendar.setCopyHidden,
 * calendar.reconcileCopy) through every state the issue names:
 *
 *  G4-1  the PWA connect leg (mutation start + callback) and the honest
 *        nothing-synced-yet read before any pass;
 *  G4-2  pending (desired but unconfirmed) after the projection pass only;
 *  G4-3  healthy after the sync pass, with the last-success timestamp and
 *        the managed deep link /co-teraz?zadanie=<id> in the fake event;
 *  G4-4  personal hide -> withdrawn from Google -> restore -> recreated
 *        (the hide/restore flow the copies list issues);
 *  G4-5  partial failure: a persona whose event creates stall past the
 *        deadline (attempts uncertain, copy pending — never success);
 *  G4-6  confirmed deleted: calendar-scoped 404 -> calendar_access_lost ->
 *        recreate offered (never blind) -> explicit recreate converges;
 *  G4-7  disconnect: cleanup residue recorded, copies still listed with
 *        actions honestly unservable, membership untouched;
 *  G4-8  the project-scope toggle leg: the certified write interface
 *        (calendar.setSelection, flagged in G2's report) does not exist —
 *        the honest unsupported refusal is recorded and the leg stays
 *        BLOCKED-prerequisite;
 *  G4-9  stale UI commands: membership revoked -> every calendar command
 *        and read for that boss honestly stops; connection revision
 *        changed -> reconcileCopy refuses unavailable; a foreign copy is
 *        not_found without existence leaks.
 *
 * Run: node tests/g4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_G4_DEPLOYMENT ?? "elated-fish-725";
const URL_API = process.env.KIERO_G4_API_URL ?? `https://${DEPLOYMENT}.convex.cloud`;
const SITE = process.env.KIERO_G4_SITE_URL ?? `https://${DEPLOYMENT}.convex.site`;

const RUN = process.env.KIERO_G4_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `g4-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szef-a"); // firm owner, no calendar of their own
const SZEF_B = person("szef-b"); // main settings persona (healthy -> hide/restore -> disconnect)
const SZEF_T = person("szef-t"); // partial failure persona (event creates stall)
const SZEF_G = person("szef-g"); // confirmed-deleted persona (calendar gone)
const SZEF_R = person("szef-r"); // stale-command persona (membership revoked)

const SIGNIN = Object.fromEntries(
  [["a", SZEF_A], ["b", SZEF_B], ["t", SZEF_T], ["g", SZEF_G], ["r", SZEF_R]].map(
    ([k, email], i) => [k, { email, code: `${RUN}s${k}${i}` }],
  ),
);
const INVITE = { b: `ib${RUN}`, t: `it${RUN}`, g: `ig${RUN}`, r: `ir${RUN}` };

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
const dispatchMembership = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", { envelope: envelope(operation, input) });
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", { envelope: envelope("access.createInvitation", input) });
const work = (client, operation, input) =>
  client.mutation("work/functions:dispatchWork", { envelope: envelope(operation, input) });
const memory = (operation, input, sessionId) =>
  anon().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
const membershipView = (client) =>
  client.query("access/membership/functions:membershipOverview", {});
const currentFindings = (scope, sessionId) =>
  anon().action("memory/findings/probe:probeReadCurrentFindings", { scope, sessionId });
const workOverview = (client) => client.query("work/functions:workOverview", {});

// The exact reads the /kalendarz screen consumes.
const calendarStatus = (client) =>
  client.query("calendar/connection/functions:calendarStatus", {});
const syncOverview = (client) => client.query("calendar/sync/functions:syncOverview", {});
const projectionOverview = (client) =>
  client.query("calendar/projection/functions:projectionOverview", {});

// The exact commands the screen issues (typed dispatches + the browser
// authorization-start mutation).
const dispatchCalendar = (client, operation, input) =>
  client.mutation("calendar/connection/functions:dispatchCalendar", { envelope: envelope(operation, input) });
const dispatchProjection = (client, operation, input) =>
  client.mutation("calendar/projection/functions:dispatchCalendarProjection", { envelope: envelope(operation, input) });
const dispatchSync = (client, operation, input) =>
  client.mutation("calendar/sync/functions:dispatchCalendarSync", { envelope: envelope(operation, input) });
const startAuthorization = (client, mode) =>
  client.mutation("calendar/connection/functions:startAuthorization", { mode });

const runSyncPass = (connectionId) =>
  anon().action("calendar/sync/proof:g3ProofRunSyncPass", { connectionId });
const runProjectionPass = (connectionId) =>
  anon().action("calendar/projection/proof:g2ProofRunPass", { connectionId });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

async function httpCallback(state, code) {
  const params = new URLSearchParams({ state, code });
  const response = await fetch(`${SITE}/calendar/oauth/callback?${params.toString()}`, {
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, text };
}

/** The browser connect leg: the PWA's own startAuthorization mutation. */
async function connectViaPwa(actor, proofCodeValue, mode = "connect") {
  const started = await startAuthorization(actor.client, mode);
  if (!isOk(started)) {
    return { ok: false, code: errCode(started) };
  }
  const url = new URL(started.value.authorizationUrl);
  const state = url.searchParams.get("state");
  const done = await httpCallback(state, proofCodeValue);
  return { ok: done.status === 200 && done.text.includes("połączony"), status: done.status };
}

async function syncStateRead(companyId) {
  const response = await fetch(`${SITE}/calendar/oauth/proof/sync-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId }),
  });
  const payload = await response.json();
  const outer = payload?.value ?? {};
  const inner = outer.state ?? {};
  return value(inner) ?? inner ?? null;
}
const syncState = async (companyId) => await syncStateRead(companyId);

/** Real B1 sign-in with a fixture code from C4's guarded probe (lease workaround). */
async function signInFixture(email, code) {
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await bootstrap.action("work/probe:c4ProofSetSignInCode", { email, code });
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

const temporalDay = (day, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression: "ustalony termin", role },
});
const known = { _tag: "known" };

async function publishFinding(sessionId, sourceId, scope, semanticKey, findingValue) {
  const prepared = await memory("memory.prepareChangeSet", {
    sourceId,
    plannedRevisions: [
      {
        findingId: null,
        scope,
        semanticKey,
        value: findingValue,
        knowledgeState: known,
        effectiveFrom: null,
        evidence: [{ sourceId, fragmentId: null, supportKind: "support" }],
        derivesFrom: [],
      },
    ],
  }, sessionId);
  if (!isOk(prepared)) {
    throw new Error(`prepareChangeSet failed for ${semanticKey}: ${errCode(prepared)}`);
  }
  const published = await memory("memory.publishChangeSet", {
    changeSetId: value(prepared).changeSetId,
    expectedRevisions: [],
  }, sessionId);
  if (!isOk(published)) {
    throw new Error(`publishChangeSet failed for ${semanticKey}: ${errCode(published)}`);
  }
  const rows = value(await currentFindings(scope, sessionId))?.rows;
  const found = rows?.find((candidate) => candidate.semanticKey === semanticKey);
  if (found === undefined) {
    throw new Error(`published finding not readable: ${semanticKey}`);
  }
  return found;
}

const connectionsOf = (state) => state?.connections ?? [];
const fakeEventOf = (state, eventId) =>
  (state?.fakeGoogleEvents ?? []).find((e) => e.eventId === eventId) ?? null;

console.log(`# G4 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("site", SITE);
row("google client credentials", "ABSENT (owner action; G1 fixture client in proof mode)");
row("proof fixtures", "KIERO_[G1|G2|G3|B3|C4]_PROOF_ENABLED on this lease only");

// --- Setup: one firm, four settings personas, per-persona dated tasks ------

const A = await signInFixture(SIGNIN.a.email, SIGNIN.a.code);
row("szef A signed in", A.email);
let companyId = null;
{
  const created = await admit(A.client, "access.createCompany", {
    name: `Budowa G4 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  check("S1 firm created (Europe/Warsaw)", isOk(created), errCode(created));
  companyId = value(created)?.companyId ?? null;
  row("companyId", companyId);
}

const members = {};
{
  const view = await membershipView(A.client);
  members.a = (view?.members ?? []).find((m) => m.isSelf)?.membershipId ?? null;
  for (const key of ["b", "t", "g", "r"]) {
    const invited = await invite(A.client, { email: SIGNIN[key].email, role: "member" });
    const invitationId = value(invited)?.invitationId;
    await anon().action("work/probe:c4ProofSetInvitationCode", { invitationId, code: INVITE[key] });
    const personClient = await signInFixture(SIGNIN[key].email, SIGNIN[key].code);
    const accepted = await admit(personClient.client, "access.acceptInvitation", {
      invitationId,
      verificationCode: INVITE[key],
    });
    check(`S2 ${key} joined the firm`, isOk(accepted), errCode(accepted));
    members[key] = (await membershipView(A.client))?.members?.find(
      (m) => m.email === SIGNIN[key].email,
    )?.membershipId ?? null;
    members[`${key}Actor`] = personClient;
  }
}

let projectId = null;
{
  const identified = await A.client.mutation("projects/functions:dispatchProjects", {
    envelope: envelope("projects.identifyProject", {
      displayName: `Kaczmarek ${RUN}`,
      initialStage: "in_progress",
      clientId: null,
    }),
  });
  check("S3 project identified", isOk(identified), errCode(identified));
  projectId = value(identified)?.projectId ?? null;
}

const seeded = await anon().action("work/probe:c4ProofSeedWitnessedSource", {
  sessionId: A.sessionId,
  acceptanceKey: `g4-${RUN}`,
  authorText: "Terminy: b 5.10, t 6.10, g 7.10, r 8.10.",
});
const sourceId = seeded?.value?.sourceId ?? null;
const scope = { _tag: "project", projectId };

const taskOf = {};
{
  const specs = [
    ["b", "b1", "Beton pod fundament", "2026-10-05"],
    ["t", "t1", "Kontrola dachu", "2026-10-06"],
    ["g", "g1", "Wywóz gruzu", "2026-10-07"],
    ["r", "r1", "Odbiór końcowy", "2026-10-08"],
  ];
  for (const [persona, tag, title, day] of specs) {
    const finding = await publishFinding(
      A.sessionId,
      sourceId,
      scope,
      `deadline.${tag}.${RUN}`,
      temporalDay(day, "agreed"),
    );
    const task = await work(A.client, "work.changeTask", {
      taskId: null,
      projectId,
      title,
      executorContactId: null,
      coordinatorMembershipId: members[persona],
      deadlineFindingId: finding.findingId,
      linkedEventId: null,
      expectedRevision: 1,
    });
    if (!isOk(task)) {
      throw new Error(`task ${tag} failed: ${errCode(task)}`);
    }
    taskOf[tag] = value(task).taskId;
  }
  row("tasks created", "b1 (B) t1 (T) g1 (G) r1 (R), each coordinated by its persona");
}

const proofCode = (tag, account, behaviors = "") => `proof-code-${RUN}-${tag}-${account}${behaviors}`;

const B = members.bActor;
const T = members.tActor;
const G = members.gActor;
const R = members.rActor;

// --- G4-1: the PWA connect leg + the honest nothing-synced-yet read -------

const connectB = await connectViaPwa(B, proofCode("b", 5));
check("G4-1a B connected through the PWA start mutation + callback", connectB.ok, JSON.stringify(connectB));
{
  const status = await calendarStatus(B.client);
  check(
    "G4-1b calendarStatus connected with the dedicated calendar and account",
    status?.state === "connected" &&
      status?.googleCalendarId === "kiero-proof-calendar" &&
      status?.googleAccountEmail === "g1-google-5@kiero.invalid",
    JSON.stringify({ state: status?.state, cal: status?.googleCalendarId, account: status?.googleAccountEmail }),
  );
  const overview = await syncOverview(B.client);
  check(
    "G4-1c before any pass: zero copies, the honest nothing-synced-yet read",
    overview?.copies?.total === 0 && overview?.lastConfirmedAtMs === null && overview?.reconnectNeeded === false,
    JSON.stringify({ copies: overview?.copies, last: overview?.lastConfirmedAtMs }),
  );
}

// --- G4-2: pending (desired but unconfirmed) after the projection pass -----

{
  const pass = await runProjectionPass(await connectionIdOf(B, 5));
  check("G4-2a the projection pass ran", isOk(pass), errCode(pass));
  const overview = await syncOverview(B.client);
  const projection = await projectionOverview(B.client);
  const copy = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.b1);
  check(
    "G4-2b the copy is desired but UNCONFIRMED (pending, never success)",
    overview?.copies?.pending === 1 && copy?.remoteOutcome === "unknown" && copy?.desiredState === "projected",
    JSON.stringify({ pending: overview?.copies, outcome: copy?.remoteOutcome }),
  );
  check(
    "G4-2c no last-success timestamp exists yet",
    overview?.lastConfirmedAtMs === null,
    JSON.stringify(overview?.lastConfirmedAtMs),
  );
}

// --- G4-3: healthy after the sync pass + the managed deep link -------------

{
  const connectionId = await connectionIdOf(B, 5);
  await runSyncPass(connectionId);
  const overview = await syncOverview(B.client);
  const projection = await projectionOverview(B.client);
  const copy = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.b1);
  check(
    "G4-3a the copy is confirmed and the last success recorded",
    overview?.copies?.confirmed === 1 &&
      overview?.copies?.pending === 0 &&
      copy?.remoteOutcome === "confirmed" &&
      typeof overview?.lastConfirmedAtMs === "number",
    JSON.stringify({ copies: overview?.copies, last: overview?.lastConfirmedAtMs }),
  );
  const state = await syncState(companyId);
  const fakeEvent = fakeEventOf(state, copy?.googleEventId);
  const description = fakeEvent === null ? "" : JSON.parse(fakeEvent.eventJson).description ?? "";
  check(
    "G4-3b the managed deep link points at the current Kiero task route",
    description.includes(`/co-teraz?zadanie=${taskOf.b1}`),
    description.split("\n").find((line) => line.includes("co-teraz")) ?? "no link line",
  );
  check(
    "G4-3c the managed copy says Kiero stays authoritative",
    description.includes("zarządzany przez Kiero") && description.includes("nie zmieniają ustaleń"),
    "description authority lines present",
  );
}

// --- G4-4: personal hide -> withdrawn from Google -> restore -> recreated --

{
  const projection = await projectionOverview(B.client);
  const copy = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.b1);
  const hidden = await dispatchProjection(B.client, "calendar.setCopyHidden", {
    copyId: copy.copyId,
    hidden: true,
  });
  check("G4-4a personal hide accepted", isOk(hidden), errCode(hidden));
  const afterHide = await projectionOverview(B.client);
  const hiddenRow = (afterHide?.copies ?? []).find((c) => c.copyId === copy.copyId);
  check("G4-4b the row reads hidden (the restore action's basis)", hiddenRow?.hidden === true, JSON.stringify(hiddenRow?.hidden));
  const connectionId = await connectionIdOf(B, 5);
  await runSyncPass(connectionId);
  const state = await syncState(companyId);
  const stillThere = (state?.fakeGoogleEvents ?? []).some(
    (e) => e.kieroSemanticId === copy.semanticId && e.accountSubject === "proof-google-subject-5",
  );
  check("G4-4c the hidden copy is withdrawn from the fake Google", !stillThere, `present=${stillThere}`);
  const restored = await dispatchProjection(B.client, "calendar.setCopyHidden", {
    copyId: copy.copyId,
    hidden: false,
  });
  check("G4-4d explicit restore accepted", isOk(restored), errCode(restored));
  // Re-creation converges ACROSS passes (the first pass observes the stale
  // Google id absent, the next creates fresh — G3's convergence shape);
  // bounded passes, never a tight loop.
  let restoredRow = null;
  for (let i = 0; i < 4 && restoredRow?.remoteOutcome !== "confirmed"; i += 1) {
    await runSyncPass(connectionId);
    const afterRestore = await projectionOverview(B.client);
    restoredRow = (afterRestore?.copies ?? []).find((c) => c.copyId === copy.copyId) ?? null;
  }
  check(
    "G4-4e the restored copy is projected and confirmed again",
    restoredRow?.hidden === false && restoredRow?.remoteOutcome === "confirmed",
    JSON.stringify({ hidden: restoredRow?.hidden, outcome: restoredRow?.remoteOutcome }),
  );
}

// --- G4-5: partial failure (creates stall past the deadline) ---------------

{
  const connectT = await connectViaPwa(T, `${proofCode("t", 6)}!e-create_timeout`);
  check("G4-5a T connected (event creates stall)", connectT.ok, JSON.stringify(connectT));
  const connectionId = await connectionIdOf(T, 6);
  await runSyncPass(connectionId);
  const overview = await syncOverview(T.client);
  const projection = await projectionOverview(T.client);
  const copy = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.t1);
  check(
    "G4-5b the stalled create leaves the copy pending with a recorded attempt",
    copy?.remoteOutcome === "unknown" &&
      overview?.copies?.pending === 1 &&
      overview?.attempts?.recorded >= 1,
    JSON.stringify({ outcome: copy?.remoteOutcome, copies: overview?.copies, attempts: overview?.attempts }),
  );
  check(
    "G4-5c partial failure never reads as success",
    overview?.copies?.confirmed === 0 && overview?.lastConfirmedAtMs === null,
    JSON.stringify({ confirmed: overview?.copies?.confirmed, last: overview?.lastConfirmedAtMs }),
  );
}

// --- G4-6: confirmed deleted -> recreate offered (never blind) -> rebuild --

{
  const connectG = await connectViaPwa(G, `${proofCode("g", 7)}!e-calendar_gone`);
  check("G4-6a G connected (events API answers calendar-scoped 404)", connectG.ok, JSON.stringify(connectG));
  const connectionId = await connectionIdOf(G, 7);
  await runSyncPass(connectionId);
  const status = await calendarStatus(G.client);
  check(
    "G4-6b calendar_access_lost with the explicit recreate offered",
    status?.state === "error" &&
      status?.reconnectReason === "calendar_access_lost" &&
      status?.availableActions?.includes("recreate"),
    JSON.stringify({ state: status?.state, reason: status?.reconnectReason, actions: status?.availableActions }),
  );
  const overview = await syncOverview(G.client);
  check(
    "G4-6c the diagnostics read reconnect-needed with the same reason",
    overview?.reconnectNeeded === true && overview?.reconnectReason === "calendar_access_lost",
    JSON.stringify({ needed: overview?.reconnectNeeded, reason: overview?.reconnectReason }),
  );
  const recreate = await connectViaPwa(G, proofCode("g2", 7), "recreate");
  check("G4-6d the explicit recreate converges through the PWA leg", recreate.ok, JSON.stringify(recreate));
  const after = await calendarStatus(G.client);
  check(
    "G4-6e after recreate the connection is healthy again",
    after?.state === "connected" && !(after?.availableActions ?? []).includes("recreate"),
    JSON.stringify({ state: after?.state, actions: after?.availableActions }),
  );
}

// --- G4-7: disconnect records cleanup residue; copies remain listed --------

{
  const status = await calendarStatus(B.client);
  const disconnected = await dispatchCalendar(B.client, "calendar.disconnectCalendar", {
    connectionId: status.connectionId,
  });
  check("G4-7a disconnect through the typed dispatch", isOk(disconnected), errCode(disconnected));
  const after = await calendarStatus(B.client);
  check(
    "G4-7b disconnected with unconfirmed cleanup recorded",
    after?.state === "disconnected" && after?.cleanupStatus === "unconfirmed",
    JSON.stringify({ state: after?.state, cleanup: after?.cleanupStatus }),
  );
  const overview = await syncOverview(B.client);
  check(
    "G4-7c the diagnostics read cleanup residue and reconnect-needed",
    overview?.cleanupRemains === true && overview?.reconnectNeeded === true,
    JSON.stringify({ residue: overview?.cleanupRemains, needed: overview?.reconnectNeeded }),
  );
  const projection = await projectionOverview(B.client);
  const copyRow = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.b1);
  check(
    "G4-7d the copies stay listed for the stopped connection (actions honestly unservable)",
    copyRow !== undefined && projection?.state === "connected",
    `rows=${(projection?.copies ?? []).length}`,
  );
  const view = await membershipView(B.client);
  check(
    "G4-7e disconnect does not touch the login: B is still a member",
    (view?.members ?? []).some((m) => m.email === SZEF_B),
    `state=${view?.state}`,
  );
}

// --- G4-8: the project-scope toggle leg (the named prerequisite) -----------

{
  const refused = await dispatchProjection(B.client, "calendar.setSelection", {
    mode: "explicit",
    projectIds: [projectId],
  });
  check(
    "G4-8a the project-selection write interface fails closed (unsupported/unknown operation)",
    !isOk(refused) && /unsupported|unknown_operation|validation/.test(errCode(refused)),
    errCode(refused),
  );
  row(
    "G4-8b project toggle leg",
    "BLOCKED-prerequisite: calendar.setSelection does not exist in the certified contracts (flagged in G2's report); the surface renders the honest not-yet-available display",
  );
}

// --- G4-9: stale UI commands ----------------------------------------------

{
  // (a) membership revoked: every command and read for that boss honestly stops
  const connectR = await connectViaPwa(R, proofCode("r", 8));
  check("G4-9a R connected before revocation", connectR.ok, JSON.stringify(connectR));
  const connectionId = await connectionIdOf(R, 8);
  await runSyncPass(connectionId);
  const projection = await projectionOverview(R.client);
  const copy = (projection?.copies ?? []).find((c) => c.subjectId === taskOf.r1);
  check("G4-9b R's copy confirmed before revocation", copy?.remoteOutcome === "confirmed", copy?.remoteOutcome);
  const revoked = await dispatchMembership(A.client, "access.revokeMembership", { membershipId: members.r });
  check("G4-9c membership revoked", isOk(revoked), errCode(revoked));
  // B3's revocation cleanup also revokes the session (G1's phase-15 note):
  // a stale command comes back either as the unauthenticated envelope or as
  // the thrown no_live_session denial. Both are honest rejections.
  const rejectionOf = async (fn) => {
    const result = await fn().catch((error) => ({
      _tag: "error",
      error: { code: `thrown:${String(error?.data?.message ?? error?.message ?? error)}` },
    }));
    if (isOk(result)) {
      return "accepted";
    }
    if (result?._tag === "error") {
      return `${result.error.code}:${result.error.message ?? ""}`;
    }
    // A query result (not an envelope): show its sanitized shape.
    return `data:${JSON.stringify(result).slice(0, 120)}`;
  };
  const hideRejection = await rejectionOf(() =>
    dispatchProjection(R.client, "calendar.setCopyHidden", { copyId: copy.copyId, hidden: true }),
  );
  check(
    "G4-9d the stale hide is rejected (no live company context)",
    hideRejection !== "accepted" && /unauthenticated|no_live_session|no_verified_identity/.test(hideRejection),
    hideRejection,
  );
  const reconcileRejection = await rejectionOf(() =>
    dispatchSync(R.client, "calendar.reconcileCopy", { copyId: copy.copyId }),
  );
  check(
    "G4-9e the stale reconcile is rejected the same honest way",
    reconcileRejection !== "accepted" && /unauthenticated|no_live_session|no_verified_identity/.test(reconcileRejection),
    reconcileRejection,
  );
  const statusForm = await rejectionOf(() => calendarStatus(R.client));
  check(
    "G4-9f the status read honestly stops for the revoked boss (session denial or the no-company view)",
    /no_live_session|no_verified_identity|unavailable_no_company|membership_lost|zaloguj/i.test(statusForm),
    statusForm.slice(0, 160),
  );

  // (b) connection revision changed: reconcileCopy refuses unavailable
  const bStatus = await calendarStatus(B.client);
  const bProjection = await projectionOverview(B.client);
  const bCopy = (bProjection?.copies ?? []).find((c) => c.subjectId === taskOf.b1);
  const refusedReconcile = await dispatchSync(B.client, "calendar.reconcileCopy", { copyId: bCopy.copyId });
  check(
    "G4-9g reconcileCopy on a disconnected connection refuses unavailable (never a fake outcome)",
    !isOk(refusedReconcile) && /unavailable/.test(errCode(refusedReconcile)),
    errCode(refusedReconcile),
  );

  // (c) a foreign copy is not_found without existence leaks
  const foreignHide = await dispatchProjection(A.client, "calendar.setCopyHidden", {
    copyId: bCopy.copyId,
    hidden: true,
  });
  check(
    "G4-9h another boss's copy is not_found (no existence leak)",
    !isOk(foreignHide) && /not_found/.test(errCode(foreignHide)),
    errCode(foreignHide),
  );

  // (d) cross-user sanity: A's own reads stay empty
  const aStatus = await calendarStatus(A.client);
  const aProjection = await projectionOverview(A.client);
  check(
    "G4-9i the owner without a connection sees no calendar and no copies",
    aStatus?.state === "disconnected" && aStatus?.connectionId === null && (aProjection?.copies ?? []).length === 0,
    JSON.stringify({ state: aStatus?.state, rows: (aProjection?.copies ?? []).length }),
  );
}

// --- Summary ---------------------------------------------------------------

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(
  `# G4 summary: ${results.length - failed.length}/${results.length} PASS` +
    (failed.length > 0 ? `; FAILED: ${failed.map((f) => f.id).join(", ")}` : ""),
);
process.exitCode = failed.length > 0 ? 1 : 0;

/** Resolves one persona's connection id through the sanitized proof read. */
async function connectionIdOf(actor, account) {
  const state = await syncState(companyId);
  const connection = connectionsOf(state).find(
    (c) => c.googleAccountSubject === `proof-google-subject-${account}`,
  );
  if (connection === null || connection === undefined) {
    throw new Error(`connection not found for account ${account}`);
  }
  return connection.connectionId;
}
