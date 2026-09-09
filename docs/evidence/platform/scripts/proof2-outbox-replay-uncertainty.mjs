/**
 * A3 proof 2: the idempotent outbox/job mechanism and the uncertain-outcome
 * protocol, against the live deployment.
 *
 * Rows produced (see docs/evidence/platform/README.md):
 *   O1 atomic publish (event + job)         O2 replay dedups (no 2nd effect)
 *   O3 uncertain outcome recorded           O4 reconcile confirms (no dup)
 *   O5 no-duplicate-effects count           O6 event-edge -> durable job
 *
 * Usage: node docs/evidence/platform/scripts/proof2-outbox-replay-uncertainty.mjs
 */

import { execSync } from "node:child_process";
import {
  bridgeCall,
  httpClient,
  loadEnv,
  pollUntil,
  record,
  stamp,
  summarize,
} from "./lib.mjs";

const env = loadEnv();

/**
 * Selects the echo stand-in's behavior. Env vars are snapshotted into the
 * deployed functions, so each switch also redeploys (a few seconds).
 */
async function setEchoBehavior(behavior) {
  execSync(
    `npx --yes convex@1.45.0 env set KIERO_ECHO_TARGET "https://steady-basilisk-613.eu-west-1.convex.site/platform/echo?behavior=${behavior}"`,
    { stdio: "pipe" },
  );
  execSync("npx --yes convex@1.45.0 dev --once", { stdio: "pipe" });
}

console.log(`# proof2 outbox replay+uncertainty :: started ${stamp()}`);

const client = httpClient();
const seed = await client.action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error("probeSeed failed");
const { companyId } = seed.value;

async function outboxState(dedupKey) {
  const result = await bridgeCall(env, {
    operation: "platform.outboxState",
    input: { dedupKey },
  });
  if (result.status !== 200 || result.body._tag !== "ok") {
    throw new Error(`outboxState failed: ${JSON.stringify(result)}`);
  }
  return result.body.value;
}

function uncertainJobsTotalBefore(state) {
  return state.jobs.filter((candidate) => candidate.kind === "platform.echo_delivery").length;
}

async function drainNow() {
  const drained = await client.action("platform/probe:probeDrainNow", {});
  if (drained._tag !== "ok") throw new Error(`drain failed: ${JSON.stringify(drained)}`);
}

// --- O0: fail AFTER registration -> full rollback (no accepted orphan) ------------

const beforeFail = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
const eventsBeforeFail = beforeFail.body.value.events.length;
const jobsBeforeFail = beforeFail.body.value.jobs.length;
let failedPublication = null;
try {
  failedPublication = await client.action("platform/probe:probeFailPublication", {
    message: `orphan-probe-${Date.now()}`,
  });
} catch (error) {
  failedPublication = { _tag: "thrown", message: String(error).slice(0, 80) };
}
const afterFail = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
record(
  "O0 failing the transaction AFTER registration rolls back event, job and scheduled work",
  afterFail.body.value.events.length === eventsBeforeFail &&
    afterFail.body.value.jobs.length === jobsBeforeFail
    ? "PASS"
    : "FAIL",
  `events ${eventsBeforeFail}->${afterFail.body.value.events.length} jobs ${jobsBeforeFail}->${afterFail.body.value.jobs.length} (mutation failed: ${failedPublication?._tag ?? "thrown"})`,
);

// --- O1/O2: atomic publication and replay dedup ----------------------------------

const idemKey = `idem_${crypto.randomUUID()}`;
const first = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "proof2 replay target" },
  idempotencyKey: idemKey,
});
const firstResult = first.body.value;
record(
  "O1 transaction publishes canonical event AND durable job together",
  first.status === 200 && firstResult.deduplicated === false && firstResult.jobKey.startsWith("job_")
    ? "PASS"
    : "FAIL",
  `eventId=${firstResult?.eventId} jobKey=${firstResult?.jobKey?.slice(0, 18)}...`,
);

await drainNow();
await pollUntil(
  "echo job runs",
  async () => {
    const state = await outboxState(firstResult.dedupKey);
    return state.jobs.length > 0 && state.jobs[0].state === "succeeded";
  },
  { timeoutMs: 20_000 },
);

const replay = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "proof2 replay target" },
  idempotencyKey: idemKey,
});
const stateAfterReplay = await outboxState(firstResult.dedupKey);
const replayEvents = stateAfterReplay.events.filter((e) => e.dedupKey === firstResult.dedupKey);
const replayJobs = stateAfterReplay.jobs.filter((j) => j.jobKey === firstResult.jobKey);
record(
  "O2 replaying the SAME logical operation dedups (same event, same job)",
  replay.status === 200 &&
    replay.body.value.deduplicated === true &&
    replay.body.value.eventId === firstResult.eventId &&
    replay.body.value.jobKey === firstResult.jobKey &&
    replayEvents.length === 1 &&
    replayJobs.length === 1
    ? "PASS"
    : "FAIL",
  `deduplicated=${replay.body?.value?.deduplicated} sameEventId=${replay.body?.value?.eventId === firstResult.eventId} sameJobKey=${replay.body?.value?.jobKey === firstResult.jobKey} events=${replayEvents.length} jobs=${replayJobs.length}`,
);

// --- O3: uncertain outcome (timeout after possible external success) -------------

