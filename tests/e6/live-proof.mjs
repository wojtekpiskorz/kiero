/**
 * E6 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/e6, instance energetic-parakeet-16,
 * EU).
 *
 * The answer flow runs FOR REAL here: fixture findings are published
 * through C2's REAL checked dispatch probes (the C5 live-proof recipe), the
 * withdrawal that produces the updating state goes through the checked
 * sources.withdrawSource dispatch and the durable recomputation executor,
 * and every question runs the bounded answer loop through E2's chat adapter
 * against the real accepted chat route (glm-5.3-flash first) with the
 * seven typed tools — decoded, context-validated, executed only through the
 * checked domain path.
 *
 * Scenarios (issue #40 focused verification):
 *  A. a grounded Polish question -> a source-backed answer with fragment
 *     citations; the amount is exact, the not_specified tax basis is
 *     visible, no VAT is guessed;
 *  B. an ambiguous question (two conflicting sources) -> a clarification
 *     citing BOTH fragments (memory.clarificationRaised), not a guess;
 *  C. a question touching an updating finding -> honestly disclosed, never
 *     presented as established (the C5 gate through the answer contract);
 *  D. a domain-tool round trip -> a task created from the answer through
 *     the checked work.changeTask core with the question source as basis.
 *
 * Run: node tests/e6/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: routing metadata, states, ids and Polish
 * product text only — no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "energetic-parakeet-16";
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
    sessionId,
  });
const withdraw = (sourceId, reason, sessionId) =>
  client().action("memory/recompute/probe:probeWithdrawSource", {
    envelope: envelope("sources.withdrawSource", { sourceId, reason }),
    sessionId,
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tenant-scoped agent state (findings/tasks/events/clarifications). */
async function agentState(sessionId) {
  const result = await client().action("agent/probe:probeAgentState", { sessionId });
  if (result._tag !== "ok") throw new Error(`agentState failed: ${JSON.stringify(result)}`);
  return result.value;
}

/** Runs the REAL answer loop for one question source (single action). */
async function askOnce(questionSourceId) {
  return client().action("agent/probe:probeAskAgent", { questionSourceId });
}

/** Runs ONE round, retrying transport/provider failures with the SAME state. */
async function runRound(questionSourceId, roundState, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await client().action("agent/probe:probeAnswerRound", {
        questionSourceId,
        roundState,
      });
    } catch (error) {
      // The synchronous wait can die at the edge even though the round ran;
      // re-running the same round state is bounded and recorded honestly.
      if (attempt < attempts - 1) {
        console.log(`[retry] round transport error; re-running round (${attempt + 1})`);
        await sleep(5_000);
        continue;
      }
      throw error;
    }
    if (response._tag !== "ok") {
      throw new Error(`round failed: ${JSON.stringify(response).slice(0, 400)}`);
    }
    if (
      response.value.kind === "done" &&
      response.value.result.outcome === "provider_failed" &&
      attempt < attempts - 1
    ) {
      console.log(
        `[retry] round provider_failed (${response.value.result.failure ?? "?"}); re-running round (${attempt + 1})`,
      );
      await sleep(3_000);
      continue;
    }
    return response.value;
  }
}

/**
 * Runs the REAL answer loop round-by-round: each round is one bounded
 * action call (start, then one provider turn + its checked executions), so
 * no single synchronous action has to outlive the transport window. The
 * round core is the SAME one the production loop drives internally.
 */
async function askRetrying(questionSourceId) {
  const start = await client().action("agent/probe:probeStartAnswerRun", {
    questionSourceId,
  });
  if (start._tag !== "ok") {
    throw new Error(`ask start failed: ${JSON.stringify(start).slice(0, 400)}`);
  }
  let outcome = start.value;
  let rounds = 0;
  while (outcome.kind === "continue") {
    rounds += 1;
    if (rounds > 8) {
      throw new Error("ask: round budget exceeded");
    }
    outcome = await runRound(questionSourceId, outcome.next);
  }
  return outcome.result;
}

/** Sanitized model observations for the evidence record. */
function modelObservations(run) {
  return {
    observedModels: run.observedModels,
    turns: run.turns,
    calls: run.turnLog.map((t) => t.calls),
    results: run.turnLog.map((t) => t.results.map((r) => r.slice(0, 120))),
  };
}

/** Publishes one finding through the REAL checked dispatch. */
async function publishOne(sourceId, planned, sessionId) {
  const prepared = await memory(
    "memory.prepareChangeSet",
    { sourceId, plannedRevisions: [planned] },
    sessionId,
  );
  if (prepared._tag !== "ok") {
    throw new Error(`prepare failed: ${JSON.stringify(prepared).slice(0, 400)}`);
  }
  const published = await memory(
    "memory.publishChangeSet",
    { changeSetId: prepared.value.changeSetId, expectedRevisions: [] },
    sessionId,
  );
  if (published._tag !== "ok") {
    throw new Error(`publish failed: ${JSON.stringify(published).slice(0, 400)}`);
  }
}

