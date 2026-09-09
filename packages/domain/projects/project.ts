/**
 * Project identity rules (C1 domain half, pure).
 *
 * Vocabulary ("Projekt", CONTEXT.md): one concrete matter about a potential
 * or accepted assignment, existing from the first client inquiry. Later
 * quotation and realization belong to the same project.
 *
 * Rules encoded here:
 *
 * - A project is IDENTIFIED, not titled: the display name is catalog text
 *   from the identifying statement ("Bathroom at Kaczmarek's"), bounded and
 *   non-empty but deliberately NOT unique — ordinary names may collide while
 *   codenames may not (see ./aliases.ts).
 * - Identification may start at any stage ("Projekt może pojawić się w
 *   Kiero na dowolnym etapie"), including a retrospectively recorded closed
 *   project; the born-closed case records its closure instant at birth.
 * - The generated working alias sequence advances per identified project,
 *   so two firms' `#1` are different marks and one firm's `#1` and `#2` can
 *   never collide by construction.
 */

import type { Validated } from "./result";

/** Bounded project display name. */
export const MAX_PROJECT_NAME_LENGTH = 200;

/** Project display names carry words; whitespace-only is not a project. */
export function validateProjectDisplayName(name: string): Validated<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "project_name_empty" };
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    return { ok: false, code: "project_name_too_long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * The generated working alias sequence position for a newly identified
 * project: one past the number of projects the firm has already identified.
 * The transaction derives that count from the company-scoped index inside
 * ONE Convex transaction, so racing identifications serialize (OCC) and
 * recompute instead of colliding.
 */
export function nextWorkingAliasSequence(identifiedProjectCount: number): number {
  return identifiedProjectCount + 1;
}
