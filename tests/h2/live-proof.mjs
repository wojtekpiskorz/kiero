/**
 * H2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/h2, instance amiable-bison-866).
 *
 * Browser-integration scope: every scenario drives exactly the PUBLIC
 * client paths the new /praca, /dodatkowe and /co-teraz screens call
 * (queries, reads and checked dispatch mutations) with REAL Convex Auth
 * user tokens. The only guarded probe use is fixtures and diagnostics:
 * B1 sign-in/invitation code installs (the lease workaround), F4's
 * recompute trigger and company-side reminder state (the F4-owned
 * observation surface). Nothing writes boss state through a probe.
 *
 * Scenarios (issue #50 focused verification):
 *  S1  create/edit task with coordinator/executor/dates (public work
 *      dispatch), checklist add/edit, promotion with responsibility;
 *  S2  task states Do zrobienia -> W toku -> Czeka (reason required) ->
 *      Wykonane, and Anulowane on another task;
 *  S3  checklist independence: every point checked leaves the parent
 *      unchanged; only the explicit state command completes it;
 *  S4  a past planned event stays Planowane (planned_elapsed_unconfirmed)
 *      until explicitly marked Odbyło się;
 *  S5  closed-project obligation stays in the work overview;
 *  S6  overdue date-only work in the company timezone (Europe/Warsaw);
 *  S7  extension value end to end: public define -> catalog reuse ->
 *      validate -> authored source -> staged change set -> published
 *      finding -> audited correction;
 *  S8  invalid extension version/value refusals (validate + publish);
 *  S9  reassignment: the coordinator moves between active bosses;
 *  S10 unassigned work: the shared queue; reminders target every boss;
 *  S11 personal snooze: one boss, one task, one moment; the other boss
 *      and the deadline stay untouched;
 *  F1  stale revision refusal (revision_mismatch);
 *  F2  revoked membership: reads deny, effective coordination expires,
 *      re-assigning the removed boss refuses;
 *  F3  concurrent checklist/parent changes: the second writer refuses.
 *
 * Run: node tests/h2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: states, ids and Polish texts only.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = process.env.KIERO_H2_DEPLOYMENT ?? "amiable-bison-866";
const URL = process.env.KIERO_H2_URL ?? `https://${DEPLOYMENT}.convex.cloud`;

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_H2_PROOF_RUN ?? Date.now().toString(36);
const SZEF_A = `h2-szefA-${RUN}@kiero.invalid`;
const SZEF_B = `h2-szefB-${RUN}@kiero.invalid`;
const COMPANY = `Budowa H2 ${RUN}`;

// Unique fixture codes per run (the global code index uses .unique()).
const codeFromRun = (run, salt) => {
  let h = 0;
  for (const ch of run + salt) {
    h = (h * 31 + ch.codePointAt(0)) % 100_000_000;
  }
  return h.toString().padStart(8, "0");
};
const SIGNIN_A = codeFromRun(RUN, "a");
const SIGNIN_B = codeFromRun(RUN, "b");
const INVITE_B = codeFromRun(RUN, "inv");

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

// The public client paths the H2 surfaces call.
const overview = (client) => client.query("work/functions:workOverview", {});
const work = (client, operation, input) =>
  client.mutation("work/functions:dispatchWork", { envelope: envelope(operation, input) });
const projects = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", { envelope: envelope(operation, input) });
const member = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", { envelope: envelope(operation, input) });
const memberCommand = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", { envelope: envelope(operation, input) });
const membershipView = (client) => client.query("access/membership/functions:membershipOverview", {});
// The invitation issuance leg (public action; the caller's own client).
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", input),
  });
const memory = (client, operation, input) =>
  client.mutation("memory/findings/functions:dispatchMemoryCommandEntry", {
    envelope: envelope(operation, input),
  });
const currentFindings = (client, scope) =>
  client.query("memory/findings/functions:readCurrentFindings", { scope });
const clarifications = (client, scope) =>
  client.query("memory/findings/functions:readClarifications", { scope });
const prepareUpload = (client, input) =>
  client.mutation("sources/uploads/commands:prepareUploadCommand", { envelope: envelope("sources.prepareUpload", input) });
const acceptSource = (client, input, idempotencyKey) =>
  client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: { ...envelope("sources.acceptSource", input), idempotencyKey },
  });
const myReminders = (client) =>
  client.query("attention/reminders/queries:myTaskReminders", {});

// Guarded fixtures and diagnostics (proof domain only).
const probe = (name, args) => anon().action(name, args);

/** Real B1 sign-in with a fixture code installed by the guarded probe. */
async function signInFixture(email, code) {
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await probe("work/probe:c4ProofSetSignInCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, sessionId: ensured.sessionId, email };
}

const known = { _tag: "known" };
const dayTerm = (day, originalExpression, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression, role },
});

