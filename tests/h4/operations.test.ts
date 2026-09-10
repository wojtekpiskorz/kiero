/**
 * H4 focused verification (3/5): the transactional cores over the in-memory
 * fake; inspection (audited, bounded, marker-free projection), failed-
 * stage retry (identity preserved, restart recorded, every denial audited),
 * linked reanalysis (new run + registered event publication), revoked
 * GM/company access (audited refusals), and the immutability witness: the
 * source bytes/text never change through any GM action.
 *
 * The live halves (real B4 authority, real processing records) run in
 * ./live-proof.mjs against the leased dev deployment.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { operationsOperations, parseTableId } from "@kiero/contracts";
import {
  performInspectProcessingRun,
  performRequestReanalysis,
  performRetryProcessingStep,
} from "../../convex/operations/processing/operations";
import type { GmAuthority } from "../../convex/access/gm/operations";
import {
  AUTHOR_ID,
  COMPANY_ID,
  GRANT_ID,
  OPERATOR_ID,
  RUN_ID,
  SOURCE_ID,
  STEP_ID,
  fakeProcessingDb,
  fakeProcessingTx,
  seedRun,
  seedSource,
  seedStep,
  type FakeProcessingDb,
} from "./fake";

const authority: GmAuthority = { userId: OPERATOR_ID, grantId: GRANT_ID };

const inspectEntry = operationsOperations["operations.inspectProcessingRun"];
const retryEntry = operationsOperations["operations.retryProcessingStep"];
const reanalysisEntry = operationsOperations["operations.requestReanalysis"];

const inspectInput = (runId: string, basis = "kontrola błędu przetwarzania") =>
  Schema.decodeUnknownSync(inspectEntry.input)({
    processingRunId: parseTableId("processingRuns", runId),
    basis,
  });
const retryInput = (
  stepId: string,
  expectedRunState: "running" | "succeeded" | "failed" | "superseded",
  basis = "wznowienie po naprawie dostawcy",
) =>
  Schema.decodeUnknownSync(retryEntry.input)({
    stepId: parseTableId("processingSteps", stepId),
    expectedRunState,
    basis,
  });
const reanalysisInput = (
  sourceId: string,
  expectedLatestRunId: string | null,
  reason = "powtórna wycena po korekcie",
) =>
  Schema.decodeUnknownSync(reanalysisEntry.input)({
    sourceId: parseTableId("sources", sourceId),
    reason,
    expectedLatestRunId:
      expectedLatestRunId === null
        ? null
        : parseTableId("processingRuns", expectedLatestRunId),
  });

/** Seeds the standing world: operator + open grant + activated company. */
function seedAuthority(db: FakeProcessingDb): void {
  db.users.set(OPERATOR_ID, { id: OPERATOR_ID, email: "gm-h4-operator@kiero.invalid" });
  db.grants.set(GRANT_ID, {
    id: GRANT_ID,
    userId: OPERATOR_ID,
    reason: "wsparcie alfa",
    enteredAtMs: 1,
    closedAtMs: null,
  });
  db.companies.set(COMPANY_ID, {
    id: COMPANY_ID,
    name: "Budowa Kowalscy",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  db.activations.push({
    id: "j97activation1",
    companyId: COMPANY_ID,
    activatedByUserId: OPERATOR_ID,
    activatedAtMs: 1,
    endedAtMs: null,
    endedByUserId: null,
  });
}

/** Seeds one failed analysis world: source + run + failed group step. */
function seedFailedRun(db: FakeProcessingDb): void {
  seedSource(db);
  seedRun(db, { runId: RUN_ID });
  seedStep(db, { stepId: STEP_ID, state: "failed" });
  db.attempts.push({
    stepId: STEP_ID,
    attempt: 101,
    outcome: "succeeded",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    errorKind: null,
    startedAtMs: 1_800_000_000_100,
    finishedAtMs: 1_800_000_000_150,
  });
  db.processingJobs.push({
    jobId: "k57job0001q2x9w7c1vbn8hj6t0a5q3z",
    runId: RUN_ID,
    kind: "processing.analyze_change_plan",
    state: "failed",
    attempts: 3,
    maxAttempts: 3,
    lastErrorKind: "max_attempts_exceeded",
    externalOutcome: null,
  });
  db.changeSets.push({
    changeSetId: "k57chg0001q2x9w7c1vbn8hj6t0a5q3z",
    sourceId: SOURCE_ID,
    state: "failed",
    preparedAtMs: 1_800_000_000_300,
    publishedAtMs: null,
    failedReason: "stale_plan",
  });
  db.diagnostics.push({
    kind: "ops.processing.failed",
    metadata: [
      { key: "runId", value: RUN_ID },
      { key: "errorKind", value: "provider_failed" },
    ],
    redactionsApplied: 1,
    atMs: 1_800_000_000_600,
  });
}

describe("inspection (the audited read)", () => {
  it("returns the full bounded projection and writes the ok audit row in the same transaction", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const tx = fakeProcessingTx(db);

    const result = await performInspectProcessingRun(tx, authority, inspectInput(RUN_ID));
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") {
      return;
    }
    const value = Schema.decodeUnknownSync(inspectEntry.result)(result.value);
    expect(value.run).toMatchObject({
      runId: RUN_ID,
      sourceId: SOURCE_ID,
      companyId: COMPANY_ID,
      kind: "initial_analysis",
      state: "failed",
      pipelineVersion: "e3.text/1",
    });
    expect(value.source).toMatchObject({
      sourceId: SOURCE_ID,
      authorUserId: AUTHOR_ID,
      lifecycle: "active",
      processingState: "failed",
    });
    expect(value.steps.map((step) => step.stepId)).toEqual([STEP_ID]);
    expect(value.attempts.map((attempt) => attempt.model)).toEqual(["z-ai/glm-5.3-flash"]);
    expect(value.jobs.map((job) => job.lastErrorKind)).toEqual(["max_attempts_exceeded"]);
    expect(value.derivedChanges.map((change) => change.failedReason)).toEqual(["stale_plan"]);
    expect(value.diagnostics.map((event) => event.kind)).toEqual(["ops.processing.failed"]);
    expect(value.blockers.map((blocker) => blocker.code)).toEqual([
      "stage_failed",
      "job_attempts_exhausted",
    ]);
    // The audit row: actor, grant, company, basis, target revision, run.
    expect(db.processingAudit).toHaveLength(1);
    expect(db.processingAudit[0]).toMatchObject({
      actorUserId: OPERATOR_ID,
      gmGrantId: GRANT_ID,
      companyId: COMPANY_ID,
      operationName: "operations.inspectProcessingRun",
      gmBasis: "kontrola błędu przetwarzania",
      outcome: "ok",
      gmTargetRevision: `${RUN_ID}@failed`,
      processingRunId: RUN_ID,
    });
  });

  it("excludes marker rows from the stage list (probe plumbing, not stages)", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    seedStep(db, {
      stepId: "k57marker0001q2x9w7c1vbn8hj6t0a5",
      stepKind: "failure_marker",
      sequence: 101_000,
      state: "failed",
    });
    const result = await performInspectProcessingRun(
      fakeProcessingTx(db),
      authority,
      inspectInput(RUN_ID),
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      const value = Schema.decodeUnknownSync(inspectEntry.result)(result.value);
      expect(value.steps.map((step) => step.stepKind)).toEqual(["publish_group"]);
    }
  });

  it("audits the honest not_found refusal for an unknown run", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    const result = await performInspectProcessingRun(
      fakeProcessingTx(db),
      authority,
      inspectInput("k57ghostrun0q2x9w7c1vbn8hj6t0a5q"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
      expect(result.error.code).toBe("processing_run_not_found");
    }
    expect(db.processingAudit).toHaveLength(1);
    expect(db.processingAudit[0]).toMatchObject({
      outcome: "processing_run_not_found",
      companyId: null,
    });
  });

  it("refuses a whitespace-only basis with validation and writes no audit row", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const result = await performInspectProcessingRun(
      fakeProcessingTx(db),
      authority,
      inspectInput(RUN_ID, "   "),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
      expect(result.error.code).toBe("gm_basis_invalid");
    }
    expect(db.processingAudit).toHaveLength(0);
  });

  it("revoked GM access (closed grant) is an audited refusal with no target leak", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.grants.get(GRANT_ID)!.closedAtMs = 1_800_000_000_999;
    const result = await performInspectProcessingRun(
      fakeProcessingTx(db),
      authority,
      inspectInput(RUN_ID),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("gm_mode_not_active");
    }
    expect(db.processingAudit).toHaveLength(1);
    expect(db.processingAudit[0]).toMatchObject({
      outcome: "gm_mode_not_active",
      companyId: COMPANY_ID,
    });
  });

  it("revoked company alpha (ended activation) is an audited refusal", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.activations[0]!.endedAtMs = 1_800_000_001_000;
    db.activations[0]!.endedByUserId = OPERATOR_ID;
    const result = await performInspectProcessingRun(
      fakeProcessingTx(db),
      authority,
      inspectInput(RUN_ID),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("company_alpha_not_active");
    }
    expect(db.processingAudit[0]).toMatchObject({ outcome: "company_alpha_not_active" });
  });
});

