/**
 * Calendar connection feature state (G1): Polish copy for the barebones
 * Kalendarz screen. Server results arrive as `ResultEnvelope`s; the copy
 * maps the typed connection status and its machine reasons to honest
 * product text. The screen itself owns no styling (the UX/UI track owns
 * presentation).
 */

/** Polish copy for the Calendar connection surface (stable product text). */
export const calendarCopy = {
  title: "Kalendarz Kiero w Google",
  intro:
    "Kalendarz jest osobisty i opcjonalny: pokazuje wybrane terminy firmy na Twoim koncie Google. Obowiązujące ustalenia zawsze pozostają w Kiero, a odłączenie kalendarza nie zmienia Twojego logowania.",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  noCompanyScope:
    "Nie należysz teraz do żadnej firmy, więc nie ma dla kogo połączyć kalendarza. Członkostwo w firmie można przyjąć na ekranie Firma.",
  providerNotConfigured:
    "To środowisko nie ma jeszcze danych klienta Google OAuth. Połączenie będzie możliwe po ich uzupełnieniu przez administratora Kiero.",
  // States
  statePending:
    "Połączenie kalendarza jest w toku. Dokończ zgodę w Google albo odłącz i zacznij od nowa (link wygasa po 10 minutach).",
  stateConnected: (email: string | null): string =>
    email === null
      ? "Kalendarz Kiero jest połączony z Twoim kontem Google."
      : `Kalendarz Kiero jest połączony z kontem ${email}.`,
  stateDisconnected: "Kalendarz nie jest połączony. Możesz go połączyć, kiedy zechcesz.",
  connectedAt: (ms: number): string =>
    `Połączono ${new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}.`,
  cleanupUnconfirmed:
    "Po odłączeniu Kiero nie potwierdziło jeszcze usunięcia swoich wpisów z kalendarza Google. Sprawdź kalendarz i usuń wpisy Kiero ręcznie, jeśli zostały.",
  lastContact: (ms: number): string =>
    `Ostatni udany kontakt z Google: ${new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}.`,
  // Error reasons (machine code -> honest Polish)
  reason: {
    authorization_denied: "Zgoda w Google nie została udzielona. Możesz spróbować ponownie.",
    authorization_expired: "Czas na dokończenie zgody upłynął. Rozpocznij połączenie od nowa.",
    exchange_failed: "Google odrzucił wymianę uprawnienia. Spróbuj połączyć kalendarz ponownie.",
    exchange_unknown:
      "Wynik wymiany z Google jest niepewny. Kiero nie powtarza jej automatycznie — spróbuj ponownie.",
    scopes_missing:
      "Zgoda nie obejmowała wymaganych uprawnień do kalendarza Kiero. Połącz ponownie i zostaw wymagane uprawnienia.",
    creation_failed: "Google odmówił utworzenia kalendarza Kiero. Spróbuj ponownie.",
    creation_unknown:
      "Kalendarz mógł zostać utworzony, ale odpowiedź Google nie dotarła. Kiero nie utworzy drugiego kalendarza automatycznie.",
    calendar_read_unknown:
      "Stan kalendarza w Google jest niepewny. Kiero nie utworzy drugiego kalendarza automatycznie.",
    calendar_access_lost:
      "Zapisany kalendarz Kiero jest niedostępny (mógł zostać usunięty). Jeśli na pewno go usunąłeś, użyj opcji Odtwórz kalendarz.",
    refresh_failed:
      "Google cofnął dostęp do kalendarza (to zdarza się w konfiguracji testowej po tygodniu). Połącz kalendarz ponownie.",
    membership_lost:
      "Członkostwo w firmie zostało cofnięte, więc połączenie kalendarza zostało zatrzymane.",
  } as const,
  unknownReason: "Połączenie kalendarza zostało zatrzymane z nieokreślonego powodu.",
  // Controls (rendered from the server's availableActions)
  connect: "Połącz kalendarz",
  reconnect: "Połącz ponownie",
  switchAccount: "Zmień konto Google",
  recreate: "Odtwórz kalendarz",
  disconnect: "Odłącz",
  disconnectConfirm:
    "Odłączyć kalendarz? Kiero przestanie natychmiast publikować nowe terminy; Twoje logowanie do Kiero nie zmieni się.",
  // The explicit acknowledgement after an unknown creation outcome
  creationAcknowledgement:
    "Rozumiem, że kalendarz Kiero mógł już zostać utworzony na moim koncie Google, i chcę spróbować ponownie.",
  // Notices
  redirecting: "Otwieramy zgodę w Google…",
  disconnecting: "Odłączamy…",
  disconnectedNotice: "Kalendarz został odłączony. Logowanie do Kiero pozostaje bez zmian.",
  unexpectedFailure: "Chwilowy błąd po stronie Kiero. Spróbuj ponownie za chwilę.",
} as const;

/** Honest Polish text for one machine reconnect reason. */
export function reasonText(reason: string | null): string {
  if (reason === null) {
    return calendarCopy.unknownReason;
  }
  const known = (calendarCopy.reason as Record<string, string>)[reason];
  return known ?? calendarCopy.unknownReason;
}
