/**
 * G3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/g3, instance knowing-toad-812, EU).
 *
 * Output is sanitized: no tokens, no keys, no service credentials. Proof
 * persons use the reserved @kiero.invalid domain. The Google legs run
 * against the deployment's OWN clearly-labeled fake endpoints (G1's
 * guarded fake Google, extended by G3 with the Calendar EVENTS API and a
 * user-action simulator), because the real Google OAuth client
 * credentials are ABSENT — the same owner action B1/G1/G2 recorded.
 * Every LIVE REAL-Google leg therefore stays BLOCKED-owner-action; what
 * is proven live here is the full reconciliation pipeline end to end:
 * real B1 sessions, a real firm, real C2 findings with corrections, real
 * C4 work dispatch, real G1 connections with sealed credentials, G2's
 * real projection pass, and G3's own real sync engine — create/update/
 * delete happy paths, the timeout-after-create unknown resolved by
 * OBSERVATION (never a second create), the calendar-scoped 404 ->
 * calendar_access_lost -> explicit recreate path, user-deleted and
 * user-moved detection (the personal-hide origins), the refresh_failed ->
 * error -> reconnect restore WITHOUT duplicates, the account-switch
 * ledger reset and rebuild, and convergence across repeated passes.
 *
 * Run: node tests/g3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_G3_DEPLOYMENT ?? "knowing-toad-812";
const URL_API = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = process.env.KIERO_G3_SITE_URL ?? `https://${DEPLOYMENT}.eu-west-1.convex.site`;

const RUN = process.env.KIERO_G3_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `g3-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szef-a"); // firm owner, no connection
const SZEF_H = person("szef-h"); // happy lifecycle account 1
const SZEF_T = person("szef-t"); // timeout-after-create account 2
const SZEF_G = person("szef-g"); // calendar gone account 3
const SZEF_R = person("szef-r"); // refresh lost/reconnect account 4

const SIGNIN = Object.fromEntries(
  [["a", SZEF_A], ["h", SZEF_H], ["t", SZEF_T], ["g", SZEF_G], ["r", SZEF_R]].map(
    ([k, email], i) => [k, { email, code: `${RUN}s${k}${i}` }],
  ),
);
const INVITE = { h: `ih${RUN}`, t: `it${RUN}`, g: `ig${RUN}`, r: `ir${RUN}` };

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
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", { envelope: envelope("access.createInvitation", input) });
const projects = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", { envelope: envelope(operation, input) });
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
const taskRevisionOf = async (client, taskId) =>
  (await workOverview(client))?.tasks?.find((t) => t.taskId === taskId)?.revisionCounter ?? null;
const runSyncPass = (connectionId) =>
  anon().action("calendar/sync/proof:g3ProofRunSyncPass", { connectionId });
const reconcileCopy = (copyId) =>
  anon().action("calendar/sync/proof:g3ProofReconcileCopy", { copyId });
const setCopyHidden = (client, copyId, hidden) =>
  client.mutation("calendar/projection/functions:dispatchCalendarProjection", {
    envelope: envelope("calendar.setCopyHidden", { copyId, hidden }),
  });
const dispatchCalendar = (client, operation, input) =>
  client.mutation("calendar/connection/functions:dispatchCalendar", { envelope: envelope(operation, input) });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HTTP helpers (G1's real OAuth boundary + G3's fake Google) --------------

async function httpStart(actor, body = {}) {
  const response = await fetch(`${SITE}/calendar/oauth/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${actor.token ?? ""}`, "content-type": "application/json" },
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

async function httpCallback(state, code) {
  const params = new URLSearchParams({ state, code });
  const response = await fetch(`${SITE}/calendar/oauth/callback?${params.toString()}`, {
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, text };
}

/** Connects one boss's calendar through the REAL flow against the fake Google. */
async function connectCalendar(actor, proofCodeValue, mode = "connect") {
  const started = await httpStart(actor, { mode });
  if (!isOk(started.payload)) {
    return { ok: false, code: errCode(started.payload) };
  }
  const url = new URL(started.payload.value.authorizationUrl);
  const state = url.searchParams.get("state");
  const done = await httpCallback(state, proofCodeValue);
  return { ok: done.status === 200 && done.text.includes("połączony"), status: done.status };
}

