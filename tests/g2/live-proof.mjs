/**
 * G2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/g2, instance chatty-mammoth-484, EU).
 *
 * Output is sanitized: no tokens, no keys, no service credentials. Proof
 * persons use the reserved @kiero.invalid domain. The Google legs run
 * against the deployment's OWN clearly-labeled fake endpoints (G1's
 * guarded proof fixtures), because the real Google OAuth client
 * credentials are ABSENT — the same owner action B1/G1 recorded. Every
 * LIVE Google leg therefore stays BLOCKED-owner-action; what is proven
 * live here is the full deterministic projection pipeline end to end:
 * real B1 sessions, a real firm with two bosses plus a third whose
 * connection refresh answers UNKNOWN, real C2 findings with corrections,
 * real C4 work dispatch, real G1 connections with sealed credentials, and
 * G2's own real projection pass — desired copies, marker semantics,
 * re-derivation after correction, withdrawal on completion, personal hide
 * survival, per-pass suspension without desired-state writes, personal
 * scope partitioning, and the account-switch identity re-mint.
 *
 * Run: node tests/g2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_G2_DEPLOYMENT ?? "chatty-mammoth-484";
const URL_API = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = process.env.KIERO_G2_SITE_URL ?? `https://${DEPLOYMENT}.eu-west-1.convex.site`;

const RUN = process.env.KIERO_G2_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `g2-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szef-a");
const SZEF_B = person("szef-b");
const SZEF_C = person("szef-c");

// Per-persona fixture codes (unique values; the code lookup is unique by
// hash). Numbers select the fake Google account the proof code binds.
const SIGNIN_A = `${RUN}a`;
const SIGNIN_B = `${RUN}b`;
const SIGNIN_C = `${RUN}c`;
const INVITE_B = `ib${RUN}`;
const INVITE_C = `ic${RUN}`;

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
const projects = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", { envelope: envelope(operation, input) });
const work = (client, operation, input) =>
  client.mutation("work/functions:dispatchWork", { envelope: envelope(operation, input) });
// C2's memory surface through its guarded service-bridge probe under the
// proof person's own live session (the C4 precedent).
const memory = (operation, input, sessionId) =>
  anon().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
const membershipView = (client) =>
  client.query("access/membership/functions:membershipOverview", {});
const workOverview = (client) => client.query("work/functions:workOverview", {});
const taskRevisionOf = async (client, taskId) =>
  (await workOverview(client))?.tasks?.find((t) => t.taskId === taskId)?.revisionCounter ?? null;
const currentFindings = (scope, sessionId) =>
  anon().action("memory/findings/probe:probeReadCurrentFindings", { scope, sessionId });
const projectionState = (companyId) =>
  anon().action("calendar/projection/proof:g2ProofProjectionState", { companyId });
const runPass = (connectionId = undefined) =>
  anon().action("calendar/projection/proof:g2ProofRunPass",
    connectionId === undefined ? {} : { connectionId });
const setCopyHidden = (client, copyId, hidden) =>
  client.mutation("calendar/projection/functions:dispatchCalendarProjection", {
    envelope: envelope("calendar.setCopyHidden", { copyId, hidden }),
  });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

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

// --- HTTP helpers (G1's real OAuth boundary + fake Google) --------------------

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

const proofCode = (account, behaviors = "") => `proof-code-${RUN}-${account}${behaviors}`;

const temporalDay = (day, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression: "ustalony termin", role },
});
const temporalDateTime = (iso, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "date_time", value: iso }, originalExpression: "ustalona godzina", role },
});
const temporalRange = (startDay, endDay, role) => ({
  _tag: "temporal",
  temporal: {
    shape: { _tag: "range", start: { _tag: "day", day: startDay }, end: { _tag: "day", day: endDay } },
    originalExpression: "ustalony zakres",
    role,
  },
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

const connectionsOf = (state) => value(state)?.connections ?? [];
const connectionBySubject = (state, googleSubject) =>
  connectionsOf(state).find((c) => c.googleAccountSubject === googleSubject) ?? null;
/** The canonical copyProjected events, newest last (the G3 consumption pin). */
const copyEventsOf = (state) => value(state)?.copyProjectedEvents ?? [];
const latestEventFor = (state, copyId) => {
  const own = copyEventsOf(state).filter((e) => e.copyId === copyId);
  return own.length === 0 ? null : own[own.length - 1];
};
const copiesOf = (connection, subjectId) =>
  (connection?.copies ?? []).filter((copy) => copy.subjectId === subjectId);

