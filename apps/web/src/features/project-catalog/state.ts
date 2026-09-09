/**
 * Project catalog feature state: Polish copy, the stage/role vocabularies
 * rendered for product text, and the closed-error classification for the
 * C1 surface.
 *
 * The stage, contact-kind and contact-role labels come from the pure domain
 * rules (`packages/domain/projects`) through one relative import: the Polish
 * rendering of the fixed vocabulary has exactly one source, shared with the
 * backend lanes that consume the same module. Operation results arrive as
 * `ResultEnvelope`s; every closed error maps to the server's Polish message
 * plus hints for load-bearing machine codes.
 */

import {
  CONTACT_KIND_LABELS,
  CONTACT_ROLE_LABELS,
  PROJECT_STAGE_LABELS,
} from "../../../../../packages/domain/projects/index";
import { signInCopy } from "../sign-in/state";

export { signInCopy };

/** The fixed stage vocabulary rendered in Polish (one source: the domain rules). */
export const stageLabels = PROJECT_STAGE_LABELS;

/** Contact kinds rendered in Polish. */
export const contactKindLabels = CONTACT_KIND_LABELS;

/** Contact roles rendered in Polish. */
export const contactRoleLabels = CONTACT_ROLE_LABELS;

/** The stages a boss may command for a new or existing project, in order. */
export const stageOrder = [
  "inquiry",
  "offer_preparation",
  "awaiting_decision",
  "agreed",
  "in_progress",
  "completed",
  "cancelled",
] as const;

