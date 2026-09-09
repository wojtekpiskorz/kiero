/**
 * Linking store surfaces (B2): plain-data snapshots and the narrow
 * interfaces every linking core consumes.
 *
 * B1's `UserPolicyUser` pattern: cores work with plain-string ids and
 * snapshot views; `normalizeId` is the proved bridge at each Convex
 * boundary (the generated-ctx adapter in ./storeAdapter.ts and the
 * Convex Auth callback adapter in ./authHook.ts). In-memory fakes
 * implement the same interfaces in tests/b2, so ceremony transitions,
 * exactly-once commits and recovery effects are pinned without a
 * deployment; the live proofs run the identical cores.
 */

import type { AccountView, AttemptView, LinkRejectionCode } from "./policy";

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

/** The shared core result envelope (typed ok / typed rejection code). */
export type CoreOk<T> = { readonly ok: true; readonly value: T };
export type CoreRejected = { readonly ok: false; readonly code: LinkRejectionCode };
export type CoreResult<T> = CoreOk<T> | CoreRejected;

/** Maps a store snapshot onto the policy's read view. */
export function attemptViewOf(row: AttemptSnapshot): AttemptView {
  return {
    userId: row.userId,
    email: row.email,
    targetMethod: row.targetMethod,
    state: row.state,
    expiresAtMs: row.expiresAtMs,
    firstProofAtMs: row.firstProofAtMs,
  };
}
