/**
 * E5 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/e5, instance beaming-frog-280, EU).
 *
 * ONE batched pass (the owner's Convex quota guardrail): every scenario runs
 * in this single script execution, sequentially, with explicit bounded waits.
 *
 * Output is sanitized: no tokens, no keys, no service credentials, no
 * prepared index texts beyond the fixture markers below. The embedding legs
 * spend real OpenRouter credit through E2's pinned route (single-digit
 * requests, the E2 authorized-dev-spend precedent).
 *
 * Proves (issue #39 focused verification):
 *  1. identical text in two tenants: every query path (text, semantic,
 *     filters, pagination) returns only the caller's company;
 *  2. withdraw + revise + query stale rows: hydration filters, the drain's
 *     refresh edges physically rebuild/drop, obsolete revisions never
 *     authorize;
 *  3. wrong-dimension embeddings through the real write mutation fail the
 *     index write (nothing commits);
 *  4. interrupted cutover and embedding outage: full-text/typed reads remain
 *     available with disclosed coverage (text_only/degraded), never a silent
 *     semantic claim;
 *  5. two generations coexist for a verified cutover; incompatible
 *     candidates never start.
 *
 * Run: node tests/e5/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_E5_DEPLOYMENT ?? "beaming-frog-280";
const URL_API = `https://${DEPLOYMENT}.convex.cloud`;
const RUN = process.env.KIERO_E5_PROOF_RUN ?? Date.now().toString(36);

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function anon() {
  return new ConvexHttpClient(URL_API, { logger: false });
}

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? `${result.error._tag}:${result.error.code}` : "ok";
const value = (result) => result?.value;

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });

// --- fixture texts (Polish product prose; distinctive per tenant) ------------
// Every fixture carries the RUN token so reruns never collide with rows from
// an earlier aborted pass on the same lease.

const SHARED_MARKER =
  `Betonową wylewkę na suficie poddasza umówiliśmy na 12 października (${RUN})`;
const A_ONLY_MARKER =
  `Dachówkę na budowie Kaczmarka dostarczy hurtownia Baumat (${RUN})`;
const B_ONLY_MARKER = `Płytki gres dostarczy salon Nizioł (${RUN})`;
const TRANSCRIPT_SEG1 = `Ekipa hydrauliczna zaczyna instalację w poniedziałek (${RUN})`;
const TRANSCRIPT_SEG2 = `Kontrola jakości dachu zaplanowana na piątek (${RUN})`;
const FINDING_KEY = `termin_dostawy_dachowki_${RUN}`;
const FINDING_TEXT_V1 = `Dachówka zostanie dostarczona 20 października (${RUN})`;
const FINDING_TEXT_V2 = `Dachówka zostanie dostarczona 27 października (${RUN})`;

// --- service drives ------------------------------------------------------------

const probeSeed = () => anon().action("platform/probe:probeSeed", {});
const probeServiceScope = () => anon().action("search/probe:probeServiceScope", {});
const seedIsolation = () => anon().action("search/probe:probeSeedIsolation", {});
const seedProject = (displayName) =>
  anon().action("sources/accept/probe:probeSeedProject", { displayName });
const seedUpload = () => anon().action("sources/accept/probe:probeSeedUpload", {});
const accept = (envelopeInput, sessionId) =>
  anon().action("sources/accept/probe:probeAcceptSource", {
    envelope: envelopeInput,
    sessionId,
  });
const seedTranscript = (sourceId, firstText, secondText) =>
  anon().action("search/probe:probeSeedTranscript", { sourceId, firstText, secondText });
const memory = (operation, input, sessionId) =>
  anon().action("memory/findings/probe:probeMemoryCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
// The REAL withdrawal operation through the checked sources dispatch: the
// lifecycle transition, the canonical sources.sourceWithdrawn event and the
// durable recompute registration commit atomically there (C5/D1), and the
// drain fans the event out to this lane's refresh edge.
const withdraw = (sourceId, reason, sessionId) =>
  anon().action("sources/accept/probe:probeAcceptSource", {
    envelope: envelope("sources.withdrawSource", { sourceId, reason }),
    sessionId,
  });
const searchCommand = (operation, input, sessionId) =>
  anon().action("search/probe:probeSearchCommand", {
    envelope: envelope(operation, input),
    sessionId,
  });
const queryEvidence = (input, sessionId, simulateEmbeddingOutage = false) =>
  anon().action("search/probe:probeQueryEvidence", {
    envelope: envelope("search.queryEvidence", input),
    sessionId,
    ...(simulateEmbeddingOutage ? { simulateEmbeddingOutage: true } : {}),
  });
const searchState = () => anon().action("search/probe:probeSearchState", {});
const injectEmbedding = (args) => anon().action("search/probe:probeInjectEmbedding", args);
const drainNow = () => anon().action("platform/probe:probeDrainNow", {});
const companyConversation = (sessionId, numItems) =>
  anon().action("sources/read/probe:probeCompanyConversation", { sessionId, numItems });

/** Bounded wait for a search job's terminal state (2s interval, no tight loop). */
async function wait_for(label, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await searchState();
    if (predicate(last)) {
      return last;
    }
    await sleep(2_000);
  }
  return last;
}

