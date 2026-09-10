/**
 * The H4 in-memory fake of the GM processing store surfaces (tests/h4).
 *
 * Implements `ProcessingTx` over plain maps, composed over B4's fake
 * (`tests/b4/fake.ts`, imported read-only; the authority surface is
 * consumed, not duplicated). Records every effect the transactional cores
 * produce (audit rows, restarts, reanalysis publications) so the
 * atomicity/identity assertions read exact history; sources are tracked
 * with their full text row so the immutability witness compares bytes
 * before and after GM actions. Ids are TEST FIXTURE DATA constructed in
 * the seed helpers below.
 */

import { fakeGmTx, type FakeGmDb } from "../b4/fake";
import type {
  AttemptView,
  ChangeSetView,
  DiagnosticEventView,
  JobView,
  ProcessingRunView,
  SourceView,
  StepView,
} from "../../convex/operations/processing/cores";
import type { ProcessingTx } from "../../convex/operations/processing/store";

/** Strips readonly for mutable fake rows (the fake mutates what GM mutates). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The mutable run row (state/checkpoint/finishedAtMs change on retry). */
export interface FakeRunRow {
  runId: string;
  companyId: string;
  sourceId: string;
  kind: "initial_analysis" | "reanalysis";
  reanalysisOfRunId: string | null;
  pipelineVersion: string;
  promptVersion: string;
  schemaVersion: string;
  modelConfigurationVersion: string;
  state: ProcessingRunView["state"];
  checkpoint: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/** The source row with its immutable text (the immutability witness). */
export interface FakeSourceRow extends SourceView {
  readonly text: string;
  readonly fullyAcceptedAtMs: number;
}

export interface FakeProcessingDb extends FakeGmDb {
  /** This lane's run rows (B4's `runs` array stays its inspection projection). */
  processingRuns: Map<string, FakeRunRow>;
  steps: Map<string, Mutable<StepView>>;
  attempts: AttemptView[];
  /** This lane's job rows (B4's `jobs` array stays its inspection projection). */
  processingJobs: Array<JobView & { readonly runId: string }>;
  sources: Map<string, Mutable<FakeSourceRow>>;
  changeSets: Array<ChangeSetView & { readonly sourceId: string }>;
  diagnostics: DiagnosticEventView[];
  processingAudit: import("../../convex/operations/processing/store").GmProcessingAuditRow[];
  reanalysisPublications: Array<{ companyId: string; sourceId: string; newRunId: string; reanalysisOfRunId: string | null }>;
  restarts: Array<{ workflowId: string; from: "model" | "group" | "start" }>;
  nextRunId: number;
}

export function fakeProcessingDb(seed?: Partial<FakeProcessingDb>): FakeProcessingDb {
  const base: FakeProcessingDb = {
    // B4's authority tables (fakeGmTx reads them).
    users: new Map(),
    grants: new Map(),
    companies: new Map(),
    activations: [],
    invitations: [],
    memberships: [],
    runs: [],
    jobs: [],
    companyOfRun: new Map(),
    audit: [],
    // This lane's tables.
    processingRuns: new Map(),
    steps: new Map(),
    attempts: [],
    processingJobs: [],
    sources: new Map(),
    changeSets: [],
    diagnostics: [],
    processingAudit: [],
    reanalysisPublications: [],
    restarts: [],
    nextRunId: 2,
  } as unknown as FakeProcessingDb;
  return seed === undefined ? base : ({ ...base, ...seed } as FakeProcessingDb);
}

/** Representative wire-shaped ids (the pattern the contract ids carry). */
export const RUN_ID = "k57run0001q2x9w7c1vbn8hj6t0a5q3z";
export const RUN2_ID = "k57run0002q2x9w7c1vbn8hj6t0a5q3z";
export const SOURCE_ID = "k57src0001q2x9w7c1vbn8hj6t0a5q3z";
export const STEP_ID = "k57stp0001q2x9w7c1vbn8hj6t0a5q3z";
export const AUTHOR_ID = "k57usr0001q2x9w7c1vbn8hj6t0a5q3z";
export const COMPANY_ID = "k57company1";
export const GRANT_ID = "j97grant1";
export const OPERATOR_ID = "k57gmoper";

const WORKFLOW_IDENTITY = JSON.stringify({ workflowId: "wf-h4-proof-0001" });

/** Seeds one run row (defaults: a failed, retryable analysis run). */
export function seedRun(
  db: FakeProcessingDb,
  overrides: Partial<FakeRunRow> & { runId: string },
): FakeRunRow {
  const row: FakeRunRow = {
    runId: overrides.runId,
    companyId: overrides.companyId ?? COMPANY_ID,
    sourceId: overrides.sourceId ?? SOURCE_ID,
    kind: overrides.kind ?? "initial_analysis",
    reanalysisOfRunId: overrides.reanalysisOfRunId ?? null,
    pipelineVersion: overrides.pipelineVersion ?? "e3.text/1",
    promptVersion: overrides.promptVersion ?? "e3.prompt/1",
    schemaVersion: overrides.schemaVersion ?? "e3.schema/1",
    modelConfigurationVersion: overrides.modelConfigurationVersion ?? "e2.routing/1#chat_analysis",
    state: overrides.state ?? "failed",
    checkpoint: overrides.checkpoint === undefined ? WORKFLOW_IDENTITY : overrides.checkpoint,
    startedAtMs: overrides.startedAtMs ?? 1_800_000_000_000,
    finishedAtMs: overrides.finishedAtMs === undefined ? 1_800_000_000_500 : overrides.finishedAtMs,
  };
  db.processingRuns.set(row.runId, row);
  db.companyOfRun.set(row.runId, row.companyId);
  return row;
}

/** Seeds one source row (defaults: an active, processed source). */
export function seedSource(
  db: FakeProcessingDb,
  overrides: Partial<FakeSourceRow> = {},
): FakeSourceRow {
  const row: FakeSourceRow = {
    sourceId: overrides.sourceId ?? SOURCE_ID,
    companyId: overrides.companyId ?? COMPANY_ID,
    authorUserId: overrides.authorUserId ?? AUTHOR_ID,
    lifecycle: overrides.lifecycle ?? "active",
    processingState: overrides.processingState ?? "failed",
    sentAtMs: overrides.sentAtMs ?? 1_800_000_000_000,
    text: overrides.text ?? "Projekt Banan: dowóz płytek w środę rano.",
    fullyAcceptedAtMs: overrides.fullyAcceptedAtMs ?? 1_800_000_000_002,
  };
  db.sources.set(row.sourceId, row);
  return row;
}

/** Seeds one step row (defaults: a failed publish_group stage). */
export function seedStep(
  db: FakeProcessingDb,
  overrides: Partial<StepView> = {},
): StepView {
  const row: StepView = {
    stepId: overrides.stepId ?? STEP_ID,
    runId: overrides.runId ?? RUN_ID,
    sequence: overrides.sequence ?? 1_000,
    stepKind: overrides.stepKind ?? "publish_group",
    state: overrides.state ?? "failed",
    startedAtMs: overrides.startedAtMs ?? 1_800_000_000_100,
    finishedAtMs: overrides.finishedAtMs ?? 1_800_000_000_200,
  };
  db.steps.set(row.stepId, row);
  return row;
}

/** Builds the fake ProcessingTx over one FakeProcessingDb. */
export function fakeProcessingTx(db: FakeProcessingDb): ProcessingTx {
  const base = fakeGmTx(db);
  const nextRun = () => (db.nextRunId = (db.nextRunId ?? 2) + 1);
  return {
    ...base,
    runById: async (runId) => db.processingRuns.get(runId) ?? null,
    stepById: async (stepId) => db.steps.get(stepId) ?? null,
    stepsOfRun: async (runId) =>
      [...db.steps.values()]
        .filter((row) => row.runId === runId)
        .sort((a, b) => a.sequence - b.sequence),
    attemptsOfSteps: async (stepIds) =>
      db.attempts
        .filter((row) => stepIds.includes(row.stepId))
        .sort((a, b) => a.attempt - b.attempt),
    jobsOfRun: async (runId) =>
      db.processingJobs
        .filter((row) => row.runId === runId)
        .map(({ runId: _runId, ...job }) => job)
        .slice(0, 10),
    sourceById: async (sourceId) => {
      const row = db.sources.get(sourceId);
      if (row === undefined) {
        return null;
      }
      const { text: _text, fullyAcceptedAtMs: _accepted, ...view } = row;
      return view;
    },
    latestRunOfSource: async (sourceId) => {
      const runs = [...db.processingRuns.values()]
        .filter((row) => row.sourceId === sourceId)
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      return runs[0] ?? null;
    },
    changeSetsOfSource: async (sourceId, limit) =>
      db.changeSets
        .filter((row) => row.sourceId === sourceId)
        .slice(0, limit)
        .map(({ sourceId: _sourceId, ...change }) => change),
    recentDiagnostics: async (limit) => db.diagnostics.slice(0, limit),
    patchRunRunning: async (runId) => {
      const row = db.processingRuns.get(runId);
      if (row === undefined) {
        return false;
      }
      row.state = "running";
      row.finishedAtMs = null;
      return true;
    },
    restartRunWorkflow: async (workflowId, from) => {
      db.restarts.push({ workflowId, from });
    },
    insertReanalysisRun: async (row) => {
      const runId = `k57reanalysis${nextRun()}q2x9w7c1vbn8hj6t0`;
      db.processingRuns.set(runId, {
        runId,
        companyId: row.companyId,
        sourceId: row.sourceId,
        kind: "reanalysis",
        reanalysisOfRunId: row.reanalysisOfRunId,
        pipelineVersion: "pending-e3",
        promptVersion: "none",
        schemaVersion: "none",
        modelConfigurationVersion: "none",
        state: "running",
        checkpoint: null,
        startedAtMs: row.startedAtMs,
        finishedAtMs: null,
      });
      db.companyOfRun.set(runId, row.companyId);
      return runId;
    },
    publishReanalysisRequested: async (publication) => {
      db.reanalysisPublications.push({ ...publication });
      return `evt-${publication.newRunId}`;
    },
    insertProcessingAudit: async (row) => {
      db.processingAudit.push({ ...row });
    },
  };
}
