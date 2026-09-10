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
  dedicatedCalendar:
    "Kiero zapisuje terminy w osobnym kalendarzu na Twoim koncie Google; Twój główny kalendarz pozostaje niezmieniony.",
  stateDisconnected: "Kalendarz nie jest połączony. Możesz go połączyć, kiedy zechcesz.",
  connectedAt: (ms: number): string =>
    `Połączono ${new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}.`,
  cleanupUnconfirmed:
    "Po odłączeniu Kiero nie potwierdziło jeszcze usunięcia swoich wpisów z kalendarza Google. Sprawdź kalendarz i usuń wpisy Kiero ręcznie, jeśli zostały.",
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

// ---------------------------------------------------------------------------
// Settings and sync diagnostics (G4): the copy and honest state mapping for
// G3's syncOverview and G2's projectionOverview. The views below are the
// structural mirrors of those query returns (the lane owns no backend files).
// ---------------------------------------------------------------------------

/** The G3 syncOverview rows the settings surface consumes (structural mirror). */
export interface SyncOverviewView {
  readonly state: string;
  readonly reconnectNeeded: boolean;
  readonly reconnectReason: string | null;
  readonly cleanupRemains: boolean;
  readonly copies: {
    readonly total: number;
    readonly confirmed: number;
    readonly pending: number;
    readonly absentWhileProjected: number;
  };
  readonly attempts: {
    readonly recorded: number;
    readonly uncertain: number;
    readonly failed: number;
  };
  readonly lastConfirmedAtMs: number | null;
}

/** One G2 projectionOverview copy row the settings surface consumes. */
export interface CopyRowView {
  readonly copyId: string;
  readonly subjectKind: "task" | "event";
  readonly subjectId: string | null;
  readonly desiredState: "projected" | "withdrawn";
  readonly summary: string | null;
  readonly hidden: boolean;
  readonly remoteOutcome: "confirmed" | "absent" | "unknown";
}

/**
 * The boss's effective project selection (G5): the stored calendarSyncState
 * column when present, the all-projects default otherwise. An explicit
 * selection always carries a (possibly empty) list.
 */
export interface SelectionView {
  readonly mode: "all_projects" | "explicit";
  readonly projectIds: readonly string[] | null;
}

/** The G2 projectionOverview shape the settings surface consumes. */
export interface ProjectionOverviewView {
  readonly state: string;
  /** Null on the lean branches: no own connection means no scope to read. */
  readonly selection: SelectionView | null;
  readonly copies: readonly CopyRowView[];
  readonly sync: {
    readonly state: "idle" | "syncing" | "needs_reconcile";
    readonly suspendedReason: string | null;
    readonly lastPassAtMs: number | null;
    readonly lastSyncedAtMs: number | null;
  } | null;
}