/** The boss acting inside Google (edit/delete/move) — the guarded simulator. */
async function adminEvent(eventId, action, patch = undefined) {
  const response = await fetch(`${SITE}/calendar/oauth/proof/fake-google/admin/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, action, ...(patch === undefined ? {} : { patch }) }),
  });
  return response.status === 200;
}

/**
 * G3's sanitized sync-state read (connections, attempts, jobs, fake
 * store); with a dedupKey also the fake Google's effect count for it.
 */
async function syncStateRead(companyId, dedupKey = undefined) {
  const response = await fetch(`${SITE}/calendar/oauth/proof/sync-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId, ...(dedupKey === undefined ? {} : { dedupKey }) }),
  });
  const payload = await response.json();
  const outer = payload?.value ?? {};
  const inner = outer.state ?? {};
  return {
    state: value(inner) ?? inner ?? null,
    effectCount: typeof outer.effectCount === "number" ? outer.effectCount : null,
  };
}

const syncState = async (companyId, dedupKey) => (await syncStateRead(companyId, dedupKey)).state;
const effectCountOf = async (companyId, dedupKey) => (await syncStateRead(companyId, dedupKey)).effectCount;

/** Runs sync passes until the predicate holds (bounded); returns the state. */
async function runPassesUntil(connectionId, companyId, predicate, label, maxTries = 8) {
  for (let i = 0; i < maxTries; i += 1) {
    await runSyncPass(connectionId);
    const state = await syncState(companyId);
    if (predicate(state)) {
      return state;
    }
  }
  row(`runPassesUntil gave up: ${label}`, "max tries reached");
  return await syncState(companyId);
}

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

/** Publishes one finding through C2's REAL dispatch and returns its id. */
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
const connectionById = (state, connectionId) =>
  connectionsOf(state).find((c) => c.connectionId === connectionId) ?? null;
const copyFor = (connection, subjectId) =>
  (connection?.copies ?? []).find((copy) => copy.subjectId === subjectId) ?? null;
const fakeEventOf = (state, eventId) =>
  (state?.fakeGoogleEvents ?? []).find((e) => e.eventId === eventId) ?? null;
const fakeEventsForSubject = (state, accountSubject, companyIdFilter = null) =>
  (state?.fakeGoogleEvents ?? []).filter(
    (e) => e.accountSubject === accountSubject && (companyIdFilter === null || e.kieroSemanticId.includes(companyIdFilter)),
  );

