/**
 * C4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/c4, instance brainy-hawk-2, EU).
 *
 * Output is sanitized: no tokens, no keys; proof persons use the reserved
 * @kiero.invalid domain; sign-in and invitation codes are dev-deployment
 * fixture installs from THIS lane's guarded probe (the lease workaround the
 * C1 evidence introduced: unchanged sibling modules keep their push-time
 * env snapshot). The REAL issuance, verification, acceptance, admission,
 * invitation, revocation, publication and every work command run through
 * their owning lanes' checked paths:
 *
 * - identities: real Convex Auth sessions from B1's email-code flow;
 * - companies: B3's real admission path (Europe/Warsaw + Pacific/Auckland
 *   for the company-timezone proofs);
 * - projects: C1's real projects dispatch;
 * - temporal findings: C2's real memory dispatch (prepareChangeSet +
 *   publishChangeSet) with witnessed sources seeded by this lane's fixture;
 * - work: C4's real work dispatch (all six operations) + workOverview.
 *
 * Run: node tests/c4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_C4_DEPLOYMENT ?? "brainy-hawk-2";
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_C4_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `c4-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szefA");
const SZEF_B = person("szefB");
const SZEF_C = person("szefC");
const COMPANY_A = `Budowa C4 A ${RUN}`;
const COMPANY_B = `Budowa C4 B ${RUN}`;

// The fixture code is UNIQUE PER RUN (the global code index uses .unique();
// see the C1 evidence for the stale-row hazard of a constant code).
const codeFromRun = (run, salt) => {
  let h = 0;
  for (const ch of run + salt) {
    h = (h * 31 + ch.codePointAt(0)) % 100_000_000;
  }
  return h.toString().padStart(8, "0");
};
const SIGNIN_A = codeFromRun(RUN, "a");
const SIGNIN_B = codeFromRun(RUN, "b");
const SIGNIN_C = codeFromRun(RUN, "c");
const INVITE_C = codeFromRun(RUN, "inv");

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);

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
const work = (client, operation, input) =>
  client.mutation("work/functions:dispatchWork", { envelope: envelope(operation, input) });
const projects = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", { envelope: envelope(operation, input) });
const member = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", { envelope: envelope(operation, input) });
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", input),
  });
const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", { envelope: envelope(operation, input) });
// C2's memory surface runs through its guarded service-bridge probes under
// the proof person's own live session (the SAME canonical chain; the public
// entries carry the service-bridge subject convention, so the bridge is the
// proven user-shaped path for guarded evidence).
const memory = (operation, input, sessionId) =>
  anon().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
const overview = (client) => client.query("work/functions:workOverview", {});
const membershipView = (client) =>
  client.query("access/membership/functions:membershipOverview", {});
const companyWork = (companyId) =>
  anon().action("work/probe:c4ProofCompanyWork", { companyId });
const currentFindings = (scope, sessionId) =>
  anon().action("memory/findings/probe:probeReadCurrentFindings", { scope, sessionId });
const derive = (args) => anon().action("work/probe:c4ProofDeriveDueness", args);
const seedWitnessed = (sessionId, acceptanceKey, authorText) =>
  anon().action("work/probe:c4ProofSeedWitnessedSource", {
    sessionId,
    acceptanceKey,
    authorText,
  });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

/** Real B1 sign-in with a fixture code from this lane's guarded probe. */
async function signInFixture(email, code) {
  const bootstrap = anon();
  await errOf(() =>
    bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }),
  );
  const set = await bootstrap.action("work/probe:c4ProofSetSignInCode", { email, code });
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

const temporal = (day, originalExpression, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression, role },
});
const known = { _tag: "known" };

/** Publishes one new finding through C2's REAL dispatch and returns its id. */
async function publishFinding(sessionId, sourceId, fragmentId, scope, semanticKey, findingValue) {
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
        evidence: [{ sourceId, fragmentId, supportKind: "support" }],
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
  return found.findingId;
}

