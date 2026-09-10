/**
 * Pure withdrawal-recomputation rules (C5): the dependency traversal that
 * locates affected findings and the revalidation-state decisions that decide
 * what happens to them — the "Źródło wycofane" half C2's marking core does
 * not cover (derivation-only dependents located through findingDependencies).
 *
 * Protocol step 8 (architecture design): "Dependent inferred conclusions
 * become updating until revalidated and cannot drive automation; unrelated
 * findings remain usable." The `updating` knowledge state is the visible
 * marker: the derived VALUE is preserved verbatim (never discarded), the
 * finding is excluded from automation (work dueness gates on anything not
 * `known`), and the marking is replaced only by a newer publication or an
 * explicit correction — revalidation.
 *
 * Everything here is pure (no I/O, no Convex); the durable executor in
 * convex/memory/recompute runs these decisions inside its own transaction
 * and tests/c5 proves them directly.
 */

import { Schema } from "effect";
import { KnowledgeState } from "@kiero/contracts";
import type { DependencyCause, DependencyEdge } from "../findings/provenance";

/**
 * The explicit updating construction: the value stays, its epistemic state
 * says the basis moved and the conclusion awaits reassessment.
 */
export function explicitUpdating(reason: string): KnowledgeState {
  return Schema.decodeUnknownSync(KnowledgeState)({
    _tag: "updating",
    reason,
  });
}

/** The reason recorded when a dependent conclusion awaits revalidation. */
export function updatingUntilRevalidatedReason(detail: string): string {
  return `updating_until_revalidated: ${detail}`;
}

/** The reason recorded on the revision that performs an updating marking. */
export function dependentUpdatingReason(rootFindingId: string, cause: string): string {
  return `dependent_updating:${rootFindingId}:${cause}`;
}

/** The minimal shape the automation gate needs from a knowledge state. */
export interface KnowledgeTagLike {
  readonly _tag: string;
}

/**
 * Whether one knowledge state is the updating-until-revalidated marking.
 * The named predicate consumers (notifications, Calendar, E6) gate on —
 * work/dueness already refuses every state other than `known`, so the two
 * gates cannot disagree (tests/c5 pins the agreement).
 */
export function isUpdatingKnowledgeState(state: KnowledgeTagLike): boolean {
  return state._tag === "updating";
}

/**
 * Whether a finding's current revision has been revalidated after an
 * updating marking: the marking is a `withdrawal_marking` revision, so any
 * NEWER origin (a source-backed publication or an explicit correction)
 * replaced it. Precedence stays with meaning, never with arrival time.
 */
export function isRevalidated(revisionOrigin: string, knowledgeTag: string): boolean {
  if (isUpdatingKnowledgeState({ _tag: knowledgeTag })) {
    return false;
  }
  return revisionOrigin === "publication" || revisionOrigin === "correction";
}

// ---------------------------------------------------------------------------
// The dependency traversal (tenant edges are supplied by the caller; the
// tenant scope itself is the transaction layer's job). The durable executor
// realizes this walk ONE bounded level per transaction (the cascade through
// memory.dependentsMarkedStale); these pure functions are its model and the
// later graph consumers' (E5 search reindexing, I4 purge) reusable core.
// ---------------------------------------------------------------------------

/**
 * One direct-dependents batch of a resumable walk: the dependents of the
 * current frontier that were not visited yet. Pure and deterministic, so a
 * crashed walk replays to the same batches (the committed marking revisions
 * and the published events are the durable checkpoints between them).
 * All three dependency causes traverse; the per-cause decision happens at
 * marking time (decideDependentRecomputation).
 */
export function nextDependentsBatch(
  edges: readonly DependencyEdge[],
  visited: ReadonlySet<string>,
  frontier: readonly string[],
): { readonly batch: string[]; readonly visited: ReadonlySet<string> } {
  const nextVisited = new Set(visited);
  for (const root of frontier) {
    nextVisited.add(root);
  }
  const frontierSet = new Set(frontier);
  const batch: string[] = [];
  for (const edge of edges) {
    if (!frontierSet.has(edge.dependsOn)) {
      continue;
    }
    if (!batch.includes(edge.dependent) && !visited.has(edge.dependent)) {
      batch.push(edge.dependent);
    }
  }
  for (const id of batch) {
    nextVisited.add(id);
  }
  return { batch, visited: nextVisited };
}

/**
 * The full cycle-safe dependents walk from a set of root findings (breadth
 * first, every finding at most once). Acyclicity is a graph INVARIANT
 * (checked at prepare and publish), but corrupted or concurrently-built
 * graphs must not hang the walk: the visited set terminates any cycle.
 * Used by tests to pin diamond merges, deep chains and cycle safety; the
 * executor consumes the per-level batches instead so each level is one
 * bounded durable transaction.
 */
export function traverseDependents(
  edges: readonly DependencyEdge[],
  roots: readonly string[],
): { readonly levels: string[][]; readonly visited: readonly string[] } {
  const visited = new Set<string>();
  const levels: string[][] = [];
  let frontier = [...new Set(roots)];
  for (const root of frontier) {
    visited.add(root);
  }
  while (frontier.length > 0) {
    const { batch, visited: nextVisited } = nextDependentsBatch(edges, visited, frontier);
    for (const id of nextVisited) {
      visited.add(id);
    }
    if (batch.length > 0) {
      levels.push(batch);
    }
    frontier = batch;
  }
  return { levels, visited: [...visited] };
}

