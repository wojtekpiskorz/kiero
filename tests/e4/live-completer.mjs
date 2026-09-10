/**
 * The E4 live-proof completer: finishes the mixed-source evidence against
 * the EXISTING run-15 state with GENEROUS waits (today's GLM latencies run
 * chat turns 50-113s, so the main script's deadlines expire while the
 * workflows still complete afterward — the semantics hold; this completer
 * waits them out and drives the sanctioned resumable paths to their
 * positive ends):
 *
 * 1. scenario A's source: kick linked reanalyses (bounded) until the vision
 *    proof order completes (GLM structured vision output is intermittently
 *    rejected through OpenRouter — each join run retries the pending order
 *    once, exactly the designed resumable semantics), then assert the
 *    joined publication with findings anchored to EVERY modality.
 * 2. scenario B's source: assert the post-disarm re-join completed vision
 *    and published the image-dependent finding.
 * 3. scenario C's source: wait out the (slow) join and assert the text
 *    conclusion published over the blocked audio.
 * 4. the correction through C2 over the image-grounded finding.
 *
 * Run: node tests/e4/live-completer.mjs
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = "necessary-weasel-284";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const PERSON = "e4-a-mtv8c2yi@kiero.invalid"; // run 15's proof person

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const codeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

const boot = new ConvexHttpClient(CLIENT_URL, { logger: false });
try {
  await boot.action("auth:signIn", { provider: "email_code", params: { email: PERSON } });
} catch {}
await boot.action("access/identity/probe:b1ProofSetCode", { email: PERSON, code: codeOf(PERSON) });
const signIn = await boot.action("auth:signIn", {
  provider: "email_code",
  params: { email: PERSON, code: codeOf(PERSON) },
});
const token = signIn?.tokens?.token;
if (typeof token !== "string") throw new Error("sign-in failed");
const A = new ConvexHttpClient(CLIENT_URL, { logger: false, auth: token });
await A.mutation("access/identity/functions:ensureSessionRegistry", {});

const joinState = (sourceId) => A.action("processing/multimodal/probe:probeJoinState", { sourceId });
const kickReanalysis = (sourceId) =>
  A.action("processing/text/probe:probeKickReanalysis", { sourceId });
const armVision = (sourceId, arm) =>
  A.action("processing/multimodal/probe:probeArmVisionUnavailable", { sourceId, arm });
const memoryRead = () =>
  A.action("memory/findings/probe:probeMemoryCommand", {
    envelope: {
      operation: "memory.readCurrentFindings",
      input: { scope: { _tag: "company" } },
      expectedRevisions: [],
    },
  });
const acceptText = (authorText) =>
  A.action("sources/uploads/probe:probeSeedE3Upload", { sessionId: "seed" }).then(() => null).catch(() => null);

// The person's sources, newest last: mixed (A), image (B), audio (C) — from run 15.
const uploads = await A.action("sources/uploads/probe:probeUploadsState", {});
const sources = (uploads?.value?.sources ?? []).slice(-3);
const [sourceA, sourceB, sourceC] = sources;
console.log(
  `# completer :: ${new Date().toISOString()}\n# sources: A=${sourceA?.sourceId} B=${sourceB?.sourceId} C=${sourceC?.sourceId}`,
);
if (!sourceA || !sourceB || !sourceC) {
  throw new Error("expected three accepted sources from run 15");
}

/** Waits for the LATEST run's join record with a generous deadline. */
async function waitJoined(sourceId, predicate, deadlineMs, label) {
  const started = Date.now();
  for (;;) {
    const state = await joinState(sourceId);
    const value = state?._tag === "ok" ? state.value : null;
    if (value !== null && predicate(value)) return value;
    if (Date.now() - started > deadlineMs) {
      console.log(`[wait] ${label} still pending after ${Math.round((Date.now() - started) / 1000)}s`);
      return value;
    }
    await sleep(8_000);
  }
}

// ---------------------------------------------------------------------------
// A: drive the vision order to completion through bounded reanalysis kicks.
// ---------------------------------------------------------------------------

