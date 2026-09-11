/**
 * Pure provenance rules for findings (C2): typed evidence, independent
 * corroboration versus derivation, and the acyclicity of the dependency
 * graph.
 *
 * - A WITNESS is a source (or fragment of one) that independently states the
 *   value: `support` or `independent_corroboration`. Derivation and
 *   supersession are NOT witness kinds — an agent's inference is never
 *   another witness ("Wniosek agenta ... nie jest ... niezależnym
 *   potwierdzeniem", issue 8).
 * - `independent_corroboration` differs from `support` in role only here; the
 *   transaction layer keeps them as distinct link rows so withdrawal of one
 *   source can leave the other standing ("Jedno ustalenie może mieć kilka
 *   niezależnych źródeł").
 * - Dependency edges (derivation, shared evidence, assignment) must stay
 *   ACYCLIC: `wouldCreateCycle` is the one decision both prepare and publish
 *   re-run, so a cycle is rejected before any write and again at the moment
 *   of writing (the graph may have moved between the two).
 */

/** The closed evidence-link vocabulary (mirrors the evidenceLinks table). */
export const EVIDENCE_SUPPORT_KINDS = [
  "support",
  "independent_corroboration",
  "derivation",
  "supersession",
] as const;
export type EvidenceSupportKind = (typeof EVIDENCE_SUPPORT_KINDS)[number];

/** The witness subset of the vocabulary: sources that state the value. */
export const WITNESS_SUPPORT_KINDS = ["support", "independent_corroboration"] as const;
export type WitnessSupportKind = (typeof WITNESS_SUPPORT_KINDS)[number];

/** The closed dependency-cause vocabulary (mirrors findingDependencies). */
export const DEPENDENCY_CAUSES = ["derivation", "shared_evidence", "assignment"] as const;
export type DependencyCause = (typeof DEPENDENCY_CAUSES)[number];

/** One directed dependency edge: `dependent` depends on `dependsOn`. */
export interface DependencyEdge {
  readonly dependent: string;
  readonly dependsOn: string;
}

/** Whether one support kind is a witness (a source stating the value). */
export function isWitnessKind(kind: EvidenceSupportKind): kind is WitnessSupportKind {
  return kind === "support" || kind === "independent_corroboration";
}

/**
 * Whether adding the planned edges to the existing graph would create a
 * directed cycle (a self-edge is a cycle). Pure DFS over the union graph;
 * duplicate edges are harmless.
 */
export function wouldCreateCycle(
  existing: readonly DependencyEdge[],
  planned: readonly DependencyEdge[],
): boolean {
  const adjacency = new Map<string, string[]>();
  const push = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list === undefined) {
      adjacency.set(from, [to]);
    } else {
      list.push(to);
    }
  };
  for (const edge of existing) {
    push(edge.dependent, edge.dependsOn);
  }
  for (const edge of planned) {
    push(edge.dependent, edge.dependsOn);
  }

  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const hasCycleFrom = (node: string, path: Set<string>): boolean => {
    const marked = state.get(node);
    if (marked === DONE) {
      return false;
    }
    if (marked === VISITING || path.has(node)) {
      return true;
    }
    path.add(node);
    state.set(node, VISITING);
    for (const next of adjacency.get(node) ?? []) {
      if (hasCycleFrom(next, path)) {
        return true;
      }
    }
    path.delete(node);
    state.set(node, DONE);
    return false;
  };
  for (const node of adjacency.keys()) {
    if (hasCycleFrom(node, new Set())) {
      return true;
    }
  }
  return false;
}

/**
 * One evidence reference as the withdrawal decision sees it: which source it
 * points at and whether it is a witness link.
 */
export interface EvidenceSupportRef {
  readonly sourceId: string;
  readonly supportKind: EvidenceSupportKind;
}

/** The knowledge-state origin of a revision, as withdrawal sees it. */
export type RevisionOrigin =
  | "publication"
  | "correction"
  | "withdrawal_marking"
  // E7 amendment (additive, flagged): the scope re-assessment marking of a
  // project reassignment; withdrawal treats it by its witness rules below
  // (not as an already-marked state, so a later withdrawal of the sole
  // witness still marks unknown).
  | "reassignment_marking";

/**
 * The withdrawal-marking decision (the pure half of "Źródło wycofane"):
 * given the CURRENT revision of a finding and its evidence links, does
 * withdrawing one source still leave the current information supported?
 *
 * - A current revision that IS an explicit correction stands: it is its own
 *   resolution, not support borrowed from the withdrawn source ("Późniejsze
 *   ... jawne poprawki zachowują swoją rolę").
 * - A publication stands while any witness link to ANOTHER source remains
 *   (independent corroboration keeps the finding alive).
 * - A revision that is already a withdrawal marking needs no second marking.
 * - Otherwise the finding must be marked unknown with the withdrawal reason;
 *   its value and full history stay intact.
 */
export type WithdrawalDecision =
  | { readonly decision: "retained"; readonly basis: "explicit_correction" | "independent_witness" | "already_marked" }
  | { readonly decision: "mark_unknown" };

export function decideWithdrawalMarking(args: {
  currentRevisionOrigin: RevisionOrigin;
  currentEvidence: readonly EvidenceSupportRef[];
  withdrawnSourceId: string;
}): WithdrawalDecision {
  if (args.currentRevisionOrigin === "withdrawal_marking") {
    return { decision: "retained", basis: "already_marked" };
  }
  if (args.currentRevisionOrigin === "correction") {
    return { decision: "retained", basis: "explicit_correction" };
  }
  const survivingWitness = args.currentEvidence.some(
    (link) =>
      link.sourceId !== args.withdrawnSourceId &&
      (link.supportKind === "support" || link.supportKind === "independent_corroboration"),
  );
  return survivingWitness
    ? { decision: "retained", basis: "independent_witness" }
    : { decision: "mark_unknown" };
}
