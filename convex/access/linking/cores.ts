/**
 * Linking cores: the db-halves of the B2 ceremony, email change, session
 * recovery and manual recovery (pure decisions in ./policy.ts).
 *
 * Every core runs against a NARROWED store interface of plain-data
 * snapshots (B1's `UserPolicyUser` pattern: policies work with plain
 * strings, `normalizeId` is the proved bridge at the Convex boundary). Two
 * adapters satisfy the same interfaces: the generated-ctx adapter below,
 * and the Convex Auth callback adapter in ./authHook.ts. In-memory fakes
 * implement them in tests/b2, so ceremony transitions, exactly-once
 * commits and recovery effects are pinned without a deployment; the live
 * proofs run the identical cores.
 *
 * Concurrency: every commit both READS and WRITES the same ceremony row
 * (state transition + user/account effect in one transaction), and begin
 * reads the by-email index range it inserts into. Concurrent attempts on
 * one address therefore serialize through Convex optimistic concurrency:
 * a loser retries, observes the committed state, and returns a typed
 * rejection — never a second link.
 */

import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalizeEmail } from "../identity/userPolicy";
import { decideIssuance } from "../identity/issuanceLimit";
import { revokeSessionCore, revocationSurface } from "../identity/operations";
import {
  CODE_VALIDITY_MS,
  LINKING_WINDOW_MS,
  decodeGoogleLinkProfile,
  decideBeginLinking,
  decideConfirmEmailLink,
  decideEmailChangeConfirm,
  decideEmailChangeRequest,
  decideGoogleCallbackLink,
  type AccountView,
  type AttemptView,
  type GoogleLinkProfile,
  type LinkRejectionCode,
} from "./policy";

/** One-time proof code: 8 digits, same shape as B1's sign-in OTP. */
export const PROOF_CODE_LENGTH = 8;