describe("retry (resume approved compatible work)", () => {
  it("resumes the failed group stage in place: same run identity, restart recorded, audited", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      const value = Schema.decodeUnknownSync(retryEntry.result)(result.value);
      expect(value).toMatchObject({
        runId: RUN_ID,
        stepId: STEP_ID,
        state: "running",
        restartedFrom: "group",
      });
    }
    // Semantic run identity: the SAME row returns to running; versions,
    // kind and link are untouched; no second run exists.
    const run = db.processingRuns.get(RUN_ID)!;
    expect(run.state).toBe("running");
    expect(run.finishedAtMs).toBeNull();
    expect(run.kind).toBe("initial_analysis");
    expect(run.pipelineVersion).toBe("e3.text/1");
    expect(db.processingRuns.size).toBe(1);
    expect(db.restarts).toEqual([
      { workflowId: "wf-h4-proof-0001", from: "group" },
    ]);
    expect(db.processingAudit).toHaveLength(1);
    expect(db.processingAudit[0]).toMatchObject({
      outcome: "ok",
      gmTargetRevision: `${RUN_ID}@failed`,
      processingRunId: RUN_ID,
    });
  });

  it("a stale inspected state is refused and audited (the completion race)", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.processingRuns.get(RUN_ID)!.state = "succeeded";
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("conflict");
      expect(result.error.code).toBe("run_state_stale");
    }
    expect(db.processingAudit[0]).toMatchObject({ outcome: "run_state_stale" });
    expect(db.restarts).toHaveLength(0);
  });

  it("a duplicate retry after the first is refused: stale, then already-running", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const tx = fakeProcessingTx(db);
    const first = await performRetryProcessingStep(tx, authority, retryInput(STEP_ID, "failed"));
    expect(first._tag).toBe("ok");
    // The second retry reuses the FIRST inspection's state: stale now.
    const stale = await performRetryProcessingStep(tx, authority, retryInput(STEP_ID, "failed"));
    expect(stale._tag).toBe("error");
    if (stale._tag === "error") {
      expect(stale.error.code).toBe("run_state_stale");
    }
    // Even an honest re-inspection (expected running) refuses: it runs.
    const running = await performRetryProcessingStep(tx, authority, retryInput(STEP_ID, "running"));
    expect(running._tag).toBe("error");
    if (running._tag === "error") {
      expect(running.error.code).toBe("run_already_running");
    }
    expect(db.restarts).toHaveLength(1);
    expect(db.processingAudit.map((row) => row.outcome)).toEqual([
      "ok",
      "run_state_stale",
      "run_already_running",
    ]);
  });

  it("a succeeded stage is not retryable work", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.steps.get(STEP_ID)!.state = "succeeded";
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("stage_not_failed");
    }
  });

  it("a run without workflow identity is refused as unsupported (never a false resume)", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.processingRuns.get(RUN_ID)!.checkpoint = null;
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("workflow_identity_missing");
    }
    expect(db.processingAudit[0]).toMatchObject({ outcome: "workflow_identity_missing" });
  });

  it("a run this deployment cannot resume (unknown pipeline version) is refused as unsupported", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.processingRuns.get(RUN_ID)!.pipelineVersion = "dev-proof";
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("workflow_version_unsupported");
    }
    expect(db.processingAudit[0]).toMatchObject({ outcome: "workflow_version_unsupported" });
  });

  it("revoked GM access refuses the retry with an audited refusal and no restart", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.grants.get(GRANT_ID)!.closedAtMs = 1_800_000_000_999;
    const result = await performRetryProcessingStep(
      fakeProcessingTx(db),
      authority,
      retryInput(STEP_ID, "failed"),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("gm_mode_not_active");
    }
    expect(db.restarts).toHaveLength(0);
    expect(db.processingAudit[0]).toMatchObject({ outcome: "gm_mode_not_active" });
  });
});

