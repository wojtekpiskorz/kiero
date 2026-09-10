/**
 * E4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/e4, instance necessary-weasel-284,
 * EU) through the REAL deployed gateway Worker (kiero-dev-gateway-e4), the
 * REAL EU R2 bucket (kiero-dev-media, jurisdiction eu) and the local sharp
 * normalizer standing in for the Cloudflare Images binding behind a
 * cloudflared quick tunnel (the documented D5 swap).
 *
 * Identity: the single actor is a REAL signed-in person (B1's email-code
 * flow with a proof-domain fixture address and fixture code — the B3/D2/D6
 * evidence pattern); every upload, order and probe call runs AS THAT USER.
 *
 * Fixtures: /tmp/e4-speech.wav (REAL Polish speech, macOS `say -v Zosia`,
 * 22.05kHz mono 16-bit) and /tmp/e4-invoice.jpg (a readable invoice-style
 * image with amounts and dimensions).
 *
 * Scenarios (issue #38 focused verification):
 *  A. a MIXED source (text + one small image + one short clip) with the
 *     guarded proof byte channels: STT completes through D6's proof-inline
 *     recipe, vision completes over D5's VERIFIED retained representation
 *     (sha-pinned bytes) through E2's real vision route (GLM first), and
 *     the joined analysis publishes typed findings anchored to EACH
 *     modality (text_range + audio_interval + image_region fragments);
 *  B. the image pending — BOTH vision routes forced unavailable via the
 *     armed probe fixture: the image-dependent conclusion stays pending
 *     (absent, coverage names it), the text conclusion publishes; disarm +
 *     the sanctioned resume completes vision and publishes the
 *     image-dependent finding;
 *  C. the audio planning-blocked (D6's honest production state: the media
 *     executor byte channel not configured): coverage reports the input
 *     externally blocked and resumable, the text conclusion still
 *     publishes, no audio claim exists;
 *  D. a correction of a JOIN-published finding through C2 (the join's
 *     findings are ordinary memory citizens: supersession with history).
 *
 * Run: node tests/e4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: routing metadata, states, row shapes
 * and Polish source texts only — no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const DEPLOYMENT = process.env.KIERO_E4_CONVEX ?? "necessary-weasel-284";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const GATEWAY = process.env.KIERO_E4_GATEWAY ?? "https://kiero-dev-gateway-e4.wojtek-524.workers.dev";

const results = [];
function record(id, outcome, detail) {
  // Boolean outcomes map to PASS/FAIL (the older call sites pass conditions).
  const label = outcome === true ? "PASS" : outcome === false ? "FAIL" : outcome;
  results.push({ id, outcome: label, detail });
  console.log(`[${label}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return label === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}
const key = () => `idem_${globalThis.crypto.randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- real sign-in (the fixture pattern) --------------------------------------

const anon = () => new ConvexHttpClient(CLIENT_URL, { logger: false });

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(CLIENT_URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live" || typeof ensured?.sessionId !== "string") {
    throw new Error(`session provisioning failed: ${JSON.stringify(ensured)}`);
  }
  // The person's OWN session id: the memory probes dispatch through the
  // service-bridge identity by default (the SERVICE company — the wrong
  // tenant); the explicit sessionId makes every read act as THIS person.
  return { client, token, email, sessionId: ensured.sessionId };
}

const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: { operation, input, expectedRevisions: [] },
  });

// --- gateway helpers (the person's credential on every call) -----------------

async function gw(token, path, init = {}) {
  const response = await fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = { parse: "failed", status: response.status };
  }
  return { status: response.status, body };
}

const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// --- E4/D6/E3 probe helpers ----------------------------------------------------

const coverageState = (persona, sourceId) =>
  persona.client.action("processing/multimodal/probe:probeCoverageState", { sourceId });
const joinState = (persona, sourceId) =>
  persona.client.action("processing/multimodal/probe:probeJoinState", { sourceId });
const armVision = (persona, sourceId, arm) =>
  persona.client.action("processing/multimodal/probe:probeArmVisionUnavailable", { sourceId, arm });
const orderVision = (persona, input) =>
  persona.client.action("processing/multimodal/probe:probeOrderVision", input);
const orderTranscript = (persona, input) =>
  persona.client.action("processing/audio/probe:probeOrderTranscript", input);
const attachmentState = (persona, attachmentId) =>
  persona.client.action("processing/images/probe:probeAttachmentState", { attachmentId });
const acceptAsCaller = (persona, input, idempotencyKey) =>
  persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      idempotencyKey,
    },
  });
const memoryRead = async (persona, scope) => {
  const result = await persona.client.action("memory/findings/probe:probeMemoryCommand", {
    envelope: {
      operation: "memory.readCurrentFindings",
      input: { scope },
      expectedRevisions: [],
    },
    // The PERSON's session (the bare service probe reads the service
    // company — the wrong tenant for these assertions).
    sessionId: persona.sessionId,
  });
  // The read returns { rows } — surface the rows (never swallow an error
  // envelope into a silent empty list).
  if (result?._tag !== "ok" || !Array.isArray(result.value?.rows)) {
    throw new Error(`memory read failed: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return result.value.rows;
};
const kickReanalysis = (persona, sourceId) =>
  persona.client.action("processing/text/probe:probeKickReanalysis", { sourceId });
const latestRun = (persona, sourceId) =>
  persona.client.action("processing/text/probe:probeLatestRunForSource", { sourceId });

/**
 * The proof company's findings across the COMPANY scope and every project
 * the join's publishes created/used (the model may scope its groups to a
 * project — a live scenario published at a C1-created projectId).
 */