/** Polish copy for the settings and diagnostics surface (stable product text). */
export const settingsCopy = {
  settingsHeading: "Stan synchronizacji",
  settingsIntro:
    "Synchronizacja działa w jedną stronę: z Kiero do Google. Obowiązujące ustalenia zawsze pozostają w Kiero, a zmiany wykonane w Google nie zmieniają ustaleń firmy.",
  neverSynced: "Kiero nie zapisało jeszcze żadnego terminu w Google.",
  lastSyncedAt: (ms: number): string =>
    `Ostatnia udana synchronizacja: ${new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}.`,
  // The ONLY success sentence; shown solely when nothing pends, fails or stays unknown.
  allConfirmed: "Wszystkie terminy są potwierdzone w Google.",
  noCopiesYet: "Nie ma jeszcze terminów do pokazania w kalendarzu.",
  pendingCopies: (n: number): string =>
    `Oczekujące na potwierdzenie: ${n} — Kiero jeszcze nie wie, czy Google zapisało te terminy.`,
  uncertainAttempts: (n: number): string =>
    `Próby o niepewnym wyniku: ${n} — Kiero nie zakłada sukcesu ani porażki i nie powtarza ich automatycznie.`,
  failedAttempts: (n: number): string => `Nieudane próby zapisu: ${n}.`,
  absentCopies: (n: number): string => `Terminy, których brakuje w Google: ${n} — sprawdź je na liście poniżej.`,
  suspendedLine: (reason: string | null): string =>
    reason === "calendar_access_lost"
      ? "Kalendarz Kiero w Google stał się niedostępny — sprawdź, czy go nie usunięto, i w razie potrzeby odtwórz."
      : "Ostatnie przejście synchronizacji zostało wstrzymane; Kiero nie zapisuje teraz nic w Google.",
  reconnectPointer: "Aby wznowić synchronizację, wróć do sekcji połączenia powyżej i użyj przycisku „Połącz ponownie”.",
  cleanupResidueNote:
    "Po odłączeniu Kiero nie potwierdziło jeszcze usunięcia swoich wpisów z kalendarza Google. Sprawdź kalendarz i usuń wpisy Kiero ręcznie, jeśli zostały.",
  // Personal project scope (G5: the certified calendar.setSelection write
  // exists, so the honest not-yet-available notice is gone and the editor
  // copy below took its place: the flagged G4-file amendment of issue #107)
  scopeHeading: "Wybrane projekty",
  scopeIntro:
    "Wybór projektów jest osobisty: decyduje, które terminy firmy trafiają do Twojego kalendarza, i nie zmienia faktów firmy ani wyciszenia powiadomień innych szefów.",
  scopeEditMode: "Wybierz, których projektów terminy mają trafiać do Twojego kalendarza.",
  scopeModeAll: "Wszystkie projekty firmy",
  scopeModeExplicit: "Tylko wybrane projekty",
  scopeCount: (n: number): string => `Liczba wybranych projektów: ${n}.`,
  scopeExplicitEmpty:
    "Nie wybrano żadnego projektu: kalendarz przestanie pokazywać terminy, dopóki nie wybierzesz choć jednego projektu.",
  scopeSave: "Zapisz wybór projektów",
  scopeSaved:
    "Wybór projektów zapisany. Kalendarz uwzględni go podczas najbliższej synchronizacji.",
  scopeProjectNotFound:
    "Nie znaleziono jednego z projektów. Odśwież stronę i spróbuj ponownie.",
  scopeNextSyncNote:
    "Zapisany wybór zadziała podczas najbliższej synchronizacji kalendarza.",
  personalFieldsNote:
    "Twoje osobiste ustawienia wpisów w Google — przypomnienia, kolory, notatki — pozostają Twoje i Kiero ich nie nadpisuje.",
  // Copies list
  copiesHeading: "Kopie kalendarzowe",
  copiesIntro:
    "Poniżej Twoje kopie kalendarzowe wraz ze stanem zapisu w Google. Ukrycie jest osobiste: nie anuluje zadania ani zdarzenia i nie dotyczy innych szefów.",
  subjectLabel: { task: "Zadanie", event: "Zdarzenie" } as const,
  copyFallbackSummary: "Termin bez tytułu",
  copyState: {
    confirmed: "Zapisana w Google.",
    unknown: "Zapis niepotwierdzony — Kiero czeka na odpowiedź Google.",
    absent: "Brak wpisu w Google — do sprawdzenia.",
    hidden: "Ukryta osobiście — nie pokazuje się w Twoim Google.",
    withdrawn: "Wycofana z kalendarza.",
  } as const,
  openSubject: { task: "Otwórz zadanie w Kiero", event: "Otwórz zdarzenie w Kiero" } as const,
  // Copy actions
  hideCopy: "Ukryj osobiście",
  restoreCopy: "Przywróć w kalendarzu",
  checkCopy: "Sprawdź teraz",
  checkNowHint:
    "Są terminy wymagające doprowadzenia do porządku: użyj przycisku „Sprawdź teraz” przy terminach poniżej.",
  actionsUnavailableNote:
    "Działania na kopiach są teraz niedostępne, bo kalendarz nie jest połączony. Połącz kalendarz ponownie, żeby nimi zarządzać.",
  hideDone: "Kopia ukryta. Zadanie lub zdarzenie w Kiero pozostaje bez zmian.",
  restoreDone: "Kopia przywrócona. Kiero zapisze ją w Google podczas najbliższej synchronizacji.",
  checkQueued: "Sprawdzenie rozpoczęte. Stan zapisu zaktualizuje się po odpowiedzi Google.",
  checkConfirmed: "Kiero potwierdziło zapis tego terminu w Google.",
  copyNotFound: "Nie znaleziono tej kopii — odśwież stronę.",
  checkUnavailable: "Sprawdzenie nie jest teraz możliwe — kalendarz nie jest połączony.",
  unexpectedFailure: "Chwilowy błąd po stronie Kiero. Spróbuj ponownie za chwilę.",
  networkFailure: "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.",
} as const;