console.log(`# G2 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("site", SITE);
row("google client credentials", "ABSENT (owner action; G1 fixture client in proof mode)");
row("proof fixtures", "KIERO_[B1|G1|G2|C4]_PROOF_ENABLED + KIERO_PROBE_ENABLED on this lease only");

// --- Setup: one firm, three bosses, one project, dated findings, work ---------

const A = await signInFixture(SZEF_A, SIGNIN_A);
row("szef A signed in", A.email);
let companyId = null;
{
  const created = await admit(A.client, "access.createCompany", {
    name: `Budowa G2 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  check("S1 firm A created (Europe/Warsaw)", isOk(created), errCode(created));
  companyId = value(created)?.companyId ?? null;
}

let B = null;
let C = null;
let membershipA = null;
let membershipB = null;
{
  const invitedB = await invite(A.client, { email: SZEF_B, role: "member" });
  check("S2 B invited", isOk(invitedB), errCode(invitedB));
  const invitationB = value(invitedB)?.invitationId;
  await anon().action("work/probe:c4ProofSetInvitationCode", { invitationId: invitationB, code: INVITE_B });
  B = await signInFixture(SZEF_B, SIGNIN_B);
  const acceptedB = await admit(B.client, "access.acceptInvitation", {
    invitationId: invitationB,
    verificationCode: INVITE_B,
  });
  check("S3 B accepted (real membership)", isOk(acceptedB), errCode(acceptedB));

  const invitedC = await invite(A.client, { email: SZEF_C, role: "member" });
  const invitationC = value(invitedC)?.invitationId;
  await anon().action("work/probe:c4ProofSetInvitationCode", { invitationId: invitationC, code: INVITE_C });
  C = await signInFixture(SZEF_C, SIGNIN_C);
  const acceptedC = await admit(C.client, "access.acceptInvitation", {
    invitationId: invitationC,
    verificationCode: INVITE_C,
  });
  check("S4 C accepted (real membership)", isOk(acceptedC), errCode(acceptedC));

  const view = await membershipView(A.client);
  membershipA = (view?.members ?? []).find((m) => m.isSelf)?.membershipId ?? null;
  membershipB = (view?.members ?? []).find((m) => m.email === SZEF_B)?.membershipId ?? null;
  row("membership A", membershipA);
  row("membership B", membershipB);
}

let projectId = null;
{
  const identified = await projects(A.client, "projects.identifyProject", {
    displayName: `Banan ${RUN}`,
    initialStage: "in_progress",
    clientId: null,
  });
  check("S5 project identified", isOk(identified), errCode(identified));
  projectId = value(identified)?.projectId ?? null;
}

// A witnessed source is the evidence basis for every finding below.
const seeded = await anon().action("work/probe:c4ProofSeedWitnessedSource", {
  sessionId: A.sessionId,
  acceptanceKey: `g2-${RUN}`,
  authorText: "Dostawa okien 15.10, odbiór rano, montaż od 2 do 5 listopada.",
});
const sourceId = seeded?.value?.sourceId ?? null;
const scope = { _tag: "project", projectId };