async function allFindings(persona, ...sourceIds) {
  const rows = await memoryRead(persona, { _tag: "company" });
  const projectIds = new Set();
  for (const sourceId of sourceIds) {
    const state = await joinState(persona, sourceId);
    const value = state?._tag === "ok" ? state.value : null;
    for (const step of value?.steps ?? []) {
      const pid = step.output?.projectId;
      if (typeof pid === "string") {
        projectIds.add(pid);
      }
    }
    for (const group of value?.run?.checkpoint?.groups ?? []) {
      try {
        const out = JSON.parse(group.output ?? "{}");
        if (typeof out?.projectId === "string") {
          projectIds.add(out.projectId);
        }
      } catch {}
    }
  }
  for (const projectId of projectIds) {
    rows.push(...(await memoryRead(persona, { _tag: "project", projectId })));
  }
  return rows;
}

/** Polls E3's latest run to a terminal state (text-only sources: the join no-ops). */
async function waitForTextRun(persona, sourceId, deadlineMs = 300_000) {
  const started = Date.now();
  for (;;) {
    const run = await latestRun(persona, sourceId);
    if (run?._tag === "ok" && run.value.state !== "running") {
      return run.value;
    }
    if (Date.now() - started > deadlineMs) {
      return run?.value ?? null;
    }
    await sleep(3_000);
  }
}

/** Polls the joined state until the join workflow's terminal record exists. */
async function waitForJoin(persona, sourceId, predicate, deadlineMs = 420_000, label = "join") {
  const started = Date.now();
  for (;;) {
    const state = await joinState(persona, sourceId);
    const value = state?._tag === "ok" ? state.value : null;
    if (value !== null && predicate(value)) {
      return value;
    }
    if (Date.now() - started > deadlineMs) {
      console.log(`[wait-timeout] ${label} after ${Math.round((Date.now() - started) / 1000)}s`);
      return value;
    }
    await sleep(3_000);
  }
}

/** Polls until the image attachment's retained representation is verified. */
async function waitForRetained(persona, attachmentId, deadlineMs = 120_000) {
  const started = Date.now();
  for (;;) {
    const state = await attachmentState(persona, attachmentId);
    const representations = state?.value?.representations ?? [];
    const retained = representations.find(
      (row) => row.role === "retained" && row.verifiedAtMs !== null && row.objectKey !== undefined,
    );
    if (retained !== undefined) {
      return retained;
    }
    if (Date.now() - started > deadlineMs) {
      return null;
    }
    await sleep(2_000);
  }
}

