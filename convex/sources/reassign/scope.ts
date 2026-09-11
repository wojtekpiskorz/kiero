/**
 * The pure scope re-assessment decision of one project reassignment (E7,
 * issue #115): which findings the link change moves to
 * updating-until-revalidated. The D1 precedent (pure decisions live in the
 * lane's own convex module, unit-tested without a deployment); the C5
 * rules it applies:
 *
 * - "Mark derived findings as updating before reassessment and block them
 *   from authorizing automation", the marking preserves the value
 *   verbatim and never discards anything;
 * - "Preserve direct facts that still have valid independent evidence":
 *   a finding that still rests on another ACTIVE source which is itself
 *   still linked to the finding's scope project keeps standing;
 * - "A correction to one fragment or project assignment narrows the
 *   affected graph", only the unlinked project's findings are candidates;
 * - an explicit correction keeps its authority; an already-marked finding
 *   is not marked twice (idempotence).
 */

/** One witness reference of a candidate's current revision, placement-known. */
export interface ScopeWitnessRef {
  readonly sourceId: string;
  /** Whether that source's lifecycle still lets it witness anything. */
  readonly sourceActive: boolean;
  /** Whether that source is currently linked to the candidate's scope project. */
  readonly linkedToScope: boolean;
}

/** What the scope re-assessment decision needs about one candidate finding. */
export interface ScopeReassessmentInput {
  /** The knowledge-state tag of the candidate's CURRENT revision. */
  readonly currentKnowledgeTag: string | null;
  /** The origin of that revision (or null when absent). */
  readonly currentRevisionOrigin: string | null;
  /** Whether the candidate's scope project is still linked (false = removed). */
  readonly scopeProjectLinked: boolean;
  /** The id of the source that moved. */
  readonly movedSourceId: string;
  /** Whether the current revision rests on the moved source: cites it as a
   * witness or was published from it (provenance). */
  readonly restsOnMovedSource: boolean;
  /** The witness links of that revision with placement knowledge. */
  readonly currentWitnesses: readonly ScopeWitnessRef[];
}

/**
 * What the re-assessment does to one candidate finding.
 *
 * - `mark_updating`: the finding's placement lost the moved source's
 *   support and has no surviving placement witness, it becomes
 *   updating-until-revalidated (value preserved, excluded from automation);
 * - `retain`: the finding keeps standing, its scope is untouched, it is
 *   already marked, an explicit correction owns it, it does not rest on
 *   the moved source, or another active linked witness survives.
 */
export type ScopeReassessmentDecision =
  | { readonly decision: "mark_updating" }
  | {
      readonly decision: "retain";
      readonly basis:
        | "scope_still_linked"
        | "already_marked"
        | "explicit_correction"
        | "not_resting_on_moved_source"
        | "independent_placement_witness";
    };

export function decideScopeReassessment(
  input: ScopeReassessmentInput,
): ScopeReassessmentDecision {
  if (input.scopeProjectLinked) {
    // The narrowing rule: the link change did not touch this finding's scope.
    return { decision: "retain", basis: "scope_still_linked" };
  }
  if (input.currentKnowledgeTag !== "known") {
    // Unknown or updating already: visibly non-current; idempotent.
    return { decision: "retain", basis: "already_marked" };
  }
  if (input.currentRevisionOrigin === "correction") {
    // An explicit correction is its own resolution ("Korekta ustalenia").
    return { decision: "retain", basis: "explicit_correction" };
  }
  if (!input.restsOnMovedSource) {
    // A candidate that neither cites the moved source on its current
    // revision nor was published from it is not affected by this move.
    return { decision: "retain", basis: "not_resting_on_moved_source" };
  }
  const survivingWitness = input.currentWitnesses.some(
    (witness) =>
      witness.sourceId !== input.movedSourceId &&
      witness.sourceActive &&
      witness.linkedToScope,
  );
  if (survivingWitness) {
    // Independent placement evidence survives.
    return { decision: "retain", basis: "independent_placement_witness" };
  }
  return { decision: "mark_updating" };
}
