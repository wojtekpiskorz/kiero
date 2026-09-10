/**
 * The shared pure-validation outcome: a value or a sanitized machine code.
 *
 * Codes are stable English identifiers surfaced through the closed
 * `validation` error kind by the transaction halves; they never carry
 * internal detail. A validator that can refuse for exactly one closed set
 * of reasons instantiates `C` with that union, so callers keep the narrow
 * type without re-mapping each literal to itself; the `string` default
 * keeps open-vocabulary validators (and every pre-existing caller)
 * compiling unchanged.
 *
 * C4 coordinated amendment (flagged, additive): the code type parameter.
 */

export type Validated<T, C extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: C };

