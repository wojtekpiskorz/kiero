/**
 * C2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/c2, instance robust-puma-619, EU).
 *
 * Actor context: the A3 service-bridge identity (the service account's own
 * session, resolved through the canonical resolution and authorization
 * seam) plus one server-seeded second-company session for tenant isolation.
 * No development-auth shortcut exists; sessions are created server-side by
 * guarded probe fixtures.
 *
 * Run: node tests/c2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = "robust-puma-619";
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
const state = (sessionId) =>
  client().action("memory/findings/probe:probeMemoryState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const readCurrent = (scope, sessionId) =>
  client().action("memory/findings/probe:probeReadCurrentFindings", {
    scope,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

const temporalValue = (day, originalExpression, role) => ({
  _tag: "temporal",
  temporal: { shape: { _tag: "day", day }, originalExpression, role },
});
const moneyValue = (taxBasis) => ({
  _tag: "money",
  money: {
    role: "agreed_price",
    amount: { _tag: "exact", value: "10000" },
    currency: "PLN",
    currencyOrigin: "stated",
    taxBasis,
    certainty: "exact",
  },
});
const known = { _tag: "known" };
const evidence = (sourceId, fragmentId, supportKind) => ({
  sourceId,
  fragmentId,
  supportKind,
});

/** Asserts the current-projection invariant over the whole tenant state. */
function projectionConsistent(stateValue) {
  for (const finding of stateValue.findings) {
    const revisions = stateValue.revisions.filter(
      (r) => r.findingId === finding.findingId,
    );
    if (revisions.length !== finding.revisionCounter) {
      return `counter ${finding.revisionCounter} != history ${revisions.length} for ${finding.semanticKey}`;
    }
    const latest = revisions.reduce((a, b) => (a.revision >= b.revision ? a : b));
    if (latest.revisionId !== finding.currentRevisionId) {
      return `currentRevisionId is not the latest revision for ${finding.semanticKey}`;
    }
    if (JSON.stringify(latest.knowledgeState) !== JSON.stringify(finding.knowledgeState)) {
      return `projection knowledge state diverged from current revision for ${finding.semanticKey}`;
    }
  }
  return null;
}

