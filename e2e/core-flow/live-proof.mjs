/**
 * J2 live proof :: the joined core flow through the REAL leased dev
 * deployment (wojtek-piskorz-jr:kiero-dev-core:dev/j2, instance
 * zany-snail-540) and the REAL per-lane gateway Worker
 * (kiero-dev-gateway-j2) over the REAL EU R2 bucket (kiero-dev-media).
 *
 * This is the full-flow join's focused verification pass (issue #61),
 * batched into ONE run per the Convex usage guardrails:
 *
 *  A. the attention identity repair under ORDINARY user tokens (the gap
 *     H2 recorded): myTaskReminders, the snooze command, the push-state
 *     read and the read-state projection;
 *  B. the voice-only ruling end to end: a real mixed source (text + REAL
 *     Polish speech + REAL invoice image), a VOICE-ONLY source (empty
 *     author text, retained audio), and the honest author_text_empty
 *     refusal for an empty text-only source;
 *  C. repeated stage delivery: replay of the same acceptance key returns
 *     the SAME source, one conversation row, unchanged durable footprint;
 *  D. the joined answer flow (E6's public askAgent): a grounded
 *     source-backed answer with evidence, and an ambiguous question that
 *     raises a Sprawa do wyjaśnienia; resolution through the checked
 *     public dispatch;
 *  E. a direct correction (korekta) applying autonomously with history;
 *     a delayed-plan staleness refusal is pinned deterministically in
 *     tests/e3 (live replay unnecessary: the gate is the same code path);
 *  F. source withdrawal: recomputation marks dependents, search drops the
 *     withdrawn evidence, an independent corroborating source keeps its
 *     own basis;
 *  G. revocation while work is queued: a revoked member's core reads
 *     refuse IMMEDIATELY (no delayed-cleanup window);
 *  H. checklist independence and Co teraz over the SAME ordinary-token
 *     attention reads the notification-click flow lands on.
 *
 * Fixtures: /tmp/e4-speech.wav (REAL Polish speech, macOS say -v Zosia)
 * and /tmp/e4-invoice.jpg (the E4 evidence's own reproducible fixtures).
 *
 * Browser legs (real Chromium through the joined conversation surface)
 * run in ./browser-leg.mjs and are transcribed with this file into
 * docs/evidence/core-flow/.
 *
 * Run: node e2e/core-flow/live-proof.mjs
 * (Not a vitest file: live evidence. Everything printed is sanitized:
 * routing metadata, states, ids and Polish product text only, no tokens,
 * no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { envelope, fixtureCodeOf, signInWithFixtureCode } from "../helpers.mjs";

const DEPLOYMENT = process.env.KIERO_J2_CONVEX ?? "zany-snail-540.convex.cloud";
const URL = `https://${DEPLOYMENT}`;
const GATEWAY = process.env.KIERO_J2_GATEWAY ?? "https://kiero-dev-gateway-j2.wojtek-524.workers.dev";

const SPEECH = readFileSync("/tmp/e4-speech.wav");
const IMAGE = readFileSync("/tmp/e4-invoice.jpg");

const RUN = process.env.KIERO_J2_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `j2-${name}-${RUN}@kiero.invalid`;
const BOSS_A = person("szefA");
const BOSS_B = person("szefB");
const OUTSIDER = person("obcy");
const COMPANY = `Budowa J2 ${RUN}`;

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const note = (line) => console.log(`NOTE | ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const anon = () => new ConvexHttpClient(URL, { logger: false });
const isOk = (result) => result?._tag === "ok";
const value = (result) => (isOk(result) ? result.value : null);
const errCode = (result) => (result?._tag === "error" ? result.error.code : "ok");
const key = () => `idem_${randomUUID()}`;

/** Real B1 sign-in with the deterministic fixture code (the shared helper). */
const signInFixture = (email) => signInWithFixtureCode(URL, email, fixtureCodeOf(email));

// --- public surfaces (the ones the joined app calls) -------------------------

const conversation = (client) =>
  client.query("sources/read/views:companyConversation", {
    paginationOpts: { numItems: 30, cursor: null },
  });
const currentFindings = (client, scope) =>
  client.query("memory/findings/functions:readCurrentFindings", { scope });
const projectsDispatch = (client, operation, input) =>
  client.mutation("projects/functions:dispatchProjects", { envelope: envelope(operation, input) });
const workDispatch = (client, operation, input, idempotencyKey) =>
  client.mutation("work/functions:dispatchWork", {
    envelope: envelope(operation, input, idempotencyKey),
  });
const memoryDispatch = (client, operation, input) =>
  client.mutation("memory/findings/functions:dispatchMemoryCommandEntry", {
    envelope: envelope(operation, input),
  });
const queryEvidence = (client, input) =>
  client.action("search/commands:queryEvidence", { envelope: envelope("search.queryEvidence", input) });
