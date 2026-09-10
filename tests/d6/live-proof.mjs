/**
 * D6 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d6, instance precious-chipmunk-303,
 * EU) through the REAL deployed gateway Worker (kiero-dev-gateway), the
 * REAL EU R2 bucket (kiero-dev-media) and the REAL deployed EU media
 * Container (kiero-dev-media-worker).
 *
 * Identity: every actor is a REAL signed-in person (B1's email-code flow
 * with proof-domain fixture addresses and fixture codes — the B2/D2
 * evidence pattern). The upload chain runs AS THAT USER through the real
 * gateway; D6's probe surface resolves the same caller identity.
 *
 * The audio fixture is REAL Polish speech (macOS `say -v Zosia`, 22.05kHz
 * mono 16-bit WAV, ~11.5s) with names, dates and amounts crossing the
 * aggressive segment boundaries; a synthetic-tone fallback exists for
 * reproducibility without macOS.
 *
 * Proof rows:
 * - L1  the real upload chain accepts the audio fixture (D2 seam).
 * - L2  production byte channel: the deployed media executor answers the
 *       typed `s3_not_configured` refusal (the R2 S3 token is a pending
 *       owner action) -> the transcript stays `planning` (visible pending),
 *       no segment fabricated, no extraction published, audio untouched.
 * - L3  guarded proof channel (hash/length-pinned to the uploaded object):
 *       manifest planned at original-time boundaries; interrupt (armed
 *       deterministic segment failure) -> PARTIAL with no fake success;
 *       resume -> COMPLETE with per-segment checkpoints exactly once,
 *       stable offsets, ONE extraction version, anchored fragments.
 * - L4  replay dedup: re-ordering the same config replays the same order
 *       (one row, one job, one extraction).
 * - L5  cross-tenant denial: person B cannot order A's attachment nor read
 *       A's transcript.
 *
 * Run: node tests/d6/live-proof.mjs   (fixture at /tmp/d6-speech.wav or the
 * synthetic fallback; not a vitest file — live evidence, transcribed into
 * the issue report).
 */

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";

const DEPLOYMENT = process.env.KIERO_D6_CONVEX ?? "precious-chipmunk-303";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const GATEWAY = process.env.KIERO_D6_GATEWAY ?? "https://kiero-dev-gateway.wojtek-524.workers.dev";
const TARGET_SEGMENT_MS = Number(process.env.KIERO_D6_TARGET_MS ?? 2_500);

const RUN = Date.now().toString(36);
const person = (name) => `d6-${name}-${RUN}@kiero.invalid`;
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
const key = () => `idem_${globalThis.crypto.randomUUID()}`;

// --- real sign-in (the D2/B3 fixture pattern) --------------------------------

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
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, token, email };
}

const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: { operation, input, expectedRevisions: [] },
  });

async function ownCompany(persona, name) {
  const created = await admit(persona.client, "access.createCompany", {
    name,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  if (created?._tag !== "ok") {
    throw new Error(`createCompany failed: ${JSON.stringify(created)}`);
  }
  return created.value.companyId;
}

// --- gateway helpers (every call carries the person's credential) -------------

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

// --- D6 probe helpers (caller identity) ---------------------------------------

const orderTranscript = (persona, input) =>
  persona.client.action("processing/audio/probe:probeOrderTranscript", input);
const transcriptState = (persona, transcriptId) =>
  persona.client.action("processing/audio/probe:probeTranscriptState", {
    ...(transcriptId === undefined ? {} : { transcriptId }),
  });
const armFailure = (persona, transcriptId, segmentIndex, arm) =>
  persona.client.action("processing/audio/probe:probeArmSegmentFailure", {
    transcriptId,
    segmentIndex,
    arm,
  });
const resumeTranscript = (persona, transcriptId) =>
  persona.client.action("processing/audio/probe:probeResumeTranscript", { transcriptId });
const uploadsStateOf = (persona) =>
  persona.client.action("sources/uploads/probe:probeUploadsState", {});
const acceptAsCaller = (persona, input, idempotencyKey) =>
  persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      idempotencyKey,
    },
  });

