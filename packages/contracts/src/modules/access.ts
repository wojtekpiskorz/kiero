/**
 * Access module surface (architecture "Deep modules": Access).
 *
 * Identity/membership separation, one active firm in v1, explicit linking,
 * last-admin constraints, device/session revocation, background and media
 * checks; all owned inside the implementing lane (B1–B4). This file only
 * names the checked operations and events; until those lanes land, dispatch
 * fails closed with `unsupported`.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { MembershipRole } from "../actor";
import { operationEntry, eventEntry } from "./registration";

/**
 * What the server returns for the current authenticated actor.
 *
 * `companyTimezone` is a plain string on purpose: real IANA zone names
 * ("America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC") defeat any short
 * regex, and the SINGLE validation authority is the creating transaction's
 * IANA check (convex/access/membership/cores.ts `validateTimezone`); the
 * snapshot mirrors what that authority already accepted.
 */
export const AccessSnapshot = Schema.Struct({
  userId: tableIdSchema("users"),
  companyId: tableIdSchema("companies"),
  membershipRole: MembershipRole,
  isGm: Schema.Boolean,
  companyTimezone: Schema.String,
  defaultCurrency: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/))),
});
export type AccessSnapshot = Schema.Schema.Type<typeof AccessSnapshot>;

export const accessOperations = {
  "access.resolveCurrentAccess": operationEntry({
    kind: "operation",
    name: "access.resolveCurrentAccess",
    input: Schema.Struct({ sessionId: tableIdSchema("sessions") }),
    result: Schema.NullOr(AccessSnapshot),
    errorKinds: ["unauthenticated"],
  }),
  // B3 amendment (coordinated addition, named in issue #22): the company
  // bootstrap and invitation-admission seams the bounded solution requires.
  // `access.createCompany` is NOT public self-service signup: a caller with
  // an active firm is refused (one-active-company), and the creator becomes
  // the first administrator ("Administrator firmy", CONTEXT.md).
  "access.createCompany": operationEntry({
    kind: "operation",
    name: "access.createCompany",
    input: Schema.Struct({
      name: Schema.NonEmptyString,
      // Plain string by design: real IANA zone names ("Etc/GMT+5",
      // "America/Argentina/Buenos_Aires", "UTC") defeat any short regex.
      // The SINGLE validation authority is the transaction's IANA check
      // (convex/access/membership/cores.ts `validateTimezone`), which runs
      // before any write; the schema only carries the value.
      timezone: Schema.String,
      defaultCurrency: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/))),
    }),
    result: Schema.Struct({
      companyId: tableIdSchema("companies"),
      membershipId: tableIdSchema("memberships"),
    }),
    errorKinds: ["validation", "conflict"],
  }),
  "access.createInvitation": operationEntry({
    kind: "operation",
    name: "access.createInvitation",
    input: Schema.Struct({
      email: Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/))),
      role: MembershipRole,
    }),
    result: Schema.Struct({
      invitationId: tableIdSchema("invitations"),
      expiresAtMs: Schema.Number,
      /** Honest email delivery state; the code never crosses this result. */
      delivery: Schema.Literals(["sent", "delivery_failed"]),
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "access.rejectInvitation": operationEntry({
    kind: "operation",
    name: "access.rejectInvitation",
    input: Schema.Struct({ invitationId: tableIdSchema("invitations") }),
    result: Schema.Struct({ state: Schema.Literal("rejected") }),
    errorKinds: ["not_found", "conflict"],
  }),
  "access.acceptInvitation": operationEntry({
    kind: "operation",
    name: "access.acceptInvitation",
    input: Schema.Struct({
      invitationId: tableIdSchema("invitations"),
      verificationCode: Schema.String,
    }),
    result: Schema.Struct({ membershipId: tableIdSchema("memberships") }),
    errorKinds: ["validation", "not_found", "conflict"],
  }),
  "access.revokeInvitation": operationEntry({
    kind: "operation",
    name: "access.revokeInvitation",
    input: Schema.Struct({ invitationId: tableIdSchema("invitations") }),
    result: Schema.Struct({ revoked: Schema.Literal("revoked") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "access.changeMembershipRole": operationEntry({
    kind: "operation",
    name: "access.changeMembershipRole",
    input: Schema.Struct({
      membershipId: tableIdSchema("memberships"),
      role: MembershipRole,
    }),
    result: Schema.Struct({ membershipId: tableIdSchema("memberships") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "access.revokeMembership": operationEntry({
    kind: "operation",
    name: "access.revokeMembership",
    input: Schema.Struct({ membershipId: tableIdSchema("memberships") }),
    result: Schema.Struct({ revokedAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  // B3 amendment: the atomic administrator transfer ("transfer
  // administration"). One transaction promotes the target member to admin
  // and demotes the actor to member, so the last-admin invariant cannot dip
  // between two separate role changes.
  "access.transferAdministration": operationEntry({
    kind: "operation",
    name: "access.transferAdministration",
    input: Schema.Struct({ toUserId: tableIdSchema("users") }),
    result: Schema.Struct({
      adminMembershipId: tableIdSchema("memberships"),
      demotedMembershipId: tableIdSchema("memberships"),
    }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
  "access.linkVerifiedMethod": operationEntry({
    kind: "operation",
    name: "access.linkVerifiedMethod",
    input: Schema.Struct({
      userId: tableIdSchema("users"),
      method: Schema.Literals(["google", "email_code"]),
      verifiedIdentity: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ linked: Schema.Literal("linked") }),
    errorKinds: ["forbidden", "conflict", "validation"],
  }),
  "access.revokeSession": operationEntry({
    kind: "operation",
    name: "access.revokeSession",
    input: Schema.Struct({ sessionId: tableIdSchema("sessions") }),
    result: Schema.Struct({ revokedAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found"],
  }),
  "access.enterGmMode": operationEntry({
    kind: "operation",
    name: "access.enterGmMode",
    input: Schema.Struct({ reason: Schema.NonEmptyString }),
    result: Schema.Struct({ grantId: tableIdSchema("gmAccessGrants") }),
    errorKinds: ["forbidden"],
  }),
  "access.exitGmMode": operationEntry({
    kind: "operation",
    name: "access.exitGmMode",
    input: Schema.Struct({ grantId: tableIdSchema("gmAccessGrants") }),
    result: Schema.Struct({ closedAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found"],
  }),
} as const;

export const accessEvents = {
  "access.membershipAccepted": eventEntry({
    kind: "event",
    name: "access.membershipAccepted",
    payload: Schema.Struct({
      membershipId: tableIdSchema("memberships"),
      userId: tableIdSchema("users"),
    }),
  }),
  "access.membershipRevoked": eventEntry({
    kind: "event",
    name: "access.membershipRevoked",
    payload: Schema.Struct({
      membershipId: tableIdSchema("memberships"),
      userId: tableIdSchema("users"),
      // B3 amendment (issue #22 revocation transaction contract): the event
      // carries the revocation instant and the chosen successor
      // administration policy — the membership that received administration
      // when the revoked boss was the last admin (transfer-before-revoke),
      // or null when another admin already remained (unassignment).
      revokedAtMs: Schema.Number,
      successorUserId: Schema.NullOr(tableIdSchema("users")),
    }),
  }),
  "access.sessionRevoked": eventEntry({
    kind: "event",
    name: "access.sessionRevoked",
    payload: Schema.Struct({ sessionId: tableIdSchema("sessions") }),
  }),
  "access.gmModeEntered": eventEntry({
    kind: "event",
    name: "access.gmModeEntered",
    payload: Schema.Struct({
      grantId: tableIdSchema("gmAccessGrants"),
      userId: tableIdSchema("users"),
    }),
  }),
  "access.gmModeExited": eventEntry({
    kind: "event",
    name: "access.gmModeExited",
    payload: Schema.Struct({ grantId: tableIdSchema("gmAccessGrants") }),
  }),
} as const;