console.log(`# C4 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- Setup: three real persons, two real companies, one project each ----------
const A = await signInFixture(SZEF_A, SIGNIN_A);
const B = await signInFixture(SZEF_B, SIGNIN_B);
{
  const createdA = await admit(A.client, "access.createCompany", {
    name: COMPANY_A,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const createdB = await admit(B.client, "access.createCompany", {
    name: COMPANY_B,
    timezone: "Pacific/Auckland",
    defaultCurrency: "PLN",
  });
  if (!isOk(createdA) || !isOk(createdB)) {
    throw new Error(`company setup failed: ${errCode(createdA)} / ${errCode(createdB)}`);
  }
  row("setup company A (Europe/Warsaw)", `${(await overview(A.client)).companyId} (${COMPANY_A})`);
  row("setup company B (Pacific/Auckland)", `${(await overview(B.client)).companyId} (${COMPANY_B})`);
}
const COMPANY_A_ID = (await overview(A.client)).companyId;
const COMPANY_B_ID = (await overview(B.client)).companyId;

let P1 = null;
let PB = null;
{
  const identified = await projects(A.client, "projects.identifyProject", {
    displayName: "Łazienka Kaczmarek",
    initialStage: "in_progress",
    clientId: null,
  });
  check("S1 project A identified", isOk(identified), errCode(identified));
  P1 = value(identified)?.projectId;
  const identifiedB = await projects(B.client, "projects.identifyProject", {
    displayName: "Projekt firmy B",
    initialStage: "in_progress",
    clientId: null,
  });
  check("S2 project B identified", isOk(identifiedB), errCode(identifiedB));
  PB = value(identifiedB)?.projectId;
}

// --- Phase A: unauthenticated typed denial ------------------------------------
{
  const denied = await anon().mutation("work/functions:dispatchWork", {
    envelope: envelope("work.changeTask", {
      taskId: null,
      projectId: P1,
      title: "Obce zadanie",
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: null,
      expectedRevision: 1,
    }),
  });
  check(
    "A1 unauthenticated work dispatch typed-denied",
    denied?._tag === "error" && denied.error._tag === "unauthenticated",
    JSON.stringify({ tag: denied?.error?._tag, code: denied?.error?.code }),
  );
  const read = await errOf(() => overview(anon()));
  check(
    "A2 unauthenticated workOverview denied with sanitized copy",
    read !== null && read.includes("Najpierw się zaloguj"),
  );
}

// --- Phase B: task identity, executor contact, coordinator assignment ---------
let T1 = null;
let executorContact = null;
let membershipA = null;
{
  const contact = await projects(A.client, "projects.upsertContact", {
    contactId: null,
    kind: "person",
    displayName: "Janek Hydraulik",
  });
  check("B1 external executor contact created", isOk(contact), errCode(contact));
  executorContact = value(contact)?.contactId;

  const seeded = await seedWitnessed(
    A.sessionId,
    `c4-witness-${RUN}`,
    "Dostawa okien w piątek, Piotrek ma odebrać dostawę.",
  );
  check("B2 witnessed source seeded for the proof person (guarded)", isOk(seeded), errCode(seeded));
  const S1 = value(seeded)?.sourceId;
  const F1 = value(seeded)?.fragmentId;

  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
    basisSourceId: S1,
    expectedRevision: 1,
  });
  check("B3 task created with executor, no coordinator, evidence basis", isOk(created), errCode(created));
  T1 = value(created)?.taskId;

  let lists = (await overview(A.client));
  let t1 = lists.tasks.find((t) => t.taskId === T1);
  check(
    "B4 born Do zrobienia, shared queue, external executor, dueness without term",
    t1?.state === "todo" &&
      t1?.coordinatorMembershipId === null &&
      t1?.effectiveCoordinatorMembershipId === null &&
      t1?.executorName === "Janek Hydraulik" &&
      t1?.dueness.kind === "no_deadline",
    JSON.stringify({ state: t1?.state, dueness: t1?.dueness?.kind, executor: t1?.executorName }),
  );

  const state = value(await companyWork(COMPANY_A_ID));
  const createdHistory = state.revisions.find((r) => r.taskId === T1 && r.revision === 1);
  check(
    "B5 immutable history row: actor, via, basis source, full snapshot",
    createdHistory !== undefined &&
      createdHistory.change === "created" &&
      createdHistory.subjectKind === "task" &&
      createdHistory.via === "user" &&
      createdHistory.basisSourceId === S1 &&
      createdHistory.snapshot.title === "Odebrać dostawę okien" &&
      createdHistory.snapshot.state === "todo",
    JSON.stringify({ change: createdHistory?.change, via: createdHistory?.via }),
  );

  // The shared queue never auto-assigns the author.
  const view = (await membershipView(A.client));
  membershipA = view?.members?.find((m) => m.isSelf)?.membershipId ?? null;
  check("B6 proof person's membership readable for explicit assignment", typeof membershipA === "string");

  const assigned = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  check("B7 explicit coordinator assignment", isOk(assigned), errCode(assigned));
  lists = (await overview(A.client));
  t1 = lists.tasks.find((t) => t.taskId === T1);
  check(
    "B8 stored AND effective coordinator set",
    t1?.coordinatorMembershipId === membershipA && t1?.effectiveCoordinatorMembershipId === membershipA,
  );

  // A revoked-coordinator-shaped input: an inactive membership id is refused.
  const stale = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: "k57" + "0".repeat(23),
    deadlineFindingId: null,
    expectedRevision: 2,
  });
  check(
    "B9 unknown coordinator membership refused (not_found, no leak)",
    stale?._tag === "error" && errCode(stale) === "coordinator_membership_not_found",
    errCode(stale),
  );

  const revisionNow = (await overview(A.client)).tasks.find((t) => t.taskId === T1).revisionCounter;
  const occ = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: revisionNow - 1,
  });
  check("B10 stale expectedRevision refuses (revision_mismatch)", errCode(occ) === "revision_mismatch", errCode(occ));
}

// --- Phase C: Czeka needs its saved reason -------------------------------------
{
  const revision = (await overview(A.client)).tasks.find((t) => t.taskId === T1).revisionCounter;
  const noReason = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: revision,
    state: "waiting",
  });
  check("C1 Czeka without a reason refused", errCode(noReason) === "waiting_reason_required", errCode(noReason));

  const reasonOutside = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: revision,
    state: "in_progress",
    waitingReason: "nie na czekaniu",
  });
  check(
    "C2 reason outside Czeka refused",
    errCode(reasonOutside) === "waiting_reason_only_for_waiting",
    errCode(reasonOutside),
  );

  const waiting = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: revision,
    state: "waiting",
    waitingReason: "  czekamy na okna ",
  });
  check("C3 Czeka entered with the trimmed reason saved", isOk(waiting), errCode(waiting));
  let t1 = (await overview(A.client)).tasks.find((t) => t.taskId === T1);
  check(
    "C4 reason saved on the record and rendered",
    t1?.state === "waiting" && t1?.waitingReason === "czekamy na okna" && t1?.stateLabel === "Czeka",
    JSON.stringify({ state: t1?.state, reason: t1?.waitingReason }),
  );

  const redescribed = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: t1.revisionCounter,
    state: "waiting",
    waitingReason: "okna przyjadą dopiero w przyszłym tygodniu",
  });
  check("C5 re-describing the obstacle is a recorded change", isOk(redescribed), errCode(redescribed));
  t1 = (await overview(A.client)).tasks.find((t) => t.taskId === T1);
  check(
    "C6 state did not move while the reason changed",
    t1?.state === "waiting" && t1?.waitingReason === "okna przyjadą dopiero w przyszłym tygodniu",
  );

  const resumed = await work(A.client, "work.changeTaskState", {
    taskId: T1,
    expectedRevision: t1.revisionCounter,
    state: "in_progress",
  });
  check("C7 leaving Czeka clears the reason", isOk(resumed), errCode(resumed));
  t1 = (await overview(A.client)).tasks.find((t) => t.taskId === T1);
  check("C8 obstacle cleared with the state move", t1?.state === "in_progress" && t1?.waitingReason === null);

  for (const operation of [
    "work.completeTaskFromChecklist",
    "work.markEventOccurredOnElapsedDate",
    "work.autoCompleteOverdue",
  ]) {
    const invented = await work(A.client, operation, { taskId: T1 });
    check(
      `C9 invented automatic operation '${operation}' fails closed`,
      invented?._tag === "error" &&
        invented.error._tag === "unsupported" &&
        invented.error.code === "unknown_operation",
      JSON.stringify({ tag: invented?.error?._tag, code: invented?.error?.code }),
    );
  }
}

// --- Phase D: checklist independence, both directions ---------------------------
let T2 = null;
{
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P1,
    title: "Montaż płytek",
    executorContactId: null,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  check("D1 second task created", isOk(created), errCode(created));
  T2 = value(created)?.taskId;

  const items = [];
  for (const description of ["kupić płytki", "zamówić fugę", "wezwać hydraulika"]) {
    let revision = (await overview(A.client)).tasks.find((t) => t.taskId === T2).revisionCounter;
    const item = await work(A.client, "work.changeChecklistItem", {
      taskId: T2,
      itemId: null,
      description,
      state: "open",
      expectedRevision: revision,
    });
    check(`D2 point '${description}' created`, isOk(item), errCode(item));
    items.push(value(item)?.itemId);
  }

  // Direction 1: checking EVERY point completes nothing.
  for (const itemId of items) {
    const revision = (await overview(A.client)).tasks.find((t) => t.taskId === T2).revisionCounter;
    const checked = await work(A.client, "work.changeChecklistItem", {
      taskId: T2,
      itemId,
      description: { 0: "kupić płytki", 1: "zamówić fugę", 2: "wezwać hydraulika" }[items.indexOf(itemId)],
      state: "checked",
      expectedRevision: revision,
    });
    check(`D3 point ${items.indexOf(itemId) + 1}/3 checked`, isOk(checked), errCode(checked));
  }
  let t2 = (await overview(A.client)).tasks.find((t) => t.taskId === T2);
  check(
    "D4 3/3 checked and the task is STILL open (no list-derived completion)",
    t2?.checklistProgress.checked === 3 &&
      t2?.checklistProgress.total === 3 &&
      t2?.state === "todo",
    JSON.stringify({ progress: t2?.checklistProgress, state: t2?.state }),
  );

  // Direction 2: Wykonane with unchecked points; item state preserved.
  const uncheck = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: items[2],
    description: "wezwać hydraulika",
    state: "open",
    expectedRevision: t2.revisionCounter,
  });
  check("D5 unchecking is recorded progress", isOk(uncheck), errCode(uncheck));
  t2 = (await overview(A.client)).tasks.find((t) => t.taskId === T2);
  check("D6 2/3 before completion", t2?.checklistProgress.checked === 2 && t2?.checklistProgress.total === 3);

  const done = await work(A.client, "work.changeTaskState", {
    taskId: T2,
    expectedRevision: t2.revisionCounter,
    state: "done",
  });
  check("D7 Wykonane with an unchecked point accepted (independent completion)", isOk(done), errCode(done));
  t2 = (await overview(A.client)).tasks.find((t) => t.taskId === T2);
  check(
    "D8 done task keeps 2/3, the open point keeps its state, dueness closed",
    t2?.state === "done" &&
      t2?.checklistProgress.checked === 2 &&
      t2?.checklist.find((i) => i.itemId === items[2])?.state === "open" &&
      t2?.checklist.find((i) => i.itemId === items[0])?.checkedAtMs !== null &&
      t2?.dueness.kind === "closed",
    JSON.stringify({ state: t2?.state, progress: t2?.checklistProgress, dueness: t2?.dueness?.kind }),
  );

  // A point may still be checked under a Wykonane task without reopening it.
  const checkUnderDone = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: items[2],
    description: "wezwać hydraulika",
    state: "checked",
    expectedRevision: t2.revisionCounter,
  });
  check("D9 checking a point under Wykonane changes only the list", isOk(checkUnderDone), errCode(checkUnderDone));
  t2 = (await overview(A.client)).tasks.find((t) => t.taskId === T2);
  check(
    "D10 the task stayed Wykonane (no reopen from a point change)",
    t2?.state === "done" && t2?.checklistProgress.checked === 3,
  );

  const state = value(await companyWork(COMPANY_A_ID));
  const itemHistory = state.revisions.filter((r) => r.itemId === items[0]);
  check(
    "D11 every point change has its own immutable history row",
    itemHistory.length === 2 &&
      itemHistory[0].change === "created" &&
      itemHistory[1].change === "changed" &&
      itemHistory[1].snapshot.state === "checked",
    JSON.stringify({ rows: itemHistory.length }),
  );
}

// --- Phase E: checklist promotion into a linked task -----------------------------
{
  const seeded = await seedWitnessed(
    A.sessionId,
    `c4-witness2-${RUN}`,
    "Janek mówi że fugę trzeba zamówić osobno.",
  );
  const S2 = value(seeded)?.sourceId;
  let lists = (await overview(A.client));
  let t2 = lists.tasks.find((t) => t.taskId === T2);

  // Phase D left the point checked; promotion is for a point that still
  // carries its own obligation, so record the honest un-check first.
  const target = t2.checklist.find((i) => i.description === "wezwać hydraulika") ?? t2.checklist[2];
  const unchecked = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: target.itemId,
    description: "wezwać hydraulika",
    state: "open",
    expectedRevision: t2.revisionCounter,
  });
  check("E0a point un-checked before promotion (recorded progress)", isOk(unchecked), errCode(unchecked));
  lists = (await overview(A.client));
  t2 = lists.tasks.find((t) => t.taskId === T2);
  const openItem = t2.checklist.find((i) => i.itemId === target.itemId);

  const deadlineFinding = await publishFinding(
    A.sessionId,
    S2,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: P1 },
    "fuga.termin",
    temporal("2026-10-01", "do 1 października", "agreed"),
  );
  row("E0 deadline finding published", deadlineFinding);

  const promoted = await work(A.client, "work.promoteChecklistItem", {
    taskId: T2,
    itemId: openItem.itemId,
    expectedRevision: t2.revisionCounter,
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: deadlineFinding,
    basisSourceId: S2,
  });
  check("E1 open point promoted into a linked task", isOk(promoted), errCode(promoted));
  const T3 = value(promoted)?.taskId;

  const after = (await overview(A.client));
  const t3 = after.tasks.find((t) => t.taskId === T3);
  const t2after = after.tasks.find((t) => t.taskId === T2);
  const promotedItem = t2after.checklist.find((i) => i.itemId === openItem.itemId);
  check(
    "E2 linked task born Do zrobienia with parent, point keeps row + state + link",
    t3?.state === "todo" &&
      t3?.parentTaskId === T2 &&
      t3?.executorContactId === executorContact &&
      t3?.deadline?.findingId === deadlineFinding &&
      promotedItem?.promotedToTaskId === T3 &&
      promotedItem?.state === "open",
    JSON.stringify({ parent: t3?.parentTaskId, promotedTo: promotedItem?.promotedToTaskId }),
  );
  check(
    "E3 promoted point excluded from list progress (obligation moved)",
    t2after?.checklistProgress.checked === 2 && t2after?.checklistProgress.total === 2,
    JSON.stringify(t2after?.checklistProgress),
  );

  const frozen = await work(A.client, "work.changeChecklistItem", {
    taskId: T2,
    itemId: openItem.itemId,
    description: "wezwać hydraulika",
    state: "open",
    expectedRevision: t2after.revisionCounter,
  });
  check("E4 promoted point is frozen (item_promoted)", errCode(frozen) === "item_promoted", errCode(frozen));
  const rePromote = await work(A.client, "work.promoteChecklistItem", {
    taskId: T2,
    itemId: openItem.itemId,
    expectedRevision: t2after.revisionCounter,
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
  });
  check("E5 double promotion refused (item_promoted)", errCode(rePromote) === "item_promoted", errCode(rePromote));

  const checkedItem = t2after.checklist.find((i) => i.state === "checked" && i.promotedToTaskId === null);
  const promoteChecked = await work(A.client, "work.promoteChecklistItem", {
    taskId: T2,
    itemId: checkedItem.itemId,
    expectedRevision: t2after.revisionCounter,
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
  });
  check("E6 checked point needs no task of its own (item_checked)", errCode(promoteChecked) === "item_checked", errCode(promoteChecked));
}

// --- Phase F: events — a passed date proves nothing ------------------------------
let E1 = null;
{
  const seeded = await seedWitnessed(
    A.sessionId,
    `c4-witness3-${RUN}`,
    "Dostawa okien była zaplanowana na wczoraj.",
  );
  const S3 = value(seeded)?.sourceId;
  // A PAST date (yesterday, Warsaw): the elapsed-date proofs below read it.
  const pastDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const timeFinding = await publishFinding(
    A.sessionId,
    S3,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: P1 },
    "dostawa.okien.termin",
    temporal(pastDay, "wczoraj", "agreed"),
  );
  row("F0 event time finding published (past day)", `${timeFinding} (${pastDay})`);

  const taskCountBefore = (await overview(A.client)).tasks.length;

  const created = await work(A.client, "work.changeEvent", {
    eventId: null,
    projectId: P1,
    title: "Dostawa okien",
    timeFindingId: timeFinding,
    basisSourceId: S3,
    expectedRevision: 1,
  });
  check("F1 event created from a date (no obligation)", isOk(created), errCode(created));
  E1 = value(created)?.eventId;

  const after = (await overview(A.client));
  const taskCountAfter = after.tasks.length;
  const e1 = after.events.find((e) => e.eventId === E1);
  check(
    "F2 the date created ONLY an event: no task appeared",
    taskCountAfter === taskCountBefore,
    `before=${taskCountBefore} after=${taskCountAfter}`,
  );
  check(
    "F3 elapsed planned event stays PLANNED, visibly past (planned_elapsed_unconfirmed)",
    e1?.state === "planned" && e1?.timing.kind === "planned_elapsed_unconfirmed",
    JSON.stringify({ state: e1?.state, timing: e1?.timing?.kind }),
  );

  // Occurrence is explicit evidence only.
  const occurred = await work(A.client, "work.changeEventState", {
    eventId: E1,
    expectedRevision: e1.revisionCounter,
    state: "occurred",
    basisSourceId: S3,
  });
  check("F4 occurrence recorded by explicit evidence", isOk(occurred), errCode(occurred));
  let e1after = (await overview(A.client)).events.find((e) => e.eventId === E1);
  check("F5 occurred is a state, not a derivation", e1after?.state === "occurred" && e1after?.timing.kind === "occurred");

  const back = await work(A.client, "work.changeEventState", {
    eventId: E1,
    expectedRevision: e1after.revisionCounter,
    state: "planned",
    basisSourceId: S3,
  });
  check("F6 explicit correction back to planned keeps history", isOk(back), errCode(back));
  e1after = (await overview(A.client)).events.find((e) => e.eventId === E1);
  check("F7 corrected event again elapsed-unconfirmed, never auto-occurred", e1after?.state === "planned" && e1after?.timing.kind === "planned_elapsed_unconfirmed");

  // The receiving obligation: a linked task sharing the SAME dated finding.
  const t1rev = (await overview(A.client)).tasks.find((t) => t.taskId === T1).revisionCounter;
  const linked = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: timeFinding,
    linkedEventId: E1,
    expectedRevision: t1rev,
  });
  check("F8 explicit receiver obligation linked to the event", isOk(linked), errCode(linked));

  const state = value(await companyWork(COMPANY_A_ID));
  const t1row = state.tasks.find((t) => t.taskId === T1);
  const e1row = state.events.find((e) => e.eventId === E1);
  check(
    "F9 task and event share ONE dated finding by reference (no copies)",
    t1row?.deadlineFindingId === e1row?.timeFindingId && t1row?.linkedEventId === E1,
    JSON.stringify({ task: t1row?.deadlineFindingId, event: e1row?.timeFindingId }),
  );
  const t1view = (await overview(A.client)).tasks.find((t) => t.taskId === T1);
  check(
    "F10 the shared past term makes the open task overdue (Czeka not entered here)",
    t1view?.dueness.kind === "overdue",
    JSON.stringify(t1view?.dueness),
  );

  // Event record shape: no executor/coordinator columns exist to assert on —
  // structural. The cancelled leg:
  const e1rev = (await overview(A.client)).events.find((e) => e.eventId === E1).revisionCounter;
  const cancelled = await work(A.client, "work.changeEventState", {
    eventId: E1,
    expectedRevision: e1rev,
    state: "cancelled",
    basisSourceId: S3,
  });
  check("F11 cancellation recorded by explicit evidence", isOk(cancelled), errCode(cancelled));
  const e1final = (await overview(A.client)).events.find((e) => e.eventId === E1);
  check("F12 cancelled event reports cancelled regardless of the date", e1final?.state === "cancelled" && e1final?.timing.kind === "cancelled");
}

// --- Phase G: temporal binding role validation -----------------------------------
{
  const seeded = await seedWitnessed(
    A.sessionId,
    `c4-witness4-${RUN}`,
    "Faktyczne wykonanie i notatka dla walidacji ról.",
  );
  const S4 = value(seeded)?.sourceId;
  const actualFinding = await publishFinding(
    A.sessionId,
    S4,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: P1 },
    "montaz.wykonanie",
    temporal("2026-09-01", "wykonano 1 września", "actual"),
  );
  const noteFinding = await publishFinding(
    A.sessionId,
    S4,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: P1 },
    "montaj.notatka",
    { _tag: "text_note", text: "sprawdzić poziomicą" },
  );

  const t1rev = (await overview(A.client)).tasks.find((t) => t.taskId === T1).revisionCounter;
  const bindActual = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: actualFinding,
    expectedRevision: t1rev,
  });
  check("G1 actual-role date refused as a deadline", errCode(bindActual) === "deadline_role_actual", errCode(bindActual));

  const bindNote = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: noteFinding,
    expectedRevision: t1rev,
  });
  check("G2 non-temporal finding refused as a deadline", errCode(bindNote) === "finding_not_temporal", errCode(bindNote));

  // A project-scoped finding of ANOTHER project of the same firm.
  const other = await projects(A.client, "projects.identifyProject", {
    displayName: "Inna przebudowa",
    initialStage: "inquiry",
    clientId: null,
  });
  const otherFinding = await publishFinding(
    A.sessionId,
    S4,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: value(other)?.projectId },
    "inny.termin",
    temporal("2026-10-20", "20 października", "agreed"),
  );
  const bindForeign = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: otherFinding,
    expectedRevision: t1rev,
  });
  check("G3 other project's finding refused (finding_project_mismatch)", errCode(bindForeign) === "finding_project_mismatch", errCode(bindForeign));

  // Company-scope findings bind in the same firm.
  const companyFinding = await publishFinding(
    A.sessionId,
    S4,
    value(seeded)?.fragmentId,
    { _tag: "company" },
    "firma.przeglad.poczta",
    temporal("2026-09-30", "do końca września", "internal"),
  );
  const bindCompany = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: companyFinding,
    expectedRevision: t1rev,
  });
  check("G4 firm-scope finding binds to a project task", isOk(bindCompany), errCode(bindCompany));

  // Cross-tenant finding: indistinguishable from missing.
  const seededB = await seedWitnessed(
    B.sessionId,
    `c4-witness-b-${RUN}`,
    "Wiadomość drugiej firmy.",
  );
  const foreignFinding = await publishFinding(
    B.sessionId,
    value(seededB)?.sourceId,
    value(seededB)?.fragmentId,
    { _tag: "project", projectId: PB },
    "obcy.termin",
    temporal("2026-10-20", "20 października", "agreed"),
  );
  const bindCross = await work(A.client, "work.changeTask", {
    taskId: T1,
    projectId: P1,
    title: "Odebrać dostawę okien",
    executorContactId: executorContact,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: foreignFinding,
    expectedRevision: t1rev + 1,
  });
  check(
    "G5 cross-tenant finding refused (not_found, no leak)",
    errCode(bindCross) === "deadline_finding_not_found",
    errCode(bindCross),
  );

  // A withdrawn source is no basis for a new change. The withdrawal runs
  // through C2's guarded lifecycle-transition probe; if THAT module's bundle
  // predates the lease's guard variables it answers proof_guard_disabled and
  // the check is skipped (the same lease-snapshot hazard the C1 evidence
  // documented) — never a silent pass.
  const withdrawn = await anon().action("memory/findings/probe:probeWithdrawSource", {
    sourceId: value(seeded)?.sourceId,
    reason: "błędna wiadomość",
  });
  if (!isOk(withdrawn) && errCode(withdrawn) === "probe_guard_disabled") {
    results.push({ id: "G6", outcome: "SKIP" });
    console.log("[SKIP] G6 :: C2 withdrawal probe disabled on this lease bundle");
  } else if (isOk(withdrawn)) {
    const bindWithdrawn = await work(A.client, "work.changeTaskState", {
      taskId: T1,
      expectedRevision: t1rev + 1,
      state: "waiting",
      waitingReason: "test wycofanej podstawy",
      basisSourceId: value(seeded)?.sourceId,
    });
    check(
      "G6 withdrawn source refused as an evidence basis",
      errCode(bindWithdrawn) === "basis_source_not_active",
      errCode(bindWithdrawn),
    );
  } else {
    check("G6 withdrawn source refused as an evidence basis", false, `withdrawal failed: ${errCode(withdrawn)}`);
  }
}

// --- Phase H: coordinator revocation (the MembershipRevoked seam) ----------------
{
  // Invite a real third person into company A through B3's real flow.
  const invited = await invite(A.client, {
    email: SZEF_C,
    role: "member",
  });
  check("H1 real invitation created", isOk(invited), errCode(invited));
  const invitationId = value(invited)?.invitationId;
  const codeSet = await anon().action("work/probe:c4ProofSetInvitationCode", {
    invitationId,
    code: INVITE_C,
  });
  check("H2 invitation fixture code installed (guarded)", isOk(codeSet), errCode(codeSet));

  const C = await signInFixture(SZEF_C, SIGNIN_C);
  const accepted = await admit(C.client, "access.acceptInvitation", {
    invitationId,
    verificationCode: INVITE_C,
  });
  check("H3 invitation accepted: real membership", isOk(accepted), errCode(accepted));
  const membershipC = value(accepted)?.membershipId;

  // One OPEN and one DONE task coordinated by C.
  const openTask = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P1,
    title: "Zamówić folię",
    executorContactId: null,
    coordinatorMembershipId: membershipC,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  check("H4 open task coordinated by the new member", isOk(openTask), errCode(openTask));
  const T5 = value(openTask)?.taskId;
  const doneTask = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P1,
    title: "Zadanie wykonane przez byłego szefa",
    executorContactId: null,
    coordinatorMembershipId: membershipC,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  const T6 = value(doneTask)?.taskId;
  const t6rev = (await overview(A.client)).tasks.find((t) => t.taskId === T6).revisionCounter;
  await work(A.client, "work.changeTaskState", {
    taskId: T6,
    expectedRevision: t6rev,
    state: "done",
  });

  let lists = (await overview(A.client));
  check(
    "H5 before revocation both tasks resolve the coordinator",
    lists.tasks.find((t) => t.taskId === T5)?.effectiveCoordinatorMembershipId === membershipC &&
      lists.tasks.find((t) => t.taskId === T6)?.effectiveCoordinatorMembershipId === membershipC,
  );

  const revoked = await member(A.client, "access.revokeMembership", { membershipId: membershipC });
  check("H6 membership revoked through the real B3 command", isOk(revoked), errCode(revoked));

  lists = (await overview(A.client));
  const t5 = lists.tasks.find((t) => t.taskId === T5);
  const t6 = lists.tasks.find((t) => t.taskId === T6);
  check(
    "H7 open task: stored assignment retained, EFFECTIVE coordination gone",
    t5?.coordinatorMembershipId === membershipC && t5?.effectiveCoordinatorMembershipId === null,
    JSON.stringify({ stored: t5?.coordinatorMembershipId, effective: t5?.effectiveCoordinatorMembershipId }),
  );
  check(
    "H8 done task: stays done, never reopened by the membership change",
    t6?.state === "done" && t6?.coordinatorMembershipId === membershipC,
    JSON.stringify({ state: t6?.state }),
  );

  const state = value(await companyWork(COMPANY_A_ID));
  const membershipCRow = state.memberships.find((m) => m.membershipId === membershipC);
  check(
    "H9 history preserved: revocation row retained, executor contact untouched",
    membershipCRow?.state === "revoked" &&
      state.tasks.find((t) => t.taskId === T5)?.executorContactId === null,
    JSON.stringify({ membership: membershipCRow?.state }),
  );
  const historyIntact = state.revisions.filter((r) => r.taskId === T5);
  check(
    "H10 the open task's full history survived the revocation",
    historyIntact.length >= 1 && historyIntact.every((r) => typeof r.actorUserId === "string"),
    JSON.stringify({ rows: historyIntact.length }),
  );
  check(
    "H11 the declared B3 cleanup consumer observed the revocation",
    state.cleanupJobs.length >= 1 && state.cleanupJobs.every((j) => j.kind === "access.cleanup_revocation"),
    JSON.stringify(state.cleanupJobs.map((j) => j.state)),
  );

  // The explicit successor: an ordinary task change by a boss.
  const t5rev = lists.tasks.find((t) => t.taskId === T5).revisionCounter;
  const successor = await work(A.client, "work.changeTask", {
    taskId: T5,
    projectId: P1,
    title: "Zamówić folię",
    executorContactId: null,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: t5rev,
  });
  check("H12 explicit successor assigned by ordinary command", isOk(successor), errCode(successor));
  lists = (await overview(A.client));
  check(
    "H13 coordination restored with the successor",
    lists.tasks.find((t) => t.taskId === T5)?.effectiveCoordinatorMembershipId === membershipA,
  );

  // The revoked membership can never be commanded back as coordinator.
  const t5rev2 = lists.tasks.find((t) => t.taskId === T5).revisionCounter;
  const back = await work(A.client, "work.changeTask", {
    taskId: T5,
    projectId: P1,
    title: "Zamówić folię",
    executorContactId: null,
    coordinatorMembershipId: membershipC,
    deadlineFindingId: null,
    expectedRevision: t5rev2,
  });
  check(
    "H14 revoked membership refused as a new coordinator",
    errCode(back) === "coordinator_membership_not_active",
    errCode(back),
  );
}

// --- Phase I: project close/cancel leaves tasks intact (the C1 seam) -------------
{
  const identified = await projects(A.client, "projects.identifyProject", {
    displayName: "Roboty zakończone, protokół jutro",
    initialStage: "in_progress",
    clientId: null,
  });
  const P3 = value(identified)?.projectId;
  const created = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P3,
    title: "Wysłać protokół",
    executorContactId: null,
    coordinatorMembershipId: membershipA,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  const T7 = value(created)?.taskId;
  check("I1 administrative task on the closing project", isOk(created), errCode(created));

  const closed = await projects(A.client, "projects.changeStage", {
    projectId: P3,
    expectedRevision: 1,
    stage: "completed",
  });
  check("I2 project completed by explicit boss command", isOk(closed), errCode(closed));

  let lists = (await overview(A.client));
  const t7 = lists.tasks.find((t) => t.taskId === T7);
  check(
    "I3 the closed project's open task stays in the company queue, state intact",
    t7 !== undefined && t7?.state === "todo" && t7?.projectId === P3,
    JSON.stringify({ state: t7?.state }),
  );

  const moved = await work(A.client, "work.changeTaskState", {
    taskId: T7,
    expectedRevision: t7.revisionCounter,
    state: "in_progress",
  });
  check("I4 work continues on the closed project's task", isOk(moved), errCode(moved));

  const reopened = await projects(A.client, "projects.changeStage", {
    projectId: P3,
    expectedRevision: 2,
    stage: "in_progress",
  });
  check("I5 project reopened", isOk(reopened), errCode(reopened));
  lists = (await overview(A.client));
  const t7after = lists.tasks.find((t) => t.taskId === T7);
  check(
    "I6 reopen changed no task state (no reopen cascade — structural)",
    t7after?.state === "in_progress" && t7after?.revisionCounter === t7.revisionCounter + 1,
    JSON.stringify({ state: t7after?.state }),
  );

  // Cancellation of another project leaves its open task visible too.
  const identified2 = await projects(A.client, "projects.identifyProject", {
    displayName: "Anulowane zlecenie",
    initialStage: "agreed",
    clientId: null,
  });
  const P4 = value(identified2)?.projectId;
  const created2 = await work(A.client, "work.changeTask", {
    taskId: null,
    projectId: P4,
    title: "Zwrócić zaliczkę",
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
    expectedRevision: 1,
  });
  const T8 = value(created2)?.taskId;
  await projects(A.client, "projects.changeStage", {
    projectId: P4,
    expectedRevision: 1,
    stage: "cancelled",
  });
  lists = (await overview(A.client));
  check(
    "I7 the cancelled project's final obligation stays visible",
    lists.tasks.find((t) => t.taskId === T8)?.state === "todo",
  );
}

// --- Phase J: overdue derivation in the COMPANY timezone -------------------------
{
  const day = (d, role = "agreed") => ({ shape: { _tag: "day", day: d }, originalExpression: d, role });
  const at = (iso) => Date.parse(iso);

  // Warsaw, summer (CEST = UTC+2): the 8th ends at 22:00Z.
  let r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-09-08") },
    knowledgeState: known,
    nowMs: at("2026-09-08T21:59:59.999Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J1 23:59:59 on the deadline day (Warsaw): pending", r?.dueness?.kind === "pending", JSON.stringify(r?.dueness));
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-09-08") },
    knowledgeState: known,
    nowMs: at("2026-09-08T22:00:00.000Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J2 midnight after the deadline day (Warsaw): overdue", r?.dueness?.kind === "overdue", JSON.stringify(r?.dueness));

  // Warsaw, winter (CET = UTC+1): the 5th ends at 23:00Z.
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-01-05") },
    knowledgeState: known,
    nowMs: at("2026-01-05T22:59:59.999Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J3 DST-crossing: 23:59:59 winter evening still pending", r?.dueness?.kind === "pending");
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-01-05") },
    knowledgeState: known,
    nowMs: at("2026-01-05T23:00:00.000Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J4 DST-crossing: midnight winter overdue", r?.dueness?.kind === "overdue");

  // Month precision: no invented day; February 2026 ends on the 28th.
  const february = { shape: { _tag: "month", month: "2026-02" }, originalExpression: "w lutym", role: "agreed" };
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: february },
    knowledgeState: known,
    nowMs: at("2026-02-28T22:59:59.999Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J5 month term: 28 Feb 23:59:59 Warsaw still pending", r?.dueness?.kind === "pending", JSON.stringify(r?.dueness));
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: february },
    knowledgeState: known,
    nowMs: at("2026-02-28T23:00:00.000Z"),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J6 month term: 1 March midnight overdue", r?.dueness?.kind === "overdue");

  // The same date-only term, different company zones, at a FIXED instant
  // where the zones provably sit on different calendar days: 15:00Z leaves
  // Warsaw (UTC+2) on the UTC date D while Auckland (UTC+12) is already on
  // D+1 — so a deadline of D is pending in Warsaw and overdue in Auckland.
  // The explicit instant makes the contrast deterministic whatever the wall
  // clock is when this script runs.
  const utcToday = new Date().toISOString().slice(0, 10);
  const contrastInstant = Date.parse(`${utcToday}T15:00:00.000Z`);
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day(utcToday) },
    knowledgeState: known,
    nowMs: contrastInstant,
    companyTimezone: "Europe/Warsaw",
  }));
  const warsawVerdict = r?.dueness?.kind;
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day(utcToday) },
    knowledgeState: known,
    nowMs: contrastInstant,
    companyTimezone: "Pacific/Auckland",
  }));
  const aucklandVerdict = r?.dueness?.kind;
  check(
    "J7 the COMPANY zone decides: the UTC day is still pending in Warsaw, already past in Auckland",
    warsawVerdict === "pending" && aucklandVerdict === "overdue",
    JSON.stringify({ warsaw: warsawVerdict, auckland: aucklandVerdict, day: utcToday }),
  );

  // Czeka does not suspend the term; unknown terms are unusable, not overdue.
  r = value(await derive({
    taskState: "waiting",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-09-08") },
    knowledgeState: known,
    nowMs: Date.now(),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J8 a waiting task is still overdue once its day passed", r?.dueness?.kind === "overdue");
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-09-08") },
    knowledgeState: { _tag: "conflicted" },
    nowMs: Date.now(),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J9 a conflicted term is unusable, never overdue", r?.dueness?.kind === "term_unusable", JSON.stringify(r?.dueness));
  r = value(await derive({
    taskState: "todo",
    eventState: "planned",
    findingValue: { _tag: "temporal", temporal: day("2026-09-08", "actual") },
    knowledgeState: known,
    nowMs: Date.now(),
    companyTimezone: "Europe/Warsaw",
  }));
  check("J10 an actual-role date is not a deadline", r?.dueness?.kind === "term_unusable" && r?.dueness?.reason === "role_actual");

  // The real overview derives in each company's own zone (B = Auckland):
  // a deadline firmly past in BOTH zones reads overdue through B's real
  // overview (the derivation, not a stored verdict), and a far-future one
  // still reads pending — proving per-task dueness in B's own zone.
  const seededB2 = await seedWitnessed(
    B.sessionId,
    `c4-witness-b2-${RUN}`,
    "Termin dawno minął.",
  );
  const pastDay = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const futureDay = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const bPastFinding = await publishFinding(
    B.sessionId,
    value(seededB2)?.sourceId,
    value(seededB2)?.fragmentId,
    { _tag: "project", projectId: PB },
    "obcy.termin.miniony",
    temporal(pastDay, "miniony termin", "agreed"),
  );
  const bFutureFinding = await publishFinding(
    B.sessionId,
    value(seededB2)?.sourceId,
    value(seededB2)?.fragmentId,
    { _tag: "project", projectId: PB },
    "obcy.termin.przyszly",
    temporal(futureDay, "przyszły termin", "agreed"),
  );
  await work(B.client, "work.changeTask", {
    taskId: null,
    projectId: PB,
    title: "Zadanie zaległe firmy B",
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: bPastFinding,
    expectedRevision: 1,
  });
  await work(B.client, "work.changeTask", {
    taskId: null,
    projectId: PB,
    title: "Zadanie przyszłe firmy B",
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: bFutureFinding,
    expectedRevision: 1,
  });
  const listsB = (await overview(B.client));
  check(
    "J11 company B's real overview derives dueness in ITS zone (Auckland)",
    listsB.companyTimezone === "Pacific/Auckland" &&
      listsB.tasks.some((t) => t.title === "Zadanie zaległe firmy B" && t.dueness.kind === "overdue") &&
      listsB.tasks.some((t) => t.title === "Zadanie przyszłe firmy B" && t.dueness.kind === "pending"),
    JSON.stringify({ tz: listsB.companyTimezone }),
  );
}

// --- Phase K: the atomic event + task pair and OCC -------------------------------
{
  const seeded = await seedWitnessed(
    A.sessionId,
    `c4-witness5-${RUN}`,
    "Dostawa wody w czwartek; Zbyszek ma ją przyjąć.",
  );
  const S5 = value(seeded)?.sourceId;
  const thursday = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pairFinding = await publishFinding(
    A.sessionId,
    S5,
    value(seeded)?.fragmentId,
    { _tag: "project", projectId: P1 },
    "woda.termin",
    temporal(thursday, "w czwartek", "agreed"),
  );

  const before = value(await companyWork(COMPANY_A_ID));
  const pair = await anon().action("work/probe:c4ProofRecordEventWithTask", {
    sessionId: A.sessionId,
    event: {
      eventId: null,
      projectId: P1,
      title: "Dostawa wody",
      timeFindingId: pairFinding,
      basisSourceId: S5,
      expectedRevision: 1,
    },
    task: {
      taskId: null,
      projectId: P1,
      title: "Przyjąć dostawę wody",
      executorContactId: null,
      coordinatorMembershipId: membershipA,
      deadlineFindingId: pairFinding,
      expectedRevision: 1,
    },
  });
  check("K1 guarded atomic pair recorded", isOk(pair), errCode(pair));
  const pairEventId = value(pair)?.eventId;
  const pairTaskId = value(pair)?.taskId;

  const after = value(await companyWork(COMPANY_A_ID));
  const pairTask = after.tasks.find((t) => t.taskId === pairTaskId);
  const pairEvent = after.events.find((e) => e.eventId === pairEventId);
  check(
    "K2 both records exist, linked, sharing one dated finding",
    pairTask !== undefined &&
      pairEvent !== undefined &&
      pairTask.linkedEventId === pairEventId &&
      pairTask.deadlineFindingId === pairEvent.timeFindingId,
    JSON.stringify({ task: pairTask?.linkedEventId, event: pairEventId }),
  );

  // The crash twin: the FULL pair, then a deliberate throw.
  const crashErr = await errOf(() =>
    anon().action("work/probe:c4ProofCrashEventWithTask", {
      sessionId: A.sessionId,
      event: {
        eventId: null,
        projectId: P1,
        title: "Dostawa piasku",
        timeFindingId: null,
        basisSourceId: S5,
        expectedRevision: 1,
      },
      task: {
        taskId: null,
        projectId: P1,
        title: "Przyjąć dostawę piasku",
        executorContactId: null,
        coordinatorMembershipId: null,
        deadlineFindingId: null,
        expectedRevision: 1,
      },
    }),
  );
  const crashed = value(await companyWork(COMPANY_A_ID));
  const orphanTask = crashed.tasks.find((t) => t.title === "Przyjąć dostawę piasku");
  const orphanEvent = crashed.events.find((e) => e.title === "Dostawa piasku");
  check(
    "K3 crash twin rolled BOTH records back (no orphan on either side)",
    crashErr !== null && orphanTask === undefined && orphanEvent === undefined,
    JSON.stringify({ threw: crashErr !== null }),
  );

  // Real OCC: two racing state commands on one revision.
  const racer = after.tasks.find((t) => t.taskId === pairTaskId);
  const [first, second] = await Promise.all([
    work(A.client, "work.changeTaskState", {
      taskId: pairTaskId,
      expectedRevision: racer.revisionCounter,
      state: "in_progress",
    }),
    work(A.client, "work.changeTaskState", {
      taskId: pairTaskId,
      expectedRevision: racer.revisionCounter,
      state: "cancelled",
    }),
  ]);
  const oks = [first, second].filter(isOk).length;
  const mismatches = [first, second].filter((r2) => errCode(r2) === "revision_mismatch").length;
  check(
    "K4 racing state commands: exactly one wins",
    oks === 1 && mismatches === 1,
    `ok=${oks} revision_mismatch=${mismatches}`,
  );
}

// --- Phase L: cross-tenant isolation ----------------------------------------------
{
  const listsA = (await overview(A.client));
  const listsB = (await overview(B.client));
  const aTaskIds = new Set(listsA.tasks.map((t) => t.taskId));
  const aEventIds = new Set(listsA.events.map((e) => e.eventId));
  check(
    "L1 company B's overview contains none of company A's work",
    listsB.tasks.every((t) => !aTaskIds.has(t.taskId)) &&
      listsB.events.every((e) => !aEventIds.has(e.eventId)),
    `A tasks=${aTaskIds.size} A events=${aEventIds.size}`,
  );

  const foreignState = await work(B.client, "work.changeTaskState", {
    taskId: [...aTaskIds][0],
    expectedRevision: 1,
    state: "cancelled",
  });
  check(
    "L2 cross-tenant task command typed-denied (not_found, no leak)",
    foreignState?._tag === "error" && errCode(foreignState) === "record_not_found",
    JSON.stringify({ tag: foreignState?.error?._tag, code: errCode(foreignState) }),
  );
  const foreignEvent = await work(B.client, "work.changeEventState", {
    eventId: [...aEventIds][0],
    expectedRevision: 1,
    state: "occurred",
  });
  check(
    "L3 cross-tenant event command typed-denied",
    foreignEvent?._tag === "error" && errCode(foreignEvent) === "record_not_found",
    errCode(foreignEvent),
  );
  const foreignItem = await work(B.client, "work.changeChecklistItem", {
    taskId: [...aTaskIds][0],
    itemId: null,
    description: "obcy punkt",
    state: "checked",
    expectedRevision: 1,
  });
  check(
    "L4 cross-tenant checklist command typed-denied",
    foreignItem?._tag === "error" && errCode(foreignItem) === "record_not_found",
    errCode(foreignItem),
  );
  const survivor = value(await companyWork(COMPANY_A_ID));
  check(
    "L5 company A's work survived every foreign attempt untouched",
    survivor.tasks.length === listsA.tasks.length && survivor.events.length === listsA.events.length,
    JSON.stringify({ tasks: survivor.tasks.length, events: survivor.events.length }),
  );
}

// --- Phase M: canonical events and history totals ----------------------------------
{
  const state = value(await companyWork(COMPANY_A_ID));
  const names = state.workEvents.map((e) => e.eventName);
  const has = (name) => names.filter((n) => n === name).length;
  check(
    "M1 all five canonical work.* events published through the outbox",
    has("work.taskChanged") >= 1 &&
      has("work.taskStateChanged") >= 1 &&
      has("work.checklistItemChanged") >= 1 &&
      has("work.eventChanged") >= 1 &&
      has("work.eventStateChanged") >= 1,
    JSON.stringify({
      taskChanged: has("work.taskChanged"),
      taskStateChanged: has("work.taskStateChanged"),
      checklistItemChanged: has("work.checklistItemChanged"),
      eventChanged: has("work.eventChanged"),
      eventStateChanged: has("work.eventStateChanged"),
    }),
  );
  const subjects = new Set(state.revisions.map((r) => r.subjectKind));
  check(
    "M2 immutable history rows exist for every subject kind",
    subjects.has("task") && subjects.has("checklist_item") && subjects.has("event"),
    JSON.stringify([...subjects]),
  );
  const monotonic = state.revisions
    .filter((r) => r.taskId !== null)
    .every((r, index, all) => {
      const prior = all.slice(0, index).filter((x) => x.taskId === r.taskId);
      return prior.every((x) => x.recordedAtMs <= r.recordedAtMs);
    });
  check("M3 per-task history is time-ordered and append-only", monotonic);
}

// --- Summary -------------------------------------------------------------------
const failed = results.filter((r) => r.outcome === "FAIL");
const skipped = results.filter((r) => r.outcome === "SKIP");
console.log(
  `\nC4 LIVE PROOFS: ${results.length - failed.length - skipped.length}/${results.length} PASS` +
    `${skipped.length === 0 ? "" : ` (${skipped.length} SKIPPED: ${skipped.map((s) => s.id).join(", ")})`}` +
    `${failed.length === 0 ? "" : ` — FAILED: ${failed.map((f) => f.id).join(", ")}`}`,
);
if (failed.length > 0) {
  process.exitCode = 1;
}
