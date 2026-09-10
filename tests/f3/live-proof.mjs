/**
 * F3 live proofs against the REAL leased dev deployment
 * (wojtekpiskorz-jr:kiero-dev-core:dev/f3, instance wonderful-firefly-487,
 * EU). ONE focused pass (the owner's Database-I/O guardrail): every
 * scenario is batched into this single script run, with bounded polling.
 *
 * The provider is the guarded FAKE WEB PUSH SERVICE deployed on the lease
 * itself (convex/attention/push/proofService.ts - the G1/G3 fake-Google
 * pattern): the real transport POSTs real RFC 8030/8291/8292 requests to
 * it over the network; it verifies the VAPID ES256 signature against the
 * deployment's PUBLIC key, decrypts the aes128gcm body with the device's
 * private key and records the receipt BEFORE answering per behavior. The
 * `timeout` device records the receipt and then stalls past the caller's
 * bounded deadline - the message EXISTS at the service while the caller
 * can only record `unknown` (the load-bearing timeout-after-acceptance
 * case).
 *
 * Actor context: the A3 service-bridge identity plus server-seeded fixture
 * bosses of the service company (the F1/F2 people fixtures). The recipient
 * boss's subscriptions are registered through the CHECKED command path.
 *
 * Scenarios (in order, one pass):
 *  1. one eligible intent reaches ALL active subscriptions once per device
 *     (two ok devices; VAPID verified; payload decrypted; Polish preview);
 *  2. the gone device (404) is terminally disabled and stops receiving;
 *     the timeout device records unknown and is never re-driven, even
 *     after a replayed duplicate delivered event (semantic
 *     intent+subscription idempotency);
 *  3. hide-preview composes the neutral payload (routing ids stay);
 *  4. session revocation denies delivery BEFORE any cleanup (the bound
 *     device receives nothing while the other device still does);
 *  5. membership revocation: F2's evaluator suppresses the intent and the
 *     transport receives nothing at all.
 *
 * Run: node tests/f3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "wonderful-firefly-487";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
/** HTTP actions are served at the deployment's site origin (the G3 shape). */
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;

const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, ok, detail) {
  const outcome = ok ? "PASS" : "FAIL";
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
const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const isOk = (r) => r._tag === "ok";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seedBoss = (email, label, device) =>
  client().action("attention/probe_shared:probeSeedBoss", {
    email,
    displayName: label,
    deviceLabel: device,
  });
const seedDevice = (email, deviceLabel) =>
  client().action("attention/probe_shared:probeSeedDevice", { email, deviceLabel });
const accept = (input, idempotencyKey) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: { ...envelope("sources.acceptSource", input), idempotencyKey },
  });
const uploadFor = async () => {
  const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
  if (!isOk(upload)) throw new Error("upload seeding failed");
  return upload.value.uploadId;
};
const latestRun = (sourceId) =>
  client().action("processing/text/probe:probeLatestRunForSource", { sourceId });
const forceSucceeded = (runId) =>
  client().action("attention/delivery/probe:probeForceRunSucceeded", { runId });
const evaluate = (nowMs) =>
  client().action("attention/delivery/probe:probeEvaluateDueIntents", {
    envelope: envelope("attention.evaluateDueIntents", { nowMs }),
  });
const stateForSource = (sourceId) =>
  client().action("attention/delivery/probe:probeDeliveryStateForSource", { sourceId });
const changePrefs = (input, sessionId) =>
  client().action("attention/preferences/probe:probeChangeNotificationPreferences", {
    envelope: envelope("attention.changeNotificationPreferences", input),
    sessionId,
  });
const registerSub = (input, sessionId) =>
  client().action("attention/push/probe:probeRegisterSubscription", { ...input, sessionId });
const pushState = (sessionId) =>
  client().action("attention/push/probe:probePushState", { sessionId });
const republishDelivered = (intentId) =>
  client().action("attention/push/probe:probePublishIntentDelivered", { intentId });
