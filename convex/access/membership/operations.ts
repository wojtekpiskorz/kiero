/**
 * Membership transactions (B3): the write halves of the cores, each inside
 * ONE Convex mutation.
 *
 * Entry ways, one core each (no drift by construction):
 *
 * - company-scoped operations (`createInvitation` delivers its email from
 *   the action wrapper, everything else straight through) run through the
 *   typed command dispatch (./dispatch.ts): envelope decode -> registry ->
 *   B1 identity resolution (provision-or-refresh + the canonical chain MY
 *   membership rows complete) -> the B3 policy -> contract input decode ->
 *   handler;
 * - admission operations (`createCompany`, `acceptInvitation`,
 *   `rejectInvitation`) serve a VERIFIED person who by definition has no
 *   active firm yet — the canonical chain resolves no company scope for
 *   them, so these run through the identity-layer entries (./functions.ts)
 *   that resolve the live session (B1's provision-or-refresh), decode the
 *   SAME contract entries and run the SAME cores with the SAME closed
 *   errors. This is exactly B1's own pattern for its membership-less
 *   surface (revokeSession): the runtime's dispatch requires a company
 *   scope, so the admission leg enters one seam earlier. Everything that
 *   CAN go through the company-scoped dispatch does.
 *
 * ATOMICITY: like D1, every step that can throw (registry lookups, schema
 * decodes, hashing) runs BEFORE the first insert/patch; between the first
 * write and the return only pre-validated writes and total decodes of
 * transaction-generated values remain. Revocation patches the membership,
 * publishes `access.membershipRevoked` and registers the durable
 * `access.cleanup_revocation` intent with ONE dedup identity — atomically.
 */

import { Schema } from "effect";
import {
  accessOperations,
  errorResult,
  events,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  unavailableError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { parseTableId } from "@kiero/contracts";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { normalizeEmail } from "../identity/userPolicy";
import {
  INVITATION_TTL_MS,
  admissionErrorKind,
  classifyRoleChange,
  decideAdministrationTransfer,
  decideInvitationAdmission,
  decideLastAdminChange,
  generateInvitationCode,
  normalizeInvitationCode,
  sha256Hex,
  validateCompanyName,
  validateInvitationEmail,
  validateTimezone,
  type MembershipViewWithTime,
} from "./cores";

// The contract entries these transactions implement (decode authority).
export const createCompanyEntry = accessOperations["access.createCompany"];
export const createInvitationEntry = accessOperations["access.createInvitation"];
export const rejectInvitationEntry = accessOperations["access.rejectInvitation"];
export const acceptInvitationEntry = accessOperations["access.acceptInvitation"];
export const revokeInvitationEntry = accessOperations["access.revokeInvitation"];
export const changeMembershipRoleEntry = accessOperations["access.changeMembershipRole"];
export const revokeMembershipEntry = accessOperations["access.revokeMembership"];
export const transferAdministrationEntry = accessOperations["access.transferAdministration"];

export type CreateCompanyInput = Schema.Schema.Type<typeof createCompanyEntry.input>;
export type CreateInvitationInput = Schema.Schema.Type<typeof createInvitationEntry.input>;
export type RejectInvitationInput = Schema.Schema.Type<typeof rejectInvitationEntry.input>;
export type AcceptInvitationInput = Schema.Schema.Type<typeof acceptInvitationEntry.input>;

/** Retry policy of the registered revocation cleanup (bounded, like A3/D1). */
export const CLEANUP_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** The verified-person half the admission transactions need. */
export interface AdmissionActor {
  readonly userId: Id<"users">;
}

/** parseTableId's non-null half over row ids (row ids are always well-formed). */
function bridgedId<T extends string>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`membership bridged id missing: ${what}`);
  }
  return value;
}

function membershipView(row: Doc<"memberships">): MembershipViewWithTime {
  // parseTableId is the proved id bridge (A3): row ids are Convex ids, the
  // cores speak the contracts' branded ids; both are the same string.
  return {
    _id: bridgedId(parseTableId("memberships", row._id), "memberships"),
    companyId: bridgedId(parseTableId("companies", row.companyId), "companies"),
    userId: bridgedId(parseTableId("users", row.userId), "users"),
    role: row.role,
    state: row.state,
    createdAtMs: row.createdAtMs,
  };
}

