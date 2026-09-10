/**
 * The analysis context shape (E3): the tenant-filtered, bounded snapshot of
 * current structured state one text-analysis run reads (protocol step 6:
 * "Read relevant current structured state ... and record the revisions used
 * in a change plan").
 *
 * The Convex loader (convex/processing/text/analysisContext.ts) builds this
 * from company-scoped reads only; this module owns the SHAPE and the pure
 * derivations over it, so every planning decision is testable without a
 * deployment.
 *
 * `findings[].revisionCounter` is the load-bearing honesty field: the
 * revision the ANALYSIS used. The publish stage passes exactly these as the
 * CALLER expectations of `memory.publishChangeSet`, so a correction that
 * lands mid-run (or before a paused plan publishes) refuses the plan instead
 * of overwriting the newer truth (C2's stale-plan guard; issue #8).
 */

import type { CoverageSnapshot } from "./coverage";

/** One project the analysis may attribute information to. */
export interface ContextProject {
  readonly projectId: string;
  readonly displayName: string;
  /** The active codename, when one exists ("Banan"); null while only `#n`. */
  readonly codename: string | null;
}

/** The scope of one finding or proposal: firm-wide memory or one project. */
export type ContextScope =
  | { readonly kind: "company" }
  | { readonly kind: "project"; readonly projectId: string };

/** One current finding row as the analysis sees it (wire value form). */
export interface ContextFinding {
  readonly findingId: string;
  readonly scope: ContextScope;
  readonly semanticKey: string;
  /**
   * The revision counter AT LOAD TIME. Recorded with every plan as the
   * input-revision version of the run; the publish stage passes these as
   * caller expectations.
   */
  readonly revisionCounter: number;
  /** Encoded (wire) FindingValue; opaque to planning, shown to the model. */
  readonly value: unknown;
  /** Encoded (wire) KnowledgeState. */
  readonly knowledgeState: unknown;
  /**
   * The source the CURRENT revision was published from (null for explicit
   * corrections), with that source's send time — the pair the reanalysis
   * guard needs: re-running an OLDER source cannot revert a newer
   * source-backed truth (issue #8).
   */
  readonly currentProvenanceSourceId: string | null;
  readonly currentProvenanceSourceSentAtMs: number | null;
}

/** One recent accepted source (bounded preview, tenant-filtered). */
export interface ContextRecentSource {
  readonly sourceId: string;
  readonly sentAtMs: number;
  readonly preview: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
}

/** The immutable source snapshot one run analyzes. */
export interface ContextSource {
  readonly sourceId: string;
  readonly authorText: string;
  readonly sentAtMs: number;
  readonly sentAtTimezone: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
  /** Projects the sender explicitly linked (context hints, never authority). */
  readonly hintProjectIds: readonly string[];
}

/** The full analysis context: everything the run legitimately knows. */
export interface AnalysisContext {
  readonly source: ContextSource;
  readonly coverage: CoverageSnapshot;
  readonly projects: readonly ContextProject[];
  readonly findings: readonly ContextFinding[];
  readonly recentSources: readonly ContextRecentSource[];
  readonly run: {
    readonly runId: string;
    readonly kind: "initial_analysis" | "reanalysis";
    readonly reanalysisOfRunId: string | null;
  };
}

/** Finds one finding by identity key (scope + semanticKey), if live. */
export function findContextFinding(
  context: AnalysisContext,
  scope: ContextScope,
  semanticKey: string,
): ContextFinding | undefined {
  return context.findings.find(
    (finding) =>
      finding.semanticKey === semanticKey &&
      finding.scope.kind === scope.kind &&
      (scope.kind === "company" ||
        (finding.scope.kind === "project" &&
          scope.kind === "project" &&
          finding.scope.projectId === scope.projectId)),
  );
}

/** Finds one context project by id (the attribution validation). */
export function findContextProject(
  context: AnalysisContext,
  projectId: string,
): ContextProject | undefined {
  return context.projects.find((project) => project.projectId === projectId);
}

/** The load-time revision snapshot the run records as its input versions. */
export function revisionSnapshotOf(
  context: AnalysisContext,
): { readonly findingId: string; readonly revision: number }[] {
  return context.findings.map((finding) => ({
    findingId: finding.findingId,
    revision: finding.revisionCounter,
  }));
}

/** Whether one scope refers to a known context project (or firm memory). */
export function scopeResolvable(
  context: AnalysisContext,
  scope: ContextScope,
): boolean {
  return scope.kind === "company" || findContextProject(context, scope.projectId) !== undefined;
}
