/**
 * Membership domain cores (B3): the pure decision halves of company
 * admission, invitations, roles and administration transfer.
 *
 * Every rule the issue names lives here as a total function over small row
 * views, so tests/b3 prove the boundaries (expiry edges, single use, the
 * one-active-company rule, the last-admin invariant, transfer atomicity)
 * without a deployment. The transaction halves (./operations.ts) adapt
 * these decisions to ONE Convex mutation each; nothing here reads the db.
 *
 * Vocabulary ("Członkostwo w firmie", "Zaproszenie do firmy",
 * "Administrator firmy", CONTEXT.md): a membership links one person to one
 * firm with a role; an invitation targets exactly one email address;
 * administration is the admin role — the first boss of a fresh firm holds
 * it, later invitees receive member unless an administrator explicitly
 * grants otherwise.
 */

import type { CompanyId, MembershipId, MembershipRole, UserId } from "@kiero/contracts";

/** An invitation expires after seven days (issue #22 bounded solution). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Single-use acceptance code: 8 digits, like the B1 sign-in code. */
export const INVITATION_CODE_LENGTH = 8;

/** Bounded invitation email and company name inputs. */
export const MAX_COMPANY_NAME_LENGTH = 100;
export const MAX_INVITATION_EMAIL_LENGTH = 254;

/** The invitation row view the admission decision consumes. */
export interface InvitationView {
  readonly state: "pending" | "accepted" | "revoked" | "expired" | "rejected";
  readonly email: string;
  readonly role: MembershipRole;
  readonly companyId: CompanyId;
  readonly codeHash: string;
  readonly expiresAtMs: number;
}

/** The verified-person view the admission decision consumes. */
export interface InviteeView {
  /** The actor's normalized account address (B1 user row). */
  readonly email: string;
  /** A Google-method identity is attached to this person. */
  readonly hasGoogleSubject: boolean;
  /** When the account address was proven (email_verified / OTP time). */
  readonly emailVerifiedMs: number | null;
  /** The earliest active membership row, when one exists. */
  readonly activeMembership: { readonly companyId: CompanyId } | null;
}

/** Why an admission failed (mapped to closed errors by the transaction). */
export type AdmissionFailureCode =
  | "invitation_not_pending"
  | "invitation_expired"
  | "invitation_not_addressed_to_actor"
  | "email_control_unproven"
  | "verification_code_mismatch"
  | "one_active_company_rule";

/** What a valid admission grants. */
export interface AdmissionGrant {
  readonly companyId: CompanyId;
  readonly role: MembershipRole;
}

/** The closed-error kind each failure surfaces as (contract error kinds). */
export function admissionErrorKind(code: AdmissionFailureCode): "validation" | "not_found" | "conflict" {
  switch (code) {
    case "invitation_not_addressed_to_actor":
      // The invitation is not the actor's business: no existence leak.
      return "not_found";
    case "email_control_unproven":
    case "verification_code_mismatch":
      return "validation";
    case "invitation_not_pending":
    case "invitation_expired":
    case "one_active_company_rule":
      return "conflict";
  }
}

/**
 * The atomic admission decision over one invitation, one verified person
 * and one hashed code: target address control, expiry, revocation, use
 * count and the one-active-company rule in one total function.
 *
 * Boundary: an invitation is expired only AFTER its expiry instant
 * (`now > expiresAt`), so "usable until" stays inclusive and
 * "one millisecond later" refuses, deterministically.
 */
export function decideInvitationAdmission(
  invitation: InvitationView,
  invitee: InviteeView,
  codeHash: string,
  nowMs: number,
): { readonly ok: true; readonly grant: AdmissionGrant } | {
  readonly ok: false;
  readonly code: AdmissionFailureCode;
} {
  if (invitation.email !== invitee.email) {
    return { ok: false, code: "invitation_not_addressed_to_actor" };
  }
  if (invitee.hasGoogleSubject && invitee.emailVerifiedMs === null) {
    // A Google identity whose address Google never marked verified did not
    // prove control of the mailbox an invitation targets. Email-code
    // persons prove the mailbox with every sign-in.
    return { ok: false, code: "email_control_unproven" };
  }
  if (invitation.state !== "pending") {
    return { ok: false, code: "invitation_not_pending" };
  }
  if (nowMs > invitation.expiresAtMs) {
    return { ok: false, code: "invitation_expired" };
  }
  if (invitation.codeHash !== codeHash) {
    return { ok: false, code: "verification_code_mismatch" };
  }
  if (invitee.activeMembership !== null) {
    // v1: one active firm per ordinary user ("Członkostwo w firmie").
    return { ok: false, code: "one_active_company_rule" };
  }
  return { ok: true, grant: { companyId: invitation.companyId, role: invitation.role } };
}