/**
 * The company scope every company-scoped transaction resolves first: the
 * Convex-normalized company and actor ids from the RESOLVED request
 * context (never client input). Unresolvable references fail closed with
 * the shared typed validation error before any read or write.
 */
function companyScopeOf(
  tx: MutationCtx,
  context: RequestContext,
): { readonly ok: true; readonly companyId: Id<"companies">; readonly actorUserId: Id<"users"> } | {
  readonly ok: false;
  readonly error: ResultEnvelope;
} {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const actorUserId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || actorUserId === null) {
    return { ok: false, error: errorResult(validationError("company_scope_unresolved")) };
  }
  return { ok: true, companyId, actorUserId };
}

/** All membership rows of one user (the multi-membership-capable read). */
export async function membershipsOfUser(
  tx: MutationCtx,
  userId: Id<"users">,
): Promise<MembershipViewWithTime[]> {
  const rows = await tx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.map(membershipView);
}

/** All membership rows of one company (role/last-admin decisions read this). */
export async function membershipsOfCompany(
  tx: MutationCtx,
  companyId: Id<"companies">,
): Promise<MembershipViewWithTime[]> {
  const rows = await tx.db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
    .collect();
  return rows.map(membershipView);
}

/**
 * Creates the firm and its FIRST administrator in one transaction
 * ("Firma" / "Administrator firmy", CONTEXT.md). Not public self-service
 * signup: a person with an active firm is refused — the v1
 * one-active-company rule — and the creator becomes the first and only
 * administrator until they invite or transfer.
 */
export async function performCreateCompany(
  tx: MutationCtx,
  actor: AdmissionActor,
  input: CreateCompanyInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const name = validateCompanyName(input.name);
  if (!name.ok) {
    return errorResult(validationError(name.code));
  }
  const timezone = validateTimezone(input.timezone);
  if (!timezone.ok) {
    return errorResult(validationError(timezone.code));
  }

  const user = await tx.db.get(actor.userId);
  if (user === null) {
    return errorResult(notFoundError("users", "actor_user_not_found"));
  }
  const existing = await membershipsOfUser(tx, actor.userId);
  if (existing.some((row) => row.state === "active")) {
    return errorResult(conflictError("one_active_company_rule"));
  }

  const companyId = await tx.db.insert("companies", {
    name: name.value,
    timezone: timezone.value,
    defaultCurrency: input.defaultCurrency,
    createdAtMs: nowMs,
  });
  const membershipId = await tx.db.insert("memberships", {
    companyId,
    userId: actor.userId,
    role: "admin",
    state: "active",
    createdAtMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(createCompanyEntry.result)({ companyId, membershipId }),
  );
}

/**
 * The invitation issuance transaction: validation, duplicate check and the
 * invitation row ONLY. Email delivery happens in the action wrapper
 * (mutations cannot fetch); the single-use code crosses the internal
 * boundary once and never appears in any client-visible result.
 */
export async function performCreateInvitation(
  tx: MutationCtx,
  context: RequestContext,
  input: CreateInvitationInput,
): Promise<
  | { readonly ok: true; readonly invitationId: Id<"invitations">; readonly expiresAtMs: number; readonly email: string; readonly companyName: string; readonly code: string }
  | { readonly ok: false; readonly result: ResultEnvelope }
> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return { ok: false, result: scope.error };
  }
  const { companyId, actorUserId } = scope;
  if (context.actor.membershipRole !== "admin") {
    // The policy already denies non-administer intents; this is the
    // handler-level recheck that never trusts a stale role.
    return { ok: false, result: errorResult(forbiddenError("requires_admin", "company")) };
  }
  const company = await tx.db.get(companyId);
  if (company === null) {
    return { ok: false, result: errorResult(notFoundError("companies")) };
  }
  const email = validateInvitationEmail(input.email);
  if (!email.ok) {
    return { ok: false, result: errorResult(validationError(email.code)) };
  }
  const existing = await tx.db
    .query("invitations")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId).eq("state", "pending"))
    .collect();
  const sameEmail = existing.filter((row) => row.email === email.value);
  if (sameEmail.some((row) => row.expiresAtMs > nowMs)) {
    // One live invitation per target address: duplicates would race and
    // confuse the single-use rule.
    return { ok: false, result: errorResult(conflictError("invitation_already_pending")) };
  }
  for (const row of sameEmail) {
    // Stale pending rows past their expiry: close them honestly, then issue.
    await tx.db.patch(row._id, { state: "expired" });
  }

  // Everything below can no longer throw on input grounds: the code and
  // hash are generated locally, the insert is pre-validated.
  const code = generateInvitationCode();
  const codeHash = await sha256Hex(code);
  const expiresAtMs = nowMs + INVITATION_TTL_MS;
  const invitationId = await tx.db.insert("invitations", {
    companyId,
    email: email.value,
    role: input.role,
    state: "pending",
    codeHash,
    expiresAtMs,
    createdAtMs: nowMs,
    issuedByUserId: actorUserId,
  });
  return { ok: true, invitationId, expiresAtMs, email: email.value, companyName: company.name, code };
}