const jobByDedup = (state, dedupKey) =>
  (state?.jobs ?? []).find((job) => job.dedupKey === dedupKey) ?? null;

console.log(`# E5 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("run", RUN);
row("embedding route", "E2 pinned qwen/qwen3-embedding-8b @ 4096 (server-held key; name only)");

// --- setup: company A (service fixture) + company B (isolation fixture) -------

const seeded = await probeSeed();
if (!isOk(seeded)) throw new Error(`probeSeed failed: ${errCode(seeded)}`);
const serviceScope = await probeServiceScope();
if (!isOk(serviceScope)) throw new Error(`probeServiceScope failed: ${errCode(serviceScope)}`);
const companyA = value(serviceScope).companyId;
const serviceUser = value(serviceScope).userId;
const serviceSession = (await anon().query("platform/probe:serviceSession", {})).sessionId;

const iso = await seedIsolation();
if (!isOk(iso)) throw new Error(`probeSeedIsolation failed: ${errCode(iso)}`);
const companyB = value(iso).companyId;
const bUser = value(iso).userId;
const bSession = value(iso).sessionId;
row("company A (service)", companyA);
row("company B (isolation)", companyB);

const project = await seedProject(`Budowa E5 ${RUN}`);
if (!isOk(project)) throw new Error(`project seeding failed: ${errCode(project)}`);
const projectId = value(project).projectId;

const acceptSource = async (uploadId, text, hints, sessionId) => {
  const result = await accept(
    envelope("sources.acceptSource", {
      uploadId,
      authorText: text,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: hints,
    }),
    sessionId,
  );
  if (!isOk(result)) throw new Error(`acceptSource failed: ${errCode(result)}`);
  return value(result).sourceId;
};

const uploadA1 = value(await seedUpload()).uploadId;
const sa1 = await acceptSource(uploadA1, SHARED_MARKER, [projectId], serviceSession);
const uploadA2 = value(await seedUpload()).uploadId;
const sentA2At = Date.now();
const sa2 = await acceptSource(uploadA2, A_ONLY_MARKER, [], serviceSession);
const sb1 = await acceptSource(value(iso).uploadId, SHARED_MARKER, [], bSession);
row("source A shared", sa1);
row("source A only", sa2);
row("source B shared", sb1);

const transcript = await seedTranscript(sa1, TRANSCRIPT_SEG1, TRANSCRIPT_SEG2);
if (!isOk(transcript)) throw new Error(`transcript seeding failed: ${errCode(transcript)}`);
row("transcript fixture", value(transcript).transcriptId);

/** Publishes one finding through C2's REAL dispatch and returns its id. */
async function publishFinding(findingId, text) {
  const prepared = await memory(
    "memory.prepareChangeSet",
    {
      sourceId: sa1,
      plannedRevisions: [
        {
          findingId,
          scope: { _tag: "company" },
          semanticKey: FINDING_KEY,
          value: { _tag: "text_note", text },
          knowledgeState: { _tag: "known" },
          effectiveFrom: null,
          evidence: [{ sourceId: sa1, fragmentId: null, supportKind: "support" }],
          derivesFrom: [],
        },
      ],
    },
    serviceSession,
  );
  if (!isOk(prepared)) throw new Error(`prepareChangeSet failed: ${errCode(prepared)}`);
  const published = await memory(
    "memory.publishChangeSet",
    { changeSetId: value(prepared).changeSetId, expectedRevisions: [] },
    serviceSession,
  );
  if (!isOk(published)) throw new Error(`publishChangeSet failed: ${errCode(published)}`);
  return value(prepared);
}

const f1Prepared = await publishFinding(null, FINDING_TEXT_V1);
row("finding published", `${f1Prepared.changeSetId}`);

// --- S0: lane-state reset (the rebuildability first step; derived data only) ---

{
  const reset = await anon().action("search/probe:probeResetLaneState", {});
  if (!isOk(reset)) throw new Error(`lane reset failed: ${errCode(reset)}`);
  row("lane reset (entries, generations, jobs)", JSON.stringify(value(reset)));
}

// --- S1: no active generation: degraded coverage, typed reads remain ----------

{
  const noIndex = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S1a degraded coverage disclosed before any generation",
    isOk(noIndex) && value(noIndex).coverage === "degraded" && value(noIndex).entries.length === 0,
    `coverage=${value(noIndex)?.coverage}`,
  );
  const typedRead = await companyConversation(serviceSession, 5);
  check(
    "S1b typed/current structured read still available (D1 conversation view)",
    isOk(typedRead) && Array.isArray(value(typedRead)?.page),
    `page=${value(typedRead)?.page?.length ?? "?"}`,
  );
}

// --- S2: incompatible candidates never start ----------------------------------

{
  const wrongDims = await searchCommand(
    "search.startIndexGeneration",
    { embeddingModel: "qwen/qwen3-embedding-8b", textPreparationVersion: "e5.fold.v1", dimensions: 2048 },
    serviceSession,
  );
  check(
    "S2a wrong dimensions refused (conflict)",
    wrongDims?._tag === "error" && errCode(wrongDims) === "conflict:dimensions_not_supported",
    errCode(wrongDims),
  );
  const wrongModel = await searchCommand(
    "search.startIndexGeneration",
    { embeddingModel: "other/model", textPreparationVersion: "e5.fold.v1", dimensions: 4096 },
    serviceSession,
  );
  check(
    "S2b unproved model refused (conflict)",
    wrongModel?._tag === "error" && errCode(wrongModel) === "conflict:model_not_supported",
    errCode(wrongModel),
  );
}

// --- S3: interrupted cutover stays refused while the build runs ----------------

const gen1Start = await searchCommand(
  "search.startIndexGeneration",
  { embeddingModel: "qwen/qwen3-embedding-8b", textPreparationVersion: "e5.fold.v1", dimensions: 4096 },
  serviceSession,
);
if (!isOk(gen1Start)) throw new Error(`gen1 start failed: ${errCode(gen1Start)}`);
const gen1 = value(gen1Start).generationId;
const buildKey1 = `search.index_generation:build:${gen1}`;
row("generation 1", gen1);

{
  const premature = await searchCommand("search.cutOverIndexGeneration", { generationId: gen1 }, serviceSession);
  check(
    "S3a cutover refused before the verified build (interrupted cutover)",
    premature?._tag === "error" && errCode(premature) === "conflict:build_not_verified",
    errCode(premature),
  );
  const concurrent = await searchCommand(
    "search.startIndexGeneration",
    { embeddingModel: "qwen/qwen3-embedding-8b", textPreparationVersion: "e5.fold.v1", dimensions: 4096 },
    serviceSession,
  );
  check(
    "S3b one build at a time (second start conflicts)",
    concurrent?._tag === "error" && errCode(concurrent) === "conflict:generation_already_building",
    errCode(concurrent),
  );
}

// --- S4: the build succeeds (real embeddings through E2's route) --------------

let stateAfterBuild = await wait_for(
  "gen1 build",
  (state) => jobByDedup(state, buildKey1)?.state === "succeeded",
);
{
  const job = jobByDedup(stateAfterBuild, buildKey1);
  check("S4a gen1 build job succeeded", job?.state === "succeeded", `state=${job?.state} err=${job?.lastErrorKind ?? "-"}`);
  const countsA = (stateAfterBuild?.entriesByCompany ?? []).find((c) => c.companyId === companyA);
  const countsB = (stateAfterBuild?.entriesByCompany ?? []).find((c) => c.companyId === companyB);
  row("gen1 entries A", JSON.stringify(countsA ?? { total: 0, embedded: 0 }));
  row("gen1 entries B", JSON.stringify(countsB ?? { total: 0, embedded: 0 }));
  check(
    "S4b every index row embedded (real route, full coverage)",
    countsA?.embedded === countsA?.total && countsA?.total > 0 && countsB?.embedded === countsB?.total,
    `A ${countsA?.embedded}/${countsA?.total} B ${countsB?.embedded}/${countsB?.total}`,
  );
}

// --- S5: verified cutover -------------------------------------------------------

{
  const cut = await searchCommand("search.cutOverIndexGeneration", { generationId: gen1 }, serviceSession);
  check("S5a gen1 cutover after verification", isOk(cut), errCode(cut));
  const state = await searchState();
  const active = (state?.generations ?? []).filter((g) => g.state === "active");
  check("S5b exactly one active generation", active.length === 1 && active[0].generationId === gen1);
}

// --- S6: tenant isolation over every query path ---------------------------------

const allSourceIdsIn = (result, allowed) =>
  value(result).entries.every(
    (entry) => entry.sourceId === undefined || allowed.includes(entry.sourceId),
  );

/** Every source id of one company, from the D1 conversation view (typed read). */
async function companySourceIds(sessionId) {
  const page = await companyConversation(sessionId, 100);
  const rows = value(page)?.page ?? [];
  return rows.map((rowOf) => rowOf.sourceId);
}

/** No result row links any of the banned record ids. */
const linksNoneOf = (result, banned) =>
  value(result).entries.every((entry) => !banned.includes(entry.sourceId));

{
  const aSources = await companySourceIds(serviceSession);
  const bSources = await companySourceIds(bSession);
  row("A sources (typed read)", aSources.length);
  row("B sources (typed read)", bSources.length);
  const fromA = await queryEvidence({ query: `wylewka na suficie (${RUN})`, limit: 10 }, serviceSession);
  const fromB = await queryEvidence({ query: `wylewka na suficie (${RUN})`, limit: 10 }, bSession);
  check(
    "S6a identical text in both tenants: A sees only A-company rows",
    isOk(fromA) && value(fromA).entries.length > 0 && allSourceIdsIn(fromA, aSources),
    `n=${value(fromA)?.entries?.length}`,
  );
  check(
    "S6b identical text in both tenants: B sees only B-company rows",
    isOk(fromB) && value(fromB).entries.length > 0 && allSourceIdsIn(fromB, bSources),
    `n=${value(fromB)?.entries?.length}`,
  );
  const aLeak = await queryEvidence({ query: `dachówka hurtownia Baumat (${RUN})`, limit: 10 }, bSession);
  const bLeak = await queryEvidence({ query: `płytki gres Nizioł (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S6c A-only text invisible from B (no A row crosses)",
    isOk(aLeak) && allSourceIdsIn(aLeak, bSources) && linksNoneOf(aLeak, [sa1, sa2]),
    `n=${value(aLeak)?.entries?.length}`,
  );
  check(
    "S6d B-only text invisible from A (no B row crosses)",
    isOk(bLeak) && allSourceIdsIn(bLeak, aSources) && linksNoneOf(bLeak, [sb1]),
    `n=${value(bLeak)?.entries?.length}`,
  );
  const coverage = value(fromA)?.coverage;
  check("S6e full coverage on the embedded active generation", coverage === "full", `coverage=${coverage}`);
}