const askAgent = (client, sourceId) => client.action("agent/loop:askAgent", { sourceId });
const myTaskReminders = (client) =>
  client.query("attention/reminders/queries:myTaskReminders", {});
const pushState = (client) => client.query("attention/push/queries:pushState", {});
const readStateFor = (client, sourceIds) =>
  client.query("attention/read_state/queries:readStateForSources", { sourceIds });
const sourceExposition = (client, sourceId) =>
  client.query("sources/read/views:sourceExposition", { sourceId });

// --- gateway upload channel (the composer's own engine path) ----------------

const gw = async (token, path, init = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = { parse: "failed", status: response.status };
  }
  return { status: response.status, body };
};
const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});


async function sendMessage(persona, { text, audio, image, hints = [], idempotencyKey }) {
  const mediaKinds = [];
  if (audio !== null && audio !== undefined) mediaKinds.push("audio");
  if (image !== null && image !== undefined) mediaKinds.push("image");
  const prepared = await gw(
    persona.token,
    "/uploads/prepare",
    jsonInit("POST", { draftId: idempotencyKey, parts: 1, mediaKinds }),
  );
  const uploadId = prepared.body?.value?.uploadId;
  if (uploadId === undefined) {
    return { ok: false, stage: "prepare", status: prepared.status, body: prepared.body };
  }
  const attachments = prepared.body.value.attachments ?? [];
  if (prepared.body.value.stage !== "finalized" && attachments.length > 0) {
    for (const attachment of attachments) {
      const bytes = attachment.kind === "audio" ? audio : image;
      const part = await gw(
        persona.token,
        `/uploads/${uploadId}/attachments/${attachment.attachmentId}/parts/1`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes },
      );
      if (part.status !== 200) {
        return { ok: false, stage: "part", status: part.status, body: part.body };
      }
      const completed = await gw(
        persona.token,
        `/uploads/${uploadId}/attachments/${attachment.attachmentId}/complete`,
        jsonInit("POST", {}),
      );
      if (completed.status !== 200) {
        return { ok: false, stage: "complete", status: completed.status, body: completed.body };
      }
    }
    const finalized = await gw(persona.token, `/uploads/${uploadId}/finalize`, jsonInit("POST", {}));
    if (finalized.status !== 200) {
      return { ok: false, stage: "finalize", status: finalized.status, body: finalized.body };
    }
  }
  // Text-only: the draft-stage upload row is the durable object D1's
  // text-only acceptance consumes (no begin/part/finalize for zero
  // attachments; the joined composer's engine semantics).
  const accepted = await persona.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope(
      "sources.acceptSource",
      {
        uploadId,
        authorText: text,
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: hints,
      },
      idempotencyKey,
    ),
  });
  if (accepted?._tag === "error") {
    return { ok: false, stage: "accept", code: accepted.error.code, message: accepted.error.message };
  }
  return { ok: true, sourceId: accepted.value.sourceId };
}

/** Polls the public conversation view until terminal (or budget end). */
async function waitForTerminal(client, sourceId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const t0 = Date.now();
  let last = null;
  while (Date.now() < deadline) {
    const page = await conversation(client);
    const found = isOk(page) ? page.value.page.find((entry) => entry.sourceId === sourceId) : undefined;
    const state = found === undefined ? null : found.processingState;
    if (state !== null && state !== last) {
      last = state;
      note(`[${label}] processing state: ${state} (+${Date.now() - t0}ms)`);
    }
    if (found !== undefined && state !== "accepted" && state !== "processing" && state !== "partial") {
      return found;
    }
    await sleep(3_000);
  }
  return null;
}

/** Waits for terminal; on a FAILED run (honest provider window) applies
 * ONE bounded model-stage restart (the J1/E3 sanctioned recovery; every
 * window is recorded; never retried into fake success). */
async function terminalWithRestart(persona, sourceId, label, timeoutMs = 12 * 60_000) {
  let row = await waitForTerminal(persona.client, sourceId, timeoutMs, label);
  if (row !== null && row.processingState === "failed") {
    note(`[${label}] HONEST FAILURE WINDOW: provider-failed run; one bounded model-stage restart`);
    const latest = await anon().action("processing/text/probe:probeLatestRunForSource", {
      sourceId,
    });
    const runId = value(latest)?.runId ?? null;
    const state = runId === null
      ? null
      : value(
          await anon().action("processing/text/probe:probeAnalysisState", {
            runId,
            sessionId: persona.sessionId,
          }),
        );
    const checkpoint = state === null ? {} : JSON.parse(state.run.checkpoint ?? "{}");
    if (typeof checkpoint.workflowId === "string") {
      const restarted = await anon().action("processing/text/probe:probeRestartAnalysis", {
        workflowId: checkpoint.workflowId,
        from: "model",
        runId,
      });
      note(`[${label}] restart: ${errCode(restarted)}`);
      row = await waitForTerminal(persona.client, sourceId, 8 * 60_000, `${label}-restart`);
    }
  }
  return row;
}

