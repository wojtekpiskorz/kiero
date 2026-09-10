/**
 * Personal hide rules ("Ukrycie kopii kalendarzowej", CONTEXT.md; G2 pure).
 *
 * Hiding is ONE boss's personal decision about ONE copy of ONE subject:
 * it never cancels the task or event, never hides another boss's copy, and
 * never touches Kiero's reminders. The decision survives corrections,
 * date changes, losing and regaining qualification, reopening and
 * reconnecting — until the same boss explicitly restores the copy. Only a
 * NEW, different subject starts unhidden ("nowe, odrębne zadanie nie
 * dziedziczy ukrycia poprzedniego").
 *
 * What the rules below deliberately do NOT encode: detecting a user's
 * deletion/move in Google. That observation belongs to G3's
 * reconciliation; once recorded on the copy it flows through these same
 * rules (a hide is a hide, however it was learned).
 */

/** Why a copy is (or stays) hidden. */
export type HideOrigin = "user_request" | "deleted_in_google" | "moved_in_google";

/** The hide state of one copy row. */
export interface HideState {
  readonly hidden: boolean;
  /** When/how the hide was last decided; null while not hidden. */
  readonly origin: HideOrigin | null;
}

/**
 * The hide decision after one projection re-derivation. Re-derivation
 * NEVER clears a hide — only an explicit restore request does. Returns
 * the next hide state plus whether the row's hidden flag changes.
 */
export function decideHideAfterDerivation(
  current: HideState,
  request: { readonly restore?: boolean } | undefined,
): { readonly next: HideState; readonly changed: boolean } {
  if (request?.restore === true) {
    return { next: { hidden: false, origin: null }, changed: current.hidden };
  }
  if (current.hidden) {
    return { next: current, changed: false };
  }
  return { next: current, changed: false };
}

/**
 * Whether a hidden copy must be absent from Google even though its subject
 * still qualifies: yes, always — the hide suppresses THIS boss's copy, it
 * does not withdraw the subject (other bosses' copies are untouched).
 */
export function hiddenCopyMustBeAbsent(hidden: boolean): boolean {
  return hidden;
}

/**
 * Whether a hide may be recorded for a subject that currently does NOT
 * qualify: yes — the row is retained so a later requalification finds the
 * hide still in force ("utrata i odzyskanie kwalifikacji").
 */
export function hideRetainedAcrossDisqualification(): true {
  return true;
}
