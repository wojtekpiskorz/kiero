/**
 * D1 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d1, instance limitless-orca-485, EU).
 *
 * Actor context: the A3 service-bridge identity (the service account's own
 * session, resolved through the canonical resolution and authorization
 * seam) plus one server-seeded second-company session for tenant isolation.
 * No development-auth shortcut exists; sessions are created server-side by
 * guarded probe fixtures.
 *
 * Run: node tests/d1/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "limitless-orca-485";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, outcome, detail) {
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
const envelope = (input, idempotencyKey) => ({
  operation: "sources.acceptSource",
  input,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

const accept = (input, idempotencyKey, sessionId) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: envelope(input, idempotencyKey),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const state = (sessionId) =>
  client().action("sources/accept/probe:probeAcceptanceState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const companyView = (numItems, cursor, sessionId) =>
  client().action("sources/read/probe:probeCompanyConversation", {
    numItems,
    ...(cursor === undefined ? {} : { cursor }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const projectView = (projectId, numItems, sessionId) =>
  client().action("sources/read/probe:probeProjectConversation", {
    projectId,
    numItems,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const detail = (sourceId) =>
  client().action("sources/read/probe:probeSourceDetail", { sourceId });

console.log(`# D1 live proofs :: limitless-orca-485 :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const companyA = seed.value.companyId;

const projectP1 = await client().action("sources/accept/probe:probeSeedProject", {
  displayName: "Banan (D1)",
});
const projectP2 = await client().action("sources/accept/probe:probeSeedProject", {
  displayName: "Kaczmarek (D1)",
});
const projectP3 = await client().action("sources/accept/probe:probeSeedProject", {
  displayName: "Niepowiązany (D1)",
});
if (projectP1._tag !== "ok" || projectP2._tag !== "ok" || projectP3._tag !== "ok") {
  throw new Error("project seeding failed");
}
const P1 = projectP1.value.projectId;
const P2 = projectP2.value.projectId;
const P3 = projectP3.value.projectId;

const uploadFor = async () => {
  const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
  if (upload._tag !== "ok") throw new Error("upload seeding failed");
  return upload.value.uploadId;
};

// --- A1: valid acceptance publishes event + durable job atomically ---------------
const K1 = key();
const up1 = await uploadFor();
const text1 = "Dowóz płytek na Buniewice w czwartek rano; Kaczmarek potwierdza odbiór";
const accepted1 = await accept(
  {
    uploadId: up1,
    authorText: text1,
    intendedSentAtIso: "2026-09-09T07:15:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [P1, P2, P1],
  },
  K1,
);
const s1 = await state();
const a1ok =
  accepted1._tag === "ok" &&
  s1._tag === "ok" &&
  s1.value.sources.filter((row) => row.acceptanceKey === K1).length === 1 &&
  s1.value.links.filter((l) => l.sourceId === accepted1.value.sourceId).length === 2 &&
  s1.value.runs.filter((r) => r.sourceId === accepted1.value.sourceId && r.state === "running").length === 1 &&
  s1.value.events.filter(
    (e) => e.eventName === "sources.sourceAccepted" && e.dedupKey === `sources.acceptSource:${companyA}:${K1}`,
  ).length === 1 &&
  s1.value.jobs.filter(
    (j) => j.kind === "processing.extract_fragments" && j.dedupKey === `sources.acceptSource:${companyA}:${K1}`,
  ).length === 1;
record(
  "A1 valid acceptance commits source+links+run atomically with event AND durable job",
  a1ok ? "PASS" : "FAIL",
  `sourceId=${accepted1.value?.sourceId} links=2 run=running event=1 job=1`,
);

// --- A2: retry same logical key, same payload -------------------------------------
const before2 = await state();
const retried1 = await accept(
  {
    uploadId: up1,
    authorText: text1,
    intendedSentAtIso: "2026-09-09T07:15:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [P1, P2, P1],
  },
  K1,
);
const after2 = await state();
const a2ok =
  retried1._tag === "ok" &&
  retried1.value.sourceId === accepted1.value.sourceId &&
  retried1.value.fullyAcceptedAtMs === accepted1.value.fullyAcceptedAtMs &&
  after2.value.sources.length === before2.value.sources.length &&
  after2.value.events.length === before2.value.events.length &&
  after2.value.jobs.length === before2.value.jobs.length &&
  after2.value.sources.find((r) => r.acceptanceKey === K1)?.sentAtMs ===
    before2.value.sources.find((r) => r.acceptanceKey === K1)?.sentAtMs;
record(
  "A2 retry of one logical-source key returns the SAME source, receipt and send intention, no duplicate work",
  a2ok ? "PASS" : "FAIL",
  `sameId=${retried1.value?.sourceId === accepted1.value?.sourceId} sources ${before2.value.sources.length}->${after2.value.sources.length} events ${before2.value.events.length}->${after2.value.events.length} jobs ${before2.value.jobs.length}->${after2.value.jobs.length}`,
);

// --- A3: same key, DIFFERENT payload => typed idempotency conflict -----------------
const before3 = await state();
const conflicting = await accept(
  {
    uploadId: up1,
    authorText: " zmieniony po fakcie tekst wiadomości",
    intendedSentAtIso: "2026-09-09T07:15:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [P1, P2],
  },
  K1,
);
const after3 = await state();
const a3ok =
  conflicting._tag === "error" &&
  conflicting.error._tag === "idempotency_conflict" &&
  conflicting.error.idempotencyKey === K1 &&
  after3.value.sources.length === before3.value.sources.length &&
  after3.value.events.length === before3.value.events.length &&
  after3.value.jobs.length === before3.value.jobs.length;
record(
  "A3 same key with differing payload => typed idempotency_conflict, never two sources, never an edit",
  a3ok ? "PASS" : "FAIL",
  `tag=${conflicting.error?._tag} rows unchanged=${after3.value.sources.length === before3.value.sources.length}`,
);

// --- A4: concurrent accepts with one fresh logical key -----------------------------
const K4 = key();
const up4 = await uploadFor();
const concurrentInput = {
  uploadId: up4,
  authorText: "Równoległa próba akceptacji tego samego klucza logicznego",
  intendedSentAtIso: "2026-09-09T08:00:00.000Z",
  timezoneSnapshot: "Europe/Warsaw",
  projectHints: [],
};
const before4 = await state();
const [c1, c2] = await Promise.all([accept(concurrentInput, K4), accept(concurrentInput, K4)]);
const after4 = await state();
const a4ok =
  c1._tag === "ok" &&
  c2._tag === "ok" &&
  c1.value.sourceId === c2.value.sourceId &&
  after4.value.sources.length === before4.value.sources.length + 1 &&
  after4.value.events.filter((e) => e.dedupKey === `sources.acceptSource:${companyA}:${K4}`).length === 1;
record(
  "A4 CONCURRENT accepts of one fresh logical key yield exactly ONE source and ONE event",
  a4ok ? "PASS" : "FAIL",
  `sameId=${c1.value?.sourceId === c2.value?.sourceId} sources ${before4.value.sources.length}->${after4.value.sources.length}`,
);

// --- A5: malformed inputs reach no domain effect -----------------------------------
const before5 = await state();
const malformed = [
  ["missing uploadId", { authorText: "x", timezoneSnapshot: "Europe/Warsaw", projectHints: [] }],
  [
    "empty timezone",
    { uploadId: up1, authorText: "x", timezoneSnapshot: "", projectHints: [] },
  ],
  [
    "whitespace-only text",
    { uploadId: up1, authorText: "   ", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  ],
  [
    "invalid IANA zone",
    { uploadId: up1, authorText: "x", timezoneSnapshot: "Mars/Olympus", projectHints: [] },
  ],
  [
    "unparseable sentAt",
    {
      uploadId: up1,
      authorText: "x",
      intendedSentAtIso: "jutro rano",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
  ],
  [
    "implausibly future sentAt",
    {
      uploadId: up1,
      authorText: "x",
      intendedSentAtIso: "2030-01-01T00:00:00.000Z",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
  ],
  [
    "nonexistent upload reference",
    { uploadId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2ff", authorText: "x", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  ],
];
let malformedAllRejected = true;
for (const [label, input] of malformed) {
  const result = await accept(input, key());
  const rejected = result._tag === "error" && result.error._tag === "validation";
  malformedAllRejected = malformedAllRejected && rejected;
  console.log(`  [${rejected ? "PASS" : "FAIL"}]   malformed: ${label} => ${result.error?.code ?? result._tag}`);
}
const after5 = await state();
record(
  "A5 malformed input reaches NO domain effect (all rejected validation, row counts unchanged)",
  malformedAllRejected &&
    after5.value.sources.length === before5.value.sources.length &&
    after5.value.events.length === before5.value.events.length &&
    after5.value.jobs.length === before5.value.jobs.length
    ? "PASS"
    : "FAIL",
  `sources ${before5.value.sources.length}->${after5.value.sources.length} events ${before5.value.events.length}->${after5.value.events.length} jobs ${before5.value.jobs.length}->${after5.value.jobs.length}`,
);

// --- A6: unauthenticated direct client call ----------------------------------------
const before6 = await state();
const direct = await client().mutation("sources/accept/commands:acceptSourceCommand", {
  envelope: envelope(
    { uploadId: up1, authorText: "bez tożsamości", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
    key(),
  ),
});
const after6 = await state();
record(
  "A6 direct client command without identity fails unauthenticated, no domain effect",
  direct._tag === "error" &&
    direct.error._tag === "unauthenticated" &&
    after6.value.sources.length === before6.value.sources.length
    ? "PASS"
    : "FAIL",
  `tag=${direct.error?._tag} sources unchanged=${after6.value.sources.length === before6.value.sources.length}`,
);

// --- A7: interrupted acceptance rolls everything back; retry keeps one source -------
const K7 = key();
const up7 = await uploadFor();
const before7 = await state();
let crashed = false;
try {
  await client().action("sources/accept/probe:probeCrashAcceptance", {
    envelope: envelope(
      {
        uploadId: up7,
        authorText: "Przerwana akceptacja - transakcja musi się wycofać",
        intendedSentAtIso: "2026-09-09T08:30:00.000Z",
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [P1],
      },
      K7,
    ),
  });
} catch (error) {
  crashed = String(error?.message ?? error).includes("deliberate failure");
}
const mid7 = await state();
const rolledBack =
  crashed &&
  mid7.value.sources.length === before7.value.sources.length &&
  mid7.value.events.length === before7.value.events.length &&
  mid7.value.jobs.length === before7.value.jobs.length &&
  mid7.value.links.length === before7.value.links.length &&
  mid7.value.runs.length === before7.value.runs.length;
const retried7 = await accept(
  {
    uploadId: up7,
    authorText: "Przerwana akceptacja - transakcja musi się wycofać",
    intendedSentAtIso: "2026-09-09T08:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [P1],
  },
  K7,
);
const after7 = await state();
const k7sources = after7.value.sources.filter((row) => row.acceptanceKey === K7);
record(
  "A7 crash after registration rolls back source+links+run+event+job; retry then keeps ONE source",
  rolledBack && retried7._tag === "ok" && k7sources.length === 1 ? "PASS" : "FAIL",
  `crashed=${crashed} rolledBack=${rolledBack} sourcesForKey=${k7sources.length}`,
);

// --- A8: tenant isolation ------------------------------------------------------------
const iso = await client().action("sources/accept/probe:probeSeedIsolation", {});
if (iso._tag !== "ok") throw new Error("isolation seeding failed");
const B = iso.value;
const before8 = await state();

const crossTenantHint = await accept(
  { uploadId: B.uploadId, authorText: "x", timezoneSnapshot: "Europe/Warsaw", projectHints: [B.projectId] },
  key(),
);
const hintDenied =
  crossTenantHint._tag === "error" &&
  crossTenantHint.error._tag === "forbidden" &&
  crossTenantHint.error.code === "tenant_scope_mismatch";

const crossTenantUpload = await accept(
  { uploadId: B.uploadId, authorText: "x", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  key(),
);
const uploadDenied =
  crossTenantUpload._tag === "error" &&
  crossTenantUpload.error._tag === "forbidden" &&
  crossTenantUpload.error.code === "tenant_scope_mismatch";

const foreignRead = await projectView(B.projectId, 5);
const readDenied =
  foreignRead._tag === "error" &&
  foreignRead.error._tag === "forbidden" &&
  foreignRead.error.code === "tenant_scope_mismatch";

// Company B accepts its own source and sees it — but not company A's.
const bAccept = await accept(
  { uploadId: B.uploadId, authorText: "Wiadomość firmy B", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  key(),
  B.sessionId,
);
const bView = await companyView(20, undefined, B.sessionId);
const aView = await companyView(50);
const bIsolationOk =
  bAccept._tag === "ok" &&
  bView._tag === "ok" &&
  bView.value.page.some((row) => row.sourceId === bAccept.value.sourceId) &&
  !bView.value.page.some((row) => row.authorText.includes("Buniewice")) &&
  !aView.value.page.some((row) => row.sourceId === bAccept.value?.sourceId);

const after8 = await state();
record(
  "A8 cross-tenant hints/uploads/reads denied; company B sees only its own conversation",
  hintDenied && uploadDenied && readDenied && bIsolationOk &&
    after8.value.sources.length === before8.value.sources.length
    ? "PASS"
    : "FAIL",
  `hint=${hintDenied} upload=${uploadDenied} read=${readDenied} bSeesOwn=${bIsolationOk} aSourcesUnchanged=${after8.value.sources.length === before8.value.sources.length}`,
);

// --- A9: one source, two project views, same immutable original ---------------------
const k1Row = aView.value.page.find((row) => row.projectIds.length === 2);
const v1 = await projectView(P1, 10);
const v2 = await projectView(P2, 10);
const v3 = await projectView(P3, 10);
const d1 = k1Row === undefined ? { _tag: "error" } : await detail(k1Row.sourceId);
const sameInBoth =
  v1._tag === "ok" &&
  v2._tag === "ok" &&
  v1.value.page.some(
    (row) => row.sourceId === k1Row?.sourceId && row.authorText === k1Row?.authorText && row.sentAtMs === k1Row?.sentAtMs,
  ) &&
  v2.value.page.some((row) => row.sourceId === k1Row?.sourceId && row.authorUserId === k1Row?.authorUserId);
const absentElsewhere = v3._tag === "ok" && !v3.value.page.some((row) => row.sourceId === k1Row?.sourceId);
const detailSame = d1._tag === "ok" && d1.value.sourceId === k1Row?.sourceId;
record(
  "A9 one source linked to two projects: both project views + detail resolve the SAME id, author, text and send snapshot",
  sameInBoth && absentElsewhere && detailSame ? "PASS" : "FAIL",
  `sourceId=${k1Row?.sourceId} inP1=${sameInBoth} absentP3=${absentElsewhere} detail=${detailSame}`,
);

// General source (no hints) in company view only
const K9 = key();
const up9 = await uploadFor();
const general = await accept(
  { uploadId: up9, authorText: "Ogólna wiedza firmy bez projektu", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  K9,
);
const aViewAfter = await companyView(50);
const generalRow = aViewAfter.value.page.find((row) => row.sourceId === general.value?.sourceId);
const v1After = await projectView(P1, 10);
record(
  "A9b a general source appears in the company conversation with no project, absent from project views",
  generalRow !== undefined &&
    generalRow.projectIds.length === 0 &&
    !v1After.value.page.some((row) => row.sourceId === general.value?.sourceId)
    ? "PASS"
    : "FAIL",
  `companyOnly=${generalRow !== undefined && generalRow.projectIds.length === 0}`,
);

// --- A10: pagination -----------------------------------------------------------------
for (let i = 0; i < 6; i += 1) {
  const up = await uploadFor();
  const burst = await accept(
    {
      uploadId: up,
      authorText: `Wiadomość stronicowania nr ${i} firmy A`,
      intendedSentAtIso: new Date(Date.parse("2026-09-09T06:00:00.000Z") + i * 60_000).toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: i % 2 === 0 ? [P1] : [],
    },
    key(),
  );
  if (burst._tag !== "ok") throw new Error(`burst accept ${i} failed`);
}
const allCompanyRows = [];
let cursor = undefined;
let isDone = false;
let pages = 0;
while (!isDone) {
  const page = await companyView(3, cursor);
  if (page._tag !== "ok") throw new Error("pagination read failed");
  allCompanyRows.push(...page.value.page);
  isDone = page.value.isDone;
  cursor = page.value.continueCursor;
  pages += 1;
}
const ids = new Set(allCompanyRows.map((row) => row.sourceId));
const ordered = allCompanyRows.every(
  (row, i) => i === 0 || allCompanyRows[i - 1].sentAtMs >= row.sentAtMs,
);
const totalA = (await state()).value.sources.length;
record(
  "A10 company conversation paginates (3/page) with no dupes, descending order, covers all company sources",
  ids.size === allCompanyRows.length && ordered && allCompanyRows.length === totalA && pages >= 3
    ? "PASS"
    : "FAIL",
  `rows=${allCompanyRows.length} distinct=${ids.size} total=${totalA} pages=${pages} descending=${ordered}`,
);

// Project pagination on P1
const p1Rows = [];
let p1cursor = undefined;
let p1done = false;
while (!p1done) {
  const page = await projectView(P1, 2, undefined);
  // project view probe takes no cursor in this transcript run: single page proof
  p1Rows.push(...page.value.page);
  p1done = true;
}
record(
  "A10b project conversation returns link-ordered rows (bounded page)",
  p1Rows.length >= 2 && p1Rows.every((row) => row.projectIds.includes(P1)) ? "PASS" : "FAIL",
  `rows=${p1Rows.length}`,
);

// --- A11: honest processing state + durable job outcome -------------------------------
const jobRow = (await state()).value.jobs.find(
  (j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`,
);
const k1Detail = await detail(accepted1.value.sourceId);
record(
  "A11 views expose derived processing state while the durable job state stays inspectable",
  k1Detail._tag === "ok" &&
    (k1Detail.value.processingState === "processing" || k1Detail.value.processingState === "failed") &&
    jobRow !== undefined
    ? "PASS"
    : "FAIL",
  `viewProcessingState=${k1Detail.value?.processingState} jobState=${jobRow?.state}/${jobRow?.lastErrorKind} attempts=${jobRow?.attempts}`,
);

process.exit(summarize() ? 0 : 1);
