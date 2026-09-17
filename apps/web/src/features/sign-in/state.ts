/**
 * Sign-in feature state: the state machine the screen walks, its Polish
 * copy, and the failure classification.
 *
 * The screen's step is a `SignInState`; every pending/intermediate label
 * the component renders comes from `signInCopy` keyed by that state (no
 * ad-hoc strings in the component). Incoming errors map to honest
 * user-facing copy: our refusals are `ConvexError`s whose DATA carries a
 * closed-vocabulary code (convex/access/errorCodes.ts) that survives
 * production message sanitization — classification reads the decoded
 * data first. The message markers and library strings below remain only
 * as a FALLBACK for responses without data (older deploys, local
 * network errors). Nothing internal can leak: unknown errors classify as
 * `unknown` and show generic copy.
 */

import {
  decodeAccessRefusal,
  type AccessRefusalCode,
} from "../../../../../convex/access/errorCodes";

/** The named sign-in states (barebones, no visual design). */
export type SignInState =
  | { readonly step: "choose" }
  | { readonly step: "submitting-email" }
  | { readonly step: "code-sent"; readonly email: string }
  | { readonly step: "submitting-code"; readonly email: string }
  | { readonly step: "google-pending" };

/**
 * Machine markers OUR server-side errors keep in their message for logs.
 * Classification no longer keys on them (R26: the closed code rides the
 * ConvexError data); they stay matched only as the no-data fallback. The
 * server literals are pinned equal to these by tests/b1.
 */
export const OUR_ERROR_MARKERS = {
  emailDeliveryFailed: "[kiero:email_delivery_failed]",
  methodConflict: "[kiero:method_conflict]",
  issuanceRateLimited: "[kiero:issuance_rate_limited]",
} as const;

/** Machine-readable failure causes the UI can distinguish. */
export type SignInFailure =
  | "invalid_email"
  | "code_wrong_or_expired"
  | "too_many_attempts"
  | "email_delivery_failed"
  | "method_conflict"
  | "network"
  | "unknown";

/** Polish copy for every state and failure (stable product text). */
export const signInCopy = {
  title: "Zaloguj się do Kiero",
  intro: "Wybierz metodę logowania. Konto firmy jest przypisane do osoby, nie do adresu e-mail.",
  emailLabel: "Adres e-mail",
  emailPlaceholder: "np. szef@firma.pl",
  sendCode: "Wyślij kod",
  changeEmail: "Zmień adres",
  codeLabel: "Kod z wiadomości",
  codePlaceholder: "8 cyfr",
  verify: "Zaloguj się kodem",
  resendCode: "Wyślij kod ponownie",
  googleButton: "Zaloguj się przez Google",
  googleUnavailable: "Logowanie Google nie jest skonfigurowane na tym środowisku.",
  sending: "Wysyłamy kod…",
  verifying: "Sprawdzamy kod…",
  googlePending: "Przekierowujemy do Google…",
  codeSentNotice: (email: string): string => `Kod wysłaliśmy na ${email}. Jest ważny 15 minut.`,
  signOutEverywhere: "Wyloguj się",
  signedOutNotice: "Zostałeś wylogowany.",
  sessionEndedNotice: "Sesja tego urządzenia została zakończona. Zaloguj się ponownie.",
  sessionInactiveNotice: "Sesja wygasła po 30 dniach nieaktywności. Zaloguj się ponownie.",
  sessionRegistryPendingNotice: "Rejestrujemy sesję tego urządzenia. Odśwież aplikację.",
  signInAgain: "Zaloguj się ponownie",
  failures: {
    invalid_email: "Podaj poprawny adres e-mail.",
    code_wrong_or_expired: "Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.",
    too_many_attempts: "Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie.",
    email_delivery_failed: "Nie udało się wysłać wiadomości z kodem. Spróbuj ponownie za chwilę.",
    method_conflict:
      "Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; metody połączysz w ustawieniach konta, potwierdzając obie.",
    network: "Brak połączenia. Sprawdź internet i spróbuj ponownie.",
    unknown: "Coś nie zadziałało. Spróbuj ponownie.",
  } as const satisfies Record<SignInFailure, string>,
} as const;

