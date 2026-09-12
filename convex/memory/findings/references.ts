/**
 * Shared tenant-scoped reference checks for the findings lane (C2).
 *
 * The resolved company is the only company any row may belong to: every
 * require* helper normalizes the id, reads the row and refuses (returns
 * null) when the row is missing OR belongs to another company — without
 * saying which, so the refusal leaks no existence information across the
 * tenant boundary. Imported by the changeset transactions, corrections,
 * the current read and the withdrawal marking.
 *
 * R1 (issue #126) addition: `checkResolutionEvidenceReference` is the ONE
 * per-reference rule for evidence cited by a clarification resolution
 * (existence, company, active lifecycle, fragment ownership). Both the
 * agent executor and the resolution transaction validate through it — each
 * layer still runs its own end-to-end check; only the rule text lives
 * here, so the two can never drift apart.
 *
 * R2 (issue #127) additions: `requireActiveSource` (GROUNDING: may this
 * source ground new work? withdrawn/tombstoned do not) and
 * `requireContentAliveSource` (CONTENT: is this source's content still
 * readable? only `purged` content is gone — withdrawal keeps history),
 * plus `clarificationContentRuleOf` with the two redaction constants (the
 * ONE shared content rule of the clarification purge, built on the
 * CONTENT predicate) — the boss-facing read (./exposition), the agent
 * context loader and the stored purge (./corrections) all evaluate them,
 * so reads, context and storage can never drift apart either.
 */

import type { RequestContext } from "@kiero/runtime";
import type { DependencyEdge } from "@kiero/domain";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";

/** The DB reader surface the reference checks need (mutation or query). */
export type Db = MutationCtx["db"] | QueryCtx["db"];

/** The actor's normalized company id (null when malformed — refuse loudly). */
export function normalizedCompany(
  db: Db,
  context: RequestContext,
): Id<"companies"> | null {
  return db.normalizeId("companies", context.actor.companyId);
}

/** The actor's normalized user id (null when malformed — refuse loudly). */
export function normalizedActor(
  db: Db,
  context: RequestContext,
): Id<"users"> | null {
  return db.normalizeId("users", context.actor.userId);
}

/** One source of this company, or null when missing/foreign/malformed. */
export async function requireSource(
  db: Db,
  sourceRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"sources"> | null> {
  const sourceId = db.normalizeId("sources", sourceRef);
  if (sourceId === null) {
    return null;
  }
  const source = await db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
    return null;
  }
  return source;
}

/**
 * R2 (issue #127): the GROUNDING predicate — "may this source ground NEW
 * work?" (raising a case, resolving on new evidence, anchoring a citation).
 * It must exist, belong to the resolved company and be `active`: a
 * withdrawn source "przestała stanowić podstawę aktualnych ustaleń"
 * (CONTEXT.md, Źródło wycofane) and a retained tombstone grounds nothing.
 * R1's `checkResolutionEvidenceReference` and the agent write paths
 * evaluate this stance; every grounding call site uses this predicate,
 * never a private copy.
 */
