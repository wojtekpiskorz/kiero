/**
 * Boss-facing memory exposition reads (H1, additive and flagged on the B3
 * precedent): the revision history with provenance, and the shared
 * clarifications list.
 *
 * C2 proved the immutable rows (findingRevisions with origin/reason/actor,
 * evidenceLinks, clarifications) and the current projection read
 * (`memory.readCurrentFindings`); issue #49 additionally requires that a
 * boss can "inspect old/current revisions and provenance" and answer a
 * displayed sourced clarification. These two cores are the minimal
 * read-only surfaces for that, through the SAME tenant rules as the
 * existing reads: company resolved from the verified context, project
 * scope tenant-checked, everything ordered and bounded.
 *
 * Rows carry their ENCODED (wire) value shapes, exactly like
 * readCurrentFindings: BigDecimal and friends are not Convex-serializable,
 * and the public query returns the wire form for client-side decoding
 * through the contract schemas at the untrusted boundary.
 */

import { type ClosedError } from "@kiero/contracts";
import { forbiddenError, notFoundError, type RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { normalizedCompany, requireFinding, requireProject } from "./references";
import type { ReadClarificationsInput, ReadFindingHistoryInput } from "./semantics";

/** How many revisions one history read keeps (bounded read). */
const MAX_REVISION_ROWS = 200;

/** How many clarifications one scope read keeps (bounded read). */
const MAX_CLARIFICATION_ROWS = 100;

/** One revision row in its wire form (value/knowledgeState encoded). */
export interface RevisionWireRow {
  readonly revisionId: string;
  readonly revision: number;
  readonly value: unknown;
  readonly knowledgeState: unknown;
  readonly origin: "publication" | "correction" | "withdrawal_marking";
  readonly reason: string | null;
  readonly recordedByUserId: string;
  readonly recordedAtMs: number;
  readonly supersedesRevisionId: string | null;
  readonly evidence: readonly {
    readonly sourceId: string;
    readonly fragmentId: string | null;
    readonly supportKind: "support" | "independent_corroboration" | "derivation" | "supersession";
  }[];
}

/** The finding-history read result in its wire form. */
export interface FindingHistoryWireRow {
  readonly findingId: string;
  readonly semanticKey: string;
  readonly scope: { readonly _tag: "company" } | { readonly _tag: "project"; readonly projectId: string };
  readonly currentRevisionId: string;
  readonly revisionCounter: number;
  readonly revisions: readonly RevisionWireRow[];
}

/** One clarification row in its wire form. */
export interface ClarificationWireRow {
  readonly clarificationId: string;
  readonly question: string;
  readonly state: "open" | "resolved";
  readonly raisedAtMs: number;
  readonly resolvedByUserId: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedAtMs: number | null;
  readonly conflictingEvidence: readonly {
    readonly fragmentId: string;
    readonly sourceId: string;
  }[];
}

type ReadResult<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly error: ClosedError };

type ListResult<T> =
  | { readonly ok: true; readonly rows: T[] }
  | { readonly ok: false; readonly error: ClosedError };
/** The evidence witnesses of one revision, ordered by link creation. */
async function evidenceOf(
  db: QueryCtx["db"],
  findingRevisionId: Id<"findingRevisions">,
): Promise<RevisionWireRow["evidence"]> {
  const links = await db
    .query("evidenceLinks")
    .withIndex("by_revision", (q) => q.eq("findingRevisionId", findingRevisionId))
    .collect();
  return links.map((link) => ({
    sourceId: link.sourceId,
    fragmentId: link.sourceFragmentId ?? null,
    supportKind: link.supportKind,
  }));
}

/**
 * One finding's full revision history with provenance, oldest first. The
 * current projection is included (finding row fields) so the caller can
 * distinguish old from current without a second read.
 */