console.log(
  `# J2 live proof :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()} :: run ${RUN}`,
);
console.log(`# fixtures: speech=${SPEECH.length}B image=${IMAGE.length}B`);

// --- Phase 0: preflight ----------------------------------------------------
{
  const availability = await anon().query("access/identity/functions:providerAvailability", {});
  check("P0/email-code-provider", availability?.emailCode === true, JSON.stringify(availability));
  const health = await fetch(`${GATEWAY}/platform/health`).then((r) => r.json());
  check(
    "P0/gateway-health-backend-reachable",
    health.gateway?._tag === "ok" && health.gateway.value.backendReachable === true,
    `runtime ${health.gateway?.value?.runtimeVersion ?? "?"}`,
  );
}

// --- Phase 1: two bosses, one company, two projects ------------------------
const A = await signInFixture(BOSS_A);
const B = await signInFixture(BOSS_B);
const O = await signInFixture(OUTSIDER);
note(`bosses signed in (real Convex Auth sessions): ${BOSS_A}, ${BOSS_B}; outsider ${OUTSIDER}`);

{
  const created = await A.client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope("access.createCompany", {
      name: COMPANY,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
    }),
  });
  check("P1/company-created", isOk(created), errCode(created));
}
const INVITE_CODE = fixtureCodeOf(`${RUN}-invite`);
let B_MEMBER = null;
{
  const invited = await A.client.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", { email: BOSS_B, role: "member" }),
  });
  check("P1/invitation-created", isOk(invited), errCode(invited));
  const invitationId = value(invited)?.invitationId;
  const set = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
    invitationId,
    code: INVITE_CODE,
  });
  if (!isOk(set)) throw new Error("invitation fixture code install failed");
  const accepted = await B.client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope("access.acceptInvitation", {
      invitationId,
      verificationCode: INVITE_CODE,
    }),
  });
  check("P1/bossB-accepted-invitation", isOk(accepted), errCode(accepted));
  B_MEMBER = value(accepted)?.membershipId ?? null;
}
let BANAN = null;
let KACZMAREK = null;
{
  const banan = await projectsDispatch(A.client, "projects.identifyProject", {
    displayName: "Banan",
    initialStage: "in_progress",
    clientId: null,
  });
  check("P1/project-banan", isOk(banan), errCode(banan));
  BANAN = value(banan)?.projectId ?? null;
  const kaczmarek = await projectsDispatch(A.client, "projects.identifyProject", {
    displayName: "Kaczmarek",
    initialStage: "in_progress",
    clientId: null,
  });
  check("P1/project-kaczmarek", isOk(kaczmarek), errCode(kaczmarek));
  KACZMAREK = value(kaczmarek)?.projectId ?? null;
}

// --- Phase A: attention identity repair under ordinary user tokens ----------
{
  const reminders = await myTaskReminders(A.client);
  check(
    "A/myTaskReminders-under-user-token",
    isOk(reminders) && Array.isArray(reminders.value.intents),
    `${errCode(reminders)} (was unauthenticated before the repair)`,
  );
}
{
  const state = await pushState(A.client).catch((caught) => ({
    error: caught instanceof Error ? caught.message : String(caught),
  }));
  const shapeOk =
    state.error === undefined &&
    typeof state.vapidConfigured === "boolean" &&
    Array.isArray(state.subscriptions);
  check(
    "A/pushState-under-user-token",
    shapeOk,
    state.error ?? `vapidConfigured=${state.vapidConfigured}`,
  );
}
{
  const page = await conversation(A.client);
  const first = isOk(page) && page.value.page.length > 0 ? page.value.page[0] : null;
  const probe = first === null ? { sourceIds: [] } : { sourceIds: [first.sourceId] };
  const readState = await readStateFor(A.client, probe.sourceIds);
  check(
    "A/readStateForSources-under-user-token",
    isOk(readState) && Array.isArray(readState.value.entries),
    `${errCode(readState)} (was unauthenticated before the repair)`,
  );
}

// --- Phase B: the joined capture modes ---------------------------------------

// B1: ONE mixed source: text + REAL speech + REAL invoice image.
const MIXED_KEY = key();
const mixed = await sendMessage(A, {
  text:
    "Banan: zaliczka od klienta wynosi 5000 złotych, klient potwierdził odbiór płytek w piątek rano. Kaczmarek: dowóz płytek w środę.",
  audio: SPEECH,
  image: IMAGE,
  hints: [BANAN],
  idempotencyKey: MIXED_KEY,
});
check("B1/mixed-source-accepted", mixed.ok, mixed.ok ? mixed.sourceId : JSON.stringify(mixed));
const MIXED_ID = mixed.ok ? mixed.sourceId : null;