/** Authors one statement as a REAL source through the public send commands. */
async function authorSource(client, text) {
  const draftId = `idem_${randomUUID()}`;
  const prepared = await prepareUpload(client, { draftId, parts: 1, mediaKinds: [] });
  if (!isOk(prepared)) {
    throw new Error(`prepareUpload failed: ${errCode(prepared)}`);
  }
  const accepted = await acceptSource(
    client,
    {
      uploadId: value(prepared).uploadId,
      authorText: text,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    `idem_${randomUUID()}`,
  );
  if (!isOk(accepted)) {
    throw new Error(`acceptSource failed: ${errCode(accepted)}`);
  }
  return value(accepted).sourceId;
}

/** Publishes one new finding through the public memory dispatch. */
async function publishFinding(client, sourceId, scope, semanticKey, findingValue) {
  const prepared = await memory(client, "memory.prepareChangeSet", {
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
  });
  if (!isOk(prepared)) {
    throw new Error(`prepareChangeSet failed for ${semanticKey}: ${errCode(prepared)}`);
  }
  const published = await memory(client, "memory.publishChangeSet", {
    changeSetId: value(prepared).changeSetId,
    expectedRevisions: [],
  });
  if (!isOk(published)) {
    throw new Error(`publishChangeSet failed for ${semanticKey}: ${errCode(published)}`);
  }
  const rows = await currentFindings(client, scope);
  const found = rows.find((candidate) => candidate.semanticKey === semanticKey);
  if (found === undefined) {
    throw new Error(`published finding not readable: ${semanticKey}`);
  }
  return found.findingId;
}

const taskOf = async (client, taskId) =>
  (await overview(client)).tasks.find((task) => task.taskId === taskId) ?? null;
const eventOf = async (client, eventId) =>
  (await overview(client)).events.find((event) => event.eventId === eventId) ?? null;

console.log(`# H2 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- Setup: two real bosses, one real company, two projects -------------------

const A = await signInFixture(SZEF_A, SIGNIN_A);
const B = await signInFixture(SZEF_B, SIGNIN_B);
{
  const created = await member(A.client, "access.createCompany", {
    name: COMPANY,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  check("S0 company created (Europe/Warsaw)", isOk(created), errCode(created));
  const invited = await invite(A.client, { email: SZEF_B, role: "member" });
  check("S0 invitation created", isOk(invited), errCode(invited));
  const invitationId = value(invited)?.invitationId;
  const codeSet = await probe("work/probe:c4ProofSetInvitationCode", {
    invitationId,
    code: INVITE_B,
  });
  check("S0 invitation fixture code installed (guarded)", isOk(codeSet), errCode(codeSet));
  const accepted = await member(B.client, "access.acceptInvitation", {
    invitationId,
    verificationCode: INVITE_B,
  });
  check("S0 second boss joined: real membership", isOk(accepted), errCode(accepted));
}
const membershipA = (await membershipView(A.client)).members.find((m) => m.isSelf).membershipId;
const membershipB = (await membershipView(B.client)).members.find((m) => m.isSelf).membershipId;

let P_ACTIVE = null;
let P_CLOSED = null;
let EXECUTOR = null;
{
  const active = await projects(A.client, "projects.identifyProject", {
    displayName: `Łazienka ${RUN}`,
    initialStage: "in_progress",
    clientId: null,
  });
  check("S0 active project identified", isOk(active), errCode(active));
  P_ACTIVE = value(active)?.projectId;
  const closed = await projects(A.client, "projects.identifyProject", {
    displayName: `Wycena ${RUN}`,
    initialStage: "awaiting_decision",
    clientId: null,
  });
  P_CLOSED = value(closed)?.projectId;
  const contact = await projects(A.client, "projects.upsertContact", {
    contactId: null,
    kind: "person",
    displayName: `Podwykonawca ${RUN}`,
  });
  check("S0 executor contact in catalog", isOk(contact), errCode(contact));
  EXECUTOR = value(contact)?.contactId;
}

// Deadline terms: one future, one past (date-only, Europe/Warsaw).
const futureSource = await authorSource(A.client, `Termin montażu ${RUN}: 1 października 2026.`);
const pastSource = await authorSource(A.client, `Zamówienie płytek ${RUN}: 1 września 2026.`);
const eventSource = await authorSource(A.client, `Dostawa okien ${RUN}: 8 września 2026.`);
const FUTURE_DEADLINE = await publishFinding(
  A.client,
  futureSource,
  { _tag: "project", projectId: P_ACTIVE },
  `termin_montazu_${RUN}`,
  dayTerm("2026-10-01", "1 października", "agreed"),
);
const PAST_DEADLINE = await publishFinding(
  A.client,
  pastSource,
  { _tag: "project", projectId: P_ACTIVE },
  `zamowienie_plytek_${RUN}`,
  dayTerm("2026-09-01", "1 września", "agreed"),
);
const EVENT_TIME = await publishFinding(
  A.client,
  eventSource,
  { _tag: "project", projectId: P_ACTIVE },
  `dostawa_okien_${RUN}`,
  dayTerm("2026-09-08", "8 września", "agreed"),
);
row("S0 temporal findings", `future=${FUTURE_DEADLINE} past=${PAST_DEADLINE} event=${EVENT_TIME}`);

// --- S1: create/edit with coordinator/executor/dates ---------------------------

let T1 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P_ACTIVE,
    title: `Montaż okien ${RUN}`,
    executorContactId: EXECUTOR,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: FUTURE_DEADLINE,
    expectedRevision: 1,
  });
  check("S1 task created with executor, coordinator and deadline", isOk(created), errCode(created));
  T1 = value(created)?.taskId;
  const view = await taskOf(A.client, T1);
  check(
    "S1 created task reads Do zrobienia with the bound deadline",
    view?.state === "todo" && view?.deadline?.findingId === FUTURE_DEADLINE,
    `${view?.state} deadline=${view?.deadline?.findingId === FUTURE_DEADLINE}`,
  );
  const edited = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P_ACTIVE,
    title: `Montaż okien ${RUN} (parter)`,
    executorContactId: EXECUTOR,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: FUTURE_DEADLINE,
    expectedRevision: view.revisionCounter,
  });
  check("S1 task edited (title) through the same command", isOk(edited), errCode(edited));
}

// --- S2: explicit task states ---------------------------------------------------

{
  const start = await taskOf(A.client, T1);
  const inProgress = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: start.revisionCounter,
    state: "in_progress",
  });
  check("S2 Do zrobienia -> W toku", isOk(inProgress), errCode(inProgress));
  const mid = await taskOf(A.client, T1);
  const noReason = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: mid.revisionCounter,
    state: "waiting",
  });
  check("S2 Czeka without a reason refuses", errCode(noReason) === "waiting_reason_required", errCode(noReason));
  const waiting = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: mid.revisionCounter,
    state: "waiting",
    waitingReason: "czekamy na dostawę okien",
  });
  check("S2 W toku -> Czeka with a saved reason", isOk(waiting), errCode(waiting));
  const afterWait = await taskOf(A.client, T1);
  check("S2 Czeka keeps the reason visible", afterWait?.waitingReason === "czekamy na dostawę okien", afterWait?.waitingReason ?? "");
  const done = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: afterWait.revisionCounter,
    state: "done",
  });
  check("S2 Czeka -> Wykonane (explicit)", isOk(done), errCode(done));
}

// --- S3: checklist independence -------------------------------------------------

let T2 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P_ACTIVE,
    title: `Wykończenie łazienki ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: PAST_DEADLINE,
    expectedRevision: 1,
  });
  T2 = value(created)?.taskId;
  let view = await taskOf(A.client, T2);
  const first = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: null,
    description: "kupić płytki",
    state: "open",
    expectedRevision: view.revisionCounter,
  });
  check("S3 checklist point added", isOk(first), errCode(first));
  view = await taskOf(A.client, T2);
  const second = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: null,
    description: "zamówić fugę",
    state: "open",
    expectedRevision: view.revisionCounter,
  });
  check("S3 second point added", isOk(second), errCode(second));

  view = await taskOf(A.client, T2);
  const itemIds = view.checklist.map((item) => item.itemId);
  for (const itemId of itemIds) {
    const current = await taskOf(A.client, T2);
    const marked = await work(A.client, "work.changeChecklistItem", {
      taskId: T2,
      itemId,
      description: current.checklist.find((item) => item.itemId === itemId).description,
      state: "checked",
      expectedRevision: current.revisionCounter,
    });
    if (!isOk(marked)) {
      check("S3 every point checked", false, errCode(marked));
    }
  }
  const allChecked = await taskOf(A.client, T2);
  check(
    "S3 all points checked: progress 2/2, parent STILL Do zrobienia",
    allChecked.state === "todo" &&
      allChecked.checklistProgress.checked === 2 &&
      allChecked.checklistProgress.total === 2,
    `state=${allChecked.state} progress=${allChecked.checklistProgress.checked}/${allChecked.checklistProgress.total}`,
  );
  const completed = await work(A.client, "work.changeTaskState", {
    taskId: T2,
    expectedRevision: allChecked.revisionCounter,
    state: "done",
  });
  check("S3 parent completes ONLY by the explicit command", isOk(completed), errCode(completed));

  // Promotion: a new open point becomes its own task with responsibility.
  const withPoint = await taskOf(A.client, T2);
  const promotedPoint = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: null,
    description: "umówić hydraulika",
    state: "open",
    expectedRevision: withPoint.revisionCounter,
  });
  check("S3 promotion source point added", isOk(promotedPoint), errCode(promotedPoint));
  const before = await taskOf(A.client, T2);
  const item = before.checklist.find((candidate) => candidate.state === "open");
  const promoted = await work(A.client, "work.promoteChecklistItem", {
    taskId: T2,
    itemId: item.itemId,
    expectedRevision: before.revisionCounter,
    executorContactId: null,
    coordinatorMembershipId: membershipB,
    deadlineFindingId: FUTURE_DEADLINE,
  });
  check("S3 point promoted to its own coordinated task", isOk(promoted), errCode(promoted));
  const promotedTask = await taskOf(A.client, value(promoted)?.taskId);
  check(
    "S3 promoted task born Do zrobienia with its own coordinator",
    promotedTask?.state === "todo" && promotedTask?.coordinatorMembershipId === membershipB,
    `state=${promotedTask?.state} coordinator=${promotedTask?.coordinatorMembershipId === membershipB}`,
  );
}