describe("reanalysis (a linked new run)", () => {
  it("creates the linked run, publishes the registered event and audits with the target revision", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const result = await performRequestReanalysis(
      fakeProcessingTx(db),
      authority,
      reanalysisInput(SOURCE_ID, RUN_ID),
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      const value = Schema.decodeUnknownSync(reanalysisEntry.result)(result.value);
      expect(value.reanalysisOfRunId).toBe(RUN_ID);
      const newRun = db.processingRuns.get(value.processingRunId);
      expect(newRun).toMatchObject({
        kind: "reanalysis",
        reanalysisOfRunId: RUN_ID,
        sourceId: SOURCE_ID,
        state: "running",
        pipelineVersion: "pending-e3",
      });
    }
    expect(db.reanalysisPublications).toHaveLength(1);
    expect(db.reanalysisPublications[0]).toMatchObject({
      companyId: COMPANY_ID,
      sourceId: SOURCE_ID,
      reanalysisOfRunId: RUN_ID,
    });
    expect(db.processingAudit).toHaveLength(1);
    expect(db.processingAudit[0]).toMatchObject({
      outcome: "ok",
      gmTargetRevision: `source@${RUN_ID}`,
      gmBasis: "powtórna wycena po korekcie",
    });
  });

  it("refuses a withdrawn source with an audited refusal", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    db.sources.get(SOURCE_ID)!.lifecycle = "withdrawn";
    const result = await performRequestReanalysis(
      fakeProcessingTx(db),
      authority,
      reanalysisInput(SOURCE_ID, RUN_ID),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("conflict");
      expect(result.error.code).toBe("source_not_active");
    }
    expect(db.reanalysisPublications).toHaveLength(0);
    expect(db.processingAudit[0]).toMatchObject({ outcome: "source_not_active" });
  });

  it("refuses a stale inspection: a newer run landed since the operator looked", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    seedRun(db, { runId: "k57run0009q2x9w7c1vbn8hj6t0a5q3z", startedAtMs: 1_800_000_010_000 });
    const result = await performRequestReanalysis(
      fakeProcessingTx(db),
      authority,
      reanalysisInput(SOURCE_ID, RUN_ID),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("newer_run_exists");
    }
    expect(db.reanalysisPublications).toHaveLength(0);
    expect(db.processingRuns.size).toBe(2); // nothing was created
  });

  it("audits the honest not_found refusal for an unknown source", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    const result = await performRequestReanalysis(
      fakeProcessingTx(db),
      authority,
      reanalysisInput("k57ghostsrc0q2x9w7c1vbn8hj6t0a5q", null),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
      expect(result.error.code).toBe("source_not_found");
    }
    expect(db.processingAudit[0]).toMatchObject({ outcome: "source_not_found" });
  });
});