// --- S7: filters and pagination --------------------------------------------------

{
  const byProject = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10, projectId }, serviceSession);
  check(
    "S7a project filter keeps the linked source only",
    isOk(byProject) && value(byProject).entries.length > 0 &&
      value(byProject).entries.every((entry) => entry.sourceId === sa1),
    `n=${value(byProject)?.entries?.length}`,
  );
  const byAuthor = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10, authorUserId: bUser }, serviceSession);
  check(
    "S7b author filter excludes the other tenant's author (zero here)",
    isOk(byAuthor) && value(byAuthor).entries.length === 0,
    `n=${value(byAuthor)?.entries?.length}`,
  );
  const byAuthorA = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10, authorUserId: serviceUser }, serviceSession);
  check(
    "S7c own author filter keeps the rows",
    isOk(byAuthorA) && value(byAuthorA).entries.length > 0,
    `n=${value(byAuthorA)?.entries?.length}`,
  );
  const inWindow = await queryEvidence(
    { query: `dachówka hurtownia (${RUN})`, limit: 10, sentFromMs: sentA2At - 60_000, sentToMs: sentA2At + 60_000 },
    serviceSession,
  );
  const outWindow = await queryEvidence(
    { query: `dachówka hurtownia (${RUN})`, limit: 10, sentFromMs: sentA2At - 10 * 60_000, sentToMs: sentA2At - 5 * 60_000 },
    serviceSession,
  );
  check("S7d date window filter keeps the row", isOk(inWindow) && value(inWindow).entries.length > 0);
  check("S7e outside the date window: nothing", isOk(outWindow) && value(outWindow).entries.length === 0);

  // Pagination: walk "na" (broad) with limit 1 until done; no duplicates.
  const seen = [];
  let cursor = undefined;
  let pages = 0;
  for (let guard = 0; guard < 12; guard += 1) {
    const page = await queryEvidence(
      { query: `wylewka na (${RUN})`, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
      serviceSession,
    );
    if (!isOk(page)) break;
    for (const entry of value(page).entries) seen.push(entry.searchEntryId);
    pages += 1;
    if (value(page).isDone || value(page).entries.length === 0) break;
    cursor = value(page).entries[value(page).entries.length - 1].searchEntryId;
  }
  check(
    "S7f cursor pagination walks distinct pages without duplicates",
    pages > 1 && new Set(seen).size === seen.length,
    `pages=${pages} rows=${seen.length}`,
  );
}

