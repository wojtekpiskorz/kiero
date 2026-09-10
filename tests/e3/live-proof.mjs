/**
 * E3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/e3, instance adept-echidna-627, EU).
 *
 * The durable text-analysis pipeline runs FOR REAL here: D1 acceptance
 * registers the extract job; the drain projection this lane owns collapses
 * onto it; extract registers the analyze job; the analyze workflow runs the
 * bounded agent loop through E2's chat adapter against the real accepted
 * chat route (glm-5.3-flash first), then publishes bounded groups through
 * C2's checked prepare/publish with the analysis's input revisions as
 * caller expectations.
 *
 * Scenarios (issue #37 focused verification):
 *  A. a clear boss message -> autonomous publish of typed findings with
 *     provenance, versions and observed model/latency recorded;
 *  B. an ambiguous message -> a source-backed clarification (not a stuck
 *     job; the run succeeds);
 *  C. a clear correction -> supersession with history retained;
 *  D. a paused Wednesday plan + a Friday correction -> resuming the paused
 *     plan is refused (stale), Friday stays current with history; a
 *     re-analysis of the older source cannot revert it;
 *  E. a mixed source (two projects + a firm fact) with one group forced to
 *     fail -> independent groups commit once, the failed group stays
 *     explicit, the run still succeeds;
 *  F. crash during publication (rollback) and crash-after-provider-response
 *     -> journal restart re-executes only the crashed stage, the provider
 *     is NOT called again, and nothing is duplicated.
 *
 * Run: node tests/e3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: routing metadata, states and Polish
 * source texts only — no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "adept-echidna-627";
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
const key = () => `idem_${randomUUID()}`;

const envelope = (input, idempotencyKey) => ({
  operation: "sources.acceptSource",
  input,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

const accept = (input, idempotencyKey, sessionId) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: envelope(input, idempotencyKey),
    sessionId,
  });
const memory = (operation, input, idempotencyKey, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: {
      operation,
      input,
      expectedRevisions: [],
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    sessionId,
  });
const analysisState = (runId, sessionId) =>
  client().action("processing/text/probe:probeAnalysisState", {
    ...(runId === undefined ? {} : { runId }),
    sessionId,
  });
const latestRun = (sourceId) =>
  client().action("processing/text/probe:probeLatestRunForSource", { sourceId });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a run to a terminal state (bounded wait). */
async function waitForRun(runId, timeoutMs = 1_200_000, sessionId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await analysisState(runId, sessionId);
    if (state._tag === "ok" && state.value.run.state !== "running") {
      return state.value;
    }
    await sleep(2_000);
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}

/** Restarts a failed run's workflow from a named stage (guarded probe). */
async function restartRun(runId, from, sessionId) {
  const state = await analysisState(runId, sessionId);
  if (state._tag !== "ok") throw new Error("state read failed for restart");
  const checkpoint = JSON.parse(state.value.run.checkpoint ?? "{}");
  if (typeof checkpoint.workflowId !== "string") {
    throw new Error("workflowId missing from checkpoint");
  }
  const outcome = await client().action("processing/text/probe:probeRestartAnalysis", {
    workflowId: checkpoint.workflowId,
    from,
    runId,
  });
  if (outcome._tag !== "ok") throw new Error(`restart failed: ${JSON.stringify(outcome)}`);
  await sleep(5_000);
}

/**
 * Waits for a run, retrying provider-window failures: a failed run whose
 * attempts show provider errors is restarted from the model stage with a
 * fresh bounded retry budget (bounded restarts, recorded honestly).
 */
async function waitForRunRetrying(runId, sessionId, restarts = 2) {
  for (let attempt = 0; ; attempt += 1) {
    const state = await waitForRun(runId, 900_000, sessionId);
    if (state.run.state === "succeeded" || attempt >= restarts) {
      return state;
    }
    const providerFailed = state.attempts.some((a) => a.outcome === "failed");
    if (!providerFailed) {
      return state;
    }
    console.log(`[retry] run ${runId} failed on provider errors; restarting from model stage (${attempt + 1}/${restarts})`);
    await restartRun(runId, "model", sessionId);
  }
}

