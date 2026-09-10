/**
 * H4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/h4, instance rugged-gnu-57, EU).
 *
 * The audited GM processing surface runs FOR REAL here: a fresh proof
 * company accepts a real text source (the full E3 pipeline through the real
 * chat route), a publication group is armed to fail deterministically, and
 * the GM, a real Convex Auth session from KIERO_GM_EMAILS, inspects the
 * failed run through the audited command, retries the failed stage (same
 * run identity, journaled model result replayed, no second provider call),
 * requests a linked reanalysis (new run, server-approved configuration),
 * and loses access both ways (company alpha ended; GM mode exited).
 *
 * Scenarios (issue #52 focused verification):
 *  A. ordinary member: cannot enter GM mode, cannot invoke GM processing
 *     operations (fail closed with the sanitized denial);
 *  B. inspection: full canonical projection of the failed run + audit row
 *     (actor, grant, basis, target revision) + immutable source;
 *  C. failed-stage retry: run identity preserved, restart from the group
 *     stage, NO new provider attempt (attempts unchanged), run succeeds;
 *  D. duplicate retry / completion race: stale inspected state refused,
 *     succeeded stage refused (both audited);
 *  E. linked reanalysis: new run kind "reanalysis" linked to the inspected
 *     latest run, versions pinned by the server, no model input anywhere;
 *  F. revoked company alpha: audited refusal (company_alpha_not_active);
 *  G. revoked GM mode: refusal without any attributable action.
 *
 * Run: node tests/h4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the session report.
 * Everything printed is sanitized: states, versions, counts and ids only;
 * no secrets, no source text.)
 */

import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_H4_DEPLOYMENT ?? "rugged-gnu-57";
const URL = `https://${DEPLOYMENT}.convex.cloud`;
// Deterministic per-person fixture codes (the library resolves by HASH).
const fixtureCode = (email) =>
  String(Math.abs(Array.from(email).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)) % 100_000_000).padStart(8, "0");

const RUN = process.env.KIERO_H4_PROOF_RUN ?? Date.now().toString(36);
/** The branded idempotency-key shape the command envelope decodes. */
const idem = () => `idem_${randomUUID()}`;
// Must match KIERO_GM_EMAILS on this deployment (deployment configuration
// is the designation; the audited grant is the explicit act).
const GM = "gm-h4-operator@kiero.invalid";
const MEMBER = `h4-member-${RUN}@kiero.invalid`;

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
  return new ConvexHttpClient(URL, { logger: false });
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Real B1 sign-in with a fixture code (proof-domain address only). */
async function signInFixture(email) {
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", {
    email,
    code: fixtureCode(email),
  });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code: fixtureCode(email) },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}`);
  }
  return { client, email };
}

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const dispatchProcessing = (client, operation, input) =>
  client.mutation("operations/processing/functions:dispatchGmProcessing", {
    envelope: envelope(operation, input),
  });
const dispatchGm = (client, operation, input) =>
  client.mutation("access/gm/functions:dispatchGm", { envelope: envelope(operation, input) });
const enterGm = (client, reason) =>
  client.action("access/gm/functions:enterGmMode", { envelope: envelope("access.enterGmMode", { reason }) });
const overview = (client) => client.query("access/gm/functions:gmOverview", {});
const auditTail = (sinceMs) =>
  anon().action("operations/processing/probe:h4ProofAuditTail", { sinceMs });
const sourceSnapshot = (sourceId) =>
  anon().action("operations/processing/probe:h4ProofSourceSnapshot", { sourceId });
const analysisState = (runId, sessionId) =>
  anon().action("processing/text/probe:probeAnalysisState", { runId, sessionId });
const latestRun = (sourceId) =>
  anon().action("processing/text/probe:probeLatestRunForSource", { sourceId });
const armFailure = (runId, sequence) =>
  anon().action("processing/text/probe:probeArmAnalysisFailure", { runId, sequence });
const disarmFailure = (runId, sequence) =>
  anon().action("processing/text/probe:probeDisarmAnalysisFailure", { runId, sequence });
const armOutcomeFailure = (runId, sequence) =>
  anon().action("processing/text/probe:probeArmAnalysisOutcomeFailure", { runId, sequence });
const drainNow = () => anon().action("platform/probe:probeDrainNow", {});
const seedE3Company = (nonce) =>
  anon().action("processing/text/probe:probeSeedE3Company", { nonce });
const seedE3Upload = (sessionId) =>
  anon().action("processing/text/probe:probeSeedE3Upload", { sessionId });
const acceptSourceProbe = (input, idempotencyKey, sessionId) =>
  anon().action("sources/accept/probe:probeAcceptSource", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      idempotencyKey,
    },
    sessionId,
  });

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const errTag = (result) => (result?._tag === "error" ? result.error._tag : "ok");

const RUN_START_MS = Date.now();
const ENTRY_REASON = `wsparcie alfa: kontrola przetwarzania (${RUN})`;
const INSPECT_BASIS = `zgłoszenie szefa: błąd przetwarzania (${RUN})`;
const RETRY_BASIS = `naprawa po stronie dostawcy potwierdzona (${RUN})`;
const REANALYSIS_REASON = `ponowna analiza po weryfikacji ustaleń (${RUN})`;

/** Polls a run to a terminal state (bounded wait, generous interval). */
async function waitForRun(runId, timeoutMs, sessionId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await analysisState(runId, sessionId);
    if (isOk(state) && state.value.run.state !== "running") {
      return state.value;
    }
    await sleep(4_000);
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
}

console.log(`# H4 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// ---------------------------------------------------------------------------
// Phase A: ordinary members cannot open or invoke GM operations
// ---------------------------------------------------------------------------
const member = await signInFixture(MEMBER);
row("A0 member signed in (not GM-designated)", MEMBER);