export async function requireActiveSource(
  db: Db,
  sourceRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"sources"> | null> {
  const source = await requireSource(db, sourceRef, companyId);
  return source !== null && source.lifecycle === "active" ? source : null;
}

/**
 * R2 round 3 (issue #127): the CONTENT predicate — "is this source's
 * CONTENT still readable?" Withdrawal deletes nothing ("Jej wcześniejsza
 * rola i przyczyna korekty pozostają częścią historii", CONTEXT.md): the
 * row, text and fragments stay, so a withdrawn source is content-alive.
 * Only a missing, cross-company or `purged` source is content-dead —
 * permanent deletion is the one lifecycle whose content must disappear.
 * The shared clarification content rule (`clarificationContentRuleOf`)
 * evaluates THIS question; grounding paths evaluate `requireActiveSource`.
 * The two predicates answer two different questions and must not merge.
 */
export async function requireContentAliveSource(
  db: Db,
  sourceRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"sources"> | null> {
  const source = await requireSource(db, sourceRef, companyId);
  return source !== null && source.lifecycle !== "purged" ? source : null;
}

/** One project of this company (id only), or null when missing/foreign. */
export async function requireProject(
  db: Db,
  projectRef: string,
  companyId: Id<"companies">,
): Promise<Id<"projects"> | null> {
  const projectId = db.normalizeId("projects", projectRef);
  if (projectId === null) {
    return null;
  }
  const project = await db.get(projectId);
  if (project === null || project.companyId !== companyId) {
    return null;
  }
  return projectId;
}

/** One finding of this company, or null when missing/foreign/malformed. */
export async function requireFinding(
  db: Db,
  findingRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"findings"> | null> {
  const findingId = db.normalizeId("findings", findingRef);
  if (findingId === null) {
    return null;
  }
  const finding = await db.get(findingId);
  if (finding === null || finding.companyId !== companyId) {
    return null;
  }
  return finding;
}

/** Finds the live finding identity for one scope key, if any. */
export async function findFindingByKey(
  db: Db,
  companyId: Id<"companies">,
  scopeProjectId: Id<"projects"> | undefined,
  semanticKey: string,
): Promise<Doc<"findings"> | null> {
  return await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) =>
      q
        .eq("companyId", companyId)
        .eq("scopeProjectId", scopeProjectId)
        .eq("semanticKey", semanticKey),
    )
    .first();
}

/** All dependency edges of one company (the acyclicity check's graph). */
export async function companyDependencyEdges(
  db: Db,
  companyId: Id<"companies">,
): Promise<DependencyEdge[]> {
  const rows = await db
    .query("findingDependencies")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect();
  return rows.map((row) => ({
    dependent: row.dependentFindingId,
    dependsOn: row.dependsOnFindingId,
  }));
}

/** The typed refusal code of one resolution-evidence reference check (R1). */
export type ResolutionEvidenceRefusalCode =
  | "resolution_source_not_found"
  | "resolution_source_not_in_company"
  | "resolution_source_not_active"
  | "resolution_fragment_mismatch";

/**
 * R1 (issue #126): the per-reference rule for evidence cited by a
 * clarification resolution — the cited source must EXIST, belong to the
 * resolved company and be ACTIVE ("Źródło wycofane" no longer grounds a
 * resolution), and a cited fragment must belong to that source. Returns
 * the typed refusal code, or null when the reference is valid; the caller
 * wraps the code in its own error shape and keeps its own dedupe.
 */
export async function checkResolutionEvidenceReference(
  db: Db,
  companyId: Id<"companies">,
  reference: { readonly sourceId: string; readonly fragmentId: string | null },
): Promise<ResolutionEvidenceRefusalCode | null> {
  const sourceId = db.normalizeId("sources", reference.sourceId);
  const source = sourceId === null ? null : await db.get(sourceId);
  if (source === null) {
    return "resolution_source_not_found";
  }
  if (source.companyId !== companyId) {
    return "resolution_source_not_in_company";
  }
  if (source.lifecycle !== "active") {
    return "resolution_source_not_active";
  }
  if (reference.fragmentId !== null) {
    const fragmentId = db.normalizeId("sourceFragments", reference.fragmentId);
    const fragment = fragmentId === null ? null : await db.get(fragmentId);
    if (fragment === null || fragment.sourceId !== source._id) {
      return "resolution_fragment_mismatch";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R2 (issue #127): the shared clarification purge-redaction rule.
// ---------------------------------------------------------------------------

/**
 * The fixed Polish redaction copy (product text): replaces stored question
 * or resolution text that possibly derived from a permanently deleted
 * source. Never a summary — deleted content is never paraphrased back.
 */
export const REDACTED_CLARIFICATION_QUESTION_COPY =
  "Pytanie zostało trwale usunięte wraz z wiadomością źródłową.";
export const REDACTED_CLARIFICATION_RESOLUTION_COPY =
  "Rozstrzygnięcie zostało trwale usunięte wraz z wiadomością źródłową.";

/**
 * The effective content state of one clarification row under the CURRENT
 * source lifecycle (R2): which links still point at sources whose CONTENT
 * is alive, and which text is therefore redacted to the fixed copy. This
 * is the ONE rule every consumer evaluates — the boss-facing read, the
 * agent context loader and the stored purge — so the immediate window
 * (tombstone committed, asynchronous purge not yet run) already redacts
 * exactly what the purge will freeze.
 */
export interface ClarificationContentRule {
  /**
   * True when any conflicting-evidence link is content-dead (its source is
   * missing, cross-company or `purged`): the question possibly derived
   * from permanently deleted content and reads as the fixed copy. A
   * withdrawn source's content stays, so its links stay alive.
   */
  readonly questionRedacted: boolean;
  /**
   * True (resolved rows) when the stored note possibly derived from
   * permanently deleted content: a stored basis that cited a purged
   * source, or a legacy basis on a redacted case (the basis is unknown;
   * never guess it safe).
   */
  readonly resolutionNoteRedacted: boolean;
  /** The conflicting fragments whose source is content-alive, in stored order. */
  readonly activeConflictingEvidence: readonly {
    readonly fragmentId: Id<"sourceFragments">;
    readonly sourceId: Id<"sources">;
  }[];
  /** The resolution evidence whose source is content-alive, in stored order. */
  readonly activeResolutionEvidence: readonly {
    readonly sourceId: Id<"sources">;
    readonly fragmentId: Id<"sourceFragments"> | null;
  }[];
  /** False only for OPEN redacted rows: they leave every actionable list. */
  readonly actionable: boolean;
}

/**
 * R2: evaluates one clarification row against the current state. A dead
 * link is a conflicting fragment (or resolution-evidence reference) whose
 * source is missing, cross-company or `purged`
 * (`requireContentAliveSource` — permanent deletion is the one lifecycle
 * whose content must disappear; a WITHDRAWN source keeps its content, so
 * its links stay alive and its cases stay answerable). The stored purge
 * audit keeps redaction sticky after the associations themselves were
 * removed.
 */
export async function clarificationContentRuleOf(
  db: Db,
  clarification: Doc<"clarifications">,
): Promise<ClarificationContentRule> {
  const activeConflictingEvidence: {
    fragmentId: Id<"sourceFragments">;
    sourceId: Id<"sources">;
  }[] = [];
  let questionRedacted = clarification.purgeAudit?.questionRedactedAtMs !== undefined;
  for (const fragmentId of clarification.conflictingFragmentIds) {
    const fragment = await db.get(fragmentId);
    if (fragment === null) {
      questionRedacted = true;
      continue;
    }
    const source = await requireContentAliveSource(
      db,
      fragment.sourceId,
      clarification.companyId,
    );
    if (source === null) {
      questionRedacted = true;
      continue;
    }
    activeConflictingEvidence.push({
      fragmentId,
      sourceId: source._id,
    });
  }
  const activeResolutionEvidence: {
    sourceId: Id<"sources">;
    fragmentId: Id<"sourceFragments"> | null;
  }[] = [];
  let storedBasisHasDeadSource = false;
  for (const reference of clarification.resolutionEvidence ?? []) {
    const source = await requireContentAliveSource(
      db,
      reference.sourceId,
      clarification.companyId,
    );
    if (source === null) {
      storedBasisHasDeadSource = true;
      continue;
    }
    activeResolutionEvidence.push({
      sourceId: source._id,
      fragmentId: reference.sourceFragmentId ?? null,
    });
  }
  // The stored basis decides the note: a source-backed basis redacts when
  // any cited source was purged; a legacy basis (never stored, pre-R1) redacts
  // with a redacted question — its basis is unknown and never guessed safe;
  // a manual boss decision rested on no source and keeps its note.
  const noteRedactedByBasis =
    clarification.state === "resolved" &&
    (storedBasisHasDeadSource ||
      (clarification.resolutionBasis === undefined && questionRedacted));
  const resolutionNoteRedacted =
    clarification.purgeAudit?.resolutionNoteRedactedAtMs !== undefined || noteRedactedByBasis;
  return {
    questionRedacted,
    resolutionNoteRedacted,
    activeConflictingEvidence,
    activeResolutionEvidence,
    actionable: clarification.state !== "open" || !questionRedacted,
  };
}
