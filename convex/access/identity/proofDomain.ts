/**
 * The reserved proof-fixture domain (B1 dev evidence).
 *
 * The guarded proof actions (convex/access/identity/probe.ts) can install
 * fixture verification codes. To make "guard enabled" a NECESSARY but not
 * SUFFICIENT condition for account takeover, the fixture may only ever
 * target addresses under the reserved `.invalid` TLD (RFC 2606): real
 * person addresses are refused even when the dev guard flag is on.
 */

/** True only for addresses on the reserved proof domain. */
export function isProofFixtureEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@kiero.invalid");
}
