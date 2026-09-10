/**
 * The tenant-filtered analysis-context loader (E3): protocol step 6 —
 * "Read relevant current structured state, discover evidence with
 * tenant-filtered retrieval ... and record the revisions used in a change
 * plan. Similarity does not establish truth."
 *
 * Every read is scoped through the source's company: projects, linked
 * hints, current findings (firm memory plus each linked project scope) and
 * bounded recent-source previews. The findings' revision counters ARE the
 * recorded input-revision version: the publish stage passes them as the
 * caller expectations of `memory.publishChangeSet`, which is how a newer
 * correction refuses a stale plan (C2's guard; issue #8 precedence).
 *
 * No vector search yet (E5 owns it): retrieval here is bounded tenant-
 * filtered listing, and similarity would anyway never establish truth.
 */

import type { QueryCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import {
  MAX_CONTEXT_FINDINGS,
  MAX_CONTEXT_PROJECTS,
  MAX_CONTEXT_RECENT_SOURCES,
  MAX_RECENT_SOURCE_PREVIEW_CHARS,
  type AnalysisContext,
  type ContextFinding,
  type ContextProject,
  type ContextRecentSource,
  type CoverageSnapshot,
} from "@kiero/agent";

/** The DB reader surface the loader needs (mutation or query context). */
export type LoaderDb = QueryCtx["db"];

/** Loads the projects of one company, bounded (id, name, active codename). */
async function loadProjects(db: LoaderDb, companyId: Id<"companies">): Promise<ContextProject[]> {
  const rows = await db
    .query("projects")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .take(MAX_CONTEXT_PROJECTS);
  const projects: ContextProject[] = [];
  for (const row of rows) {
    const alias = await db
      .query("projectAliases")
      .withIndex("by_project", (q) => q.eq("projectId", row._id))
      .filter((q) => q.eq(q.field("active"), true))
      .first();
    projects.push({
      projectId: row._id,
      displayName: row.displayName,
      codename: alias?.codename ?? null,
    });
  }
  return projects;
}

/** Loads current findings for the company scope and each linked project. */
async function loadFindings(
  db: LoaderDb,
  companyId: Id<"companies">,
  projectIds: readonly Id<"projects">[],
): Promise<ContextFinding[]> {
  const scopes: (Id<"projects"> | undefined)[] = [undefined, ...projectIds];
  const findings: ContextFinding[] = [];
  for (const scopeProjectId of scopes) {
    const rows = await db
      .query("findings")
      .withIndex("by_company_scope_key", (q) =>
        q.eq("companyId", companyId).eq("scopeProjectId", scopeProjectId),
      )
      .take(MAX_CONTEXT_FINDINGS);
    for (const finding of rows) {
      if (findings.length >= MAX_CONTEXT_FINDINGS) {
        break;
      }
      let value: unknown = null;
      let knowledgeState: unknown = null;
      let currentProvenanceSourceId: string | null = null;
      let currentProvenanceSourceSentAtMs: number | null = null;
      if (finding.currentRevisionId !== undefined) {
        const revision = await db.get(finding.currentRevisionId);
        if (revision !== null) {
          value = revision.value;
          knowledgeState = revision.knowledgeState;
          const provenanceSourceId =
            revision.provenance === undefined
              ? undefined
              : db.normalizeId("sources", revision.provenance.sourceId);
          if (provenanceSourceId !== null && provenanceSourceId !== undefined) {
            currentProvenanceSourceId = provenanceSourceId;
            const provenanceSource = await db.get(provenanceSourceId);
            currentProvenanceSourceSentAtMs = provenanceSource?.sentAtMs ?? null;
          }
        }
      }
      findings.push({
        findingId: finding._id,
        scope:
          finding.scopeKind === "company" || finding.scopeProjectId === undefined
            ? { kind: "company" }
            : { kind: "project", projectId: finding.scopeProjectId },
        semanticKey: finding.semanticKey,
        revisionCounter: finding.revisionCounter,
        value,
        knowledgeState,
        currentProvenanceSourceId,
        currentProvenanceSourceSentAtMs,
      });
    }
  }
  return findings;
}

/** The inspectable-parts snapshot: completed extraction kinds vs pending. */
async function loadCoverage(
  db: LoaderDb,
  sourceId: Id<"sources">,
): Promise<CoverageSnapshot> {
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const extractions = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId))
    .collect();
  const extractedKinds = new Set<"text" | "stt" | "vision">(
    extractions.map((row) => row.kind),
  );
  const pending: ("audio" | "image")[] = [];
  for (const attachment of attachments) {
    if (!extractedKinds.has(attachment.kind === "audio" ? "stt" : "vision")) {
      pending.push(attachment.kind);
    }
  }
  return { extractedKinds: [...extractedKinds], pendingSegments: pending };
}

/** Loads bounded previews of the company's recent sources (context only). */
async function loadRecentSources(
  db: LoaderDb,
  companyId: Id<"companies">,
): Promise<ContextRecentSource[]> {
  const rows = await db
    .query("sources")
    .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(MAX_CONTEXT_RECENT_SOURCES);
  return rows.map((row) => ({
    sourceId: row._id,
    sentAtMs: row.sentAtMs,
    preview: row.authorText.slice(0, MAX_RECENT_SOURCE_PREVIEW_CHARS),
    lifecycle: row.lifecycle,
  }));
}

/**
 * Builds the full analysis context for one run's source. Returns null when
 * the source row is missing (the caller fails the run honestly).
 */
export async function loadAnalysisContext(
  db: LoaderDb,
  params: {
    readonly source: Doc<"sources">;
    readonly runId: Id<"processingRuns">;
    readonly runKind: "initial_analysis" | "reanalysis";
    readonly reanalysisOfRunId: Id<"processingRuns"> | null;
  },
): Promise<AnalysisContext> {
  const companyId = params.source.companyId;
  const links = await db
    .query("sourceProjectLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", params.source._id))
    .collect();
  const hintProjectIds = links.map((link) => link.projectId);
  const [projects, findings, coverage, recentSources] = await Promise.all([
    loadProjects(db, companyId),
    loadFindings(db, companyId, hintProjectIds),
    loadCoverage(db, params.source._id),
    loadRecentSources(db, companyId),
  ]);
  return {
    source: {
      sourceId: params.source._id,
      authorText: params.source.authorText,
      sentAtMs: params.source.sentAtMs,
      sentAtTimezone: params.source.sentAtTimezone,
      lifecycle: params.source.lifecycle,
      hintProjectIds,
    },
    coverage,
    projects,
    findings,
    recentSources,
    run: {
      runId: params.runId,
      kind: params.runKind,
      reanalysisOfRunId: params.reanalysisOfRunId,
    },
  };
}