console.log(`# G3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("site", SITE);
row("google client credentials", "ABSENT (owner action; G1 fixture client in proof mode)");
row("proof fixtures", "KIERO_[G1|G2|G3|C4]_PROOF_ENABLED on this lease only");

// --- Setup: one firm, four connected bosses, per-persona dated tasks ------------

const A = await signInFixture(SIGNIN.a.email, SIGNIN.a.code);
row("szef A signed in", A.email);
let companyId = null;
{
  const created = await admit(A.client, "access.createCompany", {
    name: `Budowa G3 ${RUN}`,
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
  const own = (view?.members ?? []).find((m) => m.isSelf)?.membershipId ?? null;
  members.a = own;
  for (const key of ["h", "t", "g", "r"]) {
    const invited = await invite(A.client, { email: SIGNIN[key].email, role: "member" });
    const invitationId = value(invited)?.invitationId;
    await anon().action("work/probe:c4ProofSetInvitationCode", { invitationId, code: INVITE[key] });
    const person = await signInFixture(SIGNIN[key].email, SIGNIN[key].code);
    const accepted = await admit(person.client, "access.acceptInvitation", {
      invitationId,
      verificationCode: INVITE[key],
    });
    check(`S2 ${key} joined the firm`, isOk(accepted), errCode(accepted));
    members[key] = (await membershipView(A.client))?.members?.find(
      (m) => m.email === SIGNIN[key].email,
    )?.membershipId ?? null;
    members[`${key}Actor`] = person;
  }
}

let projectId = null;
{
  const identified = await projects(A.client, "projects.identifyProject", {
    displayName: `Kaczmarek ${RUN}`,
    initialStage: "in_progress",
    clientId: null,
  });
  check("S3 project identified", isOk(identified), errCode(identified));
  projectId = value(identified)?.projectId ?? null;
}

const seeded = await anon().action("work/probe:c4ProofSeedWitnessedSource", {
  sessionId: A.sessionId,
  acceptanceKey: `g3-${RUN}`,
  authorText: "Terminy: him 5.10, ht 6.10, h2 7.10, tim 8.10, gim 9.10, rim 10.10.",
});
const sourceId = seeded?.value?.sourceId ?? null;
const scope = { _tag: "project", projectId };

const taskOf = {};
{
  const specs = [
    ["h", "h1", "Beton pod fundament", "2026-10-05"],
    ["h", "h2", "Kontrola dachu", "2026-10-07"],
    ["t", "t1", "Dostawa dachówki", "2026-10-08"],
    ["g", "g1", "Wywóz gruzu", "2026-10-09"],
    ["r", "r1", "Odbiór końcowy", "2026-10-10"],
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
  row("tasks created", "h1/h2 (H) t1 (T) g1 (G) r1 (R), each coordinated by its persona");
}

const proofCode = (tag, account, behaviors = "") => `proof-code-${RUN}-${tag}-${account}${behaviors}`;

const H = members.hActor;
const T = members.tActor;
const G = members.gActor;
const R = members.rActor;

const connectH = await connectCalendar(H, proofCode("h", 1));
check("S4 H connected (account 1, healthy)", connectH.ok, JSON.stringify(connectH));
const connectT = await connectCalendar(T, `${proofCode("t", 2)}!e-create_timeout`);
check("S5 T connected (account 2, event creates stall past the deadline)", connectT.ok, JSON.stringify(connectT));
const connectG = await connectCalendar(G, `${proofCode("g", 3)}!e-calendar_gone`);
check("S6 G connected (account 3, events API answers calendar-scoped 404)", connectG.ok, JSON.stringify(connectG));
const connectR = await connectCalendar(R, proofCode("r", 4));
check("S7 R connected (account 4, healthy)", connectR.ok, JSON.stringify(connectR));

let state = await syncState(companyId);
// Resolve each persona's connection by its Google account subject.
const connBySubject = (n) =>
  connectionsOf(state).find((c) => c.googleAccountSubject === `proof-google-subject-${n}`) ?? null;
const connH = connBySubject(1);
const connT = connBySubject(2);
const connG = connBySubject(3);
const connR = connBySubject(4);
row("connections", [connH, connT, connG, connG, connR].filter(Boolean).length + " of 4 resolved");

// --- Phase 1: the first sync pass ---------------------------------------------

{
  const pass = await runSyncPass(connH.connectionId);
  row("pass H1", JSON.stringify(value(pass)));
  state = await syncState(companyId);
  const h = connectionById(state, connH.connectionId);
  const h1 = copyFor(h, taskOf.h1);
  check(
    "1a H's h1 copy CREATED in the fake Google (confirmed, remote id recorded)",
    h1?.remoteOutcome === "confirmed" && typeof h1?.googleEventId === "string",
    JSON.stringify([h1?.remoteOutcome, h1?.googleEventId]),
  );
  const fakeH1 = fakeEventOf(state, h1?.googleEventId);
  check(
    "1b the fake event carries the managed payload and the observation marker",
    fakeH1 != null &&
      fakeH1.accountSubject === "proof-google-subject-1" &&
      JSON.parse(fakeH1.eventJson).summary === "Zadanie: Beton pod fundament" &&
      fakeH1.kieroSemanticId === h1?.semanticId,
    JSON.stringify(fakeH1?.eventJson?.slice(0, 80) ?? null),
  );
  const effects = await effectCountOf(companyId, `g3-proof-event-create:proof-google-subject-1:${h1?.semanticId}`);
  check("1c exactly ONE create effect for the semantic id (no duplicates)", effects === 1, String(effects));

  // Convergence: repeated passes make zero new attempts.
  const attemptsBefore = (connectionById(await syncState(companyId), connH.connectionId)?.attempts ?? []).length;
  for (let i = 0; i < 4; i += 1) {
    await runSyncPass(connH.connectionId);
  }
  const afterState = await syncState(companyId);
  const after = connectionById(afterState, connH.connectionId);
  const attemptsAfter = (after?.attempts ?? []).length;
  row("attempts after replays", JSON.stringify((after?.attempts ?? []).map((a) => [a.legKind, a.decisionReason, a.outcome])));
  check(
    "1d four repeated passes over converged state issue ZERO external legs",
    attemptsAfter === attemptsBefore,
    `${attemptsBefore} -> ${attemptsAfter}`,
  );
  const effectsAfter = await effectCountOf(companyId, `g3-proof-event-create:proof-google-subject-1:${h1?.semanticId}`);
  check("1e still exactly one create effect after replays", effectsAfter === 1, String(effectsAfter));
}

// --- Phase 1.5: R converges too (the loss/reconnect arc needs prior copies) ----

{
  const pass = await runSyncPass(connR.connectionId);
  row("pass R1", JSON.stringify(value(pass)));
  const r = connectionById(await syncState(companyId), connR.connectionId);
  const r1 = copyFor(r, taskOf.r1);
  check(
    "1f R's copy created and confirmed (the pre-loss baseline)",
    r1?.remoteOutcome === "confirmed" && typeof r1?.googleEventId === "string",
    JSON.stringify([r1?.remoteOutcome, r1?.googleEventId != null]),
  );
}

// --- Phase 2: T's timeout-after-create -> unknown -> OBSERVATION, no 2nd create ---

{
  const pass = await runSyncPass(connT.connectionId);
  row("pass T (the create stalls 4s caller-side; the fake CREATED it first)", JSON.stringify(value(pass)));
  const t = connectionById(await syncState(companyId), connT.connectionId);
  const t1 = copyFor(t, taskOf.t1);
  // The timed-out create leaves unknown with NO remote id (or the durable
  // observation has already adopted the stray — either way, one create).
  const okUnknown =
    (t1?.remoteOutcome === "unknown" && t1?.googleEventId == null) ||
    (t1?.remoteOutcome === "confirmed" && typeof t1?.googleEventId === "string");
  check(
    "2a the timeout leaves the outcome UNKNOWN with no remote id (never assumed)",
    okUnknown,
    JSON.stringify([t1?.remoteOutcome, t1?.googleEventId]),
  );
  const createEffects = await effectCountOf(companyId, `g3-proof-event-create:proof-google-subject-2:${t1?.semanticId}`);
  check("2b exactly ONE create reached Google (the stall happened AFTER the effect)", createEffects === 1, String(createEffects));

  // The certified consumer edge resolves it: outcome recorded -> durable
  // reconcile job -> ONE observation -> the stray is ADOPTED, not recreated.
  let resolved = null;
  for (let i = 0; i < 20 && resolved === null; i += 1) {
    await sleep(1500);
    state = await syncState(companyId);
    const copy = copyFor(connectionById(state, connT.connectionId), taskOf.t1);
    if (copy?.remoteOutcome === "confirmed" && typeof copy?.googleEventId === "string") {
      resolved = copy;
    }
  }
  check(
    "2c the durable observation ADOPTED the stray (confirmed, id recorded)",
    resolved !== null,
    JSON.stringify([resolved?.remoteOutcome, resolved?.googleEventId]),
  );
  const jobs = (await syncState(companyId))?.reconcileJobs ?? [];
  row("reconcile jobs", JSON.stringify(jobs.slice(0, 6)));
  check(
    "2d the calendar.reconcile_outcome durable job ran and succeeded",
    jobs.some((j) => j.state === "succeeded"),
    JSON.stringify(jobs.map((j) => [j.state, j.externalOutcome])),
  );
  const effectsFinal = await effectCountOf(companyId, `g3-proof-event-create:proof-google-subject-2:${resolved?.semanticId}`);
  check(
    "2e STILL exactly one create — observation-before-retry, never a second create",
    effectsFinal === 1,
    String(effectsFinal),
  );
}

// --- Phase 3: G's calendar-scoped 404 -> calendar_access_lost -> explicit recreate

{
  await runSyncPass(connG.connectionId);
  state = await syncState(companyId);
  const g = connectionById(state, connG.connectionId);
  check(
    "3a the events-API 404 stopped the connection: error/calendar_access_lost",
    g?.state === "error" && g?.reconnectReason === "calendar_access_lost",
    JSON.stringify([g?.state, g?.reconnectReason]),
  );
  const g1 = copyFor(g, taskOf.g1);
  check(
    "3b no event was created and none is claimed (honest unknown, no auto-recreate)",
    g1?.googleEventId == null,
    JSON.stringify([g1?.remoteOutcome, g1?.googleEventId]),
  );
  // The explicit recreate: the boss's own decision (G1's recreate mode),
  // with a HEALTHY code — recovery is never automatic.
  const recreated = await connectCalendar(G, proofCode("g2", 3), "recreate");
  check("3c the boss explicitly recreated the dedicated calendar", recreated.ok, JSON.stringify(recreated));
  const converged = await runPassesUntil(
    connG.connectionId,
    companyId,
    (s) => copyFor(connectionById(s, connG.connectionId), taskOf.g1)?.remoteOutcome === "confirmed",
    "g1 confirmed after recreate",
  );
  const gAfter = connectionById(converged, connG.connectionId);
  const g1After = copyFor(gAfter, taskOf.g1);
  check(
    "3d after the explicit recreate the copy rebuilds (confirmed, exactly one event)",
    gAfter?.state === "connected" &&
      g1After?.remoteOutcome === "confirmed" &&
      typeof g1After?.googleEventId === "string",
    JSON.stringify([gAfter?.state, g1After?.remoteOutcome]),
  );
}

// --- Phase 4: manual Google edits — restore managed fields, preserve personal ---

{
  state = await syncState(companyId);
  const h = connectionById(state, connH.connectionId);
  const h1 = copyFor(h, taskOf.h1);
  // The boss edits the copy in Google: a personal reminders capture and a
  // changed title.
  const edited = await adminEvent(h1.googleEventId, "edit", {
    summary: "Zmienione w Google",
    reminders: { useDefault: true, overrides: [] },
  });
  check("4a the boss edited the copy inside Google (simulator)", edited);
  const observed = await reconcileCopy(h1.copyId);
  row("explicit reconcile (forced observation)", JSON.stringify(value(observed)));
  const afterObserveState = await syncState(companyId);
  const afterObserve = connectionById(afterObserveState, connH.connectionId);
  row("attempts after reconcile", JSON.stringify((afterObserve?.attempts ?? []).map((a) => [a.legKind, a.decisionReason, a.outcome, a.googleEventId != null])));
  const driftSeen = (afterObserve?.attempts ?? []).some(
    (a) => a.copyId === h1.copyId && a.legKind === "observe_get" && a.decisionReason === "explicit_reconcile_observe",
  );
  check("4b the explicit reconcile OBSERVED the drift (a read, never a mutation)", driftSeen);
  const updated = await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) => {
      const copy = copyFor(connectionById(s, connH.connectionId), taskOf.h1);
      const fake = fakeEventOf(s, copy?.googleEventId);
      return fake != null && JSON.parse(fake.eventJson).summary === "Zadanie: Beton pod fundament";
    },
    "managed fields restored",
  );
  const h1After = copyFor(connectionById(updated, connH.connectionId), taskOf.h1);
  const fake = fakeEventOf(updated, h1After.googleEventId);
  const body = JSON.parse(fake.eventJson);
  check(
    "4c Kiero RESTORED its managed summary after the manual edit",
    body.summary === "Zadanie: Beton pod fundament",
    body.summary,
  );
  check(
    "4d the personally captured reminders SURVIVED the managed update (never re-sent)",
    JSON.stringify(body.reminders) === JSON.stringify({ useDefault: true, overrides: [] }),
    JSON.stringify(body.reminders),
  );
  const updateAttempt = (connectionById(updated, connH.connectionId)?.attempts ?? []).find(
    (a) => a.copyId === h1After.copyId && a.legKind === "update",
  );
  check("4e the update leg is recorded with its timing basis (J4's ledger)", updateAttempt != null && updateAttempt.completedAtMs != null, JSON.stringify(updateAttempt ?? null));
}

// --- Phase 5: hide -> ensure absent; restore -> recreate -----------------------

{
  state = await syncState(companyId);
  const h1 = copyFor(connectionById(state, connH.connectionId), taskOf.h1);
  const hid = await setCopyHidden(H.client, h1.copyId, true);
  check("5a H hides the copy through G2's certified dispatch", isOk(hid), errCode(hid));
  const hiddenState = await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) => copyFor(connectionById(s, connH.connectionId), taskOf.h1)?.remoteOutcome === "absent",
    "hidden copy absent",
  );
  const h1Hidden = copyFor(connectionById(hiddenState, connH.connectionId), taskOf.h1);
  check(
    "5b the Kiero-owned deletion ran (absent, hide origin untouched)",
    h1Hidden?.remoteOutcome === "absent" && h1Hidden?.hidden === true && h1Hidden?.hiddenOrigin === "user_request",
    JSON.stringify([h1Hidden?.remoteOutcome, h1Hidden?.hidden, h1Hidden?.hiddenOrigin]),
  );
  check(
    "5c the fake Google no longer serves the event",
    fakeEventOf(hiddenState, h1.googleEventId) == null,
  );
  const restored = await setCopyHidden(H.client, h1.copyId, false);
  check("5d H restores the copy explicitly", isOk(restored), errCode(restored));
  const reState = await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) => copyFor(connectionById(s, connH.connectionId), taskOf.h1)?.remoteOutcome === "confirmed",
    "restored copy recreated",
  );
  const h1Re = copyFor(connectionById(reState, connH.connectionId), taskOf.h1);
  check(
    "5e the restore recreated the copy (new remote id, ONE row — never a duplicate row)",
    h1Re?.remoteOutcome === "confirmed" &&
      typeof h1Re?.googleEventId === "string" &&
      h1Re.googleEventId !== h1.googleEventId &&
      (connectionById(reState, connH.connectionId)?.copies ?? []).filter((c) => c.subjectId === taskOf.h1).length === 1,
    JSON.stringify([h1Re?.googleEventId]),
  );
}

// --- Phase 6: user-DELETED detection -> hiddenOrigin deleted_in_google ---------

{
  state = await syncState(companyId);
  const h1 = copyFor(connectionById(state, connH.connectionId), taskOf.h1);
  const deleted = await adminEvent(h1.googleEventId, "delete");
  check("6a the boss deleted the copy inside Google (hard delete, no remnant)", deleted);
  const observed = await reconcileCopy(h1.copyId);
  row("explicit reconcile after user deletion", JSON.stringify(value(observed)));
  state = await syncState(companyId);
  const h1Gone = copyFor(connectionById(state, connH.connectionId), taskOf.h1);
  check(
    "6b the deletion was DETECTED: personal hide with origin deleted_in_google",
    h1Gone?.hidden === true && h1Gone?.hiddenOrigin === "deleted_in_google" && h1Gone?.remoteOutcome === "absent",
    JSON.stringify([h1Gone?.hidden, h1Gone?.hiddenOrigin, h1Gone?.remoteOutcome]),
  );
  check(
    "6c the subject itself is untouched (still desired-projected for Kiero)",
    h1Gone?.desiredState === "projected",
    h1Gone?.desiredState,
  );
}

// --- Phase 7: user-MOVED detection -> hiddenOrigin moved_in_google -------------

{
  state = await syncState(companyId);
  const h2 = copyFor(connectionById(state, connH.connectionId), taskOf.h2);
  const moved = await adminEvent(h2.googleEventId, "move");
  check("7a the boss moved the copy outside the dedicated calendar (cancelled remnant)", moved);
  await reconcileCopy(h2.copyId);
  state = await syncState(companyId);
  const h2Moved = copyFor(connectionById(state, connH.connectionId), taskOf.h2);
  check(
    "7b the move was DETECTED: personal hide with origin moved_in_google",
    h2Moved?.hidden === true && h2Moved?.hiddenOrigin === "moved_in_google",
    JSON.stringify([h2Moved?.hidden, h2Moved?.hiddenOrigin]),
  );
  const cleaned = await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) => fakeEventOf(s, h2.googleEventId) == null,
    "moved remnant cleaned",
  );
  check(
    "7c the cancelled remnant in the managed calendar was cleaned (Kiero deletion)",
    fakeEventOf(cleaned, h2.googleEventId) == null,
  );
}

// --- Phase 8: withdrawal deletes; the timing/status export reads honestly ------

{
  const revision = await taskRevisionOf(A.client, taskOf.h2);
  const done = await work(A.client, "work.changeTaskState", {
    taskId: taskOf.h2,
    expectedRevision: revision,
    state: "done",
  });
  check("8a the task completed (withdrawal through real work dispatch)", isOk(done), errCode(done));
  const withdrawn = await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) => copyFor(connectionById(s, connH.connectionId), taskOf.h2)?.remoteOutcome === "absent",
    "withdrawn copy absent",
  );
  const h2w = copyFor(connectionById(withdrawn, connH.connectionId), taskOf.h2);
  check(
    "8b the withdrawn copy's Google event is gone (absent; hide fields untouched)",
    h2w?.remoteOutcome === "absent" && h2w?.hidden === true,
    JSON.stringify([h2w?.remoteOutcome, h2w?.hidden]),
  );
  const overview = await H.client.query("calendar/sync/functions:syncOverview", {});
  row("syncOverview (H)", JSON.stringify(overview));
  check(
    "8c the status export reads the honest sync state (confirmed+hidden copies, timing present)",
    overview?.state === "connected" &&
      overview?.copies?.total >= 2 &&
      typeof overview?.lastConfirmedAtMs === "number" &&
      typeof overview?.lastSaveToGoogleAcceptanceMs === "number" &&
      overview?.reconnectNeeded === false,
    JSON.stringify(overview),
  );
}

// --- Phase 9: refresh definitely_lost -> error; reconnect restores, no dupes ---

{
  const disconnected = await dispatchCalendar(R.client, "calendar.disconnectCalendar", {
    connectionId: connR.connectionId,
  });
  check("9a R disconnected (the user path)", isOk(disconnected), errCode(disconnected));
  const passWhileDisconnected = await runSyncPass(connR.connectionId);
  row("pass while disconnected", JSON.stringify(value(passWhileDisconnected)));
  check(
    "9b a disconnected connection syncs NOTHING (suspended, zero Google legs)",
    value(passWhileDisconnected)?.[0]?.outcome === "suspended",
    JSON.stringify(value(passWhileDisconnected)?.[0] ?? null),
  );
  // Reconnect with a refresh grant that Google will DEFINITELY refuse
  // (the documented >1-week Testing-mode shape, J4's observation).
  const reconnectedBad = await connectCalendar(R, `${proofCode("rbad", 4)}!r-invalid_grant`);
  check("9c R reconnected with a doomed refresh grant", reconnectedBad.ok, JSON.stringify(reconnectedBad));
  const passBad = await runSyncPass(connR.connectionId);
  row("pass with doomed refresh", JSON.stringify(value(passBad)));
  state = await syncState(companyId);
  const rErr = connectionById(state, connR.connectionId);
  check(
    "9d refresh definitely_lost -> honest error state refresh_failed (the mechanism)",
    rErr?.state === "error" && rErr?.reconnectReason === "refresh_failed",
    JSON.stringify([rErr?.state, rErr?.reconnectReason]),
  );
  const r1Copy = copyFor(rErr, taskOf.r1);
  check(
    "9e the copies survive the loss untouched (facts, not desires)",
    r1Copy?.remoteOutcome === "confirmed",
    JSON.stringify([r1Copy?.remoteOutcome, r1Copy?.googleEventId != null]),
  );
  const overviewErr = await R.client.query("calendar/sync/functions:syncOverview", {});
  check(
    "9f the status export answers reconnect-needed honestly",
    overviewErr?.reconnectNeeded === true,
    JSON.stringify([overviewErr?.state, overviewErr?.reconnectReason]),
  );
  // The reconnect that restores: a healthy grant for the SAME Google
  // account — recovery from the stored calendar id, no second calendar.
  const r1Before = r1Copy;
  const reconnectedGood = await connectCalendar(R, proofCode("rgood", 4));
  check("9g R reconnected with a healthy grant (same account)", reconnectedGood.ok, JSON.stringify(reconnectedGood));
  const restored = await runPassesUntil(
    connR.connectionId,
    companyId,
    (s) => {
      const c = connectionById(s, connR.connectionId);
      return c?.state === "connected" && copyFor(c, taskOf.r1)?.remoteOutcome === "confirmed";
    },
    "r reconnect converged",
  );
  const rAfter = connectionById(restored, connR.connectionId);
  const r1After = copyFor(rAfter, taskOf.r1);
  check(
    "9h the reconnect CONVERGED onto the SAME remote event (no replay, no duplicate)",
    r1After?.googleEventId === r1Before?.googleEventId,
    JSON.stringify([r1Before?.googleEventId, r1After?.googleEventId]),
  );
  const effects = await effectCountOf(companyId, `g3-proof-event-create:proof-google-subject-4:${r1After?.semanticId}`);
  check("9i still exactly one create effect for R's copy across the whole loss/reconnect arc", effects === 1, String(effects));
}

// --- Phase 9.5: restore both H copies to projected-unhidden for the switch -----

{
  state = await syncState(companyId);
  const h = connectionById(state, connH.connectionId);
  const h1 = copyFor(h, taskOf.h1);
  const unhid = await setCopyHidden(H.client, h1.copyId, false);
  check("9j H restores the deleted-detected copy explicitly", isOk(unhid), errCode(unhid));
  const revision = await taskRevisionOf(A.client, taskOf.h2);
  const reopened = await work(A.client, "work.changeTaskState", {
    taskId: taskOf.h2,
    expectedRevision: revision,
    state: "todo",
  });
  check("9k the withdrawn task reopened", isOk(reopened), errCode(reopened));
  await runPassesUntil(
    connH.connectionId,
    companyId,
    (s) =>
      (connectionById(s, connH.connectionId)?.copies ?? [])
        .filter((c) => c.desiredState === "projected" && !c.hidden)
        .every((c) => c.remoteOutcome === "confirmed"),
    "both H copies projected and confirmed",
  );
}

// --- Phase 10: the account switch -> ledger reset and rebuild ------------------

{
  const switched = await connectCalendar(H, proofCode("hswitch", 9), "switch");
  check("10a H switched to a different Google account", switched.ok, JSON.stringify(switched));
  state = await syncState(companyId);
  const hSwitched = connectionsOf(state).find(
    (c) => c.googleAccountSubject === "proof-google-subject-9",
  );
  check(
    "10b the switch recorded unconfirmed cleanup for the old account's calendar",
    hSwitched?.cleanupStatus === "unconfirmed",
    JSON.stringify([hSwitched?.cleanupStatus]),
  );
  const rebuilt = await runPassesUntil(
    hSwitched.connectionId,
    companyId,
    (s) =>
      (connectionById(s, hSwitched.connectionId)?.copies ?? []).every(
        (c) => c.remoteOutcome === "confirmed" || c.remoteOutcome === "absent",
      ),
    "switch rebuild converged",
  );
  const hNew = connectionById(rebuilt, hSwitched.connectionId);
  const h1New = copyFor(hNew, taskOf.h1);
  check(
    "10c the ledger was RESET and REBUILT under the new account (new semantic id, confirmed)",
    h1New?.remoteOutcome === "confirmed" &&
      typeof h1New?.googleEventId === "string" &&
      h1New.semanticId.includes("proof-google-subject-9"),
    JSON.stringify([h1New?.remoteOutcome, h1New?.semanticId?.slice(-40)]),
  );
  const newEvents = fakeEventsForSubject(rebuilt, "proof-google-subject-9", companyId);
  const oldEvents = fakeEventsForSubject(rebuilt, "proof-google-subject-1", companyId);
  check(
    "10d the new account's calendar has exactly the rebuilt copies (no duplicates)",
    newEvents.length === (hNew?.copies ?? []).filter((c) => c.desiredState === "projected" && !c.hidden).length &&
      newEvents.length > 0,
    `${newEvents.length} new-account events`,
  );
  check(
    "10e the old account's events remain (honest unconfirmed cleanup — no Kiero access)",
    oldEvents.length > 0,
    `${oldEvents.length} old-account events remain`,
  );
}

// --- Summary -------------------------------------------------------------------

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`# ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
  process.exitCode = 1;
}
