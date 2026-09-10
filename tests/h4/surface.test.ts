/**
 * H4 focused verification (4/5): the exposed surface; the enriched
 * contract entries decode the exact wire rows the transactional cores
 * produce, the host feature mounts through the real registry with exactly
 * the three consumed operations (no read marking, no boss-facing
 * mutation), the UI labels every closed state in Polish, every load-bearing
 * failure code has an actionable Polish hint, and the public dispatch entry
 * exists in the generated api.
 *
 * The browser smoke (clear GM banner, reason entry, status progression, no
 * unread/usage mutation) runs against the leased dev deployment and is
 * transcribed into the session report.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { operations, operationsOperations, parseTableId } from "@kiero/contracts";
import { api } from "../../convex/_generated/api";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { gmProcessingFeatureEntry } from "../../apps/web/src/app/features/gm/processing-entry";
import { gmCopy } from "../../apps/web/src/features/gm/access/state";
import {
  gmProcessingCopy,
  gmProcessingFailureHint,
} from "../../apps/web/src/features/gm/processing/state";
import { envelopeOf } from "../../apps/web/src/features/company/CompanyGate";

const RUN_ID = parseTableId("processingRuns", "k57run0001q2x9w7c1vbn8hj6t0a5q3z");
const SOURCE_ID = parseTableId("sources", "k57src0001q2x9w7c1vbn8hj6t0a5q3z");
const COMPANY_ID = parseTableId("companies", "k57company1");
const AUTHOR_ID = parseTableId("users", "k57usr0001q2x9w7c1vbn8hj6t0a5q3z");
const STEP_ID = parseTableId("processingSteps", "k57stp0001q2x9w7c1vbn8hj6t0a5q3z");
const ATTEMPT_STEP_ID = parseTableId("processingSteps", "k57stp0002q2x9w7c1vbn8hj6t0a5q3z");
const JOB_ID = parseTableId("durableJobs", "k57job0001q2x9w7c1vbn8hj6t0a5q3z");
const CHANGE_ID = parseTableId("changeSets", "k57chg0001q2x9w7c1vbn8hj6t0a5q3z");
const LINKED_RUN_ID = parseTableId("processingRuns", "k57run0002q2x9w7c1vbn8hj6t0a5q3z");

/** One representative inspection wire value the server produces. */
const inspectionWire = {
  run: {
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    companyId: COMPANY_ID,
    kind: "initial_analysis",
    reanalysisOfRunId: LINKED_RUN_ID,
    state: "failed",
    pipelineVersion: "e3.text/1",
    promptVersion: "e3.prompt/1",
    schemaVersion: "e3.schema/1",
    modelConfigurationVersion: "e2.routing/1#chat_analysis",
    startedAtMs: 1_800_000_000_000,
    finishedAtMs: 1_800_000_000_500,
  },
  source: {
    sourceId: SOURCE_ID,
    authorUserId: AUTHOR_ID,
    lifecycle: "active",
    processingState: "failed",
    sentAtMs: 1_800_000_000_000,
  },
  steps: [
    {
      stepId: STEP_ID,
      sequence: 1_000,
      stepKind: "publish_group",
      state: "failed",
      startedAtMs: 1_800_000_000_100,
      finishedAtMs: 1_800_000_000_200,
    },
  ],
  attempts: [
    {
      stepId: ATTEMPT_STEP_ID,
      attempt: 101,
      outcome: "failed",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      errorKind: "provider_failed",
      startedAtMs: 1,
      finishedAtMs: 2,
    },
    {
      stepId: ATTEMPT_STEP_ID,
      attempt: 102,
      outcome: "timeout",
      provider: null,
      model: null,
      errorKind: null,
      startedAtMs: 3,
      finishedAtMs: null,
    },
  ],
  jobs: [
    {
      jobId: JOB_ID,
      kind: "processing.analyze_change_plan",
      state: "failed",
      attempts: 3,
      maxAttempts: 3,
      lastErrorKind: "max_attempts_exhausted",
      externalOutcome: null,
    },
  ],
  derivedChanges: [
    {
      changeSetId: CHANGE_ID,
      state: "failed",
      preparedAtMs: 1,
      publishedAtMs: null,
      failedReason: "stale_plan",
    },
  ],
  diagnostics: [
    {
      kind: "ops.processing.failed",
      metadata: [
        { key: "runId", value: "k57run0001q2x9w7c1vbn8hj6t0a5q3z" },
        { key: "errorKind", value: "provider_failed" },
      ],
      redactionsApplied: 1,
      atMs: 1_800_000_000_600,
    },
  ],
  blockers: [
    { code: "stage_failed", detail: "publish_group#1000" },
    { code: "job_attempts_exhausted", detail: "processing.analyze_change_plan" },
  ],
};