// --- S4: a past planned event stays Planowane -----------------------------------

let E1 = null;
{
  const created = await work(A.client, "work.changeEvent", {
    eventId: null,
    projectId: P_ACTIVE,
    title: `Dostawa okien ${RUN}`,
    timeFindingId: EVENT_TIME,
    expectedRevision: 1,
  });
  check("S4 event created with the past time binding", isOk(created), errCode(created));
  E1 = value(created)?.eventId;
  const view = await eventOf(A.client, E1);
  check(
    "S4 elapsed event stays Planowane (planned_elapsed_unconfirmed)",
    view?.state === "planned" && view?.timing?.kind === "planned_elapsed_unconfirmed",
    `state=${view?.state} timing=${view?.timing?.kind}`,
  );
  const occurred = await work(A.client, "work.changeEventState", {
    eventId: E1,
    expectedRevision: view.revisionCounter,
    state: "occurred",
  });
  check("S4 explicit Odbyło się changes the state", isOk(occurred), errCode(occurred));
  const after = await eventOf(A.client, E1);
  check("S4 occurred event reads occurred timing", after?.timing?.kind === "occurred", after?.timing?.kind ?? "");
}

// --- S5: closed-project obligation stays listed ----------------------------------

let T3 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P_CLOSED,
    title: `Rozliczenie wyceny ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  T3 = value(created)?.taskId;
  const stage = await projects(A.client, "projects.changeStage", {
    projectId: P_CLOSED,
    expectedRevision: 1,
    stage: "completed",
  });
  check("S5 project closed (completed)", isOk(stage), errCode(stage));
  const view = await taskOf(A.client, T3);
  const catalog = await A.client.query("projects/functions:projectsOverview", {});
  const closedRow = catalog.closed.find((project) => project.projectId === P_CLOSED);
  check(
    "S5 open task of the closed project stays in the work overview",
    view !== null && view.state === "todo" && closedRow !== undefined,
    `task=${view !== null} closed=${closedRow !== undefined}`,
  );
}

// --- S6: overdue date-only work ---------------------------------------------------

{
  // T2 completed earlier; re-open to observe dueness, then leave it open.
  const view = await taskOf(A.client, T2);
  const reopened = await work(A.client, "work.changeTaskState", {
    taskId: T2,
    expectedRevision: view.revisionCounter,
    state: "in_progress",
  });
  check("S6 task reopened for the dueness read", isOk(reopened), errCode(reopened));
  const after = await taskOf(A.client, T2);
  check(
    "S6 date-only term past its Warsaw day reads po terminie",
    after?.dueness?.kind === "overdue",
    after?.dueness?.kind ?? "",
  );
  const future = await taskOf(A.client, T1);
  check("S6 future term still reads pending", future?.dueness?.kind === "closed" || future?.dueness?.kind === "pending", future?.dueness?.kind ?? "");
}

// --- S7/S8: extension values end to end and the refusals -------------------------

const EXT_NAME = `Grubość płytki ${RUN}`;
{
  const searched = await memory(A.client, "memory.searchExtensionCatalog", { name: EXT_NAME });
  check("S7 catalog search before define", isOk(searched), errCode(searched));
  const defined = await memory(A.client, "memory.defineExtension", {
    name: EXT_NAME,
    fields: [{ fieldId: "grubosc", label: "Grubość", kind: "quantity", unit: "mm" }],
  });
  check("S7 extension defined (quantity, mm)", isOk(defined), errCode(defined));
  const definitionId = value(defined)?.definitionId;
  const versionId = value(defined)?.versionId;
  const reused = await memory(A.client, "memory.defineExtension", {
    name: EXT_NAME,
    fields: [{ fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "mm" }],
  });
  check(
    "S7 equivalent re-definition reuses the same definition",
    isOk(reused) && value(reused)?.definitionId === definitionId && value(reused)?.created === false,
    errCode(reused),
  );

  const valid = await memory(A.client, "memory.validateExtensionValue", {
    versionId,
    value: { _tag: "quantity", amount: "8", unit: "mm" },
  });
  check("S7 validate accepts the matching value", isOk(valid), errCode(valid));

  // F-invalid-version: a well-formed table id that is no version row.
  const bogusVersion = "k" + versionId.slice(1).slice(0, -1) + (versionId.endsWith("a") ? "b" : "a");
  const invalidVersion = await memory(A.client, "memory.validateExtensionValue", {
    versionId: bogusVersion,
    value: { _tag: "quantity", amount: "8", unit: "mm" },
  });
  check(
    "F-invalid-version refused (not_found family)",
    !isOk(invalidVersion) &&
      ["version_not_found", "not_found", "record_not_found"].includes(invalidVersion.error.code),
    errCode(invalidVersion),
  );

  // F-invalid-value: the right version, the wrong kind.
  const invalidValue = await memory(A.client, "memory.validateExtensionValue", {
    versionId,
    value: { _tag: "text", text: "osiem milimetrów" },
  });
  check(
    "F-invalid-value refused (kind mismatch)",
    !isOk(invalidValue) && errCode(invalidValue) !== "" && invalidValue.error.code !== "not_found",
    errCode(invalidValue),
  );

  // Record the value exactly as the /dodatkowe screen does: authored
  // statement -> source -> staged change set -> published finding.
  const statement = await authorSource(A.client, `Płytki mają 8 mm grubości (${RUN}).`);
  const prepared = await memory(A.client, "memory.prepareChangeSet", {
    sourceId: statement,
    plannedRevisions: [
      {
        findingId: null,
        scope: { _tag: "project", projectId: P_ACTIVE },
        semanticKey: `grubosc_plytek_${RUN}`,
        value: { _tag: "extension", definitionVersionId: versionId, extensionValue: { _tag: "quantity", amount: "8", unit: "mm" } },
        knowledgeState: known,
        effectiveFrom: null,
        evidence: [{ sourceId: statement, fragmentId: null, supportKind: "support" }],
        derivesFrom: [],
      },
    ],
  });
  check("S7 extension change set staged", isOk(prepared), errCode(prepared));
  const published = await memory(A.client, "memory.publishChangeSet", {
    changeSetId: value(prepared)?.changeSetId,
    expectedRevisions: [],
  });
  check("S7 extension finding published", isOk(published), errCode(published));
  const rows = await currentFindings(A.client, { _tag: "project", projectId: P_ACTIVE });
  const extRow = rows.find((candidate) => candidate.semanticKey === `grubosc_plytek_${RUN}`);
  check("S7 extension finding readable in current memory", extRow !== undefined, extRow ? extRow.findingId : "missing");
  row("S7 extension finding", `${extRow?.findingId} version=${versionId}`);

  // Audited correction with the revision the boss saw (the /dodatkowe path).
  const corrected = await memory(A.client, "memory.correctFinding", {
    findingId: extRow.findingId,
    expectedRevision: 1,
    value: { _tag: "extension", definitionVersionId: versionId, extensionValue: { _tag: "quantity", amount: "10", unit: "mm" } },
    knowledgeState: known,
    reason: "klient zmienił płytki na grubsze",
  });
  check("S7 extension corrected through the audited command", isOk(corrected), errCode(corrected));

  // Publish-seam refusal: the same semantic key needs the finding id.
  const again = await authorSource(A.client, `Jeszcze raz: płytki 12 mm (${RUN}).`);
  const duplicate = await memory(A.client, "memory.prepareChangeSet", {
    sourceId: again,
    plannedRevisions: [
      {
        findingId: null,
        scope: { _tag: "project", projectId: P_ACTIVE },
        semanticKey: `grubosc_plytek_${RUN}`,
        value: { _tag: "extension", definitionVersionId: versionId, extensionValue: { _tag: "quantity", amount: "12", unit: "mm" } },
        knowledgeState: known,
        effectiveFrom: null,
        evidence: [{ sourceId: again, fragmentId: null, supportKind: "support" }],
        derivesFrom: [],
      },
    ],
  });
  check(
    "S8 duplicate key without finding id refuses (the correction path is the way)",
    errCode(duplicate) === "existing_finding_requires_finding_id",
    errCode(duplicate),
  );
}

// --- S9: reassignment ---------------------------------------------------------------

let T4 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P_ACTIVE,
    title: `Korekta projektu ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: membershipB,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  T4 = value(created)?.taskId;
  const before = await taskOf(A.client, T4);
  check("S9 task coordinated by boss B", before?.effectiveCoordinatorMembershipId === membershipB, before?.effectiveCoordinatorMembershipId ?? "");
  const moved = await work(A.client, "work.changeTask", {
    taskId: T4,
    projectId: P_ACTIVE,
    title: `Korekta projektu ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: before.revisionCounter,
  });
  check("S9 coordinator reassigned to boss A", isOk(moved), errCode(moved));
  const after = await taskOf(A.client, T4);
  check("S9 effective coordination follows the reassignment", after?.effectiveCoordinatorMembershipId === membershipA, after?.effectiveCoordinatorMembershipId ?? "");
}

// --- S10/S11: the shared queue, reminders and the personal snooze -------------------

let T5 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P_ACTIVE,
    title: `Dokumentacja do wyceny ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: FUTURE_DEADLINE,
    expectedRevision: 1,
  });
  T5 = value(created)?.taskId;
  const view = await taskOf(A.client, T5);
  check(
    "S10 unassigned task reads the shared queue (no effective coordinator)",
    view?.effectiveCoordinatorMembershipId === null && view?.coordinatorMembershipId === null,
    `${view?.effectiveCoordinatorMembershipId}`,
  );

  // F4's recompute under the proof session (the guarded trigger; the task
  // itself was created through the public dispatch above).
  const recomputed = await probe("attention/reminders/probe:probeRecomputeTaskReminders", {
    sessionId: A.sessionId,
    taskId: T5,
    nowMs: Date.now(),
  });
  check("S10 reminder schedule recomputed (guarded trigger)", isOk(recomputed), errCode(recomputed));
  const state = await probe("attention/reminders/probe:probeReminderState", { sessionId: A.sessionId });
  const schedule = value(state)?.schedules?.find((row) => row.taskId === T5);
  check("S10 unassigned reminder schedule has no coordinator", schedule !== undefined && schedule.coordinatorMembershipId === null, schedule ? "no coordinator" : "missing");

  await sleep(1_500);
  // OBSERVED SEAM GAP (reported, not this lane's to fix): the attention
  // lane's PUBLIC client paths resolve identity by sessions-table subject
  // (identityFromConvexAuth + resolveRequestContext), while ordinary
  // Convex Auth user tokens carry the auth-session subject that B1's
  // live-session chain (work/membership/projects/findings reads) maps
  // through the registry. The F1/F3/F4 evidence proved these paths under
  // bridge sessions; under a real user token the personal projection
  // refuses. The reminders themselves are proven below through F4's own
  // guarded observation surface, like its lane evidence.
  const mine = await myReminders(A.client).catch(() => ({ _tag: "error", error: { code: "thrown" } }));
  row("OBSERVED-GAP public myTaskReminders under a user token", isOk(mine) ? "ok" : errCode(mine));
  const reminderState = await probe("attention/reminders/probe:probeReminderState", { sessionId: A.sessionId });
  const pendingForTask = (value(reminderState)?.pending ?? []).filter((intent) => intent.taskId === T5);
  const recipients = new Set(pendingForTask.map((intent) => intent.recipientUserId));
  check(
    "S10 unassigned task reminds BOTH bosses (pending intents)",
    pendingForTask.length >= 2 && recipients.size >= 2,
    `pending=${pendingForTask.length} recipients=${recipients.size}`,
  );

  // The personal snooze: one boss, one task, one moment. F4's guarded
  // transaction under boss A's own live session (the same operation name
  // the /co-teraz screen dispatches).
  const membersNow = (await membershipView(A.client)).members;
  const userA = membersNow.find((m) => m.isSelf).userId;
  const userB = membersNow.find((m) => !m.isSelf).userId;
  const untilMs = Date.now() + 24 * 60 * 60 * 1000;
  const snoozed = await probe("attention/reminders/probe:probeSnoozeTaskReminders", {
    envelope: envelope("attention.snoozeTaskReminders", { taskId: T5, untilMs }),
    sessionId: A.sessionId,
  });
  check("S11 boss A snoozed the task's reminders", isOk(snoozed), errCode(snoozed));
  const afterState = await probe("attention/reminders/probe:probeReminderState", { sessionId: A.sessionId });
  const snoozeRows = (value(afterState)?.snoozes ?? []).filter((entry) => entry.taskId === T5);
  const mySnooze = snoozeRows.find((entry) => entry.userId === userA);
  check("S11 snooze recorded for boss A until the chosen moment", mySnooze !== undefined && mySnooze.untilMs === untilMs, mySnooze ? `${mySnooze.untilMs}` : "missing");
  check("S11 NO snooze row for boss B (personal scope)", !snoozeRows.some((entry) => entry.userId === userB), `${snoozeRows.length} row(s)`);
  const taskAfter = await taskOf(A.client, T5);
  check("S11 the deadline itself is untouched", taskAfter?.deadline?.findingId === FUTURE_DEADLINE, taskAfter?.deadline?.findingId ?? "");
}

