/**
 * The ONE closed vocabulary of access refusal codes (R26, issue #232).
 *
 * B5's live qualification (defect D1) proved that classifying sign-in and
 * linking refusals by ERROR MESSAGE TEXT cannot work on a production-type
 * deployment: Convex sanitizes messages to "Server Error", so the honest
 * Polish copies keyed on `[kiero:…]` markers and library strings never
 * rendered. From R26 on, every classified refusal is thrown as a
 * `ConvexError` whose DATA carries one of the codes below — Convex
 * preserves `error.data` through production sanitization, so the client
 * decodes the code and never regexes the message.
 *
 * This module is a deliberate LEAF with zero imports (no convex runtime,
 * no Effect): the web app imports it for the typed union and the decoder,
 * the same way it already imports server types, so client and server pin
 * ONE vocabulary instead of drifting twin literals.
 */

/**
 * Refusals the SIGN-IN surface classifies: email delivery failures, the
 * per-address issuance budget, the no-implicit-linking policy rejection,
 * wrong/expired codes and the verification-failure budget.
 */
export const SIGN_IN_REFUSAL_CODES = [
  "email_delivery_failed",
  "issuance_rate_limited",
  "method_conflict",
  "code_wrong_or_expired",
  "too_many_attempts",
] as const;
export type SignInRefusalCode = (typeof SIGN_IN_REFUSAL_CODES)[number];

/**
 * The linking layer's typed rejection codes (one vocabulary for every
 * ceremony, email-change and linking lane; formerly defined inline in
 * ./linking/policy.ts, moved here so the closed union spans all refusals).
 */
export const LINK_REJECTION_CODES = [
  "method_already_attached",
  "target_account_established",
  "ceremony_in_progress",
  "no_active_ceremony",
  "proof_stale",
  "mismatched_address",
  "google_email_unproven",
  "code_wrong_or_expired",
  "too_many_attempts",
  "ambiguous_registry",
] as const;
export type LinkRejectionCode = (typeof LINK_REJECTION_CODES)[number];

/** Every refusal code any access surface can throw as structured data. */
export type AccessRefusalCode = SignInRefusalCode | LinkRejectionCode;

const ACCESS_REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...SIGN_IN_REFUSAL_CODES,
  ...LINK_REJECTION_CODES,
]);

/**
 * The structured payload refusal sites throw inside `ConvexError`:
 * `code` is the classification key; `message` keeps the previous marker +
 * copy text for logs and for older clients that still match messages —
 * nothing CLASSIFIES by it anymore. A type ALIAS (not an interface) on
 * purpose: `ConvexError<Data extends Value>` requires the index-signature
 * compatibility only aliases of literal shapes get.
 */
export type AccessRefusalData = {
  readonly code: AccessRefusalCode;
  readonly message: string;
};

/** Builds the refusal payload (the single construction point). */
export function accessRefusalData(
  code: AccessRefusalCode,
  message: string,
): AccessRefusalData {
  return { code, message };
}

/**
 * Decodes one thrown error's `data` field to a closed-vocabulary code,
 * or null when the data is absent/malformed (older deploys, network
 * errors, foreign ConvexErrors). Membership in the const sets keeps the
 * vocabulary closed; unknown codes decode to null (fail closed).
 */
export function decodeAccessRefusalCode(data: unknown): AccessRefusalCode | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const code = (data as { readonly code?: unknown }).code;
  if (typeof code !== "string" || !ACCESS_REFUSAL_CODES.has(code)) {
    return null;
  }
  return code as AccessRefusalCode;
}
