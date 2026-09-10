/**
 * Hydration rules (E5): the pure keep-or-drop decisions applied AFTER the
 * index matched, when the canonical D1/C2 records are re-read.
 *
 * "Results hydrate current canonical records before use; deleted/withdrawn
 * evidence and obsolete revisions cannot authorize an answer" (issue #39).
 * The index is disposable derived data; these rules are the authority gate
 * every result row passes through, INDEPENDENT of the derived rows being
 * refreshed: a stale index row that names a withdrawn source or a superseded
 * finding revision is dropped here even before the durable refresh job
 * physically removes it.
 *
 * Every rule keys on the caller's resolved company id: a canonical record
 * from another company never passes, whatever the derived row claims.
 */

/** The canonical source state one entry hydrates against. */
export interface HydratedSource {
  readonly sourceCompanyId: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
}

/** The canonical finding state one entry hydrates against. */
export interface HydratedFinding {
  readonly findingCompanyId: string;
  /** The revision the canonical finding currently projects. */
  readonly currentRevisionId: string | null;
}

/** The search filters the hydration pass enforces server-side. */
export interface RetrievalFilters {
  readonly projectId?: string;
  readonly authorUserId?: string;
  readonly sentFromMs?: number;
  readonly sentToMs?: number;
}

/** What one source-backed entry hydrates from the canonical record. */
export interface SourceHydrationInput {
  readonly source: HydratedSource;
  /** Project ids the source is linked to (empty when unlinked). */
  readonly linkedProjectIds: readonly string[];
  readonly authorUserId: string;
  readonly sentAtMs: number;
}

/** Keeps a source-backed entry: tenant scope, lifecycle and filters. */
export function keepSourceEntry(
  callerCompanyId: string,
  input: SourceHydrationInput,
  filters: RetrievalFilters,
): boolean {
  if (input.source.sourceCompanyId !== callerCompanyId) {
    return false;
  }
  if (input.source.lifecycle !== "active") {
    // Withdrawn ("Źródło wycofane") and purged sources authorize nothing.
    return false;
  }
  if (filters.projectId !== undefined && !input.linkedProjectIds.includes(filters.projectId)) {
    return false;
  }
  if (filters.authorUserId !== undefined && input.authorUserId !== filters.authorUserId) {
    return false;
  }
  if (filters.sentFromMs !== undefined && input.sentAtMs < filters.sentFromMs) {
    return false;
  }
  if (filters.sentToMs !== undefined && input.sentAtMs > filters.sentToMs) {
    return false;
  }
  return true;
}

/** Keeps a finding-backed entry: tenant scope and the CURRENT revision. */
export function keepFindingEntry(
  callerCompanyId: string,
  finding: HydratedFinding,
  indexedRevisionId: string | null,
  filters: RetrievalFilters,
): boolean {
  if (finding.findingCompanyId !== callerCompanyId) {
    return false;
  }
  if (
    finding.currentRevisionId === null ||
    indexedRevisionId === null ||
    finding.currentRevisionId !== indexedRevisionId
  ) {
    // No current projection, or the entry names a superseded revision:
    // an obsolete revision can never authorize an answer.
    return false;
  }
  // Project/author/date filters name MESSAGE attributes; finding-backed
  // entries have no single message author or send time, so any such filter
  // excludes them rather than guessing a scope they cannot prove.
  return filters.projectId === undefined && filters.authorUserId === undefined &&
    filters.sentFromMs === undefined && filters.sentToMs === undefined;
}