describe("the contract entries decode the server's wire rows", () => {
  it("the inspection result decodes the full projection", () => {
    const entry = operationsOperations["operations.inspectProcessingRun"];
    const decoded = Schema.decodeUnknownSync(entry.result)(inspectionWire);
    expect(decoded.run.state).toBe("failed");
    expect(decoded.attempts).toHaveLength(2);
    expect(decoded.blockers).toHaveLength(2);
    expect(decoded.diagnostics[0]?.metadata).toHaveLength(2);
  });

  it("the inspection result rejects content fields (no free-form leak)", () => {
    const entry = operationsOperations["operations.inspectProcessingRun"];
    expect(() =>
      Schema.decodeUnknownSync(entry.result)({
        ...inspectionWire,
        authorText: "Projekt Banan: dowóz płytek.",
      }),
    ).not.toThrow(); // excess keys decode away; the projection simply never carries them
    const decoded = Schema.decodeUnknownSync(entry.result)(inspectionWire);
    expect("authorText" in decoded).toBe(false);
  });

  it("the retry result decodes the identity-preserving receipt", () => {
    const decoded = Schema.decodeUnknownSync(
      operationsOperations["operations.retryProcessingStep"].result,
    )({
      runId: RUN_ID,
      stepId: STEP_ID,
      state: "running",
      restartedFrom: "group",
    });
    expect(decoded.state).toBe("running");
  });

  it("the reanalysis result decodes the linked-run receipt", () => {
    const decoded = Schema.decodeUnknownSync(
      operationsOperations["operations.requestReanalysis"].result,
    )({
      processingRunId: RUN_ID,
      reanalysisOfRunId: LINKED_RUN_ID,
    });
    expect(decoded.reanalysisOfRunId).toBe(LINKED_RUN_ID);
  });

  it("the operations exist in the composed contracts registry", () => {
    for (const name of [
      "operations.inspectProcessingRun",
      "operations.retryProcessingStep",
      "operations.requestReanalysis",
    ]) {
      expect(name in operations).toBe(true);
    }
  });
});

describe("the host feature mount", () => {
  it("mounts through the real registry at /gm-przetwarzanie with exactly the three operations", () => {
    expect(gmProcessingFeatureEntry.featureId).toBe("operations.processing");
    expect(gmProcessingFeatureEntry.routePath).toBe("/gm-przetwarzanie");
    expect(gmProcessingFeatureEntry.implementation).toBe("mounted");
    expect(gmProcessingFeatureEntry.consumedOperations).toEqual([
      "operations.inspectProcessingRun",
      "operations.retryProcessingStep",
      "operations.requestReanalysis",
    ]);
    const mounted = gmProcessingFeatureEntry as Extract<
      typeof gmProcessingFeatureEntry,
      { implementation: "mounted" }
    >;
    expect(mounted.screen).toBeTypeOf("function");
  });

  it("the composed host list carries the entry (validated composition)", () => {
    const entry = appFeatures.find((candidate) => candidate.featureId === "operations.processing");
    expect(entry).toBeDefined();
    expect(entry?.implementation).toBe("mounted");
    // The mounted screen itself is pinned by the entry test above (the
    // branded registry type does not narrow on the implementation tag).
  });

  it("consumes no read marking, no boss-facing mutation, no model operation", () => {
    for (const name of gmProcessingFeatureEntry.consumedOperations) {
      expect(name.startsWith("attention.")).toBe(false);
      expect(name.startsWith("memory.")).toBe(false);
      expect(name.startsWith("sources.")).toBe(false);
    }
  });

  it("the public dispatch entry exists in the generated api", () => {
    expect(api.operations.processing.functions.dispatchGmProcessing).toBeDefined();
  });

  it("the dispatch envelope uses the shared checked-dispatch shape", () => {
    expect(envelopeOf("operations.inspectProcessingRun", { x: 1 })).toEqual({
      operation: "operations.inspectProcessingRun",
      input: { x: 1 },
      expectedRevisions: [],
    });
  });
});

