/**
 * The email-change core (B2): stage (recent-authentication gate + hashed
 * code for the NEW address) and confirm (atomic address move + credential
 * repoint + pending-ceremony rejection). A failed confirmation writes
 * nothing; the identity-layer action delivers the code (./functions.ts).
 */

import { normalizeEmail } from "../identity/userPolicy";
import {
  CODE_VALIDITY_MS,
  decideEmailChangeConfirm,
  decideEmailChangeRequest,
} from "./policy";
import { generateProofCode, sha256Hex } from "./codes";
import type { CoreResult, LinkingTx } from "./store";

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
