/**
 * E7 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/e7, instance flippant-lemur-146).
 *
 * The certified project-reassignment operation runs FOR REAL here: the
 * `sources.reassignSource` checked dispatch moves the source's
 * `sourceProjectLinks` atomically with the canonical
 * `sources.sourceReassigned` event and the durable recomputation
 * registration; the outbox drain projection collapses onto that
 * registration; the C5 executor rechecks lifecycle and CURRENT links,
 * marks the narrowed scope findings updating-until-revalidated (origin
 * `reassignment_marking`, value preserved verbatim), cascades to
 * derivation dependents and registers linked re-analysis through E3's
 * seam; the conversation views and the dossier read the MOVED links live
 * (single source of truth, nothing copied).
 *
 * Scenarios (issue #115 acceptance criteria):
 *  R1  execute: the certified dispatch reassigns project A -> project B;
 *      the receipt carries the committed set; the dossier AND the project
 *      conversation views show the new placement (and the old project's
 *      view no longer lists the source);
 *  R2  dependent findings re-assess per C5's rules: the unlinked-scope
 *      finding becomes updating (value preserved, automation-excluded,
 *      history intact, attribution by source id); the still-witnessed
 *      finding, the company-scope finding and an explicit correction keep
 *      standing; the derivation dependent is reached by the cascade;
 *      linked re-analysis is registered;
 *  R3  fails closed on stale input: re-declaring the same set is a typed
 *      conflict (nothing to change, no double reaction);
 *  R4  fails closed on foreign input: another company's project and
 *      another company's source both refuse without leaking existence;
 *  R5  general->project placement: moving a company-general source into a
 *      project commits the new link and marks nothing;
 *  R6  withdrawal semantics untouched: moving back does not re-mark (the
 *      updating marking stays until revalidation), withdrawal still
 *      refuses a reassignment afterwards, and the withdrawal itself stays
 *      one-shot;
 *  R7  tenant isolation: company B reassigns its own placement; company A
 *      cannot touch B's source.
 *
 * Run: node tests/e7/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: states, ids and Polish product text
 * only, no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

/** Every run uses its own fixtures (projects, sources, findings, keys). */
const RUN = randomUUID().slice(0, 8);

const DEPLOYMENT = "flippant-lemur-146";
const CLIENT_URL = `https://${DEPLOYMENT}.convex.cloud`;

const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
    {},
  );
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}

const envelope = (operation, input, idempotencyKey) => ({
  operation,
  input,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});