/** One rendered status line with its honest ARIA role. */
export interface StatusLine {
  readonly role: "status" | "alert";
  readonly text: string;
}

/**
 * The honest diagnostics lines for one syncOverview: alerts first (stopped
 * work), then uncertainties, then the ONLY success sentence — shown solely
 * when nothing pends, fails or stays unknown (never success over pending
 * work, the issue's third acceptance rule).
 */
export function syncStatusLines(overview: SyncOverviewView): readonly StatusLine[] {
  if (overview.reconnectNeeded) {
    // The recovery POINTER lives with the next-actions copy (the section
    // renders it from syncNextActions); the alert states WHY work stopped.
    return [{ role: "alert", text: reasonText(overview.reconnectReason) }];
  }
  const lines: StatusLine[] = [];
  if (overview.copies.pending > 0) {
    lines.push({ role: "status", text: settingsCopy.pendingCopies(overview.copies.pending) });
  }
  if (overview.attempts.uncertain > 0) {
    lines.push({ role: "status", text: settingsCopy.uncertainAttempts(overview.attempts.uncertain) });
  }
  if (overview.attempts.failed > 0) {
    lines.push({ role: "alert", text: settingsCopy.failedAttempts(overview.attempts.failed) });
  }
  if (overview.copies.absentWhileProjected > 0) {
    lines.push({
      role: "alert",
      text: settingsCopy.absentCopies(overview.copies.absentWhileProjected),
    });
  }
  if (lines.length === 0) {
    return overview.copies.total === 0
      ? [{ role: "status", text: settingsCopy.noCopiesYet }]
      : [{ role: "status", text: settingsCopy.allConfirmed }];
  }
  return lines;
}

/** The next actions recovery offers for one syncOverview (honest, bounded). */
export type SyncNextAction = "reconnect" | "check_now" | "check_google_manually";

/**
 * The recovery copy per action: one total map the compiler enforces, so a
 * future fourth action cannot silently render a wrong note.
 */
export const syncNextActionCopy: Record<SyncNextAction, { readonly role: "status" | "note"; readonly text: string }> = {
  reconnect: { role: "status", text: settingsCopy.reconnectPointer },
  check_now: { role: "status", text: settingsCopy.checkNowHint },
  check_google_manually: { role: "note", text: settingsCopy.cleanupResidueNote },
};

/** Which recoveries the overview honestly offers (never a blind recreate). */
export function syncNextActions(overview: SyncOverviewView): readonly SyncNextAction[] {
  const actions: SyncNextAction[] = [];
  if (overview.reconnectNeeded) {
    actions.push("reconnect");
  }
  if (overview.copies.pending > 0 || overview.copies.absentWhileProjected > 0) {
    actions.push("check_now");
  }
  if (overview.cleanupRemains) {
    actions.push("check_google_manually");
  }
  return actions;
}

/** The honest one-line state of one copy (hide first: the personal decision). */
export function copyStatusLabel(copy: CopyRowView): string {
  if (copy.hidden) {
    return settingsCopy.copyState.hidden;
  }
  if (copy.desiredState === "withdrawn") {
    return settingsCopy.copyState.withdrawn;
  }
  return settingsCopy.copyState[copy.remoteOutcome];
}

/**
 * The deep link into the current Kiero task/event route — the SAME route
 * contract the managed Google copies carry (packages/domain/calendar
 * subjectLinkPath): `/co-teraz?zadanie=<id>` or `?zdarzenie=<id>`.
 */
export function subjectHref(subjectKind: "task" | "event", subjectId: string): string {
  return subjectKind === "task"
    ? `/co-teraz?zadanie=${encodeURIComponent(subjectId)}`
    : `/co-teraz?zdarzenie=${encodeURIComponent(subjectId)}`;
}

/** Honest Polish text for one dispatch failure code (the copy commands). */
export function commandFailureHint(code: string): string {
  if (code === "not_found") {
    return settingsCopy.copyNotFound;
  }
  if (code === "unavailable") {
    return settingsCopy.checkUnavailable;
  }
  return settingsCopy.unexpectedFailure;
}
