/**
 * GM processing transactions (H4): the write halves of the cores, each
 * inside ONE Convex mutation; and each writing its protected audit row in
 * the SAME transaction as its effect (the B4 atomicity contract: real GM
 * actor, grant, basis, command outcome, target revision and timestamps).
 *
 * ATOMICITY (B4's discipline): every step that can throw (lookups, schema
 * decodes) runs BEFORE the first write; between the first write and the
 * return only pre-validated writes and total decodes of transaction-
 * generated values remain. DENIED attempts under a VALID authority still
 * audit (outcome = the closed error code), so the protected trail records
 * refusals; attempts without any open grant have no grant to attribute and
 * fail closed (nothing GM-attributable happened).
 *
 * Authority is B4's, consumed not duplicated: the acting grant and the
 * per-company access (open grant + existing company + OPEN alpha
 * activation) are re-derived inside every transaction, so racing an exit,
 * an alpha-ending or a revocation denies at commit (OCC-serialized).
 */

import { Schema } from "effect";
import {
  errorResult,
  okResult,
  operationsOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  forbiddenError,
  unsupportedError,
  validationError,
} from "@kiero/runtime";
import {
  COMPANY_NOT_FOUND,
  GM_MODE_NOT_ACTIVE,
  decideGmCompanyAccess,
  gmGrantOpen,
  normalizeGmStatement,
  type GmActivationView,
  type GmCompanyAccessDenial,
} from "../../access/gm/cores";
import type { GmAuthority } from "../../access/gm/operations";
import type { GmCompanyView } from "../../access/gm/store";
import type { ProcessingTx } from "./store";
import {
  DIAGNOSTIC_SCAN_ROWS,
  MAX_INSPECT_ATTEMPTS,
  MAX_INSPECT_CHANGE_SETS,
  MAX_INSPECT_DIAGNOSTICS,
  MAX_INSPECT_STEPS,
  deriveBlockers,
  diagnosticsForTarget,
  isPipelineStage,
  parseWorkflowIdentity,
  restartTargetOfStep,
  runTargetRevision,
  sourceTargetRevision,
  decideReanalysisTarget,
  decideRetry,
} from "./cores";

// The contract entries these transactions implement (decode authority).
export const inspectProcessingRunEntry = operationsOperations["operations.inspectProcessingRun"];
export const retryProcessingStepEntry = operationsOperations["operations.retryProcessingStep"];
export const requestReanalysisEntry = operationsOperations["operations.requestReanalysis"];

/** Reads the acting grant in-transaction; B4's current-authority rule. */
async function actingGrantOpen(tx: ProcessingTx, authority: GmAuthority): Promise<boolean> {
  const grant = await tx.grantById(authority.grantId);
  return grant !== null && grant.userId === authority.userId && gmGrantOpen(grant);
}

/**
 * The audited refusal every denied GM processing operation returns: the
 * trail records the attempt under the acting grant with the closed outcome
 * code and the operator's stated target revision; the envelope maps the
 * denial without leaking target data.
 */
async function refuseProcessing(
  tx: ProcessingTx,
  authority: GmAuthority,
  args: {
    readonly operationName: string;
    readonly basis: string;
    readonly companyId: string | null;
    readonly processingRunId: string | null;
    readonly gmTargetRevision: string;
    readonly denial: GmCompanyAccessDenial;
  },
): Promise<ResultEnvelope> {
  await tx.insertProcessingAudit({
    actorUserId: authority.userId,
    gmGrantId: authority.grantId,
    companyId: args.companyId,
    operationName: args.operationName,
    gmBasis: args.basis,
    outcome: args.denial.code,
    gmTargetRevision: args.gmTargetRevision,
    processingRunId: args.processingRunId,
    atMs: Date.now(),
  });
  if (args.denial.kind === "not_found") {
    return errorResult(notFoundError("companies", args.denial.code));
  }
  return errorResult(
    forbiddenError(args.denial.code, args.denial.code === "gm_mode_not_active" ? "gm" : "company"),
  );
}

/** Writes the ok-side audit row in the caller's transaction. */
async function auditOk(
  tx: ProcessingTx,
  authority: GmAuthority,
  args: {
    readonly operationName: string;
    readonly basis: string;
    readonly companyId: string | null;
    readonly processingRunId: string | null;
    readonly gmTargetRevision: string;
  },
): Promise<void> {
  await tx.insertProcessingAudit({
    actorUserId: authority.userId,
    gmGrantId: authority.grantId,
    companyId: args.companyId,
    operationName: args.operationName,
    gmBasis: args.basis,
    outcome: "ok",
    gmTargetRevision: args.gmTargetRevision,
    processingRunId: args.processingRunId,
    atMs: Date.now(),
  });
}