const revokeSession = (targetSessionId) =>
  client().action("attention/push/probe:probeRevokeFixtureSession", { targetSessionId });
const revokeMembership = (email) =>
  client().action("attention/probe_shared:probeRevokeFixtureMembership", { email });

const newDevice = async (behavior) => {
  const response = await fetch(`${SITE}/attention/push/proof/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ behavior }),
  });
  if (response.status !== 201) throw new Error(`device creation failed: ${response.status}`);
  const created = await response.json();
  // The device's public token rides its endpoint URL (the service returns
  // {endpoint, keys}, exactly like pushManager.subscribe().toJSON()).
  return { ...created, token: created.endpoint.split("/").pop() };
};
const proofState = async () => {
  const response = await fetch(`${SITE}/attention/push/proof/state`, { method: "POST" });
  return response.json();
};
const messagesOf = async (token) => {
  const state = await proofState();
  return (state.devices ?? []).find((device) => device.token === token)?.messages ?? [];
};

/** Bounded wait until the predicate over messages holds. */
async function waitFor(token, predicate, what, timeoutMs = 100_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await messagesOf(token);
    if (predicate(last)) {
      return last;
    }
    await sleep(3_000);
  }
  throw new Error(`${what} never happened for device ${token.slice(0, 6)} (last: ${last.length} messages)`);
}

/** One accepted text source authored by the service account (company entry). */
async function acceptCompanySource(text) {
  const sourceId = await (async () => {
    const accepted = await accept(
      {
        uploadId: await uploadFor(),
        authorText: text,
        intendedSentAtIso: new Date().toISOString(),
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      key(),
    );
    if (!isOk(accepted)) throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
    return accepted.value.sourceId;
  })();
  // Wait for the terminal assignment classification (analysis run), then
  // force the terminal-success branch (the F2 fixture flip).
  const deadline = Date.now() + 100_000;
  let run = null;
  while (Date.now() < deadline) {
    const state = await latestRun(sourceId);
    if (isOk(state) && state.value.state !== "running" && state.value.state !== null) {
      run = state.value;
      break;
    }
    await sleep(3_000);
  }
  if (run === null) throw new Error("analysis run never became terminal");
  await forceSucceeded(run.runId);
  // The REAL evaluator seam at the real wall clock.
  const evaluated = await evaluate(Date.now() + 1_000);
  if (!isOk(evaluated)) throw new Error(`evaluation failed: ${JSON.stringify(evaluated)}`);
  return sourceId;
}

console.log(`# F3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- fixtures ---------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (!isOk(seed)) throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);

const boss = await seedBoss("f3-boss-b@kiero.invalid", "F3 boss B (push recipient)", "f3-boss-b-bridge");
if (!isOk(boss)) throw new Error("boss seeding failed");
const SESSION = boss.value.sessionId;
const USER_B = boss.value.sessionId ? boss.value.userId : null;
if (USER_B === null) throw new Error("boss fixture has no user id");

const secondDevice = await seedDevice("f3-boss-b@kiero.invalid", "f3-boss-b-tablet");
if (!isOk(secondDevice)) throw new Error("second device seeding failed");
const SESSION_TABLET = secondDevice.value.sessionId;

// The fake push service devices (the browser side).
const okPhone = await newDevice("ok");
const okTablet = await newDevice("ok");
const goneDevice = await newDevice("gone");
const timeoutDevice = await newDevice("timeout");
console.log(
  `# devices: okPhone/okTablet/gone/timeout registered at the fake push service`,
);

// Register the recipient's subscriptions through the CHECKED command path.
const registered = [];
for (const [label, device, sessionId] of [
  ["Telefon (ok)", okPhone, SESSION],
  ["Tablet (ok)", okTablet, SESSION_TABLET],
  ["Stary telefon (gone)", goneDevice, SESSION],
  ["Tablet testowy (timeout)", timeoutDevice, SESSION],
]) {
  const result = await registerSub(
    {
      endpoint: device.endpoint,
      p256dhKeyBase64: device.keys.p256dh,
      authKeyBase64: device.keys.auth,
      deviceLabel: label,
    },
    sessionId,
  );
  if (!isOk(result)) throw new Error(`subscription registration failed for ${label}`);
  registered.push({ label, id: result.value.pushSubscriptionId, device });
}

// --- scenario 1: one eligible intent reaches all active subscriptions once --
const source1 = await acceptCompanySource("Klient potwierdził termin betonowania na piątek.");

const phoneMessages = await waitFor(okPhone.token, (messages) => messages.length === 1, "phone delivery");
const tabletMessages = await waitFor(okTablet.token, (messages) => messages.length === 1, "tablet delivery");

const message = phoneMessages[0];
record(
  "push.verified-vapid",
  message.vapidVerified === true && message.vapidAudience === SITE,
  `vapidVerified=${message.vapidVerified} aud=${message.vapidAudience}`,
);
record(
  "push.aes128gcm-decrypted",
  message.decrypted === true && message.contentEncoding === "aes128gcm",
  `decrypted=${message.decrypted} encoding=${message.contentEncoding}`,
);
record(
  "push.ttl-headers",
  message.ttl === "86400",
  `ttl=${message.ttl}`,
);
const payload = message.payload ?? {};
record(
  "push.polish-preview",
  payload.title === "Nowy wpis: Firma" && typeof payload.body === "string" && payload.body.includes("termin betonowania"),
  `title="${payload.title}" body="${payload.body}"`,
);
record(
  "push.payload-routing-ids-only",
  payload.data !== undefined && payload.data.sourceIds?.length === 1 && !("url" in (payload.data ?? {})),
  `data=${JSON.stringify(payload.data)}`,
);
record(
  "push.multiple-devices-once-each",
  phoneMessages.length === 1 && tabletMessages.length === 1,
  `phone=${phoneMessages.length} tablet=${tabletMessages.length}`,
);

// The gone device: 404 revokes the subscription (terminal provider answer).
await waitFor(goneDevice.token, (messages) => messages.length >= 1, "gone receipt");
await sleep(2_000);
const stateAfterGone = await pushState(SESSION);
const goneRow = stateAfterGone.value.subscriptions.find(
  (row) => row.deviceLabel === "Stary telefon (gone)",
);
record(
  "push.expired-subscription-disabled",
  isOk(stateAfterGone) && goneRow !== undefined && goneRow.revokedAtMs !== null,
  `gone device revoked=${goneRow?.revokedAtMs !== null && goneRow?.revokedAtMs !== undefined}`,
);

// The timeout device: unknown at the caller, RECEIPT EXISTS at the service.
const timeoutMessages = await waitFor(timeoutDevice.token, (messages) => messages.length === 1, "timeout receipt");
record(
  "push.timeout-after-acceptance-receipt-exists",
  timeoutMessages.length === 1 && timeoutMessages[0].decrypted === true,
  `service recorded ${timeoutMessages.length} message(s) while the caller recorded unknown`,
);

// The per-device delivery rows (via the settings-screen state + intent read).
const sourceState1 = await stateForSource(source1);
const intent1 = sourceState1.value.intents.find((row) => row.recipientUserId === USER_B);
record("push.intent-delivered-state", intent1?.state === "delivered", `state=${intent1?.state}`);

// --- scenario 2: duplicate delivered event (concurrent/replayed) ------------
if (intent1 === undefined) throw new Error("no delivered intent to replay");
await republishDelivered(intent1.intentId);
await sleep(8_000); // drain (1s) + job + legs, once
const phoneAfterReplay = await messagesOf(okPhone.token);
const timeoutAfterReplay = await messagesOf(timeoutDevice.token);
record(
  "push.replayed-event-no-second-message",
  phoneAfterReplay.length === 1,
  `phone messages after replay=${phoneAfterReplay.length}`,
);
record(
  "push.unknown-never-re-driven",
  timeoutAfterReplay.length === 1,
  `timeout device messages after replay=${timeoutAfterReplay.length}`,
);

// --- scenario 3: hide-preview composes the neutral payload -----------------
const prefs = await changePrefs({ hidePreviewContent: true }, SESSION);
if (!isOk(prefs)) throw new Error("preference change failed");
const source2 = await acceptCompanySource("Druga bardzo ważna ustalona kwota 12 tysięcy.");
await waitFor(okPhone.token, (messages) => messages.length === 2, "second delivery");
const hiddenPayload = (await messagesOf(okPhone.token))[1].payload ?? {};
record(
  "push.hide-preview-neutral-payload",
  hiddenPayload.title === "Nowe powiadomienie" && hiddenPayload.body === "Otwórz Kiero, żeby zobaczyć.",
  `title="${hiddenPayload.title}" body="${hiddenPayload.body}"`,
);
record(
  "push.hide-preview-keeps-routing-ids",
  Array.isArray(hiddenPayload.data?.sourceIds) && hiddenPayload.data.sourceIds.length === 1,
  `data=${JSON.stringify(hiddenPayload.data)}`,
);

// --- scenario 4: session revocation denies BEFORE cleanup -------------------
await revokeSession(SESSION_TABLET);
const beforeSessionTest = (await messagesOf(okPhone.token)).length;
const tabletAtRevocation = (await messagesOf(okTablet.token)).length;
const source3 = await acceptCompanySource("Trzecia wzmianka po cofnięciu sesji tabletu.");
await waitFor(okPhone.token, (messages) => messages.length === beforeSessionTest + 1, "phone only delivery");
const tabletAfterSessionRevoke = await messagesOf(okTablet.token);
record(
  "push.session-revocation-denied-before-cleanup",
  tabletAfterSessionRevoke.length === tabletAtRevocation,
  `revoked-session device received nothing new (${tabletAfterSessionRevoke.length} total, ${tabletAtRevocation} at revocation) while its subscription row was still enabled`,
);
const phoneThird = (await messagesOf(okPhone.token)).at(-1).payload ?? {};
record(
  "push.other-devices-still-receive",
  (await messagesOf(okPhone.token)).length === beforeSessionTest + 1 && phoneThird.title !== undefined,
  `active phone messages=${(await messagesOf(okPhone.token)).length}`,
);

// --- the settings-screen read (before revoking the membership) ---------------
const finalState = await pushState(SESSION);
record(
  "push.pushState-honest",
  isOk(finalState) &&
    finalState.value.vapidConfigured === true &&
    typeof finalState.value.applicationServerKey === "string" &&
    finalState.value.subscriptions.length >= 2,
  `vapidConfigured=${finalState.value?.vapidConfigured} subscriptions=${finalState.value?.subscriptions?.length}`,
);

// --- scenario 5: membership revocation ---------------------------------------
await revokeMembership("f3-boss-b@kiero.invalid");
const beforeMembershipTest = (await messagesOf(okPhone.token)).length;
const source4 = await acceptCompanySource("Czwarta wzmianka po odebraniu członkostwa.");
await sleep(6_000);
const afterMembershipTest = (await messagesOf(okPhone.token)).length;
record(
  "push.membership-revocation-no-delivery",
  afterMembershipTest === beforeMembershipTest,
  `messages before=${beforeMembershipTest} after=${afterMembershipTest}`,
);
const sourceState4 = await stateForSource(source4);
const intent4 = sourceState4.value.intents.find((row) => row.recipientUserId === USER_B);
record(
  "push.membership-revocation-no-intent-created",
  intent4 === undefined,
  `no notification intent exists for the revoked member (found: ${sourceState4.value.intents.length} rows, recipients: ${sourceState4.value.intents.map((row) => row.recipientUserId).join(",")})`,
);

const ok = summarize();
if (!ok) {
  process.exitCode = 1;
}
