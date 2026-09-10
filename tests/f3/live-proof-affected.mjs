/**
 * F3 live-proof SURGICAL re-run (the owner's Database-I/O guardrail: after
 * fixes, re-run ONLY the affected scenarios). The first pass proved 14/18
 * checks; the four FAILs were assertion bugs in the evidence script, not
 * system behavior. This script re-verifies exactly those four against the
 * same lease, with one extra accepted source for the session-revocation
 * denial (the tablet's session stays revoked):
 *
 *  1. push.verified-vapid        - the aud claim is the push endpoint's
 *                                  SITE origin (compared against the wrong
 *                                  constant in round 1).
 *  2. push.session-revocation-denied-before-cleanup - count from the
 *                                  revocation instant.
 *  3. push.membership-revocation-no-intent-created - F2 creates intents
 *                                  for ACTIVE members only, so a revoked
 *                                  member has no row at all.
 *  4. push.pushState-honest      - read while the actor still resolves
 *                                  (boss B is re-seeded, which re-activates
 *                                  the membership per the F2 fixture note).
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "wonderful-firefly-487";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, ok, detail) {
  results.push({ id, outcome: ok ? "PASS" : "FAIL", detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
}
const isOk = (r) => r._tag === "ok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `idem_${randomUUID()}`;

const proofState = async () => (await (await fetch(`${SITE}/attention/push/proof/state`, { method: "POST" })).json());
const messagesOf = async (endpoint) => {
  const token = endpoint.split("/").pop();
  const state = await proofState();
  return (state.devices ?? []).find((d) => d.token === token)?.messages ?? [];
};

console.log(`# F3 surgical re-run :: ${new Date().toISOString()}`);

// Round 1 fixture ids (from the first pass transcript).
const PHONE = { endpoint: "https://wonderful-firefly-487.eu-west-1.convex.site/attention/push/proof/push-service/" };
// Resolve devices by behavior from the recorded state.
const state0 = await proofState();
const okPhone = state0.devices.find((d) => d.behavior === "ok" && d.messages.length >= 3);
const okTablet = state0.devices.find((d) => d.behavior === "ok" && d !== okPhone && d.messages.length >= 1);
if (okPhone === undefined || okTablet === undefined) throw new Error("fixtures not found");

// 1. VAPID audience is the SITE origin of the push endpoint.
const anyMessage = okPhone.messages[0];
record(
  "push.verified-vapid",
  anyMessage.vapidVerified === true && anyMessage.vapidAudience === SITE,
  `vapidVerified=${anyMessage.vapidVerified} aud=${anyMessage.vapidAudience}`,
);

// Re-seed boss B (also re-activates the membership, the F2 fixture note).
const boss = await client().action("attention/probe_shared:probeSeedBoss", {
  email: "f3-boss-b@kiero.invalid",
  displayName: "F3 boss B (push recipient)",
  deviceLabel: "f3-boss-b-bridge",
});
if (!isOk(boss)) throw new Error("re-seed failed");
const SESSION = boss.value.sessionId;

// 4. The settings-screen read resolves and reports the honest server state.
const stateRead = await client().action("attention/push/probe:probePushState", { sessionId: SESSION });
record(
  "push.pushState-honest",
  isOk(stateRead) &&
    stateRead.value.vapidConfigured === true &&
    typeof stateRead.value.applicationServerKey === "string" &&
    stateRead.value.subscriptions.length >= 2 &&
    stateRead.value.subscriptions.some((row) => row.thisDevice === true),
  `vapidConfigured=${stateRead.value?.vapidConfigured} subscriptions=${stateRead.value?.subscriptions?.length} thisDevice=${stateRead.value?.subscriptions?.some((r) => r.thisDevice)}`,
);

// 2. Session-revocation denial: the tablet's session is STILL revoked
// (sessions stay revoked); one new eligible intent reaches only the phone.
const phoneBefore = okPhone.messages.length;
const tabletBefore = okTablet.messages.length;
const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
const accepted = await client().action("sources/accept/probe:probeAcceptSource", {
  envelope: {
    operation: "sources.acceptSource",
    input: {
      uploadId: upload.value.uploadId,
      authorText: "Piąta wzmianka: tablet ma nie dostać niczego.",
      intendedSentAtIso: new Date().toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    expectedRevisions: [],
    idempotencyKey: key(),
  },
});
const sourceId = accepted.value.sourceId;
let run = null;
for (let attempt = 0; attempt < 30 && run === null; attempt += 1) {
  const state = await client().action("processing/text/probe:probeLatestRunForSource", { sourceId });
  if (isOk(state) && state.value.state !== "running" && state.value.state !== null) {
    run = state.value;
  } else {
    await sleep(3_000);
  }
}
if (run === null) throw new Error("run never terminal");
await client().action("attention/delivery/probe:probeForceRunSucceeded", { runId: run.runId });
await client().action("attention/delivery/probe:probeEvaluateDueIntents", {
  envelope: { operation: "attention.evaluateDueIntents", input: { nowMs: Date.now() + 1_000 }, expectedRevisions: [] },
});

const deadline = Date.now() + 100_000;
let phoneNow = okPhone.messages.length;
while (Date.now() < deadline && phoneNow < phoneBefore + 1) {
  await sleep(3_000);
  phoneNow = (await messagesOf(PHONE.endpoint + okPhone.token)).length;
}
const tabletNow = (await messagesOf(`${PHONE.endpoint}${okTablet.token}`)).length;
record(
  "push.session-revocation-denied-before-cleanup",
  phoneNow === phoneBefore + 1 && tabletNow === tabletBefore,
  `phone ${phoneBefore}->${phoneNow}, revoked-session tablet ${tabletBefore}->${tabletNow}`,
);

// 3. A source accepted while the membership is revoked creates NO
// notification intent for the revoked member (F2's creation enumerates
// ACTIVE members), so the transport receives nothing at all.
await client().action("attention/probe_shared:probeRevokeFixtureMembership", {
  email: "f3-boss-b@kiero.invalid",
});
const phoneAtRevocation = (await messagesOf(`${PHONE.endpoint}${okPhone.token}`)).length;
const upload2 = await client().action("sources/accept/probe:probeSeedUpload", {});
const accepted2 = await client().action("sources/accept/probe:probeAcceptSource", {
  envelope: {
    operation: "sources.acceptSource",
    input: {
      uploadId: upload2.value.uploadId,
      authorText: "Szósta wzmianka po ponownym odebraniu członkostwa.",
      intendedSentAtIso: new Date().toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    expectedRevisions: [],
    idempotencyKey: key(),
  },
});
const revokedSourceId = accepted2.value.sourceId;
let revokedRun = null;
for (let attempt = 0; attempt < 30 && revokedRun === null; attempt += 1) {
  const state = await client().action("processing/text/probe:probeLatestRunForSource", { sourceId: revokedSourceId });
  if (isOk(state) && state.value.state !== "running" && state.value.state !== null) {
    revokedRun = state.value;
  } else {
    await sleep(3_000);
  }
}
if (revokedRun === null) throw new Error("revoked-membership run never terminal");
await client().action("attention/delivery/probe:probeForceRunSucceeded", { runId: revokedRun.runId });
await client().action("attention/delivery/probe:probeEvaluateDueIntents", {
  envelope: { operation: "attention.evaluateDueIntents", input: { nowMs: Date.now() + 1_000 }, expectedRevisions: [] },
});
await sleep(5_000);
const revokedSourceState = await client().action("attention/delivery/probe:probeDeliveryStateForSource", {
  sourceId: revokedSourceId,
});
const phoneAfterRevocation = (await messagesOf(`${PHONE.endpoint}${okPhone.token}`)).length;
const bossIntent =
  isOk(revokedSourceState)
    ? revokedSourceState.value.intents.find((row) => row.recipientUserId === boss.value.userId)
    : null;
record(
  "push.membership-revocation-no-intent-created",
  bossIntent === undefined && phoneAfterRevocation === phoneAtRevocation,
  `intents for the source: ${isOk(revokedSourceState) ? revokedSourceState.value.intents.length : "read-failed"}, boss B row: ${bossIntent === undefined ? "none" : JSON.stringify(bossIntent)}, phone ${phoneAtRevocation}->${phoneAfterRevocation}`,
);

const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
if (results.some((r) => r.outcome === "FAIL")) process.exitCode = 1;