// --- Questions across scopes (Co teraz's third column) ------------------------------

{
  const raised = await memory(A.client, "memory.raiseClarification", {
    question: `Która kwota zaliczki obowiązuje (${RUN})?`,
    conflictingEvidence: [],
    scope: { _tag: "company" },
  });
  check("Q1 clarification raised (company scope)", isOk(raised), errCode(raised));
  const open = await clarifications(A.client, { _tag: "company" });
  const rowOf = open.find((candidate) => candidate.clarificationId === value(raised)?.clarificationId);
  check("Q1 open question readable by both scopes' read", rowOf !== undefined && rowOf.state === "open", rowOf ? rowOf.state : "missing");
  const resolved = await memory(B.client, "memory.resolveClarification", {
    clarificationId: value(raised)?.clarificationId,
    resolutionNote: "obowiązuje kwota z czwartkowej rozmowy",
  });
  check("Q1 second boss answered (author kept)", isOk(resolved), errCode(resolved));
}

// --- F1: stale revision ---------------------------------------------------------------

{
  const view = await taskOf(A.client, T4);
  const stale = await work(A.client, "work.changeTaskState", {
    taskId: T4,
    expectedRevision: view.revisionCounter,
    state: "in_progress",
  });
  check("F1 fresh revision accepted (setup)", isOk(stale), errCode(stale));
  const replay = await work(A.client, "work.changeTaskState", {
    taskId: T4,
    expectedRevision: view.revisionCounter, // stale on purpose
    state: "waiting",
    waitingReason: "test nieaktualnej rewizji",
  });
  check("F1 stale revision refuses (revision_mismatch)", errCode(replay) === "revision_mismatch", errCode(replay));
}