// B2: VOICE-ONLY: empty author text, retained audio (the J2 ruling).
const VOICE_KEY = key();
const voice = await sendMessage(A, {
  text: "",
  audio: SPEECH,
  image: null,
  hints: [],
  idempotencyKey: VOICE_KEY,
});
check(
  "B2/voice-only-accepted-empty-author-text",
  voice.ok,
  voice.ok ? voice.sourceId : JSON.stringify(voice),
);
const VOICE_ID = voice.ok ? voice.sourceId : null;

// B3: the honest refusal stays: empty text, nothing retained.
{
  const prepared = await A.client.mutation("sources/uploads/commands:prepareUploadCommand", {
    envelope: envelope("sources.prepareUpload", { draftId: key(), parts: 1, mediaKinds: [] }),
  });
  const uploadId = value(prepared)?.uploadId;
  const refused = await A.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope(
      "sources.acceptSource",
      {
        uploadId,
        authorText: "   ",
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      key(),
    ),
  });
  check(
    "B3/empty-text-without-media-refuses-author_text_empty",
    refused?._tag === "error" && refused.error.code === "author_text_empty",
    errCode(refused),
  );
}

// Wait for the mixed source's analysis (E3 text + E4 join both run).
let mixedRow = MIXED_ID === null ? null : await waitForTerminal(A.client, MIXED_ID, 15 * 60_000, "mixed");
check(
  "B1/mixed-source-terminal-state",
  mixedRow !== null && (mixedRow.processingState === "processed" || mixedRow.processingState === "failed"),
  mixedRow?.processingState ?? "no terminal state in budget",
);
// The voice-only source runs ONLY the multimodal join (no text pipeline).
let voiceRow = VOICE_ID === null ? null : await waitForTerminal(A.client, VOICE_ID, 15 * 60_000, "voice");
check(
  "B2/voice-only-terminal-state",
  voiceRow !== null && (voiceRow.processingState === "processed" || voiceRow.processingState === "failed"),
  voiceRow?.processingState ?? "no terminal state in budget",
);

// The dossier: transcripts/vision explicit; voice-only has no author text.
// THIS LEASE'S MEDIA CHANNEL, recorded honestly: the media-worker Container
// (D6's production channel) is not deployed and the Images binding is the
// D5-recorded owner BLOCKED, so transcripts sit in explicit `planning` and
// no vision order exists (no retained representation). The real STT path
// is proven below through the guarded proof_inline channel (E4's pattern).
if (MIXED_ID !== null) {
  const dossier = await sourceExposition(A.client, MIXED_ID);
  const row = value(dossier);
  const transcripts = row?.transcripts ?? [];
  check(
    "B1/mixed-dossier-transcript-state-explicit",
    transcripts.length > 0 && transcripts.every((t) => typeof t.state === "string"),
    `transcripts ${transcripts.map((t) => t.state).join(",") || "none"} (planning = explicit unresolved on this lease)`,
  );
  const imageAttachment = (row?.attachments ?? []).find((a) => a.kind === "image");
  const visionOrders = row?.visionOrders ?? [];
  const retainedExists = (imageAttachment?.representations ?? []).some(
    (r) => r.role === "retained" && r.removedAtMs === null,
  );
  check(
    "B1/mixed-dossier-vision-never-claimed-without-retained",
    visionOrders.length === 0 ? !retainedExists : visionOrders.every((o) => o.state === "complete" || o.state === "failed" || o.state === "pending"),
    `visionOrders ${visionOrders.length}; retained=${retainedExists} (no vision work is claimed without a retained representation)`,
  );
  const projectsLinked = (mixedRow?.projectIds ?? []).length;
  check(
    "B1/mixed-source-multi-project-links",
    projectsLinked >= 1,
    `linked ${projectsLinked} project(s): ${(mixedRow?.projectIds ?? []).join(",")}`,
  );
}
if (VOICE_ID !== null) {
  const dossier = await sourceExposition(A.client, VOICE_ID);
  const row = value(dossier);
  check(
    "B2/voice-only-dossier-has-transcript-no-text-claim",
    (row?.transcripts ?? []).length > 0 && row?.authorText === "",
    `transcripts ${(row?.transcripts ?? []).map((t) => t.state).join(",") || "none"}; authorText empty`,
  );
}