/** The direct dependents of one finding, deduplicated, order-stable. */
export function directDependents(
  edges: readonly DependencyEdge[],
  findingId: string,
): string[] {
  const out: string[] = [];
  for (const edge of edges) {
    if (edge.dependsOn === findingId && !out.includes(edge.dependent)) {
      out.push(edge.dependent);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-dependent recomputation decision.
// ---------------------------------------------------------------------------

/** One witness reference of a dependent's current revision, lifecycle-known. */
export interface DependentWitnessRef {
  readonly sourceId: string;
  readonly supportKind: string;
  /** Whether that source's lifecycle still lets it witness anything. */
  readonly sourceActive: boolean;
}

/** What the recomputation decision needs about one dependent finding. */
export interface DependentRecomputationInput {
  /** The dependency cause connecting the dependent to the moved root. */
  readonly cause: DependencyCause;
  /** The origin of the dependent's CURRENT revision (or null when absent). */
  readonly currentRevisionOrigin: string | null;
  /** The knowledge-state tag of that revision (or null when absent). */
  readonly currentKnowledgeTag: string | null;
  /** The witness links of that revision with their source lifecycles. */
  readonly currentWitnesses: readonly DependentWitnessRef[];
}

/**
 * What recomputation does to one dependent finding.
 *
 * - `mark_updating`: a derivation lost its basis — the inferred conclusion
 *   becomes updating-until-revalidated (value preserved, excluded from
 *   automation, NOT discarded);
 * - `retain`: the dependent stands on its own — an explicit correction keeps
 *   its authority, an own live witness survives ("independent evidence
 *   survives"), an already-marked finding is not marked twice (idempotence),
 *   and a non-derivation edge (shared evidence, assignment) is judged by the
 *   witness-based marking core instead, which already ran;
 * - `gone`: the dependent (or its revision) no longer exists — nothing to do.
 */
export type DependentRecomputationDecision =
  | { readonly decision: "mark_updating" }
  | {
      readonly decision: "retain";
      readonly basis:
        | "explicit_correction"
        | "independent_witness"
        | "already_marked"
        | "witness_judged_elsewhere"
        | "no_current_revision";
    }
  | { readonly decision: "gone" };

export function decideDependentRecomputation(
  input: DependentRecomputationInput,
): DependentRecomputationDecision {
  if (input.currentRevisionOrigin === null || input.currentKnowledgeTag === null) {
    return { decision: "gone" };
  }
  if (input.currentKnowledgeTag === "unknown") {
    // Already cleared (e.g. the marking core removed its only witness).
    return { decision: "retain", basis: "already_marked" };
  }
  if (isUpdatingKnowledgeState({ _tag: input.currentKnowledgeTag })) {
    return { decision: "retain", basis: "already_marked" };
  }
  if (input.currentRevisionOrigin === "correction") {
    return { decision: "retain", basis: "explicit_correction" };
  }
  if (input.cause !== "derivation") {
    // Shared-evidence and assignment dependents are facts with their own
    // witnesses; the witness-based marking core (C2) already judged them
    // against the withdrawn source. Derivation conclusions are the ones
    // whose BASIS moved.
    return { decision: "retain", basis: "witness_judged_elsewhere" };
  }
  const ownWitness = input.currentWitnesses.some(
    (witness) =>
      witness.sourceActive &&
      (witness.supportKind === "support" ||
        witness.supportKind === "independent_corroboration"),
  );
  if (ownWitness) {
    // A derivation that also carries a live witness of its own: the
    // conclusion is not resting on the moved basis alone.
    return { decision: "retain", basis: "independent_witness" };
  }
  return { decision: "mark_updating" };
}

// ---------------------------------------------------------------------------
// Bounded recomputation groups (the reanalysis registrations).
// ---------------------------------------------------------------------------

/** One dependent eligible for linked re-analysis through the E3 seam. */
export interface RecomputeTarget {
  readonly findingId: string;
  /** The source the dependent's current revision was published from. */
  readonly provenanceSourceId: string;
  /** Whether that provenance source is still active (reanalyzable). */
  readonly provenanceSourceActive: boolean;
}

/** One bounded recomputation group: every affected finding of ONE source. */
export interface RecomputeGroup {
  readonly sourceId: string;
  readonly findingIds: string[];
}

/**
 * Groups recomputation targets by their provenance source, keeping only
 * sources that can still be re-analyzed (a withdrawn or purged provenance
 * source supports no new run; its dependents stay updating until NEW
 * evidence arrives — the honest visible state, never a silent restore).
 * Re-analysis of one source reconsiders all its affected findings together,
 * so the number of registered runs stays bounded by distinct sources.
 */
export function groupRecomputeBatches(
  targets: readonly RecomputeTarget[],
): RecomputeGroup[] {
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    if (!target.provenanceSourceActive) {
      continue;
    }
    const existing = groups.get(target.provenanceSourceId);
    if (existing === undefined) {
      groups.set(target.provenanceSourceId, [target.findingId]);
    } else if (!existing.includes(target.findingId)) {
      existing.push(target.findingId);
    }
  }
  return [...groups.entries()].map(([sourceId, findingIds]) => ({ sourceId, findingIds }));
}
