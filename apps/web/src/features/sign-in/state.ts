/**
 * Sign-in feature state: the state machine the screen walks, its Polish
 * copy, and the failure classification.
 *
 * The screen's step is a `SignInState`; every pending/intermediate label
 * the component renders comes from `signInCopy` keyed by that state (no
 * ad-hoc strings in the component). Incoming errors map to honest
 * user-facing copy: OUR thrown errors carry a stable machine marker
 * (`[kiero:…]`) that classification keys on; library errors stay matched
 * by their stable upstream messages. Nothing internal can leak: unknown
 * errors classify as `unknown` and show generic copy.
 */

/** The named sign-in states (barebones, no visual design). */
export type SignInState =
  | { readonly step: "choose" }
  | { readonly step: "submitting-email" }
  | { readonly step: "code-sent"; readonly email: string }
  | { readonly step: "submitting-code"; readonly email: string }
  | { readonly step: "google-pending" };

/**
 * Machine markers OUR server-side errors prefix their message with.
 * The server literals are pinned equal to these by tests/b1 (the client
 * cannot import server modules; the test can import both sides).
 */
export const OUR_ERROR_MARKERS = {
  emailDeliveryFailed: "[kiero:email_delivery_failed]",
  methodConflict: "[kiero:method_conflict]",
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
  failures: {
    invalid_email: "Podaj poprawny adres e-mail.",
    code_wrong_or_expired: "Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.",
    too_many_attempts: "Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie.",
    email_delivery_failed: "Nie udało się wysłać wiadomości z kodem. Spróbuj ponownie za chwilę.",
    method_conflict:
      "Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; łączenie metod będzie dostępne później.",
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

/** Simple e-mail shape check (the server re-validates everything). */
export function isValidEmail(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.trim());
}

/**
 * Maps a thrown sign-in error to a failure cause WITHOUT leaking the
 * message: our own errors are recognized by their machine marker;
 * upstream library errors by their stable messages; everything else is
 * `unknown`.
 */
export function classifySignInError(error: unknown): SignInFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes(OUR_ERROR_MARKERS.emailDeliveryFailed)) {
    return "email_delivery_failed";
  }
  if (message.includes(OUR_ERROR_MARKERS.methodConflict)) {
    return "method_conflict";
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