console.log(`# E6 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures: a FRESH proof company per pass (deterministic context) ----------
const NONCE = String(Date.now());
const seed = await client().action("agent/probe:probeSeedE6Company", { nonce: NONCE });
if (seed._tag !== "ok") throw new Error(`probeSeedE6Company failed: ${JSON.stringify(seed)}`);
const SESSION = seed.value.sessionId;
const BANAN = seed.value.bananId;
console.log(
  `# fixtures: fresh company=${seed.value.companyId} session=<seeded> banan=${BANAN} nonce=${NONCE}`,
);

/** Seeds one witnessed source in the proof company (optionally project-linked). */
async function seedSource(acceptanceKey, authorText, sentAtIso, projectId) {
  const result = await client().action("agent/probe:probeSeedE6Source", {
    sessionId: SESSION,
    acceptanceKey,
    authorText,
    sentAtIso,
    ...(projectId === undefined ? {} : { projectId }),
  });
  if (result._tag !== "ok") throw new Error(`seedSource failed: ${JSON.stringify(result)}`);
  return result.value;
}

const key = (base) => `${base}.${NONCE}`;

// ---------------------------------------------------------------------------
// A. a grounded question -> a source-backed answer with citations
// ---------------------------------------------------------------------------
const S_DEPOSIT = await seedSource(
  `e6-deposit-${NONCE}`,
  "Kaczmarek wpłacił zaliczkę 5000 na konto. Potwierdził to telefonicznie.",
  "2026-09-08T16:30:00.000Z",
  BANAN,
);
await publishOne(
  S_DEPOSIT.sourceId,
  {
    findingId: null,
    scope: { _tag: "project", projectId: BANAN },
    semanticKey: key("zaliczka_klienta"),
    value: {
      _tag: "money",
      money: {
        role: "deposit_received",
        amount: { _tag: "exact", value: "5000" },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "not_specified",
        certainty: "exact",
      },
    },
    knowledgeState: { _tag: "known" },
    effectiveFrom: null,
    evidence: [
      { sourceId: S_DEPOSIT.sourceId, fragmentId: S_DEPOSIT.fragmentId, supportKind: "support" },
    ],
    derivesFrom: [],
  },
  SESSION,
);
const Q_A = await seedSource(
  `e6-question-a-${NONCE}`,
  "Pytanie do biura: jaka zaliczka wpłynęła od Kaczmarka i czy to netto?",
  "2026-09-09T07:30:00.000Z",
);
const aRun = await askRetrying(Q_A.sourceId);
console.log(`[A] run: ${JSON.stringify(modelObservations(aRun))}`);
console.log(`[A] answerText: ${aRun.answer === null ? "(brak)" : aRun.answer.answerText}`);
record("A/run-answered", aRun.outcome === "answered" ? "PASS" : "FAIL", aRun.outcome);
record(
  "A/versions-recorded",
  aRun.versions.pipeline === "e6.answer/2" &&
    aRun.versions.tools === "e6.tools/1" &&
    aRun.versions.prompt === "e6.prompt-pl/4" &&
    aRun.versions.modelConfiguration === "e6.routing#chat_analysis"
    ? "PASS"
    : "FAIL",
  JSON.stringify(aRun.versions),
);
const aStatement = aRun.answer?.statements?.[0] ?? null;
record(
  "A/statement-grounded",
  aStatement !== null &&
    (aStatement.basis === "direct" || aStatement.basis === "corroboration") &&
    aStatement.evidenceIds.length >= 1
    ? "PASS"
    : "FAIL",
  aStatement === null ? "no statement" : `${aStatement.basis} ${aStatement.evidenceIds.join(",")}`,
);
const aCitations = (aRun.answer?.statements ?? []).flatMap((s) => s.evidenceIds);
const aCited = aCitations.map((id) => aRun.evidence.find((e) => e.evidenceId === id));
record(
  "A/citations-resolve-to-source",
  aCited.length >= 1 && aCited.every((entry) => entry !== undefined && entry.sourceId === S_DEPOSIT.sourceId)
    ? "PASS"
    : "FAIL",
  aCited.map((entry) => entry?.sourceId ?? "?").join(","),
);
const aText = aRun.answer?.answerText ?? "";
record(
  "A/exact-amount-visible",
  aText.includes("5000") ? "PASS" : "FAIL",
  aText.slice(0, 200),
);
// The basis must be visibly not_specified and no VAT may be COMPUTED:
// mentioning the word VAT while stating the basis is unknown is honest,
// a guess would be a derived number (6150, 23%, netto/brutto + amount).
record(
  "A/not_specified-basis-visible-no-guessed-vat",
  /nie ?określon|not.?specified/i.test(aText) &&
    !/6150|23\s?%|(netto|brutto)\s*[:–-]?\s*\d/i.test(aText)
    ? "PASS"
    : "FAIL",
  aText.slice(0, 200),
);

