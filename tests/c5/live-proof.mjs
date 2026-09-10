/**
 * C5 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/c5, instance sleek-tiger-36, EU).
 *
 * The durable withdrawal-recomputation pipeline runs FOR REAL here: the
 * `sources.withdrawSource` checked dispatch transitions the source and
 * atomically registers `memory.recompute_dependents`; the outbox drain
 * projection collapses onto that registration; the executor rechecks the
 * lifecycle, runs C2's marking core, walks one bounded dependency level,
 * marks derivation conclusions updating-until-revalidated, publishes the
 * `memory.dependentsMarkedStale` cascade and registers linked re-analysis
 * runs through E3's seam.
 *
 * Scenarios (issue #28 focused verification):
 *  W1  withdraw ONE of two independent witnesses -> the finding survives
 *      on the remaining witness (no marking revision at all);
 *  W2  an explicit correction keeps its authority when the last witness is
 *      later withdrawn;
 *  W3  withdraw the SOLE witness -> the finding is visibly retracted as
 *      explicit unknown with the withdrawal reason; value and full history
 *      stay intact; the withdrawn source stays inspectable with reason,
 *      time and actor;
 *  W4  withdraw the basis of a derived conclusion -> the derivation becomes
 *      updating-until-revalidated (value preserved, excluded from
 *      automation), the cascade marks the second level through the
 *      `memory.dependentsMarkedStale` durable job, unrelated findings stay
 *      current, and linked re-analysis runs are registered through E3's
 *      seam (the model call itself needs OPENROUTER_API_KEY: without it
 *      the runs honestly stay failed at the provider gate — registration
 *      and linkage are the C5 proof);
 *  W5  a plan prepared BEFORE the recomputation cannot publish afterwards
 *      (the marking bumped the counter: stale-plan guard, so recomputation
 *      can never overwrite or restore around a newer truth);
 *  W6  tenant isolation: company A cannot withdraw company B's source, and
 *      B's own withdrawal recomputes only B's memory.
 *
 * Run: node tests/c5/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: states, ids and Polish product text
 * only — no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

/** One withdrawal is one-shot per source: every run uses its own fixtures. */
const RUN = randomUUID().slice(0, 8);

