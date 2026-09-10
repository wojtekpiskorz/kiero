/**
 * G5 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/g5).
 *
 * Output is sanitized: no tokens, no keys, no service credentials. Proof
 * persons use the reserved @kiero.invalid domain. The Google legs run
 * against the deployment's OWN clearly-labeled fake endpoints (G1's
 * guarded fake Google), because the real Google OAuth client credentials
 * are ABSENT, the same owner action B1/G1/G2/G3/G4 recorded. Every LIVE
 * REAL-Google leg stays BLOCKED-owner-action.
 *
 * Lease environment (names only; the dev lease snapshots guard variables
 * into module bundles at push time, so every variable below landed BEFORE
 * the recorded `npx convex dev --once` push): JWT_PRIVATE_KEY, JWKS (a
 * fresh dev keypair for this lease), KIERO_PROBE_ENABLED, KIERO_B3_PROOF_ENABLED,
 * KIERO_C4_PROOF_ENABLED, KIERO_G1_PROOF_ENABLED, KIERO_G2_PROOF_ENABLED,
 * KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE and
 * KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE (both pointing at the
 * deployment's own fake Google endpoints).
 *
 * What is proven live here is the certified project-selection seam end to
 * end (issue #107's three criteria): the exact read the /kalendarz scope
 * section consumes (projectionOverview's selection), the exact command it
 * issues (calendar.setSelection through the typed projection dispatch),
 * and the projection pass consuming the stored column:
 *
 *  G5-1  the PWA connect leg (mutation start + fake-Google callback) and
 *        the effective-selection read defaulting honestly to all projects
 *        with no stored column (criterion 2's read);
 *  G5-2  the projection pass projects both projects' unassigned tasks
 *        under the default (the baseline the narrowing is measured on);
 *  G5-3  setSelection explicit [P1] executes (criterion 1); the read
 *        carries the stored selection; the NEXT pass withdraws P2's copies
 *        with out_of_personal_scope and keeps P1's (criterion 2's pass);
 *  G5-4  setSelection back to all_projects; the next pass re-projects P2
 *        (the edit is live-provable in BOTH directions);
 *  G5-5  the honest opt-out: an empty explicit selection withdraws every
 *        copy on the next pass; restoring all projects re-projects them;
 *  G5-6  stale/foreign input fails closed exactly like the sibling
 *        calendar commands: another firm's project id and a malformed id
 *        are not_found with no existence leak and no row written,
 *        duplicated ids fail validation, and the stored selection is
 *        unchanged after every refusal (criterion 1's fail-closed half);
 *  G5-7  a boss without a connection row cannot scope anything
 *        (not_found), and a revoked membership stops the command and the
 *        read the same honest way G4 recorded.
 *
 * Run: node tests/g5/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_G5_DEPLOYMENT ?? "<set-by-coordinator>";
const URL_API = process.env.KIERO_G5_API_URL ?? `https://${DEPLOYMENT}.convex.cloud`;
const SITE = process.env.KIERO_G5_SITE_URL ?? `https://${DEPLOYMENT}.convex.site`;

const RUN = process.env.KIERO_G5_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `g5-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szef-a"); // firm owner, no calendar of their own
const SZEF_B = person("szef-b"); // the selection persona
const SZEF_R = person("szef-r"); // the revocation persona
const SZEF_F = person("szef-f"); // the OTHER firm's owner (foreign project)

const SIGNIN = Object.fromEntries(
  [["a", SZEF_A], ["b", SZEF_B], ["r", SZEF_R], ["f", SZEF_F]].map(
    ([k, email], i) => [k, { email, code: `${RUN}s${k}${i}` }],
  ),
);
const INVITE = { b: `ib${RUN}`, r: `ir${RUN}` };

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
const memory = (operation, input, sessionId) =>
  anon().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
const membershipView = (client) =>
  client.query("access/membership/functions:membershipOverview", {});
const currentFindings = (scope, sessionId) =>
  anon().action("memory/findings/probe:probeReadCurrentFindings", { scope, sessionId });

// The exact read the /kalendarz scope section consumes, and the exact
// command its editor issues.
const projectionOverview = (client) =>
  client.query("calendar/projection/functions:projectionOverview", {});
const dispatchProjection = (client, operation, input) =>
  client.mutation("calendar/projection/functions:dispatchCalendarProjection", { envelope: envelope(operation, input) });
const setSelection = (client, input) =>
  dispatchProjection(client, "calendar.setSelection", input);
const startAuthorization = (client, mode) =>
  client.mutation("calendar/connection/functions:startAuthorization", { mode });

const runProjectionPass = (connectionId) =>
  anon().action("calendar/projection/proof:g2ProofRunPass", { connectionId });
const projectionState = (companyId) =>
  anon().action("calendar/projection/proof:g2ProofProjectionState", { companyId });

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

/** One unassigned open task with a concrete agreed deadline (projects for every boss). */
async function seedTask(owner, sessionId, sourceId, projectId, semanticKey, title, day) {
  const finding = await publishFinding(
    sessionId,
    sourceId,
    { _tag: "project", projectId },
    semanticKey,
    temporalDay(day, "agreed"),
  );
  const task = await owner.client.mutation("work/functions:dispatchWork", {
    envelope: envelope("work.changeTask", {
      taskId: null,
      projectId,
      title,
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: finding.findingId,
      linkedEventId: null,
      expectedRevision: 1,
    }),
  });
  if (!isOk(task)) {
    throw new Error(`task ${title} failed: ${errCode(task)}`);
  }
  return value(task).taskId;
}

