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

/** What the server returns for the current authenticated actor. */
export const AccessSnapshot = Schema.Struct({
  userId: tableIdSchema("users"),
  companyId: tableIdSchema("companies"),
  membershipRole: MembershipRole,
  isGm: Schema.Boolean,
  companyTimezone: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_]+\/[A-Za-z_]+$/))),
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