/** Accepts one source and returns { sourceId, runId } once registered. */
async function acceptAndAnalyze(text, projectHints = [], sentAtIso, sessionId) {
  const upload = await client().action("processing/text/probe:probeSeedE3Upload", {
    sessionId,
  });
  if (upload._tag !== "ok") throw new Error("upload seeding failed");
  const accepted = await accept(
    {
      uploadId: upload.value.uploadId,
      authorText: text,
      ...(sentAtIso === undefined ? {} : { intendedSentAtIso: sentAtIso }),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints,
    },
    key(),
    sessionId,
  );
  if (accepted._tag !== "ok") {
    throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  }
  const run = await latestRun(accepted.value.sourceId);
  if (run._tag !== "ok") throw new Error("no processing run for source");
  return { sourceId: accepted.value.sourceId, runId: run.value.runId };
}

/** Sanitized model observations for the evidence record. */
function modelObservations(state) {
  return state.attempts.map((a) => ({
    model: a.model,
    outcome: a.outcome,
    latencyMs: a.finishedAtMs === null ? null : a.finishedAtMs - a.startedAtMs,
    ...(a.errorKind === null ? {} : { errorKind: a.errorKind }),
  }));
}

console.log(`# E3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures: a FRESH proof company per pass (deterministic context) ----------
const NONCE = String(Date.now());
const seed = await client().action("processing/text/probe:probeSeedE3Company", { nonce: NONCE });
if (seed._tag !== "ok") throw new Error(`probeSeedE3Company failed: ${JSON.stringify(seed)}`);
const COMPANY = seed.value.companyId;
const SESSION = seed.value.sessionId;
const BANAN = seed.value.bananId;
const KACZMAREK = seed.value.kaczmarekId;
console.log(
  `# fixtures: fresh company=${COMPANY} session=<seeded> banan=${BANAN} kaczmarek=${KACZMAREK} nonce=${NONCE}`,
);

// ---------------------------------------------------------------------------
// A. clear boss message -> autonomous publish
// ---------------------------------------------------------------------------
const A_SENT_AT = "2026-09-08T16:30:00.000Z"; // Tuesday 18:30 Warsaw
const a = await acceptAndAnalyze(
  "Projekt Banan: dowóz płytek na Buniewice w środę rano. Odbiór potwierdził u nas klient Kaczmarek. Do wyceny doliczamy około 10 tysięcy.",
  [BANAN],
  A_SENT_AT,
  SESSION,
);
const aState = await waitForRunRetrying(a.runId, SESSION);
console.log(
  `[A] run: ${aState.run.state} pipeline=${aState.run.pipelineVersion} prompt=${aState.run.promptVersion} schema=${aState.run.schemaVersion} modelConfig=${aState.run.modelConfigurationVersion}`,
);
console.log(`[A] model observations: ${JSON.stringify(modelObservations(aState))}`);
console.log(`[A] steps: ${JSON.stringify(aState.steps.map((s) => [s.sequence, s.stepKind, s.state]))}`);
record(
  "A/run-versions-recorded",
  aState.run.pipelineVersion === "e3.text/1" &&
    aState.run.promptVersion === "e3.prompt-pl/2" &&
    aState.run.schemaVersion === "e3.schema/1" &&
    aState.run.modelConfigurationVersion === "e2.routing/e2.0#chat_analysis"
    ? "PASS"
    : "FAIL",
  aState.run.modelConfigurationVersion,
);
record("A/run-succeeded", aState.run.state === "succeeded" ? "PASS" : "FAIL", aState.run.state);
const aGroups = aState.steps.filter((s) => s.stepKind === "publish_group");
const aPublished = aGroups.filter((s) => s.state === "succeeded");
record(
  "A/autonomous-publish",
  aPublished.length >= 1 ? "PASS" : "FAIL",
  `${aPublished.length}/${aGroups.length} groups`,
);
const bananFinding = aState.findings.find(
  (f) =>
    f.scopeProjectId === BANAN &&
    f.value?._tag === "temporal" &&
    JSON.stringify(f.value).includes("2026-09-09"),
);
record(
  "A/typed-finding-with-provenance",
  bananFinding !== undefined && bananFinding.revisionCounter >= 1 ? "PASS" : "FAIL",
  bananFinding === undefined
    ? "no project finding"
    : `${bananFinding.semanticKey} rev${bananFinding.revisionCounter} value=${JSON.stringify(bananFinding.value)}`,
);
const aChangeSets = aState.changeSets.filter((c) => c.sourceId === a.sourceId && c.state === "published");
record(
  "A/change-set-published-once",
  aChangeSets.length === aPublished.length && aChangeSets.length >= 1 ? "PASS" : "FAIL",
  `published sets=${aChangeSets.length} groups=${aPublished.length}`,
);
const aFragment = aState.fragments.find((f) => f.anchor._tag === "text_range");
record(
  "A/text-range-fragments",
  aFragment !== undefined ? "PASS" : "FAIL",
  aFragment === undefined ? "only whole-source" : `${aState.fragments.length} fragments`,
);