const connectionsOf = (state) => state?.connections ?? [];
const syncRowOf = (state, connectionId) => {
  const connection = connectionsOf(state).find((c) => c.connectionId === connectionId);
  return connection?.sync ?? null;
};

console.log(`# G5 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("site", SITE);
row("google client credentials", "ABSENT (owner action; G1 fixture client in proof mode)");
row("proof fixtures", "KIERO_[G1|G2|B3|C4]_PROOF_ENABLED on this lease only");

// --- Setup: firm 1 (A owner, B and R members, projects P1+P2), firm 2 (F) --

const A = await signInFixture(SIGNIN.a.email, SIGNIN.a.code);
row("szef A signed in", A.email);
let companyId = null;
{
  const created = await admit(A.client, "access.createCompany", {
    name: `Budowa G5 ${RUN}`,
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
  for (const key of ["b", "r"]) {
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

async function identifyProject(owner, displayName) {
  const identified = await owner.client.mutation("projects/functions:dispatchProjects", {
    envelope: envelope("projects.identifyProject", {
      displayName,
      initialStage: "in_progress",
      clientId: null,
    }),
  });
  if (!isOk(identified)) {
    throw new Error(`project ${displayName} failed: ${errCode(identified)}`);
  }
  return value(identified).projectId;
}

const project1 = await identifyProject(A, `Kaczmarek ${RUN}`);
const project2 = await identifyProject(A, `Nowak ${RUN}`);
row("projects", `P1=${project1} P2=${project2}`);

const seeded = await anon().action("work/probe:c4ProofSeedWitnessedSource", {
  sessionId: A.sessionId,
  acceptanceKey: `g5-${RUN}`,
  authorText: "Terminy: b1 5.10, b2 6.10 (P1); b3 7.10 (P2).",
});
const sourceId = seeded?.value?.sourceId ?? null;

const taskP1a = await seedTask(A, A.sessionId, sourceId, project1, `deadline.b1.${RUN}`, "Beton pod fundament", "2026-10-05");
const taskP1b = await seedTask(A, A.sessionId, sourceId, project1, `deadline.b2.${RUN}`, "Kupno stali", "2026-10-06");
const taskP2 = await seedTask(A, A.sessionId, sourceId, project2, `deadline.b3.${RUN}`, "Kontrola dachu", "2026-10-07");
row("tasks", `P1: ${taskP1a} ${taskP1b}; P2: ${taskP2} (all unassigned)`);

const B = members.bActor;
const R = members.rActor;
const proofCode = (tag, account) => `proof-code-${RUN}-${tag}-${account}`;

// The OTHER firm and its project (the foreign id G5-6 must refuse).
const F = await signInFixture(SIGNIN.f.email, SIGNIN.f.code);
let foreignCompanyId = null;
let foreignProject = null;
{
  const created = await admit(F.client, "access.createCompany", {
    name: `Obca firma G5 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  foreignCompanyId = value(created)?.companyId ?? null;
  foreignProject = await identifyProject(F, `Zagraniczna ${RUN}`);
  row("foreign firm", `company=${foreignCompanyId} project=${foreignProject}`);
}

// --- G5-1: connect + the honest default read (no stored column) -----------

