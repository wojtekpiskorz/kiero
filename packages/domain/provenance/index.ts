/**
 * @kiero/domain provenance surface (C5): the PURE withdrawal-recomputation
 * rules — the updating-until-revalidated state and its decisions, direct
 * dependent resolution and bounded recomputation grouping. No I/O, no
 * Convex; the durable executor in convex/memory/recompute runs these
 * decisions inside its own transaction, and tests/c5 proves them directly.
 * (No traversal ships here by design: the durable cascade terminates on
 * marking idempotence, and cycle safety is pinned with the graph invariant
 * in findings/provenance.)
 *
 * Named for later lanes: E6 (agent answers) treats `updating` findings as
 * excluded from authoritative answers; H3 (withdrawal UI) shows them as
 * visibly awaiting reassessment; E5 (search) and I4 (purge) consume
 * isUpdatingKnowledgeState the same way.
 */

export * from "./recompute";
