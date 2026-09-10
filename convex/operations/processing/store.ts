/**
 * The GM processing transaction store surface (H4).
 *
 * Extends B4's `GmTx` (the GM authority reads/writes: grant, company,
 * activation, audit) with the processing reads and writes this lane's
 * transactional cores need, following the same discipline: plain-string ids
 * (the Convex adapter normalizes branded ids exactly once), direct
 * per-entity methods, no query-chain types; so an in-memory fake
 * (tests/h4) implements it line by line and the cores stay unit-testable
 * without a deployment.
 *
 * Projections stay bounded and payload-free: inspection reads carry ids,
 * states, versions and sanitized closed kinds, never source content or job
 * input payloads.
 */

import type { GmTx } from "../../access/gm/store";
import type {
  AttemptView,
  ChangeSetView,
  DiagnosticEventView,
  JobView,
  ProcessingRunView,
  SourceView,
  StepView,
} from "./cores";

/** The GM processing audit row (B4's shape plus this lane's target). */
export interface GmProcessingAuditRow {
  readonly actorUserId: string;
  readonly gmGrantId: string;
  readonly companyId: string | null;
  readonly operationName: string;
  readonly gmBasis: string;
  readonly outcome: string;
  /** The operator's stated target revision (cores' targetRevision strings). */
  readonly gmTargetRevision: string;
  /** The run the operation targeted, when it is run-scoped. */
  readonly processingRunId: string | null;
  readonly atMs: number;
}

/** The reanalysis run the insertion writes. */
export interface ReanalysisRunInsert {
  readonly companyId: string;
  readonly sourceId: string;
  readonly reanalysisOfRunId: string | null;
  readonly startedAtMs: number;
}

/** The reanalysis event publication (the registered consumer edge). */
export interface ReanalysisPublication {
  readonly companyId: string;
  readonly sourceId: string;
  readonly newRunId: string;
  readonly reanalysisOfRunId: string | null;
}

/** The read+write surface the GM processing transactional cores consume. */
export interface ProcessingTx extends GmTx {
  runById(runId: string): Promise<ProcessingRunView | null>;
  stepById(stepId: string): Promise<StepView | null>;
  stepsOfRun(runId: string): Promise<StepView[]>;
  attemptsOfSteps(stepIds: readonly string[]): Promise<AttemptView[]>;
  jobsOfRun(runId: string, limit: number): Promise<JobView[]>;
  sourceById(sourceId: string): Promise<SourceView | null>;
  latestRunOfSource(sourceId: string): Promise<ProcessingRunView | null>;
  changeSetsOfSource(sourceId: string, limit: number): Promise<ChangeSetView[]>;
  recentDiagnostics(limit: number): Promise<DiagnosticEventView[]>;
  /** Returns the run to running before the workflow resumes (same identity). */
  patchRunRunning(runId: string): Promise<boolean>;
  /** Resumes the run's workflow from its journal; `from: "start"` means a
   * full restart (journal replay re-executes only unjournaled steps). */
  restartRunWorkflow(workflowId: string, from: "model" | "group" | "start"): Promise<void>;
  insertReanalysisRun(row: ReanalysisRunInsert): Promise<string>;
  publishReanalysisRequested(publication: ReanalysisPublication): Promise<string>;
  insertProcessingAudit(row: GmProcessingAuditRow): Promise<void>;
}
