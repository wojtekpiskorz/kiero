/**
 * Desired-state diffing (G2 pure): reconcile the copies one connection
 * ALREADY has against the desired copies its current derivation produces.
 *
 * This is the seam G3 completes against Google: every outcome here is an
 * idempotent decision (create / update / withdraw / none) with a stable
 * semantic id, so a repeated pass over unchanged data produces zero
 * actions ("kolejne próby synchronizacji tego samego obiektu nie tworzą
 * dodatkowych kopii") and an unknown Google outcome never needs a blind
 * retry — the desired state stays until a later pass re-derives it.
 */

import type { DesiredGoogleEvent, SubjectExclusion, TermWithdrawReason } from "./projection";

/**
 * The desired state of one subject's copy after a pass. The derivation
 * basis lives INSIDE the variants: a `projected` desire always carries the
 * revision its payload was derived from (never null), while a `withdrawn`
 * desire keeps the last known revision when the binding is gone entirely.
 */
export interface DesiredCopy {
  readonly subjectKind: "task" | "event";
  readonly subjectId: string;
  readonly semanticId: string;
  readonly desired: DesiredOutcome;
}

/** One outcome variant of a desired copy (see DesiredCopy). */
export type DesiredOutcome =
  | {
      readonly state: "projected";
      readonly payload: DesiredGoogleEvent;
      readonly derivationRevisionId: string;
    }
  | {
      readonly state: "withdrawn";
      readonly reason: SubjectExclusion | TermWithdrawReason;
      /** Null only when the binding disappeared without a current revision. */
      readonly derivationRevisionId: string | null;
    };

/** The stored state of one existing copy row (what the pass reads back). */
export interface ExistingCopy {
  readonly copyId: string;
  readonly subjectKind: "task" | "event";
  readonly subjectId: string;
  readonly semanticId: string;
  readonly hidden: boolean;
  readonly derivationRevisionId: string | null;
  readonly desiredState: "projected" | "withdrawn";
  readonly payload: DesiredGoogleEvent | null;
}

/** One reconciliation action. */
export type CopyAction =
  | {
      readonly action: "create";
      readonly desired: DesiredCopy;
    }
  | {
      readonly action: "update";
      readonly copyId: string;
      readonly desired: DesiredCopy;
      /** What changed relative to the stored row. */
      readonly changes: ReadonlyArray<"payload" | "semantic_id" | "derivation">;
    }
  | {
      readonly action: "none";
      readonly copyId: string;
      readonly desired: DesiredCopy;
    };

/** Canonical JSON: object keys sorted, arrays ordered, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Diffs existing copies against desired copies for ONE connection.
 * Subjects are matched by (kind, id) — the row identity, not the semantic
 * id (an account switch re-mints the semantic id on the SAME row while
 * hide and personal state survive it).
 *
 * - A row is CREATED only for a `projected` desire: withdrawn subjects
 *   never earn a row (a hide can only live on an existing copy).
 * - An orphan row (its subject no longer fed to the pass at all) is
 *   withdrawn honestly as out of scope — it is never silently kept.
 * - Determinism/idempotence: a second run over the applied result yields
 *   only `none` actions (property-tested); repeated syncs of the same
 *   object never create additional copies.
 */
export function diffDesiredCopies(
  existing: readonly ExistingCopy[],
  desired: readonly DesiredCopy[],
): CopyAction[] {
  const bySubject = new Map<string, ExistingCopy>();
  for (const row of existing) {
    bySubject.set(subjectKey(row.subjectKind, row.subjectId), row);
  }
  const actions: CopyAction[] = [];
  const seen = new Set<string>();
  for (const want of desired) {
    const key = subjectKey(want.subjectKind, want.subjectId);
    seen.add(key);
    const have = bySubject.get(key);
    if (have === undefined) {
      if (want.desired.state === "projected") {
        actions.push({ action: "create", desired: want });
      }
      continue;
    }
    const changes: Array<"payload" | "semantic_id" | "derivation"> = [];
    if (have.semanticId !== want.semanticId) {
      changes.push("semantic_id");
    }
    if (have.derivationRevisionId !== want.desired.derivationRevisionId) {
      changes.push("derivation");
    }
    if (
      want.desired.state === "projected" &&
      (have.desiredState !== "projected" ||
        have.payload === null ||
        canonicalJson(have.payload) !== canonicalJson(want.desired.payload))
    ) {
      changes.push("payload");
    }
    if (want.desired.state === "withdrawn" && have.desiredState !== "withdrawn") {
      changes.push("payload");
    }
    actions.push(
      changes.length === 0
        ? { action: "none", copyId: have.copyId, desired: want }
        : { action: "update", copyId: have.copyId, desired: want, changes },
    );
  }
  for (const [key, have] of bySubject) {
    if (!seen.has(key)) {
      if (have.desiredState === "withdrawn") {
        continue;
      }
      actions.push({
        action: "update",
        copyId: have.copyId,
        desired: {
          subjectKind: have.subjectKind,
          subjectId: have.subjectId,
          semanticId: have.semanticId,
          desired: {
            state: "withdrawn",
            reason: "out_of_personal_scope",
            derivationRevisionId: have.derivationRevisionId,
          },
        },
        changes: ["payload"],
      });
    }
  }
  return actions;
}

/** The stable subject key shared by rows and desired copies. */
export function subjectKey(kind: "task" | "event", id: string): string {
  return `${kind}:${id}`;
}