// ---------------------------------------------------------------------------
// B. an ambiguous question -> a clarification, not a guess
// ---------------------------------------------------------------------------
// Genuinely unresolvable in context: OUR plan says Wednesday, the CLIENT
// proposes Friday — no correction marker, no authority to pick a side. An
// explicit "Poprawka:" pair would be resolvable in context (supersession)
// and is the wrong fixture for the ask-don't-guess discipline.
const S_CONFLICT_A = await seedSource(
  `e6-montaz-a-${NONCE}`,
  "Zaplanowaliśmy montaż u Kaczmarka na środę.",
  "2026-09-08T17:00:00.000Z",
  BANAN,
);
const S_CONFLICT_B = await seedSource(
  `e6-montaz-b-${NONCE}`,
  "Kaczmarek proponuje montaż w piątek, bo środa mu nie pasuje.",
  "2026-09-08T17:20:00.000Z",
  BANAN,
);
const Q_B = await seedSource(
  `e6-question-b-${NONCE}`,
  "Kiedy mamy montaż u Kaczmarka?",
  "2026-09-09T08:00:00.000Z",
);
const bRun = await askRetrying(Q_B.sourceId);
console.log(`[B] run: ${JSON.stringify(modelObservations(bRun))}`);
console.log(`[B] clarifications: ${JSON.stringify(bRun.clarificationsRaised)}`);
record(
  "B/clarified-not-guessed",
  bRun.clarificationsRaised.length >= 1 && bRun.answer === null ? "PASS" : "FAIL",
  `outcome=${bRun.outcome} answers=${bRun.answer === null ? 0 : 1} clarifications=${bRun.clarificationsRaised.length}`,
);
const bState = await agentState(SESSION);
const bClarification = bState.clarifications.find(
  (c) => c.clarificationId === bRun.clarificationsRaised[0]?.clarificationId,
);
record(
  "B/clarification-row-cites-both-sides",
  bClarification !== undefined &&
    bClarification.state === "open" &&
    bClarification.conflictingFragmentIds.length >= 2
    ? "PASS"
    : "FAIL",
  bClarification === undefined
    ? "no row"
    : `fragments=${bClarification.conflictingFragmentIds.length} state=${bClarification.state}`,
);
console.log(`[B] question: ${bClarification?.question ?? "?"}`);

// ---------------------------------------------------------------------------
// C. a question touching an updating finding -> disclosed, not established
// ---------------------------------------------------------------------------
const S_BASIS = await seedSource(
  `e6-basis-${NONCE}`,
  "Dostawa płytek na Buniewice uzgodniona na piątek rano.",
  "2026-09-07T15:00:00.000Z",
  BANAN,
);
await publishOne(
  S_BASIS.sourceId,
  {
    findingId: null,
    scope: { _tag: "project", projectId: BANAN },
    semanticKey: key("termin_dostawy_baza"),
    value: {
      _tag: "temporal",
      temporal: { shape: { _tag: "day", day: "2026-09-11" }, originalExpression: "w piątek rano", role: "agreed" },
    },
    knowledgeState: { _tag: "known" },
    effectiveFrom: null,
    evidence: [
      { sourceId: S_BASIS.sourceId, fragmentId: S_BASIS.fragmentId, supportKind: "support" },
    ],
    derivesFrom: [],
  },
  SESSION,
);
{
  const st = await agentState(SESSION);
  const basisFinding = st.findings.find((f) => f.semanticKey === key("termin_dostawy_baza"));
  if (basisFinding === undefined) throw new Error("basis finding missing");
  const S_DERIVE = await seedSource(
    `e6-derive-${NONCE}`,
    "Skoro dostawa w piątek rano, ryzyko kary za opóźnienie jest niskie.",
    "2026-09-07T16:00:00.000Z",
    BANAN,
  );
  await publishOne(
    S_DERIVE.sourceId,
    {
      findingId: null,
      scope: { _tag: "project", projectId: BANAN },
      semanticKey: key("wniosek_ryzyko"),
      value: { _tag: "text_note", text: "ryzyko kary za opóźnienie jest niskie" },
      knowledgeState: { _tag: "known" },
      effectiveFrom: null,
      evidence: [],
      derivesFrom: [basisFinding.findingId],
    },
    SESSION,
  );
}
// Withdraw the basis source: the durable recomputation marks the derived
// conclusion updating-until-revalidated (the C5 gate input for this proof).
const withdrawn = await withdraw(S_BASIS.sourceId, "e6-proof: basis statement was wrong", SESSION);
if (withdrawn._tag !== "ok") throw new Error(`withdraw failed: ${JSON.stringify(withdrawn)}`);
let updatingFindingId = null;
{
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const st = await agentState(SESSION);
    const risk = st.findings.find((f) => f.semanticKey === key("wniosek_ryzyko"));
    if (risk !== undefined && risk.knowledgeState?._tag === "updating") {
      updatingFindingId = risk.findingId;
      break;
    }
    await sleep(1_500);
  }
}
record(
  "C/fixture-updating-established",
  updatingFindingId !== null ? "PASS" : "FAIL",
  updatingFindingId ?? "never became updating",
);
const Q_C = await seedSource(
  `e6-question-c-${NONCE}`,
  "Czy ryzyko kary za opóźnienie jest u nas niskie?",
  "2026-09-09T09:00:00.000Z",
);
const cRun = await askRetrying(Q_C.sourceId);
console.log(`[C] run: ${JSON.stringify(modelObservations(cRun))}`);
console.log(`[C] answerText: ${cRun.answer === null ? "(brak)" : cRun.answer.answerText}`);
const cCitedEvidence = (cRun.answer?.statements ?? []).flatMap((s) => s.evidenceIds);
const cCitedEntries = cCitedEvidence
  .map((id) => cRun.evidence.find((e) => e.evidenceId === id))
  .filter((entry) => entry !== undefined);