/** Administrator revocation of a pending invitation (idempotent). */
export async function performRevokeInvitation(
  tx: MutationCtx,
  context: RequestContext,
  invitationId: Id<"invitations">,
): Promise<ResultEnvelope> {
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const invitation = await tx.db.get(invitationId);
  if (invitation === null || invitation.companyId !== companyId) {
    // Cross-tenant ids are indistinguishable from missing ones.
    return errorResult(notFoundError("invitations"));
  }
  if (invitation.state === "revoked") {
    return okResult(Schema.decodeUnknownSync(revokeInvitationEntry.result)({ revoked: "revoked" }));
  }
  if (invitation.state !== "pending") {
    return errorResult(conflictError("invitation_not_pending"));
  }
  await tx.db.patch(invitationId, { state: "revoked", revokedAtMs: Date.now() });
  return okResult(Schema.decodeUnknownSync(revokeInvitationEntry.result)({ revoked: "revoked" }));
}

/**
 * The admission transaction (issue #22): acceptance atomically validates
 * the target address, expiry, revocation, use count and the
 * one-active-company rule, then inserts the membership, marks the
 * invitation used and publishes `access.membershipAccepted` — in ONE
 * transaction. The invitation-row patch is also the serialization point:
 * a racing second acceptance or revocation conflicts through OCC and
 * re-reads a non-pending row.
 */
export async function performAcceptInvitation(
  tx: MutationCtx,
  actor: AdmissionActor,
  invitationId: Schema.Schema.Type<typeof acceptInvitationEntry.input>["invitationId"],
  verificationCode: string,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const invitationRowId = tx.db.normalizeId("invitations", invitationId);
  if (invitationRowId === null) {
    return errorResult(notFoundError("invitations"));
  }
  const user = await tx.db.get(actor.userId);
  if (user === null) {
    return errorResult(notFoundError("users", "actor_user_not_found"));
  }
  const invitation = await tx.db.get(invitationRowId);
  if (invitation === null) {
    return errorResult(notFoundError("invitations"));
  }
  const codeHash = await sha256Hex(normalizeInvitationCode(verificationCode));
  const memberships = await membershipsOfUser(tx, actor.userId);
  const decision = decideInvitationAdmission(
    {
      state: invitation.state,
      email: invitation.email,
      role: invitation.role,
      companyId: bridgedId(parseTableId("companies", invitation.companyId), "companies"),
      codeHash: invitation.codeHash,
      expiresAtMs: invitation.expiresAtMs,
    },
    {
      email: normalizeEmail(user.email),
      hasGoogleSubject: user.googleSubject !== undefined,
      emailVerifiedMs: user.emailVerificationTime ?? null,
      activeMembership: (() => {
        const active = memberships.filter((row) => row.state === "active");
        return active.length > 0 ? { companyId: active[0]!.companyId } : null;
      })(),
    },
    codeHash,
    nowMs,
  );
  if (!decision.ok) {
    const kind = admissionErrorKind(decision.code);
    if (kind === "not_found") {
      return errorResult(notFoundError("invitations", decision.code));
    }
    if (kind === "validation") {
      return errorResult(validationError(decision.code));
    }
    return errorResult(conflictError(decision.code));
  }

  // --- the atomic commit: membership + used invitation + canonical event --
  const grantCompanyId = tx.db.normalizeId("companies", decision.grant.companyId);
  if (grantCompanyId === null) {
    return errorResult(validationError("invitation_company_unresolvable"));
  }
  const membershipId = await tx.db.insert("memberships", {
    companyId: grantCompanyId,
    userId: actor.userId,
    role: decision.grant.role,
    state: "active",
    createdAtMs: nowMs,
  });
  await tx.db.patch(invitationRowId, {
    state: "accepted",
    acceptedMembershipId: membershipId,
  });
  const dedupKey = `access.membershipAccepted:${membershipId}`;
  const eventEntry = events["access.membershipAccepted"];
  if (eventEntry === undefined) {
    return errorResult(unavailableError(true, "membership_accepted_event_missing"));
  }
  Schema.decodeUnknownSync(eventEntry.payload)({ membershipId, userId: actor.userId });
  await publishEvent(tx, {
    companyId: decision.grant.companyId,
    eventName: "access.membershipAccepted",
    payload: { membershipId, userId: actor.userId },
    dedupKey,
  });
  return okResult(
    Schema.decodeUnknownSync(acceptInvitationEntry.result)({ membershipId }),
  );
}

