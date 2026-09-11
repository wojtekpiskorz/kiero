/**
 * H3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/h3, instance hallowed-tortoise-829, EU).
 *
 * ONE batched pass (the Convex quota guardrail): every scenario runs in
 * this single script execution, sequentially, with explicit bounded waits.
 *
 * Identity: every actor is a REAL signed-in person (B1 email-code flow with
 * proof-domain fixture addresses and fixture codes, the D3 evidence
 * pattern). The fixtures the guarded probes seed (transcript segments, OCR
 * observations) resolve P's OWN live session server-side — no
 * development-auth shortcut, no client-supplied identity.
 *
 * Drives the surfaces H3 owns through their PUBLIC paths:
 * - `search/commands:queryEvidence` (the public action, P's token);
 * - `sources/read/views:sourceExposition` and `:sourceEvidence` (the
 *   H3-flagged public queries, P's and Q's tokens);
 * - `sources.withdrawSource` and `memory.correctFinding` through the real
 *   public dispatches;
 * - `/sources/media/access` (the D3 Convex HTTP boundary) with the person's
 *   bearer credential, including the membership-revocation refusal.
 *
 * Scenarios (issue #51 focused verification):
 *  S1  representative Polish text, transcript and OCR evidence found with
 *      filters, opening the authoritative source/revision links;
 *  S2  coverage disclosed verbatim (full on an embedded generation,
 *      text_only when the provider leg is unavailable — never a silent
 *      semantic claim);
 *  S3  filters (project, author, date window) and cursor pagination;
 *  S4  company isolation: the second person's query and source-detail read
 *      refuse everything of P's company;
 *  S5  the dossier: immutable content, retained representations with D5
 *      states, transcript segments with time anchors, OCR observations
 *      with pixel anchors against the pinned representation space;
 *  S6  the paginated evidence chain: cited revision, correction history,
 *      supersession visible;
 *  S7  withdrawal through C5: the withdrawn source authorizes nothing in
 *      search (stale vector filtered by hydration), stays inspectable with
 *      its record (never deletion), and the dependent finding shows the
 *      recomputation marking;
 *  S8  media access resolution: grant for the current representation, the
 *      exact-representation read, and the revocation refusal (fresh
 *      authorization per request).
 *
 * Run: node tests/h3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Output is sanitized: routing metadata, states, ids and Polish fixture
 * texts only — no secrets, no tokens.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_H3_DEPLOYMENT ?? "hallowed-tortoise-829";
const URL_API = `https://${DEPLOYMENT}.convex.cloud`;
const URL_SITE = `https://${DEPLOYMENT}.convex.site`;
const RUN = process.env.KIERO_H3_PROOF_RUN ?? Date.now().toString(36);

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const anon = () => new ConvexHttpClient(URL_API, { logger: false });
const isOk = (r) => r?._tag === "ok";
const errCode = (r) => (r?._tag === "error" ? `${r.error._tag}:${r.error.code}` : "ok");
const value = (r) => r?.value;
const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });

// --- real sign-in (the D3 fixture pattern) -------------------------------------

const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

async function signInFixture(email) {
  const code = fixtureCodeOf(email);
  const bootstrap = anon();
  await bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }).catch(() => {});
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(URL_API, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}`);
  }
  return { client, token, sessionId: ensured.sessionId, email };
}

// --- guarded drives (probe surfaces; P's own seeded session) --------------------

// The fixture seeds are guarded mutations over the source row itself (no
// identity leg): E5's transcript fixture and H3's image-OCR fixture.
const seedTranscript = (sourceId, firstText, secondText) =>
  anon().action("search/probe:probeSeedTranscript", { sourceId, firstText, secondText });
const seedImageOcr = (sourceId, observations) =>
  anon().action("sources/read/probe:probeSeedImageOcr", { sourceId, observations });
const searchCommand = (operation, input, sessionId) =>
  anon().action("search/probe:probeSearchCommand", { envelope: envelope(operation, input), sessionId });
const queryEvidenceOutage = (input, sessionId) =>
  anon().action("search/probe:probeQueryEvidence", {
    envelope: envelope("search.queryEvidence", input),
    sessionId,
    simulateEmbeddingOutage: true,
  });
const searchState = () => anon().action("search/probe:probeSearchState", {});
const drainNow = () => anon().action("platform/probe:probeDrainNow", {});
const recomputeState = (sessionId) =>
  anon().action("memory/recompute/probe:probeRecomputeState", { sessionId });
const setInvitationCode = (invitationId, code) =>
  anon().action("access/membership/probe:b3ProofSetInvitationCode", { invitationId, code });

/** Bounded wait (2s interval, explicit deadline — no tight polling). */
async function wait_for(label, predicate, timeoutMs = 120_000) {
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

/** The D3 media-access resolution with the person's browser credential. */
async function mediaAccess(persona, body) {
  const response = await fetch(`${URL_SITE}/sources/media/access`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${persona.token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

console.log(`# H3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);
row("run", RUN);
row("embedding key", "OPENROUTER_API_KEY absent on this lease (name checked); coverage expectation: text_only disclosed");

// --- setup: three real people, P owns the fixture company ----------------------

const P = await signInFixture(`h3-boss-${RUN}@kiero.invalid`);
const Q = await signInFixture(`h3-other-${RUN}@kiero.invalid`);
const R = await signInFixture(`h3-guest-${RUN}@kiero.invalid`);

const admit = (persona, operation, input) =>
  persona.client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope(operation, input),
  });

const createdP = await admit(P, "access.createCompany", {
  name: `Kiero Dev Proof H3 ${RUN}`,
  timezone: "Europe/Warsaw",
  defaultCurrency: "PLN",
});
if (!isOk(createdP)) throw new Error(`P createCompany failed: ${errCode(createdP)}`);
const companyId = value(createdP).companyId;
row("company (P)", companyId);

const createdQ = await admit(Q, "access.createCompany", {
  name: `Kiero Dev Proof H3-other ${RUN}`,
  timezone: "Europe/Warsaw",
  defaultCurrency: "PLN",
});
if (!isOk(createdQ)) throw new Error(`Q createCompany failed: ${errCode(createdQ)}`);
row("company (Q)", value(createdQ).companyId);

const projectIdentified = await P.client.mutation("projects/functions:dispatchProjects", {
  envelope: envelope("projects.identifyProject", {
    displayName: `Budowa H3 ${RUN}`,
    initialStage: "inquiry",
    clientId: null,
  }),
});
if (!isOk(projectIdentified)) throw new Error(`identifyProject failed: ${errCode(projectIdentified)}`);
const projectId = value(projectIdentified).projectId;
row("project", projectId);

// --- fixtures: Polish product prose with the RUN marker -------------------------

const TEXT_MARKER = `Betonową wylewkę podjazdu umówiliśmy na 12 października (${RUN})`;
const TEXT_WITHDRAW = `Dachówkę dostarczy hurtownia Baumat bezpośrednio na budowę (${RUN})`;
const TRANSCRIPT_SEG1 = `Ekipa hydrauliczna zaczyna instalację w poniedziałek (${RUN})`;
const TRANSCRIPT_SEG2 = `Kontrola jakości dachu zaplanowana na piątek (${RUN})`;
const OCR_TEXT = `FV/2026/09/${RUN.slice(-3)}`;
const FINDING_KEY = `termin_wylewki_${RUN}`;
const FINDING_V1 = `Wylewka podjazdu 12 października (${RUN})`;
const FINDING_V2 = `Wylewka podjazdu przesunięta na 19 października (${RUN})`;

const prepareUpload = (persona) =>
  persona.client.mutation("sources/uploads/commands:prepareUploadCommand", {
    envelope: envelope("sources.prepareUpload", { draftId: `h3-${RUN}-${Math.random().toString(36).slice(2, 8)}`, parts: 1, mediaKinds: [] }),
  });
const acceptSource = (persona, uploadId, authorText, projectHints) =>
  persona.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope("sources.acceptSource", {
      uploadId,
      authorText,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints,
    }),
  });

async function newSource(persona, text, hints) {
  const prepared = await prepareUpload(persona);
  if (!isOk(prepared)) throw new Error(`prepareUpload failed: ${errCode(prepared)}`);
  const accepted = await acceptSource(persona, value(prepared).uploadId, text, hints);
  if (!isOk(accepted)) throw new Error(`acceptSource failed: ${errCode(accepted)}`);
  return value(accepted).sourceId;
}

const sText = await newSource(P, TEXT_MARKER, [projectId]);
const sWithdraw = await newSource(P, TEXT_WITHDRAW, []);
const sAudio = await newSource(P, `Nagranie z budowy (${RUN}).`, []);
const sImage = await newSource(P, `Zdjęcie faktury (${RUN}).`, [projectId]);
row("source text", sText);
row("source withdraw-later", sWithdraw);
row("source audio", sAudio);
row("source image", sImage);

const qSource = await newSource(Q, `Notatka własnej firmy Q (${RUN})`, []);
row("source Q", qSource);

const transcriptSeed = await seedTranscript(sAudio, TRANSCRIPT_SEG1, TRANSCRIPT_SEG2);
if (!isOk(transcriptSeed)) throw new Error(`transcript seed failed: ${errCode(transcriptSeed)}`);
row("transcript fixture", value(transcriptSeed).transcriptId);

const ocrSeed = await seedImageOcr(
  sImage,
  [{ text: OCR_TEXT, region: { x: 64, y: 48, width: 256, height: 32 } }],
);
if (!isOk(ocrSeed)) throw new Error(`image OCR seed failed: ${errCode(ocrSeed)}`);
row("image OCR fixture", value(ocrSeed).orderId);

/** Publishes one finding revision through C2's REAL public dispatch (as P). */
async function publishRevision(findingId, text, sourceId, semanticKey = FINDING_KEY) {
  const prepared = await P.client.mutation("memory/findings/functions:dispatchMemoryCommandEntry", {
    envelope: envelope("memory.prepareChangeSet", {
      sourceId,
      plannedRevisions: [
        {
          findingId,
          scope: { _tag: "company" },
          semanticKey,
          value: { _tag: "text_note", text },
          knowledgeState: { _tag: "known" },
          effectiveFrom: null,
          evidence: [{ sourceId, fragmentId: null, supportKind: "support" }],
          derivesFrom: [],
        },
      ],
    }),
  });
  if (!isOk(prepared)) throw new Error(`prepareChangeSet failed: ${errCode(prepared)}`);
  const published = await P.client.mutation("memory/findings/functions:dispatchMemoryCommandEntry", {
    envelope: envelope("memory.publishChangeSet", {
      changeSetId: value(prepared).changeSetId,
      expectedRevisions: [],
    }),
  });
  if (!isOk(published)) throw new Error(`publishChangeSet failed: ${errCode(published)}`);
  return value(prepared).changeSetId;
}

const changeSet1 = await publishRevision(null, FINDING_V1, sText);
row("finding published (rev 1)", changeSet1);

const currentFindings = await P.client.query("memory/findings/functions:readCurrentFindings", {
  scope: { _tag: "company" },
});
const findingRow = (Array.isArray(currentFindings) ? currentFindings : []).find(
  (candidate) => candidate.semanticKey === FINDING_KEY,
);
if (findingRow === undefined) throw new Error("finding not readable after publication");
// The correction's expectedRevision is the CURRENT counter, read through
// C2's own history read (the current-findings row carries no counter).
const findingHistory = await P.client.query("memory/findings/functions:readFindingHistory", {
  findingId: findingRow.findingId,
});
row("finding id", findingRow.findingId);
row("finding revision counter", findingHistory?.revisionCounter);

// --- index lifecycle: reset, build, verified cutover (as P's session) -----------

await anon().action("search/probe:probeResetLaneState", {}).then((reset) => {
  if (!isOk(reset)) throw new Error(`lane reset failed: ${errCode(reset)}`);
});

const genStart = await searchCommand(
  "search.startIndexGeneration",
  { embeddingModel: "qwen/qwen3-embedding-8b", textPreparationVersion: "e5.fold.v1", dimensions: 4096 },
  P.sessionId,
);
if (!isOk(genStart)) throw new Error(`generation start failed: ${errCode(genStart)}`);
const generationId = value(genStart).generationId;
row("generation", generationId);

const buildKey = `search.index_generation:build:${generationId}`;
const builtState = await wait_for("build", (state) =>
  (state?.jobs ?? []).some((job) => job.dedupKey === buildKey && (job.state === "succeeded" || job.state === "failed")),
);
const buildJob = (builtState?.jobs ?? []).find((job) => job.dedupKey === buildKey);
row("build job", `${buildJob?.state}:${buildJob?.lastErrorKind ?? "-"}`);
if (buildJob?.state !== "succeeded") throw new Error("index build did not succeed");

const cutOver = await searchCommand("search.cutOverIndexGeneration", { generationId }, P.sessionId);
check("S0 index generation cut over (active)", isOk(cutOver), errCode(cutOver));

// --- the public search action (P's token) ----------------------------------------

const queryP = (input) =>
  P.client.action("search/commands:queryEvidence", { envelope: envelope("search.queryEvidence", input) });

{
  const textHit = await queryP({ query: `wylewka podjazdu (${RUN})`, limit: 10 });
  check(
    "S1a text evidence found through the public action with the source link",
    isOk(textHit) &&
      value(textHit).entries.some(
        (entry) => entry.kind === "source_fragment" && entry.sourceId === sText,
      ),
    `n=${value(textHit)?.entries?.length} coverage=${value(textHit)?.coverage}`,
  );

  const transcriptHit = await queryP({ query: `instalacja poniedziałek (${RUN})`, limit: 10 });
  check(
    "S1b transcript evidence found with its fragment link",
    isOk(transcriptHit) &&
      value(transcriptHit).entries.some(
        (entry) => entry.sourceId === sAudio && entry.sourceFragmentId !== undefined,
      ),
    `n=${value(transcriptHit)?.entries?.length}`,
  );

  const ocrHit = await queryP({ query: OCR_TEXT, limit: 10 });
  check(
    "S1c OCR evidence found through the indexed observation",
    isOk(ocrHit) && value(ocrHit).entries.some((entry) => entry.sourceId === sImage),
    `n=${value(ocrHit)?.entries?.length}`,
  );

  const findingHit = await queryP({ query: `termin wylewki (${RUN})`, limit: 10 });
  check(
    "S1d current finding revision found with the finding link",
    isOk(findingHit) && value(findingHit).entries.some((entry) => entry.kind === "finding"),
    `n=${value(findingHit)?.entries?.length}`,
  );

  const coverage = value(await queryP({ query: `wylewka (${RUN})`, limit: 10 }))?.coverage;
  check(
    "S2 coverage literal is one of the contract's three, disclosed verbatim",
    coverage === "full" || coverage === "text_only" || coverage === "degraded",
    `coverage=${coverage}`,
  );

  const outage = await queryEvidenceOutage({ query: `wylewka (${RUN})`, limit: 10 }, P.sessionId);
  check(
    "S2b simulated embedding outage discloses text_only (retrieval stands)",
    isOk(outage) && value(outage).coverage === "text_only" && value(outage).entries.length > 0,
    `coverage=${value(outage)?.coverage} n=${value(outage)?.entries?.length}`,
  );
}

// --- S3: filters and pagination ----------------------------------------------------

{
  const byProject = await queryP({ query: `wylewka (${RUN})`, limit: 10, projectId });
  check(
    "S3a project filter keeps the linked source only",
    isOk(byProject) &&
      value(byProject).entries.length > 0 &&
      value(byProject).entries.every((entry) => entry.sourceId === undefined || entry.sourceId === sText || entry.sourceId === sImage),
    `n=${value(byProject)?.entries?.length}`,
  );

  const byWrongAuthor = await queryP({
    query: `wylewka (${RUN})`,
    limit: 10,
    authorUserId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z9z",
  });
  check(
    "S3b author filter of a foreign author returns nothing",
    isOk(byWrongAuthor) && value(byWrongAuthor).entries.length === 0,
    `n=${value(byWrongAuthor)?.entries?.length}`,
  );

  const sentAtOfText = value(
    await P.client.query("sources/read/views:sourceDetail", { sourceId: sText }),
  )?.sentAtMs;
  const inWindow = await queryP({
    query: `wylewka (${RUN})`,
    limit: 10,
    sentFromMs: sentAtOfText - 60_000,
    sentToMs: sentAtOfText + 60_000,
  });
  const outWindow = await queryP({
    query: `wylewka (${RUN})`,
    limit: 10,
    sentFromMs: sentAtOfText - 10 * 60_000,
    sentToMs: sentAtOfText - 5 * 60_000,
  });
  check("S3c date window keeps the row", isOk(inWindow) && value(inWindow).entries.length > 0);
  check("S3d outside the date window: nothing", isOk(outWindow) && value(outWindow).entries.length === 0);

  const seen = [];
  let cursor = undefined;
  let pages = 0;
  for (let guard = 0; guard < 12; guard += 1) {
    const page = await queryP({ query: `na (${RUN})`, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    if (!isOk(page)) break;
    for (const entry of value(page).entries) seen.push(entry.searchEntryId);
    pages += 1;
    if (value(page).isDone || value(page).entries.length === 0) break;
    cursor = value(page).entries[value(page).entries.length - 1].searchEntryId;
  }
  check(
    "S3e cursor pagination walks distinct pages without duplicates",
    pages > 1 && new Set(seen).size === seen.length,
    `pages=${pages} rows=${seen.length}`,
  );
}

// --- S4: company isolation ----------------------------------------------------------

const queryQ = (input) =>
  Q.client.action("search/commands:queryEvidence", { envelope: envelope("search.queryEvidence", input) });

{
  const fromQ = await queryQ({ query: `wylewka (${RUN})`, limit: 10 });
  check(
    "S4a the other company's query returns none of P's evidence",
    isOk(fromQ) &&
      value(fromQ).entries.every(
        (entry) => ![sText, sWithdraw, sAudio, sImage].includes(entry.sourceId),
      ),
    `n=${value(fromQ)?.entries?.length}`,
  );
  const foreignDetail = await Q.client.query("sources/read/views:sourceExposition", { sourceId: sText });
  check(
    "S4b the other company's source-detail read refuses (closed not_found)",
    foreignDetail?._tag === "error" && foreignDetail.error.code === "source_not_in_company",
    foreignDetail?._tag === "error" ? foreignDetail.error.code : "ok",
  );
  const foreignEvidence = await Q.client.query("sources/read/views:sourceEvidence", {
    sourceId: sText,
    paginationOpts: { numItems: 5, cursor: null },
  });
  check(
    "S4c the other company's evidence read refuses the same way",
    foreignEvidence?._tag === "error",
    foreignEvidence?._tag === "error" ? foreignEvidence.error.code : "ok",
  );
}

// --- S5: the dossier reads (public queries, P's token) ------------------------------

{
  const imageDossier = value(
    await P.client.query("sources/read/views:sourceExposition", { sourceId: sImage }),
  );
  check(
    "S5a image dossier: retained representation with its pixel space",
    imageDossier?.attachments?.some((attachment) =>
      attachment.representations.some(
        (representation) =>
          representation.role === "retained" &&
          representation.verifiedAtMs !== null &&
          representation.width === 1024 &&
          representation.height === 768,
      ),
    ),
    JSON.stringify(imageDossier?.attachments?.[0]?.representations?.map((r) => `${r.role}:${r.width}x${r.height}`)),
  );
  const visionOrder = (imageDossier?.visionOrders ?? [])[0];
  check(
    "S5b OCR observations with coordinate anchors against that representation",
    visionOrder?.observations?.some(
      (observation) =>
        observation.text === OCR_TEXT &&
        observation.region.x === 64 &&
        observation.region.width === 256,
    ) && visionOrder?.spaceWidth === 1024,
    `obs=${visionOrder?.observations?.length ?? 0}`,
  );
  check(
    "S5c image_region fragment anchor present",
    (imageDossier?.fragments ?? []).some(
      (fragment) => fragment.anchor._tag === "image_region" && fragment.anchor.x === 64,
    ),
  );

  const audioDossier = value(
    await P.client.query("sources/read/views:sourceExposition", { sourceId: sAudio }),
  );
  const transcript = (audioDossier?.transcripts ?? [])[0];
  check(
    "S5d audio dossier: complete transcript with verbatim segments and time anchors",
    transcript?.state === "complete" &&
      transcript?.segments?.length === 2 &&
      transcript.segments[0].startMs === 0 &&
      transcript.segments[0].text === TRANSCRIPT_SEG1,
    `state=${transcript?.state} segments=${transcript?.segments?.length ?? 0}`,
  );
  check(
    "S5e audio_interval fragment anchor present",
    (audioDossier?.fragments ?? []).some((fragment) => fragment.anchor._tag === "audio_interval"),
  );

  const textDossier = value(
    await P.client.query("sources/read/views:sourceExposition", { sourceId: sText }),
  );
  check(
    "S5f text dossier: immutable authored content and project link",
    textDossier?.authorText === TEXT_MARKER && textDossier?.projectIds?.[0] === projectId,
  );
}

// --- S6: the paginated evidence chain with correction history ------------------------

{
  const corrected = await P.client.mutation("memory/findings/functions:dispatchMemoryCommandEntry", {
    envelope: envelope("memory.correctFinding", {
      findingId: findingRow.findingId,
      expectedRevision: findingHistory.revisionCounter,
      value: { _tag: "text_note", text: FINDING_V2 },
      knowledgeState: { _tag: "known" },
      reason: "Klient przesunął termin telefonicznie.",
    }),
  });
  check("S6a direct correction through the public command", isOk(corrected), errCode(corrected));

  const evidence = value(
    await P.client.query("sources/read/views:sourceEvidence", {
      sourceId: sText,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  const cited = (evidence?.page ?? []).find((entry) => entry.findingId === findingRow.findingId);
  check(
    "S6b the evidence chain shows the cited revision superseded by the correction",
    cited?.supersededByNewerRevision === true &&
      cited?.currentOrigin === "correction" &&
      cited?.currentRevision === 2,
    `origin=${cited?.currentOrigin} current=${cited?.currentRevision}`,
  );
  check(
    "S6c the page is a bounded Convex page (cursor vocabulary present)",
    evidence !== null && typeof evidence.isDone === "boolean" && typeof evidence.continueCursor === "string",
    `isDone=${evidence?.isDone}`,
  );
}

// --- S7: withdrawal through C5 (public command) ---------------------------------------

{
  const withdrawn = await P.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope("sources.withdrawSource", {
      sourceId: sWithdraw,
      reason: "Pomyłka: dotyczyło innego projektu.",
    }),
  });
  check("S7a withdrawal through the public C5 command", isOk(withdrawn), errCode(withdrawn));

  const afterWithdrawQuery = await queryP({ query: `dachówka hurtownia Baumat (${RUN})`, limit: 10 });
  check(
    "S7b the withdrawn source authorizes nothing in search (stale vector filtered)",
    isOk(afterWithdrawQuery) &&
      value(afterWithdrawQuery).entries.every((entry) => entry.sourceId !== sWithdraw),
    `n=${value(afterWithdrawQuery)?.entries?.length}`,
  );

  const withdrawnDossier = value(
    await P.client.query("sources/read/views:sourceExposition", { sourceId: sWithdraw }),
  );
  check(
    "S7c the withdrawn source stays inspectable with its record (not deletion)",
    withdrawnDossier?.lifecycle === "withdrawn" &&
      withdrawnDossier?.withdrawnReason === "Pomyłka: dotyczyło innego projektu." &&
      withdrawnDossier?.authorText === TEXT_WITHDRAW,
    `lifecycle=${withdrawnDossier?.lifecycle}`,
  );

  // The corrected finding keeps its authority (C5: a later explicit
  // correction survives an older basis's withdrawal — its CURRENT revision
  // cites no evidence). The recomputation marking therefore needs a finding
  // whose CURRENT revision rests on the source about to be withdrawn:
  // publish F2 citing sText, then withdraw sText.
  const f2Key = `${FINDING_KEY}_wykonawca`;
  const f2ChangeSet = await publishRevision(
    null,
    `Wylewkę wykonuje ekipa Marka (${RUN})`,
    sText,
    f2Key,
  );
  row("finding F2 published (cites sText)", f2ChangeSet);
  const currentF2 = await P.client.query("memory/findings/functions:readCurrentFindings", {
    scope: { _tag: "company" },
  });
  const f2Row = (Array.isArray(currentF2) ? currentF2 : []).find(
    (candidate) => candidate.semanticKey === f2Key,
  );
  if (f2Row === undefined) throw new Error("F2 not readable after publication");

  const evidenceBefore = value(
    await P.client.query("sources/read/views:sourceEvidence", {
      sourceId: sText,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  check(
    "S7d the corrected finding still carries its history and F2 cites this source",
    (evidenceBefore?.page ?? []).some((entry) => entry.findingId === findingRow.findingId) &&
      (evidenceBefore?.page ?? []).some((entry) => entry.findingId === f2Row.findingId),
  );

  const withdrawSupport = await P.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope("sources.withdrawSource", {
      sourceId: sText,
      reason: "Wycofuję podstawę ustalenia do ponownego rozpatrzenia.",
    }),
  });
  check("S7e support withdrawal executed", isOk(withdrawSupport), errCode(withdrawSupport));

  await drainNow();
  const recompute = await (async () => {
    const deadline = Date.now() + 90_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await recomputeState(P.sessionId);
      const finding = (value(last)?.findings ?? []).find((f) => f.findingId === f2Row.findingId);
      if (finding !== undefined && finding.knowledgeTag !== "known") {
        return last;
      }
      await sleep(2_000);
    }
    return last;
  })();
  const findingState = (value(recompute)?.findings ?? []).find((f) => f.findingId === f2Row.findingId);
  check(
    "S7f the dependent finding is re-assessed by recomputation (not settled, automation-blocked)",
    (findingState?.knowledgeTag === "updating" || findingState?.knowledgeTag === "unknown") &&
      findingState?.automationEligible === false,
    `knowledge=${findingState?.knowledgeTag} automation=${findingState?.automationEligible}`,
  );

  const evidenceAfter = value(
    await P.client.query("sources/read/views:sourceEvidence", {
      sourceId: sText,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  const citedAfter = (evidenceAfter?.page ?? []).find((entry) => entry.findingId === f2Row.findingId);
  check(
    "S7g the evidence chain discloses the recomputation on the current projection (withdrawal marking)",
    citedAfter?.currentOrigin === "withdrawal_marking" &&
      (citedAfter?.currentKnowledgeState?._tag === "updating" ||
        citedAfter?.currentKnowledgeState?._tag === "unknown"),
    `origin=${citedAfter?.currentOrigin} knowledge=${citedAfter?.currentKnowledgeState?._tag}`,
  );
}

// --- S8: media access resolution (D3 boundary, live authorization) --------------------

{
  // The image fixture's attachment and retained representation carry the
  // full D3 ledger receipts (etag-prefixed hash, own bytes, dimensions), so
  // the resolution answers real grants for both read paths.
  const attachmentId = value(ocrSeed).attachmentId;
  const representationId = value(ocrSeed).representationId;

  const grantAttachment = await mediaAccess(P, { attachmentId });
  check(
    "S8a the canonical attachment read resolves a grant (current representation)",
    grantAttachment.status === 200 &&
      grantAttachment.body?._tag === "ok" &&
      grantAttachment.body?.value?.role === "retained",
    `status=${grantAttachment.status} role=${grantAttachment.body?.value?.role}`,
  );
  const grantRep = await mediaAccess(P, { representationId });
  check(
    "S8b the exact-representation read resolves the anchored representation",
    grantRep.status === 200 &&
      grantRep.body?.value?.representationId === representationId &&
      grantRep.body?.value?.width === 1024,
    `status=${grantRep.status}`,
  );

  // Membership revocation mid-session: invite R for real, read once, revoke,
  // read again — every request re-authorizes.
  let revocationRefusal = false;
  let revocationDetail = "not-run";
  try {
    const invite = await P.client.action("access/membership/functions:createInvitationCommand", {
      envelope: envelope("access.createInvitation", { email: R.email, role: "member" }),
    });
    if (isOk(invite)) {
      const invitationId = value(invite).invitationId;
      await setInvitationCode(invitationId, fixtureCodeOf(`${R.email}:invite`));
      const accepted = await admit(R, "access.acceptInvitation", {
        invitationId,
        verificationCode: fixtureCodeOf(`${R.email}:invite`),
      });
      if (isOk(accepted)) {
        const asMember = await mediaAccess(R, { attachmentId });
        const memberRead = asMember.status === 200 && asMember.body?._tag === "ok";
        const revoked = await P.client.mutation("access/membership/functions:dispatchMembership", {
          envelope: envelope("access.revokeMembership", {
            membershipId: value(accepted).membershipId,
          }),
        });
        const afterRevoke = await mediaAccess(R, { attachmentId });
        revocationRefusal =
          memberRead && isOk(revoked) && (afterRevoke.status === 401 || afterRevoke.status === 403);
        revocationDetail = `member=${memberRead} revoke=${isOk(revoked)} after=${afterRevoke.status}`;
      } else {
        revocationDetail = `acceptInvitation failed: ${errCode(accepted)}`;
      }
    } else {
      revocationDetail = `createInvitation failed: ${errCode(invite)}`;
    }
  } catch (error) {
    revocationDetail = `error: ${String(error).slice(0, 80)}`;
  }
  check(
    "S8c membership revoked mid-session: the next media request refuses",
    revocationRefusal,
    revocationDetail,
  );

  const foreign = await mediaAccess(Q, { attachmentId });
  check(
    "S8d the other company's media request gets the closed refusal",
    foreign.body?._tag === "error" && foreign.body?.error?.code === "media_reference_not_found",
    `status=${foreign.status} code=${foreign.body?.error?.code}`,
  );
}

// --- final sanitized dump ---------------------------------------------------------------

{
  const state = await searchState();
  row("generations", JSON.stringify((state?.generations ?? []).map((g) => `${g.state}`)));
  row("entries by company", JSON.stringify(state?.entriesByCompany ?? []));
}

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`# H3 live proof summary: ${results.length - failed.length}/${results.length} PASS`);
for (const failure of failed) {
  console.log(`# FAILED: ${failure.id}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