// Findings: agreed day (T1 deadline + shared by nothing), marker time for
// E1, internal range for T2, month precision for E2 (approximate).
const findingDay = await publishFinding(A.sessionId, sourceId, scope, `deadline.day.${RUN}`, temporalDay("2026-10-15", "agreed"));
const findingTime = await publishFinding(A.sessionId, sourceId, scope, `event.time.${RUN}`, temporalDateTime("2026-10-16T08:30:00.000+02:00[Europe/Warsaw]", "agreed"));
const findingRange = await publishFinding(A.sessionId, sourceId, scope, `montaz.range.${RUN}`, temporalRange("2026-11-02", "2026-11-05", "internal"));
const findingMonth = await publishFinding(A.sessionId, sourceId, scope, `event.month.${RUN}`, {
  _tag: "temporal",
  temporal: { shape: { _tag: "month", month: "2026-12" }, originalExpression: "grudzień", role: "agreed" },
});
row("findings published", "day/time/range/month (real C2 dispatch)");

// Work: E1 timed event; T1 unassigned task linked to E1 (deadline day);
// E2 month-precision event; T2 task coordinated by B (internal range).
let eventE1 = null;
let taskT1 = null;
let eventE2 = null;
let taskT2 = null;
{
  const e1 = await work(A.client, "work.changeEvent", {
    eventId: null,
    projectId,
    title: "Dostawa okien",
    timeFindingId: findingTime.findingId,
    expectedRevision: 1,
  });
  check("S6 event E1 (agreed 08:30 Warsaw time)", isOk(e1), errCode(e1));
  eventE1 = value(e1)?.eventId ?? null;

  const t1 = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId,
    title: "Odebrać dostawę okien",
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: findingDay.findingId,
    linkedEventId: eventE1,
    expectedRevision: 1,
  });
  check("S7 task T1 (unassigned, agreed day, linked to E1)", isOk(t1), errCode(t1));
  taskT1 = value(t1)?.taskId ?? null;

  const e2 = await work(A.client, "work.changeEvent", {
    eventId: null,
    projectId,
    title: "Kontrola montażu",
    timeFindingId: findingMonth.findingId,
    expectedRevision: 1,
  });
  check("S8 event E2 (month precision — approximate)", isOk(e2), errCode(e2));
  eventE2 = value(e2)?.eventId ?? null;

  const t2 = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId,
    title: "Montaż okien",
    executorContactId: null,
    coordinatorMembershipId: membershipB,
    deadlineFindingId: findingRange.findingId,
    expectedRevision: 1,
  });
  check("S9 task T2 (coordinated by B, internal range)", isOk(t2), errCode(t2));
  taskT2 = value(t2)?.taskId ?? null;
}

// --- Connections: A and B healthy; C's refresh will answer UNKNOWN -----------

const connectA = await connectCalendar(A, proofCode(1));
check("S10 A connected through the real OAuth flow (fake Google, sealed credentials)", connectA.ok, JSON.stringify(connectA));
const connectB = await connectCalendar(B, proofCode(2));
check("S11 B connected (own Google account)", connectB.ok, JSON.stringify(connectB));
// The !r-timeout suffix makes every later refresh of THIS connection stall:
// G1's capability answers `unknown`, which G2 must treat as
// "do not publish, do not retry blindly".
const connectC = await connectCalendar(C, `${proofCode(3)}!r-timeout`);
check("S12 C connected with an uncertain refresh future (!r-timeout)", connectC.ok, JSON.stringify(connectC));

// --- Phase 1: the first pass derives the desired copies ----------------------