const connectB = await connectViaPwa(B, proofCode("b", 5));
check("G5-1a B connected through the PWA start mutation + callback", connectB.ok, JSON.stringify(connectB));
let connectionId = null;
{
  const state = value(await projectionState(companyId));
  const connection = connectionsOf(state).find(
    (c) => c.googleAccountSubject === "proof-google-subject-5",
  );
  connectionId = connection?.connectionId ?? null;
  check("G5-1b the connection row exists with NO stored selection yet", connectionId !== null && syncRowOf(state, connectionId)?.selectedProjects == null, `sync=${JSON.stringify(syncRowOf(state, connectionId))}`);
}
{
  const projection = await projectionOverview(B.client);
  check(
    "G5-1c the effective-selection read defaults honestly to all projects",
    projection?.state === "connected" &&
      projection?.selection?.mode === "all_projects" &&
      projection?.selection?.projectIds === null,
    JSON.stringify(projection?.selection),
  );
}

// --- G5-2: the baseline pass (both projects' unassigned tasks) -------------

{
  const pass = await runProjectionPass(connectionId);
  check("G5-2a the projection pass ran", isOk(pass), errCode(pass));
  const projection = await projectionOverview(B.client);
  const ids = (projection?.copies ?? []).map((c) => c.subjectId);
  check(
    "G5-2b the default selection projects BOTH projects' tasks",
    ids.includes(taskP1a) && ids.includes(taskP1b) && ids.includes(taskP2) && ids.length === 3,
    `copies=${ids.length}`,
  );
}

// --- G5-3: narrow to P1; the read carries it; the pass honors it -----------

{
  const narrowed = await setSelection(B.client, { mode: "explicit", projectIds: [project1] });
  check("G5-3a setSelection explicit [P1] executes through the typed dispatch", isOk(narrowed), errCode(narrowed));
  if (isOk(narrowed)) {
    check(
      "G5-3b the result is the effective selection",
      value(narrowed)?.mode === "explicit" && JSON.stringify(value(narrowed)?.projectIds) === JSON.stringify([project1]),
      JSON.stringify(value(narrowed)),
    );
  }
  const projection = await projectionOverview(B.client);
  check(
    "G5-3c the read carries the stored selection",
    projection?.selection?.mode === "explicit" &&
      JSON.stringify(projection?.selection?.projectIds) === JSON.stringify([project1]),
    JSON.stringify(projection?.selection),
  );
  const state = value(await projectionState(companyId));
  check(
    "G5-3d the raw sync row stores exactly the selection",
    syncRowOf(state, connectionId)?.selectedProjects?.mode === "explicit",
    JSON.stringify(syncRowOf(state, connectionId)?.selectedProjects),
  );
  await runProjectionPass(connectionId);
  const after = await projectionOverview(B.client);
  const rowOf = (subjectId) => (after?.copies ?? []).find((c) => c.subjectId === subjectId) ?? null;
  check(
    "G5-3e the next pass KEEPS P1's copies and WITHDRAWS P2's with out_of_personal_scope",
    rowOf(taskP1a)?.desiredState === "projected" &&
      rowOf(taskP1b)?.desiredState === "projected" &&
      rowOf(taskP2)?.desiredState === "withdrawn" &&
      rowOf(taskP2)?.withdrawReason === "out_of_personal_scope",
    JSON.stringify({
      p1a: rowOf(taskP1a)?.desiredState,
      p1b: rowOf(taskP1b)?.desiredState,
      p2: [rowOf(taskP2)?.desiredState, rowOf(taskP2)?.withdrawReason],
    }),
  );
}

// --- G5-4: back to all projects; P2 re-projects ----------------------------

{
  const widened = await setSelection(B.client, { mode: "all_projects" });
  check("G5-4a setSelection all_projects executes", isOk(widened), errCode(widened));
  await runProjectionPass(connectionId);
  const after = await projectionOverview(B.client);
  const rowOf = (subjectId) => (after?.copies ?? []).find((c) => c.subjectId === subjectId) ?? null;
  check(
    "G5-4b the next pass re-projects P2's copy (the edit is bidirectional)",
    rowOf(taskP2)?.desiredState === "projected",
    JSON.stringify(rowOf(taskP2)?.desiredState),
  );
}

// --- G5-5: the honest opt-out (empty explicit) ------------------------------