console.log("\n--- A completer: vision completion through the resumable path ---");
let visionDone = false;
let kicks = 0;
for (let attempt = 0; attempt < 4 && !visionDone; attempt += 1) {
  const state = await joinState(sourceA.sourceId);
  const order = (state?.value?.visionOrders ?? []).find((o) => o.bytesChannel === "proof_inline");
  if (order?.state === "complete") {
    visionDone = true;
    break;
  }
  if (attempt > 0 || order?.state !== "complete") {
    kicks += 1;
    await kickReanalysis(sourceA.sourceId);
  }
  const done = await waitJoined(
    sourceA.sourceId,
    (value) =>
      (value.visionOrders ?? []).some((o) => o.bytesChannel === "proof_inline" && o.state === "complete"),
    9 * 60_000,
    `A vision (kick ${kicks})`,
  );
  visionDone = (done?.visionOrders ?? []).some(
    (o) => o.bytesChannel === "proof_inline" && o.state === "complete",
  );
}
record(
  "A-c1 the vision proof order completed through the resumable re-join path",
  visionDone,
  `kicks=${kicks}`,
);
const stateA = await waitJoined(
  sourceA.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
  9 * 60_000,
  "A join completion",
);
const stepsA = (stateA?.steps ?? []).filter((s) => s.kind === "e4_publish_group");
record(
  "A-c2 the joined analysis published its bounded groups",
  stepsA.some((s) => s.output?.outcome === "published"),
  `outcomes=${stepsA.map((s) => s.output?.outcome).join(",")}`,
);
const coverageA = stateA?.coverage ?? { inputs: [], completeness: "?" };
record(
  "A-c3 every input COMPLETE (text + audio + image)",
  coverageA.completeness === "complete",
  `inputs=${coverageA.inputs.map((i) => `${i.kind}:${i.status}`).join(", ")}`,
);
const fragmentsA = stateA?.fragments ?? [];
const imageRegions = fragmentsA.filter((f) => f.anchor._tag === "image_region");
const audioIntervals = fragmentsA.filter((f) => f.anchor._tag === "audio_interval");
const textRanges = fragmentsA.filter((f) => f.anchor._tag === "text_range");
record(
  "A-c4 findings anchored to EVERY modality (text_range + audio_interval + image_region)",
  imageRegions.length > 0 && audioIntervals.length > 0 && textRanges.length > 0,
  `text=${textRanges.length} audio=${audioIntervals.length} image=${imageRegions.length}`,
);
const visionExtractionA = (stateA?.extractions ?? []).find((row) => row.kind === "vision");
record(
  "A-c5 the vision extraction version pins the exact representationId",
  visionExtractionA !== undefined && visionExtractionA.representationId !== null,
  `extraction=${visionExtractionA?.extractionId} rep=${visionExtractionA?.representationId}`,
);
const findingsA = (await memoryRead())?.value ?? [];
record(
  "A-c6 the image amount appears as a typed finding",
  findingsA.some((f) => /12 ?400/.test(JSON.stringify(f.value))),
  `findings=${findingsA.map((f) => f.semanticKey).join(",")}`,
);
const imageAnchoredFindings = findingsA.filter((f) => f.semanticKey);
console.log(
  `# A findings: ${findingsA.map((f) => `${f.semanticKey}=${JSON.stringify(f.value)}`).join(" | ")}`,
);

// ---------------------------------------------------------------------------
// B: the post-disarm re-join (kick from run 15) — vision + publication.
// ---------------------------------------------------------------------------

console.log("\n--- B completer: post-disarm re-join ---");
await armVision(sourceB.sourceId, false);
let visionDoneB = false;
let kicksB = 0;
for (let attempt = 0; attempt < 3 && !visionDoneB; attempt += 1) {
  const state = await joinState(sourceB.sourceId);
  const order = (state?.visionOrders ?? []).find((o) => o.bytesChannel === "proof_inline");
  if (order?.state === "complete") {
    visionDoneB = true;
    break;
  }
  kicksB += 1;
  await kickReanalysis(sourceB.sourceId);
  const done = await waitJoined(
    sourceB.sourceId,
    (value) =>
      (value.visionOrders ?? []).some((o) => o.bytesChannel === "proof_inline" && o.state === "complete"),
    9 * 60_000,
    `B vision (kick ${kicksB})`,
  );
  visionDoneB = (done?.visionOrders ?? []).some(
    (o) => o.bytesChannel === "proof_inline" && o.state === "complete",
  );
}
record("B-c1 after disarm the re-join completed vision (resumable path)", visionDoneB, `kicks=${kicksB}`);
const stateB = await waitJoined(
  sourceB.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
  9 * 60_000,
  "B join completion",
);
const stepsB = (stateB?.steps ?? []).filter((s) => s.kind === "e4_publish_group");
record(
  "B-c2 the re-join published (the image-dependent conclusion lands late but sound)",
  stepsB.some((s) => s.output?.outcome === "published"),
  `outcomes=${stepsB.map((s) => s.output?.outcome).join(",")}`,
);
const imageRegionsB = (stateB?.fragments ?? []).filter((f) => f.anchor._tag === "image_region");
record(
  "B-c3 the late conclusion carries image-region anchors",
  imageRegionsB.length > 0,
  `imageFragments=${imageRegionsB.length}`,
);

