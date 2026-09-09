/**
 * The verified-linking policy: pure decisions over ceremony views (B2).
 *
 * The product rule (issue #21, docs/research/auth-identity-facts.md):
 * matching email text is NEVER proof that two identities belong to one
 * person. A link commits only when BOTH methods carry a FRESH proof inside
 * ONE ceremony, and every rejection is a typed machine code (the UI and
 * the tests key on codes, never prose).
 *
 * Both directions ("an email-code person adding Google, a Google person
 * adding email-code") share one shape:
 *
 * - the ceremony starts from a live session and targets the account's
 *   canonical address (`email`) — the ONE address both methods must prove;
 * - the initiating method is re-proven fresh first (a code to the address,
 *   or a Google re-authentication);
 * - the target method proof must carry the SAME address: the Google
 *   profile's address claim must match AND be one Google is authoritative
 *   for (@gmail.com, or verified with a Workspace `hd` — the research
 *   note's two cases); an email-code proof is the code we sent there;
 * - a proof is fresh for LINKING_PROOF_FRESHNESS_MS and the whole
 *   ceremony must finish inside LINKING_WINDOW_MS;
 * - a link that would merge two established accounts (the target method's
 *   credential already belongs to another user row) is rejected: there is
 *   no supported resolution in B2 (GM-assisted recovery is B4's).
 *
 * The decision halves are pure and unit-tested (tests/b2); the Convex
 * db-halves in ./cores.ts are thin adapters over fake-able surfaces.
 */

import { Schema } from "effect";
import { normalizeEmail } from "../identity/userPolicy";

/** The whole ceremony (both proofs and the commit) fits in this window. */
export const LINKING_WINDOW_MS = 15 * 60 * 1000;
/** A method proof stays fresh for this long inside the ceremony. */
export const LINKING_PROOF_FRESHNESS_MS = 15 * 60 * 1000;
/** "Recent authentication" for sensitive self-service operations. */
export const RECENT_AUTH_MS = 15 * 60 * 1000;
/** One-time codes (linking proofs, email change) are valid this long. */
export const CODE_VALIDITY_MS = 15 * 60 * 1000;

/** Machine-readable typed rejection codes (one vocabulary for all lanes). */
export type LinkRejectionCode =
  | "method_already_attached"
  | "target_account_established"
  | "ceremony_in_progress"
  | "no_active_ceremony"
  | "proof_stale"
  | "mismatched_address"
  | "google_email_unproven"
  | "code_wrong_or_expired"
  | "too_many_attempts"
  | "ambiguous_registry";

/** The canonical decoded form of Google's raw OAuth id-token payload. */
export const GoogleLinkProfile = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  email_verified: Schema.optional(Schema.Boolean),
  hd: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
export type GoogleLinkProfile = Schema.Schema.Type<typeof GoogleLinkProfile>;

/** Decodes Google's raw profile; null for any malformed payload. */
export function decodeGoogleLinkProfile(
  raw: Record<string, unknown>,
): GoogleLinkProfile | null {
  const decoded = Schema.decodeUnknownOption(GoogleLinkProfile)(raw);
  return decoded._tag === "Some" ? decoded.value : null;
}

/**
 * Whether Google is AUTHORITATIVE for the profile's address claim: the two
 * documented cases (gmail host, or verified with a Workspace `hd`). For
 * anything else Google verified its own account at creation time but not
 * the external mailbox — the claim must not drive a link commit.
 */
export function googleAuthoritativeForEmail(profile: GoogleLinkProfile): boolean {
  const email = normalizeEmail(profile.email);
  if (email.endsWith("@gmail.com")) {
    return true;
  }
  return profile.email_verified === true && profile.hd !== undefined;
}

/** The read view of one ceremony row the decisions consume. */
export interface AttemptView {
  readonly userId: string;
  readonly email: string;
  readonly targetMethod: "google" | "email_code";
  readonly state:
    | "awaiting_first_proof"
    | "awaiting_target_proof"
    | "committed"
    | "rejected";
  readonly expiresAtMs: number;
  readonly firstProofAtMs: number | null;
}

/** The read view of one user row the decisions consume. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly googleSubject: string | null;
}

/** A proof is fresh when recorded inside the freshness window and the ceremony has not expired. */
export function proofFresh(
  proofAtMs: number | null,
  nowMs: number,
  expiresAtMs: number,
): boolean {
  if (proofAtMs === null) {
    return false;
  }
  return nowMs - proofAtMs <= LINKING_PROOF_FRESHNESS_MS && nowMs <= expiresAtMs;
}

/** A ceremony is active when non-terminal and not past its window. */
export function attemptActive(attempt: AttemptView, nowMs: number): boolean {
  return (
    (attempt.state === "awaiting_first_proof" ||
      attempt.state === "awaiting_target_proof") &&
    nowMs <= attempt.expiresAtMs
  );
}

/** Why a begin was refused; begin either proceeds or states its typed reason. */
export type BeginDecision =
  | { readonly action: "begin" }
  | { readonly action: "reject"; readonly reason: LinkRejectionCode };