/** The membership row view the role/administration decisions consume. */
export interface MembershipView {
  readonly _id: MembershipId;
  readonly companyId: CompanyId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly state: "active" | "revoked";
}

/** A membership row with its creation time (rows always carry one). */
export interface MembershipViewWithTime extends MembershipView {
  readonly createdAtMs: number;
}

/**
 * The v1 active-firm rule, identical to the canonical resolution
 * (convex/platform/context.ts): the EARLIEST active membership defines the
 * user's one active firm. B3 keeps this the authoritative rule while the
 * schema admits future multiple memberships.
 */
export function earliestActiveMembership(
  rows: readonly MembershipViewWithTime[],
): MembershipViewWithTime | null {
  const active = rows.filter((row) => row.state === "active");
  let earliest: MembershipViewWithTime | null = null;
  for (const row of active) {
    if (earliest === null || row.createdAtMs < earliest.createdAtMs) {
      earliest = row;
    }
  }
  return earliest;
}

/** Active administrators of one company, given its active memberships. */
export function activeAdministrators(
  rows: readonly MembershipView[],
): MembershipView[] {
  return rows.filter((row) => row.state === "active" && row.role === "admin");
}

/**
 * The last-admin invariant ("Administrator firmy", issue #22): removing
 * administration from `target` is allowed only when another CURRENT boss
 * already holds it. Blocking removal, self-revocation and demotion alike.
 */
export function decideLastAdminChange(
  target: MembershipView,
  companyActive: readonly MembershipView[],
): { readonly allowed: true } | { readonly allowed: false; readonly code: "last_administrator" } {
  if (target.state !== "active" || target.role !== "admin") {
    return { allowed: true };
  }
  const others = activeAdministrators(
    companyActive.filter((row) => row._id !== target._id),
  );
  return others.length > 0 ? { allowed: true } : { allowed: false, code: "last_administrator" };
}

/** What a role change does to one membership. */
export type RoleChangeKind = "unchanged" | "promote_to_admin" | "demote_to_member";

export function classifyRoleChange(current: MembershipRole, next: MembershipRole): RoleChangeKind {
  if (current === next) {
    return "unchanged";
  }
  return next === "admin" ? "promote_to_admin" : "demote_to_member";
}

/**
 * The administration-transfer decision: the acting admin transfers
 * administration to one CURRENT member of the SAME firm in one atomic
 * promote+demote step, so the company never dips below one administrator.
 */
export function decideAdministrationTransfer(args: {
  readonly actor: MembershipView;
  readonly target: MembershipView;
}): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  if (args.actor.state !== "active" || args.actor.role !== "admin") {
    return { ok: false, code: "requires_admin" };
  }
  if (args.target.state !== "active") {
    return { ok: false, code: "target_not_active" };
  }
  if (args.target.companyId !== args.actor.companyId) {
    // Cross-tenant target: not the actor's business (no leak).
    return { ok: false, code: "target_not_found" };
  }
  if (args.target.userId === args.actor.userId) {
    return { ok: false, code: "transfer_to_self" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Code and input helpers (pure halves of the issuance path).
// ---------------------------------------------------------------------------

/** Normalizes an acceptance code: trim only, no case games with digits. */
export function normalizeInvitationCode(input: string): string {
  return input.trim();
}

/**
 * Cryptographically secure invitation digits with rejection sampling
 * (identical shape to B1's OTP): bytes >= 250 are rejected so the modulo
 * mapping onto 0..9 stays uniform. Web Crypto only.
 */
export function generateInvitationCode(): string {
  const digits = "0123456789";
  const maxUsableByte = Math.floor(256 / digits.length) * digits.length; // 250
  let code = "";
  while (code.length < INVITATION_CODE_LENGTH) {
    const bytes = new Uint8Array(INVITATION_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= maxUsableByte) {
        continue; // rejected sample, not used
      }
      code += digits[byte % digits.length] ?? "0";
      if (code.length === INVITATION_CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

/** SHA-256 hex digest (the single code-hashing path for invitations). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A deeper validation outcome: a value or a sanitized machine code. */
export type Validated<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly code: string;
};

/** Company names carry words; whitespace-only is not a firm. */
export function validateCompanyName(name: string): Validated<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "company_name_empty" };
  }
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH) {
    return { ok: false, code: "company_name_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** The shared time context must be a real IANA zone ("Strefa czasu firmy"). */
export function validateTimezone(zone: string): Validated<string> {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    return { ok: false, code: "timezone_invalid" };
  }
  return { ok: true, value: zone };
}

/** Invitation target addresses: shape plus a hard length bound. */
export function validateInvitationEmail(email: string): Validated<string> {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_INVITATION_EMAIL_LENGTH ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)
  ) {
    return { ok: false, code: "invitation_email_invalid" };
  }
  return { ok: true, value: normalized };
}