/** The invitee declines: only the targeted person, only while pending. */
export async function performRejectInvitation(
  tx: MutationCtx,
  actor: AdmissionActor,
  invitationId: Schema.Schema.Type<typeof rejectInvitationEntry.input>["invitationId"],
): Promise<ResultEnvelope> {
  const invitationRowId = tx.db.normalizeId("invitations", invitationId);
  if (invitationRowId === null) {
    return errorResult(notFoundError("invitations"));
  }
  const user = await tx.db.get(actor.userId);
  if (user === null) {
    return errorResult(notFoundError("users", "actor_user_not_found"));
  }
  const invitation = await tx.db.get(invitationRowId);
  if (invitation === null || invitation.email !== normalizeEmail(user.email)) {
    return errorResult(notFoundError("invitations"));
  }
  if (invitation.state !== "pending") {
    return errorResult(conflictError("invitation_not_pending"));
  }
  await tx.db.patch(invitationRowId, { state: "rejected", rejectedAtMs: Date.now() });
  return okResult(Schema.decodeUnknownSync(rejectInvitationEntry.result)({ state: "rejected" }));
}

/** Administrator (or self) role change with the last-admin guard. */
export async function performChangeMembershipRole(
  tx: MutationCtx,
  context: RequestContext,
  membershipId: Id<"memberships">,
  role: "admin" | "member",
): Promise<ResultEnvelope> {
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const membership = await tx.db.get(membershipId);
  if (membership === null || membership.companyId !== companyId) {
    return errorResult(notFoundError("memberships"));
  }
  if (membership.state !== "active") {
    return errorResult(conflictError("membership_not_active"));
  }
  const kind = classifyRoleChange(membership.role, role);
  if (kind === "unchanged") {
    return okResult(
      Schema.decodeUnknownSync(changeMembershipRoleEntry.result)({ membershipId }),
    );
  }
  if (kind === "demote_to_member") {
    const companyActive = await membershipsOfCompany(tx, companyId);
    const guard = decideLastAdminChange(membershipView(membership), companyActive);
    if (!guard.allowed) {
      return errorResult(forbiddenError(guard.code, "memberships"));
    }
  }
  await tx.db.patch(membershipId, { role });
  return okResult(
    Schema.decodeUnknownSync(changeMembershipRoleEntry.result)({ membershipId }),
  );
}

/**
 * Membership revocation / leaving (issue #22): administrators revoke any
 * member, a plain member revokes only their own row; the final
 * administrator can neither leave nor be revoked. The row survives with
 * state `revoked` (authorship and audit history preserved), current access
 * ends structurally — the canonical resolution finds no active membership —
 * and the canonical `access.membershipRevoked` event plus the durable
 * `access.cleanup_revocation` intent publish atomically with the patch,
 * under ONE dedup identity.
 */