/** The pending label for a state, or null when idle. */
export function pendingLabel(state: SignInState): string | null {
  switch (state.step) {
    case "submitting-email":
      return signInCopy.sending;
    case "submitting-code":
      return signInCopy.verifying;
    case "google-pending":
      return signInCopy.googlePending;
    default:
      return null;
  }
}

/** Machine-readable session-registry denial reasons (server contract). */
export type SessionDenialReason =
  | "no_identity"
  | "malformed_subject"
  | "subject_mismatch"
  | "auth_session_missing"
  | "auth_session_expired"
  | "registry_missing"
  | "revoked"
  | "inactive";

/** What the UI should do about a denied session. */
export interface SessionDeniedView {
  readonly notice: string;
  /** True when the only sensible next step is signing in again. */
  readonly requiresSignIn: boolean;
}

/**
 * Maps a registry denial reason to honest Polish copy. Expired, revoked
 * and signed-out-upstream sessions all end the device session: the client
 * must sign out (its token may still verify, but every protected read
 * will be denied).
 */
export function sessionDeniedView(reason: SessionDenialReason): SessionDeniedView {
  switch (reason) {
    case "auth_session_missing":
      return { notice: signInCopy.signedOutNotice, requiresSignIn: true };
    case "auth_session_expired":
    case "inactive":
      return { notice: signInCopy.sessionInactiveNotice, requiresSignIn: true };
    case "revoked":
      return { notice: signInCopy.sessionEndedNotice, requiresSignIn: true };
    case "registry_missing":
      return { notice: signInCopy.sessionRegistryPendingNotice, requiresSignIn: false };
    case "no_identity":
    case "malformed_subject":
    case "subject_mismatch":
      return { notice: signInCopy.failures.unknown, requiresSignIn: true };
  }
}

/** Simple e-mail shape check (the server re-validates everything). */
export function isValidEmail(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.trim());
}

/**
 * Which closed refusal codes this surface renders, mapped to its failure
 * names. Linking-layer codes (the account surface's domain) are
 * deliberately absent: reaching one here classifies as `unknown`
 * (fail-closed), never as the wrong sign-in copy.
 */
const REFUSAL_FAILURE_BY_CODE: Readonly<Partial<Record<AccessRefusalCode, SignInFailure>>> = {
  email_delivery_failed: "email_delivery_failed",
  issuance_rate_limited: "too_many_attempts",
  method_conflict: "method_conflict",
  code_wrong_or_expired: "code_wrong_or_expired",
  too_many_attempts: "too_many_attempts",
};

/**
 * Maps a thrown sign-in error to a failure cause WITHOUT leaking the
 * message: refusals carrying structured `ConvexError` data classify by
 * the decoded closed code (this path works on production deployments,
 * where messages are sanitized to "Server Error"). Only responses
 * WITHOUT data fall back to the marker/library message heuristics;
 * everything else is `unknown`.
 */
export function classifySignInError(error: unknown): SignInFailure {
  const refusal = decodeAccessRefusal(error);
  const byCode = refusal === null ? undefined : REFUSAL_FAILURE_BY_CODE[refusal];
  if (byCode !== undefined) {
    return byCode;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes(OUR_ERROR_MARKERS.emailDeliveryFailed)) {
    return "email_delivery_failed";
  }
  if (message.includes(OUR_ERROR_MARKERS.methodConflict)) {
    return "method_conflict";
  }
  if (message.includes(OUR_ERROR_MARKERS.issuanceRateLimited)) {
    return "too_many_attempts";
  }
  if (/Could not verify code|Invalid verification code/i.test(message)) {
    return "code_wrong_or_expired";
  }
  if (/Too many failed attempts/i.test(message)) {
    return "too_many_attempts";
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return "network";
  }
  return "unknown";
}