const memberEntry = await enterGm(member.client, "próba wejścia bez wskazania");
check(
  "A1 non-designated account cannot enter GM mode",
  memberEntry?._tag === "error" && memberEntry.error.code === "gm_not_designated",
  JSON.stringify({ tag: errTag(memberEntry), code: errCode(memberEntry) }),
);

const memberInspect = await dispatchProcessing(member.client, "operations.inspectProcessingRun", {
  processingRunId: "k57doesnotmatter000000000000000000",
  basis: "próba bez uprawnienia",
});
check(
  "A2 ordinary member cannot invoke the GM processing dispatch",
  memberInspect?._tag === "error" &&
    (memberInspect.error.code === "gm_mode_not_active" || memberInspect.error._tag === "forbidden"),
  JSON.stringify({ tag: errTag(memberInspect), code: errCode(memberInspect) }),
);

// ---------------------------------------------------------------------------
// Fixtures: fresh proof company + GM activation
// ---------------------------------------------------------------------------
const seed = await seedE3Company(`h4-${RUN}`);
if (!isOk(seed)) throw new Error(`probeSeedE3Company failed: ${JSON.stringify(seed)}`);
const COMPANY = seed.value.companyId;
const SESSION = seed.value.sessionId;
row("fixtures: fresh company", COMPANY);

const gm = await signInFixture(GM);
row("GM operator signed in (real Convex Auth session)", GM);

// Re-run hygiene: close any stale grant an earlier pass left open.
const stale = await overview(gm.client);
if (stale?.state === "gm") {
  await dispatchGm(gm.client, "access.exitGmMode", { grantId: stale.grantId });
}

const entered = await enterGm(gm.client, ENTRY_REASON);
check("fixtures: GM mode entered with basis", isOk(entered), errCode(entered));

