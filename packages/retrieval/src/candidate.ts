/**
 * The pinned initial index candidate (E5): which embedding model, dimensions,
 * text preparation and provider route version one index generation must be
 * built from.
 *
 * The bounded solution (issue #39): "Use E2's Qwen candidate at the initial
 * 4096 dimensions only after the live route proves it." The pins mirror
 * @kiero/providers' routing constants (E2 owns them); this package pins its
 * own copy so the pure cores stay free of node-typed imports, and
 * tests/e5/cores.test.ts fails loudly if either side drifts. Any change
 * to model, dimensions or preparation is a NEW generation, never a
 * per-request knob: `isCompatibleCandidate` is the single gate both
 * `search.startIndexGeneration` and the index-write path consult.
 */

import { TEXT_PREPARATION_VERSION } from "./preparation";

/** The version label of the frozen E2 embedding route this candidate rides. */
export const PROVIDER_ROUTE_VERSION = "e2.embedding.route.v1";

/** The pinned embedding model of the initial candidate (E2's first choice). */
export const INDEX_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";

/** The pinned native dimensions of the initial candidate (E2's baseline). */
export const INDEX_EMBEDDING_DIMENSIONS = 4096;

/** The complete pinned initial candidate for a search index generation. */
export const INDEX_CANDIDATE = {
  embeddingModel: INDEX_EMBEDDING_MODEL,
  dimensions: INDEX_EMBEDDING_DIMENSIONS,
  textPreparationVersion: TEXT_PREPARATION_VERSION,
  providerRouteVersion: PROVIDER_ROUTE_VERSION,
} as const;

/** What a generation request carries (the operation input shape). */
export interface CandidateRequest {
  readonly embeddingModel: string;
  readonly textPreparationVersion: string;
  readonly dimensions: number;
}

/**
 * The compatibility verdict with the sanitized reason the typed errors carry.
 * A request that is not exactly the pinned candidate is refused: building a
 * generation from an unproved model or dimension would silently mix
 * incompatible vectors later (the acceptance criterion this gate protects).
 */
export type CandidateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "model_not_supported" | "dimensions_not_supported" | "preparation_unknown" };

/** Checks one generation request against the pinned initial candidate. */
export function isCompatibleCandidate(request: CandidateRequest): CandidateVerdict {
  if (request.embeddingModel !== INDEX_CANDIDATE.embeddingModel) {
    return { ok: false, reason: "model_not_supported" };
  }
  if (request.dimensions !== INDEX_CANDIDATE.dimensions) {
    return { ok: false, reason: "dimensions_not_supported" };
  }
  if (request.textPreparationVersion !== INDEX_CANDIDATE.textPreparationVersion) {
    return { ok: false, reason: "preparation_unknown" };
  }
  return { ok: true };
}
