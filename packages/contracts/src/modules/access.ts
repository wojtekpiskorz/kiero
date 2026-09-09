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
    // B4 amendment (issue #23): entering twice in one session is an honest
    // conflict, not a silent grant swap.
    errorKinds: ["forbidden", "conflict"],
  }),
  "access.exitGmMode": operationEntry({
    kind: "operation",
    name: "access.exitGmMode",
    input: Schema.Struct({ grantId: tableIdSchema("gmAccessGrants") }),
    result: Schema.Struct({ closedAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found"],
  }),
  // B4 amendment (coordinated addition, named in issue #23): the audited GM
  // operations. Every input that targets company data states the target
  // company; every human-triggered action states its basis ("podstawa").
  // GM authority is resolved from an OPEN `gmAccessGrants` row inside the
  // same transaction (never from membership: a member without a GM grant
  // gains nothing, and a GM without membership acts through the grant).
  //
  // The staged B2 manual-recovery command (issue #21 named prerequisite):
  // the GM states the verification basis; the B2 core clears sessions,
  // provider accounts and the Google subject while the users row, membership
  // and authorship survive untouched.
  "access.recoverAccount": operationEntry({
    kind: "operation",
    name: "access.recoverAccount",
    input: Schema.Struct({
      userId: tableIdSchema("users"),
      verificationBasis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      recoveredAtMs: Schema.Number,
      revokedSessions: Schema.Number,
      clearedAccounts: Schema.Number,
      clearedGoogleSubject: Schema.Boolean,
    }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation"],
  }),
  // The audited GM inspection read (read-side surface over processingRuns /
  // durableJobs; the retry/reanalysis ACTIONS are H4's). A read is still a
  // GM request: it states the target company and basis, and its audit row
  // lands in the same transaction.
  "access.gmInspectCompany": operationEntry({
    kind: "operation",
    name: "access.gmInspectCompany",
    input: Schema.Struct({
      companyId: tableIdSchema("companies"),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      company: Schema.Struct({
        companyId: tableIdSchema("companies"),
        name: Schema.String,
        timezone: Schema.String,
        defaultCurrency: Schema.String,
      }),
      alpha: Schema.Struct({
        activationId: tableIdSchema("gmCompanyActivations"),
        activatedAtMs: Schema.Number,
      }),
      activeAdminCount: Schema.Number,
      processingRuns: Schema.Array(
        Schema.Struct({
          runId: tableIdSchema("processingRuns"),
          kind: Schema.Literals(["initial_analysis", "reanalysis"]),
          state: Schema.Literals(["running", "succeeded", "failed", "superseded"]),
          startedAtMs: Schema.Number,
          finishedAtMs: Schema.NullOr(Schema.Number),
        }),
      ),
      durableJobs: Schema.Array(
        Schema.Struct({
          jobId: tableIdSchema("durableJobs"),
          kind: Schema.String,
          state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
          attempts: Schema.Number,
          maxAttempts: Schema.Number,
          lastErrorKind: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
  // GM company onboarding: creates the firm UNDER GM AUTHORITY (no GM
  // membership is ever created), opens its alpha activation and issues the
  // first-administrator invitation — the operator control path that replaces
  // direct database edits (issue #23 acceptance criteria).
  "access.gmOnboardCompany": operationEntry({
    kind: "operation",
    name: "access.gmOnboardCompany",
    input: Schema.Struct({
      name: Schema.NonEmptyString,
      // Plain string by design (same ruling as access.createCompany): the
      // SINGLE validation authority is the transaction's IANA check
      // (convex/access/membership/cores.ts `validateTimezone`).
      timezone: Schema.String,
      defaultCurrency: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/))),
      adminEmail: Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/))),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      companyId: tableIdSchema("companies"),
      activationId: tableIdSchema("gmCompanyActivations"),
      invitationId: tableIdSchema("invitations"),
      expiresAtMs: Schema.Number,
      /** Honest email delivery state; the code never crosses this result. */
      delivery: Schema.Literals(["sent", "delivery_failed"]),
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  // Brings an existing firm under GM alpha authority (an open activation
  // row). Without it the firm is invisible to every GM surface.
  "access.gmActivateCompany": operationEntry({
    kind: "operation",
    name: "access.gmActivateCompany",
    input: Schema.Struct({
      companyId: tableIdSchema("companies"),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ activationId: tableIdSchema("gmCompanyActivations") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  // Administrator restoration: promotes one ACTIVE member of the target
  // firm to administrator under GM authority (audited), when the firm lost
  // usable administration. Not a membership power: the GM never gains a
  // membership, and members never gain this operation.
  "access.gmRestoreAdministrator": operationEntry({
    kind: "operation",
    name: "access.gmRestoreAdministrator",
    input: Schema.Struct({
      companyId: tableIdSchema("companies"),
      userId: tableIdSchema("users"),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ membershipId: tableIdSchema("memberships") }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
  // Ending company alpha participation: closes the activation row. Every
  // grant-derived GM path over that firm denies immediately afterwards
  // (each GM operation re-checks the open activation at commit); time
  // elapsed alone never ends participation.
  "access.gmEndCompanyAlpha": operationEntry({
    kind: "operation",
    name: "access.gmEndCompanyAlpha",
    input: Schema.Struct({
      companyId: tableIdSchema("companies"),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ endedAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found", "conflict"],
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