{
  const optOut = await setSelection(B.client, { mode: "explicit", projectIds: [] });
  check("G5-5a the empty explicit selection is accepted", isOk(optOut), errCode(optOut));
  const projection = await projectionOverview(B.client);
  check(
    "G5-5b the read carries the empty list (never a silent all-projects)",
    projection?.selection?.mode === "explicit" && (projection?.selection?.projectIds ?? []).length === 0,
    JSON.stringify(projection?.selection),
  );
  await runProjectionPass(connectionId);
  const after = await projectionOverview(B.client);
  const allWithdrawn = (after?.copies ?? []).every(
    (c) => c.desiredState === "withdrawn" && c.withdrawReason === "out_of_personal_scope",
  );
  check("G5-5c the next pass withdraws every copy", allWithdrawn, `rows=${(after?.copies ?? []).length}`);
  await setSelection(B.client, { mode: "all_projects" });
  await runProjectionPass(connectionId);
  const restored = await projectionOverview(B.client);
  const allBack = (restored?.copies ?? []).every((c) => c.desiredState === "projected");
  check("G5-5d restoring all projects re-projects everything", allBack, `rows=${(restored?.copies ?? []).length}`);
}

// --- G5-6: stale/foreign input fails closed (the sibling discipline) -------

{
  const before = JSON.stringify((await projectionOverview(B.client))?.selection);
  const foreign = await setSelection(B.client, { mode: "explicit", projectIds: [foreignProject] });
  check(
    "G5-6a another firm's project id is not_found (no existence leak)",
    !isOk(foreign) && foreign?.error?._tag === "not_found",
    errCode(foreign),
  );
  const malformed = await setSelection(B.client, { mode: "explicit", projectIds: ["not-a-convex-id"] });
  check(
    "G5-6b a malformed project id is not_found",
    !isOk(malformed) && malformed?.error?._tag === "not_found",
    errCode(malformed),
  );
  const duplicated = await setSelection(B.client, {
    mode: "explicit",
    projectIds: [project1, project1],
  });
  const duplicatedKind = duplicated?._tag === "error" ? duplicated.error._tag : "ok";
  check(
    "G5-6c duplicated project ids fail validation",
    !isOk(duplicated) && duplicatedKind === "validation",
    `${duplicatedKind}:${errCode(duplicated)}`,
  );
  const after = JSON.stringify((await projectionOverview(B.client))?.selection);
  check("G5-6d every refusal left the stored selection unchanged", before === after, `${before} -> ${after}`);
}

// --- G5-7: no connection / revoked membership -------------------------------

{
  const noConnection = await setSelection(A.client, { mode: "all_projects" });
  check(
    "G5-7a a boss without a connection row cannot scope anything (not_found)",
    !isOk(noConnection) && noConnection?.error?._tag === "not_found",
    errCode(noConnection),
  );

  const connectR = await connectViaPwa(R, proofCode("r", 6));
  check("G5-7b R connected before revocation", connectR.ok, JSON.stringify(connectR));
  const accepted = await setSelection(R.client, { mode: "explicit", projectIds: [project2] });
  check("G5-7c R's selection executes before revocation", isOk(accepted), errCode(accepted));
  const revoked = await dispatchMembership(A.client, "access.revokeMembership", { membershipId: members.r });
  check("G5-7d membership revoked", isOk(revoked), errCode(revoked));
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
    return `data:${JSON.stringify(result).slice(0, 120)}`;
  };
  const staleSelection = await rejectionOf(() =>
    setSelection(R.client, { mode: "all_projects" }),
  );
  check(
    "G5-7e the stale selection command is rejected (no live company context)",
    staleSelection !== "accepted" && /unauthenticated|no_live_session|no_verified_identity/.test(staleSelection),
    staleSelection,
  );
  const readForm = await rejectionOf(() => projectionOverview(R.client));
  check(
    "G5-7f the selection read honestly stops for the revoked boss",
    /no_live_session|no_verified_identity|unavailable_no_company|membership_lost|zaloguj/i.test(readForm),
    readForm.slice(0, 160),
  );
}

// --- Summary -----------------------------------------------------------------

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(
  `# G5 summary: ${results.length - failed.length}/${results.length} PASS` +
    (failed.length > 0 ? `; FAILED: ${failed.map((f) => f.id).join(", ")}` : ""),
);
process.exitCode = failed.length > 0 ? 1 : 0;