console.log(`# C2 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const fixtures = await client().action("memory/findings/probe:probeSeedMemoryFixtures", {});
if (fixtures._tag !== "ok") throw new Error(`memory fixtures failed: ${JSON.stringify(fixtures)}`);
const S1 = fixtures.value.sourceId;
const F1 = fixtures.value.fragmentId;
const S2 = fixtures.value.secondSourceId;
const F2 = fixtures.value.secondFragmentId;

const isolation = await client().action("memory/findings/probe:probeSeedMemoryIsolation", {});
if (isolation._tag !== "ok") throw new Error(`isolation seeding failed: ${JSON.stringify(isolation)}`);
const SESSION_B = isolation.value.sessionId;
const SOURCE_B = isolation.value.sourceId;

// A project in the service company for the project-scope proof.
const projectSeed = await client().action("sources/accept/probe:probeSeedProject", {
  displayName: "Banan (C2)",
});
if (projectSeed._tag !== "ok") throw new Error(`project seeding failed`);
const P1 = projectSeed.value.projectId;

// --- A1: publish happy path — revisions + provenance + projection atomically ----
const plan1 = {
  sourceId: S1,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "termin.dostawy",
      value: temporalValue("2026-09-09", "jutro", "agreed"),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, F1, "support")],
      derivesFrom: [],
    },
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "cena.ustalona",
      value: moneyValue("not_specified"),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, F1, "support"), evidence(S2, F2, "independent_corroboration")],
      derivesFrom: [],
    },
    {
      findingId: null,
      scope: { _tag: "project", projectId: P1 },
      semanticKey: "kolor.fasety",
      value: { _tag: "text_note", text: "bananowy" },
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, F1, "support"), evidence(S2, null, "independent_corroboration")],
      derivesFrom: [],
    },
  ],
};
const prepared1 = await memory("memory.prepareChangeSet", plan1);
const published1 = await memory("memory.publishChangeSet", {
  changeSetId: prepared1._tag === "ok" ? prepared1.value.changeSetId : "",
  expectedRevisions: [],
});
const st1 = await state();
const findingBy = (st, key, kind = "company") =>
  st.findings.find((f) => f.semanticKey === key && f.scopeKind === kind);
const w1 = findingBy(st1.value, "termin.dostawy");
const w2 = findingBy(st1.value, "cena.ustalona");
const w4 = findingBy(st1.value, "kolor.fasety", "project");
const a1ok =
  prepared1._tag === "ok" &&
  prepared1.value.state === "prepared" &&
  published1._tag === "ok" &&
  published1.value.publishedRevisionIds.length === 3 &&
  w1 !== undefined &&
  w2 !== undefined &&
  w4 !== undefined &&
  w1.revisionCounter === 1 &&
  st1.value.revisions.filter((r) => r.origin === "publication").length === 3 &&
  st1.value.revisions.every(
    (r) =>
      r.origin === "publication" &&
      r.provenanceSourceId === S1 &&
      r.evidence.filter((e) => e.supportKind === "independent_corroboration").length <= 2,
  ) &&
  st1.value.changeSets.filter((c) => c.state === "published").length === 1 &&
  st1.value.groups.every((g) => g.state === "published") &&
  st1.value.memoryEvents.filter((e) => e.eventName === "memory.changeSetPublished").length === 1 &&
  st1.value.memoryEvents.filter((e) => e.eventName === "memory.findingRevised").length === 3 &&
  projectionConsistent(st1.value) === null;
record(
  "A1 publish commits 3 revisions + evidence + dependencies-free provenance + projection atomically",
  a1ok ? "PASS" : "FAIL",
  `revisions=${st1.value.revisions.length} events=${st1.value.memoryEvents.length} consistent=${projectionConsistent(st1.value) ?? "yes"}`,
);

// --- A2: evidence typing is visible (support vs independent corroboration) -------
const w2rev1 = st1.value.revisions.find((r) => r.findingId === w2.findingId);
const w4rev1 = st1.value.revisions.find((r) => r.findingId === w4?.findingId);
const a2ok =
  w2rev1 !== undefined &&
  w4rev1 !== undefined &&
  w2rev1.evidence.some((e) => e.sourceId === S2 && e.supportKind === "independent_corroboration") &&
  w2rev1.evidence.some((e) => e.sourceId === S1 && e.supportKind === "support") &&
  w4rev1.evidence.some((e) => e.sourceFragmentId === null && e.supportKind === "independent_corroboration");
record(
  "A2 evidence links carry typed support and independent corroboration (whole-source included)",
  a2ok ? "PASS" : "FAIL",
  `w2 evidence=${JSON.stringify(w2rev1?.evidence)}`,
);

// --- A3: current read needs no replay, scope-filtered ---------------------------
const companyRead = await readCurrent({ _tag: "company" });
const projectRead = await readCurrent({ _tag: "project", projectId: P1 });
const a3ok =
  companyRead._tag === "ok" &&
  companyRead.value.rows.length === 2 &&
  companyRead.value.rows.every((r) => r.currentRevisionId !== null && r.value !== null) &&
  projectRead._tag === "ok" &&
  projectRead.value.rows.length === 1 &&
  projectRead.value.rows[0]?.semanticKey === "kolor.fasety";
record(
  "A3 current findings read without replay; company and project scopes partition correctly",
  a3ok ? "PASS" : "FAIL",
  `company rows=${companyRead.value?.rows?.length} project rows=${projectRead.value?.rows?.length}`,
);

// --- A4: money without net/gross stays visibly not_specified --------------------
const moneyRow = companyRead.value.rows.find((r) => r.semanticKey === "cena.ustalona");
const a4ok =
  moneyRow !== undefined &&
  moneyRow.value._tag === "money" &&
  moneyRow.value.money.taxBasis === "not_specified" &&
  moneyRow.value.money.amount.value === "10000";
record(
  "A4 money published without net/gross reads back visibly not_specified (VAT never inferred)",
  a4ok ? "PASS" : "FAIL",
  `taxBasis=${moneyRow?.value?.money?.taxBasis}`,
);

// --- A5: temporal anchoring — resolve "jutro" from stored sentAt + timezone ------
const resolve1 = await client().action("memory/findings/probe:probeResolveRelativeDay", {
  expression: "jutro",
  sentAtMs: Date.parse("2026-09-08T16:30:00.000Z"),
  timezone: "Europe/Warsaw",
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const resolve2 = await client().action("memory/findings/probe:probeResolveRelativeDay", {
  expression: "jutro",
  sentAtMs: Date.parse("2026-09-08T16:30:00.000Z"),
  timezone: "Europe/Warsaw",
});
const temporalRow = companyRead.value.rows.find((r) => r.semanticKey === "termin.dostawy");
const a5ok =
  resolve1._tag === "ok" &&
  resolve2._tag === "ok" &&
  resolve1.value.matched === true &&
  resolve1.value.day === "2026-09-09" &&
  resolve2.value.day === resolve1.value.day &&
  temporalRow !== undefined &&
  temporalRow.value._tag === "temporal" &&
  temporalRow.value.temporal.shape.day === "2026-09-09" &&
  temporalRow.value.temporal.originalExpression === "jutro" &&
  temporalRow.value.temporal.shape._tag === "day";
record(
  "A5 relative date resolves from stored sentAt+timezone, stays stable on retry, precision preserved",
  a5ok ? "PASS" : "FAIL",
  `resolved=${resolve1.value?.day} retry=${resolve2.value?.day} stored=${temporalRow?.value?.temporal?.shape?.day}`,
);

// --- A6: basis added later is a new revision; amount history intact -------------
const correction1 = await memory("memory.correctFinding", {
  findingId: w2.findingId,
  expectedRevision: 1,
  value: moneyValue("net"),
  knowledgeState: known,
  reason: "Szef potwierdził kwotę netto",
});
const st2 = await state();
const w2history = st2.value.revisions
  .filter((r) => r.findingId === w2.findingId)
  .sort((a, b) => a.revision - b.revision);
const a6ok =
  correction1._tag === "ok" &&
  w2history.length === 2 &&
  w2history[0].value.money.taxBasis === "not_specified" &&
  w2history[0].value.money.amount.value === "10000" &&
  w2history[1].value.money.taxBasis === "net" &&
  w2history[1].value.money.amount.value === "10000" &&
  w2history[1].origin === "correction" &&
  w2history[1].reason === "Szef potwierdził kwotę netto" &&
  w2history[1].supersedesRevisionId === w2history[0].revisionId &&
  projectionConsistent(st2.value) === null;
record(
  "A6 adding the tax basis creates a revision; not_specified history retained",
  a6ok ? "PASS" : "FAIL",
  `history=${w2history.map((r) => r.value.money.taxBasis).join(" -> ")}`,
);

// --- A8 preparation: pause the old plans while the finding is at revision 2 ------
// Both plans are prepared NOW (captured expectations: revision 2); A7's newer
// correction then moves the finding to 3; only afterwards are they resumed.
const oldPlan = () => ({
  sourceId: S2,
  plannedRevisions: [
    {
      findingId: w2.findingId,
      scope: { _tag: "company" },
      semanticKey: "cena.ustalona",
      value: moneyValue("gross"),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S2, F2, "support")],
      derivesFrom: [],
    },
  ],
});
const prepared2a = await memory("memory.prepareChangeSet", oldPlan());
const prepared2b = await memory("memory.prepareChangeSet", oldPlan());

// --- A7: correction chain with full history and explicit clear ------------------
const correction2 = await memory("memory.correctFinding", {
  findingId: w2.findingId,
  expectedRevision: 2,
  value: moneyValue("net"),
  knowledgeState: { _tag: "unknown", reason: "Szef zmienił zdanie co do kwoty" },
  reason: "Wycofanie kwoty do ponownego ustalenia",
});
const st3 = await state();
const w2chain = st3.value.revisions
  .filter((r) => r.findingId === w2.findingId)
  .sort((a, b) => a.revision - b.revision);
const wrongExpectation = await memory("memory.correctFinding", {
  findingId: w2.findingId,
  expectedRevision: 1, // stale: the finding is at 3
  value: moneyValue("gross"),
  knowledgeState: known,
  reason: "Stara rewizja",
});
const a7ok =
  correction2._tag === "ok" &&
  w2chain.length === 3 &&
  w2chain[2].knowledgeState._tag === "unknown" &&
  wrongExpectation._tag === "error" &&
  wrongExpectation.error._tag === "conflict" &&
  projectionConsistent(st3.value) === null;
record(
  "A7 correction chain keeps full history; stale expected revision refuses (arrival time never decides)",
  a7ok ? "PASS" : "FAIL",
  `chain=${w2chain.length} stale=${wrongExpectation.error?._tag}`,
);

// --- A8: the paused old plan cannot roll back the newer correction --------------
// The plans above were prepared while the finding was at revision 2; A7's
// newer correction then moved it to 3. One plan is resumed with the OLD
// caller expectation (2); the other with an honestly refreshed one (3). Both
// must refuse: the CAPTURED expectations are stale, so resuming the old plan
// is impossible regardless of what the caller now claims.
const resumeOld = await memory("memory.publishChangeSet", {
  changeSetId: prepared2a._tag === "ok" ? prepared2a.value.changeSetId : "",
  expectedRevisions: [{ findingId: w2.findingId, revision: 2 }],
});
const resumeRefreshed = await memory("memory.publishChangeSet", {
  changeSetId: prepared2b._tag === "ok" ? prepared2b.value.changeSetId : "",
  expectedRevisions: [{ findingId: w2.findingId, revision: 3 }],
});
const st4 = await state();
const w2after = st4.value.findings.find((f) => f.findingId === w2.findingId);
const w2final = st4.value.revisions
  .filter((r) => r.findingId === w2.findingId)
  .sort((a, b) => a.revision - b.revision);
const failedSetA = st4.value.changeSets.find(
  (c) => c.changeSetId === (prepared2a._tag === "ok" ? prepared2a.value.changeSetId : ""),
);
const failedSetB = st4.value.changeSets.find(
  (c) => c.changeSetId === (prepared2b._tag === "ok" ? prepared2b.value.changeSetId : ""),
);
const a8ok =
  resumeOld._tag === "error" &&
  resumeOld.error._tag === "conflict" &&
  resumeOld.error.code === "stale_plan" &&
  resumeRefreshed._tag === "error" &&
  resumeRefreshed.error.code === "stale_plan" &&
  w2after.revisionCounter === 3 &&
  w2final.length === 3 &&
  w2final[2].knowledgeState._tag === "unknown" &&
  failedSetA.state === "failed" &&
  failedSetA.failedReason === "stale_plan" &&
  failedSetB.state === "failed" &&
  failedSetB.failedReason === "stale_plan" &&
  projectionConsistent(st4.value) === null;
record(
  "A8 paused old plan refuses to resume after a newer correction (stale-plan guard, both expectation paths)",
  a8ok ? "PASS" : "FAIL",
  `old=${resumeOld.error?.code} refreshed=${resumeRefreshed.error?.code} sets=${failedSetA?.failedReason},${failedSetB?.failedReason}`,
);

// --- A9: concurrent publishes of one plan commit exactly once -------------------
const plan3 = {
  sourceId: S1,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "notatka.robocza",
      value: { _tag: "text_note", text: "sprawdzenie atomowości" },
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, null, "support")],
      derivesFrom: [],
    },
  ],
};
const prepared3 = await memory("memory.prepareChangeSet", plan3);
const [pubA, pubB] = await Promise.all([
  memory("memory.publishChangeSet", {
    changeSetId: prepared3._tag === "ok" ? prepared3.value.changeSetId : "",
    expectedRevisions: [],
  }),
  memory("memory.publishChangeSet", {
    changeSetId: prepared3._tag === "ok" ? prepared3.value.changeSetId : "",
    expectedRevisions: [],
  }),
]);
const st5 = await state();
const note = findingBy(st5.value, "notatka.robocza");
const oks = [pubA, pubB].filter((r) => r._tag === "ok").length;
const conflicts = [pubA, pubB].filter(
  (r) => r._tag === "error" && r.error._tag === "conflict",
).length;
const a9ok =
  oks === 1 &&
  conflicts === 1 &&
  note !== undefined &&
  note.revisionCounter === 1 &&
  st5.value.revisions.filter((r) => r.semanticKey === "notatka.robocza").length === 1 &&
  projectionConsistent(st5.value) === null;
record(
  "A9 two concurrent publishes of one plan commit exactly once (the loser refuses, no double revision)",
  a9ok ? "PASS" : "FAIL",
  `ok=${oks} conflict=${conflicts} revisions for note=1`,
);

// --- A10: cyclic derivation rejected --------------------------------------------
const plan4 = {
  sourceId: S2,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "wniosek.ryzyko",
      value: { _tag: "text_note", text: "ryzyko opóźnienia dostawy" },
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [],
      derivesFrom: [w1.findingId],
    },
  ],
};
const prepared4 = await memory("memory.prepareChangeSet", plan4);
const published4 = await memory("memory.publishChangeSet", {
  changeSetId: prepared4._tag === "ok" ? prepared4.value.changeSetId : "",
  expectedRevisions: [],
});
const st6 = await state();
const inference = findingBy(st6.value, "wniosek.ryzyko");
const depRow = st6.value.dependencies.find(
    (d) => d.dependentFindingId === inference?.findingId && d.dependsOnFindingId === w1.findingId,
  );
// Now the cycle attempt: W1 derives from the inference that derives from W1.
const cyclePlan = {
  sourceId: S2,
  plannedRevisions: [
    {
      findingId: w1.findingId,
      scope: { _tag: "company" },
      semanticKey: "termin.dostawy",
      value: temporalValue("2026-09-09", "jutro", "agreed"),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S2, null, "support")],
      derivesFrom: [inference?.findingId ?? w1.findingId],
    },
  ],
};
const cycleAttempt = await memory("memory.prepareChangeSet", cyclePlan);
const a10ok =
  published4._tag === "ok" &&
  depRow !== undefined &&
  depRow.cause === "derivation" &&
  cycleAttempt._tag === "error" &&
  cycleAttempt.error._tag === "validation" &&
  cycleAttempt.error.code === "planned_dependencies_cyclic" &&
  st6.value.dependencies.length === 1;
record(
  "A10 derivation edge commits with its revision; the closing cyclic edge is rejected",
  a10ok ? "PASS" : "FAIL",
  `cycle=${cycleAttempt.error?.code}`,
);

// --- A11: cross-tenant evidence and reads refuse ---------------------------------
const foreignEvidence = await memory("memory.prepareChangeSet", {
  sourceId: S1,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "obcy.termin",
      value: temporalValue("2026-09-09", "jutro", "agreed"),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(SOURCE_B, null, "support")],
      derivesFrom: [],
    },
  ],
});
const foreignRead = await readCurrent({ _tag: "project", projectId: P1 }, SESSION_B);
const foreignCorrection = await memory(
  "memory.correctFinding",
  {
    findingId: w1.findingId,
    expectedRevision: 1,
    value: temporalValue("2026-09-10", "pojutrze", "agreed"),
    knowledgeState: known,
    reason: "próba obcej firmy",
  },
  SESSION_B,
);
const stateAsB = await state(SESSION_B);
const a11ok =
  foreignEvidence._tag === "error" &&
  foreignEvidence.error._tag === "forbidden" &&
  foreignRead._tag === "error" &&
  foreignRead.error._tag === "not_found" &&
  foreignCorrection._tag === "error" &&
  foreignCorrection.error._tag === "not_found" &&
  stateAsB.value.findings.length === 0;
record(
  "A11 cross-tenant evidence, scope reads and corrections all refuse; B sees none of A's memory",
  a11ok ? "PASS" : "FAIL",
  `evidence=${foreignEvidence.error?._tag} read=${foreignRead.error?._tag} correction=${foreignCorrection.error?._tag}`,
);

// --- A12: transaction failure between revision and projection writes -----------
const plan5 = {
  sourceId: S1,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "notatka.uciekajaca",
      value: { _tag: "text_note", text: "ta notatka nie powinna istnieć" },
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, null, "support")],
      derivesFrom: [],
    },
  ],
};
const prepared5 = await memory("memory.prepareChangeSet", plan5);
let crashError = null;
try {
  await client().action("memory/findings/probe:probeCrashPublish", {
    envelope: envelope("memory.publishChangeSet", {
      changeSetId: prepared5._tag === "ok" ? prepared5.value.changeSetId : "",
      expectedRevisions: [],
    }),
  });
} catch (error) {
  crashError = String(error).slice(0, 80);
}
const st7 = await state();
const crashedSet = st7.value.changeSets.find(
  (c) => c.changeSetId === (prepared5._tag === "ok" ? prepared5.value.changeSetId : ""),
);
const a12ok =
  crashError !== null &&
  findingBy(st7.value, "notatka.uciekajaca") === undefined &&
  st7.value.revisions.every((r) => r.semanticKey !== "notatka.uciekajaca") &&
  crashedSet.state === "prepared" &&
  projectionConsistent(st7.value) === null;
record(
  "A12 a crash after the publish writes rolls back EVERYTHING (no revision, no projection, changeSet still prepared)",
  a12ok ? "PASS" : "FAIL",
  `crash="${crashError}"`,
);

// --- A13: withdrawal marking with history intact --------------------------------
const notWithdrawn = await client().action("memory/findings/probe:probeMarkWithdrawn", {
  sourceId: S2,
  reason: "S2 jeszcze nie wycofane",
});
await client().action("memory/findings/probe:probeWithdrawSource", {
  sourceId: S1,
  reason: "Szef wysłał tę wiadomość przez pomyłkę",
});
const marked = await client().action("memory/findings/probe:probeMarkWithdrawn", {
  sourceId: S1,
  reason: "Szef wysłał tę wiadomość przez pomyłkę",
});
const st8 = await state();
const w1chain = st8.value.revisions
  .filter((r) => r.findingId === w1.findingId)
  .sort((a, b) => a.revision - b.revision);
const w1now = st8.value.findings.find((f) => f.findingId === w1.findingId);
const w2now = st8.value.findings.find((f) => f.findingId === w2.findingId);
const w4now = st8.value.findings.find((f) => f.findingId === w4?.findingId);
const w1last = w1chain[w1chain.length - 1];
const w1first = w1chain[0];
const a13ok =
  notWithdrawn._tag === "error" &&
  notWithdrawn.error._tag === "conflict" &&
  marked._tag === "ok" &&
  marked.value.markedFindingIds.includes(w1.findingId) &&
  !marked.value.markedFindingIds.includes(w2.findingId) &&
  !marked.value.markedFindingIds.includes(w4?.findingId ?? "") &&
  w1chain.length === 2 &&
  w1last.origin === "withdrawal_marking" &&
  w1last.knowledgeState._tag === "unknown" &&
  String(w1last.knowledgeState.reason).startsWith("source_withdrawn:") &&
  w1last.value.temporal.shape.day === "2026-09-09" && // value preserved verbatim
  w1last.supersedesRevisionId === w1first.revisionId &&
  w1now.knowledgeState._tag === "unknown" &&
  // W2 (explicit correction current) and W4 (independent S2 witness) got NO
  // marking revision: their histories did not grow.
  st8.value.revisions.filter((r) => r.findingId === w2.findingId).length === 3 &&
  st8.value.revisions.filter((r) => r.findingId === w4?.findingId).length === 1 &&
  w4now.knowledgeState._tag === "known" && // independent witness on S2
  projectionConsistent(st8.value) === null;
record(
  "A13 withdrawal marks the solely-supported finding (value + history intact); independent witness and explicit correction survive; not-yet-withdrawn refuses",
  a13ok ? "PASS" : "FAIL",
  `marked=${JSON.stringify(marked.value?.markedFindingIds?.length)} w1 chain=${w1chain.length} reason="${w1last?.knowledgeState?.reason}"`,
);

// --- A14: a withdrawn evidence witness fails the set (the one marking rule) ------
// S1 is withdrawn now. A plan whose evidence cites S1 still PREPARES (prepare
// checks tenancy, not lifecycle), but its publish must refuse AND mark the
// set failed: the staged plan can never publish as-is, so by_company_state
// must not show it as actionable prepared.
const staleEvidencePlan = {
  sourceId: S2,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey: "po.wycofaniu",
      value: { _tag: "text_note", text: "nie powinno powstać" },
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(S1, F1, "support")],
      derivesFrom: [],
    },
  ],
};
const staleEvidencePrepared = await memory("memory.prepareChangeSet", staleEvidencePlan);
const staleEvidencePublish = await memory("memory.publishChangeSet", {
  changeSetId: staleEvidencePrepared._tag === "ok" ? staleEvidencePrepared.value.changeSetId : "",
  expectedRevisions: [],
});
const st9 = await state();
const staleEvidenceSet = st9.value.changeSets.find(
  (c) => c.changeSetId === (staleEvidencePrepared._tag === "ok" ? staleEvidencePrepared.value.changeSetId : ""),
);
const a14ok =
  staleEvidencePrepared._tag === "ok" &&
  staleEvidencePublish._tag === "error" &&
  staleEvidencePublish.error._tag === "conflict" &&
  staleEvidencePublish.error.code === "evidence_source_no_longer_active" &&
  staleEvidenceSet.state === "failed" &&
  staleEvidenceSet.failedReason === "evidence_source_no_longer_active" &&
  findingBy(st9.value, "po.wycofaniu") === undefined &&
  projectionConsistent(st9.value) === null;
record(
  "A14 publishing against a withdrawn evidence witness refuses AND marks the set failed (never actionable prepared)",
  a14ok ? "PASS" : "FAIL",
  `publish=${staleEvidencePublish.error?.code} set=${staleEvidenceSet?.state}/${staleEvidenceSet?.failedReason}`,
);

// --- A15: final consistency sweep ------------------------------------------------
const stFinal = await state();
const sweep = projectionConsistent(stFinal.value);
const a15ok =
  sweep === null &&
  stFinal.value.findings.length === 5 &&
  stFinal.value.groups.every(
    (g) => g.state === "published" || g.state === "failed" || g.state === "prepared",
  ) &&
  stFinal.value.groups.filter((g) => g.state === "prepared").length === 1; // the crashed one
record(
  "A15 final state: every current projection equals its latest revision after every path",
  a15ok ? "PASS" : "FAIL",
  sweep === null ? `findings=${stFinal.value.findings.length}` : sweep,
);

const ok = summarize();
process.exit(ok ? 0 : 1);