const activated = await dispatchGm(gm.client, "access.gmActivateCompany", {
  companyId: COMPANY,
  basis: `objęcie firmy udziałem w alfie (${RUN})`,
});
check("fixtures: GM activates the proof company's alpha", isOk(activated), errCode(activated));
const gmState = await overview(gm.client);
const GRANT_ID = gmState?.state === "gm" ? gmState.grantId : null;
row("fixtures: open grant", GRANT_ID ?? "MISSING");

// ---------------------------------------------------------------------------
// Fixture helpers: real acceptance through the full E3 pipeline
// ---------------------------------------------------------------------------
async function acceptSource(attempt) {
  const upload = await seedE3Upload(SESSION);
  if (!isOk(upload)) throw new Error("upload seeding failed");
  const accepted = await acceptSourceProbe(
    {
      uploadId: upload.value.uploadId,
      authorText:
        attempt === 1
          ? "Projekt Banan: dowóz płytek na Buniewice w środę rano. Do wyceny doliczamy około 10 tysięcy."
          : "Zapisz w pamięci firmy: serwis drukarki etykiet zaplanowany na poniedziałek 14 września 2026.",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    idem(),
    SESSION,
  );
  if (!isOk(accepted)) throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  const run = await latestRun(accepted.value.sourceId);
  if (!isOk(run)) throw new Error("no processing run for source");
  return { sourceId: accepted.value.sourceId, runId: run.value.runId };
}

// ---------------------------------------------------------------------------
// The CRASH shape: a publication group armed to throw (the run fails, the
// crashed stage leaves no step row; the honest blocker list says run_failed)
// ---------------------------------------------------------------------------
const crash = await acceptSource(1);
await armFailure(crash.runId, 1_000); // the A3/E3 throw marker, group index 0
await drainNow();
const crashTerminal = await waitForRun(crash.runId, 600_000, SESSION);
check(
  "B0 crash fixture: the run failed for real",
  crashTerminal.run.state === "failed",
  crashTerminal.run.state,
);
const CRASH_ATTEMPTS = crashTerminal.attempts.length;
row("B0 real provider attempts before any GM action", String(CRASH_ATTEMPTS));

const snapshotBefore = await sourceSnapshot(crash.sourceId);
check(
  "B0 source snapshot captured (sha256 identity)",
  isOk(snapshotBefore),
  snapshotBefore?._tag === "ok" ? `sha=${snapshotBefore.value.textSha256.slice(0, 12)}...` : errCode(snapshotBefore),
);

// ---------------------------------------------------------------------------
// Phase B: the audited inspection (over the failed crash run)
// ---------------------------------------------------------------------------
const inspection = await dispatchProcessing(gm.client, "operations.inspectProcessingRun", {
  processingRunId: crash.runId,
  basis: INSPECT_BASIS,
});
check("B1 inspection succeeds under GM authority", isOk(inspection), errCode(inspection));
if (!isOk(inspection)) throw new Error("inspection failed; aborting");

const view = inspection.value;
check(
  "B2 inspection shows the failed run with server-pinned versions",
  view.run.state === "failed" &&
    view.run.pipelineVersion === "e3.text/1" &&
    view.run.modelConfigurationVersion.startsWith("e2.routing/"),
  `${view.run.state} ${view.run.pipelineVersion} ${view.run.modelConfigurationVersion}`,
);
check(
  "B3 inspection shows stages, attempts with the approved route, and the honest blocker",
  view.steps.some((s) => s.stepKind === "model_analysis" && s.state === "succeeded") &&
    view.attempts.some((a) => a.provider === "openrouter" && a.model !== null) &&
    view.blockers.some((b) => b.code === "run_failed" || b.code === "job_failed"),
  `${view.steps.length} steps, ${view.attempts.length} attempts, ${view.blockers.length} blockers`,
);
check(
  "B4 inspection diagnostics carry only redacted sanitized events",
  view.diagnostics.every((event) => event.kind.startsWith("ops.")),
  view.diagnostics.map((event) => event.kind).join(",") || "none",
);

const inspectAudit = (await auditTail(RUN_START_MS)).value.records.find(
  (record) =>
    record.operationName === "operations.inspectProcessingRun" &&
    record.processingRunId === crash.runId &&
    record.outcome === "ok",
);
check(
  "B5 inspection wrote the canonical audit row (actor, grant, basis, target revision)",
  inspectAudit !== undefined &&
    inspectAudit.gmGrantId === GRANT_ID &&
    inspectAudit.gmBasis === INSPECT_BASIS &&
    inspectAudit.gmTargetRevision === `${crash.runId}@failed`,
  inspectAudit === undefined ? "no audit row" : `${inspectAudit.gmTargetRevision} grant=${inspectAudit.gmGrantId}`,
);

const snapshotAfterInspect = await sourceSnapshot(crash.sourceId);
check(
  "B6 inspection left the immutable source untouched",
  isOk(snapshotAfterInspect) &&
    snapshotAfterInspect.value.textSha256 === snapshotBefore.value.textSha256 &&
    snapshotAfterInspect.value.sentAtMs === snapshotBefore.value.sentAtMs,
  "sha identical",
);

// ---------------------------------------------------------------------------
// Phase D: refusals on the crash run (stale revision, not-failed stage)
// ---------------------------------------------------------------------------
const modelStep = view.steps.find((s) => s.stepKind === "model_analysis");
const staleRefusal = await dispatchProcessing(gm.client, "operations.retryProcessingStep", {
  stepId: modelStep.stepId,
  expectedRunState: "succeeded",
  basis: RETRY_BASIS,
});
check(
  "D1 stale inspected state is refused (the completion-race shape)",
  staleRefusal?._tag === "error" && staleRefusal.error.code === "run_state_stale",
  JSON.stringify({ tag: errTag(staleRefusal), code: errCode(staleRefusal) }),
);
const notFailedRefusal = await dispatchProcessing(gm.client, "operations.retryProcessingStep", {
  stepId: modelStep.stepId,
  expectedRunState: "failed",
  basis: RETRY_BASIS,
});
check(
  "D2 a succeeded stage is not retryable work",
  notFailedRefusal?._tag === "error" && notFailedRefusal.error.code === "stage_not_failed",
  JSON.stringify({ tag: errTag(notFailedRefusal), code: errCode(notFailedRefusal) }),
);
const refusalAudits = (await auditTail(RUN_START_MS)).value.records.filter(
  (record) =>
    record.operationName === "operations.retryProcessingStep" &&
    (record.outcome === "run_state_stale" || record.outcome === "stage_not_failed"),
);
check(
  "D3 both refusals are audited with their closed outcome codes",
  refusalAudits.length === 2 && refusalAudits.every((record) => record.gmGrantId === GRANT_ID),
  refusalAudits.map((record) => record.outcome).join(","),
);

// ---------------------------------------------------------------------------
// The FAILED-GROUP shape: a publication group armed to fail as a RECORDED
// outcome (the run succeeds; the failed group stays an explicit failed step)
// ---------------------------------------------------------------------------
const partial = await acceptSource(2);
await armOutcomeFailure(partial.runId, 1_000);
await drainNow();
const partialTerminal = await waitForRun(partial.runId, 600_000, SESSION);
check(
  "C0 partial fixture: the run completed with an explicit failed group",
  partialTerminal.run.state === "succeeded" &&
    partialTerminal.steps.some((s) => s.stepKind === "publish_group" && s.state === "failed"),
  `${partialTerminal.run.state} failedGroups=${
    partialTerminal.steps.filter((s) => s.stepKind === "publish_group" && s.state === "failed").length
  }`,
);
const PARTIAL_ATTEMPTS = partialTerminal.attempts.length;

// ---------------------------------------------------------------------------
// Phase C: the failed-stage retry (identity preserved, no duplicate calls)
// ---------------------------------------------------------------------------
const partialSnapshotBefore = await sourceSnapshot(partial.sourceId);
const partialInspection = await dispatchProcessing(gm.client, "operations.inspectProcessingRun", {
  processingRunId: partial.runId,
  basis: INSPECT_BASIS,
});
if (!isOk(partialInspection)) throw new Error("partial inspection failed; aborting");
const failedStep = partialInspection.value.steps.find(
  (s) => s.stepKind === "publish_group" && s.state === "failed",
);

const retry = await dispatchProcessing(gm.client, "operations.retryProcessingStep", {
  stepId: failedStep.stepId,
  expectedRunState: "succeeded",
  basis: RETRY_BASIS,
});
check(
  "C1 retry resumes the failed stage under GM authority",
  isOk(retry) && retry.value.state === "running" && retry.value.restartedFrom === "group",
  isOk(retry) ? `${retry.value.runId} from=${retry.value.restartedFrom}` : errCode(retry),
);
if (!isOk(retry)) throw new Error("retry failed; aborting");

check(
  "C2 semantic run identity preserved (same run id, no new run)",
  retry.value.runId === partial.runId,
  `${retry.value.runId} === ${partial.runId}`,
);

const retriedTerminal = await waitForRun(partial.runId, 600_000, SESSION);
check(
  "C3 the retried run progresses through running back to terminal",
  retriedTerminal.run.state === "succeeded",
  retriedTerminal.run.state,
);
check(
  "C4 the journaled model result replayed: NO new provider attempt",
  retriedTerminal.attempts.length === PARTIAL_ATTEMPTS,
  `${retriedTerminal.attempts.length} === ${PARTIAL_ATTEMPTS}`,
);

const retryAudit = (await auditTail(RUN_START_MS)).value.records.find(
  (record) =>
    record.operationName === "operations.retryProcessingStep" &&
    record.processingRunId === partial.runId &&
    record.outcome === "ok",
);
check(
  "C5 retry wrote the canonical audit row",
  retryAudit !== undefined && retryAudit.gmTargetRevision === `${partial.runId}@succeeded`,
  retryAudit === undefined ? "no audit row" : retryAudit.gmTargetRevision,
);

// ---------------------------------------------------------------------------
// Phase E: linked reanalysis (new run, server-approved configuration)
// ---------------------------------------------------------------------------
const reanalysis = await dispatchProcessing(gm.client, "operations.requestReanalysis", {
  sourceId: partial.sourceId,
  reason: REANALYSIS_REASON,
  expectedLatestRunId: partial.runId,
});
check(
  "E1 reanalysis creates a linked NEW run",
  isOk(reanalysis) &&
    reanalysis.value.processingRunId !== partial.runId &&
    reanalysis.value.reanalysisOfRunId === partial.runId,
  isOk(reanalysis)
    ? `${reanalysis.value.processingRunId} of=${reanalysis.value.reanalysisOfRunId}`
    : errCode(reanalysis),
);
if (!isOk(reanalysis)) throw new Error("reanalysis failed; aborting");
const NEW_RUN = reanalysis.value.processingRunId;

await drainNow();
const reanalysisTerminal = await waitForRun(NEW_RUN, 600_000, SESSION);
check(
  "E2 the linked reanalysis run completes",
  reanalysisTerminal.run.state === "succeeded" && reanalysisTerminal.run.kind === "reanalysis",
  `${reanalysisTerminal.run.state} ${reanalysisTerminal.run.kind}`,
);
check(
  "E3 the new run's configuration is server-approved (pinned by the workflow)",
  reanalysisTerminal.run.pipelineVersion === "e3.text/1" &&
    reanalysisTerminal.run.modelConfigurationVersion.startsWith("e2.routing/"),
  `${reanalysisTerminal.run.pipelineVersion} ${reanalysisTerminal.run.modelConfigurationVersion}`,
);

const reanalysisAudit = (await auditTail(RUN_START_MS)).value.records.find(
  (record) =>
    record.operationName === "operations.requestReanalysis" &&
    record.outcome === "ok" &&
    record.gmBasis === REANALYSIS_REASON,
);
check(
  "E4 reanalysis wrote the canonical audit row with the inspected target",
  reanalysisAudit !== undefined && reanalysisAudit.gmTargetRevision === `source@${partial.runId}`,
  reanalysisAudit === undefined ? "no audit row" : reanalysisAudit.gmTargetRevision,
);

const snapshotAfterAll = await sourceSnapshot(partial.sourceId);
check(
  "E5 the immutable source still never changed (bytes, timestamps, lifecycle)",
  snapshotAfterAll?._tag === "ok" &&
    snapshotAfterAll.value.textSha256 === partialSnapshotBefore.value.textSha256 &&
    snapshotAfterAll.value.fullyAcceptedAtMs === partialSnapshotBefore.value.fullyAcceptedAtMs &&
    snapshotAfterAll.value.lifecycle === partialSnapshotBefore.value.lifecycle,
  "both scenario sources untouched (crash source sha pinned at B6)",
);

// ---------------------------------------------------------------------------
// Phase F: revoked company alpha (audited refusal)
// ---------------------------------------------------------------------------
const ended = await dispatchGm(gm.client, "access.gmEndCompanyAlpha", {
  companyId: COMPANY,
  basis: `koniec udziału firmy w alfie (${RUN})`,
});
check("F1 GM ends the company's alpha participation", isOk(ended), errCode(ended));

const afterAlpha = await dispatchProcessing(gm.client, "operations.inspectProcessingRun", {
  processingRunId: NEW_RUN,
  basis: INSPECT_BASIS,
});
check(
  "F2 GM scope ends with alpha: inspection refused",
  afterAlpha?._tag === "error" && afterAlpha.error.code === "company_alpha_not_active",
  JSON.stringify({ tag: errTag(afterAlpha), code: errCode(afterAlpha) }),
);
const alphaRefusal = (await auditTail(RUN_START_MS)).value.records.find(
  (record) =>
    record.operationName === "operations.inspectProcessingRun" &&
    record.outcome === "company_alpha_not_active",
);
check(
  "F3 the alpha refusal is audited under the acting grant",
  alphaRefusal !== undefined && alphaRefusal.gmGrantId === GRANT_ID,
  alphaRefusal === undefined ? "no audit row" : alphaRefusal.outcome,
);

// ---------------------------------------------------------------------------
// Phase G: revoked GM mode (refusal without any attributable action)
// ---------------------------------------------------------------------------
const exited = await dispatchGm(gm.client, "access.exitGmMode", { grantId: GRANT_ID });
check("G1 GM exits GM mode", isOk(exited), errCode(exited));

const inspectRowsBeforeExit = (await auditTail(RUN_START_MS)).value.records.filter(
  (record) => record.operationName === "operations.inspectProcessingRun",
).length;
const afterExit = await dispatchProcessing(gm.client, "operations.inspectProcessingRun", {
  processingRunId: NEW_RUN,
  basis: INSPECT_BASIS,
});
check(
  "G2 GM scope ends with the mode: inspection refused",
  afterExit?._tag === "error" && afterExit.error.code === "gm_mode_not_active",
  JSON.stringify({ tag: errTag(afterExit), code: errCode(afterExit) }),
);
const inspectRowsAfterExit = (await auditTail(RUN_START_MS)).value.records.filter(
  (record) => record.operationName === "operations.inspectProcessingRun",
).length;
check(
  "G3 nothing GM-attributable happened after the exit (no audit row)",
  inspectRowsAfterExit === inspectRowsBeforeExit,
  `${inspectRowsAfterExit} === ${inspectRowsBeforeExit}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const counts = results.reduce(
  (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
  {},
);
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
process.exit(results.every((r) => r.outcome === "PASS") ? 0 : 1);