record(
  "C/updating-never-established",
  cRun.answer === null || cCitedEntries.every((entry) => !entry.groundsUpdating)
    ? "PASS"
    : "FAIL",
  cCitedEntries.map((entry) => `${entry.evidenceId}:updating=${entry.groundsUpdating}`).join(",") || "no citations",
);
// The honest exclusion may take either terminal the answer contract allows:
// a disclosed answer (updatingFindingIds carries the finding) OR a sourced
// clarification about the finding's status. Both exclude the updating value
// from established statements; neither presents it as settled truth.
const cClarifiedExclusion = async () => {
  if (cRun.clarificationsRaised.length < 1) {
    return false;
  }
  const st = await agentState(SESSION);
  return cRun.clarificationsRaised.every((raised) => {
    const row = st.clarifications.find((c) => c.clarificationId === raised.clarificationId);
    return row !== undefined && row.state === "open";
  });
};
const cDisclosed =
  cRun.answer !== null &&
  cRun.answer.disclosures.updatingFindingIds.includes(updatingFindingId);
const cExcludedByQuestion = cRun.answer === null && (await cClarifiedExclusion());
record(
  "C/updating-disclosed",
  cDisclosed || cExcludedByQuestion ? "PASS" : "FAIL",
  cRun.answer !== null
    ? `disclosures=${JSON.stringify(cRun.answer.disclosures.updatingFindingIds)}`
    : `excluded-by-question=${cExcludedByQuestion} (outcome=${cRun.outcome})`,
);

// ---------------------------------------------------------------------------
// D. a domain-tool round trip: a task created from the answer
// ---------------------------------------------------------------------------
const Q_D = await seedSource(
  `e6-question-d-${NONCE}`,
  "Proszę zapisz w Bananie zadanie: zamówić płytki na piątek.",
  "2026-09-09T09:30:00.000Z",
);
const dRun = await askRetrying(Q_D.sourceId);
console.log(`[D] run: ${JSON.stringify(modelObservations(dRun))}`);
console.log(`[D] changes: ${JSON.stringify(dRun.changes)}`);
record(
  "D/task-change-executed",
  dRun.changes.some((change) => change.kind === "task") ? "PASS" : "FAIL",
  dRun.changes.map((change) => `${change.operation}:${change.entityId}:r${change.revision}`).join(",") || "none",
);
{
  const st = await agentState(SESSION);
  const createdTask = st.tasks.find(
    (task) => dRun.changes.some((change) => change.entityId === task.taskId),
  );
  record(
    "D/task-row-in-project",
    createdTask !== undefined &&
      createdTask.projectId === BANAN &&
      createdTask.state === "todo" &&
      createdTask.revisionCounter >= 1
      ? "PASS"
      : "FAIL",
    createdTask === undefined
      ? "no row"
      : `${createdTask.title} state=${createdTask.state} rev=${createdTask.revisionCounter}`,
  );
  console.log(`[D] task: ${createdTask === undefined ? "?" : createdTask.title}`);
}

const finalState = await agentState(SESSION);
console.log(
  `\n# final state summary: ${JSON.stringify({
    findings: finalState.findings.length,
    clarifications: finalState.clarifications.map((c) => ({
      id: c.clarificationId,
      state: c.state,
      question: c.question.slice(0, 60),
    })),
    tasks: finalState.tasks.length,
  })}`,
);

process.exit(summarize() ? 0 : 1);