/** Rejects sampled bytes for uniform digits (no modulo bias), like B1. */
export function generateProofCode(): string {
  const digits = "0123456789";
  const maxUsableByte = Math.floor(256 / digits.length) * digits.length; // 250
  let code = "";
  while (code.length < PROOF_CODE_LENGTH) {
    const bytes = new Uint8Array(PROOF_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= maxUsableByte) {
        continue;
      }
      code += digits[byte % digits.length] ?? "0";
      if (code.length === PROOF_CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Snapshots and store surfaces (plain-string ids; fake-able in tests).
// ---------------------------------------------------------------------------

/** The ceremony snapshot every core consumes (state + staged code). */
export interface AttemptSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly initiatingMethod: "google" | "email_code";
  readonly targetMethod: "google" | "email_code";
  readonly state: "awaiting_first_proof" | "awaiting_target_proof" | "committed" | "rejected";
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly firstProofAtMs: number | null;
  readonly pendingCodeHash: string | null;
  readonly pendingCodeExpiresAtMs: number | null;
}

/** Convex-style patch: an explicit undefined clears an optional field. */
export interface AttemptPatch {
  state?: AttemptSnapshot["state"];
  firstProofAtMs?: number | undefined;
  pendingCodeHash?: string | undefined;
  pendingCodeExpiresAtMs?: number | undefined;
  googleSub?: string | undefined;
  committedAtMs?: number | undefined;
  rejectedAtMs?: number | undefined;
  rejectionCode?: string | undefined;
}

/** The pending email-change snapshot. */
export interface EmailChangeSnapshot {
  readonly id: string;
  readonly newEmail: string;
  readonly previousEmail: string;
  readonly codeHash: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly confirmed: boolean;
}

/** One device-session registry row, as recovery sees it. */
export interface RegistrySessionSnapshot {
  readonly id: string;
  readonly revokedAtMs: number | null;
}

/** The read surface every core consumes. */
export interface LinkingStore {
  userById(id: string): Promise<AccountView | null>;
  /** User rows at a normalized address, case-insensitively defended. */
  usersByEmail(email: string): Promise<AccountView[]>;
  /** Non-terminal ceremony rows at a normalized address. */
  openAttemptsByEmail(email: string): Promise<AttemptSnapshot[]>;
  /** The actor's active (non-terminal, unexpired) ceremony, if any. */
  activeAttemptByUser(userId: string, nowMs: number): Promise<AttemptSnapshot | null>;
  /** The actor's most recent ceremony of any state (typed confirmation). */
  latestAttemptByUser(userId: string): Promise<AttemptSnapshot | null>;
  /** Owner of the email-code provider credential at an address, if any. */
  emailCodeCredentialOwner(email: string): Promise<string | null>;
  /** Whether the account carries its own email-code credential. */
  hasEmailCodeCredential(userId: string): Promise<boolean>;
  /** Owner of the Google provider credential for a subject, if any. */
  googleCredentialOwner(sub: string): Promise<string | null>;
  /** User ids already carrying a Google subject. */
  usersWithGoogleSubject(sub: string): Promise<string[]>;
  /** The actor's device-session registry rows. */
  registrySessionsByUser(userId: string): Promise<RegistrySessionSnapshot[]>;
  /** The latest unconfirmed email-change request of a user, if any. */
  pendingEmailChange(userId: string): Promise<EmailChangeSnapshot | null>;
}

/** The write extension the ceremony/email-change/recovery cores need. */
export interface LinkingTx extends LinkingStore {
  insertAttempt(row: {
    userId: string;
    email: string;
    initiatingMethod: "google" | "email_code";
    targetMethod: "google" | "email_code";
    startedAtMs: number;
    expiresAtMs: number;
  }): Promise<string>;
  patchAttempt(id: string, patch: AttemptPatch): Promise<void>;
  patchUser(
    id: string,
    patch: {
      googleSubject?: string | null;
      email?: string;
      emailVerificationTime?: number;
    },
  ): Promise<void>;
  insertEmailCodeAccount(args: { userId: string; email: string; nowMs: number }): Promise<void>;
  /** Repoints the email-code credential of `previousEmail` when the actor owns it. */
  repointEmailCodeCredential(args: {
    userId: string;
    previousEmail: string;
    newEmail: string;
  }): Promise<boolean>;
  insertEmailChange(row: {
    userId: string;
    newEmail: string;
    previousEmail: string;
    codeHash: string;
    requestedAtMs: number;
    expiresAtMs: number;
  }): Promise<string>;
  patchEmailChange(
    id: string,
    patch: { confirmedAtMs?: number; codeHash?: string; expiresAtMs?: number },
  ): Promise<void>;
  /** Reads and rewrites one issuance-throttle row (B1's decideIssuance). */
  applyIssuanceThrottle(identifier: string, nowMs: number): Promise<boolean>;
  insertRecovery(row: {
    userId: string;
    verificationBasis: string;
    performedBy: string;
    performedAtMs: number;
    revokedSessionIds: string[];
    clearedAccountIds: string[];
    clearedGoogleSubject: boolean;
  }): Promise<void>;
  /** Revokes one registry row through B1's canonical revocation core. */
  revokeRegistrySession(args: {
    actorUserId: string;
    targetSessionId: string;
    nowMs: number;
    companyIdForEvent: string | null;
  }): Promise<{ revoked: boolean }>;
  deleteAuthSessionsOfUser(userId: string): Promise<number>;
  deleteAuthAccountsOfUser(userId: string): Promise<string[]>;
}

function attemptViewOf(row: AttemptSnapshot): AttemptView {
  return {
    userId: row.userId,
    email: row.email,
    targetMethod: row.targetMethod,
    state: row.state,
    expiresAtMs: row.expiresAtMs,
    firstProofAtMs: row.firstProofAtMs,
  };
}

function isActive(attempt: AttemptSnapshot, nowMs: number): boolean {
  return (
    (attempt.state === "awaiting_first_proof" || attempt.state === "awaiting_target_proof") &&
    nowMs <= attempt.expiresAtMs
  );
}

// ---------------------------------------------------------------------------
// Ceremony cores.
// ---------------------------------------------------------------------------

export type CoreOk<T> = { readonly ok: true; readonly value: T };
export type CoreRejected = { readonly ok: false; readonly code: LinkRejectionCode };
export type CoreResult<T> = CoreOk<T> | CoreRejected;

/**
 * Opens the ceremony attaching `targetMethod` to the live account. The
 * canonical address is the account's own email: BOTH proofs must carry it.
 */
export async function beginLinkingCore(
  tx: LinkingTx,
  args: { actorUserId: string; targetMethod: "google" | "email_code"; nowMs: number },
): Promise<CoreResult<{ attemptId: string }>> {
  const account = await tx.userById(args.actorUserId);
  if (account === null) {
    return { ok: false, code: "ambiguous_registry" };
  }
  const email = normalizeEmail(account.email);
  const credentialOwner =
    args.targetMethod === "email_code" ? await tx.emailCodeCredentialOwner(email) : null;
  const decision = decideBeginLinking({
    account,
    targetMethod: args.targetMethod,
    targetCredentialOwner: credentialOwner,
    activeAttemptsAtEmail: (await tx.openAttemptsByEmail(email)).map(attemptViewOf),
    nowMs: args.nowMs,
  });
  if (decision.action === "reject") {
    return { ok: false, code: decision.reason };
  }
  const initiatingMethod: "google" | "email_code" =
    account.googleSubject !== null ? "google" : "email_code";
  const attemptId = await tx.insertAttempt({
    userId: account.id,
    email,
    initiatingMethod,
    targetMethod: args.targetMethod,
    startedAtMs: args.nowMs,
    expiresAtMs: args.nowMs + LINKING_WINDOW_MS,
  });
  return { ok: true, value: { attemptId } };
}

/** Which ceremony leg a staged proof code belongs to. */
export type ProofCodeLeg = "first_proof" | "target_proof";

/** What staging a code returns (server-side only; the code never crosses to the client). */
export interface StagedCode {
  readonly email: string;
  readonly code: string;
  readonly expiresAtMs: number;
  readonly leg: ProofCodeLeg;
}

/**
 * Stages a one-time proof code on the actor's active ceremony (the email
 * half of a leg; Google legs prove by OAuth). Returns the address to send
 * to and the PLAIN code; the sending action delivers it and never returns
 * it to the client.
 */
export async function stageProofCodeCore(
  tx: LinkingTx,
  args: { actorUserId: string; nowMs: number },
): Promise<CoreResult<StagedCode>> {
  const attempt = await tx.activeAttemptByUser(args.actorUserId, args.nowMs);
  if (attempt === null) {
    return { ok: false, code: "no_active_ceremony" };
  }
  let leg: ProofCodeLeg;
  if (attempt.state === "awaiting_first_proof" && attempt.initiatingMethod === "email_code") {
    leg = "first_proof";
  } else if (attempt.state === "awaiting_target_proof" && attempt.targetMethod === "email_code") {
    leg = "target_proof";
  } else {
    // Google legs do not take codes; the ceremony is on an OAuth leg.
    return { ok: false, code: "no_active_ceremony" };
  }
  const allowed = await tx.applyIssuanceThrottle(
    `linking:email_code:${normalizeEmail(attempt.email)}`,
    args.nowMs,
  );
  if (!allowed) {
    return { ok: false, code: "too_many_attempts" };
  }
  const code = generateProofCode();
  const expiresAtMs = args.nowMs + CODE_VALIDITY_MS;
  await tx.patchAttempt(attempt.id, {
    pendingCodeHash: await sha256Hex(code),
    pendingCodeExpiresAtMs: expiresAtMs,
  });
  return { ok: true, value: { email: attempt.email, code, expiresAtMs, leg } };
}

/**
 * Verifies a staged proof code. On the first leg this records the fresh
 * email proof; on the target leg it COMMITS the email-direction link
 * (provider account insert + user patch + ceremony transition, atomic).
 */
export async function verifyProofCodeCore(
  tx: LinkingTx,
  args: { actorUserId: string; code: string; nowMs: number },
): Promise<CoreResult<{ leg: ProofCodeLeg; linked: boolean }>> {
  const attempt = await tx.activeAttemptByUser(args.actorUserId, args.nowMs);
  if (attempt === null) {
    return { ok: false, code: "no_active_ceremony" };
  }
  const providedHash = await sha256Hex(args.code);
  if (attempt.state === "awaiting_first_proof" && attempt.initiatingMethod === "email_code") {
    if (
      attempt.pendingCodeHash === null ||
      attempt.pendingCodeExpiresAtMs === null ||
      providedHash !== attempt.pendingCodeHash ||
      args.nowMs > attempt.pendingCodeExpiresAtMs
    ) {
      return { ok: false, code: "code_wrong_or_expired" };
    }
    await tx.patchAttempt(attempt.id, {
      state: "awaiting_target_proof",
      firstProofAtMs: args.nowMs,
      pendingCodeHash: undefined,
      pendingCodeExpiresAtMs: undefined,
    });
    return { ok: true, value: { leg: "first_proof", linked: false } };
  }
  if (attempt.state === "awaiting_target_proof" && attempt.targetMethod === "email_code") {
    const account = await tx.userById(args.actorUserId);
    if (account === null) {
      return { ok: false, code: "ambiguous_registry" };
    }
    const decision = decideConfirmEmailLink({
      attempt: {
        ...attemptViewOf(attempt),
        pendingCodeExpiresAtMs: attempt.pendingCodeExpiresAtMs,
      },
      account,
      providedCodeHash: providedHash,
      pendingCodeHash: attempt.pendingCodeHash,
      emailCredentialOwner: await tx.emailCodeCredentialOwner(attempt.email),
      nowMs: args.nowMs,
    });
    if (decision.action === "reject") {
      return { ok: false, code: decision.reason };
    }
    await tx.insertEmailCodeAccount({
      userId: account.id,
      email: attempt.email,
      nowMs: args.nowMs,
    });
    await tx.patchAttempt(attempt.id, {
      state: "committed",
      committedAtMs: args.nowMs,
      firstProofAtMs: attempt.firstProofAtMs ?? args.nowMs,
      pendingCodeHash: undefined,
      pendingCodeExpiresAtMs: undefined,
    });
    return { ok: true, value: { leg: "target_proof", linked: true } };
  }
  return { ok: false, code: "no_active_ceremony" };
}

/** The store slice the two auth-callback hooks consume (see ./authHook.ts). */
export interface GoogleHookStore {
  userById(id: string): Promise<AccountView | null>;
  openAttemptsByEmail(email: string): Promise<AttemptSnapshot[]>;
  activeAttemptByUser(userId: string, nowMs: number): Promise<AttemptSnapshot | null>;
  googleCredentialOwner(sub: string): Promise<string | null>;
  usersWithGoogleSubject(sub: string): Promise<string[]>;
  patchAttempt(id: string, patch: AttemptPatch): Promise<void>;
  patchUser(id: string, patch: { googleSubject?: string | null }): Promise<void>;
}

/**
 * The auth-callback hook for a Google RESUME sign-in (type "oauth" into an
 * existing account): records the fresh Google proof on the actor's
 * email-direction ceremony. No-op when no ceremony awaits it — plain
 * sign-ins pay one bounded lookup, nothing more.
 */
export async function recordGoogleProofCore(
  store: GoogleHookStore,
  args: { userId: string; profile: GoogleLinkProfile; nowMs: number },
): Promise<void> {
  const account = await store.userById(args.userId);
  if (account === null || account.googleSubject !== args.profile.sub) {
    return;
  }
  const attempt = await store.activeAttemptByUser(args.userId, args.nowMs);
  if (
    attempt === null ||
    attempt.targetMethod !== "email_code" ||
    attempt.initiatingMethod !== "google" ||
    normalizeEmail(attempt.email) !== normalizeEmail(args.profile.email)
  ) {
    return;
  }
  if (attempt.state === "awaiting_first_proof" || attempt.state === "awaiting_target_proof") {
    await store.patchAttempt(attempt.id, {
      state: "awaiting_target_proof",
      firstProofAtMs: args.nowMs,
    });
  }
}

/**
 * The auth-callback hook for B1's `method_conflict` rejection (a Google
 * sign-in whose address collides with an email-code account): replaces the
 * rejection with the explicit link commit when — and only when — an active
 * ceremony proves both methods. Returns the committed user id, or the
 * typed reason the caller keeps failing with.
 */
export async function googleLinkFromCallbackCore(
  tx: GoogleHookStore,
  args: {
    rawProfile: Record<string, unknown>;
    usersWithEmail: readonly { id: string; email: string; googleSubject: string | null }[];
    nowMs: number;
  },
): Promise<
  { committed: true; userId: string } | { committed: false; reason: LinkRejectionCode }
> {
  const profile = decodeGoogleLinkProfile(args.rawProfile);
  if (profile === null) {
    return { committed: false, reason: "google_email_unproven" };
  }
  const normalized = normalizeEmail(profile.email);
  const attempts = await tx.openAttemptsByEmail(normalized);
  const decision = decideGoogleCallbackLink({
    profile,
    usersWithEmail: args.usersWithEmail
      .filter((user) => normalizeEmail(user.email) === normalized)
      .map((user) => ({ id: user.id, email: user.email, googleSubject: user.googleSubject })),
    attemptsAtEmail: attempts.map(attemptViewOf),
    googleSubCredentialOwner: await tx.googleCredentialOwner(profile.sub),
    usersWithGoogleSub: await tx.usersWithGoogleSubject(profile.sub),
    nowMs: args.nowMs,
  });
  if (decision.action === "reject") {
    return { committed: false, reason: decision.reason };
  }
  const attempt = attempts.find((row) => row.userId === decision.userId);
  if (attempt === undefined) {
    return { committed: false, reason: "no_active_ceremony" };
  }
  await tx.patchAttempt(attempt.id, {
    state: "committed",
    committedAtMs: args.nowMs,
    googleSub: decision.googleSub,
  });
  await tx.patchUser(decision.userId, { googleSubject: decision.googleSub });
  return { committed: true, userId: decision.userId };
}

/** Cancels the actor's active ceremony (explicit abandonment). */
export async function cancelLinkingCore(
  tx: Pick<LinkingTx, "activeAttemptByUser" | "patchAttempt">,
  args: { actorUserId: string; nowMs: number },
): Promise<{ readonly cancelled: boolean }> {
  const attempt = await tx.activeAttemptByUser(args.actorUserId, args.nowMs);
  if (attempt === null) {
    return { cancelled: false };
  }
  await tx.patchAttempt(attempt.id, {
    state: "rejected",
    rejectedAtMs: args.nowMs,
    rejectionCode: "cancelled_by_user",
    pendingCodeHash: undefined,
    pendingCodeExpiresAtMs: undefined,
  });
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Email change cores.
// ---------------------------------------------------------------------------

/**
 * Stages a pending email change: requires recent authentication (the
 * device session started within RECENT_AUTH_MS) and stores a hashed code
 * for the NEW address. The action half delivers the code.
 */
export async function stageEmailChangeCore(
  tx: LinkingTx,
  args: { actorUserId: string; newEmail: string; sessionStartedAtMs: number; nowMs: number },
): Promise<CoreResult<{ email: string; code: string; expiresAtMs: number }>> {
  const account = await tx.userById(args.actorUserId);
  if (account === null) {
    return { ok: false, code: "ambiguous_registry" };
  }
  const pending = await tx.pendingEmailChange(args.actorUserId);
  const decision = decideEmailChangeRequest({
    account,
    newEmail: args.newEmail,
    sessionStartedAtMs: args.sessionStartedAtMs,
    pendingRequestExists: pending !== null,
    nowMs: args.nowMs,
  });
  if (decision.action === "reject") {
    return { ok: false, code: decision.reason };
  }
  const normalized = normalizeEmail(args.newEmail);
  const allowed = await tx.applyIssuanceThrottle(`email_change:${normalized}`, args.nowMs);
  if (!allowed) {
    return { ok: false, code: "too_many_attempts" };
  }
  const code = generateProofCode();
  const expiresAtMs = args.nowMs + CODE_VALIDITY_MS;
  await tx.insertEmailChange({
    userId: account.id,
    newEmail: normalized,
    previousEmail: normalizeEmail(account.email),
    codeHash: await sha256Hex(code),
    requestedAtMs: args.nowMs,
    expiresAtMs,
  });
  return { ok: true, value: { email: normalized, code, expiresAtMs } };
}

/**
 * Confirms a pending email change: verifies the code mailed to the NEW
 * address, then atomically moves `users.email`, repoints the email-code
 * credential and rejects the actor's pending ceremonies. A failed
 * confirmation writes nothing.
 */
export async function confirmEmailChangeCore(
  tx: LinkingTx,
  args: { actorUserId: string; code: string; nowMs: number },
): Promise<CoreResult<{ newEmail: string; changedAtMs: number }>> {
  const account = await tx.userById(args.actorUserId);
  if (account === null) {
    return { ok: false, code: "ambiguous_registry" };
  }
  const request = await tx.pendingEmailChange(args.actorUserId);
  const decision = decideEmailChangeConfirm({
    account,
    request:
      request === null
        ? null
        : {
            newEmail: request.newEmail,
            codeHash: request.codeHash,
            expiresAtMs: request.expiresAtMs,
            confirmedAtMs: request.confirmed ? request.requestedAtMs : null,
          },
    providedCodeHash: await sha256Hex(args.code),
    nowMs: args.nowMs,
  });
  if (decision.action === "reject") {
    return { ok: false, code: decision.reason };
  }
  if (request === null) {
    return { ok: false, code: "no_active_ceremony" };
  }
  await tx.patchUser(account.id, {
    email: request.newEmail,
    emailVerificationTime: args.nowMs,
  });
  await tx.repointEmailCodeCredential({
    userId: account.id,
    previousEmail: request.previousEmail,
    newEmail: request.newEmail,
  });
  const attempt = await tx.activeAttemptByUser(args.actorUserId, args.nowMs);
  if (attempt !== null) {
    await tx.patchAttempt(attempt.id, {
      state: "rejected",
      rejectedAtMs: args.nowMs,
      rejectionCode: "email_changed",
      pendingCodeHash: undefined,
      pendingCodeExpiresAtMs: undefined,
    });
  }
  await tx.patchEmailChange(request.id, { confirmedAtMs: args.nowMs });
  return { ok: true, value: { newEmail: request.newEmail, changedAtMs: args.nowMs } };
}

// ---------------------------------------------------------------------------
// Session recovery cores.
// ---------------------------------------------------------------------------

/**
 * Revokes every OTHER device session of the actor through B1's canonical
 * revocation core (one call per session; the current device stays).
 */
export async function revokeOtherSessionsCore(
  tx: LinkingTx,
  args: {
    actorUserId: string;
    currentSessionId: string;
    nowMs: number;
    companyIdForEvent: string | null;
  },
): Promise<{ revokedAtMs: number; revokedCount: number; skipped: number }> {
  const rows = await tx.registrySessionsByUser(args.actorUserId);
  let revokedCount = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.id === args.currentSessionId || row.revokedAtMs !== null) {
      skipped += 1;
      continue;
    }
    const outcome = await tx.revokeRegistrySession({
      actorUserId: args.actorUserId,
      targetSessionId: row.id,
      nowMs: args.nowMs,
      companyIdForEvent: args.companyIdForEvent,
    });
    if (outcome.revoked) {
      revokedCount += 1;
    } else {
      skipped += 1;
    }
  }
  return { revokedAtMs: args.nowMs, revokedCount, skipped };
}

/** The recovery outcome the ledger row and the caller share. */
export interface RecoveryOutcome {
  readonly state: "recovered";
  readonly recoveredAtMs: number;
  readonly revokedSessionIds: string[];
  readonly clearedAccountIds: string[];
  readonly clearedGoogleSubject: boolean;
}

/**
 * The checked manual-recovery core (B4 supplies the only alpha invoker;
 * B2's guarded dev action runs it for evidence). One transaction:
 *
 * - revokes every registry session and deletes every upstream authSession
 *   (with refresh tokens), so no pre-recovery token survives either layer;
 * - deletes every provider account row and detaches the Google subject:
 *   the person must set up a fresh sign-in method;
 * - rejects pending ceremonies;
 * - records the verification basis and performer in `accountRecoveries`.
 *
 * The users row — and with it every membership and authored record — is
 * untouched: historical actor ids stay stable.
 */
export async function recoverAccountCore(
  tx: LinkingTx,
  args: { targetUserId: string; verificationBasis: string; performedBy: string; nowMs: number },
): Promise<RecoveryOutcome | { readonly state: "rejected"; readonly reason: "no_such_account" }> {
  if (args.verificationBasis.trim().length === 0) {
    throw new Error("recovery: verification basis is required");
  }
  const account = await tx.userById(args.targetUserId);
  if (account === null) {
    return { state: "rejected", reason: "no_such_account" };
  }
  const rows = await tx.registrySessionsByUser(args.targetUserId);
  const revokedSessionIds: string[] = [];
  for (const row of rows) {
    if (row.revokedAtMs !== null) {
      continue;
    }
    await tx.revokeRegistrySession({
      actorUserId: args.targetUserId,
      targetSessionId: row.id,
      nowMs: args.nowMs,
      companyIdForEvent: null,
    });
    revokedSessionIds.push(row.id);
  }
  await tx.deleteAuthSessionsOfUser(args.targetUserId);
  const clearedAccountIds = await tx.deleteAuthAccountsOfUser(args.targetUserId);
  const clearedGoogleSubject = account.googleSubject !== null;
  if (clearedGoogleSubject) {
    await tx.patchUser(args.targetUserId, { googleSubject: null });
  }
  const attempt = await tx.activeAttemptByUser(args.targetUserId, args.nowMs);
  if (attempt !== null) {
    await tx.patchAttempt(attempt.id, {
      state: "rejected",
      rejectedAtMs: args.nowMs,
      rejectionCode: "recovered",
      pendingCodeHash: undefined,
      pendingCodeExpiresAtMs: undefined,
    });
  }
  await tx.insertRecovery({
    userId: args.targetUserId,
    verificationBasis: args.verificationBasis,
    performedBy: args.performedBy,
    performedAtMs: args.nowMs,
    revokedSessionIds,
    clearedAccountIds,
    clearedGoogleSubject,
  });
  return {
    state: "recovered",
    recoveredAtMs: args.nowMs,
    revokedSessionIds,
    clearedAccountIds,
    clearedGoogleSubject,
  };
}

// ---------------------------------------------------------------------------
// Status view (the barebones account UI reads this).
// ---------------------------------------------------------------------------

/** What the account screen shows about linking state. */
export interface LinkingStatusView {
  readonly email: string;
  readonly displayName: string;
  readonly googleLinked: boolean;
  readonly emailCodeLinked: boolean;
  readonly activeAttempt: {
    readonly targetMethod: "google" | "email_code";
    readonly state: AttemptSnapshot["state"];
    readonly startedAtMs: number;
    readonly expiresAtMs: number;
    readonly firstProofAtMs: number | null;
    /** Which leg is expected next (OAuth leg or emailed code leg). */
    readonly nextLeg: "google_oauth" | "email_code";
  } | null;
}

/** Builds the linking status view for the actor's account. */
export async function linkingStatusCore(
  store: LinkingStore,
  args: { userId: string; displayName?: string; nowMs: number },
): Promise<LinkingStatusView | null> {
  const account = await store.userById(args.userId);
  if (account === null) {
    return null;
  }
  const attempt = await store.activeAttemptByUser(args.userId, args.nowMs);
  const emailCodeLinked = await store.hasEmailCodeCredential(args.userId);
  return {
    email: account.email,
    displayName: args.displayName ?? account.email.split("@")[0] ?? account.email,
    googleLinked: account.googleSubject !== null,
    emailCodeLinked,
    activeAttempt:
      attempt === null
        ? null
        : {
            targetMethod: attempt.targetMethod,
            state: attempt.state,
            startedAtMs: attempt.startedAtMs,
            expiresAtMs: attempt.expiresAtMs,
            firstProofAtMs: attempt.firstProofAtMs,
            nextLeg:
              attempt.state === "awaiting_first_proof"
                ? attempt.initiatingMethod === "google"
                  ? "google_oauth"
                  : "email_code"
                : attempt.targetMethod === "google"
                  ? "google_oauth"
                  : "email_code",
          },
  };
}

// ---------------------------------------------------------------------------
// Convex adapter (generated ctx: typed chains + normalizeId bridge).
// ---------------------------------------------------------------------------

type IdentityDb = QueryCtx["db"];

function attemptSnapshotOf(row: {
  _id: string;
  userId: string;
  email: string;
  initiatingMethod: "google" | "email_code";
  targetMethod: "google" | "email_code";
  state: AttemptSnapshot["state"];
  startedAtMs: number;
  expiresAtMs: number;
  firstProofAtMs?: number;
  pendingCodeHash?: string;
  pendingCodeExpiresAtMs?: number;
}): AttemptSnapshot {
  return {
    id: row._id,
    userId: row.userId,
    email: row.email,
    initiatingMethod: row.initiatingMethod,
    targetMethod: row.targetMethod,
    state: row.state,
    startedAtMs: row.startedAtMs,
    expiresAtMs: row.expiresAtMs,
    firstProofAtMs: row.firstProofAtMs ?? null,
    pendingCodeHash: row.pendingCodeHash ?? null,
    pendingCodeExpiresAtMs: row.pendingCodeExpiresAtMs ?? null,
  };
}

/** Adapts a Convex reader to the linking read surface. */
export function linkingStore(db: IdentityDb): LinkingStore {
  return {
    userById: async (id) => {
      const userId = db.normalizeId("users", id);
      if (userId === null) {
        return null;
      }
      const user = await db.get(userId);
      if (user === null) {
        return null;
      }
      return {
        id: user._id,
        email: user.email,
        googleSubject: user.googleSubject ?? null,
      };
    },
    usersByEmail: async (email) => {
      const rows = await db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
        .collect();
      return rows
        .filter((row) => normalizeEmail(row.email) === normalizeEmail(email))
        .map((row) => ({
          id: row._id,
          email: row.email,
          googleSubject: row.googleSubject ?? null,
        }));
    },
    openAttemptsByEmail: async (email) => {
      const rows = await db
        .query("linkingAttempts")
        .withIndex("by_email_state", (q) => q.eq("email", normalizeEmail(email)))
        .collect();
      return rows
        .filter(
          (row) => row.state === "awaiting_first_proof" || row.state === "awaiting_target_proof",
        )
        .map(attemptSnapshotOf);
    },
    activeAttemptByUser: async (userId, nowMs) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const rows = await db
        .query("linkingAttempts")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .collect();
      const active = rows
        .map(attemptSnapshotOf)
        .filter((attempt) => isActive(attempt, nowMs))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      return active[0] ?? null;
    },
    latestAttemptByUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const rows = await db
        .query("linkingAttempts")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .order("desc")
        .first();
      return rows === null ? null : attemptSnapshotOf(rows);
    },
    emailCodeCredentialOwner: async (email) => {
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "email_code").eq("providerAccountId", normalizeEmail(email)),
        )
        .unique();
      return account === null ? null : account.userId;
    },
    hasEmailCodeCredential: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return false;
      }
      const accounts = await db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", uid))
        .collect();
      return accounts.some((account) => account.provider === "email_code");
    },
    googleCredentialOwner: async (sub) => {
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "google").eq("providerAccountId", sub),
        )
        .unique();
      return account === null ? null : account.userId;
    },
    usersWithGoogleSubject: async (sub) => {
      const rows = await db
        .query("users")
        .filter((q) => q.eq(q.field("googleSubject"), sub))
        .take(2);
      return rows.map((row) => row._id);
    },
    registrySessionsByUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return [];
      }
      const rows = await db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .collect();
      return rows.map((row) => ({ id: row._id, revokedAtMs: row.revokedAtMs ?? null }));
    },
    pendingEmailChange: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const rows = await db
        .query("emailChangeRequests")
        .withIndex("by_user_requested", (q) => q.eq("userId", uid))
        .collect();
      const pending = rows
        .filter((row) => row.confirmedAtMs === undefined)
        .sort((a, b) => b.requestedAtMs - a.requestedAtMs);
      const row = pending[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row._id,
        newEmail: row.newEmail,
        previousEmail: row.previousEmail,
        codeHash: row.codeHash,
        requestedAtMs: row.requestedAtMs,
        expiresAtMs: row.expiresAtMs,
        confirmed: false,
      };
    },
  };
}