// --- S8: semantic path and transcript coverage -----------------------------------

{
  const semantic = await queryEvidence(
    { query: `kiedy zostanie dostarczony materiał do pokrycia dachu (${RUN})`, limit: 10 },
    serviceSession,
  );
  check(
    "S8a semantic query returns hydrated rows with full coverage",
    isOk(semantic) && value(semantic).entries.length > 0 && value(semantic).coverage === "full",
    `n=${value(semantic)?.entries?.length} via=${value(semantic)?.entries?.map((e) => e.matchedVia).join(",")}`,
  );
  const transcriptQuery = await queryEvidence({ query: `instalacja poniedziałek (${RUN})`, limit: 10 }, serviceSession);
  const transcriptFromB = await queryEvidence({ query: `instalacja poniedziałek (${RUN})`, limit: 10 }, bSession);
  const aSources = await companySourceIds(serviceSession);
  check(
    "S8b transcript text searchable and linked to its fragment (A only)",
    isOk(transcriptQuery) &&
      value(transcriptQuery).entries.some(
        (entry) => entry.sourceId === sa1 && entry.sourceFragmentId !== undefined,
      ) &&
      allSourceIdsIn(transcriptQuery, aSources) &&
      isOk(transcriptFromB) &&
      linksNoneOf(transcriptFromB, [sa1]),
    `A n=${value(transcriptQuery)?.entries?.length} B n=${value(transcriptFromB)?.entries?.length}`,
  );
  const findingQuery = await queryEvidence({ query: `termin dostawy dachowki (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S8c finding revision indexed and hydratable",
    isOk(findingQuery) && value(findingQuery).entries.some((entry) => entry.kind === "finding"),
    `n=${value(findingQuery)?.entries?.length}`,
  );
}

// --- S9: withdrawal: hydration filters; the drain refresh physically drops -------

{
  const before = await searchState();
  const countsABefore = (before?.entriesByCompany ?? []).find((c) => c.companyId === companyA)?.total ?? 0;
  const withdrawn = await withdraw(sa2, "myląca informacja o dostawie", serviceSession);
  check("S9a withdrawal executed through the real C5/D1 path", isOk(withdrawn), errCode(withdrawn));
  const immediate = await queryEvidence({ query: `dachówka hurtownia Baumat (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S9b withdrawn evidence authorizes nothing immediately (hydration filters stale rows)",
    isOk(immediate) && linksNoneOf(immediate, [sa2]),
    `n=${value(immediate)?.entries?.length} linksSa2=${value(immediate)?.entries?.filter((e) => e.sourceId === sa2).length ?? "?"}`,
  );
  const afterWithdrawState = await searchState();
  const staleStillPresent =
    (afterWithdrawState?.entriesByCompany ?? []).find((c) => c.companyId === companyA)?.total === countsABefore;
  row("stale row state at immediate query", staleStillPresent ? "rows-present-hydration-filtered" : "already-refreshed");
  await drainNow();
  const refreshed = await wait_for("refresh_source", (state) => {
    const job = (state?.jobs ?? []).find(
      (candidate) => candidate.dedupKey === `search.index_generation:refresh_source:${sa2}`,
    );
    return job !== undefined && (job.state === "succeeded" || job.state === "failed");
  });
  const refreshJob = (refreshed?.jobs ?? []).find(
    (candidate) => candidate.dedupKey === `search.index_generation:refresh_source:${sa2}`,
  );
  check("S9c drain refresh_source job terminal", refreshJob?.state === "succeeded", `state=${refreshJob?.state} err=${refreshJob?.lastErrorKind ?? "-"}`);
  const countsAAfter = (refreshed?.entriesByCompany ?? []).find((c) => c.companyId === companyA)?.total ?? 0;
  check("S9d derived rows physically dropped", countsAAfter < countsABefore, `${countsAAfter} < ${countsABefore}`);
  const afterRefresh = await queryEvidence({ query: `dachówka hurtownia Baumat (${RUN})`, limit: 10 }, serviceSession);
  check("S9e withdrawn rows gone after the refresh too", isOk(afterRefresh) && linksNoneOf(afterRefresh, [sa2]));
}

// --- S10: revised finding: obsolete revision never authorizes ---------------------

{
  const currentRows = value(
    await memory("memory.readCurrentFindings", { scope: { _tag: "company" } }, serviceSession),
  )?.rows;
  const f1 = currentRows?.find((candidate) => candidate.semanticKey === FINDING_KEY)?.findingId ?? null;
  row("finding id", f1 ?? "missing");
  const corrected = await publishFinding(f1, FINDING_TEXT_V2);
  row("finding corrected", `${corrected.changeSetId}`);
  const noTextLinkToOld = (result) =>
    value(result).entries.every(
      (entry) =>
        !(
          entry.findingId === f1 &&
          (entry.matchedVia === "text" || entry.matchedVia === "text_and_semantic")
        ),
    );
  const oldText = await queryEvidence({ query: `dostarczona 20 pazdziernika (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S10a obsolete revision authorizes nothing immediately (hydration)",
    isOk(oldText) && noTextLinkToOld(oldText),
    `n=${value(oldText)?.entries?.length}`,
  );
  await drainNow();
  const refreshed = await wait_for("refresh_finding", (state) => {
    const job = (state?.jobs ?? []).find((candidate) =>
      candidate.dedupKey?.startsWith("search.index_generation:refresh_finding:"),
    );
    return job !== undefined && (job.state === "succeeded" || job.state === "failed");
  });
  const newText = await queryEvidence({ query: `dostarczona 27 pazdziernika (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S10b the corrected current revision is indexed after the refresh",
    isOk(newText) && value(newText).entries.length > 0,
    `n=${value(newText)?.entries?.length}`,
  );
  const again = await queryEvidence({ query: `dostarczona 20 pazdziernika (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S10c the superseded text stays gone (no text-path link to the old revision)",
    isOk(again) && noTextLinkToOld(again),
    `n=${value(again)?.entries?.length}`,
  );
}

// --- S11: two generations coexist for a verified cutover --------------------------

let gen2 = null;
{
  const gen2Start = await searchCommand(
    "search.startIndexGeneration",
    { embeddingModel: "qwen/qwen3-embedding-8b", textPreparationVersion: "e5.fold.v1", dimensions: 4096 },
    serviceSession,
  );
  check("S11a second generation started", isOk(gen2Start), errCode(gen2Start));
  gen2 = value(gen2Start)?.generationId ?? null;
  const coexist = await searchState();
  const states = (coexist?.generations ?? []).map((g) => `${g.generationId.slice(-6)}:${g.state}`).join(" ");
  check(
    "S11b generations coexist (active + building) during cutover preparation",
    (coexist?.generations ?? []).some((g) => g.state === "active" && g.generationId === gen1) &&
      (coexist?.generations ?? []).some((g) => g.state === "building" && g.generationId === gen2),
    states,
  );
  const serving = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10 }, serviceSession);
  check(
    "S11c queries keep serving the OLD generation until the switch",
    isOk(serving) && value(serving).entries.length > 0,
    `n=${value(serving)?.entries?.length}`,
  );
}
{
  const buildKey2 = `search.index_generation:build:${gen2}`;
  await wait_for("gen2 build", (state) => jobByDedup(state, buildKey2)?.state === "succeeded");
  const cut = await searchCommand("search.cutOverIndexGeneration", { generationId: gen2 }, serviceSession);
  check("S11d gen2 cutover after verification", isOk(cut), errCode(cut));
  const state = await searchState();
  const gen1Row = (state?.generations ?? []).find((g) => g.generationId === gen1);
  check("S11e gen1 retired atomically with gen2 activation", gen1Row?.state === "retired");
  const afterSwitch = await queryEvidence({ query: `wylewka (${RUN})`, limit: 10 }, serviceSession);
  const aSourcesLate = await companySourceIds(serviceSession);
  check(
    "S11f the new generation serves the same company scope",
    isOk(afterSwitch) && value(afterSwitch).entries.length > 0 && allSourceIdsIn(afterSwitch, aSourcesLate),
    `n=${value(afterSwitch)?.entries?.length}`,
  );
}

// --- S12: wrong-dimension embedding fails the index write -------------------------

{
  const injection = await injectEmbedding({ generationId: gen2, companyId: companyA, sourceId: sa1, dimensions: 3 });
  const outcome = value(injection)?.writeOutcome;
  check(
    "S12a wrong-dimension vector refused by the write authority",
    isOk(injection) && outcome?._tag === "error" && outcome?.error?.code === "embedding_dimension_mismatch",
    outcome?._tag === "error" ? outcome.error.code : JSON.stringify(outcome)?.slice(0, 80),
  );
  check(
    "S12b nothing committed (generation entry count unchanged)",
    value(injection)?.entriesAfter?.total === value(injection)?.entriesBefore?.total &&
      value(injection)?.entriesBefore !== undefined,
    `${value(injection)?.entriesAfter?.total} === ${value(injection)?.entriesBefore?.total}`,
  );
}

// --- S13: embedding outage: text retrieval stands, coverage discloses ------------

{
  const outage = await queryEvidence({ query: `wylewka na suficie (${RUN})`, limit: 10 }, serviceSession, true);
  check(
    "S13a simulated outage: full-text retrieval still serves",
    isOk(outage) && value(outage).entries.length > 0,
    `n=${value(outage)?.entries?.length}`,
  );
  check(
    "S13b coverage discloses text_only (the semantic gap is explicit)",
    value(outage)?.coverage === "text_only",
    `coverage=${value(outage)?.coverage}`,
  );
  const typedRead = await companyConversation(serviceSession, 5);
  check("S13c typed/current structured reads unaffected by the outage", isOk(typedRead));
}

// --- final sanitized dump ----------------------------------------------------------

{
  const state = await searchState();
  row("generations", JSON.stringify(state?.generations ?? []));
  row("search jobs", JSON.stringify((state?.jobs ?? []).map((j) => `${j.state}:${j.lastErrorKind ?? "-"}`)));
  row("entries by company", JSON.stringify(state?.entriesByCompany ?? []));
}

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`# E5 live proof summary: ${results.length - failed.length}/${results.length} PASS`);
for (const failure of failed) {
  console.log(`# FAILED: ${failure.id}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