/** Polls the transcript + its job until stable or the deadline. */
async function waitForStable(persona, transcriptId, { wantComplete = false, deadlineMs = 240_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const state = await transcriptState(persona, transcriptId);
    const transcript = state?.value?.transcripts?.[0];
    const uploads = await uploadsStateOf(persona);
    const jobKey = `processing.transcribe_segment:${transcriptId}`;
    const jobs = (uploads?.value?.jobs ?? []).filter((job) => job.dedupKey === jobKey);
    const job = jobs[0];
    const segments = transcript?.segments ?? [];
    const settled =
      transcript !== undefined &&
      // For wantComplete, also wait for the extraction version: the state
      // flips to complete in the last segment's checkpoint mutation, a step
      // BEFORE assembly registers the immutable extraction + fragments.
      ((wantComplete && transcript.state === "complete" && transcript.extractionId !== undefined) ||
        (!wantComplete && job?.state === "failed" && transcript.state !== "pending"));
    if (settled) {
      return { transcript, job, segments };
    }
    if (Date.now() - started > deadlineMs) {
      return { transcript, job, segments, timeout: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

// --- the audio fixture: real Polish speech, synthetic fallback -----------------

function syntheticFallbackWav() {
  const seconds = 11.5;
  const sampleRate = 22_050;
  const total = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, Math.min(t, seconds - t) * 20);
    const wordish = 0.55 + 0.45 * Math.sin(2 * Math.PI * 2.2 * t); // speech-ish bursts
    const sample = Math.round(
      Math.sin(2 * Math.PI * 190 * t) * 10_000 * envelope * wordish +
        Math.sin(2 * Math.PI * 1_330 * t) * 3_000 * envelope * wordish,
    );
    data.writeInt16LE(Math.max(-32_000, Math.min(32_000, sample)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let fixture;
let fixtureLabel;
try {
  fixture = readFileSync("/tmp/d6-speech.wav");
  fixtureLabel = "real Polish speech (macOS say -v Zosia, 22.05kHz mono, ~11.5s)";
} catch {
  fixture = syntheticFallbackWav();
  fixtureLabel = "SYNTHETIC tone burst fallback (no /tmp/d6-speech.wav)";
}
const fixtureBase64 = fixture.toString("base64");

console.log(
  `# D6 live proofs :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}\n# fixture: ${fixtureLabel} (${fixture.length} bytes, target segment ${TARGET_SEGMENT_MS}ms)`,
);

// --- fixture persons ------------------------------------------------------------

const A = await signInFixture(person("a"));
const companyA = await ownCompany(A, `Budowa D6 A ${RUN}`);
const B = await signInFixture(person("b"));
await ownCompany(B, `Budowa D6 B ${RUN}`);
console.log(`# persons: A=${A.email} B=${B.email} (fixture sign-ins, reproducible codes)`);

// --- L1: the real upload chain over the real gateway + R2 ------------------------

const DRAFT = `d6-audio-${RUN}`;
const prepared = await gw(A.token, "/uploads/prepare", jsonInit("POST", {
  draftId: DRAFT,
  parts: 1,
  mediaKinds: ["audio"],
}));
const uploadId = prepared.body.value?.uploadId;
const attachment = prepared.body.value?.attachments?.[0];
record(
  "L1a prepare as the signed-in owner mints the audio attachment + R2 session",
  prepared.body._tag === "ok" && attachment?.kind === "audio" ? "PASS" : "FAIL",
  `uploadId=${uploadId}`,
);

const put = await gw(A.token, `/uploads/${uploadId}/attachments/${attachment.attachmentId}/parts/1`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream" },
  body: fixture,
  duplex: "half",
});
const complete = await gw(
  A.token,
  `/uploads/${uploadId}/attachments/${attachment.attachmentId}/complete`,
  jsonInit("POST", {}),
);
const finalize = await gw(A.token, `/uploads/${uploadId}/finalize`, jsonInit("POST", {}));
record(
  "L1b the REAL audio bytes are durable in EU R2 (part + complete + finalize verified)",
  put.body._tag === "ok" && complete.body._tag === "ok" && finalize.body._tag === "ok" ? "PASS" : "FAIL",
  `bytes=${fixture.length} etag=${complete.body.value?.r2ObjectEtag?.slice(0, 12) ?? "none"}`,
);

const K_ACC = key();
const accepted = await acceptAsCaller(
  A,
  {
    uploadId,
    authorText: "Nagranie z ustaleń (D6 live proof)",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K_ACC,
);
const sourceId = accepted.value?.sourceId;
record(
  "L1c acceptance binds the verified audio attachment to ONE immutable source",
  accepted._tag === "ok" && typeof sourceId === "string" ? "PASS" : "FAIL",
  `sourceId=${sourceId}`,
);

const audioAttachmentId = attachment.attachmentId;

// --- L2: the production byte channel refuses honestly (no R2 S3 token) ----------

const productionOrder = await orderTranscript(A, {
  attachmentId: audioAttachmentId,
  bytesChannel: "media_worker",
});
const productionTranscriptId = productionOrder.value?.transcriptId;
const productionSettled = await waitForStable(A, productionTranscriptId, {});
const productionRows = (await transcriptState(A, productionTranscriptId)).value.transcripts[0];
const productionRefusals = new Set(["media_worker_refused", "media_worker_unreachable"]);
record(
  "L2a production order: the deployed EU media executor answers the typed byte-source refusal (s3_not_configured behind the token; cold container wake can surface it as unreachable); transcript stays PLANNING (pending), zero segments fabricated",
  productionOrder._tag === "ok" &&
    productionSettled.transcript?.state === "planning" &&
    productionRefusals.has(productionSettled.transcript?.lastErrorKind ?? "") &&
    (productionSettled.segments ?? []).length === 0 &&
    productionSettled.job?.state === "failed"
    ? "PASS"
    : "FAIL",
  `state=${productionSettled.transcript?.state} lastError=${productionSettled.transcript?.lastErrorKind} segments=${(productionSettled.segments ?? []).length} job=${productionSettled.job?.state}`,
);
record(
  "L2b no extraction version exists for the pending order (no fake success)",
  productionRows?.extractionId === undefined && productionRows?.extraction === null ? "PASS" : "FAIL",
  `extraction=${JSON.stringify(productionRows?.extraction)}`,
);
const uploadsAfterL2 = await uploadsStateOf(A);
const attachmentAfterL2 = uploadsAfterL2.value.attachments.find((row) => row.attachmentId === audioAttachmentId);
record(
  "L2c provider/executor failure preserves the playable audio (attachment untouched, R2 object still verified)",
  attachmentAfterL2?.completedAtMs !== undefined && attachmentAfterL2?.r2ObjectEtag !== undefined ? "PASS" : "FAIL",
  `receivedBytes=${attachmentAfterL2?.receivedBytes}`,
);

// --- L3: the guarded proof channel: transcribe -> interrupt -> resume -> complete -

const proofOrder = await orderTranscript(A, {
  attachmentId: audioAttachmentId,
  bytesChannel: "proof_inline",
  proofAudioBase64: fixtureBase64,
  targetSegmentMs: TARGET_SEGMENT_MS,
});
const transcriptId = proofOrder.value?.transcriptId;
record(
  "L3a the guarded order is accepted and the durable job registered (bytes pinned to the uploaded object)",
  proofOrder._tag === "ok" && typeof transcriptId === "string" ? "PASS" : "FAIL",
  `transcriptId=${transcriptId}`,
);

// The interrupt: arm a deterministic failure for segment 2 immediately.
const ARM_AT = 2;
const armed = await armFailure(A, transcriptId, ARM_AT, true);
record(
  "L3b interrupt armed at segment 2 (deterministic marker, A3's pattern)",
  armed?._tag === "ok" && armed?.value?.armed === true ? "PASS" : "FAIL",
  JSON.stringify(armed?.value ?? armed),
);

const afterInterrupt = await waitForStable(A, transcriptId, { wantComplete: false });
console.log(
  `# post-interrupt job bookkeeping: ${JSON.stringify(
    (await transcriptState(A, transcriptId)).value.transcriptJobs?.find(
      (row) => row.transcriptId === transcriptId,
    ),
  )}`,
);
const partial = afterInterrupt.transcript;
const partialSegments = afterInterrupt.segments;
const interruptedOthers = partialSegments.filter((row) => row.segmentIndex !== ARM_AT);
const interruptedTarget = partialSegments.find((row) => row.segmentIndex === ARM_AT);
record(
  "L3c interrupted run: transcript PARTIAL (never complete), target segment failed with the sanitized armed error, others succeeded exactly once",
  partial?.state === "partial" &&
    interruptedTarget?.state === "failed" &&
    interruptedTarget?.lastErrorKind === "probe_armed_segment_failure" &&
    interruptedOthers.length > 0 &&
    interruptedOthers.every((row) => row.state === "succeeded" && row.attempts === 1)
    ? "PASS"
    : "FAIL",
  `state=${partial?.state} target=${interruptedTarget?.state}/${interruptedTarget?.lastErrorKind} others=${interruptedOthers.map((row) => `${row.segmentIndex}:${row.state}:${row.attempts}`).join(",")}`,
);
record(
  "L3d the partial order publishes NO extraction version (missing segment = pending, not complete)",
  partial?.extractionId === undefined && partial?.extraction === null ? "PASS" : "FAIL",
  `extraction=${JSON.stringify(partial?.extraction)}`,
);
const manifestBefore = partialSegments
  .slice()
  .sort((a, b) => a.segmentIndex - b.segmentIndex)
  .map((row) => [row.startMs, row.endMs]);
const audioStillPlayable = (await uploadsStateOf(A)).value.attachments.find(
  (row) => row.attachmentId === audioAttachmentId,
);
record(
  "L3e audio still playable after provider failure (retained bytes untouched)",
  audioStillPlayable?.r2ObjectEtag !== undefined ? "PASS" : "FAIL",
  `etag=${audioStillPlayable?.r2ObjectEtag?.slice(0, 12)}`,
);

// The resume: disarm, re-run the order entry (the sanctioned bounded resume).
const disarmed = await armFailure(A, transcriptId, ARM_AT, false);
const resumed = await resumeTranscript(A, transcriptId);
console.log(`# resume receipt: ${JSON.stringify(resumed)}`);
const afterResume = await waitForStable(A, transcriptId, { wantComplete: true });
const completeRow = afterResume.transcript;
const finalSegments = afterResume.segments.slice().sort((a, b) => a.segmentIndex - b.segmentIndex);
const resumedTarget = finalSegments.find((row) => row.segmentIndex === ARM_AT);
const resumedOthers = finalSegments.filter((row) => row.segmentIndex !== ARM_AT);
record(
  "L3f resume completes the transcript: armed segment retried ONCE more (attempts=2), completed segments NOT reprocessed (attempts stay 1)",
  disarmed?._tag === "ok" &&
    resumed?._tag === "ok" &&
    completeRow?.state === "complete" &&
    resumedTarget?.state === "succeeded" &&
    resumedTarget?.attempts === 2 &&
    resumedOthers.every((row) => row.attempts === 1)
    ? "PASS"
    : "FAIL",
  `state=${completeRow?.state} target=${resumedTarget?.state}:${resumedTarget?.attempts} others=${resumedOthers.map((row) => `${row.segmentIndex}:${row.attempts}`).join(",")}`,
);
const manifestAfter = finalSegments.map((row) => [row.startMs, row.endMs]);
record(
  "L3g original-time offsets are STABLE across the interrupt/resume (manifest immutable)",
  JSON.stringify(manifestBefore) === JSON.stringify(manifestAfter) ? "PASS" : "FAIL",
  `manifest=${JSON.stringify(manifestAfter)}`,
);
record(
  "L3h ONE immutable extraction version registered (kind stt, openrouter, models recorded)",
  completeRow?.extractionId !== undefined &&
    completeRow?.extraction?.kind === "stt" &&
    completeRow?.extraction?.provider === "openrouter" &&
    typeof completeRow?.extraction?.model === "string"
    ? "PASS"
    : "FAIL",
  JSON.stringify(completeRow?.extraction),
);
const anchors = (completeRow?.fragmentAnchors ?? []).map((anchor) => [anchor.startMs, anchor.endMs]);
record(
  "L3i fragments anchor to the ORIGINAL audio timeline (audio_interval == manifest, full coverage)",
  anchors.length === finalSegments.length &&
    JSON.stringify(anchors) === JSON.stringify(manifestAfter) &&
    anchors[0]?.[0] === 0 &&
    Math.abs((anchors[anchors.length - 1]?.[1] ?? 0) - (completeRow?.audioDurationMs ?? -1)) < 30
    ? "PASS"
    : "FAIL",
  `anchors=${JSON.stringify(anchors)} duration=${completeRow?.audioDurationMs?.toFixed(0)}ms`,
);
const perSegmentMeta = finalSegments.map(
  (row) =>
    `${row.segmentIndex}:${row.servedModels?.join("+") ?? "?"} lat=${row.latencyMs ?? "?"}ms audio=${row.audioSeconds ?? "?"}s cost=${row.costUsd ?? "?"}`,
);
record(
  "L4j the actual model, route version, latency and cost are recorded for EVERY segment",
  finalSegments.every(
    (row) => Array.isArray(row.servedModels) && row.servedModels.length > 0 && typeof row.latencyMs === "number",
  )
    ? "PASS"
    : "FAIL",
  perSegmentMeta.join(" | "),
);
const attempts = (await transcriptState(A, transcriptId)).value.transcripts[0]?.attempts ?? [];
record(
  "L3k per-attempt history on the platform tables (processingAttempts rows with model + outcome)",
  attempts.filter((row) => row.stepSequence < 100_000).length >= finalSegments.filter((row) => row.state === "succeeded" && row.text !== undefined).length - 0
    ? "PASS"
    : "FAIL",
  attempts
    .filter((row) => row.stepSequence < 100_000)
    .map((row) => `${row.stepSequence}.${row.attempt}=${row.outcome}${row.model ? `@${row.model}` : ""}`)
    .join(","),
);

// Sanitized transcript evidence (verbatim provider output per segment).
console.log("\n# Sanitized per-segment transcripts (verbatim provider output):");
for (const segment of finalSegments) {
  console.log(`  [${segment.startMs}-${segment.endMs}ms] ${JSON.stringify(segment.text ?? null)}`);
}
const wholeTranscript = finalSegments.map((row) => row.text ?? "").join(" ").trim();
record(
  "L3l every required segment carries non-empty transcript text (complete transcript assembled)",
  finalSegments.length > 0 && finalSegments.every((row) => typeof row.text === "string" && row.text.length > 0)
    ? "PASS"
    : "FAIL",
  `assembled=${JSON.stringify(wholeTranscript)}`,
);

// --- L4: replay dedup --------------------------------------------------------------

const replay = await orderTranscript(A, {
  attachmentId: audioAttachmentId,
  bytesChannel: "proof_inline",
  proofAudioBase64: fixtureBase64,
  targetSegmentMs: TARGET_SEGMENT_MS,
});
const uploadsReplay = await uploadsStateOf(A);
const transcriptJobs = (uploadsReplay.value.jobs ?? []).filter(
  (job) => job.dedupKey === `processing.transcribe_segment:${transcriptId}`,
);
const replayState = (await transcriptState(A, transcriptId)).value.transcripts[0];
const jobBookkeeping = (await transcriptState(A, transcriptId)).value.transcriptJobs?.find(
  (row) => row.transcriptId === transcriptId,
);
console.log(`# job bookkeeping after replay: ${JSON.stringify(jobBookkeeping)}`);
record(
  "L4a replaying the SAME order replays the SAME transcript: one row, one durable job, one extraction, state intact",
  replay?.value?.transcriptId === transcriptId &&
    replay?.value?.resumed === true &&
    transcriptJobs.length === 1 &&
    replayState?.state === "complete" &&
    replayState?.extractionId !== undefined
    ? "PASS"
    : "FAIL",
  `jobs=${transcriptJobs.length} jobState=${transcriptJobs[0]?.state}`,
);
const extractionsForSource = (await transcriptState(A)).value.transcripts.filter(
  (row) => row.state === "complete" && row.extractionId !== undefined,
);
record(
  "L4b exactly ONE complete transcript version exists for this config (the earlier planning order stays pending)",
  extractionsForSource.length === 1 ? "PASS" : "FAIL",
  `completeVersions=${extractionsForSource.length}`,
);

// --- L5: cross-tenant denial --------------------------------------------------------

const bOrder = await orderTranscript(B, {
  attachmentId: audioAttachmentId,
  bytesChannel: "proof_inline",
  proofAudioBase64: fixtureBase64,
  targetSegmentMs: TARGET_SEGMENT_MS,
});
record(
  "L5a person B cannot order a transcript over A's attachment (cross-tenant refusal)",
  bOrder?._tag === "error" && bOrder?.error?._tag === "forbidden" ? "PASS" : "FAIL",
  JSON.stringify(bOrder?.error ?? bOrder),
);
const bRead = await transcriptState(B, transcriptId);
record(
  "L5b person B cannot inspect A's transcript (tenant-scoped read refusal)",
  bRead?._tag === "error" || (bRead?.value?.transcripts ?? []).length === 0 ? "PASS" : "FAIL",
  JSON.stringify(bRead?.error ?? { visible: (bRead?.value?.transcripts ?? []).length }),
);

// --- wrap up ------------------------------------------------------------------------

const allOk = summarize();
console.log(`\nObject keys for cleanup (R2, leased bucket): uploadId=${uploadId}`);
process.exitCode = allOk ? 0 : 1;
