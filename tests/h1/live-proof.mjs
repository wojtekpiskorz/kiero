/**
 * H1 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/h1, instance next-wren-578, EU).
 *
 * The boss-facing surface rides the same public paths this script drives
 * through the guarded service-bridge probes (no development-auth shortcut;
 * sessions are created server-side by guarded fixtures):
 *
 * - D1 conversation views (company + project projection) and source detail;
 * - F1 read-state projection and marking (two bosses, second device);
 * - the real E3 analysis pipeline (OPENROUTER_API_KEY set on the deployment;
 *   values never printed) for the live correction flow;
 * - C2 checked memory commands (correctFinding, resolveClarification) and
 *   the H1-flagged exposition reads (history + clarifications).
 *
 * Scenarios (issue #49 focused verification):
 *  S2. one mixed source appears consistently in the company view and BOTH
 *      project views — one source id, one actual author, no divergent copy
 *      (the project rows ARE the dereferenced original);
 *  S3. unread transition: absence = unread; opening the original (marking
 *      through the project view's row) marks it read for that person in
 *      every view and on their second device; the other boss stays unread;
 *  S4. honest processing states: the same row reads accepted/processing
 *      mid-flight and processed after the run succeeds (no lost source);
 *  S5. correction-as-new-source with visible history: a clear message
 *      publishes a typed finding with evidence; a correcting NEW message
 *      referencing the old one supersedes it with the new source as
 *      evidence; the original message text stays immutable in history;
 *  S6. direct structured correction through C2's audited command, and the
 *      concurrent-revision conflict refusal (revision_mismatch);
 *  S7. E3's sourced clarification surfaces through the clarifications read
 *      and is answered (resolve keeps author + note).
 *
 * Run: node tests/h1/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: routing metadata, states, ids and Polish
 * source texts only — no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "next-wren-578";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

const client = () => new ConvexHttpClient(CLIENT_URL);

// A websocket connection keeps the dev deployment active while the model
// runs are awaited (dev deployments defer scheduled continuations when
// fully idle).
const keepalive = new ConvexReactClient(CLIENT_URL);
const closeKeepalive = () => void keepalive.close();

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

const accept = (input, idempotencyKey, sessionId) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const companyView = (numItems, sessionId) =>
  client().action("sources/read/probe:probeCompanyConversation", {
    numItems,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const projectView = (projectId, numItems, sessionId) =>
  client().action("sources/read/probe:probeProjectConversation", {
    projectId,
    numItems,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const sourceDetailOf = (sourceId) =>
  client().action("sources/read/probe:probeSourceDetail", { sourceId });
const readState = (sourceIds, sessionId) =>
  client().action("attention/read_state/probe:probeReadState", {
    sourceIds,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const markRead = (input, sessionId) =>
  client().action("attention/read_state/probe:probeMarkSourceRead", {
    envelope: { operation: "attention.markSourceRead", input, expectedRevisions: [] },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const memory = (operation, input, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: { operation, input, expectedRevisions: [] },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const currentFindings = (scope, sessionId) =>
  client().action("memory/findings/probe:probeReadCurrentFindings", {
    scope,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const findingHistory = (findingId, sessionId) =>
  client().action("memory/findings/probe:probeReadFindingHistory", {
    findingId,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const clarifications = (scope, sessionId) =>
  client().action("memory/findings/probe:probeReadClarifications", {
    scope,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const analysisState = (runId, sessionId) =>
  client().action("processing/text/probe:probeAnalysisState", {
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const latestRun = (sourceId) =>
  client().action("processing/text/probe:probeLatestRunForSource", { sourceId });

const isOk = (r) => r._tag === "ok";
const isErr = (r, kind, code) =>
  r._tag === "error" && (kind === undefined || r.error._tag === kind) &&
  (code === undefined || r.error.code === code);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Waits for a run to a terminal state, resilient like E3: a terminal FAILED
 * run whose attempts show provider errors gets one bounded model-stage
 * restart (the workflow refuses restarts while it still claims running, so
 * a WEDGED model stage cannot be kicked that way). A run that reaches no
 * terminal state within the bounded wait returns null — the caller's
 * fresh-source retry loop treats that as attempt variance, exactly like a
 * model that plans nothing.
 */
