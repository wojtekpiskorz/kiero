/**
 * F2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/f2, instance energetic-kangaroo-562, EU).
 *
 * Actor context: the A3 service-bridge identity plus server-seeded fixture
 * bosses of the service company (the F1 people fixtures). No
 * development-auth shortcut; sessions are created server-side by guarded
 * probe fixtures. This deployment has no model key, so E3's analysis
 * honestly fails `provider_key_not_configured` — the natural terminal
 * failure feeds the company-rules proof, and guarded run-state fixture
 * flips (the revokeFixtureMembership precedent) produce the terminal
 * success branch.
 *
 * Clock policy (issue 42: "real scheduled functions/fake clock boundaries"):
 * the evaluator's `nowMs` is caller-owned, so scenario evaluations run at
 * chosen instants (window closes, quiet-hours ends, the Europe/Warsaw DST
 * nights), all within the first real 60 seconds of each source's batching
 * window (before any real scheduled hop fires). The final scenario waits
 * for the REAL scheduled hop and proves the un-forced 60-second window.
 *
 * Run: node tests/f2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "energetic-kangaroo-562";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, ok, detail) {
  const outcome = ok ? "PASS" : "FAIL";
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}
const key = () => `idem_${randomUUID()}`;
const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const isOk = (r) => r._tag === "ok";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seedBoss = (email, label) =>
  client().action("attention/probe_shared:probeSeedBoss", {
    email,
    displayName: label,
    deviceLabel: `${email.split("@")[0]}-bridge`,
  });
const changePrefs = (input, sessionId) =>
  client().action("attention/preferences/probe:probeChangeNotificationPreferences", {
    envelope: envelope("attention.changeNotificationPreferences", input),
    sessionId,
  });
const markRead = (input, sessionId) =>
  client().action("attention/read_state/probe:probeMarkSourceRead", {
    envelope: envelope("attention.markSourceRead", input),
    sessionId,
  });
const accept = (input, idempotencyKey, sessionId) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: { ...envelope("sources.acceptSource", input), idempotencyKey },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const uploadFor = async () => {
  const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
  if (upload._tag !== "ok") throw new Error("upload seeding failed");
  return upload.value.uploadId;
};
const acceptText = async (text, hints) => {
  const accepted = await accept(
    {
      uploadId: await uploadFor(),
      authorText: text,
      intendedSentAtIso: new Date().toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: hints,
    },
    key(),
  );
  if (accepted._tag !== "ok") throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  return accepted.value.sourceId;
};
const latestRun = (sourceId) =>
  client().action("processing/text/probe:probeLatestRunForSource", { sourceId });
const forceSucceeded = (runId) =>
  client().action("attention/delivery/probe:probeForceRunSucceeded", { runId });
const forceFailed = (runId) =>
  client().action("attention/delivery/probe:probeForceRunFailed", { runId });
const evaluate = (nowMs) =>
  client().action("attention/delivery/probe:probeEvaluateDueIntents", {
    envelope: envelope("attention.evaluateDueIntents", { nowMs }),
  });
const deliveryState = () =>
  client().action("attention/delivery/probe:probeDeliveryState", {});
const stateForSource = (sourceId) =>
  client().action("attention/delivery/probe:probeDeliveryStateForSource", { sourceId });
const memoryCommand = (operation, input, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const analysisState = (runId) =>
  client().action("processing/text/probe:probeAnalysisState", { runId });

/** Polls one source's intents until they exist (drain + executor ran). */
async function waitForIntents(sourceId, expectedCount, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await stateForSource(sourceId);
    if (isOk(state) && state.value.intents.length >= expectedCount) {
      return state.value.intents;
    }
    await sleep(1_500);
  }
  throw new Error(`intents for ${sourceId} never appeared`);
}

/** Polls a source's run until terminal (or null when none exists). */
async function waitRunTerminal(sourceId, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await latestRun(sourceId);
    if (isOk(run) && run.value.state !== "running") {
      return run.value;
    }
    await sleep(3_000);
  }
  return null;
}

/** The Warsaw minute-of-day right now, for fresh personal quiet windows. */
function warsawMinuteOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

