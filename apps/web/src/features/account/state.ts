/**
 * Account feature state: the ceremony walkthrough, Polish copy and the
 * failure classification (B2).
 *
 * Every pending label and failure text renders from `accountCopy` keyed by
 * a named state — no ad-hoc strings in components. Server rejections
 * arrive with the `[kiero:link_rejected]` machine marker followed by
 * Polish prose; classification keys on the marker and the typed code map
 * mirrors the server vocabulary (pinned equal by tests/b2, which imports
 * both sides — the client cannot import server modules).
 */

/** The two sign-in methods, as the UI names them. */
export type LinkMethod = "google" | "email_code";

/** Which leg the active ceremony waits for (mirrors the server view). */
export type CeremonyLeg = "google_oauth" | "email_code";

/** The account screen's named states (barebones, no visual design). */
export type AccountState =
  | { readonly step: "idle" }
  | { readonly step: "sending-code"; readonly leg: CeremonyLeg }
  | { readonly step: "verifying-code"; readonly leg: CeremonyLeg }
  | { readonly step: "google-pending" }
  | { readonly step: "requesting-email-change" }
  | { readonly step: "confirming-email-change" };

/**
 * Machine markers OUR server-side errors prefix their message with. The
 * server literals are pinned equal to these by tests/b2.
 */
export const ACCOUNT_ERROR_MARKERS = {
  linkRejected: "[kiero:link_rejected]",
  emailDeliveryFailed: "[kiero:email_delivery_failed]",
} as const;

/** Machine-readable typed rejection codes (mirrors the server union). */
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

/** Polish copy for every state and rejection (stable product text). */
export const accountCopy = {
  title: "Konto",
  intro:
    "Metody logowania, adres e-mail i sesje urządzeń. Połączenie metod wymaga świeżego potwierdzenia obu stron.",
  methodsHeading: "Metody logowania",
  emailMethod: "Kod e-mail",
  googleMethod: "Google",
  methodAttached: "Przypisana",
  methodMissing: "Brak",
  addGoogle: "Dodaj Google",
  addEmailCode: "Dodaj kod e-mail",
  googleUnavailable: "Logowanie Google nie jest skonfigurowane na tym środowisku.",
  cancelCeremony: "Anuluj łączenie",
  ceremonyHeading: "Łączenie metod w toku",
  ceremonyFirstProofEmail: (email: string): string =>
    `Potwierdź najpierw obecną metodę: wyślemy kod na ${email}.`,
  ceremonyFirstProofGoogle: "Potwierdź najpierw obecną metodę: zaloguj się ponownie przez Google.",
  ceremonyTargetProofEmail: (email: string): string =>
    `Potwierdź nową metodę: wyślemy kod na ${email}.`,
  ceremonyTargetProofGoogle:
    "Potwierdź nową metodę: zaloguj się przez Google. Po powrocie metoda zostanie połączona.",
  sendCode: "Wyślij kod",
  resendCode: "Wyślij kod ponownie",
  codeLabel: "Kod z wiadomości",
  codePlaceholder: "8 cyfr",
  verifyCode: "Potwierdź kod",
  sending: "Wysyłamy kod…",
  verifying: "Sprawdzamy kod…",
  googlePending: "Przekierowujemy do Google…",
  linkedNotice: "Metody zostały połączone. Jedno konto, obie metody.",
  emailHeading: "Adres e-mail",
  emailChangeLabel: "Nowy adres e-mail",
  emailChangePlaceholder: "np. szef@nowafirma.pl",
  requestEmailChange: "Zmień adres e-mail",
  emailChangeCodeLabel: "Kod wysłany na nowy adres",
  confirmEmailChange: "Potwierdź nowy adres",
  emailChangeRequested: (email: string): string =>
    `Wysłaliśmy kod na ${email}. Jest ważny 15 minut.`,
  emailChanged: (email: string): string => `Adres zmieniony na ${email}.`,
  requestingChange: "Wysyłamy kod na nowy adres…",
  confirmingChange: "Sprawdzamy kod…",
  sessionsHeading: "Twoje urządzenia",
  revokeOtherSessions: "Wyloguj pozostałe urządzenia",
  revokedOtherSessions: (count: number): string =>
    `Wylogowano pozostałych urządzeń: ${count}.`,
  signOut: "Wyloguj się",
  signInFirst: "Najpierw się zaloguj, aby zarządzać kontem.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  failures: {
    method_already_attached: "Ta metoda logowania jest już przypisana do Twojego konta.",
    target_account_established:
      "Ta metoda należy już do innego konta Kiero. Połączenie dwóch istniejących kont wymaga odzyskania konta z pomocą obsługi.",
    ceremony_in_progress:
      "Trwa już inne łączenie metod dla tego adresu. Dokończ je albo je anuluj.",
    no_active_ceremony: "Nie ma aktywnej ceremonii łączenia. Zacznij łączenie od nowa.",
    proof_stale:
      "Potwierdzenie wygasło. Zacznij łączenie od nowa i potwierdź obie metody na świeżo.",
    mismatched_address: "Adresy się nie zgadzają. Obie metody muszą potwierdzić ten sam adres e-mail.",
    google_email_unproven:
      "Google nie potwierdza własności tego adresu e-mail. Użyj konta Google z zweryfikowanym adresem.",
    code_wrong_or_expired: "Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.",
    too_many_attempts: "Zbyt wiele próśb o kod na ten adres. Odczekaj kilka minut i spróbuj ponownie.",
    ambiguous_registry: "Stan kont jest niejednoznaczny. Skontaktuj się z obsługą, zanim połączysz metody.",
    email_delivery_failed: "Nie udało się wysłać wiadomości z kodem. Spróbuj ponownie za chwilę.",
    invalid_email: "Podaj poprawny adres e-mail.",
    network: "Brak połączenia. Sprawdź internet i spróbuj ponownie.",
    unknown: "Coś nie zadziałało. Spróbuj ponownie.",
  } as const satisfies Record<LinkRejectionCode | "email_delivery_failed" | "invalid_email" | "network" | "unknown", string>,
} as const;

/** The pending label for a state, or null when idle. */
export function accountPendingLabel(state: AccountState): string | null {
  switch (state.step) {
    case "sending-code":
      return accountCopy.sending;
    case "verifying-code":
      return accountCopy.verifying;
    case "google-pending":
      return accountCopy.googlePending;
    case "requesting-email-change":
      return accountCopy.requestingChange;
    case "confirming-email-change":
      return accountCopy.confirmingChange;
    default:
      return null;
  }
}

/** Simple e-mail shape check (the server re-validates everything). */
export function isValidEmail(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.trim());
}

/** What a thrown account error classifies to (marker-first, never prose). */
export function classifyAccountError(
  error: unknown,
): LinkRejectionCode | "email_delivery_failed" | "network" | "unknown" {
  const message = error instanceof Error ? error.message : "";
  if (message.includes(ACCOUNT_ERROR_MARKERS.emailDeliveryFailed)) {
    return "email_delivery_failed";
  }
  const markerAt = message.indexOf(ACCOUNT_ERROR_MARKERS.linkRejected);
  if (markerAt !== -1) {
    // The server appends `[code]` right after the marker; classify on the
    // code token, falling back to unknown for anything unmapped.
    const afterMarker = message.slice(markerAt + ACCOUNT_ERROR_MARKERS.linkRejected.length);
    const match = /^\[([a-z_]+)\]/.exec(afterMarker);
    const code = match?.[1];
    if (code !== undefined && code in accountCopy.failures) {
      return code as LinkRejectionCode;
    }
    return "unknown";
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return "network";
  }
  return "unknown";
}
