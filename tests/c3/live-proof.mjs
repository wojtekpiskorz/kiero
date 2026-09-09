/**
 * C3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/c3, instance industrious-crane-319, EU).
 *
 * Actor context: the A3 service-bridge identity (the service account's own
 * session, resolved through the canonical resolution and authorization seam)
 * plus the C2-seeded second-company session for tenant isolation. No
 * development-auth shortcut exists; sessions are created server-side by
 * guarded probe fixtures.
 *
 * Run: node tests/c3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = "industrious-crane-319";
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
const ext = (operation, input, sessionId) =>
  client().action("memory/extensions/probe:probeExtensionCommand", {
    envelope: envelope(operation, input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const memory = (operation, input, sessionId) =>
  client().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const extState = (sessionId) =>
  client().action("memory/extensions/probe:probeExtensionState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const memState = (sessionId) =>
  client().action("memory/findings/probe:probeMemoryState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });

const known = { _tag: "known" };
const evidence = (sourceId, fragmentId, supportKind) => ({
  sourceId,
  fragmentId,
  supportKind,
});
const mmField = { fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "mm" };
const extensionValue = (definitionVersionId, value) => ({
  _tag: "extension",
  definitionVersionId,
  extensionValue: value,
});
const extensionPlan = (sourceId, semanticKey, definitionVersionId, value) => ({
  sourceId,
  plannedRevisions: [
    {
      findingId: null,
      scope: { _tag: "company" },
      semanticKey,
      value: extensionValue(definitionVersionId, value),
      knowledgeState: known,
      effectiveFrom: null,
      evidence: [evidence(sourceId, null, "support")],
      derivesFrom: [],
    },
  ],
});

async function publish(plan) {
  const prepared = await memory("memory.prepareChangeSet", plan);
  if (prepared._tag !== "ok") {
    return { prepared, published: prepared };
  }
  const published = await memory("memory.publishChangeSet", {
    changeSetId: prepared.value.changeSetId,
    expectedRevisions: [],
  });
  return { prepared, published };
}

console.log(`# C3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const fixtures = await client().action("memory/findings/probe:probeSeedMemoryFixtures", {});
if (fixtures._tag !== "ok") throw new Error(`memory fixtures failed`);
const S1 = fixtures.value.sourceId;
const S2 = fixtures.value.secondSourceId;
const isolation = await client().action("memory/findings/probe:probeSeedMemoryIsolation", {});
if (isolation._tag !== "ok") throw new Error(`isolation seeding failed`);
const SESSION_B = isolation.value.sessionId;
const shared = await client().action("memory/extensions/probe:probeSeedSharedExtension", {});
if (shared._tag !== "ok") throw new Error(`shared fixture failed: ${JSON.stringify(shared)}`);
const SH_DEF = shared.value.definitionId;
const SH_VER = shared.value.versionId;

// Run-unique names: the leased deployment is shared across proof runs, and
// findings/definitions are append-only. The run token keeps every identity
// fresh so each transcript exercises creation, not idempotent reuse.
const RUN = String(Date.now() % 100000);
const MM_NAME = `Grubość płytki (mm) r${RUN}`;
const CM_NAME = `Grubość płytki (cm) r${RUN}`;
const RACE_NAME = `Wykończenie fugi r${RUN}`;

// --- C1: define a firm definition (version 1, firm-scoped) ----------------------
const defined = await ext("memory.defineExtension", {
  name: MM_NAME,
  fields: [mmField],
});
const st1 = await extState();
const mmDefinition = st1.value.definitions.find((d) => d.stableKey === `grubosc plytki mm r${RUN}`);
const c1ok =
  defined._tag === "ok" &&
  defined.value.created === true &&
  mmDefinition !== undefined &&
  mmDefinition.shared === false &&
  mmDefinition.versions.length === 1 &&
  mmDefinition.versions[0].version === 1 &&
  mmDefinition.versions[0].fields[0].unit === "mm";
record(
  "C1 define creates a firm-scoped definition with immutable version 1 (quantity declares its unit)",
  c1ok ? "PASS" : "FAIL",
  `created=${defined.value?.created} versions=${mmDefinition?.versions?.length}`,
);
const MM_DEF = defined._tag === "ok" ? defined.value.definitionId : "";
const MM_V1 = defined._tag === "ok" ? defined.value.versionId : "";

// --- C2: use it in a finding through C2's publish; usage counts from commits ----
const { prepared: p2, published: pub2 } = await publish(
  extensionPlan(S1, `grubosc.plytki.banan.${RUN}`, MM_V1, {
    _tag: "quantity",
    amount: "8",
    unit: "mm",
  }),
);
const st2 = await extState();
const usageV1 = st2.value.usage.find((u) => u.usedVersionId === MM_V1);
const c2ok =
  p2._tag === "ok" &&
  pub2._tag === "ok" &&
  usageV1 !== undefined &&
  usageV1.usageCount === 1 &&
  usageV1.definitionId === MM_DEF;
record(
  "C2 an extension value publishes through C2's atomic path; the committed-usage counter moves with the revision",
  c2ok ? "PASS" : "FAIL",
  `publish=${pub2._tag} usage=${usageV1?.usageCount}`,
);

// --- C3: values validate against the EXACT version (refusals) -------------------
const wrongUnit = await memory("memory.prepareChangeSet", extensionPlan(S1, `grubosc.zla.${RUN}`, MM_V1, {
  _tag: "quantity",
  amount: "8",
  unit: "cm",
}));
const wrongOption = await memory(
  "memory.prepareChangeSet",
  extensionPlan(S1, `kolor.zly.${RUN}`, SH_VER, { _tag: "enum", optionId: "czarna" }),
);
const foreignVersion = await memory(
  "memory.prepareChangeSet",
  extensionPlan(S1, `obca.definicja.${RUN}`, "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f", {
    _tag: "text",
    text: "nieistniejąca wersja",
  }),
);
const validateOk = await ext("memory.validateExtensionValue", {
  versionId: MM_V1,
  value: { _tag: "quantity", amount: "9", unit: "mm" },
});
const c3ok =
  wrongUnit._tag === "error" &&
  wrongUnit.error._tag === "validation" &&
  wrongUnit.error.code === "value_unit_mismatch" &&
  wrongOption._tag === "error" &&
  wrongOption.error.code === "enum_option_unknown" &&
  foreignVersion._tag === "error" &&
  foreignVersion.error._tag === "validation" &&
  validateOk._tag === "ok" &&
  validateOk.value.definitionId === MM_DEF;
record(
  "C3 prepare/validate refuse wrong unit, undeclared enum option and invisible versions; the validate-value operation resolves the exact version",
  c3ok ? "PASS" : "FAIL",
  `unit=${wrongUnit.error?.code} option=${wrongOption.error?.code} invisible=${foreignVersion.error?._tag}`,
);

// --- C4: a compatible new version; historic values keep theirs ------------------
const versioned = await ext("memory.versionExtensionDefinition", {
  definitionId: MM_DEF,
  changeNote: "Dodano opcjonalną tolerancję; doprecyzowano etykietę",
  fields: [
    { ...mmField, label: "Grubość płytki (nominalna)" },
    { fieldId: "tolerancja", label: "Tolerancja", kind: "quantity", unit: "mm" },
  ],
});
const st4 = await extState();
const mmAfter = st4.value.definitions.find((d) => d.definitionId === MM_DEF);
const v1Snapshot = mmAfter?.versions.find((v) => v.version === 1);
const v2Snapshot = mmAfter?.versions.find((v) => v.version === 2);
const mem4 = await memState();
const extensionRevision = mem4.value.revisions.find(
  (r) => r.semanticKey === `grubosc.plytki.banan.${RUN}`,
);
const c4ok =
  versioned._tag === "ok" &&
  versioned.value.version === 2 &&
  mmAfter?.currentVersionId === versioned.value.versionId &&
  v1Snapshot !== undefined &&
  v1Snapshot.fields.length === 1 &&
  v1Snapshot.fields[0].label === "Grubość płytki" &&
  v1Snapshot.changeNote === "initial version" &&
  v2Snapshot?.fields.length === 2 &&
  extensionRevision !== undefined &&
  extensionRevision.value.definitionVersionId === MM_V1;
record(
  "C4 version 2 (label change + optional field) appends without rewriting: v1 snapshot intact, the committed revision still names v1 (historic interpretation preserved)",
  c4ok ? "PASS" : "FAIL",
  `v2=${versioned.value?.version} v1-label="${v1Snapshot?.fields[0]?.label}" revision-version=${extensionRevision?.value?.definitionVersionId === MM_V1 ? "v1" : "?"}`,
);
const MM_V2 = versioned._tag === "ok" ? versioned.value.versionId : "";

// --- C5: the incompatible millimetre→centimetre version refuses ------------------
const cmAttempt = await ext("memory.versionExtensionDefinition", {
  definitionId: MM_DEF,
  changeNote: "Próba zmiany znaczenia na centymetry",
  fields: [
    { fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "cm" },
    { fieldId: "tolerancja", label: "Tolerancja", kind: "quantity", unit: "mm" },
  ],
});
const kindAttempt = await ext("memory.versionExtensionDefinition", {
  definitionId: MM_DEF,
  changeNote: "Próba zmiany rodzaju pola",
  fields: [
    { fieldId: "grubosc", label: "Grubość płytki", kind: "text" },
    { fieldId: "tolerancja", label: "Tolerancja", kind: "quantity", unit: "mm" },
  ],
});
const st5 = await extState();
const mmAfter5 = st5.value.definitions.find((d) => d.definitionId === MM_DEF);
const c5ok =
  cmAttempt._tag === "error" &&
  cmAttempt.error._tag === "conflict" &&
  cmAttempt.error.code === "field_unit_changed" &&
  kindAttempt._tag === "error" &&
  kindAttempt.error.code === "field_kind_changed" &&
  mmAfter5?.versions.length === 2;
record(
  "C5 versioning millimetres into centimetres (or another kind) refuses conflict: a new definition or explicit migration is required",
  c5ok ? "PASS" : "FAIL",
  `unit=${cmAttempt.error?.code} kind=${kindAttempt.error?.code} versions-still=${mmAfter5?.versions.length}`,
);

// --- C6: v2 values: optional field may be absent, unknown field refuses ----------
const { published: pub6a } = await publish(
  extensionPlan(S1, `grubosc.plytki.banan2.${RUN}`, MM_V2, {
    _tag: "object",
    fields: [
      { fieldId: "grubosc", value: { _tag: "quantity", amount: "8", unit: "mm" } },
    ],
  }),
);
const { published: pub6b } = await publish(
  extensionPlan(S1, `grubosc.plytki.banan3.${RUN}`, MM_V2, {
    _tag: "object",
    fields: [
      { fieldId: "grubosc", value: { _tag: "quantity", amount: "8", unit: "mm" } },
      { fieldId: "nieznane", value: { _tag: "quantity", amount: "1", unit: "mm" } },
    ],
  }),
);
const st6 = await extState();
const usageV2 = st6.value.usage.find((u) => u.usedVersionId === MM_V2);
const c6ok =
  pub6a._tag === "ok" &&
  pub6b._tag === "error" &&
  pub6b.error._tag === "validation" &&
  usageV2?.usageCount === 1;
record(
  "C6 a v2 value may omit the optional field (v1 fields stay required); an unknown field refuses and counts nothing",
  c6ok ? "PASS" : "FAIL",
  `optional-ok=${pub6a._tag} unknown=${pub6b.error?.code} usageV2=${usageV2?.usageCount}`,
);

// --- C7: near-duplicate names: typed reuse outcome, never a silent reuse ---------
const searchConflict = await ext("memory.searchExtensionCatalog", {
  name: CM_NAME,
  fields: [{ fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "cm" }],
});
const mmCandidate = searchConflict.value?.candidates?.find(
  (c) => c.definitionId === MM_DEF,
);
const definedCm = await ext("memory.defineExtension", {
  name: CM_NAME,
  fields: [{ fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "cm" }],
});
const st7 = await extState();
const cmDefinitions = st7.value.definitions.filter((d) => d.stableKey === `grubosc plytki cm r${RUN}`);
const c7ok =
  mmCandidate !== undefined &&
  mmCandidate.similarity.verdict === "name_conflict" &&
  mmCandidate.similarity.structureCompatible === false &&
  definedCm._tag === "ok" &&
  definedCm.value.created === true &&
  definedCm.value.definitionId !== MM_DEF &&
  cmDefinitions.length === 1 &&
  cmDefinitions[0].definitionId === definedCm.value.definitionId;
record(
  "C7 equivalent names with incompatible units: the catalog answers a typed name_conflict and define creates a SEPARATE definition (no silent reuse)",
  c7ok ? "PASS" : "FAIL",
  `verdict=${mmCandidate?.similarity?.verdict} separate=${definedCm.value?.definitionId !== MM_DEF}`,
);

// --- C8: idempotent define: the identical proposal reuses -----------------------
const redefine = await ext("memory.defineExtension", {
  name: MM_NAME,
  fields: [mmField],
});
const st8 = await extState();
const mmCount = st8.value.definitions.filter((d) => d.stableKey === `grubosc plytki mm r${RUN}`).length;
const c8ok =
  redefine._tag === "ok" &&
  redefine.value.created === false &&
  redefine.value.definitionId === MM_DEF &&
  redefine.value.versionId === MM_V2 &&
  mmCount === 1;
record(
  "C8 re-defining the identical name+structure reuses the existing definition (one catalog entry, current version returned)",
  c8ok ? "PASS" : "FAIL",
  `created=${redefine.value?.created} entries=${mmCount}`,
);

// --- C9: same name, incompatible structure refuses loudly ------------------------
const sameNameConflict = await ext("memory.defineExtension", {
  name: MM_NAME,
  fields: [
    { fieldId: "grubosc", label: "Grubość płytki", kind: "quantity", unit: "cm" },
  ],
});
const c9ok =
  sameNameConflict._tag === "error" &&
  sameNameConflict.error._tag === "conflict" &&
  sameNameConflict.error.code === "extension_definition_name_conflict";
record(
  "C9 the SAME name with an incompatible structure refuses conflict (rename or migrate explicitly)",
  c9ok ? "PASS" : "FAIL",
  `code=${sameNameConflict.error?.code}`,
);

// --- C10: shared catalog: reuse suggestion, per-firm usage, read-only ------------
const searchShared = await ext("memory.searchExtensionCatalog", {
  name: "Kolor fugi",
  fields: [
    {
      fieldId: "kolor",
      label: "Kolor fugi",
      kind: "enum",
      options: [
        { optionId: "bezowa", label: "Beżowa" },
        { optionId: "szara", label: "Szara" },
        { optionId: "antracytowa", label: "Antracytowa" },
      ],
    },
  ],
});
const sharedCandidate = searchShared.value?.candidates?.find((c) => c.definitionId === SH_DEF);
// Shared usage accumulates across proof runs on this leased deployment: the
// assertion is a DELTA of exactly one committed use per firm.
const sharedUsageBefore =
  (await extState()).value.usage
    .filter((u) => u.definitionId === SH_DEF)
    .reduce((sum, u) => sum + u.usageCount, 0) ?? 0;
const { published: pubSharedA } = await publish(
  extensionPlan(S2, `kolor.fugi.banan.${RUN}`, SH_VER, { _tag: "enum", optionId: "bezowa" }),
);
// The B-side publish runs under B's session (its own source as evidence).
const { published: pubSharedB } = await (async () => {
  const prepared = await memory(
    "memory.prepareChangeSet",
    extensionPlan(isolation.value.sourceId, `kolor.fugi.firmaB.${RUN}`, SH_VER, {
      _tag: "enum",
      optionId: "szara",
    }),
    SESSION_B,
  );
  if (prepared._tag !== "ok") return { prepared, published: prepared };
  const published = await memory(
    "memory.publishChangeSet",
    { changeSetId: prepared.value.changeSetId, expectedRevisions: [] },
    SESSION_B,
  );
  return { prepared, published };
})();
const usageA = (await extState()).value.usage.filter((u) => u.definitionId === SH_DEF);
const usageADelta =
  usageA.reduce((sum, u) => sum + u.usageCount, 0) - sharedUsageBefore;
const sharedVersionAttempt = await ext(
  "memory.versionExtensionDefinition",
  {
    definitionId: SH_DEF,
    changeNote: "Próba firmy: nowa wersja wspólnej definicji",
    fields: [
      {
        fieldId: "kolor",
        label: "Kolor fugi",
        kind: "enum",
        options: [{ optionId: "bezowa", label: "Beżowa" }],
      },
    ],
  },
);
const c10ok =
  sharedCandidate !== undefined &&
  sharedCandidate.shared === true &&
  sharedCandidate.similarity.verdict === "reuse_candidate" &&
  pubSharedA._tag === "ok" &&
  pubSharedB._tag === "ok" &&
  usageADelta === 1 &&
  sharedVersionAttempt._tag === "error" &&
  sharedVersionAttempt.error._tag === "forbidden" &&
  sharedVersionAttempt.error.code === "shared_definition_readonly";
record(
  "C10 shared definitions: suggested for reuse, usable per firm with per-firm committed usage, and versioning them is product-code-only (firm refuses forbidden)",
  c10ok ? "PASS" : "FAIL",
  `verdict=${sharedCandidate?.similarity?.verdict} usageA-delta=${usageADelta} version-attempt=${sharedVersionAttempt.error?.code}`,
);

// --- C11: cross-tenant isolation -------------------------------------------------
const versionB = await ext(
  "memory.versionExtensionDefinition",
  {
    definitionId: MM_DEF,
    changeNote: "Próba firmy B",
    fields: [
      { ...mmField, label: "Grubość płytki" },
      { fieldId: "tolerancja", label: "Tolerancja", kind: "quantity", unit: "mm" },
    ],
  },
  SESSION_B,
);
const defineB = await ext(
  "memory.defineExtension",
  { name: MM_NAME, fields: [mmField] },
  SESSION_B,
);
const stA = await extState();
const stB = await extState(SESSION_B);
const ownA = stA.value.definitions.filter((d) => !d.shared && d.stableKey === `grubosc plytki mm r${RUN}`);
const ownB = stB.value.definitions.filter((d) => !d.shared && d.stableKey === `grubosc plytki mm r${RUN}`);
// The isolation invariant: NOTHING firm-owned in A's catalog appears in B's
// view (and vice versa), regardless of run history.
const firmIdsA = new Set(stA.value.definitions.filter((d) => !d.shared).map((d) => d.definitionId));
const bSeesNoA = stB.value.definitions
  .filter((d) => !d.shared)
  .every((d) => !firmIdsA.has(d.definitionId));
const c11ok =
  versionB._tag === "error" &&
  versionB.error._tag === "not_found" &&
  defineB._tag === "ok" &&
  defineB.value.created === true &&
  ownA.length === 1 &&
  ownB.length === 1 &&
  ownA[0].definitionId !== ownB[0].definitionId &&
  bSeesNoA;
record(
  "C11 firm B cannot see or version firm A's definitions; its own same-named definition is a separate row and no A-owned definition ever appears in B's catalog",
  c11ok ? "PASS" : "FAIL",
  `versionB=${versionB.error?._tag} ownA=${ownA.length} ownB=${ownB.length} bSeesNoA=${bSeesNoA}`,
);

// --- C12: racing duplicate proposals converge on one reusable result -------------
const raceName = RACE_NAME;
const raceFields = [{ fieldId: "kolor", label: "Kolor fugi", kind: "text" }];
const [raceA, raceB] = await Promise.all([
  ext("memory.defineExtension", { name: raceName, fields: raceFields }),
  ext("memory.defineExtension", { name: raceName, fields: raceFields }),
]);
const st12 = await extState();
const raced = st12.value.definitions.filter(
  (d) => !d.shared && d.stableKey === `wykonczenie fugi r${RUN}`,
);
const oks = [raceA, raceB].filter((r) => r._tag === "ok");
const createdTrue = oks.filter((r) => r.value.created === true).length;
const sameId = oks.every((r) => r.value.definitionId === oks[0]?.value.definitionId);
const usageTotal = st12.value.usage
  .filter((u) => u.definitionId === raced[0]?.definitionId)
  .reduce((sum, u) => sum + u.usageCount, 0);
const c12ok =
  oks.length === 2 &&
  createdTrue === 1 &&
  sameId &&
  raced.length === 1 &&
  usageTotal === 0;
record(
  "C12 two racing identical proposals converge on ONE definition (exactly one created; both return the same reusable id; no usage invented)",
  c12ok ? "PASS" : "FAIL",
  `ok=${oks.length} created=${createdTrue} entries=${raced.length} usage=${usageTotal}`,
);

// --- C13: the storage boundary refuses invalid stored shapes --------------------
const invalidPayloads = {
  recursive: [{ fieldId: "wezel", label: "Węzeł", kind: "object" }],
  executableLooking: [{ fieldId: "f", label: "F", kind: "text", run: "process.exit(1)" }],
};
const refusals = {};
for (const [label, payload] of Object.entries(invalidPayloads)) {
  const attempt = await client().action(
    "memory/extensions/probe:probeConvexValidatorRefuses",
    { payload },
  );
  refusals[label] = attempt.value?.rejected === true;
}
// Array LENGTH cannot be expressed by Convex 1.45 validators, so the size
// bound is enforced at every WRITE PATH: the checked dispatch refuses an
// oversized draft before any handler runs.
const oversizedDraft = await ext("memory.defineExtension", {
  name: "Za duża definicja",
  fields: Array.from({ length: 33 }, (_, i) => ({
    fieldId: `f${i}`,
    label: `F${i}`,
    kind: "text",
  })),
});
const st13 = await extState();
const proofRows = st13.value.definitions
  .flatMap((d) => d.versions)
  .filter((v) => v.version === 99);
const oversizedStored = st13.value.definitions.some(
  (d) => d.stableKey.startsWith("za duza definicja"),
);
const c13ok =
  refusals.recursive &&
  refusals.executableLooking &&
  proofRows.length === 0 &&
  oversizedDraft._tag === "error" &&
  oversizedDraft.error._tag === "validation" &&
  !oversizedStored;
record(
  "C13 the Convex table validators refuse recursive and executable-looking snapshots at the storage boundary; the oversized draft refuses at the only write path (nothing stored)",
  c13ok ? "PASS" : "FAIL",
  `refusals=${JSON.stringify(refusals)} oversized=${oversizedDraft.error?.code ?? "stored!"}`,
);

// --- C14: correction of an extension finding keeps version discipline -----------
const mem14 = await memState();
const extFinding = mem14.value.findings.find((f) => f.semanticKey === `grubosc.plytki.banan.${RUN}`);
const badCorrection = await memory("memory.correctFinding", {
  findingId: extFinding.findingId,
  expectedRevision: 1,
  value: extensionValue(MM_V1, { _tag: "quantity", amount: "10", unit: "cm" }),
  knowledgeState: known,
  reason: "Zła jednostka",
});
const goodCorrection = await memory("memory.correctFinding", {
  findingId: extFinding.findingId,
  expectedRevision: 1,
  value: extensionValue(MM_V2, {
    _tag: "object",
    fields: [
      { fieldId: "grubosc", value: { _tag: "quantity", amount: "9", unit: "mm" } },
      { fieldId: "tolerancja", value: { _tag: "quantity", amount: "0.5", unit: "mm" } },
    ],
  }),
  knowledgeState: known,
  reason: "Doprecyzowano grubość z tolerancją",
});
const st14 = await extState();
const usageAfter = st14.value.usage.filter((u) => u.definitionId === MM_DEF);
const v2Count = usageAfter.find((u) => u.usedVersionId === MM_V2)?.usageCount ?? 0;
const mem14b = await memState();
const corrected = mem14b.value.revisions
  .filter((r) => r.findingId === extFinding.findingId)
  .sort((a, b) => a.revision - b.revision);
const c14ok =
  badCorrection._tag === "error" &&
  badCorrection.error.code === "value_unit_mismatch" &&
  goodCorrection._tag === "ok" &&
  corrected.length === 2 &&
  corrected[0].value.definitionVersionId === MM_V1 &&
  corrected[1].value.definitionVersionId === MM_V2 &&
  corrected[1].origin === "correction" &&
  v2Count === 2; // one publication (C6) + this correction
record(
  "C14 corrections validate against the exact version too: a wrong unit refuses; a v2 correction keeps the v1 history and bumps the v2 usage counter",
  c14ok ? "PASS" : "FAIL",
  `bad=${badCorrection.error?.code} chain=${corrected.map((r) => r.value.definitionVersionId === MM_V1 ? "v1" : "v2").join("->")} v2Usage=${v2Count}`,
);

// --- C15: catalog ranking with usage statistics ---------------------------------
const searchAgain = await ext("memory.searchExtensionCatalog", {
  name: MM_NAME,
  fields: [mmField],
});
const candidates = searchAgain.value?.candidates ?? [];
const mmSearch = candidates.find((c) => c.definitionId === MM_DEF);
const c15ok =
  searchAgain._tag === "ok" &&
  mmSearch !== undefined &&
  mmSearch.similarity.verdict === "reuse_candidate" &&
  mmSearch.similarity.structureCompatible === true &&
  mmSearch.usageCount >= 3 &&
  mmSearch.lastUsedAtMs !== null;
record(
  "C15 catalog search returns typed candidates with committed usage statistics (repeat-need signal from stored data, not model estimates)",
  c15ok ? "PASS" : "FAIL",
  `top=${mmSearch?.similarity?.verdict} usage=${mmSearch?.usageCount} candidates=${candidates.length}`,
);

const ok = summarize();
process.exit(ok ? 0 : 1);
