/**
 * The shared pure-validation outcome: a value or a sanitized machine code.
 *
 * Codes are stable English identifiers surfaced through the closed
 * `validation` error kind by the transaction halves; they never carry
 * internal detail.
 */

export type Validated<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly code: string;
};
