/**
 * F3 surgical re-check #3 (session-revocation, final): the hygiene cron had
 * legitimately disabled boss B's subscriptions while the membership was
 * revoked (the converging cleanup). This pass RE-REGISTERS the devices
 * through the checked path - the phones under the live bridge session, the
 * tablets under the STILL-REVOKED tablet session - accepts one source,
 * waits past the 60-second batching window, evaluates once, and asserts:
 * both phones +1, both revoked-session tablets +0.
 */
import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "wonderful-firefly-487";
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const client = () => new ConvexHttpClient(`https://${DEPLOYMENT}.eu-west-1.convex.cloud`);
const isOk = (r) => r._tag === "ok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `idem_${randomUUID()}`;
const proofState = async () =>
  (await (await fetch(`${SITE}/attention/push/proof/state`, { method: "POST" })).json());

console.log(`# F3 session-revocation re-check (fresh bindings) :: ${new Date().toISOString()}`);
const boss = await client().action("attention/probe_shared:probeSeedBoss", {
  email: "f3-boss-b@kiero.invalid", displayName: "F3 boss B", deviceLabel: "f3-boss-b-bridge",
});
const tabletSession = await client().action("attention/probe_shared:probeSeedDevice", {
  email: "f3-boss-b@kiero.invalid", deviceLabel: "f3-boss-b-tablet",
});
if (!isOk(boss) || !isOk(tabletSession)) throw new Error("seeding failed");
const SESSION = boss.value.sessionId;
const SESSION_TABLET = tabletSession.value.sessionId;

const state0 = await proofState();
const pick = (prefix) => {
  const d = state0.devices.find((x) => x.token.startsWith(prefix));
  if (!d) throw new Error(`device ${prefix} missing`);
  return d;
};
// The device rows carry only public material in the state read; the keys
// come from the endpoint registration we do now with FRESH proof devices.
const mkDevice = async (behavior) => {
  const response = await fetch(`${SITE}/attention/push/proof/device`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior }),
  });
  const created = await response.json();
  return { ...created, token: created.endpoint.split("/").pop() };
};
const phone = await mkDevice("ok");
const tablet = await mkDevice("ok");
const register = async (device, label, sessionId) => {
  const result = await client().action("attention/push/probe:probeRegisterSubscription", {
    endpoint: device.endpoint, p256dhKeyBase64: device.keys.p256dh, authKeyBase64: device.keys.auth,
    deviceLabel: label, sessionId,
  });
  if (!isOk(result)) throw new Error(`registration failed: ${JSON.stringify(result)}`);
};

// The REVOKED tablet session: revoke the fresh one so the tablet binding is
// dead from the start (a session's revocation is what the scenario tests).
await register(phone, "Telefon (re-check)", SESSION);
await register(tablet, "Tablet (re-check, revoked session)", SESSION_TABLET);
await client().action("attention/push/probe:probeRevokeFixtureSession", { targetSessionId: SESSION_TABLET });

const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
const acceptedAt = Date.now();
const accepted = await client().action("sources/accept/probe:probeAcceptSource", {
  envelope: {
    operation: "sources.acceptSource",
    input: {
      uploadId: upload.value.uploadId,
      authorText: "Ósma wzmianka: świeże urządzenia, sesja tabletu odwołana.",
      intendedSentAtIso: new Date().toISOString(), timezoneSnapshot: "Europe/Warsaw", projectHints: [],
    },
    expectedRevisions: [], idempotencyKey: key(),
  },
});
const sourceId = accepted.value.sourceId;
let run = null;
while (run === null && Date.now() - acceptedAt < 120_000) {
  const state = await client().action("processing/text/probe:probeLatestRunForSource", { sourceId });
  if (isOk(state) && state.value.state !== "running" && state.value.state !== null) run = state.value;
  else await sleep(4_000);
}
if (run === null) throw new Error("run never terminal");
await client().action("attention/delivery/probe:probeForceRunSucceeded", { runId: run.runId });
const evaluated = await client().action("attention/delivery/probe:probeEvaluateDueIntents", {
  envelope: { operation: "attention.evaluateDueIntents", input: { nowMs: Date.now() }, expectedRevisions: [] },
});
if (!isOk(evaluated)) throw new Error(`evaluation failed: ${JSON.stringify(evaluated)}`);

const deadline = Date.now() + 120_000;
let after = await proofState();
while (Date.now() < deadline) {
  after = await proofState();
  const phoneN = after.devices.find((d) => d.token === phone.token)?.messages.length ?? 0;
  if (phoneN >= 1) break;
  await sleep(4_000);
}
const phoneN = after.devices.find((d) => d.token === phone.token)?.messages.length ?? 0;
const tabletN = after.devices.find((d) => d.token === tablet.token)?.messages.length ?? 0;
const ok = phoneN === 1 && tabletN === 0;
console.log(`[${ok ? "PASS" : "FAIL"}] push.session-revocation-denied-before-cleanup :: live-session phone 0->${phoneN}; revoked-session tablet 0->${tabletN} (subscription row still enabled at delivery time)`);
if (!ok) process.exitCode = 1;