/**
 * Decides whether a live session's account may open a ceremony attaching
 * `targetMethod`. The account must not already carry the method, the
 * method's credential must not belong to another established account, and
 * no other active ceremony may exist for the same canonical address.
 *
 * `targetCredentialOwner` is the owner of the target method's existing
 * credential, when one is discoverable at begin time: for email-code that
 * is the provider account at the canonical address; for Google nothing is
 * discoverable yet (the subject arrives with the proof) and null is
 * passed — the commit decision re-checks establishment anyway.
 */
export function decideBeginLinking(args: {
  account: AccountView;
  targetMethod: "google" | "email_code";
  targetCredentialOwner: string | null;
  /** Every non-terminal ceremony row at the account's canonical address. */
  activeAttemptsAtEmail: readonly AttemptView[];
  nowMs: number;
}): BeginDecision {
  const { account, targetMethod } = args;
  if (targetMethod === "google") {
    if (account.googleSubject !== null) {
      return { action: "reject", reason: "method_already_attached" };
    }
  } else {
    // An email-code credential for the address exists. If it is the
    // actor's own, the method is already attached; if it belongs to
    // another person, attaching it here would merge two established
    // accounts without a supported resolution.
    if (args.targetCredentialOwner === account.id) {
      return { action: "reject", reason: "method_already_attached" };
    }
    if (args.targetCredentialOwner !== null) {
      return { action: "reject", reason: "target_account_established" };
    }
  }
  if (args.activeAttemptsAtEmail.some((attempt) => attemptActive(attempt, args.nowMs))) {
    return { action: "reject", reason: "ceremony_in_progress" };
  }
  return { action: "begin" };
}

/** The google-direction commit decision (target proof arrives by OAuth). */
export type GoogleLinkDecision =
  | { readonly action: "commit"; readonly userId: string; readonly googleSub: string }
  | { readonly action: "reject"; readonly reason: LinkRejectionCode };

/**
 * Decides the Google OAuth callback that arrives while the address's
 * email-code account would collide (B1's `method_conflict` path). The
 * commit requires: exactly one user row at the profile's address (the
 * ceremony owner, without a Google subject), exactly one active ceremony
 * for that address targeting Google with a fresh first proof, the profile
 * address matching the ceremony's canonical address, Google authoritative
 * for the claim, and the Google subject not established anywhere.
 */