let state = null;
let connA = null;
let connB = null;
let connC = null;
{
  const pass = await runPass();
  row("pass 1 (all connections)", JSON.stringify(value(pass)));
  state = await projectionState(companyId);
  connA = connectionBySubject(state, "proof-google-subject-1");
  connB = connectionBySubject(state, "proof-google-subject-2");
  connC = connectionBySubject(state, "proof-google-subject-3");

  // The shared lease accumulates earlier runs' connections; scope the
  // assertion to THIS run's three connections.
  const ownPasses = (value(pass) ?? []).filter((r) =>
    [connA?.connectionId, connB?.connectionId, connC?.connectionId].includes(r.connectionId),
  );
  check("1a pass reports one projected pass per healthy connection",
    ownPasses.filter((r) => r.outcome === "projected").length === 2 &&
      ownPasses.length === 3,
    JSON.stringify(ownPasses.map((r) => [r.outcome, r.suspensionReason])));

  const t1a = copiesOf(connA, taskT1);
  check("1b A's T1 copy desired: all-day on the agreed day, marker-free title",
    t1a.length === 1 && t1a[0]?.desiredState === "projected" &&
      t1a[0]?.start?.date === "2026-10-15" && t1a[0]?.end?.date === "2026-10-16" &&
      t1a[0]?.summary === "Zadanie: Odebrać dostawę okien",
    JSON.stringify(t1a.map((c) => [c.desiredState, c.start, c.end, c.summary])));

  const e1a = copiesOf(connA, eventE1);
  check("1c A's E1 copy desired: five-minute marker at the Warsaw instant",
    e1a.length === 1 && e1a[0]?.desiredState === "projected" &&
      e1a[0]?.start?.dateTime === "2026-10-16T06:30:00.000Z" &&
      e1a[0]?.end?.dateTime === "2026-10-16T06:35:00.000Z" &&
      e1a[0]?.summary === "Zdarzenie: Dostawa okien — godz. 08:30 (czas firmy)",
    JSON.stringify(e1a.map((c) => [c.start, c.end, c.summary])));
  check("1d the marker description explains the presentation, company time, project and link",
    (e1a[0]?.description ?? "").includes("pięciominutowy znacznik") &&
      (e1a[0]?.description ?? "").includes("nie ustalenie czasu pracy") &&
      (e1a[0]?.description ?? "").includes("czas firmy") &&
      (e1a[0]?.description ?? "").includes(`Banan ${RUN}`) &&
      (e1a[0]?.description ?? "").includes(`/co-teraz?zdarzenie=${eventE1}`),
    "description content checked");

  check("1e task and its linked event stay SEPARATE copies with distinct ids",
    t1a.length === 1 && e1a.length === 1 && t1a[0]?.semanticId !== e1a[0]?.semanticId,
    `${t1a[0]?.semanticId?.slice(-8)} vs ${e1a[0]?.semanticId?.slice(-8)}`);

  check("1f no copy for the month-precision event (approximations never export)",
    copiesOf(connA, eventE2).length === 0 && copiesOf(connB, eventE2).length === 0,
    "E2 absent everywhere");

  const t2a = copiesOf(connA, taskT2);
  const t2b = copiesOf(connB, taskT2);
  check("1g personal scope partitioning: B's coordinated T2 only for B",
    t2a.length === 0 && t2b.length === 1 && t2b[0]?.desiredState === "projected" &&
      t2b[0]?.start?.date === "2026-11-02" && t2b[0]?.end?.date === "2026-11-06",
    JSON.stringify({ aT2: t2a.length, bT2: t2b.length, span: [t2b[0]?.start?.date, t2b[0]?.end?.date] }));

  const t1b = copiesOf(connB, taskT1);
  const e1b = copiesOf(connB, eventE1);
  check("1h unassigned T1 and company event E1 project for BOTH bosses separately",
    t1b.length === 1 && e1b.length === 1 &&
      t1b[0]?.copyId !== t1a[0]?.copyId && e1b[0]?.copyId !== e1a[0]?.copyId &&
      t1a[0]?.semanticId !== t1b[0]?.semanticId,
    "own copy rows per boss");

  check("1i every new copy starts remoteOutcome unknown with no Google event id",
    [...(connA?.copies ?? []), ...(connB?.copies ?? [])].every(
      (c) => c.remoteOutcome === "unknown" && c.googleEventId === null,
    ),
    "unknown/absent for all");

  check("1j C's uncertain-refresh connection SUSPENDED: no desired-state writes at all",
    (connC?.copies ?? []).length === 0 && connC?.sync?.state === "needs_reconcile" &&
      connC?.sync?.suspendedReason === "refresh_unknown",
    JSON.stringify({ copies: (connC?.copies ?? []).length, sync: connC?.sync }));
}

// --- Phase 2: idempotence — a repeated pass writes nothing --------------------

