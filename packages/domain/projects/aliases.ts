/**
 * Project codename (alias) rules (C1 domain half, pure).
 *
 * Vocabulary ("Alias projektu", CONTEXT.md): a working name that identifies
 * ONE project unambiguously within the firm, e.g. „Banan” or „Kaczmarek”.
 * In retained history a previous alias still denotes the same project, also
 * after a rename or the end of work.
 *
 * Rules encoded here:
 *
 * - Ordinary project names may collide; assigned codenames may not. A
 *   codename is reserved by its company's RETAINED history: renaming retires
 *   the old row (it stays, still pointing at the same project) and closure
 *   reserves every alias the project ever held. Another project claiming a
 *   reserved codename is a conflict, forever.
 * - The project that owns a codename may re-claim it (reactivating its own
 *   retired row); nobody else ever may. This keeps exactly one row per
 *   (company, codename) across all of history.
 * - A project is born with a GENERATED working alias (`#<sequence>`), so it
 *   is resolvable from the first inquiry before any boss-chosen codename
 *   exists. The `#<digits>` namespace is reserved for the generator: a
 *   boss-chosen codename from that shape is rejected, keeping generated and
 *   chosen names unambiguous.
 */

import type { Validated } from "./result";

/** Bounded codename: a working name, not a sentence. */
export const MAX_CODENAME_LENGTH = 100;

/** The reserved generated-working-alias namespace (`#7`, `#42`, …). */
const GENERATED_CODENAME_PATTERN = /^#\d+$/;

/** True for the reserved generated working aliases. */
export function isGeneratedCodename(codename: string): boolean {
  return GENERATED_CODENAME_PATTERN.test(codename);
}

/** The generated working alias of the n-th identified project of a firm. */
export function generatedCodename(sequence: number): string {
  return `#${sequence}`;
}

/** Normalizes a codename candidate: surrounding whitespace is not meaning. */
export function normalizeCodename(input: string): string {
  return input.trim();
}

/** Codename bounds and namespace rules (exact-match matching, no case folding). */
export function validateCodename(input: string): Validated<string> {
  const trimmed = normalizeCodename(input);
  if (trimmed.length === 0) {
    return { ok: false, code: "codename_empty" };
  }
  if (trimmed.length > MAX_CODENAME_LENGTH) {
    return { ok: false, code: "codename_too_long" };
  }
  if (isGeneratedCodename(trimmed)) {
    return { ok: false, code: "codename_generated_namespace" };
  }
  return { ok: true, value: trimmed };
}

/**
 * The reservation rows one (company, codename) pair already has. At most one
 * row exists per pair (the assignment core keeps it that way); the decision
 * stays total over any list so tests can probe the invariant itself.
 */
export interface AliasReservationView {
  readonly aliasId: string;
  readonly projectId: string;
  /** False once the codename was renamed away from; the row is retained. */
  readonly active: boolean;
}

/** What one codename assignment command does. */
export type CodenameAssignmentDecision =
  /** Fresh codename: insert an active row (retiring the current one). */
  | { readonly kind: "assign" }
  /** This project already holds this codename actively: idempotent no-op. */
  | { readonly kind: "already_active"; readonly aliasId: string }
  /** This project held it before: reactivate the retained row. */
  | { readonly kind: "reactivate"; readonly aliasId: string }
  /** Retained history reserves the codename for ANOTHER project: refuse. */
  | { readonly kind: "reserved_by_other" };

/**
 * Decides one codename claim against the firm's retained reservation rows
 * for that codename. Cross-project reservation holds regardless of the other
 * project's stage: closed projects keep their aliases reserved (the acceptance
 * criterion races one closed project against a fresh claim).
 */
export function decideCodenameReservation(
  reserved: readonly AliasReservationView[],
  targetProjectId: string,
): CodenameAssignmentDecision {
  // One full pass, order-independent: a foreign row refuses regardless of
  // where it sits beside the target's own rows (a codename can never denote
  // two projects, even transiently inside the decision).
  let activeOwn: AliasReservationView | null = null;
  let retainedOwn: AliasReservationView | null = null;
  for (const row of reserved) {
    if (row.projectId !== targetProjectId) {
      // Retained history — active OR retired — reserves it for that project.
      return { kind: "reserved_by_other" };
    }
    if (row.active) {
      if (activeOwn === null) {
        activeOwn = row;
      }
    } else if (retainedOwn === null || row.aliasId < retainedOwn.aliasId) {
      retainedOwn = row;
    }
  }
  if (activeOwn !== null) {
    return { kind: "already_active", aliasId: activeOwn.aliasId };
  }
  return retainedOwn === null
    ? { kind: "assign" }
    : { kind: "reactivate", aliasId: retainedOwn.aliasId };
}