/** A personal quiet window covering [now-30min, now+40min] in Warsaw time. */
function freshQuietWindow() {
  const nowMin = warsawMinuteOfDay();
  const start = (nowMin - 30 + 1440) % 1440;
  const end = (nowMin + 40) % 1440;
  return { startMinuteOfDay: start, endMinuteOfDay: end };
}

console.log(`# F2 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures ---------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (!isOk(seed)) throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const AUTHOR_EMAIL = "platform-service@kiero.invalid";

const proj = async (name) => {
  const seeded = await client().action("sources/accept/probe:probeSeedProject", { displayName: name });
  if (seeded._tag !== "ok") throw new Error("project seeding failed");
  return seeded.value.projectId;
};

const bossB = await seedBoss("f2-boss-b@kiero.invalid", "F2 boss B (muted project)");
const bossQ = await seedBoss("f2-boss-q@kiero.invalid", "F2 boss Q (quiet hours)");
// Re-seeding also RE-ACTIVATES a previously revoked proof boss (a fresh
// active membership row; the old one keeps its revoked history).
const bossR = await seedBoss("f2-boss-r@kiero.invalid", "F2 boss R (revocation)");
if (!isOk(bossB) || !isOk(bossQ) || !isOk(bossR)) throw new Error("boss seeding failed");
const USER_B = bossB.value.userId;
const USER_Q = bossQ.value.userId;
const USER_R = bossR.value.userId;
const SESS_B = bossB.value.sessionId;
const SESS_Q = bossQ.value.sessionId;
const SESS_R = bossR.value.sessionId;
const EMAIL_R = "f2-boss-r@kiero.invalid";

const P_MUTED = await proj("Banan (F2)");
const P_OTHER = await proj("Kaczmarek (F2)");

// The service account (boss A) is the AUTHOR of every proof source; its
// user id is resolved through the same checked preferences read.
const meA = await client().action("attention/preferences/probe:probeMyPreferences", {});
if (!isOk(meA)) throw new Error(`service identity unavailable: ${JSON.stringify(meA)}`);
const USER_A = meA.value.userId;

// B mutes the Banan conversation; Q starts quiet (refreshed per scenario).
await changePrefs({ mutedProjectIds: [P_MUTED] }, SESS_B);
const quietOn = async () => changePrefs({ quietHours: freshQuietWindow() }, SESS_Q);

/** One boss's intents across states for a set of sources. */
async function intentsFor(userId, sourceIds) {
  const state = await deliveryState();
  if (!isOk(state)) throw new Error("delivery state read failed");
  const all = [...state.value.pending, ...state.value.delivered, ...state.value.suppressed];
  return all.filter((intent) => intent.recipientUserId === userId && sourceIds.includes(intent.sourceId));
}

const distinctSummaries = (intents) => {
  const jsons = new Set(
    intents.filter((i) => i.state === "delivered").map((i) => JSON.stringify(i.delivery)),
  );
  return [...jsons].map((json) => JSON.parse(json));
};

// ---------------------------------------------------------------------------
// A. Author exclusion and the recipient set at acceptance.
// ---------------------------------------------------------------------------
await quietOn();
const idemA = key();
const S_A = (
  await accept(
    {
      uploadId: await uploadFor(),
      authorText: "Dowóz płytek na Budę; ekipa potwierdza montaż na 10:00 (F2 A)",
      intendedSentAtIso: new Date().toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [P_MUTED],
    },
    idemA,
  )
).value.sourceId;
const intentsA = await waitForIntents(S_A, 3);
const authorsA = new Set(intentsA.map((i) => i.recipientUserId));
record(
  "A1 acceptance creates intents for every OTHER active boss, never the author",
  intentsA.length === 3 &&
    authorsA.has(USER_B) && authorsA.has(USER_Q) && authorsA.has(USER_R) &&
    [...intentsA].every((i) => i.semanticKind === "source_entry" && i.state === "pending"),
  `recipients=${intentsA.length}/3 (author ${AUTHOR_EMAIL} absent: ${![...intentsA].some((i) => i.sourceId === S_A && i.dedupKey.includes(AUTHOR_EMAIL))}) kinds=${new Set(intentsA.map((i) => i.semanticKind))}`,
);
const dueDelta = intentsA[0].dueAtMs - intentsA[0].createdAtMs;
record(
  "A2 the batching window anchors at durable acceptance (+/- executor latency)",
  dueDelta > 45_000 && dueDelta < 75_000,
  `dueAtMs - createdAtMs = ${Math.round(dueDelta / 1000)}s (expected ~60s)`,
);

// Make the assignment terminal (succeeded) FAST, inside the first window.
const runA = await latestRun(S_A);
if (isOk(runA)) {
  await forceSucceeded(runA.value.runId);
}

// ---------------------------------------------------------------------------
// B. Suppression matrix at due time: muted project / quiet hours / delivery.
// ---------------------------------------------------------------------------
const dueA = intentsA[0].dueAtMs;
await evaluate(dueA + 1_000);
const afterB = await intentsFor(USER_B, [S_A]);
const afterR = await intentsFor(USER_R, [S_A]);
const afterQ = await intentsFor(USER_Q, [S_A]);
record(
  "B1 the muted boss dies muted (F1 seam, project scope)",
  afterB.length === 1 && afterB[0].state === "suppressed" && afterB[0].suppressedReason === "muted_project",
  `B=${afterB[0]?.state}/${afterB[0]?.suppressedReason}`,
);
record(
  "B2 the unmuted boss receives ONE collapsed project summary",
  afterR.length === 1 && afterR[0].state === "delivered" && afterR[0].delivery.bucket === `project:${P_MUTED}` && afterR[0].delivery.sourceIds.length === 1,
  `R=${afterR[0]?.state} bucket=${afterR[0]?.delivery?.bucket}`,
);
const quietDeferred = afterQ.filter((i) => i.state === "pending");
record(
  "B3 quiet hours DEFER (availability unchanged): intent stays pending until the window end",
  quietDeferred.length === 1,
  `Q=${afterQ[0]?.state} dueAtMs=${afterQ[0]?.dueAtMs ? new Date(afterQ[0].dueAtMs).toISOString() : "-"}`,
);
const quietEnd = afterQ[0]?.dueAtMs;
await evaluate(quietEnd);
const collapsedQ = await intentsFor(USER_Q, [S_A]);
record(
  "B4 at the quiet end ONE current summary is delivered (no replay)",
  collapsedQ.length === 1 && collapsedQ[0].state === "delivered" &&
    collapsedQ[0].delivery.deliveredAtMs === quietEnd &&
    collapsedQ[0].delivery.sourceIds.length === 1,
  `Q=${collapsedQ[0]?.state} deliveredAt=${collapsedQ[0]?.delivery ? new Date(collapsedQ[0].delivery.deliveredAtMs).toISOString() : "-"}`,
);

// ---------------------------------------------------------------------------
// C. Deterministic batching: two same-bucket sources collapse; a mixed
//    source stays ONE notification in its own bucket.
// ---------------------------------------------------------------------------
await quietOn();
const S_C1 = await acceptText("Kolejna dostawa na Budę rano (F2 C1)", [P_MUTED]);
const S_C2 = await acceptText("Druga dostawa na Budę po południu (F2 C2)", [P_MUTED]);
await waitForIntents(S_C1, 3);
await waitForIntents(S_C2, 3);
for (const sourceId of [S_C1, S_C2]) {
  const run = await latestRun(sourceId);
  if (isOk(run)) await forceSucceeded(run.value.runId);
}
const c1Due = (await stateForSource(S_C1)).value.intents[0].dueAtMs;
const c2Due = (await stateForSource(S_C2)).value.intents[0].dueAtMs;
await evaluate(Math.max(c1Due, c2Due) + 1_000);
const batchR = await intentsFor(USER_R, [S_C1, S_C2]);
const summariesC = distinctSummaries(batchR);
record(
  "C1 two qualifying sources in one window collapse into ONE current summary",
  batchR.length === 2 && batchR.every((i) => i.state === "delivered") && summariesC.length === 1 &&
    new Set(summariesC[0].sourceIds).size === 2,
  `intents=${batchR.length} distinctSummaries=${summariesC.length} covering=${summariesC[0]?.sourceIds?.length}`,
);

const S_MIX = await acceptText("Buda i Kaczmarek wspólna dostawa (F2 mixed)", [P_MUTED, P_OTHER]);
await waitForIntents(S_MIX, 3);
const runMix = await latestRun(S_MIX);
if (isOk(runMix)) await forceSucceeded(runMix.value.runId);
const mixDue = (await stateForSource(S_MIX)).value.intents[0].dueAtMs;
await evaluate(mixDue + 1_000);
const mixR = await intentsFor(USER_R, [S_MIX]);
const mixB = await intentsFor(USER_B, [S_MIX]);
record(
  "C2 a mixed-project source is ONE notification (its own bucket), never one per project",
  mixR.length === 1 && mixR[0].state === "delivered" && mixR[0].delivery.sourceIds.length === 1 &&
    mixR[0].delivery.bucket === `mixed:${[P_MUTED, P_OTHER].sort().join("|")}`,
  `R bucket=${mixR[0]?.delivery?.bucket} sources=${mixR[0]?.delivery?.sourceIds?.length}`,
);
record(
  "C3 the mixed source dies for the boss who muted ANY of its projects",
  mixB.length === 1 && mixB[0].state === "suppressed" && mixB[0].suppressedReason === "muted_project",
  `B=${mixB[0]?.state}/${mixB[0]?.suppressedReason}`,
);

// ---------------------------------------------------------------------------
// D. A source read just before due time leaves the batch.
// ---------------------------------------------------------------------------
await quietOn();
const S_D = await acceptText("Termin wyceny dla Kaczmarka (F2 D)", [P_OTHER]);
await waitForIntents(S_D, 3);
const runD = await latestRun(S_D);
if (isOk(runD)) await forceSucceeded(runD.value.runId);
await markRead({ sourceId: S_D, read: true }, SESS_R);
const dDue = (await stateForSource(S_D)).value.intents[0].dueAtMs;
await evaluate(dDue + 1_000);
const readR = await intentsFor(USER_R, [S_D]);
const readB = await intentsFor(USER_B, [S_D]);
record(
  "D1 the reader's intent dies already_read before delivery",
  readR.length === 1 && readR[0].state === "suppressed" && readR[0].suppressedReason === "already_read",
  `R=${readR[0]?.state}/${readR[0]?.suppressedReason}`,
);
record(
  "D2 the unread boss still receives the summary",
  readB.length === 1 && readB[0].state === "delivered" && readB[0].delivery.sourceIds.includes(S_D),
  `B=${readB[0]?.state}`,
);

// ---------------------------------------------------------------------------
// E. A revoked member's intent dies at due time.
// ---------------------------------------------------------------------------
await quietOn();
const S_E = await acceptText("Ostatnia zmiana harmonogramu Kaczmarka (F2 E)", [P_OTHER]);
await waitForIntents(S_E, 3);
const runE = await latestRun(S_E);
if (isOk(runE)) await forceSucceeded(runE.value.runId);
const revoke = await client().action("attention/probe_shared:probeRevokeFixtureMembership", {
  email: EMAIL_R,
});
const eDue = (await stateForSource(S_E)).value.intents[0].dueAtMs;
await evaluate(eDue + 1_000);
const revR = await intentsFor(USER_R, [S_E]);
const revB = await intentsFor(USER_B, [S_E]);
record(
  "E1 the revoked member produces nothing (the intent dies)",
  isOk(revoke) && revR.length === 1 && revR[0].state === "suppressed" &&
    revR[0].suppressedReason === "membership_revoked",
  `revoke=${revoke._tag} R=${revR[0]?.state}/${revR[0]?.suppressedReason}`,
);
record(
  "E2 remaining bosses are unaffected",
  revB.length === 1 && revB[0].state === "delivered",
  `B=${revB[0]?.state}`,
);

// ---------------------------------------------------------------------------
// F. An addressed agent clarification may notify the AUTHOR of their own
//    source (a separate kind from ordinary source updates).
// ---------------------------------------------------------------------------
const fragmentRun = await latestRun(S_A);
const analysisA = isOk(fragmentRun) ? await analysisState(fragmentRun.value.runId) : { _tag: "error" };
const fragmentId = isOk(analysisA)
  ? (analysisA.value.fragments.find((f) => f.anchor._tag === "whole_source") ?? analysisA.value.fragments[0])?.fragmentId
  : undefined;
if (fragmentId === undefined) {
  record("F1 the clarification intent addresses the source author", false, "no fragment available");
} else {
  const raised = await memoryCommand(
    "memory.raiseClarification",
    {
      question: "F2: która dostawa dotyczy Budy — poranna czy popołudniowa?",
      conflictingEvidence: [fragmentId],
      scope: { _tag: "company" },
    },
  );
  if (!isOk(raised)) {
    record("F1 the clarification intent addresses the source author", false, `raise failed: ${raised.error?.code}`);
  } else {
    const clarificationId = raised.value.clarificationId;
    const deadline = Date.now() + 30_000;
    let clarIntent = null;
    while (Date.now() < deadline && clarIntent === null) {
      const state = await deliveryState();
      if (isOk(state)) {
        clarIntent = state.value.pending.find((i) => i.clarificationId === clarificationId) ?? null;
      }
      if (clarIntent === null) await sleep(1_500);
    }
    record(
      "F1 the clarification intent addresses the source author",
      clarIntent !== null && clarIntent.recipientUserId === USER_A,
      `intent=${clarIntent === null ? "none" : `recipient=${clarIntent.recipientUserId === USER_A ? "author" : "other"} kind=${clarIntent.semanticKind}`}`,
    );
    const clarDue = clarIntent.dueAtMs;
    await evaluate(clarDue + 1_000);
    const clarAfter = await deliveryState();
    const settled = isOk(clarAfter)
      ? [...clarAfter.value.delivered, ...clarAfter.value.suppressed].find((i) => i.clarificationId === clarificationId)
      : null;
    record(
      "F2 the author may receive it about their own entry (delivered, one summary)",
      settled !== undefined && settled.state === "delivered" && settled.recipientUserId === USER_A &&
        settled.delivery.semanticKind === "clarification",
      `state=${settled?.state} kind=${settled?.delivery?.semanticKind}`,
    );
  }
}
// ---------------------------------------------------------------------------
// G. An ordinary agent confirmation (a published change set) pushes NOTHING.
// ---------------------------------------------------------------------------
const stateBefore = await deliveryState();
const countBefore = isOk(stateBefore)
  ? stateBefore.value.pending.length + stateBefore.value.delivered.length + stateBefore.value.suppressed.length
  : -1;
const prepared = await memoryCommand(
  "memory.prepareChangeSet",
  {
    sourceId: S_A,
    plannedRevisions: [
      {
        findingId: null,
        scope: { _tag: "company" },
        semanticKey: `f2-proof/agent-answer-${randomUUID().slice(0, 8)}`,
        value: { _tag: "text_note", text: "F2: agent potwierdza uporządkowanie wpisu." },
        knowledgeState: { _tag: "known" },
        effectiveFrom: null,
        evidence: [{ sourceId: S_A, fragmentId: fragmentId ?? null, supportKind: "support" }],
        derivesFrom: [],
      },
    ],
  },
);
if (!isOk(prepared)) {
  record("G1 an ordinary agent confirmation produces no push intent", false, `prepare failed: ${prepared.error?.code}`);
  record("G2 later assignment sends no second source notification", false, "blocked by G1");
} else {
  const published = await memoryCommand("memory.publishChangeSet", {
    changeSetId: prepared.value.changeSetId,
    expectedRevisions: [],
  });
  if (!isOk(published)) {
    record("G1 an ordinary agent confirmation produces no push intent", false, `publish failed: ${published.error?.code}`);
    record("G2 later assignment sends no second source notification", false, "blocked by G1");
  } else {
    await sleep(8_000); // the drain (1s) + the kick job + settle
    const stateAfter = await deliveryState();
    const countAfter = isOk(stateAfter)
      ? stateAfter.value.pending.length + stateAfter.value.delivered.length + stateAfter.value.suppressed.length
      : -1;
    const confirmationKinds = isOk(stateAfter)
      ? [...stateAfter.value.pending, ...stateAfter.value.delivered, ...stateAfter.value.suppressed].filter(
          (i) => i.semanticKind === "confirmation",
        )
      : null;
    record(
      "G1 an ordinary agent confirmation produces no push intent",
      countAfter === countBefore && (confirmationKinds === null || confirmationKinds.length === 0),
      `intents before=${countBefore} after=${countAfter} confirmationKind=${confirmationKinds?.length ?? "?"}`,
    );
    // G2: a resurrection would be an intent CREATED by the publication;
    // legitimately deferred pendings (quiet hours) are not resurrections.
    const publishAt = Date.now() - 10_000;
    const resurrected = isOk(stateAfter)
      ? [...stateAfter.value.pending, ...stateAfter.value.delivered, ...stateAfter.value.suppressed].filter(
          (i) => i.createdAtMs >= publishAt && [S_A, S_C1, S_C2, S_MIX, S_D, S_E].includes(i.sourceId),
        )
      : [];
    record(
      "G2 later assignment sends no second source notification",
      resurrected.length === 0,
      `newIntentsForEarlierSources=${resurrected.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// H. Duplicate suppression by semantic identity: replayed events, worker
//    retries and duplicate scheduling all collapse.
// ---------------------------------------------------------------------------
const beforeH = await deliveryState();
const countH = isOk(beforeH)
  ? beforeH.value.pending.length + beforeH.value.delivered.length + beforeH.value.suppressed.length
  : -1;
const replay = await client().action("attention/delivery/probe:probeRepublishSourceAccepted", {
  sourceId: S_A,
  freshDedupKey: false,
  dedupKey: `sources.acceptSource:${seed.value.companyId}:${idemA}`,
});
const freshDuplicate = await client().action("attention/delivery/probe:probeRepublishSourceAccepted", {
  sourceId: S_A,
  freshDedupKey: true,
});
const retry = await client().action("attention/delivery/probe:probeReregisterIntentsJob", { sourceId: S_A });
await client().action("attention/delivery/probe:probeScheduleEvaluation", { atMs: Date.now() + 2_000 });
await sleep(8_000);
const afterH = await deliveryState();
const countHAfter = isOk(afterH)
  ? afterH.value.pending.length + afterH.value.delivered.length + afterH.value.suppressed.length
  : -1;
record(
  "H1 the replayed acceptance event dedups at the outbox row",
  isOk(replay) && replay.value.deduplicated === true,
  `deduplicated=${replay.value?.deduplicated}`,
);
record(
  "H2 a fresh-identity duplicate event still collapses: one semantic intent set",
  isOk(freshDuplicate) && countHAfter === countH,
  `fresh event=${freshDuplicate.value?.eventId ? "published" : "?"} intents before=${countH} after=${countHAfter}`,
);
record(
  "H3 the retried worker job registration collapses (no re-execution)",
  isOk(retry) && retry.value.deduplicated === true,
  `deduplicated=${retry.value?.deduplicated}`,
);
record(
  "H4 duplicate scheduling is idempotent (states unchanged)",
  countHAfter === countH,
  `intents ${countH} -> ${countHAfter}`,
);

// ---------------------------------------------------------------------------
// I. Terminal analysis failure applies company-entry rules (natural E3
//    failure on this deployment: provider key not configured).
// ---------------------------------------------------------------------------
const S_I = await acceptText("Notatka bez przypisania czeka na analizę (F2 I)", []);
// R is revoked since scenario E: exactly TWO recipients remain (B, Q).
await waitForIntents(S_I, 2);
const runI = await waitRunTerminal(S_I, 180_000);
const iIntents = await stateForSource(S_I);
const iB = iIntents.value.intents.find((i) => i.recipientUserId === USER_B);
if (runI === null) {
  // The workflow is still retrying: force the terminal failure branch.
  const current = await latestRun(S_I);
  if (isOk(current)) await forceFailed(current.value.runId);
}
const iDeadline = Date.now() + 90_000;
let iBfinal = iB;
while (Date.now() < iDeadline) {
  const state = await stateForSource(S_I);
  iBfinal = state.value.intents.find((i) => i.recipientUserId === USER_B);
  if (iBfinal !== undefined && iBfinal.state !== "pending") break;
  await sleep(3_000);
}
record(
  "I1 terminal analysis failure applies company-entry rules (company bucket)",
  iBfinal !== undefined && iBfinal.state === "delivered" && iBfinal.delivery.bucket === "company",
  `runTerminal=${runI === null ? "forced" : runI.state} B=${iBfinal?.state} bucket=${iBfinal?.delivery?.bucket}`,
);

// ---------------------------------------------------------------------------
// J. Quiet-hours deferral across the Europe/Warsaw DST nights (F1's seam
//    through the deployed evaluator), with the DEFAULT company window.
// ---------------------------------------------------------------------------
const S_J = await acceptText("Wpis na noc zmiany czasu (F2 J)", [P_OTHER]);
await waitForIntents(S_J, 2);
const runJ = await latestRun(S_J);
if (isOk(runJ)) await forceSucceeded(runJ.value.runId);
// B has no personal quiet window: the company default 20:00-06:00 applies.
await changePrefs({ mutedProjectIds: [] }, SESS_B);
const FALL_BACK_NOW = Date.parse("2026-10-24T23:30:00.000Z"); // 01:30 CEST, inside 20:00-06:00
const FALL_BACK_END = Date.parse("2026-10-25T05:00:00.000Z"); // 06:00 CET after the repeated hour
await evaluate(FALL_BACK_NOW);
const jB = (await stateForSource(S_J)).value.intents.find((i) => i.recipientUserId === USER_B);
record(
  "J1 deferral across the fall-back night lands at 06:00 CET (05:00Z)",
  jB !== undefined && jB.state === "pending" && jB.dueAtMs === FALL_BACK_END,
  `B=${jB?.state} until=${jB ? new Date(jB.dueAtMs).toISOString() : "-"}`,
);
await evaluate(FALL_BACK_END);
const jBafter = (await stateForSource(S_J)).value.intents.find((i) => i.recipientUserId === USER_B);
record(
  "J2 the deferred DST-night batch delivers at the window end",
  jBafter !== undefined && jBafter.state === "delivered" &&
    jBafter.delivery.deliveredAtMs === FALL_BACK_END,
  `B=${jBafter?.state} deliveredAt=${jBafter ? new Date(jBafter.delivery.deliveredAtMs).toISOString() : "-"}`,
);

// ---------------------------------------------------------------------------
// K. The REAL scheduled hop: no probe evaluation, just the 60-second window.
// ---------------------------------------------------------------------------
const S_K = await acceptText("Wpis na prawdziwe okno 60 sekund (F2 K)", [P_OTHER]);
await waitForIntents(S_K, 2);
// NO run flip and NO forced evaluation: the analysis fails naturally on
// this deployment (provider key not configured), and the REAL scheduled
// chain (acceptance hop, then the assignment-pending 30 s retries) must
// deliver after the 60-second window with the honest company scope.
const kIntents = (await stateForSource(S_K)).value.intents;
const kDue = Math.min(...kIntents.map((i) => i.dueAtMs));
const kDeadline = kDue + 360_000;
let kB = null;
while (Date.now() < kDeadline) {
  const state = await stateForSource(S_K);
  kB = state.value.intents.find((i) => i.recipientUserId === USER_B);
  if (kB !== undefined && kB.state === "delivered") break;
  await sleep(5_000);
}
record(
  "K1 the real scheduled chain delivers after the 60-second window (no forced evaluation)",
  kB !== undefined && kB.state === "delivered" && kB.deliveredAtMs >= kDue &&
    kB.deliveredAtMs <= kDue + 300_000 && kB.delivery.bucket === "company",
  `B=${kB?.state} due=${new Date(kDue).toISOString()} deliveredAt=${kB ? new Date(kB.deliveredAtMs).toISOString() : "-"} bucket=${kB?.delivery?.bucket}`,
);

// --- summary -----------------------------------------------------------------
const ok = summarize();
process.exit(ok ? 0 : 1);
