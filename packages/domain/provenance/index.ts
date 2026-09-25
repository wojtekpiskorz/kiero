/**
 * @kiero/domain provenance surface: the PURE withdrawal-recomputation
 * rules — the updating-until-revalidated state and its decisions, direct
 * dependent resolution and bounded recomputation grouping. No I/O, no
 * Convex; the durable executor in convex/memory/recompute runs these
 * decisions inside its own transaction, and tests/c5 proves them directly.
 * (No traversal ships here by design: the durable cascade terminates on
 * marking idempotence, and cycle safety is pinned with the graph invariant
 * in findings/provenance.)
 *
 * Consumers: agent answers treat `updating` findings as
 * excluded from authoritative answers; the withdrawal UI shows them as
 * visibly awaiting reassessment; search and purge consume
 * isUpdatingKnowledgeState the same way.
 */

export * from "./recompute";