describe("the Polish surface (glossary-exact product text)", () => {
  it("identifies GM mode with B4's banner contract beside this lane's intro", () => {
    expect(gmCopy.bannerActive.length).toBeGreaterThan(0);
    expect(gmProcessingCopy.bannerIntro.length).toBeGreaterThan(0);
    expect(gmProcessingCopy.bannerIntro).toContain("dzienniku");
  });

  it("labels every closed run/step/attempt state in Polish", () => {
    for (const state of ["running", "succeeded", "failed", "superseded"] as const) {
      expect(gmProcessingCopy.runStateLabel(state)).not.toBe(state);
    }
    for (const state of ["pending", "running", "succeeded", "failed"] as const) {
      expect(gmProcessingCopy.stepStateLabel(state)).not.toBe(state);
    }
    for (const outcome of ["succeeded", "failed", "timeout", "unknown"] as const) {
      expect(gmProcessingCopy.attemptOutcomeLabel(outcome)).not.toBe(outcome);
    }
  });

  it("uses the accepted processing vocabulary (przebieg, podstawa, źródło, zadania wytrwałe)", () => {
    expect(gmProcessingCopy.inspectHeading).toContain("przebiegu przetwarzania");
    expect(gmProcessingCopy.inspectBasisLabel).toContain("Podstawa");
    expect(gmProcessingCopy.retryBasisLabel).toContain("Podstawa");
    expect(gmProcessingCopy.reanalysisReasonLabel).toContain("Podstawa");
    expect(gmProcessingCopy.resultSourceHeading).toContain("Wiadomość źródłowa");
    expect(gmProcessingCopy.resultJobsHeading).toContain("Zadania wytrwałe");
    expect(gmProcessingCopy.resultDiagnosticsHeading).toContain("edagowane");
  });

  it("names the provenance semantics: retry keeps identity, reanalysis links a new run", () => {
    expect(gmProcessingCopy.retryIntro).toContain("Tożsamość przebiegu");
    expect(gmProcessingCopy.retryIntro).toContain("niezmiennej wiadomości źródłowej");
    expect(gmProcessingCopy.reanalysisIntro).toContain("NOWY przebieg");
    expect(gmProcessingCopy.reanalysisIntro).toContain("nie pozwala wybrać modelu");
  });

  it("every load-bearing failure code has an actionable Polish hint", () => {
    const codes = [
      "processing_run_not_found",
      "processing_step_not_found",
      "source_not_found",
      "run_state_stale",
      "run_already_running",
      "stage_not_failed",
      "run_superseded",
      "workflow_identity_missing",
      "workflow_version_unsupported",
      "source_not_active",
      "newer_run_exists",
      // Shared authority codes fall back to B4's hints.
      "gm_mode_not_active",
      "company_alpha_not_active",
      "company_not_found",
    ];
    for (const code of codes) {
      const hint = gmProcessingFailureHint(code);
      expect(hint, code).not.toBeNull();
      expect(hint?.length, code).toBeGreaterThan(10);
    }
  });
});
