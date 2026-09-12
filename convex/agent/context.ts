/**
 * The tenant-filtered answer-context loader (E6): protocol step 6 for the
 * answer flow — "Read relevant current structured state, discover evidence
 * with tenant-filtered retrieval ... Similarity does not establish truth."
 *
 * Every read is scoped through the QUESTION SOURCE's company: projects,
 * current findings of the firm and each project scope (with their current
 * witnesses as the initial evidence ledger), and recent sources with their
 * honest processing state (a source whose analysis is still running is
 * disclosure material, never a blocker for independent confirmed facts).
 *
 * The C5 updating gate is applied HERE: `isUpdatingKnowledgeState` decides
 * the `updating` flag and the `groundsUpdating` evidence flag, so the pure
 * reducer never has to re-derive it and the model sees updating findings
 * marked from the first message.
 *
 * R2 (issue #127): the same loader drops dead references — an evidence
 * WITNESS must pass the GROUNDING predicate (`requireActiveSource`: a
 * withdrawn source "przestała stanowić podstawę aktualnych ustaleń" and a
 * tombstone grounds nothing, so neither may enter the ledger the model
 * cites for statements and resolves), while the open-clarification list
 * rides the CONTENT rule in ../memory/findings/references (only permanent
 * deletion removes content): a redacted case is not actionable and stays
 * out of the model's list, a withdrawn-anchored case stays answerable.
 *
 * No vector search yet (E5 owns it): retrieval stays bounded tenant-filtered
 * text work, and similarity would anyway never establish truth.
 */

import { isUpdatingKnowledgeState } from "@kiero/domain";
import {
  MAX_ANSWER_CONTEXT_CONTACTS,
  MAX_ANSWER_CONTEXT_FINDINGS,
  MAX_ANSWER_CONTEXT_MEMBERSHIPS,
  MAX_ANSWER_CONTEXT_PROJECTS,
  MAX_ANSWER_CONTEXT_WORK,
  MAX_ANSWER_RECENT_SOURCES,
  MAX_ANSWER_SOURCE_PREVIEW_CHARS,
  MAX_EVIDENCE_QUOTE_CHARS,
  type AnswerClarification,
  type AnswerContext,
  type AnswerContact,
  type AnswerEvent,
  type AnswerEvidenceEntry,
  type AnswerFinding,
  type AnswerKnowledgeTag,
  type AnswerMembership,
  type AnswerProject,
  type AnswerSourceStatus,
  type AnswerTask,
} from "@kiero/agent/tools";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  clarificationContentRuleOf,
  requireActiveSource,
} from "../memory/findings/references";

/** The DB reader surface the loader needs (mutation or query context). */
export type AnswerLoaderDb = QueryCtx["db"];

/** The encoded knowledge-state tag of one revision row. */
function knowledgeTagOf(state: unknown): AnswerKnowledgeTag {
  if (typeof state === "object" && state !== null && "_tag" in state) {
    const tag = (state as { _tag: unknown })._tag;
    switch (tag) {
      case "known":
      case "unknown":
      case "conflicted":
      case "updating":
      case "not_applicable":
        return tag;
    }
  }
  return "unknown";
}

