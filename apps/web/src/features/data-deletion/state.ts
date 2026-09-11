/**
 * Polish product copy of the data-deletion feature (I4). Barebones scope:
 * plain semantic controls and status text only, no styling (AGENTS.md).
 * The confirmation phrase is the server's exact contract (imported, not
 * duplicated), so the UI's "wpisz: ..." can never drift from the check.
 */

import { PURGE_CONFIRMATION_PHRASE } from "../../../../../convex/operations/deletion/purge";

export const deletionCopy = {
  title: "Trwałe usunięcie danych",
  intro:
    "Trwałe usunięcie wiadomości źródłowej usuwa ją natychmiast z rozmowy, pamięci, wyszukiwania i eksportów, a pliki i pochodne dane są czyszczone w ciągu 24 godzin. To operacja nieodwracalna i inna niż zwykłe wycofanie wiadomości.",
  adminNote:
    "Podgląd i trwałe usunięcie są dostępne wyłącznie dla obecnego administratora firmy.",
  sourceLabel: "Identyfikator wiadomości źródłowej",
  previewButton: "Podejrzyj wpływ usunięcia",
  previewing: "Sprawdzam wpływ...",
  previewHeading: "Co zostanie usunięte lub unieważnione",
  confirmationLabel: `Aby potwierdzić, wpisz dokładnie: ${PURGE_CONFIRMATION_PHRASE}`,
  purgeButton: "Trwale usuń",
  purging: "Usuwam trwale...",
  empty: "Nie wykonano jeszcze żadnego trwałego usunięcia.",
  historyHeading: "Trwałe usunięcia i stan czyszczenia",
  deadlineLabel: "Termin czyszczenia",
  attemptsLabel: "Próby",
  stagePending: "w toku",
  stagePurged: "wyczyszczone",
  stageFailed: "niepowodzenie",
  stageLabels: {
    media_objects: "Pliki i reprezentacje",
    transcripts: "Transkrypcje, odczyty i fragmenty",
    findings_marking: "Ustalenia oparte na wiadomości",
    search_index: "Indeks wyszukiwania",
    notification_work: "Zawiadomienia",
    exports: "Eksporty",
  } as const,
  checking: "Sprawdzam stan usunięć...",
  sessionEnded: "Sesja wygasła. Zaloguj się ponownie.",
  unexpected: "Nie udało się wykonać operacji.",
  notFound: "Nie znaleziono takiej wiadomości źródłowej w tej firmie.",
} as const;

export { PURGE_CONFIRMATION_PHRASE };