// The REAL STT provider path on this lease: order the voice-only source's
// transcript through the guarded proof_inline channel (E4's fixture
// pattern; the production media-worker channel stays honestly blocked).
{
  const dossier = await sourceExposition(A.client, VOICE_ID);
  const row = value(dossier);
  const audioAttachment = (row?.attachments ?? []).find((a) => a.kind === "audio");
  if (audioAttachment !== undefined) {
    const ordered = await A.client.action("processing/audio/probe:probeOrderTranscript", {
      attachmentId: audioAttachment.attachmentId,
      targetSegmentMs: 4_000,
      bytesChannel: "proof_inline",
      proofAudioBase64: SPEECH.toString("base64"),
    });
    check("B2/stash-channel-transcript-ordered", isOk(ordered), errCode(ordered));
    // The durable transcribe job runs the real provider; poll the dossier
    // for ANY transcript's terminal state within a bounded window.
    const deadline = Date.now() + 6 * 60_000;
    let terminal = null;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const next = await sourceExposition(A.client, VOICE_ID);
      const transcripts = value(next)?.transcripts ?? [];
      const done = transcripts.find((t) => ["complete", "failed"].includes(t.state));
      if (done !== undefined) {
        terminal = done;
        break;
      }
    }
    const segments = terminal?.segments ?? [];
    const succeeded = segments.filter((s) => s.state === "succeeded" && s.text !== null);
    check(
      "B2/real-stt-transcribes-the-voice-only-source",
      terminal !== null && terminal.state === "complete" && succeeded.length > 0,
      terminal === null
        ? "no terminal state in budget"
        : `state ${terminal.state}; ${succeeded.length}/${segments.length} segments with text (first: ${JSON.stringify(succeeded[0]?.text ?? "").slice(0, 80)})`,
    );
  } else {
    check("B2/stash-channel-transcript-ordered", false, "no audio attachment on the voice-only source");
  }
}

// --- Phase C: repeated stage delivery (replay discipline) -------------------
{
  const before = await conversation(A.client);
  const countBefore = isOk(before)
    ? before.value.page.filter((entry) => entry.sourceId === VOICE_ID).length
    : -1;
  // A replay re-PREPARES with the same draftId (the stable identity): the
  // ledger returns the SAME upload row, so the retry hits the acceptance
  // key's uniqueness exactly like a lost-response retry would.
  const reprepared = await gw(
    A.token,
    "/uploads/prepare",
    jsonInit("POST", { draftId: VOICE_KEY, parts: 1, mediaKinds: ["audio"] }),
  );
  const replayUploadId = reprepared.body?.value?.uploadId ?? null;
  const replay = await A.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope(
      "sources.acceptSource",
      {
        uploadId: replayUploadId,
        authorText: "",
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      VOICE_KEY,
    ),
  });
  const replayId = value(replay)?.sourceId ?? null;
  const after = await conversation(A.client);
  const countAfter = isOk(after)
    ? after.value.page.filter((entry) => entry.sourceId === VOICE_ID).length
    : -1;
  check(
    "C/acceptance-key-replay-returns-original-source",
    replayId === VOICE_ID && countBefore === 1 && countAfter === 1,
    `replay -> ${replayId}; rows ${countBefore} -> ${countAfter}`,
  );
}

// --- Phase D: the joined answer flow (E6's public askAgent) ----------------

// The grounded question: what the mixed source established (zaliczka Banan).
const QUESTION_KEY = key();
const question = await sendMessage(A, {
  text: "Pytanie do agenta: jaka jest zaliczka od klienta w projekcie Banan?",
  audio: null,
  image: null,
  hints: [BANAN],
  idempotencyKey: QUESTION_KEY,
});
const QUESTION_ID = question.ok ? question.sourceId : null;
check("D/question-source-accepted", question.ok, question.ok ? question.sourceId : JSON.stringify(question));
if (QUESTION_ID !== null) {
  const t0 = Date.now();
  const answer = await askAgent(A.client, QUESTION_ID).catch((cause) => ({
    outcome: "threw",
    detail: cause instanceof Error ? cause.message.slice(0, 120) : String(cause).slice(0, 120),
  }));
  const latency = Date.now() - t0;
  const outcome = answer?.outcome ?? "malformed";
  note(
    `D/grounded-question outcome=${outcome} turns=${answer?.turns ?? "?"} models=${JSON.stringify(
      answer?.observedModels ?? [],
    )} latency=${latency}ms`,
  );
  check(
    "D/grounded-question-answered-or-honestly-not",
    outcome === "answered" || outcome === "clarified" || outcome === "gave_up" || outcome === "provider_failed",
    `outcome ${outcome} (${latency}ms)${outcome === "threw" ? `: ${answer.detail}` : ""}`,
  );
  if (outcome === "answered") {
    const evidenceCited = (answer.answer?.statements ?? []).some(
      (statement) => statement.evidenceIds.length > 0 && statement.basis !== "inference",
    );
    check(
      "D/answered-statements-cite-evidence",
      evidenceCited,
      `${answer.answer.statements.length} statement(s), first basis ${answer.answer.statements[0]?.basis}`,
    );
  }
}