export async function performRevokeMembership(
  tx: MutationCtx,
  context: RequestContext,
  membershipId: Id<"memberships">,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId, actorUserId } = scope;
  const membership = await tx.db.get(membershipId);
  if (membership === null || membership.companyId !== companyId) {
    return errorResult(notFoundError("memberships"));
  }
  if (membership.state !== "active") {
    return errorResult(conflictError("membership_not_active"));
  }
  const isAdmin = context.actor.membershipRole === "admin";
  if (!isAdmin && membership.userId !== actorUserId) {
    // A plain boss may only leave ("Członkostwo w firmie" is personal).
    return errorResult(forbiddenError("not_own_membership", "memberships"));
  }
  const companyActive = await membershipsOfCompany(tx, companyId);
  const guard = decideLastAdminChange(membershipView(membership), companyActive);
  if (!guard.allowed) {
    return errorResult(forbiddenError(guard.code, "memberships"));
  }

  // Successor policy for the typed event: another current boss already
  // holds administration (the guard proved it), so revocation unassigns
  // nothing — successorUserId is null. The field carries the policy slot
  // for future transfer-before-revoke compositions.
  const successorUserId = null;
  await tx.db.patch(membershipId, { state: "revoked", revokedAtMs: nowMs });
  const dedupKey = `access.membershipRevoked:${membershipId}:${nowMs}`;
  const eventEntry = events["access.membershipRevoked"];
  if (eventEntry === undefined) {
    return errorResult(unavailableError(true, "membership_revoked_event_missing"));
  }
  Schema.decodeUnknownSync(eventEntry.payload)({
    membershipId,
    userId: membership.userId,
    revokedAtMs: nowMs,
    successorUserId,
  });
  await publishEvent(tx, {
    companyId,
    eventName: "access.membershipRevoked",
    payload: { membershipId, userId: membership.userId, revokedAtMs: nowMs, successorUserId },
    dedupKey,
  });
  await registerDurableJob(tx, {
    kind: "access.cleanup_revocation",
    input: { kind: "membership", membershipId, sessionId: null, revokedAtMs: nowMs },
    companyId,
    policy: CLEANUP_RETRY_POLICY,
    dedupKey,
  });
  return okResult(
    Schema.decodeUnknownSync(revokeMembershipEntry.result)({ revokedAtMs: nowMs }),
  );
}

/**
 * The atomic administration transfer (issue #22): promote the target member
 * and demote the acting administrator in ONE transaction. Because both
 * patches commit together, the company can never dip below one
 * administrator between two separate role changes, and two racing
 * transfers serialize on the shared membership rows through OCC — the
 * loser re-reads a non-admin actor and refuses honestly.
 */
export async function performTransferAdministration(
  tx: MutationCtx,
  context: RequestContext,
  toUserId: Id<"users">,
): Promise<ResultEnvelope> {
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId, actorUserId } = scope;
  const rows = await tx.db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
    .collect();
  const actorRow = rows.find(
    (row) => row.userId === actorUserId && row.state === "active",
  );
  const targetRow = rows.find((row) => row.userId === toUserId && row.state === "active");
  if (actorRow === undefined) {
    return errorResult(notFoundError("memberships", "actor_membership_not_found"));
  }
  if (targetRow === undefined) {
    return errorResult(notFoundError("memberships", "target_membership_not_found"));
  }
  const decision = decideAdministrationTransfer({
    actor: membershipView(actorRow),
    target: membershipView(targetRow),
  });
  if (!decision.ok) {
    if (decision.code === "requires_admin") {
      return errorResult(forbiddenError(decision.code, "company"));
    }
    if (decision.code === "target_not_found" || decision.code === "target_not_active") {
      return errorResult(notFoundError("memberships", "target_membership_not_found"));
    }
    return errorResult(validationError(decision.code));
  }
  await tx.db.patch(targetRow._id, { role: "admin" });
  await tx.db.patch(actorRow._id, { role: "member" });
  return okResult(
    Schema.decodeUnknownSync(transferAdministrationEntry.result)({
      adminMembershipId: targetRow._id,
      demotedMembershipId: actorRow._id,
    }),
  );
}

