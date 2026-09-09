/**
 * Sign-in feature state (pure, unit-tested).
 *
 * The barebones screen walks an explicit state machine so every UI copy
 * string is a named constant (Polish product text, AGENTS.md) and no
 * internal error text can leak into the product: incoming errors map to
 * one of the honest user-facing messages.
 */

/** The named sign-in states (barebones, no visual design). */
export type SignInState =
  | { readonly step: "choose" }
  | { readonly step: "code-sent"; readonly email: string }
  | { readonly step: "submitting-email" }
  | { readonly step: "submitting-code" }
  | { readonly step: "google-pending" };

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

/** Simple e-mail shape check (the server re-validates everything). */
export function isValidEmail(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.trim());
}

/**
 * Maps a thrown sign-in error to a failure cause WITHOUT leaking the
 * message: only known markers are inspected, everything else is unknown.
 */
export function classifySignInError(error: unknown): SignInFailure {
  const message = error instanceof Error ? error.message : "";
  if (/Could not verify code|Invalid verification code/i.test(message)) {
    return "code_wrong_or_expired";
  }
  if (/Too many failed attempts/i.test(message)) {
    return "too_many_attempts";
  }
  if (/usługa poczty nie jest skonfigurowana|nie mogło wysłać wiadomości|Nie wiemy, czy wiadomość/i.test(message)) {
    return "email_delivery_failed";
  }
  if (/innej metody logowania/i.test(message)) {
    return "method_conflict";
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return "network";
  }
  return "unknown";
}