/** The per-company authority decision over one target company (B4's rule). */
async function companyAccess(
  tx: ProcessingTx,
  args: { readonly grantOpen: boolean; readonly companyId: string },
): Promise<
  | { readonly ok: true; readonly company: GmCompanyView; readonly activation: GmActivationView }
  | { readonly ok: false; readonly company: GmCompanyView | null; readonly denial: GmCompanyAccessDenial }
> {
  const company = await tx.companyById(args.companyId);
  const activation = await tx.openActivationOf(args.companyId);
  const decision = decideGmCompanyAccess({
    grantOpen: args.grantOpen,
    companyExists: company !== null,
    activation,
  });
  if (!decision.ok) {
    return {
      ok: false,
      company,
      denial: decision,
    };
  }
  return { ok: true, company: company!, activation: activation! };
}

// ---------------------------------------------------------------------------
// Inspection (the audited read)
// ---------------------------------------------------------------------------

/**
 * The audited GM inspection read over one processing run: the canonical
 * run/step/attempt records (with versions and the approved model route),
 * the protected source detail (ids and states, never content), the run's
 * durable jobs, the source's derived change sets, the I2 redacted
 * diagnostics naming this run/source, and the derived blocker list.
 */
export async function performInspectProcessingRun(
  tx: ProcessingTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof inspectProcessingRunEntry.input>,
): Promise<ResultEnvelope> {
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const run = await tx.runById(input.processingRunId);
  if (run === null) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: null,
      operationName: "operations.inspectProcessingRun",
      gmBasis: basis.value,
      outcome: "processing_run_not_found",
      gmTargetRevision: runTargetRevision(input.processingRunId, "unknown"),
      processingRunId: null,
      atMs: Date.now(),
    });
    return errorResult(notFoundError("processingRuns", "processing_run_not_found"));
  }
  const access = await companyAccess(tx, {
    grantOpen: await actingGrantOpen(tx, authority),
    companyId: run.companyId,
  });
  if (!access.ok) {
    return await refuseProcessing(tx, authority, {
      operationName: "operations.inspectProcessingRun",
      basis: basis.value,
      companyId: access.company === null ? null : access.company.id,
      processingRunId: run.runId,
      gmTargetRevision: runTargetRevision(run.runId, run.state),
      denial: access.denial,
    });
  }

  const source = await tx.sourceById(run.sourceId);
  if (source === null) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: run.companyId,
      operationName: "operations.inspectProcessingRun",
      gmBasis: basis.value,
      outcome: "source_not_found",
      gmTargetRevision: runTargetRevision(run.runId, run.state),
      processingRunId: run.runId,
      atMs: Date.now(),
    });
    return errorResult(notFoundError("sources", "source_not_found"));
  }
  const steps = (await tx.stepsOfRun(run.runId))
    .filter(isPipelineStage)
    .slice(0, MAX_INSPECT_STEPS);
  const attempts = (
    await tx.attemptsOfSteps(steps.map((step) => step.stepId))
  ).slice(0, MAX_INSPECT_ATTEMPTS);
  const jobs = await tx.jobsOfRun(run.runId);
  const derivedChanges = await tx.changeSetsOfSource(run.sourceId, MAX_INSPECT_CHANGE_SETS);
  const diagnostics = diagnosticsForTarget(
    await tx.recentDiagnostics(DIAGNOSTIC_SCAN_ROWS),
    run.runId,
    run.sourceId,
    MAX_INSPECT_DIAGNOSTICS,
  );
  const blockers = deriveBlockers({ run, source, steps, jobs });

  await auditOk(tx, authority, {
    operationName: "operations.inspectProcessingRun",
    basis: basis.value,
    companyId: run.companyId,
    processingRunId: run.runId,
    gmTargetRevision: runTargetRevision(run.runId, run.state),
  });
  return okResult(
    Schema.decodeUnknownSync(inspectProcessingRunEntry.result)({
      run: {
        runId: run.runId,
        sourceId: run.sourceId,
        companyId: run.companyId,
        kind: run.kind,
        reanalysisOfRunId: run.reanalysisOfRunId,
        state: run.state,
        pipelineVersion: run.pipelineVersion,
        promptVersion: run.promptVersion,
        schemaVersion: run.schemaVersion,
        modelConfigurationVersion: run.modelConfigurationVersion,
        startedAtMs: run.startedAtMs,
        finishedAtMs: run.finishedAtMs,
      },
      source: {
        sourceId: source.sourceId,
        authorUserId: source.authorUserId,
        lifecycle: source.lifecycle,
        processingState: source.processingState,
        sentAtMs: source.sentAtMs,
      },
      steps: steps.map((step) => ({
        stepId: step.stepId,
        sequence: step.sequence,
        stepKind: step.stepKind,
        state: step.state,
        startedAtMs: step.startedAtMs,
        finishedAtMs: step.finishedAtMs,
      })),
      attempts: attempts.map((attempt) => ({
        stepId: attempt.stepId,
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        provider: attempt.provider,
        model: attempt.model,
        errorKind: attempt.errorKind,
        startedAtMs: attempt.startedAtMs,
        finishedAtMs: attempt.finishedAtMs,
      })),
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        kind: job.kind,
        state: job.state,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lastErrorKind: job.lastErrorKind,
        externalOutcome: job.externalOutcome,
      })),
      derivedChanges: derivedChanges.map((change) => ({
        changeSetId: change.changeSetId,
        state: change.state,
        preparedAtMs: change.preparedAtMs,
        publishedAtMs: change.publishedAtMs,
        failedReason: change.failedReason,
      })),
      diagnostics: diagnostics.map((event) => ({
        kind: event.kind,
        metadata: event.metadata.map((entry) => ({ key: entry.key, value: entry.value })),
        redactionsApplied: event.redactionsApplied,
        atMs: event.atMs,
      })),
      blockers: blockers.map((blocker) => ({
        code: blocker.code,
        detail: blocker.detail,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Retry (resume approved compatible work; same run identity)
// ---------------------------------------------------------------------------

/**
 * The audited GM retry: resumes the run's workflow from its journal after
 * the operator's inspected-state guard. The run row returns to running IN
 * PLACE (same id, kind, versions and journal; semantic run identity); the
 * immutable source is never touched and no model is selected.
 */
export async function performRetryProcessingStep(
  tx: ProcessingTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof retryProcessingStepEntry.input>,
): Promise<ResultEnvelope> {
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const step = await tx.stepById(input.stepId);
  if (step === null) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: null,
      operationName: "operations.retryProcessingStep",
      gmBasis: basis.value,
      outcome: "processing_step_not_found",
      gmTargetRevision: runTargetRevision(input.stepId, input.expectedRunState),
      processingRunId: null,
      atMs: Date.now(),
    });
    return errorResult(notFoundError("processingSteps", "processing_step_not_found"));
  }
  const run = await tx.runById(step.runId);
  if (run === null) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: null,
      operationName: "operations.retryProcessingStep",
      gmBasis: basis.value,
      outcome: "processing_run_not_found",
      gmTargetRevision: runTargetRevision(step.runId, input.expectedRunState),
      processingRunId: null,
      atMs: Date.now(),
    });
    return errorResult(notFoundError("processingRuns", "processing_run_not_found"));
  }
  const access = await companyAccess(tx, {
    grantOpen: await actingGrantOpen(tx, authority),
    companyId: run.companyId,
  });
  if (!access.ok) {
    return await refuseProcessing(tx, authority, {
      operationName: "operations.retryProcessingStep",
      basis: basis.value,
      companyId: access.company === null ? null : access.company.id,
      processingRunId: run.runId,
      gmTargetRevision: runTargetRevision(run.runId, input.expectedRunState),
      denial: access.denial,
    });
  }

  const decision = decideRetry({
    runState: run.state,
    stepState: step.state,
    expectedRunState: input.expectedRunState,
    pipelineVersion: run.pipelineVersion,
    workflowId: parseWorkflowIdentity(run.checkpoint),
  });
  if (!decision.ok) {
    // The audited refusal: the closed code records exactly which guard
    // refused (stale revision, already-running stage, unsupported version).
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: run.companyId,
      operationName: "operations.retryProcessingStep",
      gmBasis: basis.value,
      outcome: decision.code,
      gmTargetRevision: runTargetRevision(run.runId, input.expectedRunState),
      processingRunId: run.runId,
      atMs: Date.now(),
    });
    if (decision.kind === "unsupported") {
      return errorResult(unsupportedError("operations.retryProcessingStep", decision.code));
    }
    return errorResult(conflictError(decision.code));
  }

  const workflowId = parseWorkflowIdentity(run.checkpoint)!;
  const target = restartTargetOfStep(step.stepKind);
  await tx.patchRunRunning(run.runId);
  await tx.restartRunWorkflow(workflowId, target);
  await auditOk(tx, authority, {
    operationName: "operations.retryProcessingStep",
    basis: basis.value,
    companyId: run.companyId,
    processingRunId: run.runId,
    gmTargetRevision: runTargetRevision(run.runId, input.expectedRunState),
  });
  return okResult(
    Schema.decodeUnknownSync(retryProcessingStepEntry.result)({
      runId: run.runId,
      stepId: step.stepId,
      state: "running",
      restartedFrom: target,
    }),
  );
}

