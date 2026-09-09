/**
 * Pure catalog-reuse rules (C3): label normalization (Polish-aware), the
 * stable key, name similarity and the typed reuse verdicts.
 *
 * "Before creating a definition, expose catalog search and similarity
 * candidates to the agent, while requiring meaning and type compatibility
 * rather than a name match" (issue #26). The verdict therefore NEVER says
 * "reuse" on a name alone: a near-duplicate name is either a reuse candidate
 * (the structure is compatible) or a NAME CONFLICT (the meaning differs —
 * create a distinct definition, never a silent reuse). Equivalent names with
 * incompatible units stay distinct definitions.
 *
 * All functions are I/O-free; the Convex catalog core runs them against the
 * firm catalog plus the shared definitions with this firm's usage counts.
 */

import type { FieldShapeView } from "./definitions";

/**
 * The similarity score at which a name counts as a near-duplicate. 0.6 lets
 * a one-token unit difference ("grubość płytki mm" vs "... cm", overlap 2/3)
 * surface as a typed `name_conflict` while unrelated two-token names
 * sharing one word ("telefony dostawcy" vs "kontakt do dostawcy", 1/2) stay
 * distinct.
 */
export const NEAR_DUPLICATE_SCORE = 0.6;

/** Polish diacritics fold: labels compare by letters, not by accents. */
const DIACRITICS: Readonly<Record<string, string>> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
};

/** Lowercases, folds Polish diacritics, strips punctuation, collapses spaces. */
export function normalizeLabel(label: string): string {
  const folded = label
    .toLowerCase()
    .split("")
    .map((character) => DIACRITICS[character] ?? character)
    .join("");
  return folded
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalized word tokens of a label (the similarity vocabulary). */
export function labelTokens(label: string): ReadonlySet<string> {
  const normalized = normalizeLabel(label);
  return new Set(normalized.length === 0 ? [] : normalized.split(" "));
}

/**
 * The stable key of a definition name: the normalized label. Two proposals
 * with the same stable key are the SAME definition name — the idempotency
 * key for duplicate-definition races and the never-silently-reuse guard
 * (unit words like "mm" survive in the key, so "Grubość płytki (mm)" and
 * "Grubość płytki (cm)" are different names).
 */
export function stableKeyOf(name: string): string {
  return normalizeLabel(name);
}

/**
 * Name similarity as the overlap coefficient over normalized token sets
 * (intersection over the SMALLER set): "grubość płytki" is fully contained
 * in "grubość płytki mm", so containment scores 1 even though the token
 * counts differ. Disjoint names score 0.
 */
export function nameSimilarity(a: string, b: string): number {
  const tokensA = labelTokens(a);
  const tokensB = labelTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.min(tokensA.size, tokensB.size);
}

/** The machine-checkable meaning signature of one field. */
function fieldSignature(field: FieldShapeView): string {
  return [field.kind, field.unit ?? "", field.itemKind ?? "", (field.options ?? []).length]
    .join("|");
}

/**
 * Meaning-and-type compatibility between a DRAFT structure and a candidate
 * version's structure: every draft field must have a candidate field with
 * the same signature (kind, declared unit, declared item kind, enum option
 * count). A candidate may offer MORE fields (later versions add optional
 * ones); a draft field the candidate cannot type is an incompatible meaning.
 */
export function structureCompatible(
  draft: readonly FieldShapeView[],
  candidate: readonly FieldShapeView[],
): boolean {
  const candidateSignatures = new Map<string, number>();
  for (const field of candidate) {
    const signature = fieldSignature(field);
    candidateSignatures.set(signature, (candidateSignatures.get(signature) ?? 0) + 1);
  }
  for (const field of draft) {
    const signature = fieldSignature(field);
    const available = candidateSignatures.get(signature) ?? 0;
    if (available === 0) {
      return false;
    }
    candidateSignatures.set(signature, available - 1);
  }
  return true;
}

/** The typed verdict of one catalog candidate against a proposed definition. */
export type CatalogVerdict = "reuse_candidate" | "name_conflict" | "distinct";

/** One catalog candidate as the assessment sees it. */
export interface CatalogCandidate {
  readonly name: string;
  readonly fields: readonly FieldShapeView[];
}

/** The assessment outcome carried per candidate (score, verdict, compatibility). */
export interface CatalogAssessment {
  readonly score: number;
  readonly verdict: CatalogVerdict;
  /** null when no draft structure was provided (name-level lookup only). */
  readonly structureCompatible: boolean | null;
}

/**
 * Assesses one candidate against a proposed definition (name always, draft
 * structure optionally): a near-duplicate name with a compatible structure
 * is a `reuse_candidate`; a near-duplicate name with an incompatible
 * structure is a `name_conflict` (distinct definition territory); anything
 * else is `distinct`. Without a draft structure the verdict stays at the
 * name level and compatibility is explicitly null — a name match alone is
 * never a typed reuse decision.
 */
export function assessCatalogCandidate(
  proposed: { readonly name: string; readonly fields?: readonly FieldShapeView[] | undefined },
  candidate: CatalogCandidate,
): CatalogAssessment {
  const score = nameSimilarity(proposed.name, candidate.name);
  const near = score >= NEAR_DUPLICATE_SCORE;
  if (proposed.fields === undefined) {
    return { score, verdict: near ? "reuse_candidate" : "distinct", structureCompatible: null };
  }
  const compatible = structureCompatible(proposed.fields, candidate.fields);
  return {
    score,
    verdict: !near ? "distinct" : compatible ? "reuse_candidate" : "name_conflict",
    structureCompatible: compatible,
  };
}