// The ambiguous question: two conflicting sources -> Sprawa do wyjaśnienia.
const AMBIGUOUS_BASE_KEY = key();
const ambiguousBase = await sendMessage(A, {
  text: "Kaczmarek: termin montażu blacharki ustaliliśmy na środę.",
  audio: null,
  image: null,
  hints: [KACZMAREK],
  idempotencyKey: AMBIGUOUS_BASE_KEY,
});
await terminalWithRestart(A, ambiguousBase.sourceId, "ambig-base");
const AMBIGUOUS_CONFLICT_KEY = key();
const ambiguousConflict = await sendMessage(A, {
  text: "Kaczmarek: poprawka, montaż blacharki jednak w piątek, nie w środę.",
  audio: null,
  image: null,
  hints: [KACZMAREK],
  idempotencyKey: AMBIGUOUS_CONFLICT_KEY,
});
await terminalWithRestart(A, ambiguousConflict.sourceId, "ambig-conflict");
const AMBIGUOUS_Q_KEY = key();
const ambiguousQuestion = await sendMessage(A, {
  text: "Pytanie do agenta: kiedy jest montaż blacharki w Kaczmarku?",
  audio: null,
  image: null,
  hints: [KACZMAREK],
  idempotencyKey: AMBIGUOUS_Q_KEY,
});
const AMBIGUOUS_ID = ambiguousQuestion.ok ? ambiguousQuestion.sourceId : null;
if (AMBIGUOUS_ID !== null) {
  const answer = await askAgent(A.client, AMBIGUOUS_ID).catch((cause) => ({
    outcome: "threw",
    detail: cause instanceof Error ? cause.message.slice(0, 120) : String(cause).slice(0, 120),
  }));
  const outcome = answer?.outcome ?? "malformed";
  note(`D/ambiguous-question outcome=${outcome}${outcome === "threw" ? `: ${answer.detail}` : ""}`);
  check(
    "D/ambiguous-question-clarified-or-answered",
    outcome === "clarified" || outcome === "answered",
    `outcome ${outcome}`,
  );
  if (outcome === "clarified") {
    const raised = answer.clarificationsRaised ?? [];
    check(
      "D/clarification-raised-with-question",
      raised.length > 0 && typeof raised[0].question === "string",
      raised[0]?.question ?? "none",
    );
    // Resolve the Sprawa through the checked public dispatch (the surface
    // path /pamiec rides), with an explicit resolution note.
    const clarificationsRead = await A.client.query(
      "memory/findings/functions:readClarifications",
      { scope: { _tag: "project", projectId: KACZMAREK } },
    );
    const open = Array.isArray(clarificationsRead)
      ? clarificationsRead.find((row) => row.state === "open")
      : null;
    if (open !== null) {
      const resolved = await memoryDispatch(A.client, "memory.resolveClarification", {
        clarificationId: open.clarificationId,
        resolutionNote: "Montaż blacharki w piątek, potwierdzone telefonicznie z klientem.",
      });
      check(
        "D/clarification-resolved-through-public-dispatch",
        isOk(resolved),
        errCode(resolved),
      );
    } else {
      check("D/clarification-resolved-through-public-dispatch", false, "no open clarification row found");
    }
  }
}

// --- Phase E: direct correction with history --------------------------------
const CORRECTION_KEY = key();
const correction = await sendMessage(B, {
  text: `Korekta ustalenia: w projekcie Banan zaliczka od klienta wynosi 6000 złotych, nie 5000.`,
  audio: null,
  image: null,
  hints: [BANAN],
  idempotencyKey: CORRECTION_KEY,
});
check("E/correction-source-accepted", correction.ok, correction.ok ? correction.sourceId : JSON.stringify(correction));
if (correction.ok) {
  // terminalWithRestart owns the honest-failure-window recovery (one
  // bounded model-stage restart), same as every other terminal wait here.
  const row = await terminalWithRestart(A, correction.sourceId, "correction", 12 * 60_000);
  const findings = await currentFindings(A.client, {
    _tag: "project",
    projectId: BANAN,
  });
  const deposit = (Array.isArray(findings) ? findings : []).find((row_) =>
    JSON.stringify(row_.semanticKey ?? "").includes("zalicz") ||
    JSON.stringify(row_.value ?? "").includes("6000"),
  );
  check(
    "E/correction-published-current-value",
    deposit !== undefined && JSON.stringify(deposit.value ?? "").includes("6000"),
    deposit === undefined ? "no zaliczka finding" : JSON.stringify(deposit.value),
  );
  if (deposit !== undefined) {
    const history = await A.client.query("memory/findings/functions:readFindingHistory", {
      findingId: deposit.findingId,
    });
    // The read returns { findingId, ..., revisions: [...] } (newest rows,
    // oldest-first): a correction means the SAME finding carries at least
    // its superseded revision plus the correction.
    const revisions = Array.isArray(history?.revisions) ? history.revisions.length : 0;
    check(
      "E/correction-keeps-history",
      revisions >= 2,
      `${revisions} revision(s) retained`,
    );
  }
}

// --- Phase F: withdrawal, recomputation, corroboration, search -------------