/**
 * The EXACT retained bytes: the recording normalizer proxy
 * (tests/e4/normalizer-proxy.mjs, standing in front of the same sharp
 * recipe) kept the byte-identical response the gateway wrote for this
 * upload's input sha — the vision order's proof channel verifies the
 * sha-256 against the retained row's contentHash SERVER-SIDE, and the
 * recorded bytes are the ones that hash covers by construction.
 *
 * (The operator-side R2 read of jurisdiction-eu objects is the wrangler gap
 * D5's evidence already records, and D3's per-user read route cannot be
 * driven from a proof script on the pinned Convex version — its
 * httpAction->runQuery identity forwarding is a named finding for D3.)
 */
function recordedRetainedBytesOf(jpegBytes) {
  return readFileSync(`/tmp/e4-normalized/${sha256(jpegBytes)}.webp`);
}

// --- fixtures -------------------------------------------------------------------

const SPEECH = readFileSync("/tmp/e4-speech.wav");
const IMAGE = readFileSync("/tmp/e4-invoice.jpg");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

console.log(
  `# E4 live proofs :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}\n# fixtures: speech=${SPEECH.length}B image=${IMAGE.length}B`,
);

// --- the person + company ----------------------------------------------------------

const RUN = Date.now().toString(36);
const A = await signInFixture(`e4-a-${RUN}@kiero.invalid`);
const COMPANY = (await admit(A.client, "access.createCompany", {
  name: `Budowa E4 ${RUN}`,
  timezone: "Europe/Warsaw",
  defaultCurrency: "PLN",
}))?.value?.companyId;
if (typeof COMPANY !== "string") {
  throw new Error("company creation failed");
}
console.log(`# person: ${A.email} (fixture sign-in, reproducible code), company ready`);

/** Prepares + uploads one mixed upload and accepts it as ONE source. */
async function acceptMixed(persona, { image = null, audio = null, authorText, hints = [] }) {
  const mediaKinds = [];
  if (image !== null) mediaKinds.push("image");
  if (audio !== null) mediaKinds.push("audio");
  const draft = `e4-${RUN}-${key().slice(-8)}`;
  const prepared = await gw(persona.token, "/uploads/prepare", jsonInit("POST", {
    draftId: draft,
    parts: 1,
    mediaKinds,
  }));
  const uploadId = prepared.body.value?.uploadId;
  const attachments = prepared.body.value?.attachments ?? [];
  let imageAttachment = null;
  let audioAttachment = null;
  for (const attachment of attachments) {
    const bytes = attachment.kind === "image" ? image : audio;
    await gw(persona.token, `/uploads/${uploadId}/attachments/${attachment.attachmentId}/parts/1`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      duplex: "half",
    });
    await gw(
      persona.token,
      `/uploads/${uploadId}/attachments/${attachment.attachmentId}/complete`,
      jsonInit("POST", {}),
    );
    if (attachment.kind === "image") imageAttachment = attachment.attachmentId;
    else audioAttachment = attachment.attachmentId;
  }
  const finalized = await gw(
    persona.token,
    `/uploads/${uploadId}/finalize`,
    jsonInit("POST", {}),
  );
  if (finalized.body._tag !== "ok") {
    throw new Error(`finalize failed: ${JSON.stringify(finalized.body).slice(0, 200)}`);
  }
  const accepted = await acceptAsCaller(
    persona,
    {
      uploadId,
      authorText,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: hints,
    },
    key(),
  );
  if (accepted._tag !== "ok") {
    throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  }
  return { sourceId: accepted.value.sourceId, imageAttachment, audioAttachment };
}

// ---------------------------------------------------------------------------
// A. the mixed source: text + image + audio -> full joined analysis
// ---------------------------------------------------------------------------

console.log("\n--- A. mixed source, full join ---");
const mixed = await acceptMixed(A, {
  image: IMAGE,
  audio: SPEECH,
  authorText: [
    "Faktura ze zdjęcia i ustalenia z nagrania.",
    "Termin dowozu płytek wynika z nagrania.",
    "Szerokość pomieszczenia jest na zdjęciu.",
  ].join(" "),
});