/** Polish copy for the project catalog surface (stable product text). */
export const catalogCopy = {
  title: "Projekty",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  sessionEndedNotice: signInCopy.sessionEndedNotice,
  signInAgain: signInCopy.signInAgain,
  // Lists
  activeHeading: "Aktywne projekty",
  closedHeading: "Zamknięte projekty",
  closedNote:
    "Zakończone i anulowane projekty zostają na liście zamkniętych: zachowają aliasy, kontakty i historię.",
  noActiveProjects: "Brak aktywnych projektów. Zidentyfikuj pierwszy projekt poniżej.",
  noClosedProjects: "Brak zamkniętych projektów.",
  pausedMark: (reason: string, resumeOn: string | null): string =>
    resumeOn === null
      ? `Wstrzymany: ${reason}`
      : `Wstrzymany: ${reason} (proponowany termin wznowienia: ${resumeOn})`,
  codenameLabel: "Alias",
  generatedCodenameNote: "Alias roboczy nadany automatycznie; można go zmienić na firmowy krótki kod.",
  retainedAliases: (count: number): string => `Zachowane aliasy w historii: ${count}.`,
  clientLabel: "Klient",
  noClient: "klient nieznany",
  sourceLinks: (count: number): string => `Powiązane wiadomości: ${count}.`,
  revisionLabel: "rewizja",
  closedAt: (closedAtMs: number): string =>
    `Zamknięto ${new Date(closedAtMs).toLocaleDateString("pl-PL")}.`,
  // Identify form
  identifyHeading: "Zidentyfikuj projekt",
  identifyIntro:
    "Projekt istnieje od pierwszego zapytania klienta i może pojawić się na dowolnym etapie. Nazwa zwyczajna może się powtarzać; jednoznaczny alias nadasz osobno.",
  projectNameLabel: "Nazwa projektu",
  projectNamePlaceholder: "np. Łazienka u Kaczmarka",
  initialStageLabel: "Etap początkowy",
  clientSelectLabel: "Klient (opcjonalnie)",
  clientNone: "— brak —",
  identify: "Zidentyfikuj projekt",
  identifying: "Identyfikujemy…",
  projectIdentified: "Projekt zidentyfikowany. Dostał roboczy alias i czeka na firmowy kod.",
  // Codename form
  codenameHeading: "Nadaj alias (kod projektu)",
  codenameIntro:
    "Alias to robocza nazwa jednoznacznie wskazująca projekt w firmie, np. „Banan”. Raz użyty alias zostaje zarezerwowany na zawsze, także po zmianie nazwy lub zamknięciu projektu.",
  codenameProjectLabel: "Projekt",
  codenameInputLabel: "Nowy alias",
  codenamePlaceholder: "np. Banan",
  assignCodename: "Nadaj alias",
  codenameAssigned: "Alias nadany.",
  // Stage form
  stageHeading: "Zmień etap projektu",
  stageIntro:
    "Etap zmienia tylko jednoznaczna decyzja: Twoja bezpośrednia zmiana albo jasna wypowiedź przekazana agentowi. Cisza, minięcie terminu ani brak otwartych zadań nie zamykają projektu.",
  stageProjectLabel: "Projekt",
  stageSelectLabel: "Nowy etap",
  changeStage: "Zmień etap",
  stageChanged: "Etap zmieniony.",
  // Pause form
  pauseHeading: "Wstrzymaj projekt",
  pauseIntro:
    "Wstrzymanie to osobne oznaczenie z powodem i ewentualnym proponowanym terminem wznowienia. Nie zmienia etapu projektu ani uzgodnionych terminów; nadejście terminu samo nie wznawia prac.",
  pauseProjectLabel: "Projekt",
  pauseReasonLabel: "Powód wstrzymania",
  pauseReasonPlaceholder: "np. czekamy na okna",
  pauseResumeLabel: "Proponowany termin wznowienia (opcjonalnie)",
  pauseSet: "Wstrzymaj",
  pauseClear: "Wznów pracę (zdejmij wstrzymanie)",
  pauseChangedSet: "Projekt wstrzymany.",
  pauseChangedClear: "Wstrzymanie zdjęte.",
  // Contacts
  contactsHeading: "Kontakty",
  contactsIntro:
    "Kontakt to osoba lub organizacja z katalogu firmy — odrębna od konta użytkownika. Ten sam kontakt może być klientem, wykonawcą i dostawcą bez zakładania nowego bytu.",
  contactKindLabel: "Rodzaj",
  contactNameLabel: "Nazwa kontaktu",
  contactNamePlaceholder: "np. Hurtownia Kaczmarek",
  addContact: "Dodaj kontakt",
  contactAdded: "Kontakt dodany.",
  roleHeading: "Role w projektach",
  roleProjectLabel: "Projekt",
  roleContactLabel: "Kontakt",
  roleSelectLabel: "Rola",
  assignRole: "Przypisz rolę",
  roleAssigned: "Rola przypisana.",
  noContacts: "Brak kontaktów — dodaj pierwszy powyżej.",
  rolesOfProject: (roles: readonly string[]): string => roles.join(", "),
} as const;

/** Extra Polish hints for the load-bearing closed-error codes. */
const codeHints: Record<string, string> = {
  codename_reserved:
    "Ten alias jest już zarezerwowany w tej firmie — także przez projekt zamknięty lub dawno przemianowany. Wybierz inny.",
  codename_generated_namespace:
    "Alias w formacie „#12” jest zarezerwowany dla aliasów nadawanych automatycznie. Wybierz nazwę bez „#”.",
  codename_empty: "Alias nie może być pusty.",
  project_closed:
    "Projekt jest zamknięty — wstrzymanie dotyczy projektów w pracy. Najpierw otwórz projekt ponownie.",
  revision_mismatch:
    "Dane projektu zmieniły się w międzyczasie. Odśwież widok i spróbuj ponownie.",
  project_name_empty: "Nazwa projektu nie może być pusta.",
  contact_name_empty: "Nazwa kontaktu nie może być pusta.",
  pause_reason_empty: "Podaj powód wstrzymania.",
  client_contact_not_found: "Wybrany kontakt nie istnieje w tej firmie.",
};

/** The Polish hint for a closed-error code, or null when the server message suffices. */
export function failureHint(code: string | undefined): string | null {
  if (code === undefined) {
    return null;
  }
  return codeHints[code] ?? null;
}