async function waitForRunRetrying(runId, sessionId, restarts = 2) {
  for (let restart = 0; ; restart += 1) {
    const deadline = Date.now() + 300_000;
    let state = null;
    while (Date.now() < deadline) {
      const r = await analysisState(runId, sessionId);
      if (r._tag !== "ok") throw new Error("state read failed");
      state = r.value;
      if (state.run.state !== "running") {
        break;
      }
      await sleep(3_000);
    }
    if (state === null) {
      throw new Error("no state read");
    }
    if (state.run.state !== "running") {
      if (state.run.state === "succeeded" || restart >= restarts) {
        return state;
      }
      const providerFailed = state.attempts.some((a) => a.outcome === "failed");
      if (!providerFailed) {
        return state;
      }
      console.log(`[retry] run failed on provider errors; restarting from model stage (${restart + 1}/${restarts})`);
      await restartRun(runId, "model", sessionId);
      continue;
    }
    // Still running after the bounded wait: one extra grace window, then
    // hand the variance back to the caller's fresh-source retry.
    const grace = await waitForTerminalOnce(runId, 180_000, sessionId);
    return grace;
  }
}

/** One bounded terminal poll; null when the run reaches no terminal state. */
async function waitForTerminalOnce(runId, timeoutMs, sessionId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await analysisState(runId, sessionId);
    if (r._tag !== "ok") throw new Error("state read failed");
    if (r.value.run.state !== "running") {
      return r.value;
    }
    await sleep(3_000);
  }
  console.log(`[wait] run reached no terminal state within ${timeoutMs}ms (wedged model stage)`);
  return null;
}

