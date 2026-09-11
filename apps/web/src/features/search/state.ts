/**
 * Search feature state (H3): Polish copy, the coverage disclosure
 * vocabulary and the closed-error hints for the search surface.
 *
 * The coverage literal is displayed VERBATIM ("full" | "text_only" |
 * "degraded", the E5 contract) beside its Polish explanation, because the
 * issue pins that semantic-gap disclosure: `text_only` and `degraded` say
 * plainly that absence of a hit is not absence of a fact. Label maps are
 * TYPED by the contract's literal unions so a vocabulary change fails the
 * build instead of rendering a raw machine code.
 */

import { signInCopy } from "../sign-in/state";
import { sessionFailureHints } from "../conversation/state";

export { signInCopy };

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the search surface. */
export const searchCopy = {
  title: "Szukaj",
  intro:
    "Wyszukaj dowody w wiadomościach, transkrypcjach nagrań i odczytach zdjęć oraz w aktualnych ustaleniach.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  // The form
  queryLabel: "Szukana treść",
  queryPlaceholder: "np. dowóz płytek Kaczmarek",
  filtersLegend: "Filtry",
  projectFilterLabel: "Projekt",
  projectFilterAny: "dowolny projekt",
  authorFilterLabel: "Autor",
  authorFilterAny: "ktokolwiek",
  dateFromLabel: "Wysłane od (dzień)",
  dateToLabel: "Wysłane do (dzień)",
  dateHint: "Zakres dnia rozumiany jest od początku dnia od do końca dnia do.",
  submitButton: "Szukaj",
  searching: "Szukanie…",
  // Coverage disclosure (the E5 contract literal, shown verbatim)
  coverageLabel: "Tryb wyszukiwania",
  coverageLabels: {
    full: "pełne (tekst i semantyka)",
    text_only: "tylko tekst",
    degraded: "ograniczone",
  } as const,
  coverageNotes: {
    full: "Przeszukano tekst i podobieństwo znaczeniowe.",
    text_only:
      "Wyszukiwanie semantyczne jest chwilowo niedostępne (induksowanie zapytania się nie udało). Brak trafienia semantycznego nie dowodzi braku faktu.",
    degraded:
      "Brak aktywnego indeksu: przeszukiwanie dowodów jest ograniczone. Aktualne ustalenia i historie pozostają dostępne w Pamięci i Rozmowie firmy.",
  } as const,
  // Results
  resultsHeading: "Wyniki",
  noResults: "Brak wyników w tym trybie. Brak trafienia nie dowodzi braku faktu — sprawdź filtry albo tryb.",
  moreButton: "Pokaż więcej wyników",
  kindLabels: {
    source_fragment: "fragment źródła",
    finding: "ustalenie",
  } as const,
  matchedViaLabels: {
    text: "trafienie tekstowe",
    semantic: "trafienie semantyczne",
    text_and_semantic: "trafienie tekstowe i semantyczne",
  } as const,
  scoreLabel: "trafność",
  sourceLinkLabel: "otwórz źródło",
  sourceHydrationUnavailable: "Nie udało się dociągnąć szczegółów tego źródła.",
  findingDetailsButton: "Szczegóły ustalenia",
  findingSemanticKeyLabel: "klucz",
  findingValueLabel: "wartość",
  findingHistoryNote: "Pełna historia i dowody: ekran Pamięć.",
  evidenceSourceLabel: "dowód:",
  cancel: "Anuluj",
} as const;

// ---------------------------------------------------------------------------
// Coverage rendering (the verbatim literal + the honest note)
// ---------------------------------------------------------------------------

/** The coverage literal E5 declares (typed pin: a new literal fails build). */
export type CoverageLiteral = "full" | "text_only" | "degraded";

/** The coverage line: the verbatim literal plus its Polish explanation. */
export function coverageLine(coverage: CoverageLiteral): string {
  return `${coverage} — ${searchCopy.coverageLabels[coverage]}: ${searchCopy.coverageNotes[coverage]}`;
}

/** True when the coverage discloses a semantic gap (drives the alert role). */
export function isDegradedCoverage(coverage: CoverageLiteral): boolean {
  return coverage !== "full";
}

// ---------------------------------------------------------------------------
// Date filter helpers (day inputs to millisecond bounds)
// ---------------------------------------------------------------------------

/** One YYYY-MM-DD day input to its UTC-midnight milliseconds (or null). */
export function dayToMs(day: string): number | null {
  if (day.trim() === "") {
    return null;
  }
  const parsed = Date.parse(`${day.trim()}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The inclusive END of one YYYY-MM-DD day in milliseconds (or null). */
export function dayToEndMs(day: string): number | null {
  const start = dayToMs(day);
  return start === null ? null : start + 24 * 60 * 60 * 1000 - 1;
}

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish context for the machine codes this surface can meet. */
const failureHints: Partial<Record<string, string>> = {
  ...sessionFailureHints,
  embedding_provider_unavailable:
    "Chwilowo nie udało się uzyskać wektora zapytania; wyszukiwanie działa w trybie tekstowym.",
};

/** The notice text for one closed error code (hint or server message). */
export function failureHint(code: string, serverMessage: string): string {
  return failureHints[code] ?? serverMessage;
}