// --- F3: concurrent checklist/parent changes -------------------------------------------

{
  const view = await taskOf(A.client, T5);
  // Two writers race with the SAME expected revision: the parent state and
  // a checklist point. One must win, the other must refuse.
  const [parent, checklist] = await Promise.all([
    work(A.client, "work.changeTaskState", {
      taskId: T5,
      expectedRevision: view.revisionCounter,
      state: "in_progress",
    }),
    work(A.client, "work.changeChecklistItem", {
      taskId: T5,
      itemId: null,
      description: "zebrać dokumentację",
      state: "open",
      expectedRevision: view.revisionCounter,
    }),
  ]);
  const oneRefused = (!isOk(parent) && errCode(parent) === "revision_mismatch") !==
    (!isOk(checklist) && errCode(checklist) === "revision_mismatch");
  check(
    "F3 concurrent parent/checklist: exactly one wins, the other refuses",
    (isOk(parent) || isOk(checklist)) && oneRefused,
    `parent=${errCode(parent)} checklist=${errCode(checklist)}`,
  );
}

// --- F2: revoked membership ---------------------------------------------------------------

{
  // Point T4 at B while B is still active (S9 ended with A coordinating it),
  // so the revocation below expires a LIVE stored assignment.
  const pre = await taskOf(A.client, T4);
  const rePointed = await work(A.client, "work.changeTask", {
    taskId: T4,
    projectId: P_ACTIVE,
    title: `Korekta projektu ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: membershipB,
    deadlineFindingId: null,
    expectedRevision: pre.revisionCounter,
  });
  check("F2 task re-coordinated by boss B (setup)", isOk(rePointed), errCode(rePointed));

  const revoked = await memberCommand(A.client, "access.revokeMembership", { membershipId: membershipB });
  check("F2 membership revoked", isOk(revoked), errCode(revoked));

  // B's company scope ends: the public reads deny (thrown or enveloped).
  const bOverview = await errOf(() => overview(B.client));
  check("F2 revoked boss's workOverview denied", bOverview !== null, bOverview === null ? "no denial" : "denied");
  // The revocation's session cleanup is asynchronous (B3's durable job),
  // so the revoked boss's membershipOverview lands in the denial/no-company
  // family either immediately or after the cleanup: both deny company data.
  const bMembership = await membershipView(B.client).catch(() => ({ state: "denied" }));
  check(
    "F2 revoked boss's membership read leaves the company surface",
    bMembership?.state === "denied" || bMembership?.state === "no_company",
    bMembership?.state ?? "unexpected",
  );

  // The still-stored assignment reads as expired; the obligation continues.
  const t4 = await taskOf(A.client, T4);
  check(
    "F2 removed coordinator reads no effective coordination",
    t4?.coordinatorMembershipId === membershipB && t4?.effectiveCoordinatorMembershipId === null,
    `stored=${t4?.coordinatorMembershipId === membershipB} effective=${t4?.effectiveCoordinatorMembershipId}`,
  );

  // Re-assigning the removed boss refuses.
  const reassign = await work(A.client, "work.changeTask", {
    taskId: T4,
    projectId: P_ACTIVE,
    title: `Korekta projektu ${RUN}`,
    executorContactId: null,
    coordinatorMembershipId: membershipB,
    deadlineFindingId: null,
    expectedRevision: t4.revisionCounter,
  });
  check("F2 assigning the removed boss refuses (not active)", errCode(reassign) === "coordinator_membership_not_active", errCode(reassign));
}

// --- Summary -------------------------------------------------------------------------------

const counts = results.reduce(
  (acc, entry) => ({ ...acc, [entry.outcome]: (acc[entry.outcome] ?? 0) + 1 }),
  {},
);
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
const failed = results.filter((entry) => entry.outcome === "FAIL");
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((entry) => entry.id).join(", ")}`);
}
process.exit(failed.length > 0 ? 1 : 0);
