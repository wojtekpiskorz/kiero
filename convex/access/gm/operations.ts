/**
 * GM transactions (B4): the write halves of the cores, each inside ONE
 * Convex mutation — and each writing its protected audit row in the SAME
 * transaction as its effect (the issue's "every GM read and command
 * produces a protected audit record with GM actor, target company,
 * operation, reason and outcome").
 *
 * ATOMICITY: like B3, every step that can throw (lookups, schema decodes,
 * hashing) runs BEFORE the first insert/patch; between the first write and
 * the return only pre-validated writes and total decodes of
 * transaction-generated values remain. DENIED attempts under a VALID
 * authority still audit (outcome = the closed error code) so the protected
 * trail records refusals; attempts without any open grant have no grant to
 * attribute and simply fail closed (nothing GM-attributable happened).
 *
 * The recovery transaction composes B2's checked command
 * (recoverAccountCommand) with the RESOLVED GM actor — the named
 * prerequisite B2 staged — so the accountRecoveries ledger records the real
 * operator while the same transaction writes the GM audit row.
 */

import { Schema } from "effect";
import {
  accessOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
} from "@kiero/runtime";
import {
  INVITATION_TTL_MS,
  generateInvitationCode,
  sha256Hex,
  validateCompanyName,
  validateInvitationEmail,
  validateTimezone,
} from "../membership/cores";
import {
  COMPANY_NOT_FOUND,
  GM_MODE_NOT_ACTIVE,
  decideGmCompanyAccess,
  decideGmEntry,
  decideGmExit,
  gmGrantOpen,
  normalizeGmStatement,
  type GmCompanyAccessDenial,
  type GmGrantView,
} from "./cores";
import type { GmCompanyView, GmTx } from "./store";

// The contract entries these transactions implement (decode authority).
export const enterGmModeEntry = accessOperations["access.enterGmMode"];
export const exitGmModeEntry = accessOperations["access.exitGmMode"];
export const recoverAccountEntry = accessOperations["access.recoverAccount"];
export const gmInspectCompanyEntry = accessOperations["access.gmInspectCompany"];
export const gmOnboardCompanyEntry = accessOperations["access.gmOnboardCompany"];
export const gmActivateCompanyEntry = accessOperations["access.gmActivateCompany"];
export const gmRestoreAdministratorEntry = accessOperations["access.gmRestoreAdministrator"];
export const gmEndCompanyAlphaEntry = accessOperations["access.gmEndCompanyAlpha"];

/** The resolved GM authority every GM operation re-derives in-transaction. */
export interface GmAuthority {
  readonly userId: string;
  /** The open grant the authority was resolved from (current authority). */
  readonly grantId: string;
}

/** How many inspection rows each bounded projection returns. */
export const MAX_INSPECT_RUN_ROWS = 20;
export const MAX_INSPECT_JOB_ROWS = 20;

/** Writes one protected audit row into the caller's transaction. */
async function audit(
  tx: GmTx,
  args: {
    readonly authority: GmAuthority;
    readonly companyId: string | null;
    readonly operationName: string;
    readonly basis: string;
    readonly outcome: string;
    readonly atMs: number;
  },
): Promise<void> {
  await tx.insertAudit({
    actorUserId: args.authority.userId,
    gmGrantId: args.authority.grantId,
    companyId: args.companyId,
    operationName: args.operationName,
    gmBasis: args.basis,
    outcome: args.outcome,
    atMs: args.atMs,
  });
}

/**
 * Reads the acting grant in-transaction — the authority every GM operation
 * re-derives at commit: the authority's own row by id, current authority
 * only while it is still OPEN. A closed, foreign or missing grant is no
 * authority at all (OCC serializes the read, so a racing exit denies here).
 */
async function actingGrant(tx: GmTx, authority: GmAuthority): Promise<GmGrantView | null> {
  const grant = await tx.grantById(authority.grantId);
  if (grant === null || grant.userId !== authority.userId || !gmGrantOpen(grant)) {
    return null;
  }
  return grant;
}

/**
 * The audited refusal every denied GM operation returns: the trail records
 * the attempt under the acting grant with the closed outcome code (denials
 * under a VALID authority still audit), and the envelope maps the denial
 * without leaking target data — the company id rides the trail only when
 * the company was actually found.
 */