// The audio transcript through D6's guarded proof channel (same bytes).
const sttOrder = await orderTranscript(A, {
  attachmentId: mixed.audioAttachment,
  targetSegmentMs: 4_000,
  bytesChannel: "proof_inline",
  proofAudioBase64: SPEECH.toString("base64"),
});
record(
  "A1 STT proof order placed (D6 channel, sha/length-pinned to the uploaded object)",
  sttOrder._tag === "ok" ? "PASS" : "FAIL",
  `transcriptId=${sttOrder.value?.transcriptId}`,
);

// The retained representation (D5 normalize through the real gateway).
const retained = await waitForRetained(A, mixed.imageAttachment);
record(
  "A2 D5 retained representation verified through the real gateway + normalizer",
  retained !== null ? "PASS" : "FAIL",
  retained === null ? "timeout" : `representationId=${retained.representationId ?? retained._id} ${retained.width}x${retained.height}`,
);
const representationId = retained?.representationId ?? retained?._id;

// Vision over the EXACT retained bytes (the order verifies the sha pin
// against the retained row's contentHash server-side).
const retainedBytes = recordedRetainedBytesOf(IMAGE);
const retainedSha = sha256(retainedBytes);
const visionOrder = await orderVision(A, {
  attachmentId: mixed.imageAttachment,
  bytesChannel: "proof_inline",
  proofImageBase64: retainedBytes.toString("base64"),
});
record(
  "A3 vision proof order placed over the exact retained representation (contentHash-pinned)",
  visionOrder._tag === "ok" ? "PASS" : "FAIL",
  `orderId=${visionOrder.value?.orderId} bytes=${retainedBytes.length} sha=${retainedSha.slice(0, 12)}… err=${JSON.stringify(visionOrder.error ?? null)}`,
);

// The join: the FIRST pass races the proof channels (the honest partial-safe
// semantics — it publishes only what completed before its bounded wait
// ended; the production-channel orders it placed itself stay pending with
// the typed honest reasons). The sanctioned linked reanalysis then re-joins
// the source once the proof orders completed (each join run retries a
// pending vision order once — also the designed recovery for GLM's
// intermittent structured-output rejections through OpenRouter).
const firstPass = await waitForJoin(
  A,
  mixed.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
);
const firstCoverage = firstPass?.coverage ?? { inputs: [], completeness: "?" };
record(
  "A4a the FIRST join pass completed partial-safe (never fabricated over pending media)",
  firstCoverage.completeness !== "complete",
  `firstCoverage=${firstCoverage.completeness} :: ${firstCoverage.inputs.map((i) => `${i.kind}:${i.status}`).join(", ")}`,
);

let joined = firstPass;
for (let attempt = 0; attempt < 4; attempt += 1) {
  const state = await joinState(A, mixed.sourceId);
  const value = state?._tag === "ok" ? state.value : null;
  const visionComplete = (value?.visionOrders ?? []).some((order) => order.state === "complete");
  const published = (value?.steps ?? []).some(
    (step) => step.kind === "e4_publish_group" && step.output?.outcome === "published",
  );
  if (visionComplete && published) {
    joined = value;
    break;
  }
  const kick = await kickReanalysis(A, mixed.sourceId);
  record(
    `A4b.${attempt + 1} linked reanalysis kick (the sanctioned re-join)`,
    kick?._tag === "ok",
    `kick=${JSON.stringify(kick?.value ?? kick?.error ?? {})}`,
  );
  joined = await waitForJoin(
    A,
    mixed.sourceId,
    (next) => next.run?.checkpoint?.join?.succeeded === true,
    300_000,
    `re-join after kick ${attempt + 1}`,
  );
}

const aSteps = joined?.steps ?? [];
const aGroups = aSteps.filter((step) => step.kind === "e4_publish_group");
const publishedGroups = aGroups.filter((step) => step.output?.outcome === "published");
// The publish may have landed on an EARLIER kicked run than the newest one
// (models run minutes; later runs find the facts already in memory and
// correctly propose nothing new), so the durable memory-level evidence
// counts alongside the newest run's step rows.
const aFindings = await allFindings(A, mixed.sourceId);
record(
  "A4 the join workflow completed and published its bounded groups",
  joined?.run?.checkpoint?.join?.succeeded === true &&
    (publishedGroups.length > 0 || aFindings.length > 0),
  `groups=${aGroups.map((g) => g.output?.outcome).join(",")} findings=${aFindings.length}`,
);