// ---------------------------------------------------------------------------
// B. ambiguous message -> clarification (a question, not a stuck job)
// ---------------------------------------------------------------------------
let bState = null;
let bClarif = [];
for (let attempt = 1; attempt <= 3 && bClarif.length === 0; attempt += 1) {
  const b = await acceptAndAnalyze(
    "Sprawa Banan: Kaczmarek twierdzi, że dostawa była uzgodniona na środę, ale ja pamiętam piątek. Zostawmy to do wyjaśnienia, dopóki nie dotrze potwierdzenie.",
    [BANAN],
    "2026-09-08T17:00:00.000Z",
    SESSION,
  );
  bState = await waitForRunRetrying(b.runId, SESSION);
  console.log(`[B] attempt ${attempt} run: ${bState.run.state}; model: ${JSON.stringify(modelObservations(bState))}`);
  bClarif = bState.clarifications.filter((c) => c.state === "open");
  if (bClarif.length === 0) {
    console.log(`[B] attempt ${attempt} raised no clarification (model variance); retrying`);
  }
}
record(
  "B/clarification-raised",
  bClarif.length >= 1 ? "PASS" : "FAIL",
  bClarif.length === 0 ? "none raised" : bClarif.map((c) => c.question.slice(0, 80)).join(" | "),
);
record(
  "B/question-not-stuck-job",
  bState.run.state === "succeeded" ? "PASS" : "FAIL",
  `run=${bState.run.state} (a raised clarification is a success outcome, no retries)`,
);

// ---------------------------------------------------------------------------
// D-prep: pause a Wednesday plan while the Wednesday world is current.
// ---------------------------------------------------------------------------
if (bananFinding === undefined) {
  throw new Error(
    `scenario D precondition failed: no Wednesday temporal finding for Banan (A steps: ${JSON.stringify(aState.steps.map((s) => [s.stepKind, s.state]))})`,
  );
}
const wholeFragmentA = aState.fragments.find((f) => f.anchor._tag === "whole_source");
if (wholeFragmentA === undefined) throw new Error("no whole-source fragment on source A");
const pausedPrepare = await memory(
  "memory.prepareChangeSet",
  {
  sourceId: a.sourceId,
  plannedRevisions: [
    {
      findingId: bananFinding.findingId,
      scope: { _tag: "project", projectId: BANAN },
      semanticKey: bananFinding.semanticKey,
      value: {
        _tag: "temporal",
        temporal: {
          shape: { _tag: "day", day: "2026-09-15" },
          originalExpression: "za tydzień",
          role: "agreed",
        },
      },
      knowledgeState: { _tag: "known" },
      effectiveFrom: null,
      evidence: [
        {
          sourceId: a.sourceId,
          fragmentId: wholeFragmentA.fragmentId,
          supportKind: "support",
          extractionId: wholeFragmentA.extraction?.extractionId ?? null,
        },
      ],
      derivesFrom: [],
    },
  ],
  },
  undefined,
  SESSION,
);
if (pausedPrepare._tag !== "ok") {
  throw new Error(`paused prepare failed: ${JSON.stringify(pausedPrepare)}`);
}
const pausedSet = pausedPrepare.value.changeSetId;
console.log(`[D] paused plan prepared against the Wednesday world (${pausedSet})`);

// ---------------------------------------------------------------------------
// C. clear correction -> supersession with history
// ---------------------------------------------------------------------------
let c = null;
let cState = null;
let cFinding = undefined;
for (let attempt = 1; attempt <= 3 && cFinding === undefined; attempt += 1) {
  c = await acceptAndAnalyze(
    "Zmieniamy termin dowozu na Buniewice: zamiast środy będzie piątek.",
    [BANAN],
    "2026-09-09T08:00:00.000Z",
    SESSION,
  );
  cState = await waitForRunRetrying(c.runId, SESSION);
  console.log(`[C] attempt ${attempt} run: ${cState.run.state}; model: ${JSON.stringify(modelObservations(cState))}`);
  const candidate = cState.findings.find((f) => f.findingId === bananFinding?.findingId);
  if (candidate !== undefined && JSON.stringify(candidate.value).includes("2026-09-11")) {
    cFinding = candidate;
  } else {
    console.log(`[C] attempt ${attempt} did not correct (model variance); retrying with a fresh source`);
  }
}
const correctedToFriday =
  cFinding !== undefined &&
  JSON.stringify(cFinding.value).includes("2026-09-11");
