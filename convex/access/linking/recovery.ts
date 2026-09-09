/**
 * The manual-recovery core (B2): the checked command's implementation.
 * B4 supplies the only alpha invoker (GM authority); B2's guarded dev
 * action (./probe.ts) runs it for evidence.
 *
 * One transaction:
 *
 * - revokes every registry session and deletes every upstream authSession
 *   (with refresh tokens), so no pre-recovery token survives either layer;
 * - deletes every provider account row and detaches the Google subject:
 *   the person must set up a fresh sign-in method (recovery is the only
 *   unlink path; relinking runs a fresh ceremony);
 * - rejects pending ceremonies;
 * - records the verification basis and performer in `accountRecoveries`.
 *
 * The users row — and with it every membership and authored record — is
 * untouched: historical actor ids stay stable.
 */

import type { LinkingTx } from "./store";

/** The recovery outcome the ledger row and the caller share. */
export interface RecoveryOutcome {
  readonly state: "recovered";
  readonly recoveredAtMs: number;
  readonly revokedSessionIds: string[];
  readonly clearedAccountIds: string[];
  readonly clearedGoogleSubject: boolean;
}

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