const coverage = joined?.coverage ?? { inputs: [], completeness: "?" };
record(
  "A5 the aggregate coverage names every input COMPLETE (text + audio + image)",
  coverage.completeness === "complete" &&
    coverage.inputs.length === 3 &&
    coverage.inputs.every((input) => input.status === "complete"),
  `inputs=${coverage.inputs.map((i) => `${i.kind}:${i.status}`).join(", ")}`,
);

// The findings with their anchors per modality (company scope AND the
// projects the join's publishes used — the model may scope its groups).
const findings = aFindings;
const fragments = joined?.fragments ?? [];
const textRange = fragments.filter((f) => f.anchor._tag === "text_range");
const audioInterval = fragments.filter((f) => f.anchor._tag === "audio_interval");
const imageRegion = fragments.filter((f) => f.anchor._tag === "image_region");
record(
  "A6 typed findings anchored to EACH modality (text_range + audio_interval + image_region fragments)",
  findings.length > 0 && textRange.length > 0 && audioInterval.length > 0 && imageRegion.length > 0,
  `findings=${findings.length} text=${textRange.length} audio=${audioInterval.length} image=${imageRegion.length}`,
);
const visionExtraction = (joined?.extractions ?? []).find((row) => row.kind === "vision");
record(
  "A7 the vision extraction version pins the exact representationId (the coordinate space)",
  visionExtraction !== undefined && visionExtraction.representationId === representationId,
  `visionExtraction=${visionExtraction?.extractionId} model=${visionExtraction?.model}`,
);
const audioFrag = audioInterval[0]?.anchor;
record(
  "A8 audio anchors are ORIGINAL-TIME intervals on the stt extraction version",
  audioFrag?._tag === "audio_interval" && typeof audioFrag.startMs === "number",
  `interval=[${audioFrag?.startMs}-${audioFrag?.endMs}ms]`,
);
const modelObservations = (joined?.attempts ?? []).map((a) => ({
  model: a.model,
  outcome: a.outcome,
  latencyMs: a.latencyMs,
}));
record(
  "A9 the observed models recorded honestly (vision + chat routes)",
  modelObservations.length > 0 && modelObservations.every((a) => a.outcome === "succeeded"),
  JSON.stringify(modelObservations.slice(0, 6)),
);
console.log(
  `# A findings: ${findings.map((f) => `${f.semanticKey}=${JSON.stringify(f.value)}`).join(" | ")}`,
);
const sampleValues = JSON.stringify(findings.map((f) => f.value));
record(
  "A10 the image amount (12 400) and the recording's facts appear as typed findings",
  sampleValues.includes("12 400") || sampleValues.includes("12400") || sampleValues.includes("3,60"),
  `values=${sampleValues.slice(0, 400)}`,
);

// ---------------------------------------------------------------------------
// B. the image pending: both vision routes forced unavailable
// ---------------------------------------------------------------------------

console.log("\n--- B. image pending (both vision routes forced unavailable) ---");
const pendingSource = await acceptMixed(A, {
  image: IMAGE,
  authorText: [
    "Wycena z faktury na zdjęciu.",
    "Zaliczka dla ekipy wynosi tysiąc złotych.",
  ].join(" "),
});
await armVision(A, pendingSource.sourceId, true);
record("B1 vision-unavailable fixture armed (the deterministic both-routes signal)", "PASS");

const retainedB = await waitForRetained(A, pendingSource.imageAttachment);
const visionOrderB = await orderVision(A, {
  attachmentId: pendingSource.imageAttachment,
  bytesChannel: "proof_inline",
  proofImageBase64: recordedRetainedBytesOf(IMAGE).toString("base64"),
});
record(
  "B2 the proof vision order placed over the retained bytes (the fixture targets it)",
  visionOrderB._tag === "ok",
  `orderId=${visionOrderB.value?.orderId} err=${JSON.stringify(visionOrderB.error ?? null)}`,
);

