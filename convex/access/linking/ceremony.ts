/**
 * The linking-ceremony core (B2): begin, staged proof codes, leg
 * verification, the two auth-callback resolutions and cancellation.
 *
 * The product rules live in ./policy.ts (pure); these db-halves run over
 * the snapshot surfaces from ./store.ts. Concurrency: every commit both
 * READS and WRITES the same ceremony row (state transition + account
 * effect in one transaction), and begin reads the by-email index range it
 * inserts into — concurrent attempts on one address serialize through
 * Convex optimistic concurrency; a loser retries, observes the committed
 * state, and returns a typed rejection, never a second link.
 */

import { normalizeEmail } from "../identity/userPolicy";
import {
  CODE_VALIDITY_MS,
  LINKING_WINDOW_MS,
  decodeGoogleLinkProfile,
  decideBeginLinking,
  decideConfirmEmailLink,
  decideGoogleCallbackLink,
  type GoogleLinkProfile,
  type LinkRejectionCode,
} from "./policy";
import { generateProofCode, sha256Hex } from "./codes";
import {
  attemptViewOf,
  type AttemptSnapshot,
  type CoreResult,
  type GoogleHookStore,
  type LinkingStore,
  type LinkingTx,
} from "./store";

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

/** What the account screen shows about linking state. */
export interface LinkingStatusView {
  readonly email: string;
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
  args: { userId: string; nowMs: number },
): Promise<LinkingStatusView | null> {
  const account = await store.userById(args.userId);
  if (account === null) {
    return null;
  }
  const attempt = await store.activeAttemptByUser(args.userId, args.nowMs);
  const emailCodeLinked = await store.hasEmailCodeCredential(args.userId);
  return {
    email: account.email,
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