describe("the immutability and attributability invariants", () => {
  it("no GM processing action touches the source bytes, timestamps or lifecycle", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const before = { ...db.sources.get(SOURCE_ID)! };
    const tx = fakeProcessingTx(db);
    await performInspectProcessingRun(tx, authority, inspectInput(RUN_ID));
    await performRetryProcessingStep(tx, authority, retryInput(STEP_ID, "failed"));
    // The retry moved the run to running: reanalysis would be stale now, so
    // exercise reanalysis on its own fresh world witness below instead.
    expect(db.sources.get(SOURCE_ID)).toEqual(before);
  });

  it("reanalysis leaves the source untouched too", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const before = { ...db.sources.get(SOURCE_ID)! };
    await performRequestReanalysis(fakeProcessingTx(db), authority, reanalysisInput(SOURCE_ID, RUN_ID));
    expect(db.sources.get(SOURCE_ID)).toEqual(before);
  });

  it("every audit row is attributable to the real GM actor and grant", async () => {
    const db = fakeProcessingDb();
    seedAuthority(db);
    seedFailedRun(db);
    const tx = fakeProcessingTx(db);
    await performInspectProcessingRun(tx, authority, inspectInput(RUN_ID));
    await performRetryProcessingStep(tx, authority, retryInput(STEP_ID, "failed"));
    await performRequestReanalysis(tx, authority, reanalysisInput("k57ghostsrc0q2x9w7c1vbn8hj6t0a5q", null));
    for (const row of db.processingAudit) {
      expect(row.actorUserId).toBe(OPERATOR_ID);
      expect(row.gmGrantId).toBe(GRANT_ID);
      expect(row.gmBasis.length).toBeGreaterThan(0);
      expect(row.gmTargetRevision.length).toBeGreaterThan(0);
    }
    expect(db.processingAudit.map((row) => row.operationName)).toEqual([
      "operations.inspectProcessingRun",
      "operations.retryProcessingStep",
      "operations.requestReanalysis",
    ]);
  });
});