record(
  "C/explicit-correction-supersedes",
  correctedToFriday && (cFinding?.revisionCounter ?? 0) > (bananFinding?.revisionCounter ?? 0)
    ? "PASS"
    : "FAIL",
  cFinding === undefined
    ? "finding missing"
    : `rev${cFinding.revisionCounter} value=${JSON.stringify(cFinding.value)}`,
);
record(
  "C/history-retained",
  (cFinding?.revisionCounter ?? 0) >= 2 ? "PASS" : "FAIL",
  `revisionCounter=${cFinding?.revisionCounter} (immutable superseded revisions stay in findingRevisions)`,
);

// ---------------------------------------------------------------------------
// D. resume the paused Wednesday plan after the Friday correction.
// ---------------------------------------------------------------------------
// The current finding now stands on the Friday correction (source C) and
// the paused plan's CAPTURED expectations still see the Wednesday world.
// Resume with the analysis-era caller expectations.
const resume = await memory(
  "memory.publishChangeSet",
  {
    changeSetId: pausedSet,
    expectedRevisions: [{ findingId: bananFinding.findingId, revision: bananFinding.revisionCounter }],
  },
  undefined,
  SESSION,
);
record(
  "D/stale-plan-refused",
  resume._tag === "error" && resume.error.code === "stale_plan" ? "PASS" : "FAIL",
  resume._tag === "error" ? resume.error.code : "published (!)",
);
const dFindingState = await analysisState(undefined, SESSION);
const dFinding = dFindingState.value.findings.find((f) => f.findingId === bananFinding?.findingId);
record(
  "D/friday-remains-current",
  dFinding !== undefined && JSON.stringify(dFinding.value).includes("2026-09-11") ? "PASS" : "FAIL",
  `rev${dFinding?.revisionCounter} value=${JSON.stringify(dFinding?.value)}`,
);
const pausedSetRow = dFindingState.value.changeSets.find((cs) => cs.changeSetId === pausedSet);
record(
  "D/paused-set-failed-explicitly",
  pausedSetRow?.state === "failed" ? "PASS" : "FAIL",
  `state=${pausedSetRow?.state} reason=${pausedSetRow?.failedReason}`,
);
// Re-analysis of the OLDER source A must not revert Friday.
const reanalysis = await client().action("processing/text/probe:probeKickReanalysis", {
  sourceId: a.sourceId,
});
if (reanalysis._tag !== "ok") throw new Error("reanalysis kick failed");
const rState = await waitForRunRetrying(reanalysis.value.runId, SESSION);
console.log(
  `[D] reanalysis run ${reanalysis.value.runId}: ${rState.run.state} (of ${reanalysis.value.reanalysisOfRunId}); model: ${JSON.stringify(modelObservations(rState))}`,
);
const postReanalysis = await analysisState(undefined, SESSION);
const prFinding = postReanalysis.value.findings.find((f) => f.findingId === bananFinding?.findingId);
record(
  "D/reanalysis-cannot-revert",
  prFinding !== undefined && JSON.stringify(prFinding.value).includes("2026-09-11") ? "PASS" : "FAIL",
  `rev${prFinding?.revisionCounter} value=${JSON.stringify(prFinding?.value)}`,
);
const reanalysisRun = postReanalysis.value.run.kind;

// ---------------------------------------------------------------------------
// E. mixed source: two projects + a firm fact, one group fails
// ---------------------------------------------------------------------------
const e = await acceptAndAnalyze(
  "Projekt Banan: umawiamy pomiar na czwartek. Projekt Kaczmarek: dostawa płyt w piątek. Obowiązuje zasada: każdy odbiór potwierdzamy zdjęciem.",
  [BANAN, KACZMAREK],
  "2026-09-09T09:00:00.000Z",
  SESSION,
);
// Arm a RECORDED failure for the FIRST group before groups run.
await client().action("processing/text/probe:probeArmAnalysisOutcomeFailure", {
  runId: e.runId,
  sequence: 1000,
});
const eState = await waitForRunRetrying(e.runId, SESSION);
console.log(`[E] run: ${eState.run.state}; model: ${JSON.stringify(modelObservations(eState))}`);
const eGroups = eState.steps.filter((s) => s.stepKind === "publish_group");
const eFailed = eGroups.filter((s) => s.state === "failed");
const ePublished = eGroups.filter((s) => s.state === "succeeded");
record(
  "E/one-group-failed-explicitly",
  eFailed.length === 1 && (eFailed[0]?.outputRef ?? "").includes("probe_injected_group_failure")
    ? "PASS"
    : "FAIL",
  JSON.stringify(eGroups.map((s) => [s.sequence, s.state, s.outputRef?.slice(0, 60)])),
);
record(
  "E/independent-groups-committed",
  ePublished.length >= 1 && ePublished.length === eGroups.length - 1 ? "PASS" : "FAIL",
  `${ePublished.length} published of ${eGroups.length}`,
);
record(
  "E/run-still-succeeded",
  eState.run.state === "succeeded" ? "PASS" : "FAIL",
  eState.run.state,
);

