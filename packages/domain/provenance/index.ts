/**
 * @kiero/domain provenance surface (C5): the PURE withdrawal-recomputation
 * rules — cycle-safe dependency traversal, the updating-until-revalidated
 * state and its decisions, and bounded recomputation grouping. No I/O, no
 * Convex; the durable executor in convex/memory/recompute runs these
 * decisions inside its own transaction, and tests/c5 proves them directly.
 *
 * Named for later lanes: E6 (agent answers) treats `updating` findings as
 * excluded from authoritative answers; H3 (withdrawal UI) shows them as
 * visibly awaiting reassessment; E5 (search) and I4 (purge) consume
 * isUpdatingKnowledgeState the same way.
 */

export * from "./recompute";