const memory = (operation, input, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const reassign = (sourceId, projectIds, sessionId, idempotencyKey) =>
  client().action("sources/reassign/probe:probeReassignSource", {
    envelope: envelope("sources.reassignSource", { sourceId, projectIds }, idempotencyKey),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const withdraw = (sourceId, reason) =>
  client().action("memory/recompute/probe:probeWithdrawSource", {
    envelope: envelope("sources.withdrawSource", { sourceId, reason }),
  });
const state = (sessionId) =>
  client().action("sources/reassign/probe:probeReassignState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const sourceDetail = (sourceId) =>
  client().action("sources/read/probe:probeSourceDetail", { sourceId });
const projectConversation = (projectId) =>
  client().action("sources/read/probe:probeProjectConversation", {
    projectId,
    numItems: 50,
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the tenant state until the predicate passes (durable jobs are async). */
async function untilState(predicate, label, sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await state(sessionId);
    if (st._tag !== "ok") throw new Error(`state read failed: ${JSON.stringify(st)}`);
    last = st.value;
    const problem = predicate(last);
    if (problem === null) return last;
    await sleep(1_500);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Run-unique semantic keys: re-runs never collide with earlier findings. */
const key = (base) => `${base}.${RUN}`;

const textNote = (text) => ({ _tag: "text_note", text });
const known = { _tag: "known" };
const evidence = (sourceId, fragmentId, supportKind) => ({
  sourceId,
  fragmentId,
  supportKind,
});

const findingBy = (st, k) => st.findings.find((f) => f.semanticKey === k);
const revisionsOf = (st, findingId) =>
  st.revisions
    .filter((r) => r.findingId === findingId)
    .sort((a, b) => a.revision - b.revision);
const sourceRow = (st, sourceId) => st.sources.find((s) => s.sourceId === sourceId);
const readState = async (sessionId) => {
  const st = await state(sessionId);
  if (st._tag !== "ok") throw new Error(`state read failed: ${JSON.stringify(st)}`);
  return st.value;
};

/** Publishes one finding through the REAL checked memory dispatch. */
async function publishOne(sourceId, planned) {
  const prepared = await memory("memory.prepareChangeSet", {
    sourceId,
    plannedRevisions: [planned],
  });
  if (prepared._tag !== "ok") throw new Error(`prepare failed for ${planned.semanticKey}`);
  const published = await memory("memory.publishChangeSet", {
    changeSetId: prepared.value.changeSetId,
    expectedRevisions: [],
  });
  if (published._tag !== "ok") throw new Error(`publish failed for ${planned.semanticKey}`);
}

console.log(`# E7 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const fixtures = await client().action("sources/reassign/probe:probeSeedReassignFixtures", {
  runTag: RUN,
});
if (fixtures._tag !== "ok") throw new Error(`fixtures failed: ${JSON.stringify(fixtures)}`);
const F = fixtures.value;
const P_A = F.projectA;
const P_B = F.projectB;
const S_MOV = F.moved.sourceId;
const FR_MOV = F.moved.fragmentId;
const S_IND = F.independent.sourceId;
const FR_IND = F.independent.fragmentId;
const S_GEN = F.general.sourceId;
const S_DER = F.derivation.sourceId;

// The findings the re-assessment will judge (published through the REAL path).
await publishOne(S_MOV, {
  findingId: null,
  scope: { _tag: "project", projectId: P_A },
  semanticKey: key("termin.budowlana"),
  value: textNote("dostawa w piątek na Budowlanej"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_MOV, FR_MOV, "support")],
  derivesFrom: [],
});
await publishOne(S_MOV, {
  findingId: null,
  scope: { _tag: "project", projectId: P_A },
  semanticKey: key("termin.budowlana.korroborowany"),
  value: textNote("dostawa potwierdzona w piątek"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_MOV, FR_MOV, "support"), evidence(S_IND, FR_IND, "independent_corroboration")],
  derivesFrom: [],
});
await publishOne(S_MOV, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("faktura.dane"),
  value: textNote("dane do faktur zmienione"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_MOV, FR_MOV, "support")],
  derivesFrom: [],
});
await publishOne(S_MOV, {
  findingId: null,
  scope: { _tag: "project", projectId: P_A },
  semanticKey: key("termin.budowlana.skorygowany"),
  value: textNote("dostawa w piątek rano"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_MOV, FR_MOV, "support")],
  derivesFrom: [],
});
{
  const corrected = await memory("memory.correctFinding", {
    findingId: findingBy(await readState(), key("termin.budowlana.skorygowany")).findingId,
    expectedRevision: 1,
    value: textNote("dostawa w piątek do południa"),
    knowledgeState: known,
    reason: "Szef doprecyzował godzinę dostawy",
  });
  if (corrected._tag !== "ok") throw new Error("correction fixture failed");
}
{
  // The derivation depends on the to-be-marked finding (published from its
  // own source, no witness of its own).
  const basis = findingBy(await readState(), key("termin.budowlana"));
  await publishOne(S_DER, {
    findingId: null,
    scope: { _tag: "company" },
    semanticKey: key("przelew.przygotuj"),
    value: textNote("przygotuj przelew na piątek"),
    knowledgeState: known,
    effectiveFrom: null,
    evidence: [],
    derivesFrom: [basis.findingId],
  });
}

// --- R1: the certified dispatch executes; placement is visible everywhere ------
{
  const moved = await reassign(S_MOV, [P_B]);
  const st = await untilState(
    (s) =>
      s.jobs.some(
        (j) =>
          j.kind === "memory.recompute_dependents" &&
          (j.dedupKey ?? "").startsWith("sources.reassignSource:") &&
          j.state === "succeeded",
      ) &&
      s.events.some(
        (e) => e.eventName === "sources.sourceReassigned" && e.deliveryState === "delivered",
      )
        ? null
        : "reassign recompute job pending",
    "R1 recompute job + event delivery",
  );
  const detail = await sourceDetail(S_MOV);
  const conversationB = await projectConversation(P_B);
  const conversationA = await projectConversation(P_A);
  const row = sourceRow(st, S_MOV);
  const eventDelivered = st.events.some(
    (e) => e.eventName === "sources.sourceReassigned" && e.deliveryState === "delivered",
  );
  const inB =
    conversationB._tag === "ok" &&
    conversationB.value.page.some((r) => r.sourceId === S_MOV);
  const inA =
    conversationA._tag === "ok" &&
    conversationA.value.page.some((r) => r.sourceId === S_MOV);
  const r1ok =
    moved._tag === "ok" &&
    moved.value.reassignedAtMs > 0 &&
    moved.value.projectIds.length === 1 &&
    moved.value.projectIds[0] === P_B &&
    row.projectIds.length === 1 &&
    row.projectIds[0] === P_B &&
    row.lifecycle === "active" &&
    detail._tag === "ok" &&
    detail.value.projectIds.length === 1 &&
    detail.value.projectIds[0] === P_B &&
    inB &&
    !inA &&
    sourceRow(st, S_IND).projectIds[0] === P_A && // untouched sibling keeps its link
    eventDelivered;
  record(
    "R1 certified dispatch moves project A -> B; dossier AND conversation views read the moved links (single source of truth)",
    r1ok ? "PASS" : "FAIL",
    `moved=${moved._tag} links=${row.projectIds.length}:${row.projectIds[0] === P_B ? "B" : "?"} inB=${inB} inA=${inA} event=${eventDelivered}`,
  );
}

// --- R2: dependent findings re-assess per C5's rules ---------------------------
{
  const st = await untilState(
    (s) => {
      const d = findingBy(s, key("przelew.przygotuj"));
      return d !== undefined && d.knowledgeTag === "updating" ? null : "cascade pending";
    },
    "R2 cascade (derivation dependent)",
  );
  const marked = findingBy(st, key("termin.budowlana"));
  const markedHistory = revisionsOf(st, marked.findingId);
  const corroborated = findingBy(st, key("termin.budowlana.korroborowany"));
  const company = findingBy(st, key("faktura.dane"));
  const corrected = findingBy(st, key("termin.budowlana.skorygowany"));
  const derivation = findingBy(st, key("przelew.przygotuj"));
  const derivationHistory = revisionsOf(st, derivation.findingId);
  const reanalysisRuns = st.reanalysisRuns.filter((run) => run.sourceId === S_MOV);
  const r2ok =
    marked.knowledgeTag === "updating" &&
    marked.revisionCounter === 2 &&
    marked.automationEligible === false &&
    markedHistory.length === 2 &&
    markedHistory[1].origin === "reassignment_marking" &&
    markedHistory[1].reassignedSourceId === S_MOV &&
    markedHistory[1].withdrawnSourceId === null &&
    markedHistory[1].reason === `source_reassigned:${P_A}` &&
    String(markedHistory[1].knowledgeState.reason) === `updating_until_revalidated: source_reassigned:${S_MOV}` &&
    markedHistory[1].value.text === "dostawa w piątek na Budowlanej" && // value verbatim
    markedHistory[1].supersedesRevisionId === markedHistory[0].revisionId && // history intact
    corroborated.knowledgeTag === "known" && // surviving placement witness
    corroborated.revisionCounter === 1 &&
    company.knowledgeTag === "known" && // company scope keeps the source
    company.revisionCounter === 1 &&
    corrected.knowledgeTag === "known" && // explicit correction keeps authority
    corrected.revisionCounter === 2 &&
    derivation.knowledgeTag === "updating" && // cascade reached the dependent
    derivation.automationEligible === false &&
    derivationHistory[1]?.origin === "withdrawal_marking" && // the cascade's marking vocabulary
    reanalysisRuns.length >= 1 &&
    reanalysisRuns.every((run) => run.reanalysisOfRunId !== null); // linked NEW runs
  record(
    "R2 unlinked-scope finding marked updating (origin reassignment_marking, value verbatim, automation-excluded, attribution by source id); corroborated/company/corrected findings stand; cascade reaches the derivation; linked re-analysis registered",
    r2ok ? "PASS" : "FAIL",
    `marked=${marked.knowledgeTag}/${markedHistory[1]?.origin} reason=${markedHistory[1]?.reason} ksReason=${String(markedHistory[1]?.knowledgeState?.reason)} reas=${markedHistory[1]?.reassignedSourceId} value=${markedHistory[1]?.value?.text} sup=${markedHistory[1]?.supersedesRevisionId === markedHistory[0]?.revisionId} corr=${corroborated.knowledgeTag}/${corroborated.revisionCounter} co=${company.knowledgeTag}/${company.revisionCounter} fix=${corrected.knowledgeTag}/${corrected.revisionCounter} der=${derivation.knowledgeTag}/${derivationHistory[1]?.origin} runs=${reanalysisRuns.length}/${reanalysisRuns.map((r) => r.reanalysisOfRunId !== null).join(",")}`,
  );
}

// --- R3: fails closed on stale input (nothing to change) ------------------------
{
  // The state read is tenant-wide (earlier proof runs live on the lease), so
  // the assertion is DELTA-based: a refused replay must register NOTHING.
  const before = (await readState()).jobs.filter(
    (j) => j.kind === "memory.recompute_dependents" && (j.dedupKey ?? "").startsWith("sources.reassignSource:"),
  ).length;
  const replay = await reassign(S_MOV, [P_B]);
  const after = (await readState()).jobs.filter(
    (j) => j.kind === "memory.recompute_dependents" && (j.dedupKey ?? "").startsWith("sources.reassignSource:"),
  ).length;
  const r3ok =
    replay._tag === "error" &&
    replay.error._tag === "conflict" &&
    replay.error.code === "source_links_unchanged" &&
    after === before; // no second reaction fired
  record(
    "R3 re-declaring the current set is a typed conflict; no second reaction registers",
    r3ok ? "PASS" : "FAIL",
    `code=${replay.error?.code} reactions=${before}->${after}`,
  );
}

// --- R4: fails closed on foreign input -----------------------------------------
{
  const isolation = await client().action("sources/reassign/probe:probeSeedReassignIsolation", {
    runTag: RUN,
  });
  if (isolation._tag !== "ok") throw new Error("isolation seeding failed");
  const SESSION_B = isolation.value.sessionId;
  const SOURCE_B = isolation.value.sourceId;
  const PROJECT_B = isolation.value.project;
  const foreignProject = await reassign(S_MOV, [P_A, PROJECT_B]);
  // A's own session attempting B's source (no sessionId override).
  const foreignSource = await reassign(SOURCE_B, []);
  const r4ok =
    foreignProject._tag === "error" &&
    (foreignProject.error.code === "tenant_scope_mismatch" ||
      foreignProject.error.code === "project_reference_not_found") &&
    foreignSource._tag === "error" &&
    foreignSource.error._tag === "not_found";
  record(
    "R4 another company's project and source both refuse closed (no existence leak)",
    r4ok ? "PASS" : "FAIL",
    `project=${foreignProject.error?.code} source=${foreignSource.error?._tag}/${foreignSource.error?.code}`,
  );

  // --- R7: tenant isolation (B reassigns its own placement) ---------------------
  const ownMove = await reassign(SOURCE_B, [], SESSION_B);
  const defaultCompanyProbe = await readState(SESSION_B);
  const ownRow = defaultCompanyProbe.sources.find((s) => s.sourceId === SOURCE_B);
  const r7ok =
    ownMove._tag === "ok" &&
    ownMove.value.projectIds.length === 0 &&
    ownRow.projectIds.length === 0;
  record(
    "R7 company B reassigns its own source to company-general; company A's attempt on B's source never executed",
    r7ok ? "PASS" : "FAIL",
    `own=${ownMove._tag} links=${ownRow?.projectIds.length ?? -1}`,
  );
}

// --- R5: to/from company-general ------------------------------------------------
{
  const generalized = await reassign(S_GEN, [P_A]);
  const st = await readState();
  const gen = sourceRow(st, S_GEN);
  const company = findingBy(st, key("faktura.dane"));
  const r5ok =
    generalized._tag === "ok" &&
    generalized.value.projectIds[0] === P_A &&
    gen.projectIds[0] === P_A &&
    company.knowledgeTag === "known" && // a general->project move marks nothing
    company.revisionCounter === 1;
  record(
    "R5 declaring the empty set means company-general (proved in R7); general->project moves the placement and marks nothing",
    r5ok ? "PASS" : "FAIL",
    `gen=${generalized._tag} links=${gen.projectIds.length} companyFinding=${company.knowledgeTag}`,
  );
}

// --- R6: withdrawal semantics untouched ------------------------------------------
{
  // Moving BACK to A is a real change; the updating marking is NOT re-marked
  // (C5's idempotence: revalidation replaces it, never a second marking).
  const back = await reassign(S_MOV, [P_A]);
  await untilState(
    (s) =>
      s.jobs.filter(
        (j) =>
          j.kind === "memory.recompute_dependents" &&
          (j.dedupKey ?? "").startsWith("sources.reassignSource:") &&
          j.state === "succeeded",
      ).length >= 2
        ? null
        : "second reassign reaction pending",
    "R6 second reaction",
  );
  const st = await readState();
  const marked = findingBy(st, key("termin.budowlana"));
  const backOk =
    back._tag === "ok" &&
    sourceRow(st, S_MOV).projectIds[0] === P_A &&
    marked.knowledgeTag === "updating" &&
    marked.revisionCounter === 2; // no duplicate marking

  // Withdrawal still works over a reassignment marking and stays one-shot;
  // a withdrawn source refuses reassignment.
  const withdrawn = await withdraw(S_MOV, "Wiadomość dotyczy innego budowy, wycofuję");
  const st2 = await untilState(
    (s) => sourceRow(s, S_MOV).lifecycle === "withdrawn" ? null : "withdrawal pending",
    "R6 withdrawal",
  );
  const withdrawnRow = sourceRow(st2, S_MOV);
  const replayWithdraw = await withdraw(S_MOV, "powtórne wycofanie");
  const reassignAfterWithdraw = await reassign(S_MOV, [P_B]);
  const r6ok =
    backOk &&
    withdrawn._tag === "ok" &&
    withdrawnRow.lifecycle === "withdrawn" &&
    withdrawnRow.withdrawnReason.includes("wycofuję") &&
    replayWithdraw._tag === "error" &&
    replayWithdraw.error.code === "source_already_withdrawn" &&
    reassignAfterWithdraw._tag === "error" &&
    reassignAfterWithdraw.error._tag === "conflict" &&
    reassignAfterWithdraw.error.code === "source_withdrawn";
  record(
    "R6 moving back never re-marks; withdrawal still executes (actor/time/reason recorded), stays one-shot, and a withdrawn source refuses reassignment",
    r6ok ? "PASS" : "FAIL",
    `back=${back._tag} markedRevs=${marked.revisionCounter} wd=${withdrawn._tag}/${withdrawnRow.lifecycle} replay=${replayWithdraw.error?.code} afterWd=${reassignAfterWithdraw.error?.code}`,
  );
}

// --- final sweep ------------------------------------------------------------------
{
  const st = await readState();
  const defaultCompanyProbe = await readState(); // company A is the default session's company
  const projectionConsistent = st.findings.every((f) => {
    const history = revisionsOf(st, f.findingId);
    return (
      history.length === f.revisionCounter &&
      history[history.length - 1]?.knowledgeTag === f.knowledgeTag
    );
  });
  const jobsTerminal = st.jobs
    .filter((j) => j.kind === "memory.recompute_dependents")
    .every((j) => j.state === "succeeded" || j.state === "failed");
  const linksSingleTruth = st.sources.every(
    (s) => s.lifecycle === "withdrawn" || s.projectIds.length <= 2,
  );
  record(
    "S final sweep: every projection equals its latest revision; every recomputation job terminal; placements bounded",
    projectionConsistent && jobsTerminal && linksSingleTruth ? "PASS" : "FAIL",
    `consistent=${projectionConsistent} terminal=${jobsTerminal} links=${linksSingleTruth} sources=${defaultCompanyProbe.sources.length}`,
  );
}

const ok = summarize();
process.exit(ok ? 0 : 1);