{
  const snapshot = async () =>
    JSON.stringify((value(await projectionState(companyId))?.connections ?? []).map((c) => [
      c.connectionId,
      c.copies.map((p) => [p.copyId, p.desiredState, JSON.stringify(p.payload), p.updatedAtMs]),
    ]));
  const before = await snapshot();
  const pass = await runPass(connA.connectionId);
  const after = await snapshot();
  check("2a second pass over unchanged data: created 0, updated 0, rows byte-identical",
    value(pass)?.[0]?.created === 0 && value(pass)?.[0]?.updated === 0 && before === after,
    JSON.stringify(value(pass)?.[0]));
}

// --- Phase 3: a correction re-derives the desired copy ------------------------

{
  const corrected = await memory("memory.correctFinding", {
    findingId: findingDay.findingId,
    expectedRevision: 1,
    value: temporalDay("2026-10-20", "agreed"),
    knowledgeState: known,
    reason: "Klient przesunął dostawę",
  }, A.sessionId);
  check("3a deadline corrected through the REAL memory dispatch", isOk(corrected), errCode(corrected));

  await runPass(connA.connectionId);
  state = await projectionState(companyId);
  const conn = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  const t1 = copiesOf(conn, taskT1);
  check("3b the SAME copy row is updated to the corrected date (no duplicate)",
    t1.length === 1 && t1[0]?.start?.date === "2026-10-20" && t1[0]?.end?.date === "2026-10-21" &&
      t1[0]?.desiredRevisionId === value(corrected)?.revisionId,
    JSON.stringify({ start: t1[0]?.start, copies: t1.length }));
  const event3 = latestEventFor(state, t1[0]?.copyId);
  check("3c the canonical copyProjected event carries the FRESH derivation basis (not the pre-patch one)",
    event3 !== null && event3.desiredRevisionId === value(corrected)?.revisionId,
    JSON.stringify({ eventRevision: event3?.desiredRevisionId, rowRevision: t1[0]?.desiredRevisionId }));
}

// --- Phase 4: completion withdraws; reopen requalifies; hide survives ---------

let hiddenCopyId = null;
{
  // Hide A's E1 copy FIRST (personal decision), then withdraw T1 by state.
  const e1a = copiesOf(connectionsOf(await projectionState(companyId)).find((c) => c.connectionId === connA.connectionId), eventE1);
  hiddenCopyId = e1a[0]?.copyId ?? null;
  const hid = await setCopyHidden(A.client, hiddenCopyId, true);
  check("4a A hides the E1 copy through the certified dispatch", isOk(hid), errCode(hid));

  const t1Revision = await taskRevisionOf(A.client, taskT1);
  const done = await work(A.client, "work.changeTaskState", {
    taskId: taskT1,
    expectedRevision: t1Revision,
    state: "done",
  });
  check("4b T1 completed through the work dispatch", isOk(done), errCode(done));

  await runPass(connA.connectionId);
  state = await projectionState(companyId);
  const conn = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  const t1 = copiesOf(conn, taskT1);
  check("4c completion withdraws the copy desired state (payload cleared, row retained)",
    t1.length === 1 && t1[0]?.desiredState === "withdrawn" &&
      t1[0]?.withdrawReason === "subject_closed" && t1[0]?.summary === null,
    JSON.stringify(t1.map((c) => [c.desiredState, c.withdrawReason, c.summary])));

  const e1 = copiesOf(conn, eventE1);
  check("4d the hidden copy survives re-derivation hidden, still desired-projected",
    e1.length === 1 && e1[0]?.hidden === true && e1[0]?.hiddenOrigin === "user_request" &&
      e1[0]?.desiredState === "projected",
    JSON.stringify(e1.map((c) => [c.hidden, c.hiddenOrigin, c.desiredState])));

  // B's E1 copy is untouched by A's hide.
  const connB2 = connectionsOf(state).find((c) => c.connectionId === connB.connectionId);
  const e1b = copiesOf(connB2, eventE1);
  check("4e A's hide does not affect B's copy of the same event",
    e1b.length === 1 && e1b[0]?.hidden === false,
    JSON.stringify(e1b.map((c) => [c.hidden])));

  const reopened = await work(A.client, "work.changeTaskState", {
    taskId: taskT1,
    expectedRevision: await taskRevisionOf(A.client, taskT1),
    state: "todo",
  });
  check("4f T1 reopened", isOk(reopened), errCode(reopened));
  await runPass(connA.connectionId);
  state = await projectionState(companyId);
  const conn2 = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  const t1r = copiesOf(conn2, taskT1);
  check("4g reopen requalifies the SAME copy row (no new row, still hidden-independent)",
    t1r.length === 1 && t1r[0]?.desiredState === "projected" &&
      t1r[0]?.start?.date === "2026-10-20" && t1r[0]?.hidden === false,
    JSON.stringify(t1r.map((c) => [c.desiredState, c.start, c.hidden])));

  const restored = await setCopyHidden(A.client, hiddenCopyId, false);
  check("4h explicit restore clears the hide (only this path does)", isOk(restored), errCode(restored));
  state = await projectionState(companyId);
  const conn3 = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  check("4i the restored copy is unhidden with origin cleared",
    copiesOf(conn3, eventE1)[0]?.hidden === false &&
      copiesOf(conn3, eventE1)[0]?.hiddenOrigin === null,
    "restored");
}