/**
 * Adapts one Convex mutation context to the linking write surface. The
 * full ctx (not just db) is required: revocation goes through B1's
 * `revokeSessionCore` with its canonical event publication.
 */
export function linkingTx(ctx: MutationCtx): LinkingTx {
  const db = ctx.db;
  const store = linkingStore(db);
  const surface = revocationSurface(ctx);
  return {
    ...store,
    insertAttempt: async (row) => {
      const userId = db.normalizeId("users", row.userId);
      if (userId === null) {
        throw new Error("linking: invalid user id");
      }
      return await db.insert("linkingAttempts", {
        userId,
        email: row.email,
        initiatingMethod: row.initiatingMethod,
        targetMethod: row.targetMethod,
        state: "awaiting_first_proof",
        startedAtMs: row.startedAtMs,
        expiresAtMs: row.expiresAtMs,
      });
    },
    patchAttempt: async (id, patch) => {
      const attemptId = db.normalizeId("linkingAttempts", id);
      if (attemptId === null) {
        throw new Error("linking: invalid attempt id");
      }
      await db.patch(attemptId, patch);
    },
    patchUser: async (id, patch) => {
      const userId = db.normalizeId("users", id);
      if (userId === null) {
        throw new Error("linking: invalid user id");
      }
      // googleSubject null clears the marker (Convex patch: undefined
      // removes the field); the interface stays exact-optional-clean.
      const { googleSubject, ...rest } = patch;
      await db.patch(userId, {
        ...rest,
        ...(googleSubject === undefined ? {} : { googleSubject: googleSubject ?? undefined }),
      });
    },
    insertEmailCodeAccount: async ({ userId, email, nowMs }) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      await db.insert("authAccounts", {
        userId: uid,
        provider: "email_code",
        providerAccountId: normalizeEmail(email),
        emailVerified: normalizeEmail(email),
      });
      await db.patch(uid, { emailVerificationTime: nowMs });
    },
    repointEmailCodeCredential: async ({ userId, previousEmail, newEmail }) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return false;
      }
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "email_code").eq("providerAccountId", normalizeEmail(previousEmail)),
        )
        .unique();
      if (account === null || account.userId !== uid) {
        return false;
      }
      await db.patch(account._id, {
        providerAccountId: normalizeEmail(newEmail),
        emailVerified: normalizeEmail(newEmail),
      });
      return true;
    },
    insertEmailChange: async (row) => {
      const uid = db.normalizeId("users", row.userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      return await db.insert("emailChangeRequests", {
        userId: uid,
        newEmail: row.newEmail,
        previousEmail: row.previousEmail,
        codeHash: row.codeHash,
        requestedAtMs: row.requestedAtMs,
        expiresAtMs: row.expiresAtMs,
      });
    },
    patchEmailChange: async (id, patch) => {
      const requestId = db.normalizeId("emailChangeRequests", id);
      if (requestId === null) {
        throw new Error("linking: invalid request id");
      }
      await db.patch(requestId, patch);
    },
    applyIssuanceThrottle: async (identifier, nowMs) => {
      const limitRow = await db
        .query("authRateLimits")
        .filter((q) => q.eq(q.field("identifier"), identifier))
        .first();
      const limit = decideIssuance(
        limitRow === null
          ? null
          : { lastAttemptTime: limitRow.lastAttemptTime, attemptsLeft: limitRow.attemptsLeft },
        nowMs,
      );
      if (!limit.allowed) {
        // No write on a blocked attempt (the row must not be pushed forward).
        return false;
      }
      if (limitRow === null) {
        await db.insert("authRateLimits", {
          identifier,
          lastAttemptTime: limit.next.lastAttemptTime,
          attemptsLeft: limit.next.attemptsLeft,
        });
      } else {
        await db.patch(limitRow._id, {
          lastAttemptTime: limit.next.lastAttemptTime,
          attemptsLeft: limit.next.attemptsLeft,
        });
      }
      return true;
    },
    insertRecovery: async (row) => {
      const uid = db.normalizeId("users", row.userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      const revokedSessionIds = row.revokedSessionIds.map((id) => {
        const sessionId = db.normalizeId("sessions", id);
        if (sessionId === null) {
          throw new Error("recovery: invalid session id");
        }
        return sessionId;
      });
      const clearedAccountIds = row.clearedAccountIds.map((id) => {
        const accountId = db.normalizeId("authAccounts", id);
        if (accountId === null) {
          throw new Error("recovery: invalid account id");
        }
        return accountId;
      });
      await db.insert("accountRecoveries", {
        userId: uid,
        verificationBasis: row.verificationBasis,
        performedBy: row.performedBy,
        performedAtMs: row.performedAtMs,
        revokedSessionIds,
        clearedAccountIds,
        clearedGoogleSubject: row.clearedGoogleSubject,
      });
    },
    revokeRegistrySession: async (args) => {
      const targetSessionId = db.normalizeId("sessions", args.targetSessionId);
      const actorUserId = db.normalizeId("users", args.actorUserId);
      if (targetSessionId === null || actorUserId === null) {
        return { revoked: false };
      }
      const companyId =
        args.companyIdForEvent === null
          ? null
          : db.normalizeId("companies", args.companyIdForEvent);
      const outcome = await revokeSessionCore(surface, {
        actorUserId,
        targetSessionId,
        nowMs: args.nowMs,
        companyIdForEvent: companyId,
      });
      return outcome.result._tag === "ok" ? { revoked: true } : { revoked: false };
    },
    deleteAuthSessionsOfUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return 0;
      }
      const sessions = await db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", uid))
        .collect();
      for (const session of sessions) {
        // Same cleanup order as the library's deleteSession: refresh
        // tokens first, then the session row itself.
        const tokens = await db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .collect();
        for (const token of tokens) {
          await db.delete(token._id);
        }
        await db.delete(session._id);
      }
      return sessions.length;
    },
    deleteAuthAccountsOfUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return [];
      }
      const accounts = await db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", uid))
        .collect();
      const deleted: string[] = [];
      for (const account of accounts) {
        await db.delete(account._id);
        deleted.push(account._id);
      }
      return deleted;
    },
  };
}