export async function readFindingHistoryRows(
  db: QueryCtx["db"],
  context: RequestContext,
  input: ReadFindingHistoryInput,
): Promise<ReadResult<FindingHistoryWireRow>> {
  const companyId = normalizedCompany(db, context);
  if (companyId === null) {
    return { ok: false, error: forbiddenError("company_scope_unresolved", "companies") };
  }
  const finding = await requireFinding(db, input.findingId, companyId);
  if (finding === null || finding.currentRevisionId === undefined) {
    // No current revision means nothing is exposed yet: the current-findings
    // read skips such rows too, so a boss never reaches this id from the UI.
    return { ok: false, error: notFoundError("findings") };
  }
  // Newest MAX_REVISION_ROWS, restored to oldest-first for display: the
  // live end (the revision the "aktualne" badge marks) must never fall off
  // the truncation, and past the cap the oldest history is the safe end to
  // drop (round-2 ride-along).
  const revisionDocs = (
    await db
      .query("findingRevisions")
      .withIndex("by_finding_revision", (q) => q.eq("findingId", finding._id))
      .order("desc")
      .take(MAX_REVISION_ROWS)
  ).reverse();
  const revisions: RevisionWireRow[] = [];
  for (const revision of revisionDocs) {
    revisions.push({
      revisionId: revision._id,
      revision: revision.revision,
      value: revision.value,
      knowledgeState: revision.knowledgeState,
      origin: revision.origin,
      reason: revision.reason ?? null,
      recordedByUserId: revision.recordedByUserId,
      recordedAtMs: revision.recordedAtMs,
      supersedesRevisionId: revision.supersedesRevisionId ?? null,
      evidence: await evidenceOf(db, revision._id),
    });
  }
  return {
    ok: true,
    row: {
      findingId: finding._id,
      semanticKey: finding.semanticKey,
      scope:
        finding.scopeKind === "company"
          ? { _tag: "company" }
          : { _tag: "project", projectId: finding.scopeProjectId ?? "" },
      currentRevisionId: finding.currentRevisionId,
      revisionCounter: finding.revisionCounter,
      revisions,
    },
  };
}

/** Dereferences a clarification's conflicting fragments to canonical sources. */
async function conflictingEvidenceOf(
  db: QueryCtx["db"],
  clarification: Doc<"clarifications">,
): Promise<ClarificationWireRow["conflictingEvidence"]> {
  const evidence: { fragmentId: string; sourceId: string }[] = [];
  for (const fragmentId of clarification.conflictingFragmentIds) {
    const fragment = await db.get(fragmentId);
    if (fragment === null) {
      continue;
    }
    evidence.push({ fragmentId, sourceId: fragment.sourceId });
  }
  return evidence;
}

/**
 * The clarifications of one scope (open and resolved, oldest first): the
 * shared open questions a boss may answer, with the sourced contradiction
 * each one is about. Resolved rows keep their author, note and time.
 */
export async function readClarificationRows(
  db: QueryCtx["db"],
  context: RequestContext,
  input: ReadClarificationsInput,
): Promise<ListResult<ClarificationWireRow>> {
  const companyId = normalizedCompany(db, context);
  if (companyId === null) {
    return { ok: false, error: forbiddenError("company_scope_unresolved", "companies") };
  }
  let scopeProjectId: Id<"projects"> | undefined;
  if (input.scope._tag === "project") {
    const resolved = await requireProject(db, input.scope.projectId, companyId);
    if (resolved === null) {
      return { ok: false, error: notFoundError("projects", "project_scope_not_found") };
    }
    scopeProjectId = resolved;
  }
  // Company-scope rows carry NO scopeProjectId, so they are omitted from the
  // `by_project` index entirely (Convex drops documents with undefined
  // indexed fields): the company scan rides `by_company_state`'s companyId
  // prefix instead, and the kind filter below keeps only firm-memory rows.
  const rows =
    scopeProjectId === undefined
      ? await db
          .query("clarifications")
          .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
          .collect()
      : await db
          .query("clarifications")
          .withIndex("by_project", (q) =>
            q.eq("companyId", companyId).eq("scopeProjectId", scopeProjectId),
          )
          .collect();
  const scoped = rows
    .filter((row) =>
      input.scope._tag === "company"
        ? row.scopeKind === "company" && row.scopeProjectId === undefined
        : row.scopeKind === "project" && row.scopeProjectId === scopeProjectId,
    )
    .sort((a, b) => a.raisedAtMs - b.raisedAtMs)
    .slice(0, MAX_CLARIFICATION_ROWS);
  const out: ClarificationWireRow[] = [];
  for (const clarification of scoped) {
    out.push({
      clarificationId: clarification._id,
      question: clarification.question,
      state: clarification.state,
      raisedAtMs: clarification.raisedAtMs,
      resolvedByUserId: clarification.resolvedByUserId ?? null,
      resolutionNote: clarification.resolutionNote ?? null,
      resolvedAtMs: clarification.resolvedAtMs ?? null,
      conflictingEvidence: await conflictingEvidenceOf(db, clarification),
    });
  }
  return { ok: true, rows: out };
}