// ---------------------------------------------------------------------------
// Reanalysis (a linked new run, server-approved configuration)
// ---------------------------------------------------------------------------

/**
 * The audited GM reanalysis request: creates a linked NEW run over the same
 * immutable source and publishes `operations.reanalysisRequested` (the
 * registered consumer edge registers the analysis job; the workflow pins
 * the server-approved E3/E2 versions itself; no model selection exists
 * anywhere in this path). Provenance is the new run's own: kind
 * "reanalysis" plus the link to the run it repeats.
 */
export async function performRequestReanalysis(
  tx: ProcessingTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof requestReanalysisEntry.input>,
): Promise<ResultEnvelope> {
  const basis = normalizeGmStatement(input.reason);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const source = await tx.sourceById(input.sourceId);
  if (source === null) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: null,
      operationName: "operations.requestReanalysis",
      gmBasis: basis.value,
      outcome: "source_not_found",
      gmTargetRevision: sourceTargetRevision(input.expectedLatestRunId),
      processingRunId: null,
      atMs: Date.now(),
    });
    return errorResult(notFoundError("sources", "source_not_found"));
  }
  const access = await companyAccess(tx, {
    grantOpen: await actingGrantOpen(tx, authority),
    companyId: source.companyId,
  });
  if (!access.ok) {
    return await refuseProcessing(tx, authority, {
      operationName: "operations.requestReanalysis",
      basis: basis.value,
      companyId: access.company === null ? null : access.company.id,
      processingRunId: null,
      gmTargetRevision: sourceTargetRevision(input.expectedLatestRunId),
      denial: access.denial,
    });
  }

  const latest = await tx.latestRunOfSource(source.sourceId);
  const latestRunId = latest === null ? null : latest.runId;
  const decision = decideReanalysisTarget({
    lifecycle: source.lifecycle,
    expectedLatestRunId: input.expectedLatestRunId,
    latestRunId,
  });
  if (!decision.ok) {
    await tx.insertProcessingAudit({
      actorUserId: authority.userId,
      gmGrantId: authority.grantId,
      companyId: source.companyId,
      operationName: "operations.requestReanalysis",
      gmBasis: basis.value,
      outcome: decision.code,
      gmTargetRevision: sourceTargetRevision(input.expectedLatestRunId),
      processingRunId: null,
      atMs: Date.now(),
    });
    return errorResult(conflictError(decision.code));
  }

  const nowMs = Date.now();
  const newRunId = await tx.insertReanalysisRun({
    companyId: source.companyId,
    sourceId: source.sourceId,
    reanalysisOfRunId: latestRunId,
    startedAtMs: nowMs,
  });
  await tx.publishReanalysisRequested({
    companyId: source.companyId,
    sourceId: source.sourceId,
    newRunId,
    reanalysisOfRunId: latestRunId,
  });
  await auditOk(tx, authority, {
    operationName: "operations.requestReanalysis",
    basis: basis.value,
    companyId: source.companyId,
    processingRunId: newRunId,
    gmTargetRevision: sourceTargetRevision(latestRunId),
  });
  return okResult(
    Schema.decodeUnknownSync(requestReanalysisEntry.result)({
      processingRunId: newRunId,
      reanalysisOfRunId: latestRunId,
    }),
  );
}

// Re-exported so the dispatch's refusal path shares B4's denial spellings.
export { COMPANY_NOT_FOUND, GM_MODE_NOT_ACTIVE };