// ---------------------------------------------------------------------------
// F. crash during publication + crash-after-provider-response
// ---------------------------------------------------------------------------
const f = await acceptAndAnalyze(
  "Zapisz w pamięci firmy: serwis drukarki etykiet zaplanowany na poniedziałek 14 września 2026.",
  [],
  "2026-09-09T10:00:00.000Z",
  SESSION,
);
// Arm the THROWING marker for the first group: the publication mutation
// does its writes and then throws — the transaction rolls back.
await client().action("processing/text/probe:probeArmAnalysisFailure", {
  runId: f.runId,
  sequence: 1000,
});
const fFailedState = await waitForRunRetrying(f.runId, SESSION);
if (fFailedState.run.state !== "failed") {
  const modelStep = fFailedState.steps.find((s) => s.stepKind === "model_analysis");
  throw new Error(
    `scenario F precondition failed: run not failed (state=${fFailedState.run.state}); model step: ${modelStep?.outputRef ?? "none"}`,
  );
}
const fAttemptCount = fFailedState.attempts.length;
const fCompanyFindingsBefore = fFailedState.findings.filter(
  (x) => x.scopeKind === "company" && x.semanticKey.includes("drukark"),
).length;
record(
  "F/crash-during-publication-rolls-back",
  fFailedState.run.state === "failed" && fCompanyFindingsBefore === 0 ? "PASS" : "FAIL",
  `run=${fFailedState.run.state} findingsBefore=${fCompanyFindingsBefore}`,
);
// Disarm, then restart from the journal: load+model replay from the journal
// (no provider re-call), the crashed group re-executes exactly once.
await client().action("processing/text/probe:probeDisarmAnalysisFailure", {
  runId: f.runId,
  sequence: 1000,
});
const checkpoint = JSON.parse(fFailedState.run.checkpoint ?? "{}");
if (typeof checkpoint.workflowId !== "string") throw new Error("workflowId missing from checkpoint");
const restartOutcome = await client().action("processing/text/probe:probeRestartAnalysis", {
  workflowId: checkpoint.workflowId,
  from: "group",
  runId: f.runId,
});
if (restartOutcome._tag !== "ok") throw new Error("restart failed");
const fRecovered = await waitForRun(f.runId, 900_000, SESSION);
const fAttemptCountAfter = fRecovered.attempts.length;
const fCompanyFindingsAfter = fRecovered.findings.filter(
  (x) => x.scopeKind === "company" && x.semanticKey.includes("drukark"),
);
const fSets = fRecovered.changeSets.filter((c) => c.sourceId === f.sourceId && c.state === "published");
console.log(`[F] recovered run: ${fRecovered.run.state}; model: ${JSON.stringify(modelObservations(fRecovered))}`);
record(
  "F/restart-recovers-run",
  fRecovered.run.state === "succeeded" ? "PASS" : "FAIL",
  fRecovered.run.state,
);
record(
  "F/no-provider-recall-after-crash",
  fAttemptCountAfter === fAttemptCount ? "PASS" : "FAIL",
  `attempts ${fAttemptCount} -> ${fAttemptCountAfter} (journal replay)`,
);
record(
  "F/no-duplicate-publication",
  fCompanyFindingsAfter.length === 1 && fSets.length === 1 && fCompanyFindingsAfter[0].revisionCounter === 1
    ? "PASS"
    : "FAIL",
  `findings=${fCompanyFindingsAfter.length} publishedSets=${fSets.length} rev=${fCompanyFindingsAfter[0]?.revisionCounter}`,
);

// ---------------------------------------------------------------------------
// Wrap-up: tenant sanity (the isolation fixture owns nothing here).
// ---------------------------------------------------------------------------
record(
  "Z/reanalysis-linked-new-run",
  reanalysis.value.reanalysisOfRunId !== null && reanalysisRun === "reanalysis" ? "PASS" : "FAIL",
  `of=${reanalysis.value.reanalysisOfRunId}`,
);

if (!summarize()) {
  process.exit(1);
}