export function decideGoogleCallbackLink(args: {
  profile: GoogleLinkProfile;
  /** User rows at the profile's normalized address (B1's conflict lookup). */
  usersWithEmail: readonly AccountView[];
  /** Non-terminal ceremonies at the profile's normalized address. */
  attemptsAtEmail: readonly AttemptView[];
  /** Owner of a provider account for this Google subject, if any. */
  googleSubCredentialOwner: string | null;
  /** Any user row already carrying this Google subject. */
  usersWithGoogleSub: readonly string[];
  nowMs: number;
}): GoogleLinkDecision {
  const normalized = normalizeEmail(args.profile.email);
  if (args.usersWithEmail.length !== 1) {
    // Zero rows never reaches the conflict path; two or more is a broken
    // registry state. Both refuse to link.
    return { action: "reject", reason: "ambiguous_registry" };
  }
  const account = args.usersWithEmail[0];
  if (account === undefined || account.googleSubject !== null) {
    return { action: "reject", reason: "method_already_attached" };
  }
  if (!googleAuthoritativeForEmail(args.profile)) {
    return { action: "reject", reason: "google_email_unproven" };
  }
  if (args.googleSubCredentialOwner !== null || args.usersWithGoogleSub.length > 0) {
    return { action: "reject", reason: "target_account_established" };
  }
  const candidates = args.attemptsAtEmail.filter(
    (attempt) =>
      attempt.targetMethod === "google" &&
      attempt.state === "awaiting_target_proof" &&
      attempt.userId === account.id,
  );
  if (candidates.length !== 1) {
    return candidates.length === 0
      ? { action: "reject", reason: "no_active_ceremony" }
      : { action: "reject", reason: "ambiguous_registry" };
  }
  const attempt = candidates[0];
  if (attempt === undefined) {
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (attempt.email !== normalized) {
    return { action: "reject", reason: "mismatched_address" };
  }
  if (!proofFresh(attempt.firstProofAtMs, args.nowMs, attempt.expiresAtMs)) {
    return { action: "reject", reason: "proof_stale" };
  }
  return { action: "commit", userId: account.id, googleSub: args.profile.sub };
}

/** The email-direction commit decision (target proof is our mailed code). */
export type EmailLinkDecision =
  | { readonly action: "commit" }
  | { readonly action: "reject"; readonly reason: LinkRejectionCode };

/**
 * Decides the confirmation of an email-direction ceremony (a Google person
 * attaching email-code). Requires the ceremony to await its target proof
 * with a fresh Google first proof, the provided code to hash-match the
 * pending unexpired code, and the address's email-code credential to be
 * unclaimed (a second established account refuses the merge).
 */
export function decideConfirmEmailLink(args: {
  attempt: AttemptView & { readonly pendingCodeExpiresAtMs: number | null };
  account: AccountView;
  providedCodeHash: string;
  pendingCodeHash: string | null;
  /** Owner of the email-code credential for the ceremony address, if any. */
  emailCredentialOwner: string | null;
  nowMs: number;
}): EmailLinkDecision {
  if (args.attempt.userId !== args.account.id) {
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (args.attempt.state !== "awaiting_target_proof") {
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (
    args.attempt.targetMethod !== "email_code" ||
    args.account.googleSubject === null
  ) {
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (!proofFresh(args.attempt.firstProofAtMs, args.nowMs, args.attempt.expiresAtMs)) {
    return { action: "reject", reason: "proof_stale" };
  }
  if (
    args.pendingCodeHash === null ||
    args.attempt.pendingCodeExpiresAtMs === null ||
    args.providedCodeHash !== args.pendingCodeHash ||
    args.nowMs > args.attempt.pendingCodeExpiresAtMs
  ) {
    return { action: "reject", reason: "code_wrong_or_expired" };
  }
  if (args.emailCredentialOwner !== null) {
    return { action: "reject", reason: "target_account_established" };
  }
  return { action: "commit" };
}

/** The email-change request decision ("recent authentication" gate). */
export type EmailChangeRequestDecision =
  | { readonly action: "request" }
  | { readonly action: "reject"; readonly reason: LinkRejectionCode };

/**
 * Decides whether a pending email change may be requested: the device
 * session must have started within RECENT_AUTH_MS (fresh provider
 * sign-in), the new address must differ from the canonical one, be
 * well-formed, and no other pending request may exist for the user.
 */
export function decideEmailChangeRequest(args: {
  account: AccountView;
  newEmail: string;
  sessionStartedAtMs: number;
  pendingRequestExists: boolean;
  nowMs: number;
}): EmailChangeRequestDecision {
  const normalized = normalizeEmail(args.newEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { action: "reject", reason: "mismatched_address" };
  }
  if (normalized === normalizeEmail(args.account.email)) {
    return { action: "reject", reason: "mismatched_address" };
  }
  if (args.nowMs - args.sessionStartedAtMs > RECENT_AUTH_MS) {
    return { action: "reject", reason: "proof_stale" };
  }
  if (args.pendingRequestExists) {
    return { action: "reject", reason: "ceremony_in_progress" };
  }
  return { action: "request" };
}

/** The email-change confirmation decision (the code to the NEW address). */
export type EmailChangeConfirmDecision =
  | { readonly action: "commit" }
  | { readonly action: "reject"; readonly reason: LinkRejectionCode };

export function decideEmailChangeConfirm(args: {
  account: AccountView;
  request: {
    readonly newEmail: string;
    readonly codeHash: string;
    readonly expiresAtMs: number;
    readonly confirmedAtMs: number | null;
  } | null;
  providedCodeHash: string;
  nowMs: number;
}): EmailChangeConfirmDecision {
  if (args.request === null || args.request.confirmedAtMs !== null) {
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (normalizeEmail(args.account.email) === normalizeEmail(args.request.newEmail)) {
    // Already moved (idempotent redelivery of a completed change).
    return { action: "reject", reason: "no_active_ceremony" };
  }
  if (args.providedCodeHash !== args.request.codeHash || args.nowMs > args.request.expiresAtMs) {
    return { action: "reject", reason: "code_wrong_or_expired" };
  }
  return { action: "commit" };
}

/** Maps a rejection code to honest Polish copy (barebones product text). */
export const linkingRejectionCopy: Readonly<Record<LinkRejectionCode, string>> = {
  method_already_attached:
    "Ta metoda logowania jest już przypisana do Twojego konta.",
  target_account_established:
    "Ta metoda należy już do innego konta Kiero. Połączenie dwóch istniejących kont wymaga odzyskania konta z pomocą obsługi.",
  ceremony_in_progress:
    "Trwa już inne łączenie metod dla tego adresu. Dokończ je albo je anuluj.",
  no_active_ceremony:
    "Nie ma aktywnej ceremonii łączenia. Zacznij łączenie od nowa.",
  proof_stale:
    "Potwierdzenie wygasło. Zacznij łączenie od nowa i potwierdź obie metody na świeżo.",
  mismatched_address:
    "Adresy się nie zgadzają. Obie metody muszą potwierdzić ten sam adres e-mail.",
  google_email_unproven:
    "Google nie potwierdza własności tego adresu e-mail. Użyj konta Google z zweryfikowanym adresem.",
  code_wrong_or_expired:
    "Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.",
  too_many_attempts:
    "Zbyt wiele próśb o kod na ten adres. Odczekaj kilka minut i spróbuj ponownie.",
  ambiguous_registry:
    "Stan kont jest niejednoznaczny. Skontaktuj się z obsługą, zanim połączysz metody.",
};

/**
 * Machine marker prefixing linking errors thrown over the identity-layer
 * surface, so client classification keys on it instead of Polish prose
 * (twin literal pinned by tests/b2).
 */
export const LINK_REJECTED_MARKER = "[kiero:link_rejected]";
