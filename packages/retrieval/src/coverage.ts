/**
 * Retrieval coverage disclosure (E5).
 *
 * "Absence of a semantic hit is reported as retrieval coverage, not proof
 * that the fact does not exist" (issue #39). The coverage literal is the
 * honest disclosure the result carries; this module is its single decision
 * table:
 *
 * - `degraded`: no ACTIVE index generation exists. Full-text search over the
 *   derived index is unavailable too; typed/current structured reads (the
 *   D1 conversation views, C2 current findings) remain available through
 *   their own operations, unaffected by the index.
 * - `text_only`: an active generation exists, but the semantic half is not
 *   fully in play: either the query could not be embedded (embedding outage)
 *   or some entries in scope carry no embedding (embedding outage during the
 *   build or a generation cutover in progress). Text retrieval still serves;
 *   the semantic coverage gap is disclosed, never hidden.
 * - `full`: the query was embedded and every entry in the caller's company
 *   scope of the active generation is embedded.
 */

export type RetrievalCoverage = "full" | "text_only" | "degraded";

/** The observed retrieval inputs the decision needs. */
export interface CoverageInputs {
  /** An active index generation exists. */
  readonly activeGeneration: boolean;
  /** The query text was embedded successfully for this request. */
  readonly queryEmbedded: boolean;
  /** Entries in the caller's company scope of the active generation. */
  readonly indexedEntries: number;
  /** Of those, entries that carry an embedding. */
  readonly embeddedEntries: number;
}

/** Decides the coverage literal for one query result. */
export function computeCoverage(inputs: CoverageInputs): RetrievalCoverage {
  if (!inputs.activeGeneration) {
    return "degraded";
  }
  if (!inputs.queryEmbedded) {
    return "text_only";
  }
  if (inputs.embeddedEntries < inputs.indexedEntries) {
    return "text_only";
  }
  return "full";
}
