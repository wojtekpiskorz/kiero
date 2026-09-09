/**
 * C1 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/c1, instance festive-cow-81, EU).
 *
 * Output is sanitized: no tokens, no keys; proof persons use the reserved
 * @kiero.invalid domain; sign-in codes are dev-deployment fixture installs
 * (the emailed-delivery leg is BLOCKED without RESEND_API_KEY, exactly like
 * B1/B3 evidence). Every projects command goes through the checked dispatch
 * entry (projects/functions.ts dispatchProjects); identities are REAL Convex
 * Auth sessions from B1's email-code flow with fixture codes; companies are
 * created through B3's real admission path. The D1 source link in the
 * closure proof is created by D1's REAL acceptSource transaction run under
 * this person's live session (guarded dev action; the draft upload is the
 * only seeded row).
 *
 * Run: node tests/c1/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_C1_DEPLOYMENT ?? "festive-cow-81";
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_C1_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `c1-${name}-${RUN}@kiero.invalid`;
const SZEF_A = person("szefA");
const SZEF_B = person("szefB");
const COMPANY_A = `Budowa C1 A ${RUN}`;
const COMPANY_B = `Budowa C1 B ${RUN}`;

// The fixture code is UNIQUE PER RUN: @convex-dev/auth resolves sign-in codes
// through a global `code` index with .unique(), so two pending rows carrying
// the same code value (even across different accounts, even expired) make
// every code sign-in with that value throw. A constant code worked only on a
// pristine lease; the shared lease accumulates stale rows from every partial
// run, so the code derives deterministically from RUN (reproducible when
// KIERO_C1_PROOF_RUN is set explicitly).
const codeFromRun = (run) => {
  let h = 0;
  for (const ch of run) {
    h = (h * 31 + ch.codePointAt(0)) % 100_000_000;
  }
  return h.toString().padStart(8, "0");
};
const FIXTURE_CODE = process.env.KIERO_C1_FIXTURE_CODE ?? codeFromRun(RUN);

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
const dispatch = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", {
    envelope: envelope(operation, input),
  });
const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope(operation, input),
  });
const overview = (client) => client.query("projects/functions:projectsOverview", {});
const companyState = (companyId) =>
  anon().action("projects/probe:c1ProofCompanyProjects", { companyId });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const value = (result) => result?.value;

/** Real B1 sign-in with a fixture code (proof-domain address only). */
async function signInFixture(email) {
  const bootstrap = anon();
  await errOf(() =>
    bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }),
  );
  // C1's own guarded fixture: B1's b1ProofSetCode module on this shared
  // lease keeps a pre-guard env snapshot (stale bundle), so the identical
  // proof-domain fixture runs from this lane's freshly-pushed probe.
  const set = await bootstrap.action("projects/probe:c1ProofSetSignInCode", {
    email,
    code: FIXTURE_CODE,
  });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code: FIXTURE_CODE },
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