/** Loads the projects of one company, bounded (id, name, active codename). */
async function loadProjects(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<AnswerProject[]> {
  const rows = await db
    .query("projects")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .take(MAX_ANSWER_CONTEXT_PROJECTS);
  const projects: AnswerProject[] = [];
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

/** One bounded quote of a source's text around a fragment range. */
function quoteOf(
  authorText: string,
  startOffset: number | null,
  endOffset: number | null,
): string {
  if (startOffset === null || endOffset === null) {
    return authorText.slice(0, MAX_EVIDENCE_QUOTE_CHARS);
  }
  const start = Math.max(0, Math.min(startOffset, authorText.length));
  const end = Math.max(start, Math.min(endOffset, authorText.length));
  return authorText.slice(start, Math.min(end, start + MAX_EVIDENCE_QUOTE_CHARS));
}

/** Loads current findings (all scopes of the company) + their witnesses. */
async function loadFindingsAndEvidence(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<{ findings: AnswerFinding[]; evidence: AnswerEvidenceEntry[] }> {
  const rows = await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) => q.eq("companyId", companyId))
    .take(MAX_ANSWER_CONTEXT_FINDINGS * 4);
  const findings: AnswerFinding[] = [];
  const evidence: AnswerEvidenceEntry[] = [];
  for (const finding of rows) {
    if (findings.length >= MAX_ANSWER_CONTEXT_FINDINGS) {
      break;
    }
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const revision = await db.get(finding.currentRevisionId);
    if (revision === null) {
      continue;
    }
    const knowledgeTag = knowledgeTagOf(revision.knowledgeState);
    const updating = isUpdatingKnowledgeState({ _tag: knowledgeTag });
    const witnesses = await db
      .query("evidenceLinks")
      .withIndex("by_revision", (q) => q.eq("findingRevisionId", revision._id))
      .filter((q) =>
        q.or(
          q.eq(q.field("supportKind"), "support"),
          q.eq(q.field("supportKind"), "independent_corroboration"),
        ),
      )
      .collect();
    const handles: string[] = [];
    for (const witness of witnesses) {
      if (evidence.length >= MAX_ANSWER_CONTEXT_FINDINGS * 2) {
        break;
      }
      // R2 (issue #127): the GROUNDING predicate decides here, not the
      // content one — the ledger's handles are what the model cites to
      // ground statements and resolves, and neither a withdrawn source
      // (no longer a basis of current agreements) nor a tombstone may
      // ground new work. (Whether the source's CONTENT stays readable is
      // a different question, asked by the clarification content rule.)
      const source = await requireActiveSource(db, witness.sourceId, companyId);
      if (source === null) {
        continue;
      }
      let startOffset: number | null = null;
      let endOffset: number | null = null;
      if (witness.sourceFragmentId !== undefined) {
        const fragment = await db.get(witness.sourceFragmentId);
        if (fragment !== null && fragment.anchor._tag === "text_range") {
          startOffset = fragment.anchor.startOffset;
          endOffset = fragment.anchor.endOffset;
        }
      }
      const entry: AnswerEvidenceEntry = {
        evidenceId: `ev${evidence.length + 1}`,
        sourceId: source._id,
        sourceSentAtMs: source.sentAtMs,
        fragmentId: witness.sourceFragmentId ?? null,
        quote: quoteOf(source.authorText, startOffset, endOffset),
        startOffset,
        endOffset,
        groundsFindingId: finding._id,
        groundsUpdating: updating,
      };
      evidence.push(entry);
      handles.push(entry.evidenceId);
    }
    findings.push({
      findingId: finding._id,
      scope:
        finding.scopeKind === "company" || finding.scopeProjectId === undefined
          ? { kind: "company" }
          : { kind: "project", projectId: finding.scopeProjectId },
      semanticKey: finding.semanticKey,
      revisionCounter: finding.revisionCounter,
      value: revision.value,
      knowledgeTag,
      updating,
      evidenceIds: handles,
    });
  }
  return { findings, evidence };
}

/** Loads recent sources with their honest processing state. */
async function loadSources(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<AnswerSourceStatus[]> {
  const rows = await db
    .query("sources")
    .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(MAX_ANSWER_RECENT_SOURCES);
  const statuses: AnswerSourceStatus[] = [];
  for (const row of rows) {
    const latestRun = await db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", row._id))
      .order("desc")
      .first();
    statuses.push({
      sourceId: row._id,
      sentAtMs: row.sentAtMs,
      preview: row.authorText.slice(0, MAX_ANSWER_SOURCE_PREVIEW_CHARS),
      lifecycle: row.lifecycle,
      processing:
        latestRun === undefined || latestRun === null
          ? "none"
          : latestRun.state === "running"
            ? "processing"
            : "complete",
    });
  }
  return statuses;
}

/** Loads the company's current tasks and events, bounded. */
async function loadWork(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<{ tasks: AnswerTask[]; events: AnswerEvent[] }> {
  const taskRows = await db
    .query("tasks")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(MAX_ANSWER_CONTEXT_WORK);
  const eventRows = await db
    .query("events")
    .withIndex("by_project_state", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(MAX_ANSWER_CONTEXT_WORK);
  return {
    tasks: taskRows.map((row) => ({
      taskId: row._id,
      projectId: row.projectId,
      title: row.title,
      state: row.state,
      revisionCounter: row.revisionCounter,
    })),
    events: eventRows.map((row) => ({
      eventId: row._id,
      projectId: row.projectId,
      title: row.title,
      state: row.state,
      revisionCounter: row.revisionCounter,
    })),
  };
}

/** Loads the company's open clarifications, bounded. */
async function loadClarifications(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<AnswerClarification[]> {
  const rows = await db
    .query("clarifications")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId).eq("state", "open"))
    .take(MAX_ANSWER_CONTEXT_WORK);
  // R2 (issue #127): a redacted open case is not actionable — the model
  // must not see (let alone answer) a question whose content derived from
  // a permanently deleted source. The ONE shared content rule decides
  // (content question: a withdrawn source's case stays visible here).
  const actionable: AnswerClarification[] = [];
  for (const row of rows) {
    const rule = await clarificationContentRuleOf(db, row);
    if (!rule.actionable) {
      continue;
    }
    actionable.push({
      clarificationId: row._id,
      // Open plus actionable implies the question is not redacted; the rule
      // keeps redacted cases out of the actionable set entirely.
      question: row.question,
      scopeKind: row.scopeKind,
      scopeProjectId: row.scopeProjectId ?? null,
    });
  }
  return actionable;
}

/** Loads the catalog contacts (executor candidates), bounded. */
async function loadContacts(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<AnswerContact[]> {
  const rows = await db
    .query("contacts")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(MAX_ANSWER_CONTEXT_CONTACTS);
  return rows.map((row) => ({
    contactId: row._id,
    displayName: row.displayName,
  }));
}

/** Loads the active boss memberships (coordinator candidates), bounded. */
async function loadMemberships(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
): Promise<AnswerMembership[]> {
  const rows = await db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .take(MAX_ANSWER_CONTEXT_MEMBERSHIPS);
  const memberships: AnswerMembership[] = [];
  for (const row of rows) {
    const user = await db.get(row.userId);
    memberships.push({
      membershipId: row._id,
      bossName: user?.displayName ?? "?",
    });
  }
  return memberships;
}

/**
 * Builds the full answer context for one question source. Returns null
 * when the source row is missing or no longer active (the caller fails
 * honestly).
 */
export async function loadAnswerContext(
  db: AnswerLoaderDb,
  params: {
    readonly source: Doc<"sources">;
    readonly runId: string;
    readonly nowMs: number;
  },
): Promise<AnswerContext | null> {
  if (params.source.lifecycle !== "active") {
    return null;
  }
  const companyId = params.source.companyId;
  const [projects, loaded, sources, work, clarifications, contacts, memberships] =
    await Promise.all([
      loadProjects(db, companyId),
      loadFindingsAndEvidence(db, companyId),
      loadSources(db, companyId),
      loadWork(db, companyId),
      loadClarifications(db, companyId),
      loadContacts(db, companyId),
      loadMemberships(db, companyId),
    ]);
  return {
    question: {
      sourceId: params.source._id,
      authorText: params.source.authorText,
      sentAtMs: params.source.sentAtMs,
      sentAtTimezone: params.source.sentAtTimezone,
    },
    projects,
    findings: loaded.findings,
    sources,
    tasks: work.tasks,
    events: work.events,
    clarifications,
    contacts,
    memberships,
    evidence: loaded.evidence,
    run: { runId: params.runId, nowMs: params.nowMs },
  };
}

/**
 * Reads the CURRENT revision counters of the loaded findings (the staleness
 * recheck's fresh side; same tenant scoping as the loader).
 */
export async function currentFindingRevisions(
  db: AnswerLoaderDb,
  companyId: Id<"companies">,
  loadRevisions: readonly { findingId: string; revision: number }[],
): Promise<Map<string, number>> {
  const current = new Map<string, number>();
  for (const expectation of loadRevisions) {
    const findingId = db.normalizeId("findings", expectation.findingId);
    const finding = findingId === null ? null : await db.get(findingId);
    if (finding !== null && finding.companyId === companyId) {
      current.set(finding._id, finding.revisionCounter);
    }
  }
  return current;
}
