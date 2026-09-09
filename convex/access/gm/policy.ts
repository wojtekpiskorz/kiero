/**
 * The B4 GM lane policy: the authoritative rule set for the GM dispatch
 * surface, layered OVER B3's membership rules (not instead of them).
 *
 * What decides where (mirroring B3's documented split):
 *
 * - Session liveness is enforced BEFORE this policy, by the B1 identity
 *   resolution the GM dispatch composes (provision-or-refresh); a denied
 *   session resolves no authority and fails `unauthenticated`.
 * - `decideGmRequest` decides HERE, over resolved facts only — and RUNS in
 *   the real gate: `resolveGmAuthority` (./dispatch.ts) calls it on every
 *   GM command. GM authority is an OPEN grant. Membership is deliberately
 *   NOT consulted — the GM without membership acts through the grant,
 *   exactly as the issue and CONTEXT.md ("GM") require.
 * - The per-company authority (open grant + existing company + OPEN alpha
 *   activation) is TRANSACTIONAL: it is re-decided inside every operation's
 *   transaction by `decideGmCompanyAccess` (./cores.ts), so racing an exit
 *   or an alpha-ending with a command denies at commit.
 *
 * The two-way fail-closed routing — member operations never route through
 * the GM dispatch and GM operations never route through the membership
 * dispatch — is STRUCTURAL: the registries themselves (GM_OPERATIONS here,
 * B1/B3's handler tables there) contain no foreign names. The focused
 * verification pins it against those real registries; no second,
 * hand-maintained copy of their names exists here.
 */

/** The operation names the GM dispatch routes (this lane's allowlist). */
export const GM_OPERATIONS: readonly string[] = [
  "access.exitGmMode",
  "access.recoverAccount",
  "access.gmInspectCompany",
  "access.gmOnboardCompany",
  "access.gmActivateCompany",
  "access.gmRestoreAdministrator",
  "access.gmEndCompanyAlpha",
];

/** The decision inputs: resolved facts about the acting request. */
export interface GmRequestFacts {
  /** A live, unrevoked session resolved (B1 identity source). */
  readonly hasLiveSession: boolean;
  /** An open gmAccessGrants row for the session's user. */
  readonly hasOpenGrant: boolean;
}

export type GmRequestDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly kind: "unauthenticated" }
  | { readonly allowed: false; readonly kind: "forbidden"; readonly code: "gm_mode_not_active" };

/**
 * The GM dispatch gate: no live session denies unauthenticated; a live
 * session without an open grant denies forbidden (a member without a GM
 * grant gains nothing here). An open grant allows the GM surface REGARDLESS
 * of membership — that independence is the layering this lane owns.
 */
export function decideGmRequest(facts: GmRequestFacts): GmRequestDecision {
  if (!facts.hasLiveSession) {
    return { allowed: false, kind: "unauthenticated" };
  }
  if (!facts.hasOpenGrant) {
    return { allowed: false, kind: "forbidden", code: "gm_mode_not_active" };
  }
  return { allowed: true };
}