console.log(`# C1 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- Setup: two real persons, two real companies (B3 admission path) -------
const A = await signInFixture(SZEF_A);
const B = await signInFixture(SZEF_B);
{
  const createdA = await admit(A.client, "access.createCompany", {
    name: COMPANY_A,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  const createdB = await admit(B.client, "access.createCompany", {
    name: COMPANY_B,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  if (!isOk(createdA) || !isOk(createdB)) {
    throw new Error(`company setup failed: ${errCode(createdA)} / ${errCode(createdB)}`);
  }
  const overviewA = await overview(A.client);
  const overviewB = await overview(B.client);
  row("setup company A", `${overviewA.companyId} (${COMPANY_A})`);
  row("setup company B", `${overviewB.companyId} (${COMPANY_B})`);
}

// --- Phase A: unauthenticated typed denial ----------------------------------
{
  const denied = await anon().mutation("projects/functions:dispatchProjects", {
    envelope: envelope("projects.identifyProject", {
      displayName: "Obcy projekt",
      initialStage: "inquiry",
      clientId: null,
    }),
  });
  check(
    "A1 unauthenticated projects dispatch typed-denied",
    denied?._tag === "error" && denied.error._tag === "unauthenticated",
    JSON.stringify({ tag: denied?.error?._tag, code: denied?.error?.code }),
  );
  const read = await errOf(() => overview(anon()));
  check(
    "A2 unauthenticated overview denied with sanitized copy",
    read !== null && read.includes("Najpierw się zaloguj"),
  );
}

// --- Phase B: contacts, identify, role multiplicity --------------------------
let contactKaczmarek = null;
let project1 = null;
{
  const contact = await dispatch(A.client, "projects.upsertContact", {
    contactId: null,
    kind: "organization",
    displayName: "Hurtownia Kaczmarek",
  });
  check("B1 contact created", isOk(contact), errCode(contact));
  contactKaczmarek = value(contact)?.contactId;

  // Same display name in company B: ordinary names may collide across and
  // within firms (identity is the row, not the text).
  const sameName = await dispatch(B.client, "projects.upsertContact", {
    contactId: null,
    kind: "person",
    displayName: "Hurtownia Kaczmarek",
  });
  check("B2 colliding contact name allowed in another firm", isOk(sameName), errCode(sameName));

  const identified = await dispatch(A.client, "projects.identifyProject", {
    displayName: "Łazienka Kaczmarek",
    initialStage: "inquiry",
    clientId: contactKaczmarek,
  });
  check("B3 project identified from first inquiry", isOk(identified), errCode(identified));
  project1 = value(identified)?.projectId;
  const alias1 = value(identified)?.aliasId;
  const state = value(await companyState((await overview(A.client)).companyId));
  const born = state.projects.find((p) => p.projectId === project1);
  row("B3 born working alias", `${born?.stage} @ alias ${state.aliases.find((a) => a.aliasId === alias1)?.codename}`);
  check(
    "B4 identified project born with generated working alias",
    state.aliases.find((a) => a.aliasId === alias1)?.codename?.startsWith("#") === true,
  );

  // One identity, three roles on the same project.
  const roleIds = [];
  for (const role of ["client", "executor", "supplier"]) {
    const assigned = await dispatch(A.client, "projects.assignContactRole", {
      projectId: project1,
      contactId: contactKaczmarek,
      role,
    });
    check(`B5 role ${role} assigned to one contact`, isOk(assigned), errCode(assigned));
    roleIds.push(value(assigned)?.contactRoleId);
  }
  check(
    "B6 three roles coexist without identity duplication",
    new Set(roleIds).size === 3 &&
      value(await companyState((await overview(A.client)).companyId)).roles.filter(
        (r) => r.projectId === project1,
      ).length === 3,
  );
  const again = await dispatch(A.client, "projects.assignContactRole", {
    projectId: project1,
    contactId: contactKaczmarek,
    role: "client",
  });
  check(
    "B7 same role re-command is idempotent (same row id)",
    isOk(again) && value(again)?.contactRoleId === roleIds[0],
    `${value(again)?.contactRoleId} vs ${roleIds[0]}`,
  );
}

// --- Phase C: codename reservation across retained history -------------------
let project3 = null;
{
  const assigned = await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Banan",
  });
  check("C1 codename assigned", isOk(assigned), errCode(assigned));
  const bananAliasId = value(assigned)?.aliasId;

  const again = await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Banan",
  });
  check(
    "C2 re-commanding the active codename is idempotent",
    isOk(again) && value(again)?.aliasId === bananAliasId,
  );

  const renamed = await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Kiwi",
  });
  check("C3 rename to a fresh codename", isOk(renamed), errCode(renamed));

  const companyIdA = (await overview(A.client)).companyId;
  let state = value(await companyState(companyIdA));
  const bananRow = state.aliases.find((a) => a.aliasId === bananAliasId);
  check(
    "C4 renamed-away codename retained, still denoting the same project",
    bananRow?.active === false && bananRow?.projectId === project1,
    JSON.stringify({ active: bananRow?.active, projectId: bananRow?.projectId }),
  );

  // A second project of the SAME firm cannot claim the retained codename.
  const second = await dispatch(A.client, "projects.identifyProject", {
    displayName: "Łazienka Kaczmarek",
    initialStage: "offer_preparation",
    clientId: null,
  });
  check("C5a second project identified", isOk(second), errCode(second));
  const project2 = value(second)?.projectId;
  const claimRetained = await dispatch(A.client, "projects.assignCodename", {
    projectId: project2,
    codename: "Banan",
  });
  check(
    "C5 retained codename refuses a second project (rename history)",
    claimRetained?._tag === "error" && errCode(claimRetained) === "codename_reserved",
    errCode(claimRetained),
  );
  const claimActive = await dispatch(A.client, "projects.assignCodename", {
    projectId: project2,
    codename: "Kiwi",
  });
  check(
    "C6 active codename refuses a second project",
    errCode(claimActive) === "codename_reserved",
    errCode(claimActive),
  );

  // The owning project may re-claim its own retired codename (one row).
  const reclaimed = await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Banan",
  });
  check(
    "C7 owning project re-claims its retired codename (reactivated row)",
    isOk(reclaimed) && value(reclaimed)?.aliasId === bananAliasId,
    `${value(reclaimed)?.aliasId} vs ${bananAliasId}`,
  );
  // Back to Kiwi for the later phases.
  await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Kiwi",
  });

  // The generated namespace is reserved for generated working aliases.
  const generated = await dispatch(A.client, "projects.assignCodename", {
    projectId: project1,
    codename: "#999",
  });
  check(
    "C8 generated namespace refused for chosen codenames",
    errCode(generated) === "codename_generated_namespace",
    errCode(generated),
  );

  // Another FIRM may use the same codename: reservation is firm-unique.
  const thirdB = await dispatch(B.client, "projects.identifyProject", {
    displayName: "Projekt firmy B",
    initialStage: "inquiry",
    clientId: null,
  });
  const foreignSame = await dispatch(B.client, "projects.assignCodename", {
    projectId: value(thirdB)?.projectId,
    codename: "Kiwi",
  });
  check(
    "C9 same codename in another firm allowed (firm-unique, not global)",
    isOk(foreignSame),
    errCode(foreignSame),
  );

  // A CLOSED project keeps its codenames reserved.
  const third = await dispatch(A.client, "projects.identifyProject", {
    displayName: "Anulowana przebudowa",
    initialStage: "inquiry",
    clientId: null,
  });
  check("C10a to-be-cancelled project identified", isOk(third), errCode(third));
  project3 = value(third)?.projectId;
  const claimThird = await dispatch(A.client, "projects.assignCodename", {
    projectId: project3,
    codename: "Ananas",
  });
  check("C10 codename for the to-be-cancelled project", isOk(claimThird), errCode(claimThird));
  const cancelled = await dispatch(A.client, "projects.changeStage", {
    projectId: project3,
    expectedRevision: 1,
    stage: "cancelled",
  });
  check("C11 project cancelled", isOk(cancelled), errCode(cancelled));
  state = value(await companyState(companyIdA));
  check(
    "C12 cancelled project left the active list, stays in closed",
    (await overview(A.client)).closed.some((p) => p.projectId === project3) &&
      !(await overview(A.client)).active.some((p) => p.projectId === project3),
  );
  const fourth = await dispatch(A.client, "projects.identifyProject", {
    displayName: "Nowa przebudowa",
    initialStage: "inquiry",
    clientId: null,
  });
  check("C13a fresh project identified after closure", isOk(fourth), errCode(fourth));
  const claimClosed = await dispatch(A.client, "projects.assignCodename", {
    projectId: value(fourth)?.projectId,
    codename: "Ananas",
  });
  check(
    "C13 closed project's codename stays reserved",
    errCode(claimClosed) === "codename_reserved",
    errCode(claimClosed),
  );
}

// --- Phase D: two projects race one codename (real OCC) ----------------------
{
  const companyIdA = (await overview(A.client)).companyId;
  const racers = [];
  for (const name of ["Wyscig 1", "Wyscig 2"]) {
    const identified = await dispatch(A.client, "projects.identifyProject", {
      displayName: name,
      initialStage: "inquiry",
      clientId: null,
    });
    check(`D0a racer '${name}' identified`, isOk(identified), errCode(identified));
    racers.push(value(identified)?.projectId);
  }
  const [first, second] = await Promise.all([
    dispatch(A.client, "projects.assignCodename", { projectId: racers[0], codename: "Meteor" }),
    dispatch(A.client, "projects.assignCodename", { projectId: racers[1], codename: "Meteor" }),
  ]);
  const wins = [first, second].filter(isOk).length;
  const conflicts = [first, second].filter((r) => errCode(r) === "codename_reserved").length;
  check(
    "D1 two racing projects: exactly one wins the codename",
    wins === 1 && conflicts === 1,
    `ok=${wins} codename_reserved=${conflicts}`,
  );
  const state = value(await companyState(companyIdA));
  check(
    "D2 one alias row for the raced codename",
    state.aliases.filter((a) => a.codename === "Meteor").length === 1,
  );
}

// --- Phase E: pause vs stage separation, revision serialization ---------------
{
  // Advance through several stages (no sequencing enforced, revision bumps).
  let revision = 1;
  for (const stage of ["offer_preparation", "awaiting_decision", "agreed", "in_progress"]) {
    const moved = await dispatch(A.client, "projects.changeStage", {
      projectId: project1,
      expectedRevision: revision,
      stage,
    });
    check(`E1 stage -> ${stage}`, isOk(moved), errCode(moved));
    revision += 1;
  }
  const paused = await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: revision,
    pause: { reason: "czekamy na okna", resumeOn: "2026-10-15" },
  });
  check("E2 pause set with reason and proposed resume date", isOk(paused), errCode(paused));
  const companyIdA = (await overview(A.client)).companyId;
  let state = value(await companyState(companyIdA));
  let row1 = state.projects.find((p) => p.projectId === project1);
  check(
    "E3 pause left the stage untouched (separate mark, not a stage)",
    row1?.stage === "in_progress" &&
      row1?.paused?.reason === "czekamy na okna" &&
      row1?.paused?.resumeOn === "2026-10-15",
    JSON.stringify({ stage: row1?.stage, paused: row1?.paused }),
  );
  check(
    "E4 paused project stays on the ACTIVE list",
    (await overview(A.client)).active.some((p) => p.projectId === project1),
  );

  // Stale revision refuses: concurrent lifecycle commands serialize.
  const stale = await dispatch(A.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: revision, // consumed by the pause
    stage: "agreed",
  });
  check("E5 stale expectedRevision refuses (revision_mismatch)", errCode(stale) === "revision_mismatch", errCode(stale));

  const cleared = await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: revision + 1,
    pause: null,
  });
  check("E6 explicit clear resumes (the only resume there is)", isOk(cleared), errCode(cleared));
  state = value(await companyState(companyIdA));
  row1 = state.projects.find((p) => p.projectId === project1);
  check("E7 cleared pause leaves the stage in place", row1?.paused === null && row1?.stage === "in_progress");

  // A pause whose proposed resume date is ALREADY PAST: nothing derives.
  const pastPause = await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: revision + 2,
    pause: { reason: "okna dalej nie ma", resumeOn: "2020-01-01" },
  });
  check("E8 pause with a long-past proposed resume date accepted", isOk(pastPause), errCode(pastPause));
  state = value(await companyState(companyIdA));
  row1 = state.projects.find((p) => p.projectId === project1);
  check(
    "E9 elapsed resume date does not auto-resume anything",
    row1?.paused?.reason === "okna dalej nie ma",
    JSON.stringify(row1?.paused),
  );
  await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: revision + 3,
    pause: null,
  });
}

// --- Phase F: silence cannot close (typed vocabulary enforcement) ------------
{
  const missingStage = await dispatch(A.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: 8,
  });
  check(
    "F1 a stage command without an explicit stage is validation-rejected",
    missingStage?._tag === "error" && missingStage.error._tag === "validation",
    JSON.stringify({ tag: missingStage?.error?._tag }),
  );
  const pauseAsStage = await dispatch(A.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: 8,
    stage: "paused",
  });
  check(
    "F2 'paused' is not a stage: vocabulary-rejected",
    pauseAsStage?._tag === "error" && pauseAsStage.error._tag === "validation",
  );
  const badDate = await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: 8,
    pause: { reason: "x", resumeOn: "2026-02-30" },
  });
  check(
    "F3 impossible calendar resume date rejected",
    badDate?._tag === "error" && badDate.error._tag === "validation",
  );
  for (const operation of [
    "projects.autoCloseOnSilence",
    "projects.closeWhenNoOpenTasks",
    "projects.closeOnElapsedDate",
  ]) {
    const invented = await dispatch(A.client, operation, { projectId: project1 });
    check(
      `F4 invented automatic-closure operation '${operation}' fails closed`,
      invented?._tag === "error" &&
        invented.error._tag === "unsupported" &&
        invented.error.code === "unknown_operation",
      JSON.stringify({ tag: invented?.error?._tag, code: invented?.error?.code }),
    );
  }
  const companyIdA = (await overview(A.client)).companyId;
  const state = value(await companyState(companyIdA));
  check(
    "F5 the project is still open after all the refused closure attempts",
    state.projects.find((p) => p.projectId === project1)?.stage === "in_progress",
  );
}

// --- Phase G: close and reopen with surviving obligations --------------------
{
  const companyIdA = (await overview(A.client)).companyId;

  // A REAL D1 source linked to this project (acceptance under this session).
  const seeded = await anon().action("projects/probe:c1ProofSeedDraftUpload", {
    sessionId: A.sessionId,
  });
  check("G1 draft upload seeded for the proof person (guarded)", isOk(seeded), errCode(seeded));
  const accepted = await anon().action("sources/accept/probe:probeAcceptSource", {
    envelope: envelope("sources.acceptSource", {
      uploadId: value(seeded)?.uploadId,
      authorText: "Dostawa okien 12 października, montaż u Kaczmarka.",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [project1],
    }),
    sessionId: A.sessionId,
  });
  check(
    "G2 REAL D1 acceptSource linked the C1-identified project",
    isOk(accepted),
    errCode(accepted),
  );
  const sourceId = value(accepted)?.sourceId;

  let state = value(await companyState(companyIdA));
  const beforeClose = {
    project: state.projects.find((p) => p.projectId === project1),
    aliases: state.aliases.filter((a) => a.projectId === project1).map((a) => a.aliasId).sort(),
    roles: state.roles.filter((r) => r.projectId === project1).map((r) => r.contactRoleId).sort(),
    contacts: state.contacts.map((c) => c.contactId).sort(),
    links: state.sourceLinks.filter((l) => l.projectId === project1).map((l) => l.sourceId).sort(),
  };
  check(
    "G3 the source link exists before closure",
    JSON.stringify(beforeClose.links) === JSON.stringify([sourceId]),
  );

  // Complete the project (explicit boss command).
  const revisionNow = beforeClose.project?.stageRevision ?? 1;
  const completed = await dispatch(A.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: revisionNow,
    stage: "completed",
  });
  check("G4 project completed by explicit command", isOk(completed), errCode(completed));

  const listsAfterClose = await overview(A.client);
  check(
    "G5 completed project left the active list, stays searchable in closed",
    listsAfterClose.closed.some((p) => p.projectId === project1) &&
      !listsAfterClose.active.some((p) => p.projectId === project1),
  );
  check(
    "G6 closed view keeps alias history, client and source links",
    (() => {
      const view = listsAfterClose.closed.find((p) => p.projectId === project1);
      return (
        view?.activeCodename === "Kiwi" &&
        view?.aliases.some((a) => a.codename === "Banan" && a.active === false) === true &&
        view?.sourceLinkCount === 1
      );
    })(),
  );

  state = value(await companyState(companyIdA));
  const closedRow = state.projects.find((p) => p.projectId === project1);
  check("G7 closure instant recorded", typeof closedRow?.closedAtMs === "number");

  const pauseOnClosed = await dispatch(A.client, "projects.setPause", {
    projectId: project1,
    expectedRevision: closedRow?.stageRevision ?? 1,
    pause: { reason: "nietzsche", resumeOn: null },
  });
  check(
    "G8 pausing a closed project refuses (project_closed)",
    errCode(pauseOnClosed) === "project_closed",
    errCode(pauseOnClosed),
  );

  // Reopen (explicit evidence = the explicit command), history preserved.
  const reopened = await dispatch(A.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: closedRow?.stageRevision ?? 1,
    stage: "in_progress",
  });
  check("G9 project reopened by explicit command", isOk(reopened), errCode(reopened));
  state = value(await companyState(companyIdA));
  const afterReopen = {
    project: state.projects.find((p) => p.projectId === project1),
    aliases: state.aliases.filter((a) => a.projectId === project1).map((a) => a.aliasId).sort(),
    roles: state.roles.filter((r) => r.projectId === project1).map((r) => r.contactRoleId).sort(),
    contacts: state.contacts.map((c) => c.contactId).sort(),
    links: state.sourceLinks.filter((l) => l.projectId === project1).map((l) => l.sourceId).sort(),
  };
  check(
    "G10 reopen keeps contacts, aliases, roles and source links on stable IDs",
    JSON.stringify(afterReopen.aliases) === JSON.stringify(beforeClose.aliases) &&
      JSON.stringify(afterReopen.roles) === JSON.stringify(beforeClose.roles) &&
      JSON.stringify(afterReopen.contacts) === JSON.stringify(beforeClose.contacts) &&
      JSON.stringify(afterReopen.links) === JSON.stringify(beforeClose.links),
  );
  check(
    "G11 reopen cleared the closure instant and returned the project to active",
    afterReopen.project?.closedAtMs === null &&
      (await overview(A.client)).active.some((p) => p.projectId === project1),
  );
  const eventNames = state.projectEvents.map((e) => e.eventName);
  check(
    "G12 history intact: identified/codename/stage/pause events all retained",
    eventNames.includes("projects.projectIdentified") &&
      eventNames.includes("projects.codenameAssigned") &&
      eventNames.filter((e) => e === "projects.stageChanged").length >= 6 &&
      eventNames.includes("projects.pauseChanged"),
    eventNames.filter((e) => e === "projects.stageChanged").length + " stageChanged events",
  );
}

// --- Phase H: cross-tenant isolation ------------------------------------------
{
  const listsB = await overview(B.client);
  const listsA = await overview(A.client);
  const aIds = new Set([...listsA.active, ...listsA.closed].map((p) => p.projectId));
  const bIds = [...listsB.active, ...listsB.closed].map((p) => p.projectId);
  check(
    "H1 company B's overview contains none of company A's projects",
    bIds.every((id) => !aIds.has(id)),
    `A=${aIds.size} B=${bIds.length} overlap=0`,
  );
  const bProject = listsB.active[0]?.projectId ?? bIds[0];

  const foreignStage = await dispatch(B.client, "projects.changeStage", {
    projectId: project1,
    expectedRevision: 1,
    stage: "cancelled",
  });
  check(
    "H2 cross-tenant stage command typed-denied (not_found, no leak)",
    foreignStage?._tag === "error" &&
      foreignStage.error._tag === "not_found" &&
      foreignStage.error.code === "record_not_found",
    JSON.stringify({ tag: foreignStage?.error?._tag, code: foreignStage?.error?.code }),
  );
  const foreignRole = await dispatch(B.client, "projects.assignContactRole", {
    projectId: bProject,
    contactId: contactKaczmarek,
    role: "client",
  });
  check(
    "H3 cross-tenant role link typed-denied",
    foreignRole?._tag === "error" && foreignRole.error._tag === "not_found",
    JSON.stringify({ tag: foreignRole?.error?._tag, code: foreignRole?.error?.code }),
  );
  const foreignIdentify = await dispatch(B.client, "projects.identifyProject", {
    displayName: "Obcy",
    initialStage: "inquiry",
    clientId: contactKaczmarek,
  });
  check(
    "H4 cross-tenant client reference typed-denied at identification",
    foreignIdentify?._tag === "error" && foreignIdentify.error._tag === "not_found",
    errCode(foreignIdentify),
  );
  const foreignCodename = await dispatch(B.client, "projects.assignCodename", {
    projectId: project1,
    codename: "Podstep",
  });
  check(
    "H5 cross-tenant codename command typed-denied",
    foreignCodename?._tag === "error" && foreignCodename.error._tag === "not_found",
  );
  const stateA = value(await companyState((await overview(A.client)).companyId));
  check(
    "H6 company A's project survived every foreign attempt untouched",
    stateA.projects.find((p) => p.projectId === project1)?.stage === "in_progress",
  );
}

// --- Summary -------------------------------------------------------------------
const failed = results.filter((r) => r.outcome === "FAIL");
console.log(
  `\nC1 LIVE PROOFS: ${results.length - failed.length}/${results.length} PASS${failed.length === 0 ? "" : ` — FAILED: ${failed.map((f) => f.id).join(", ")}`}`,
);
if (failed.length > 0) {
  process.exitCode = 1;
}