// Point the echo target at the slow stand-in: it records the effect, then
// delays past the caller's 2s deadline.
await setEchoBehavior("slow");
const uncertainKey = `idem_${crypto.randomUUID()}`;
const uncertain = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "proof2 uncertain target" },
  idempotencyKey: uncertainKey,
});
await drainNow();
const uncertainState = await pollUntil(
  "uncertain delivery recorded",
  async () => {
    const state = await outboxState(uncertain.body.value.dedupKey);
    const job = state.jobs.find((candidate) => candidate.jobKey === uncertain.body.value.jobKey);
    return job && job.state === "failed" ? state : null;
  },
  { timeoutMs: 40_000 },
);
const uncertainJob = uncertainState.jobs.find(
  (candidate) => candidate.jobKey === uncertain.body.value.jobKey,
);
const uncertainEffectsBefore = uncertainState.externalEffects.length;
record(
  "O3 timeout-after-possible-success recorded as uncertain (no auto-retry)",
  uncertainJob.state === "failed" && uncertainEffectsBefore >= 1
    ? "PASS"
    : "FAIL",
  `jobState=${uncertainJob.state} externalEffects=${uncertainEffectsBefore} (effect recorded by the external system before the deadline)`,
);

// --- O3a: replaying the UNCERTAIN-failure publisher with the SAME key is refused --

const uncertainReplay = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "proof2 uncertain target" },
  idempotencyKey: uncertainKey,
});
const stateAfterUncertainReplay = await outboxState(uncertain.body.value.dedupKey);
const uncertainJobsAfterReplay = stateAfterUncertainReplay.jobs.filter(
  (candidate) => candidate.jobKey === uncertainJob.jobKey,
);
record(
  "O3a replay of an uncertain-failure publisher with the SAME dedup key is refused",
  uncertainReplay.status === 200 &&
    uncertainReplay.body.value.deduplicated === true &&
    uncertainReplay.body.value.jobKey === uncertainJob.jobKey &&
    stateAfterUncertainReplay.jobs.filter((candidate) => candidate.kind === "platform.echo_delivery")
      .length === uncertainJobsTotalBefore(uncertainState) &&
    uncertainJobsAfterReplay.length === 1
    ? "PASS"
    : "FAIL",
  `deduplicated=${uncertainReplay.body?.value?.deduplicated} sameJobKey=${uncertainReplay.body?.value?.jobKey === uncertainJob.jobKey} echoJobs=${stateAfterUncertainReplay.jobs.filter((c) => c.kind === "platform.echo_delivery").length} (was ${uncertainJobsTotalBefore(uncertainState)})`,
);

// --- O4/O5: reconciliation confirms without a duplicate effect -------------------

const reconcile = await client.action("platform/probe:probeReconcileDelivery", {
  jobKey: uncertainJob.jobKey,
});
const afterReconcile = await outboxState(uncertain.body.value.dedupKey);
const reconciledJob = afterReconcile.jobs.find(
  (candidate) => candidate.jobKey === uncertainJob.jobKey,
);
record(
  "O4 reconciliation observes the external system and confirms delivery",
  reconcile._tag === "ok" &&
    reconcile.value.reconciled === "confirmed_delivered" &&
    reconciledJob.state === "succeeded"
    ? "PASS"
    : "FAIL",
  `reconciled=${reconcile?.value?.reconciled} jobState=${reconciledJob?.state}`,
);

record(
  "O5 no duplicate external effect across replay+uncertainty+reconciliation",
  afterReconcile.externalEffects.length === 1 ? "PASS" : "FAIL",
  `externalEffects for one logical operation = ${afterReconcile.externalEffects.length} (expected 1)`,
);

// Restore the fast target for later proofs.
await setEchoBehavior("ok");

// --- O6: cross-module consumer edge -> durable job (reanalysis) -------------------

const kick = await client.action("platform/probe:probeKickAnalysis", {
  sourceId: seed.value.sourceId,
});
if (kick._tag !== "ok") throw new Error(`kickAnalysis failed: ${JSON.stringify(kick)}`);
await drainNow();
const analysisState = await pollUntil(
  "analysis workflow completes",
  async () => {
    const state = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
    const job = state.body.value.jobs.find(
      (candidate) => candidate.kind === "processing.analyze_change_plan",
    );
    return job && job.state === "succeeded" ? job : null;
  },
  { timeoutMs: 60_000 },
);
record(
  "O6 event consumer edge registers the durable analyze job (drain path)",
  analysisState.kind === "processing.analyze_change_plan" ? "PASS" : "FAIL",
  `jobKind=${analysisState.kind} state=${analysisState.state} (registered from operations.reanalysisRequested by the outbox drain)`,
);

// --- O7: an unprojected consumer edge fails LOUDLY (never silently in_flight) ----

const unprojected = await client.action("platform/probe:probePublishEvent", {
  eventName: "sources.sourceAccepted",
  payload: { sourceId: seed.value.sourceId, attachmentIds: [] },
});
if (unprojected._tag !== "ok") throw new Error(`publish failed: ${JSON.stringify(unprojected)}`);
await drainNow();
const allState = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
const stranded = allState.body.value.events.find(
  (event) => event.eventName === "sources.sourceAccepted" && event.deliveryState === "failed",
);
const extractJobs = allState.body.value.jobs.filter(
  (candidate) => candidate.kind === "processing.extract_fragments",
);
record(
  "O7 unprojected consumer edge fails loudly (row failed + consumer_projection_missing, no job)",
  stranded !== undefined &&
    stranded.lastErrorKind === "consumer_projection_missing" &&
    extractJobs.length === 0
    ? "PASS"
    : "FAIL",
  `event=${stranded?.eventName ?? "none"} state=${stranded?.deliveryState ?? "none"} lastErrorKind=${stranded?.lastErrorKind ?? "none"} extractJobs=${extractJobs.length}`,
);

process.exit(summarize() ? 0 : 1);