const DEPLOYMENT = "sleek-tiger-36";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

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

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const memory = (operation, input, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const withdraw = (sourceId, reason, sessionId) =>
  client().action("memory/recompute/probe:probeWithdrawSource", {
    envelope: envelope("sources.withdrawSource", { sourceId, reason }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const state = (sessionId) =>
  client().action("memory/recompute/probe:probeRecomputeState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the tenant state until the predicate passes (durable jobs are async). */
async function untilState(predicate, label, sessionId, timeoutMs = 60_000) {
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

const temporalValue = (day, originalExpression, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression, role },
});
const textNote = (text) => ({ _tag: "text_note", text });
const known = { _tag: "known" };
const evidence = (sourceId, fragmentId, supportKind) => ({
  sourceId,
  fragmentId,
  supportKind,
});

const findingBy = (st, key) => st.findings.find((f) => f.semanticKey === key);
const revisionsOf = (st, findingId) =>
  st.revisions
    .filter((r) => r.findingId === findingId)
    .sort((a, b) => a.revision - b.revision);
const recomputeJobFor = (st, dedupPrefix) =>
  st.recomputeJobs.find((j) => (j.dedupKey ?? "").startsWith(dedupPrefix));
const readState = async (sessionId) => {
  const st = await state(sessionId);
  if (st._tag !== "ok") throw new Error(`state read failed: ${JSON.stringify(st)}`);
  return st.value;
};

console.log(`# C5 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const fixtures = await client().action("memory/recompute/probe:probeSeedRecomputeFixtures", { runTag: RUN });
if (fixtures._tag !== "ok") throw new Error(`fixtures failed: ${JSON.stringify(fixtures)}`);
const F = fixtures.value;
const S_SOLE = F.sole.sourceId;
const F_SOLE = F.sole.fragmentId;
const S_WITA = F.witnessA.sourceId;
const F_WITA = F.witnessA.fragmentId;
const S_WITB = F.witnessB.sourceId;
const F_WITB = F.witnessB.fragmentId;
const S_BASIS = F.basis.sourceId;
const F_BASIS = F.basis.fragmentId;
const S_DERIVE = F.derive.sourceId;
const S_DERIVE2 = F.derive2.sourceId;
const S_INDEP = F.indep.sourceId;
const F_INDEP = F.indep.fragmentId;

const isolation = await client().action("memory/recompute/probe:probeSeedRecomputeIsolation", { runTag: RUN });
if (isolation._tag !== "ok") throw new Error(`isolation seeding failed`);
const SESSION_B = isolation.value.sessionId;
const SOURCE_B = isolation.value.sourceId;
const FRAGMENT_B = isolation.value.fragmentId;

/** Publishes one finding through the REAL checked dispatch. */
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

await publishOne(S_SOLE, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("termin.dostawy.bruno"),
  value: temporalValue("2026-09-11", "w piątek", "agreed"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_SOLE, F_SOLE, "support")],
  derivesFrom: [],
});
await publishOne(S_WITA, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("cena.korroborowana"),
  value: textNote("10 tysięcy"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_WITA, F_WITA, "support"), evidence(S_WITB, F_WITB, "independent_corroboration")],
  derivesFrom: [],
});
await publishOne(S_BASIS, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("termin.dostawy.baza"),
  value: temporalValue("2026-09-11", "piątek rano", "agreed"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_BASIS, F_BASIS, "support")],
  derivesFrom: [],
});
await publishOne(S_INDEP, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("notatka.wizytowka"),
  value: textNote("nowa wizytówka klienta"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [evidence(S_INDEP, F_INDEP, "support")],
  derivesFrom: [],
});
const basisFinding = findingBy(await readState(), key("termin.dostawy.baza"));
if (basisFinding === undefined) throw new Error("basis finding missing before derivations");
await publishOne(S_DERIVE, {
  findingId: null,
  scope: { _tag: "company" },
  semanticKey: key("wniosek.ryzyko"),
  value: textNote("ryzyko kary za opóźnienie jest niskie"),
  knowledgeState: known,
  effectiveFrom: null,
  evidence: [],
  derivesFrom: [basisFinding.findingId],
});
const riskFinding = (st) => findingBy(st, key("wniosek.ryzyko"));
{
  const st = await readState();
  const d1 = riskFinding(st);
  if (d1 === undefined) throw new Error("d1 missing before d2");
  await publishOne(S_DERIVE2, {
    findingId: null,
    scope: { _tag: "company" },
    semanticKey: key("wniosek.spedycja"),
    value: textNote("nie odkładamy zamówienia"),
    knowledgeState: known,
    effectiveFrom: null,
    evidence: [],
    derivesFrom: [d1.findingId],
  });
}

// --- W1: withdraw one of two witnesses -> the finding survives -------------------
{
  const withdrawn = await withdraw(S_WITB, "Druga firma potwierdziła cenę później; witness B wycofany");
  const st = await untilState(
    (s) =>
      recomputeJobFor(s, "sources.withdrawSource:") !== undefined &&
      recomputeJobFor(s, "sources.withdrawSource:").state === "succeeded"
        ? null
        : "recompute job pending",
    "W1 recompute job",
  );
  const corr = findingBy(st, key("cena.korroborowana"));
  const corrHistory = revisionsOf(st, corr.findingId);
  const w1ok =
    withdrawn._tag === "ok" &&
    corr.knowledgeTag === "known" &&
    corr.revisionCounter === 1 &&
    corrHistory.length === 1; // no marking revision: the finding stood
  record(
    "W1 withdraw ONE of two independent witnesses -> finding survives on the remaining witness (no marking revision)",
    w1ok ? "PASS" : "FAIL",
    `tag=${corr.knowledgeTag} revisions=${corrHistory.length} job=${recomputeJobFor(st, "sources.withdrawSource:")?.state}`,
  );
}

// --- W2: an explicit correction keeps authority when the last witness withdraws --
{
  const corr0 = findingBy(await readState(), key("cena.korroborowana"));
  const corrected = await memory("memory.correctFinding", {
    findingId: corr0.findingId,
    expectedRevision: 1,
    value: textNote("10 tysięcy netto"),
    knowledgeState: known,
    reason: "Szef potwierdził kwotę netto",
  });
  const withdrawn = await withdraw(S_WITA, "Wycofuję pierwszą wypowiedź o cenie");
  const st = await untilState(
    (s) =>
      recomputeJobFor(s, "sources.withdrawSource:") !== undefined &&
      s.recomputeJobs.filter((j) => (j.dedupKey ?? "").startsWith("sources.withdrawSource:"))
          .filter((j) => j.state === "succeeded").length >= 2
        ? null
        : "second withdrawal job pending",
    "W2 recompute job",
  );
  const corr = findingBy(st, key("cena.korroborowana"));
  const history = revisionsOf(st, corr.findingId);
  const w2ok =
    corrected._tag === "ok" &&
    withdrawn._tag === "ok" &&
    corr.knowledgeTag === "known" &&
    corr.revisionCounter === 2 &&
    history.length === 2 &&
    history[1].origin === "correction" &&
    revisionsOf(st, corr.findingId).every((r) => r.origin !== "withdrawal_marking");
  record(
    "W2 later explicit correction keeps authority after its last original witness is withdrawn",
    w2ok ? "PASS" : "FAIL",
    `tag=${corr.knowledgeTag} revisions=${history.length} lastOrigin=${history[1]?.origin}`,
  );
}

// --- W3: withdraw the sole witness -> visible retraction with full history -------
{
  const before = findingBy(await readState(), key("termin.dostawy.bruno"));
  const withdrawn = await withdraw(S_SOLE, "Szef wysłał tę wiadomość przez pomyłkę");
  const st = await untilState(
    (s) => {
      const f = findingBy(s, key("termin.dostawy.bruno"));
      return f !== undefined && f.knowledgeTag === "unknown" && f.revisionCounter === 2
        ? null
        : "sole-witness marking pending";
    },
    "W3 marking",
  );
  const sole = findingBy(st, key("termin.dostawy.bruno"));
  const history = revisionsOf(st, sole.findingId);
  const sourceRow = st.sources.find((s) => s.sourceId === S_SOLE);
  const w3ok =
    withdrawn._tag === "ok" &&
    withdrawn.value.withdrawnAtMs > 0 &&
    sole.knowledgeTag === "unknown" &&
    history.length === 2 &&
    history[1].origin === "withdrawal_marking" &&
    String(history[1].knowledgeState.reason).startsWith("source_withdrawn:") &&
    history[1].value.temporal.shape.day === "2026-09-11" && // value preserved verbatim
    history[1].value.temporal.originalExpression === "w piątek" &&
    history[1].supersedesRevisionId === history[0].revisionId &&
    sourceRow.lifecycle === "withdrawn" &&
    sourceRow.withdrawnReason.includes("pomyłkę") &&
    sourceRow.withdrawnAtMs !== null &&
    sourceRow.withdrawnByUserId !== null; // actor recorded on the source
  record(
    "W3 withdraw the SOLE witness -> finding visibly retracted as explicit unknown, value+history intact, source inspectable with reason/time/actor",
    w3ok ? "PASS" : "FAIL",
    `tag=${sole.knowledgeTag} reason="${history[1]?.knowledgeState?.reason}" value=${history[1]?.value?.temporal?.shape?.day}`,
  );

  // W3b: the withdrawal is one-shot; a replay can never duplicate anything.
  const replay = await withdraw(S_SOLE, "powtórne wycofanie tej samej wiadomości");
  const st3b = await readState();
  const w3bok =
    replay._tag === "error" &&
    replay.error._tag === "conflict" &&
    replay.error.code === "source_already_withdrawn" &&
    revisionsOf(st3b, sole.findingId).length === 2; // no duplicate marking
  record(
    "W3b a replayed withdrawal refuses (one-shot) and commits nothing: no duplicate revisions or events",
    w3bok ? "PASS" : "FAIL",
    `code=${replay.error?.code} revisions=${revisionsOf(st3b, sole.findingId).length}`,
  );
}

// --- W4: the dependent cascade + automation exclusion + reanalysis registration --
let staleSetId = null;
{
  // Prepare the OLD plan BEFORE the withdrawal (captured expectations: rev 1).
  const basisBefore = findingBy(await readState(), key("termin.dostawy.baza"));
  const oldPlan = await memory("memory.prepareChangeSet", {
    sourceId: S_INDEP,
    plannedRevisions: [
      {
        findingId: basisBefore.findingId,
        scope: { _tag: "company" },
        semanticKey: key("termin.dostawy.baza"),
        value: temporalValue("2026-09-12", "sobota", "agreed"),
        knowledgeState: known,
        effectiveFrom: null,
        evidence: [evidence(S_INDEP, F_INDEP, "support")],
        derivesFrom: [],
      },
    ],
  });
  staleSetId = oldPlan._tag === "ok" ? oldPlan.value.changeSetId : null;

  const withdrawn = await withdraw(S_BASIS, "Teraz jest inaczej — wycofuję ustalenie terminu");
  const st = await untilState(
    (s) => {
      const d1 = findingBy(s, key("wniosek.ryzyko"));
      const d2 = findingBy(s, key("wniosek.spedycja"));
      return d1 !== undefined &&
        d2 !== undefined &&
        d1.knowledgeTag === "updating" &&
        d2.knowledgeTag === "updating"
        ? null
        : "cascade levels pending";
    },
    "W4 cascade (two durable levels)",
    undefined,
    90_000,
  );
  const basis = findingBy(st, key("termin.dostawy.baza"));
  const d1 = findingBy(st, key("wniosek.ryzyko"));
  const d2 = findingBy(st, key("wniosek.spedycja"));
  const indep = findingBy(st, key("notatka.wizytowka"));
  const d1History = revisionsOf(st, d1.findingId);
  const d2History = revisionsOf(st, d2.findingId);
  const basisHistory = revisionsOf(st, basis.findingId);
  const reanalysisRuns = st.reanalysisRuns;
  const cascadeJobs = st.recomputeJobs.filter((j) => j.kind === "memory.recompute_dependents");
  const w4ok =
    withdrawn._tag === "ok" &&
    basis.knowledgeTag === "unknown" &&
    d1.knowledgeTag === "updating" &&
    d2.knowledgeTag === "updating" &&
    String(d1History[1]?.knowledgeState?.reason).startsWith("updating_until_revalidated:") &&
    d1History[1]?.value?.text === "ryzyko kary za opóźnienie jest niskie" && // value preserved verbatim
    d1History[1]?.origin === "withdrawal_marking" &&
    d2History[1]?.origin === "withdrawal_marking" &&
    d1.automationEligible === false &&
    d2.automationEligible === false &&
    indep.knowledgeTag === "known" && // unrelated finding remains current
    indep.revisionCounter === 1 &&
    reanalysisRuns.length >= 2 &&
    reanalysisRuns.every((run) => run.reanalysisOfRunId !== null) && // linked NEW runs
    reanalysisRuns.some((run) => run.sourceId === S_DERIVE) &&
    reanalysisRuns.some((run) => run.sourceId === S_DERIVE2) &&
    cascadeJobs.length >= 3; // withdrawal + level 1 + level 2 carriers
  record(
    "W4 withdraw the basis -> derivation updating-until-revalidated (value kept, automation-excluded), cascade reaches level 2 durably, unrelated findings stay current",
    w4ok ? "PASS" : "FAIL",
    `basis=${basis.knowledgeTag} d1=${d1.knowledgeTag} d2=${d2.knowledgeTag} indep=${indep.knowledgeTag} runs=${reanalysisRuns.length} jobs=${cascadeJobs.length}`,
  );
  const runStates = reanalysisRuns.map((r) => r.state).join(",");
  record(
    "W4b linked re-analysis runs registered through the E3 seam (model execution needs OPENROUTER_API_KEY on the deployment)",
    reanalysisRuns.length >= 2 ? "PASS" : "FAIL",
    `runStates=${runStates}`,
  );
}

// --- W5: the pre-withdrawal plan cannot publish (stale-plan guard) ---------------
{
  const attempt = await memory("memory.publishChangeSet", {
    changeSetId: staleSetId ?? "",
    expectedRevisions: [{ findingId: findingBy(await readState(), key("termin.dostawy.baza")).findingId, revision: 1 }],
  });
  const st = await readState();
  const basis = findingBy(st, key("termin.dostawy.baza"));
  const w5ok =
    attempt._tag === "error" &&
    attempt.error.code === "stale_plan" &&
    basis.knowledgeTag === "unknown" && // the marking stands
    revisionsOf(st, basis.findingId).length === 2; // no restore, no duplicate
  record(
    "W5 a plan prepared before the recomputation refuses stale afterwards (recompute never overwrites or restores around a newer truth)",
    w5ok ? "PASS" : "FAIL",
    `code=${attempt.error?.code} basisTag=${basis.knowledgeTag} revisions=${revisionsOf(st, basis.findingId).length}`,
  );
}

// --- W7: revalidation by explicit correction --------------------------------------
{
  // d1 is at revision 2 (the updating marking). The boss's explicit
  // correction revalidates it immediately: a NEW revision with origin
  // `correction` replaces the marking — revalidation never needs the model.
  const d1Before = findingBy(await readState(), key("wniosek.ryzyko"));
  const corrected = await memory("memory.correctFinding", {
    findingId: d1Before.findingId,
    expectedRevision: 2,
    value: textNote("ryzyko kary — do ponownej oceny po korekcie terminu"),
    knowledgeState: known,
    reason: "Szef potwierdził nową ocenę ryzyka",
  });
  const st = await readState();
  const d1 = findingBy(st, key("wniosek.ryzyko"));
  const d2 = findingBy(st, key("wniosek.spedycja"));
  const history = revisionsOf(st, d1.findingId);
  const w7ok =
    corrected._tag === "ok" &&
    d1.knowledgeTag === "known" &&
    d1.automationEligible === true && // revalidated -> automation may use it again
    history.length === 3 &&
    history[2].origin === "correction" &&
    history[1].origin === "withdrawal_marking" && // the marking stays in history
    d2.knowledgeTag === "updating"; // the deeper dependent still awaits its own revalidation
  record(
    "W7 explicit correction revalidates the updating marking (new revision, automation re-eligible, history retained); deeper dependents stay updating",
    w7ok ? "PASS" : "FAIL",
    `d1=${d1.knowledgeTag}/${history[2]?.origin} eligible=${d1.automationEligible} d2=${d2.knowledgeTag}`,
  );
}

// --- W6: tenant isolation ---------------------------------------------------------
{
  const foreignWithdraw = await withdraw(SOURCE_B, "próba firmy A na źródle firmy B");
  const bPublish = await memory(
    "memory.prepareChangeSet",
    {
      sourceId: SOURCE_B,
      plannedRevisions: [
        {
          findingId: null,
          scope: { _tag: "company" },
          semanticKey: key("notatka.firmyB"),
          value: textNote("ustalenie drugiej firmy"),
          knowledgeState: known,
          effectiveFrom: null,
          evidence: [evidence(SOURCE_B, FRAGMENT_B, "support")],
          derivesFrom: [],
        },
      ],
    },
    SESSION_B,
  );
  const bPublishDone =
    bPublish._tag === "ok" &&
    (await memory(
      "memory.publishChangeSet",
      { changeSetId: bPublish.value.changeSetId, expectedRevisions: [] },
      SESSION_B,
    ))._tag === "ok";
  const bWithdraw = await withdraw(SOURCE_B, "Firma B wycofuje własne źródło", SESSION_B);
  const stB = await untilState(
    (s) => {
      const f = findingBy(s, key("notatka.firmyB"));
      return f !== undefined && f.knowledgeTag === "unknown" ? null : "B marking pending";
    },
    "W6 B marking",
    SESSION_B,
    120_000,
  );
  const stA = await readState();
  const w6ok =
    foreignWithdraw._tag === "error" && // A cannot withdraw B's source
    bPublishDone &&
    bWithdraw._tag === "ok" &&
    findingBy(stB, key("notatka.firmyB")).knowledgeTag === "unknown" && // B recomputed its own
    stB.findings.every((f) => !f.semanticKey.startsWith("wniosek.")) && // B sees none of A
    findingBy(stA, key("notatka.firmyB")) === undefined && // A sees none of B
    findingBy(stA, key("wniosek.spedycja")).knowledgeTag === "updating"; // A untouched by B's work
  record(
    "W6 tenant isolation: A cannot withdraw B's source; B's withdrawal recomputes only B's memory; neither sees the other's findings",
    w6ok ? "PASS" : "FAIL",
    `foreign=${foreignWithdraw.error?._tag}/${foreignWithdraw.error?.code} bTag=${findingBy(stB, key("notatka.firmyB"))?.knowledgeTag} aD1=${findingBy(stA, key("wniosek.ryzyko"))?.knowledgeTag}`,
  );
}

// --- final sweep ------------------------------------------------------------------
{
  const st = await readState();
  const projectionConsistent = st.findings.every((f) => {
    const history = revisionsOf(st, f.findingId);
    return (
      history.length === f.revisionCounter &&
      history[history.length - 1]?.knowledgeTag === f.knowledgeTag
    );
  });
  const jobsTerminal = st.recomputeJobs
    .filter((j) => j.kind === "memory.recompute_dependents")
    .every((j) => j.state === "succeeded" || j.state === "failed");
  record(
    "S final sweep: every projection equals its latest revision; every recomputation job reached a terminal state",
    projectionConsistent && jobsTerminal ? "PASS" : "FAIL",
    `consistent=${projectionConsistent} jobsTerminal=${jobsTerminal}`,
  );
}

const ok = summarize();
process.exit(ok ? 0 : 1);