// --- Phase 5: cross-tenant hide denial -----------------------------------------

{
  const denied = await setCopyHidden(B.client, hiddenCopyId, true);
  check("5a B cannot hide A's copy (not_found; no existence leak)",
    denied?._tag === "error" && denied.error._tag === "not_found",
    errCode(denied));
}

// --- Phase 6: an unresolved term withdraws the copy ----------------------------

{
  const unresolved = await memory("memory.correctFinding", {
    findingId: findingTime.findingId,
    expectedRevision: 1,
    value: temporalDateTime("2026-10-16T08:30:00.000+02:00[Europe/Warsaw]", "agreed"),
    knowledgeState: { _tag: "conflicted" },
    reason: "Dwie różne godziny w rozmowie",
  }, A.sessionId);
  check("6a event time marked conflicted (unresolved)", isOk(unresolved), errCode(unresolved));
  await runPass(connA.connectionId);
  state = await projectionState(companyId);
  const conn = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  const e1 = copiesOf(conn, eventE1);
  check("6b an unresolved term withdraws its copy with the machine reason",
    e1.length === 1 && e1[0]?.desiredState === "withdrawn" &&
      e1[0]?.withdrawReason === "term_unresolved",
    JSON.stringify(e1.map((c) => [c.desiredState, c.withdrawReason])));
}

// --- Phase 7: account switch re-mints the identity on the same rows -----------

{
  const switched = await connectCalendar(A, proofCode(4), "switch");
  check("7a A switched to a different Google account", switched.ok, JSON.stringify(switched));
  await runPass(connA.connectionId);
  state = await projectionState(companyId);
  const conn = connectionsOf(state).find((c) => c.connectionId === connA.connectionId);
  check("7b the switch re-mints semantic ids under the new account and resets the remote ledger",
    conn?.googleAccountSubject === "proof-google-subject-4" &&
      (conn?.copies ?? []).length > 0 &&
      conn.copies.every(
        (c) =>
          c.semanticId.includes("proof-google-subject-4") &&
          c.remoteOutcome === "unknown" &&
          c.googleEventId === null,
      ),
    JSON.stringify(conn?.copies?.map((c) => [c.semanticId.slice(-24), c.remoteOutcome])));
}

// --- Summary -------------------------------------------------------------------

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`\nSUMMARY | ${results.length - failed.length}/${results.length} PASS${failed.length === 0 ? "" : ` :: FAILED: ${failed.map((f) => f.id).join(", ")}`}`);
row("live Google legs", "BLOCKED-owner-action (real OAuth client credentials absent; fake endpoints only)");
process.exit(failed.length === 0 ? 0 : 1);