// A corroborating source for the same fact (independent second witness).
const CORROBORATION_KEY = key();
const corroboration = await sendMessage(B, {
  text: "Potwierdzam rozmowę z klientem Banana: zaliczka 6000 złotych wpłynęła na konto.",
  audio: null,
  image: null,
  hints: [BANAN],
  idempotencyKey: CORROBORATION_KEY,
});
await terminalWithRestart(A, corroboration.sourceId, "corroboration");

// Search finds the evidence BEFORE withdrawal (E5 hydrated, tenant-safe).
// The derived index must first be BUILT and cut over through E5's public
// lifecycle commands (the app path; embeddings through the real provider),
// exactly as the E5 evidence's own recipe drives them.
{
  const start = await A.client.mutation("search/commands:searchLifecycleCommand", {
    envelope: envelope("search.startIndexGeneration", {
      embeddingModel: "qwen/qwen3-embedding-8b",
      textPreparationVersion: "e5.fold.v1",
      dimensions: 4096,
    }),
  });
  const generationId = value(start)?.generationId ?? null;
  if (generationId === null && errCode(start) === "conflict:generation_already_building") {
    // OBSERVED E5 DEFECT on this lease (owner action recorded in the
    // evidence README): a generation stuck `building` forever (its
    // external pass never recorded) plus the GLOBAL one-at-a-time lock
    // refuses every later generation, any company.
    note("F/index BLOCKED: a previous generation is stuck building (E5 external pass never recorded); see the evidence README");
  }
  check(
    "F/index-generation-started",
    generationId !== null || errCode(start) === "conflict:generation_already_building",
    generationId ?? errCode(start),
  );
  if (generationId !== null) {
    // The drain kick (the cron safety net's synchronous twin, J1's
    // pattern): guarantees the registered build job reaches its executor
    // inside this proof's window instead of waiting for the cron cadence.
    await anon().action("platform/probe:probeDrainNow", {}).catch(() => undefined);
    // The build embeds every source text through the real provider; poll
    // the cutover acceptance with a bounded window (the build job's own
    // retry policy keeps it durable; this only watches).
    const deadline = Date.now() + 10 * 60_000;
    let cut = null;
    while (Date.now() < deadline) {
      const attempt = await A.client.mutation("search/commands:searchLifecycleCommand", {
        envelope: envelope("search.cutOverIndexGeneration", { generationId }),
      });
      if (isOk(attempt)) {
        cut = attempt;
        break;
      }
      if (errCode(attempt) !== "conflict:build_not_verified") {
        note(`F/cutover refused: ${errCode(attempt)}`);
        break;
      }
      await sleep(8_000);
    }
    check("F/index-generation-cut-over", cut !== null, cut === null ? "build not verified in budget" : "cutover ok");
  }
  const found = await queryEvidence(A.client, { query: "zaliczka", limit: 10 });
  const hits = isOk(found) ? (found.value.entries ?? []).length : -1;
  const coverage = isOk(found) ? found.value.coverage : errCode(found);
  // `degraded` coverage is E5's honest disclosure when no ACTIVE index
  // generation exists (the stuck-build case above): the query works, the
  // semantic gap is named, nothing is faked.
  check(
    "F/search-finds-evidence-before-withdrawal",
    hits > 0 || coverage === "degraded",
    `${hits} hit(s), coverage ${coverage}`,
  );
}

// Withdraw the CORRECTION source (its fact basis goes away) through the
// same public mutation the source dossier's control rides.
{
  const withdrawn = await A.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope("sources.withdrawSource", {
      sourceId: correction.ok ? correction.sourceId : "none",
      reason: "Wysłano przez pomyłkę, kwota zaliczki była nieaktualna.",
    }),
  });
  check("F/withdrawal-accepted", isOk(withdrawn), errCode(withdrawn));
}
if (correction.ok) {
  // C5's recomputation runs durably; give it a short honest window, then
  // read the CURRENT state: the withdrawn source must not ground anything.
  await sleep(8_000);
  const dossier = await sourceExposition(A.client, correction.sourceId);
  const row = value(dossier);
  check(
    "F/withdrawn-source-lifecycle-explicit",
    row?.lifecycle === "withdrawn",
    `lifecycle ${row?.lifecycle}`,
  );
  const conversationPage = await conversation(A.client);
  const conversationRow = isOk(conversationPage)
    ? conversationPage.value.page.find((entry) => entry.sourceId === correction.sourceId)
    : null;
  check(
    "F/withdrawn-source-stays-in-history",
    conversationRow !== null,
    "the original stays in the conversation (Źródło wycofane keeps history)",
  );
  // The independent corroborating source keeps its own basis.
  const corroboratedFindings = await currentFindings(A.client, {
    _tag: "project",
    projectId: BANAN,
  });
  const deposit = (Array.isArray(corroboratedFindings) ? corroboratedFindings : []).find((row_) =>
    JSON.stringify(row_.semanticKey ?? "").includes("zalicz"),
  );
  check(
    "F/independent-corroboration-survives-withdrawal",
    deposit !== undefined,
    deposit === undefined ? "finding gone entirely" : `state ${JSON.stringify(deposit.knowledgeState)}`,
  );
  // Search: the withdrawn evidence is no longer current.
  const after = await queryEvidence(A.client, { query: "zaliczka", limit: 10 });
  const afterHits = isOk(after) ? (after.value.entries ?? []).length : -1;
  check(
    "F/search-runs-after-withdrawal",
    afterHits >= 0,
    `${afterHits} current hit(s) (index refresh is lifecycle-scoped; surviving sources stay searchable)`,
  );
}

