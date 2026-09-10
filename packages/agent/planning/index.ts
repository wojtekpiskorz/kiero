/**
 * @kiero/agent/planning: the pure planning surface for text analysis (E3).
 *
 * Small public interface, Convex-free and model-free by construction:
 *
 * - `AnalysisContext` + derivations: the tenant-filtered snapshot of
 *   current structured state one run reads, with the input-revision
 *   version it must record;
 * - the three tool input schemas (`memory_upsert_finding`,
 *   `projects_identify`, `memory_ask_clarification`): the decode authority
 *   for tool arguments coming back through E2's chat adapter;
 * - `applyDecodedCall`: the decoded-not-executed reducer that validates a
 *   decoded call against the context and accumulates the plan;
 * - `boundPublicationGroups` + `decideGroupPublish`: bounded source-linked
 *   publication groups and the honest mid-run staleness refusal;
 * - `buildTemporalValue`/`buildMoneyValue`: server-side value anchoring
 *   (relative dates against the source's sentAt/timezone; VAT never
 *   inferred);
 * - the versioned Polish dialogue builder (system prompt, context message,
 *   tool-result encodings);
 * - coverage honesty: a missing required segment is pending, and a
 *   text-only run cannot claim to have inspected a pending image.
 *
 * The Convex-coupled halves (workflow stages, durable executors, C2
 * publication transactions, provider calls) live in convex/processing/text.
 */

export * from "./versions";
export * from "./coverage";
export * from "./context";
export * from "./tools";
export * from "./quotes";
export * from "./values";
export * from "./reducer";
export * from "./bounding";
export * from "./prompt";
