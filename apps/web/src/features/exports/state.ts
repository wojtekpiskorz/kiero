/**
 * Polish product copy of the exports feature (I3). Barebones scope: plain
 * semantic controls and status text only, no styling (AGENTS.md).
 */

export const exportsCopy = {
  title: "Eksport danych firmy",
  intro:
    "Archiwum firmy w jednym pliku ZIP: czytelny wykaz (index.html), dane w formacie JSON oraz zachowane zdjęcia i nagrania. Eksport przygotowuje się w tle; plik jest dostępny do pobrania przez 24 godziny od przygotowania.",
  requestButton: "Przygotuj eksport",
  requesting: "Zlecam przygotowanie...",
  adminNote:
    "Eksport może zlecić i pobrać wyłącznie obecny administrator firmy.",
  gatewayMissing:
    "Adres bramki plików nie jest skonfigurowany, więc pobieranie jest teraz niemożliwe. Pozostałe funkcje działają.",
  historyHeading: "Poprzednie eksporty",
  empty: "Nie przygotowano jeszcze żadnego eksportu.",
  snapshotLabel: "Migawka z",
  availableUntil: "Do pobrania do",
  sourcesCount: (n: number) => `Wiadomości w archiwum: ${n}`,
  mediaCount: (n: number) => `Plików mediów: ${n}`,
  failureNote: "Przygotowanie eksportu nie powiodło się.",
  invalidationNote: "Eksport unieważniony (np. trwałe usunięcie danych).",
  cleanedNote: "Plik usunięty po wygaśnięciu.",
  downloadButton: "Pobierz archiwum",
  downloading: "Pobieram...",
  checking: "Sprawdzam stan eksportów...",
  sessionEnded: "Sesja wygasła. Zaloguj się ponownie.",
  unexpected: "Nie udało się wykonać operacji.",
} as const;