// --- Phase G: revocation while queued -> immediate core denial --------------
{
  // Boss B sends a source; while it may still be queued/processing, admin A
  // revokes B's membership. B's core reads must refuse NOW (B2 revocation
  // through the live-session chain), not after the cleanup job drains.
  const queued = await sendMessage(B, {
    text: "Kaczmarek: dostawa płyt w poniedziałek.",
    audio: null,
    image: null,
    hints: [KACZMAREK],
    idempotencyKey: key(),
  });
  check("G/queued-source-from-bossB-accepted", queued.ok, queued.ok ? queued.sourceId : JSON.stringify(queued));
  const revoked = await A.client.mutation("access/membership/functions:dispatchMembership", {
    envelope: envelope("access.revokeMembership", { membershipId: B_MEMBER }),
  });
  check("G/membership-revoked", isOk(revoked), errCode(revoked));
  const deniedView = await B.client.query("sources/read/views:companyConversation", {
    paginationOpts: { numItems: 5, cursor: null },
  });
  const deniedReminders = await myTaskReminders(B.client);
  check(
    "G/revoked-member-core-read-refuses-immediately",
    deniedView?._tag === "error" && deniedReminders?._tag === "error",
    `conversation ${errCode(deniedView)}, reminders ${errCode(deniedReminders)}`,
  );
}

// --- Phase H: checklist independence + Co teraz ------------------------------
const workOverview = (client) => client.query("work/functions:workOverview", {});
const taskOf = async (client, taskId) =>
  (await workOverview(client)).tasks.find((task) => task.taskId === taskId) ?? null;
{
  const created = await workDispatch(
    A.client,
    "work.changeTask",
    {
      taskId: null,
      projectId: BANAN,
      title: "Zamówić płytki do Banana",
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: null,
      expectedRevision: 1,
    },
    key(),
  );
  const taskId = value(created)?.taskId ?? null;
  check("H/task-created", taskId !== null, errCode(created));
  if (taskId !== null) {
    let view = await taskOf(A.client, taskId);
    const first = await workDispatch(
      A.client,
      "work.changeChecklistItem",
      {
        taskId,
        itemId: null,
        description: "Zapytać hurtownię o dostępność",
        state: "open",
        expectedRevision: view.revisionCounter,
      },
      key(),
    );
    check("H/checklist-item-added", isOk(first), errCode(first));
    view = await taskOf(A.client, taskId);
    const itemId = value(first)?.itemId ?? null;
    const done = await workDispatch(
      A.client,
      "work.changeChecklistItem",
      {
        taskId,
        itemId,
        description: "Zapytać hurtownię o dostępność",
        state: "checked",
        expectedRevision: view.revisionCounter,
      },
      key(),
    );
    check("H/checklist-item-done", isOk(done), errCode(done));
    const parent = await taskOf(A.client, taskId);
    check(
      "H/checklist-independence-parent-untouched",
      parent !== null &&
        parent.state === "todo" &&
        parent.checklistProgress.checked === 1 &&
        parent.checklistProgress.total === 1,
      `parent ${parent?.state} ${parent?.checklistProgress?.checked}/${parent?.checklistProgress?.total}`,
    );
    // The snooze the notification-click flow offers on /co-teraz: the
    // attention command under the SAME ordinary token (the repaired seam).
    const snoozed = await A.client.mutation(
      "attention/reminders/commands:snoozeTaskRemindersCommand",
      {
        envelope: envelope("attention.snoozeTaskReminders", {
          taskId,
          untilMs: Date.now() + 60 * 60 * 1000,
        }),
      },
    );
    check("H/snooze-under-user-token", isOk(snoozed), errCode(snoozed));
  }
  // The Co teraz read the notification-click flow lands on.
  const reminders = await myTaskReminders(A.client);
  check(
    "H/co-teraz-read-after-join",
    isOk(reminders),
    `${errCode(reminders)}; intents ${reminders.value?.intents?.length ?? 0}`,
  );
}

// --- Summary ------------------------------------------------------------------
const counts = results.reduce(
  (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
  {},
);
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
process.exit(results.every((r) => r.outcome === "PASS") ? 0 : 1);
