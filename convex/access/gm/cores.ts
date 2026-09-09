/**
 * GM decision cores (B4): the pure, timestamp-injected decisions behind
 * explicit audited GM access.
 *
 * Everything here is pure over plain views (no Convex types, no db): the
 * transactional halves (./operations.ts) feed them row snapshots, the unit
 * tests pin them, and the live proofs exercise them through the real
 * dispatch. The decisions implement the issue's authority model:
 *
 * - GM authority is an OPEN `gmAccessGrants` row ("grant"). Opening one is
 *   an explicit, reason-carrying action; only `access.exitGmMode` closes
 *   it, and TIME ELAPSED ALONE NEVER ENDS IT (there is deliberately no
 *   expiry decision here — an idle GM session stays open until it is
 *   explicitly exited or the actor signs out and the session dies).
 * - GM authority is SEPARATE from company membership ("GM", CONTEXT.md):
 *   `decideAuthoritySurfaces` is the one place that states the layering.
 *   A GM without membership acts through the grant; a member without a
 *   grant gains nothing; holding both yields both surfaces, never a blend.
 * - Company data is reachable in GM mode only while the target company's
 *   alpha participation is ACTIVE (an open `gmCompanyActivations` row).
 *   Ending participation removes grant-derived access to that firm
 *   immediately because every GM operation re-decides `decideGmCompanyAccess`
 *   inside its own transaction.
 */

/** The grant fields the decisions consume (a gmAccessGrants row snapshot). */
export interface GmGrantView {
  readonly id: string;
  readonly userId: string;
  readonly reason: string;
  readonly enteredAtMs: number;
  /** null = the grant is open (current GM authority). */
  readonly closedAtMs: number | null;
}

/** The activation fields the decisions consume. */
export interface GmActivationView {
  readonly id: string;
  readonly companyId: string;
  readonly activatedAtMs: number;
  /** null = the company currently participates in alpha. */
  readonly endedAtMs: number | null;
}

/** Bounded basis/reason length: auditable prose, not a textarea dump. */
export const MAX_GM_REASON_LENGTH = 500;

/** Normalizes a stated GM reason or basis ("podstawa"): trimmed, bounded. */
export function normalizeGmStatement(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GM_REASON_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

/** Whether one grant row is the actor's CURRENT GM authority. */
export function gmGrantOpen(grant: GmGrantView): boolean {
  return grant.closedAtMs === null;
}

/** Whether one activation row says the company currently participates. */
export function gmActivationOpen(activation: GmActivationView): boolean {
  return activation.endedAtMs === null;
}

/** The first open grant among a user's rows, or null. */
export function openGrantOfUser(grants: readonly GmGrantView[]): GmGrantView | null {
  return grants.find(gmGrantOpen) ?? null;
}

/**
 * The decision to open GM mode: one open grant per actor at a time. A
 * second entry attempt while one is open is an honest conflict — the actor
 * must exit first, so no interval ever hides inside another.
 */
export function decideGmEntry(
  grants: readonly GmGrantView[],
): { readonly ok: true } | { readonly ok: false; readonly code: "gm_mode_already_active" } {
  if (openGrantOfUser(grants) !== null) {
    return { ok: false, code: "gm_mode_already_active" };
  }
  return { ok: true };
}

/**
 * The decision to close GM mode: only the grant's own actor may exit it,
 * and only an open grant can be closed (closing twice is not_found).
 */
export function decideGmExit(
  grant: GmGrantView | null,
  actorUserId: string,
): { readonly ok: true; readonly grant: GmGrantView } | { readonly ok: false; readonly code: "gm_grant_not_open" | "gm_not_own_grant" } {
  if (grant === null) {
    return { ok: false, code: "gm_grant_not_open" };
  }
  if (grant.userId !== actorUserId) {
    // Another operator's interval is never closable from outside.
    return { ok: false, code: "gm_not_own_grant" };
  }
  if (!gmGrantOpen(grant)) {
    return { ok: false, code: "gm_grant_not_open" };
  }
  return { ok: true, grant };
}

/**
 * The per-operation GM authority decision over one target company. Every
 * GM operation runs this INSIDE its transaction, so a grant closed or an
 * activation ended concurrently denies at commit (OCC serializes the row
 * reads): "require current authority at commit".
 */
export function decideGmCompanyAccess(args: {
  readonly grantOpen: boolean;
  readonly companyExists: boolean;
  readonly activation: GmActivationView | null;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "forbidden"; readonly code: "gm_mode_not_active" | "company_alpha_not_active" }
  | { readonly ok: false; readonly kind: "not_found"; readonly code: "company_not_found" } {
  if (!args.grantOpen) {
    // No open grant: not GM right now (a member without a grant, or an
    // exited/never-entered operator). Denial carries no target data.
    return { ok: false, kind: "forbidden", code: "gm_mode_not_active" };
  }
  if (!args.companyExists) {
    return { ok: false, kind: "not_found", code: "company_not_found" };
  }
  if (args.activation === null || !gmActivationOpen(args.activation)) {
    // Grant-derived access ends with alpha participation, immediately and
    // structurally: nothing time-based, nothing cached.
    return { ok: false, kind: "forbidden", code: "company_alpha_not_active" };
  }
  return { ok: true };
}

/**
 * THE membership/GM layering matrix (one place, pure, pinned by tests).
 * Which dispatch surfaces resolve for an actor:
 *
 * - `gmSurface` (this lane's dispatch): requires an open grant. Membership
 *   is deliberately not consulted — the GM without membership acts through
 *   the grant alone.
 * - `memberSurface` (B1/B3 dispatches over the canonical chain): requires
 *   an active membership. The grant is deliberately not consulted — a
 *   member never gains GM powers, and isGm never widens member intents.
 */
export function decideAuthoritySurfaces(args: {
  readonly hasOpenGrant: boolean;
  readonly hasActiveMembership: boolean;
}): { readonly gmSurface: boolean; readonly memberSurface: boolean } {
  return {
    gmSurface: args.hasOpenGrant,
    memberSurface: args.hasActiveMembership,
  };
}

/**
 * Parses the deployment's GM operator allow-list (`KIERO_GM_EMAILS`,
 * comma-separated normalized addresses). An empty/absent list means NOBODY
 * may enter GM mode on that deployment — fail-closed by configuration.
 */
export function parseGmOperatorAllowList(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) {
    return new Set();
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry));
  return new Set(entries);
}

/**
 * Whether a verified account email may open GM mode on this deployment:
 * the allow-list is deployment configuration (the alpha owner's explicit
 * designation), the entry act itself remains the audited grant.
 */
export function decideGmEntryEligibility(
  email: string,
  allowList: ReadonlySet<string>,
): boolean {
  return allowList.size > 0 && allowList.has(email.trim().toLowerCase());
}