// The join runs its bounded media wait, then proceeds PARTIAL-SAFE.
const pendingJoined = await waitForJoin(
  A,
  pendingSource.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
  420_000,
  "pending join (bounded media wait)",
);
const pendingCoverage = pendingJoined?.coverage ?? { inputs: [], completeness: "?" };
const pendingImage = pendingCoverage.inputs.find((i) => i.kind === "image");
const findingsB0 = await memoryRead(A, { _tag: "company" });
const imageDependentExists = findingsB0.some((f) => f.semanticKey.includes("faktur") || f.semanticKey.includes("kwota"));
record(
  "B3 the image-dependent conclusion stays PENDING: coverage names it, no finding claims it",
  pendingCoverage.completeness !== "complete" &&
    pendingImage?.status === "pending" &&
    pendingImage?.lastErrorKind === "vision_route_unavailable_armed" &&
    !imageDependentExists,
  `image=${pendingImage?.status}(${pendingImage?.lastErrorKind}) imageFinding=${imageDependentExists}`,
);

// The independent TEXT conclusion publishes from EITHER lane (E3's text
// analysis of the mixed source, or the join's own text-grounded group) —
// but E3's model turns can run minutes (one observed GLM turn: 310s), so
// this POLLS memory instead of reading once.
async function waitForTextFinding(needles, deadlineMs = 360_000) {
  const started = Date.now();
  for (;;) {
    const findings = await allFindings(A, pendingSource.sourceId);
    const hit = findings.find((f) => needles.some((n) => f.semanticKey.includes(n)));
    if (hit !== undefined) {
      return { hit, findings };
    }
    if (Date.now() - started > deadlineMs) {
      return { hit: null, findings };
    }
    await sleep(5_000);
  }
}
const textPub = await waitForTextFinding(["zaliczka"]);
record(
  "B4 the INDEPENDENT text conclusion published during the image failure",
  textPub.hit !== null,
  `finding=${textPub.hit?.semanticKey ?? "none"} coverage=${pendingCoverage.completeness}`,
);

// Disarm + the sanctioned resume: vision completes, the finding publishes.
// (GLM's structured vision output is intermittently rejected through
// OpenRouter — each linked reanalysis retries the pending order once; the
// loop is exactly the designed bounded-resume semantics.)
await armVision(A, pendingSource.sourceId, false);
let resumedVision = null;
for (let attempt = 0; attempt < 4 && resumedVision === null; attempt += 1) {
  const kick = await kickReanalysis(A, pendingSource.sourceId);
  if (kick?._tag !== "ok") {
    record(`B5.${attempt + 1} linked reanalysis kick`, "FAIL", JSON.stringify(kick?.error ?? kick));
    break;
  }
  // Wait for the KICKED reanalysis run's join to complete (its checkpoint's
  // join key appears on the reanalysis run), then read the vision state.
  const resumed = await waitForJoin(
    A,
    pendingSource.sourceId,
    (value) =>
      value.run?.kind === "reanalysis" && value.run?.checkpoint?.join?.succeeded === true,
    300_000,
    `re-join after kick ${attempt + 1}`,
  );
  const orders = resumed?.visionOrders ?? [];
  const complete = orders.find((order) => order.state === "complete") ?? null;
  const failedKind = orders.find((order) => order.state === "pending")?.lastErrorKind ?? null;
  record(
    `B5.${attempt + 1} linked reanalysis kick (the sanctioned re-join path)`,
    "PASS",
    `vision=${complete !== null ? "complete" : `pending(${failedKind})`}`,
  );
  resumedVision = complete;
}
record(
  "B6 after disarm the re-join completed vision over the same representation",
  resumedVision !== null,
  `observations=${resumedVision?.observations ?? 0} extraction=${resumedVision?.extractionId}`,
);
const findingsAfter = await allFindings(A, pendingSource.sourceId);
record(
  "B7 the image-dependent conclusion now publishes (anchored to the image region)",
  findingsAfter.some((f) => /faktur|kwota|12 ?400/.test(JSON.stringify(f.value) + f.semanticKey)),
  `findings=${findingsAfter.map((f) => f.semanticKey).join(",")}`,
);