// ---------------------------------------------------------------------------
// C: wait out the slow join over the blocked audio.
// ---------------------------------------------------------------------------

console.log("\n--- C completer: the blocked-audio join completes partial-safe ---");
const stateC = await waitJoined(
  sourceC.sourceId,
  (value) => value.run?.checkpoint?.join?.succeeded === true,
  9 * 60_000,
  "C join completion",
);
const stepsC = (stateC?.steps ?? []).filter((s) => s.kind === "e4_publish_group");
const blockedAudioC = (stateC?.coverage ?? { inputs: [] }).inputs.find((i) => i.kind === "audio");
record(
  "C-c1 the text conclusion published over the externally blocked audio",
  stepsC.some((s) => s.output?.outcome === "published") &&
    blockedAudioC?.status === "externally_blocked",
  `audio=${blockedAudioC?.status}(${blockedAudioC?.lastErrorKind}) outcomes=${stepsC.map((s) => s.output?.outcome).join(",")}`,
);

// ---------------------------------------------------------------------------
// D: correction of the JOIN-published image finding through C2.
// ---------------------------------------------------------------------------

console.log("\n--- D completer: correction through C2 ---");
const GATEWAY = "https://kiero-dev-gateway-e4.wojtek-524.workers.dev";
const target = (await memoryRead())?.value?.find((f) => /12 ?400/.test(JSON.stringify(f.value)));
if (target === undefined) {
  record("D-c1 correction target (the join's image-grounded finding)", "FAIL", "no target finding");
} else {
  // A text-only correction source: a fresh EMPTY upload (no attachments)
  // accepted as the person, through the same checked acceptance path.
  const prep = await fetch(`${GATEWAY}/uploads/prepare`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ draftId: `e4-corr-${Date.now()}`, parts: 1, mediaKinds: [] }),
  });
  const prepBody = await prep.json();
  const uploadId = prepBody?.value?.uploadId;
  const fin = await fetch(`${GATEWAY}/uploads/${uploadId}/finalize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const accepted = await A.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input: {
        uploadId,
        authorText:
          "Kwota z faktury dla projektu zmieniona: ostatecznie trzynaście tysięcy dwieście złotych netto. Poprawka do wcześniejszej wyceny.",
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      expectedRevisions: [],
      idempotencyKey: `idem_corr_${globalThis.crypto.randomUUID()}`,
    },
  });
  const correctionSourceId = accepted?.value?.sourceId;
  console.log(`# correction source: ${correctionSourceId} (finalize ok: ${fin.ok})`);
  // Text-only source: E3's analyze owns it; wait for its run.
  const startedD = Date.now();
  let runState = null;
  for (;;) {
    const run = await A.action("processing/text/probe:probeLatestRunForSource", {
      sourceId: correctionSourceId,
    });
    if (run?._tag === "ok" && run.value.state !== "running") {
      runState = run.value.state;
      break;
    }
    if (Date.now() - startedD > 8 * 60_000) break;
    await sleep(8_000);
  }
  const after = (await memoryRead())?.value ?? [];
  const changed = after.find((f) => f.findingId === target.findingId);
  const changedValue = JSON.stringify(changed?.value ?? {});
  record(
    "D-c1 the text correction superseded the JOIN-published finding's current value (C2's immutable-revision history)",
    runState === "succeeded" &&
      changed !== undefined &&
      changed.currentRevisionId !== target.currentRevisionId &&
      /13 ?200/.test(changedValue),
    `run=${runState} revision=${target.currentRevisionId}->${changed?.currentRevisionId} value=${changedValue.slice(0, 140)}`,
  );
}

console.log("\n" + "=".repeat(72));
summarize();