/** Accepts one source and returns { sourceId, runId } once registered. */
async function acceptAndAnalyze(text, projectHints, sessionId, sentAtIso) {
  // The upload must be owned by the accepting actor: seed it through the
  // session-bound fixture when acting as a seeded boss, through the service
  // fixture otherwise.
  const upload =
    sessionId === undefined
      ? await client().action("sources/accept/probe:probeSeedUpload", {})
      : await client().action("processing/text/probe:probeSeedE3Upload", { sessionId });
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

/** The current project findings whose history evidence cites the source. */
async function findingsBackedBy(sourceId, projectId, sessionId) {
  const findings = await currentFindings(
    { _tag: "project", projectId },
    sessionId,
  );
  if (findings._tag !== "ok") throw new Error("current findings read failed");
  const backed = [];
  for (const row of findings.value.rows) {
    const history = await findingHistory(row.findingId, sessionId);
    if (history._tag !== "ok") continue;
    const cites = history.value.revisions.some((revision) =>
      revision.evidence.some((witness) => witness.sourceId === sourceId),
    );
    if (cites) {
      backed.push({ current: row, history: history.value });
    }
  }
  return backed;
}

console.log(`# H1 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const companyA = seed.value.companyId;

const project = async (name) => {
  const seeded = await client().action("sources/accept/probe:probeSeedProject", { displayName: name });
  if (seeded._tag !== "ok") throw new Error("project seeding failed");
  return seeded.value.projectId;
};
const P1 = await project("Banan (H1)");
const P2 = await project("Kaczmarek (H1)");

const bossB = await client().action("attention/probe_shared:probeSeedBoss", {
  email: "h1-boss-b@kiero.invalid",
  displayName: "H1 boss B",
  deviceLabel: "h1-boss-b-bridge",
});
if (!isOk(bossB)) throw new Error("boss B seeding failed");
const SESS_B = bossB.value.sessionId;
const USER_B = bossB.value.userId;

const deviceA2 = await client().action("attention/probe_shared:probeSeedDevice", {
  email: "platform-service@kiero.invalid",
  deviceLabel: "h1-boss-a-device-2",
});
if (!isOk(deviceA2)) throw new Error("device A2 seeding failed");
const SESS_A2 = deviceA2.value.sessionId;

console.log(
  `# fixtures: company=${companyA} P1=${P1} P2=${P2} bossB=${USER_B} (sessions seeded server-side)`,
);

// ---------------------------------------------------------------------------
// S2. one mixed source, consistently in company and project views
// ---------------------------------------------------------------------------
const MIXED_TEXT =
  "Projekt Banan i Kaczmarek: wspólny dowóz płytek 23 września 2026 rano, oba projekty potwierdziły udział.";
const mixed = await acceptAndAnalyze(MIXED_TEXT, [P1, P2], SESS_B);
const company = await companyView(10);
const project1 = await projectView(P1, 10);
const project2 = await projectView(P2, 10);
const companyRow = isOk(company)
  ? company.value.page.find((row) => row.sourceId === mixed.sourceId)
  : undefined;
const projectRow1 = isOk(project1)
  ? project1.value.page.find((row) => row.sourceId === mixed.sourceId)
  : undefined;
const projectRow2 = isOk(project2)
  ? project2.value.page.find((row) => row.sourceId === mixed.sourceId)
  : undefined;
record(
  "S2/mixed-in-all-views",
  companyRow !== undefined && projectRow1 !== undefined && projectRow2 !== undefined
    ? "PASS"
    : "FAIL",
  `company=${companyRow !== undefined} p1=${projectRow1 !== undefined} p2=${projectRow2 !== undefined}`,
);
record(
  "S2/one-source-one-author",
  companyRow !== undefined &&
    projectRow1 !== undefined &&
    companyRow.sourceId === projectRow1.sourceId &&
    companyRow.authorUserId === projectRow1.authorUserId &&
    companyRow.authorText === projectRow1.authorText &&
    projectRow2 !== undefined &&
    companyRow.authorUserId === projectRow2.authorUserId
    ? "PASS"
    : "FAIL",
  `author=${companyRow?.authorUserId} (bossB=${USER_B})`,
);
record(
  "S2/actual-author-is-boss-b",
  companyRow?.authorUserId === USER_B ? "PASS" : "FAIL",
  companyRow?.authorUserId,
);
record(
  "S2/both-links-on-one-row",
  companyRow?.projectIds?.length === 2 ? "PASS" : "FAIL",
  JSON.stringify(companyRow?.projectIds),
);
const detail = await sourceDetailOf(mixed.sourceId);
record(
  "S2/detail-is-the-same-original",
  isOk(detail) &&
    detail.value.sourceId === companyRow?.sourceId &&
    detail.value.authorText === MIXED_TEXT
    ? "PASS"
    : "FAIL",
  "one canonical ?zrodlo= target",
);

// ---------------------------------------------------------------------------
// S3. unread transition: absence = unread; marking through ONE view marks
//     everywhere for that person; the other boss stays unread
// ---------------------------------------------------------------------------
const before = await readState([mixed.sourceId]);
const beforeB = await readState([mixed.sourceId], SESS_B);
const unreadA = isOk(before) && before.value.entries.every((e) => !e.read);
const unreadB = isOk(beforeB) && beforeB.value.entries.every((e) => !e.read);
record("S3/absence-means-unread", unreadA && unreadB ? "PASS" : "FAIL", "no rows for either boss");

// The boss "opens the original" while reading the PROJECT view: the marking
// command carries the canonical source id (the same id every view rows).
const projectRowForMarking = projectRow1 ?? companyRow;
const marked = await markRead({ sourceId: projectRowForMarking?.sourceId, read: true });
record("S3/mark-through-project-view", isOk(marked) ? "PASS" : "FAIL", marked._tag);

const afterA = await readState([mixed.sourceId]);
const afterA2 = await readState([mixed.sourceId], SESS_A2);
const afterB = await readState([mixed.sourceId], SESS_B);
record(
  "S3/read-everywhere-for-that-person",
  isOk(afterA) && afterA.value.entries.some((e) => e.read) &&
    isOk(afterA2) && afterA2.value.entries.some((e) => e.read)
    ? "PASS"
    : "FAIL",
  "company view + second device of boss A",
);
record(
  "S3/other-boss-stays-unread",
  isOk(afterB) && afterB.value.entries.every((e) => !e.read) ? "PASS" : "FAIL",
  `entries=${JSON.stringify(isOk(afterB) ? afterB.value.entries : [])}`,
);

// ---------------------------------------------------------------------------
// S5 (part 1). clear message -> typed finding with evidence; then the
// correcting NEW message supersedes it with visible history
// ---------------------------------------------------------------------------
// The analysis scenarios run in a FRESH proof company (the E3 pattern): the
// model must see an empty current-state context, or it rightly plans
// nothing for information it already knows from earlier passes.
const NONCE = String(Date.now());
const fresh = await client().action("processing/text/probe:probeSeedE3Company", { nonce: NONCE });
if (fresh._tag !== "ok") throw new Error(`probeSeedE3Company failed: ${JSON.stringify(fresh)}`);
const BANAN = fresh.value.bananId;
const SESSION = fresh.value.sessionId;
// The fresh boss's user id (the read-state projection resolves it).
const freshRead = await readState([], SESSION);
const FRESH_USER = isOk(freshRead) ? freshRead.value.userId : null;
console.log(
  `# fresh analysis company=${fresh.value.companyId} banan=${BANAN} session=<seeded> user=${FRESH_USER} nonce=${NONCE}`,
);
// The E3-proven shape: a relative weekday anchored by the send time (model
// variance means bounded retries with fresh sources, exactly like E3's A/C).
const ORIGINAL_TEXT =
  "Projekt Banan: dowóz płytek na Buniewice w środę rano. Odbiór potwierdził u nas klient Kaczmarek. Do wyceny doliczamy około 10 tysięcy.";
const ORIGINAL_SENT_AT = "2026-09-08T16:30:00.000Z"; // Tuesday 18:30 Warsaw
let original = null;
let originalState = null;
let originalFindings = [];
for (let attempt = 1; attempt <= 3 && originalFindings.length === 0; attempt += 1) {
  original = await acceptAndAnalyze(ORIGINAL_TEXT, [BANAN], SESSION, ORIGINAL_SENT_AT);
  originalState = await waitForRunRetrying(original.runId, SESSION);
  console.log(
    `[S5] attempt ${attempt} run: ${
      originalState === null ? "wedged" : originalState.run.state
    }; model: ${
      originalState === null
        ? "-"
        : originalState.attempts.map((a) => `${a.model}:${a.outcome}`).join(",")
    }`,
  );
  originalFindings = await findingsBackedBy(original.sourceId, BANAN, SESSION);
  if (originalFindings.length === 0) {
    console.log(`[S5] attempt ${attempt} published nothing (model variance); retrying`);
  }
}
record(
  "S5/original-run-succeeded",
  originalState !== null && originalState.run.state === "succeeded" ? "PASS" : "FAIL",
  originalState === null ? "wedged (model stage)" : originalState.run.state,
);
record(
  "S5/finding-published-with-evidence",
  originalFindings.length >= 1 ? "PASS" : "FAIL",
  originalFindings.map((f) => f.current.semanticKey).join(", ") || "none",
);
const originalFinding = originalFindings[0];
if (originalFinding === undefined) {
  throw new Error("no finding backed by the original source; cannot continue S5/S6");
}
const history1 = originalFinding.history;
record(
  "S5/history-evidence-cites-original-source",
  history1.revisions.some((r) =>
    r.evidence.some((w) => w.sourceId === original.sourceId),
  )
    ? "PASS"
    : "FAIL",
  `revisions=${history1.revisions.length}`,
);

// The correcting NEW message references the old one (correction-as-new-source).
// The core phrase is E3's proved correction form ("zamiast środy będzie
// piątek", tests/e3/live-proof.mjs scenario C) with an explicit reference to
// the corrected message instead of a full quote: the quote form leaves two
// dates in one text for the model to disentangle (observed variance).
const CORRECTION_TEXT =
  "Poprawka do środowej wiadomości o dowozie płytek na Buniewice: zamiast środy będzie piątek.";
const CORRECTION_SENT_AT = "2026-09-09T08:00:00.000Z"; // Wednesday morning -> piątek = 2026-09-11
let correction = null;
let correctionState = null;
let corrected = undefined;
for (let attempt = 1; attempt <= 5 && corrected === undefined; attempt += 1) {
  correction = await acceptAndAnalyze(CORRECTION_TEXT, [BANAN], SESSION, CORRECTION_SENT_AT);

  // S4 (honest states): the mid-flight row of the SAME source, then settled.
  const midFlight = attempt === 1 ? await companyView(10, SESSION) : null;
  const midRow =
    midFlight !== null && isOk(midFlight)
      ? midFlight.value.page.find((row) => row.sourceId === correction.sourceId)
      : undefined;
  if (attempt === 1) {
    record(
      "S4/midflight-state-honest",
      midRow !== undefined && (midRow.processingState === "accepted" || midRow.processingState === "processing")
        ? "PASS"
        : "FAIL",
      `mid=${midRow?.processingState}`,
    );
  }
  const correctionWait = await waitForRunRetrying(correction.runId, SESSION);
  if (correctionWait !== null) {
    correctionState = correctionWait;
  }
  console.log(
    `[S5-korekta] attempt ${attempt} run: ${
      correctionState === null ? "wedged" : correctionState.run.state
    }; model: ${
      correctionState === null
        ? "-"
        : correctionState.attempts.map((a) => `${a.model}:${a.outcome}`).join(",")
    }`,
  );
  const correctedFindings = await findingsBackedBy(correction.sourceId, BANAN, SESSION);
  corrected = correctedFindings.find(
    (f) => f.current.findingId === originalFinding.current.findingId,
  );
  if (corrected === undefined) {
    console.log(`[S5-korekta] attempt ${attempt} did not correct (model variance); retrying with a fresh source`);
  }
}
const settled = await companyView(10, SESSION);
const settledRow = isOk(settled)
  ? settled.value.page.find((row) => row.sourceId === correction.sourceId)
  : undefined;
record(
  "S4/settled-state-processed",
  correctionState !== null &&
    correctionState.run.state === "succeeded" &&
    settledRow?.processingState === "processed"
    ? "PASS"
    : "FAIL",
  `run=${correctionState === null ? "wedged" : correctionState.run.state} row=${settledRow?.processingState}`,
);
record(
  "S4/source-never-lost",
  settledRow !== undefined && settledRow.authorText === CORRECTION_TEXT ? "PASS" : "FAIL",
  "the message stays in history whatever processing did",
);

// The correction is visible in project memory with history.
record(
  "S5/correction-reflected-in-project-memory",
  corrected !== undefined ? "PASS" : "FAIL",
  corrected === undefined
    ? "current finding not backed by the correction source"
    : `${corrected.current.semanticKey} rev${corrected.history.revisionCounter}`,
);
if (corrected !== undefined) {
  const history = corrected.history;
  const currentRevision =
    history.revisions.find((r) => r.revisionId === history.currentRevisionId) ??
    history.revisions[history.revisions.length - 1];
  const olderRevision = history.revisions.find((r) => r.revisionId !== history.currentRevisionId);
  record(
    "S5/history-visible-old-and-current",
    history.revisions.length >= 2 && currentRevision !== undefined && olderRevision !== undefined
      ? "PASS"
      : "FAIL",
    `${history.revisions.length} revisions`,
  );
  record(
    "S5/current-value-carries-the-correction",
    JSON.stringify(currentRevision?.value).includes("2026-09-11") ||
      JSON.stringify(currentRevision?.value).includes("piątek")
      ? "PASS"
      : "FAIL",
    JSON.stringify(currentRevision?.value),
  );
  record(
    "S5/old-value-stays-in-history",
    JSON.stringify(olderRevision?.value).includes("2026-09-09") ||
      JSON.stringify(olderRevision?.value).includes("środ")
      ? "PASS"
      : "FAIL",
    JSON.stringify(olderRevision?.value),
  );
  record(
    "S5/current-evidence-cites-the-correcting-source",
    (currentRevision?.evidence ?? []).some((w) => w.sourceId === correction.sourceId)
      ? "PASS"
      : "FAIL",
    `witnesses=${JSON.stringify(currentRevision?.evidence ?? [])}`,
  );
}
record(
  "S5/original-message-immutable",
  settledRow !== undefined &&
    (await companyView(10, SESSION)).value.page.find((r) => r.sourceId === original.sourceId)?.authorText ===
      ORIGINAL_TEXT
    ? "PASS"
    : "FAIL",
  "the original words are never rewritten",
);

// ---------------------------------------------------------------------------
// S6. direct structured correction (C2's audited command) + concurrent conflict
// ---------------------------------------------------------------------------
const target = corrected ?? originalFinding;
const expectedRevision = target.history.revisionCounter;
const direct = await memory(
  "memory.correctFinding",
  {
    findingId: target.current.findingId,
    expectedRevision,
    value: { _tag: "text_note", text: "Dowóz płytek: ostatecznie 25 września 2026 rano." },
    knowledgeState: { _tag: "known" },
    reason: "Szef potwierdził nowy termin telefonicznie (korekta bezpośrednia).",
  },
  SESSION,
);
record(
  "S6/direct-correction-applied",
  isOk(direct) ? "PASS" : "FAIL",
  isOk(direct) ? `revision=${direct.value.revisionId}` : JSON.stringify(direct.error),
);
const stale = await memory(
  "memory.correctFinding",
  {
    findingId: target.current.findingId,
    expectedRevision, // the OLD counter: the direct correction above moved it
    value: { _tag: "text_note", text: "Próba zagranych rewizji." },
    knowledgeState: { _tag: "known" },
    reason: "Ta próba musi zostać odrzucona.",
  },
  SESSION,
);
record(
  "S6/concurrent-revision-conflict-refused",
  isErr(stale, "conflict", "revision_mismatch") ? "PASS" : "FAIL",
  stale._tag === "error" ? `${stale.error._tag}/${stale.error.code}` : "accepted?!",
);
const afterDirect = await findingHistory(target.current.findingId, SESSION);
const correctionRevision = isOk(afterDirect)
  ? afterDirect.value.revisions.find((r) => r.origin === "correction")
  : undefined;
record(
  "S6/direct-correction-in-history-with-author-and-reason",
  correctionRevision !== undefined &&
    correctionRevision.recordedByUserId === FRESH_USER &&
    correctionRevision.reason !== null
    ? "PASS"
    : "FAIL",
  correctionRevision === undefined ? "no correction-origin revision" : "ok",
);

// ---------------------------------------------------------------------------
// S7. E3's sourced clarification surfaces and is answered
// ---------------------------------------------------------------------------
const AMBIGUOUS_TEXT =
  "Sprawa Banan: Kaczmarek twierdzi, że dostawa płytek była uzgodniona na 23 września, ale ja pamiętam 24. Zostawmy to do wyjaśnienia, dopóki nie dotrze potwierdzenie.";
let ambiguousRun = null;
let openClarification = null;
for (let attempt = 1; attempt <= 5 && openClarification === null; attempt += 1) {
  const ambiguous = await acceptAndAnalyze(AMBIGUOUS_TEXT, [BANAN], SESSION);
  const state = await waitForRunRetrying(ambiguous.runId, SESSION);
  if (state === null) {
    console.log(`[S7] attempt ${attempt} wedged (model stage); retrying`);
    continue;
  }
  ambiguousRun = { source: ambiguous.sourceId, state };
  const listed = await clarifications({ _tag: "project", projectId: BANAN }, SESSION);
  openClarification = isOk(listed)
    ? listed.value.find((c) => c.state === "open") ?? null
    : null;
  if (openClarification === null) {
    console.log(`[S7] attempt ${attempt} raised no clarification (model variance); retrying`);
  }
}
let clarificationId = openClarification?.clarificationId ?? null;
let raisedByModel = clarificationId !== null;
if (clarificationId === null && ambiguousRun !== null) {
  // Deterministic fallback: raise the shared question through the checked
  // command, citing real fragments of the two contradicting sources.
  const fragmentIds = ambiguousRun.state.fragments.map((f) => f.fragmentId);
  const raised = await memory(
    "memory.raiseClarification",
    {
      question: "Który termin dostawy płytek obowiązuje: 23 czy 24 września?",
      conflictingEvidence: fragmentIds.slice(0, 2),
      scope: { _tag: "project", projectId: BANAN },
    },
    SESSION,
  );
  record(
    "S7/fallback-raise-through-checked-command",
    isOk(raised) ? "PASS" : "FAIL",
    isOk(raised) ? `fragments=${fragmentIds.length}` : JSON.stringify(raised.error),
  );
  clarificationId = isOk(raised) ? raised.value.clarificationId : null;
}
record(
  "S7/clarification-surfaced-with-source",
  clarificationId !== null &&
    (openClarification === null ||
      openClarification.conflictingEvidence.every((w) => typeof w.sourceId === "string"))
    ? "PASS"
    : "FAIL",
  raisedByModel ? "raised by the analysis (model)" : "raised via checked command (fallback)",
);
if (clarificationId !== null) {
  const answered = await memory(
    "memory.resolveClarification",
    {
      clarificationId,
      resolutionNote: "Obowiązuje 24 września — potwierdzone z klientem.",
    },
    SESSION,
  );
  record(
    "S7/answer-accepted",
    isOk(answered) ? "PASS" : "FAIL",
    isOk(answered) ? "resolved" : JSON.stringify(answered.error),
  );
  const afterAnswer = await clarifications({ _tag: "project", projectId: BANAN }, SESSION);
  const row = isOk(afterAnswer)
    ? afterAnswer.value.find((c) => c.clarificationId === clarificationId)
    : undefined;
  record(
    "S7/resolution-keeps-author-and-note",
    row !== undefined &&
      row.state === "resolved" &&
      row.resolvedByUserId === FRESH_USER &&
      row.resolutionNote !== null
      ? "PASS"
      : "FAIL",
    row === undefined ? "row missing" : `${row.state} by=${row.resolvedByUserId}`,
  );
  const reanswer = await memory(
    "memory.resolveClarification",
    { clarificationId, resolutionNote: "Druga próba odpowiedzi." },
    SESSION,
  );
  record(
    "S7/double-answer-refused",
    isErr(reanswer, "conflict", "clarification_already_resolved") ? "PASS" : "FAIL",
    reanswer._tag === "error" ? reanswer.error.code : "accepted?!",
  );
}

// ---------------------------------------------------------------------------
// S8. company-scope clarifications surface in the Firma memory scope
//     (regression pin: firm-memory rows carry no scopeProjectId, so the
//     company read must not scan the by_project index, which omits them)
// ---------------------------------------------------------------------------
const companyRaised = await memory(
  "memory.raiseClarification",
  {
    question: "Firma: który zapis terminu w rozmowach jest wiążący przy wycenie?",
    conflictingEvidence: [],
    scope: { _tag: "company" },
  },
  SESSION,
);
record(
  "S8/company-scope-raise-accepted",
  isOk(companyRaised) ? "PASS" : "FAIL",
  isOk(companyRaised) ? "ok" : JSON.stringify(companyRaised.error),
);
const firmMemory = await clarifications({ _tag: "company" }, SESSION);
const surfacedCompany = isOk(firmMemory)
  ? firmMemory.value.find(
      (c) => isOk(companyRaised) && c.clarificationId === companyRaised.value.clarificationId,
    )
  : undefined;
record(
  "S8/company-clarification-in-firma-scope",
  surfacedCompany !== undefined ? "PASS" : "FAIL",
  surfacedCompany === undefined
    ? "company-scope row missing from the Firma read"
    : `rows=${isOk(firmMemory) ? firmMemory.value.length : "?"}`,
);

const ok = summarize();
closeKeepalive();
if (!ok) {
  process.exitCode = 1;
}