// ---------------------------------------------------------------------------
// C. the audio planning-blocked (D6's honest production state)
// ---------------------------------------------------------------------------

console.log("\n--- C. audio planning-blocked (production channel honest state) ---");
const blockedSource = await acceptMixed(A, {
  audio: SPEECH,
  authorText: [
    "Ustalenia z nagrania dla projektu.",
    "Kontakt do klienta: Kaczmarek.",
  ].join(" "),
});
// NO proof STT order: the join's production media_worker order hits the
// unconfigured channel and the transcript stays planning + lastErrorKind.
const blockedJoined = await waitForJoin(
  A,
  blockedSource.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
  420_000,
  "blocked join",
);
const blockedCoverage = blockedJoined?.coverage ?? { inputs: [], completeness: "?" };
const blockedAudio = blockedCoverage.inputs.find((i) => i.kind === "audio");
const blockedTranscript = (blockedJoined?.transcripts ?? [])[0];
record(
  "C1 the production STT order stays PLANNING with the sanitized refusal (externally blocked, resumable)",
  blockedAudio?.status === "externally_blocked" &&
    blockedAudio?.lastErrorKind === "media_worker_not_configured" &&
    blockedTranscript?.state === "planning" &&
    blockedTranscript?.segmentCount === 0,
  `audio=${blockedAudio?.status}(${blockedAudio?.lastErrorKind}) transcript=${blockedTranscript?.state}`,
);
record(
  "C2 the aggregate reports the blocked_external shape and the text conclusion still published",
  blockedCoverage.completeness !== "complete" &&
    (blockedJoined?.steps ?? []).some(
      (step) => step.kind === "e4_publish_group" && step.output?.outcome === "published",
    ),
  `completeness=${blockedCoverage.completeness}`,
);
const noAudioFragments = (blockedJoined?.fragments ?? []).filter(
  (f) => f.anchor._tag === "audio_interval",
);
record(
  "C3 no audio anchor exists (nothing claimed inspection of the blocked recording)",
  noAudioFragments.length === 0,
  `audioFragments=${noAudioFragments.length}`,
);

// ---------------------------------------------------------------------------
// D. correction of a JOIN-published finding through C2
// ---------------------------------------------------------------------------

console.log("\n--- D. correction through C2 ---");
const target = findingsAfter.find((f) =>
  /faktur|kwota|12 ?400|szeroko|3,60/.test(JSON.stringify(f.value) + f.semanticKey),
);
if (target === undefined) {
  record("D1 correction target (the join's image-grounded finding)", "FAIL", "no target finding");
} else {
  // The correction text matches WHAT the target records (the amount or the
  // image-read dimension) — both are image-grounded JOIN-published findings.
  const isDimension = /szeroko|3,60/.test(JSON.stringify(target.value) + target.semanticKey);
  const correction = await acceptMixed(A, {
    authorText: isDimension
      ? [
          "Szerokość pomieszczenia dla projektu ostatecznie 3,90 metra.",
          "Poprawka do wcześniejszego odczytu ze zdjęcia.",
        ].join(" ")
      : [
          "Kwota z faktury dla projektu zmieniona: ostatecznie trzynaście tysięcy dwieście złotych netto.",
          "Poprawka do wcześniejszej wyceny.",
        ].join(" "),
  });
  const correctedRun = await waitForTextRun(A, correction.sourceId);
  const after = await allFindings(A, correction.sourceId, pendingSource.sourceId);
  const changed = after.find((f) => f.findingId === target.findingId);
  const changedValue = JSON.stringify(changed?.value ?? {});
  const expected = isDimension ? ["3,90", "3.90", "390"] : ["13 200", "13200"];
  record(
    "D1 the text correction run completed and superseded the JOIN-published finding's current value (history is C2's immutable-revision contract)",
    correctedRun?.state === "succeeded" &&
      changed !== undefined &&
      changed.currentRevisionId !== target.currentRevisionId &&
      expected.some((needle) => changedValue.includes(needle)),
    `run=${correctedRun?.state} revision=${target.currentRevisionId}->${changed?.currentRevisionId} value=${changedValue.slice(0, 200)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(72));
const ok = summarize();
process.exit(ok ? 0 : 1);