async function refuseGmAccess(
  tx: GmTx,
  authority: GmAuthority,
  operationName: string,
  basis: string,
  company: GmCompanyView | null,
  denial: GmCompanyAccessDenial,
): Promise<ResultEnvelope> {
  await audit(tx, {
    authority,
    companyId: company === null ? null : company.id,
    operationName,
    basis,
    outcome: denial.code,
    atMs: Date.now(),
  });
  if (denial.kind === "not_found") {
    return errorResult(notFoundError("companies", denial.code));
  }
  return errorResult(
    forbiddenError(denial.code, denial.code === "gm_mode_not_active" ? "gm" : "company"),
  );
}

/**
 * Opens GM mode: one audited grant interval. The eligibility decision
 * (deployment allow-list) happened at the ACTION boundary; this transaction
 * re-verifies everything it can see — the actor exists and has no open
 * grant — and records the interval with its stated reason.
 */
export async function performEnterGmMode(
  tx: GmTx,
  args: { readonly userId: string; readonly reason: string },
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const reason = normalizeGmStatement(args.reason);
  if (!reason.ok) {
    return errorResult(validationError("gm_reason_invalid"));
  }
  const user = await tx.userById(args.userId);
  if (user === null) {
    return errorResult(notFoundError("users", "actor_user_not_found"));
  }
  const grants = await tx.grantsOfUser(args.userId);
  const decision = decideGmEntry(grants);
  if (!decision.ok) {
    return errorResult(conflictError(decision.code));
  }

  const grantId = await tx.insertGrant({
    userId: args.userId,
    reason: reason.value,
    enteredAtMs: nowMs,
  });
  await audit(tx, {
    authority: { userId: args.userId, grantId },
    companyId: null,
    operationName: "access.enterGmMode",
    basis: reason.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(enterGmModeEntry.result)({ grantId }),
  );
}

/** Closes GM mode: only the grant's own actor, only an open grant. */
export async function performExitGmMode(
  tx: GmTx,
  args: { readonly userId: string; readonly grantId: string },
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const grant = await tx.grantById(args.grantId);
  const decision = decideGmExit(grant, args.userId);
  if (!decision.ok) {
    if (decision.code === "gm_not_own_grant") {
      return errorResult(forbiddenError(decision.code, "gmAccessGrants"));
    }
    return errorResult(notFoundError("gmAccessGrants", decision.code));
  }
  await tx.closeGrant(args.grantId, nowMs);
  await audit(tx, {
    authority: { userId: args.userId, grantId: args.grantId },
    companyId: null,
    operationName: "access.exitGmMode",
    basis: grant!.reason,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(Schema.decodeUnknownSync(exitGmModeEntry.result)({ closedAtMs: nowMs }));
}

/**
 * The audited GM inspection read over one target company: the read-side
 * surface over processingRuns / durableJobs (A3/I2 state). The retry and
 * reanalysis ACTIONS are H4's; this is the authority + audit spine they
 * build on. Company internals leave the database ONLY through this audited
 * command.
 */
export async function performGmInspectCompany(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof gmInspectCompanyEntry.input>,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const grant = await actingGrant(tx, authority);
  const company = await tx.companyById(input.companyId);
  const activation = await tx.openActivationOf(input.companyId);
  const access = decideGmCompanyAccess({
    grantOpen: grant !== null,
    companyExists: company !== null,
    activation,
  });
  if (!access.ok) {
    // Audited refusal: the trail records the denied attempt under the
    // acting grant with the closed outcome code.
    return await refuseGmAccess(tx, authority, "access.gmInspectCompany", basis.value, company, access);
  }

  const memberships = await tx.membershipsOfCompany(input.companyId);
  const runs = await tx.recentRunsOfCompany(input.companyId, MAX_INSPECT_RUN_ROWS);
  const jobs = await tx.recentJobsOfCompany(input.companyId, MAX_INSPECT_JOB_ROWS);
  await audit(tx, {
    authority,
    companyId: input.companyId,
    operationName: "access.gmInspectCompany",
    basis: basis.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(gmInspectCompanyEntry.result)({
      company: {
        companyId: company!.id,
        name: company!.name,
        timezone: company!.timezone,
        defaultCurrency: company!.defaultCurrency,
      },
      alpha: {
        activationId: activation!.id,
        activatedAtMs: activation!.activatedAtMs,
      },
      activeAdminCount: memberships.filter((row) => row.state === "active" && row.role === "admin")
        .length,
      processingRuns: runs,
      durableJobs: jobs,
    }),
  );
}

/**
 * The onboarding transaction: firm + alpha activation + first-administrator
 * invitation, under GM authority and in ONE transaction. The GM never gains
 * a membership; the first administrator enters through B3's ordinary
 * admission path when they accept the invitation. The single-use code
 * crosses to the ACTION wrapper exactly once (email delivery) and never
 * appears in any client-visible result.
 */
export async function performGmOnboardCompany(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof gmOnboardCompanyEntry.input>,
): Promise<
  | {
      readonly ok: true;
      readonly companyId: string;
      readonly activationId: string;
      readonly invitationId: string;
      readonly expiresAtMs: number;
      readonly email: string;
      readonly companyName: string;
      readonly code: string;
    }
  | { readonly ok: false; readonly result: ResultEnvelope }
> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return { ok: false, result: errorResult(validationError("gm_basis_invalid")) };
  }
  if ((await actingGrant(tx, authority)) === null) {
    return {
      ok: false,
      result: await refuseGmAccess(tx, authority, "access.gmOnboardCompany", basis.value, null, GM_MODE_NOT_ACTIVE),
    };
  }
  const name = validateCompanyName(input.name);
  if (!name.ok) {
    return { ok: false, result: errorResult(validationError(name.code)) };
  }
  const timezone = validateTimezone(input.timezone);
  if (!timezone.ok) {
    return { ok: false, result: errorResult(validationError(timezone.code)) };
  }
  const email = validateInvitationEmail(input.adminEmail);
  if (!email.ok) {
    return { ok: false, result: errorResult(validationError(email.code)) };
  }

  const companyId = await tx.insertCompany({
    name: name.value,
    timezone: timezone.value,
    defaultCurrency: input.defaultCurrency,
    createdAtMs: nowMs,
  });
  const activationId = await tx.insertActivation({
    companyId,
    activatedByUserId: authority.userId,
    activatedAtMs: nowMs,
  });
  const code = generateInvitationCode();
  const codeHash = await sha256Hex(code);
  const expiresAtMs = nowMs + INVITATION_TTL_MS;
  const invitationId = await tx.insertInvitation({
    companyId,
    email: email.value,
    role: "admin",
    codeHash,
    expiresAtMs,
    createdAtMs: nowMs,
    issuedByUserId: authority.userId,
  });
  await audit(tx, {
    authority,
    companyId,
    operationName: "access.gmOnboardCompany",
    basis: basis.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return {
    ok: true,
    companyId,
    activationId,
    invitationId,
    expiresAtMs,
    email: email.value,
    companyName: name.value,
    code,
  };
}

/**
 * Brings an existing firm under GM alpha authority: one open activation
 * per company by construction (an open row conflicts; a ended row may be
 * reopened by a NEW activation, history retained).
 */
export async function performGmActivateCompany(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof gmActivateCompanyEntry.input>,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  if ((await actingGrant(tx, authority)) === null) {
    return await refuseGmAccess(tx, authority, "access.gmActivateCompany", basis.value, null, GM_MODE_NOT_ACTIVE);
  }
  const company = await tx.companyById(input.companyId);
  if (company === null) {
    return await refuseGmAccess(tx, authority, "access.gmActivateCompany", basis.value, null, COMPANY_NOT_FOUND);
  }
  const existing = await tx.openActivationOf(input.companyId);
  if (existing !== null) {
    await audit(tx, {
      authority,
      companyId: input.companyId,
      operationName: "access.gmActivateCompany",
      basis: basis.value,
      outcome: "company_alpha_already_active",
      atMs: nowMs,
    });
    return errorResult(conflictError("company_alpha_already_active"));
  }
  const activationId = await tx.insertActivation({
    companyId: input.companyId,
    activatedByUserId: authority.userId,
    activatedAtMs: nowMs,
  });
  await audit(tx, {
    authority,
    companyId: input.companyId,
    operationName: "access.gmActivateCompany",
    basis: basis.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(gmActivateCompanyEntry.result)({ activationId }),
  );
}

/**
 * Administrator restoration: promotes one ACTIVE member of the target firm
 * to administrator under GM authority. Not a membership power — the GM
 * holds no membership in the firm and members cannot invoke this operation.
 */
export async function performGmRestoreAdministrator(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof gmRestoreAdministratorEntry.input>,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const grant = await actingGrant(tx, authority);
  const company = await tx.companyById(input.companyId);
  const activation = await tx.openActivationOf(input.companyId);
  const access = decideGmCompanyAccess({
    grantOpen: grant !== null,
    companyExists: company !== null,
    activation,
  });
  if (!access.ok) {
    return await refuseGmAccess(tx, authority, "access.gmRestoreAdministrator", basis.value, company, access);
  }
  const memberships = await tx.membershipsOfCompany(input.companyId);
  const target = memberships.find(
    (row) => row.userId === input.userId && row.state === "active",
  );
  if (target === undefined) {
    await audit(tx, {
      authority,
      companyId: input.companyId,
      operationName: "access.gmRestoreAdministrator",
      basis: basis.value,
      outcome: "target_membership_not_found",
      atMs: nowMs,
    });
    return errorResult(notFoundError("memberships", "target_membership_not_found"));
  }
  if (target.role !== "admin") {
    await tx.patchMembershipRole(target.membershipId, "admin");
  }
  await audit(tx, {
    authority,
    companyId: input.companyId,
    operationName: "access.gmRestoreAdministrator",
    basis: basis.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(gmRestoreAdministratorEntry.result)({
      membershipId: target.membershipId,
    }),
  );
}

/**
 * Ends company alpha participation: closes the open activation. Grant-
 * derived access to the firm ends immediately and structurally — every GM
 * operation re-decides `decideGmCompanyAccess` at commit — while the
 * activation row survives as history and ordinary membership is untouched.
 */
export async function performGmEndCompanyAlpha(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof gmEndCompanyAlphaEntry.input>,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.basis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  const grant = await actingGrant(tx, authority);
  const company = await tx.companyById(input.companyId);
  const activation = await tx.openActivationOf(input.companyId);
  const access = decideGmCompanyAccess({
    grantOpen: grant !== null,
    companyExists: company !== null,
    activation,
  });
  if (!access.ok) {
    return await refuseGmAccess(tx, authority, "access.gmEndCompanyAlpha", basis.value, company, access);
  }
  await tx.endActivation(activation!.id, nowMs, authority.userId);
  await audit(tx, {
    authority,
    companyId: input.companyId,
    operationName: "access.gmEndCompanyAlpha",
    basis: basis.value,
    outcome: "ok",
    atMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(gmEndCompanyAlphaEntry.result)({ endedAtMs: nowMs }),
  );
}

/**
 * The recovery runner this lane composes: B2's checked command under the
 * RESOLVED GM actor. Production wires the mutation ctx (dispatch.ts);
 * tests run the same B2 core over an in-memory store, proving the actor.
 */
export type GmRecoveryRunner = (
  input: { userId: string; verificationBasis: string },
  performedBy: string,
) => Promise<ResultEnvelope>;

/**
 * The GM recovery invocation: B2's checked command under the RESOLVED GM
 * actor. The B2 core (sessions, provider accounts, Google subject cleared;
 * users row, membership and authorship untouched) and this lane's audit
 * row commit in ONE transaction — the named prerequisite B2 staged for
 * exactly this caller.
 */
export async function performGmRecoverAccount(
  tx: GmTx,
  authority: GmAuthority,
  input: Schema.Schema.Type<typeof recoverAccountEntry.input>,
  runRecovery: GmRecoveryRunner,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const basis = normalizeGmStatement(input.verificationBasis);
  if (!basis.ok) {
    return errorResult(validationError("gm_basis_invalid"));
  }
  if ((await actingGrant(tx, authority)) === null) {
    return await refuseGmAccess(tx, authority, "access.recoverAccount", basis.value, null, GM_MODE_NOT_ACTIVE);
  }
  const user = await tx.userById(input.userId);
  if (user === null) {
    await audit(tx, {
      authority,
      companyId: null,
      operationName: "access.recoverAccount",
      basis: basis.value,
      outcome: "account_not_found",
      atMs: nowMs,
    });
    return errorResult(notFoundError("users", "account_not_found"));
  }

  // Same transaction: the B2 core records the REAL GM actor in the
  // accountRecoveries ledger; the audit row lands beside it.
  const result = await runRecovery(
    { userId: input.userId, verificationBasis: basis.value },
    authority.userId,
  );
  await audit(tx, {
    authority,
    companyId: null,
    operationName: "access.recoverAccount",
    basis: basis.value,
    outcome: result._tag === "ok" ? "ok" : result.error.code,
    atMs: nowMs,
  });
  return result;
}
