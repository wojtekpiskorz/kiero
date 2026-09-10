/**
 * GM processing feature state: Polish copy and the closed-error
 * classification for the H4 surface.
 *
 * The banner and mode copy reuse B4's gmCopy (the GM-mode identification
 * contract has one home); this module carries only the processing copy and
 * the failure hints THIS surface adds, falling back to B4's hints so the
 * shared authority codes keep one Polish spelling.
 */

import { gmFailureHint } from "../access/state";

export { signInCopy } from "../../sign-in/state";

/** Polish copy for the GM processing surface (stable product text). */
export const gmProcessingCopy = {
  title: "GM — inspekcja przetwarzania",
  bannerIntro:
    "Tryb GM aktywny. Każda czynność na tym panelu zapisuje się w chronionym dzienniku wraz z podstawą.",
  accessPanelLink: "Przejdź do panelu dostępu GM",
  notGmHeading: "Ten panel wymaga aktywnego trybu GM",
  notGmIntro:
    "Inspekcja przetwarzania i operacje przywracania są czynnościami GM. Najpierw wejdź w tryb GM na panelu dostępu, podając podstawę.",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured:
    "Adres backendu jest nieprawidłowy. Aplikacja działa bez połączenia.",
  checkingState: "Sprawdzamy stan trybu GM…",
  inspectHeading: "Inspekcja przebiegu przetwarzania",
  inspectIntro:
    "Inspekcja pokazuje chroniony szczegół przebiegu: etapy, próby z zatwierdzoną trasą modelu, wersje pipeline, monitu i schematu, zmiany wynikowe, zredagowane diagnostyki oraz aktualne blokady. Nie zmienia stanu przeczytania ani metryk szefów.",
  inspectRunLabel: "Identyfikator przebiegu (runId)",
  inspectBasisLabel: "Podstawa inspekcji",
  inspectSubmit: "Inspekcjonuj przebieg",
  inspecting: "Inspekcjonujemy…",
  inspectNotice: "Inspekcja zapisana w dzienniku.",
  retryHeading: "Ponowne uruchomienie nieudanego etapu",
  retryIntro:
    "Wznowienie działa tylko dla etapu nieudanego lub zablokowanego w zgodnym przebiegu. Tożsamość przebiegu zostaje zachowana: te same wersje i ten sam dziennik, bez zmiany niezmiennej wiadomości źródłowej i bez wyboru modelu.",
  retryStepLabel: "Identyfikator etapu (stepId)",
  retryExpectedStateLabel: "Stan przebiegu widziany przy inspekcji",
  retryBasisLabel: "Podstawa wznowienia",
  retrySubmit: "Wznów etap",
  retrying: "Wznawiamy…",
  retryNotice: (runId: string, from: string): string =>
    `Wznowiono przebieg ${runId} od etapu „${from}”. Przebieg wraca do stanu w toku.`,
  reanalysisHeading: "Ponowna analiza źródła",
  reanalysisIntro:
    "Ponowna analiza tworzy NOWY przebieg powiązany ze źródłem, z konfiguracją zatwierdzoną przez serwer. Nie nadpisuje nowszej korekty i nie pozwala wybrać modelu.",
  reanalysisSourceLabel: "Identyfikator źródła (sourceId)",
  reanalysisLatestRunLabel: "Najnowszy przebieg źródła widziany przy inspekcji (lub puste)",
  reanalysisReasonLabel: "Podstawa ponownej analizy",
  reanalysisSubmit: "Zleć ponowną analizę",
  reanalyzing: "Zlecamy…",
  reanalysisNotice: (runId: string, ofRunId: string | null): string =>
    ofRunId === null
      ? `Utworzono nowy przebieg ${runId}.`
      : `Utworzono nowy przebieg ${runId} powiązany z przebiegiem ${ofRunId}.`,
  resultRunHeading: "Przebieg",
  resultRunKind: (kind: string): string =>
    kind === "reanalysis" ? "ponowna analiza" : "analiza pierwotna",
  resultRunLink: (runId: string | null): string =>
    runId === null ? "brak przebiegu źródłowego" : `powtórka przebiegu ${runId}`,
  resultSourceHeading: "Wiadomość źródłowa (szczegół chroniony)",
  resultStepsHeading: "Etapy",
  resultAttemptsHeading: "Próby (zatwierdzona trasa modelu)",
  resultJobsHeading: "Zadania wytrwałe przebiegu",
  resultChangesHeading: "Zmiany wynikowe źródła",
  resultDiagnosticsHeading: "Zredagowane diagnostyki",
  resultBlockersHeading: "Aktualne blokady",
  resultEmpty: "Brak.",
  diagnosticsRedacted: (count: number | null): string =>
    count === null ? "" : ` (zredagowano: ${count})`,
  runStateLabel: (state: string): string => {
    switch (state) {
      case "running":
        return "w toku";
      case "succeeded":
        return "zakończony";
      case "failed":
        return "nieudany";
      case "superseded":
        return "zastąpiony";
      default:
        return state;
    }
  },
  stepStateLabel: (state: string): string => {
    switch (state) {
      case "pending":
        return "oczekuje";
      case "running":
        return "w toku";
      case "succeeded":
        return "zakończony";
      case "failed":
        return "nieudany";
      default:
        return state;
    }
  },
  attemptOutcomeLabel: (outcome: string): string => {
    switch (outcome) {
      case "succeeded":
        return "sukces";
      case "failed":
        return "niepowodzenie";
      case "timeout":
        return "przekroczono czas";
      case "unknown":
        return "wynik nieznany";
      default:
        return outcome;
    }
  },
  versionsLine: (run: {
    pipelineVersion: string;
    promptVersion: string;
    schemaVersion: string;
    modelConfigurationVersion: string;
  }): string =>
    `Wersje: pipeline ${run.pipelineVersion}, monit ${run.promptVersion}, schemat ${run.schemaVersion}, konfiguracja modelu ${run.modelConfigurationVersion}.`,
  sourceLine: (source: {
    lifecycle: string;
    processingState: string;
    sentAtMs: number;
  }): string =>
    `Stan źródła: ${source.lifecycle}; przetwarzanie: ${source.processingState}; wysłano ${new Date(source.sentAtMs).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}.`,
} as const;

/**
 * Extra Polish hints for this surface's load-bearing closed-error codes;
 * shared authority codes fall back to B4's hint map.
 */
const processingCodeHints: Record<string, string> = {
  processing_run_not_found: "Nie znaleziono takiego przebiegu przetwarzania.",
  processing_step_not_found: "Nie znaleziono takiego etapu przetwarzania.",
  source_not_found: "Nie znaleziono takiej wiadomości źródłowej.",
  run_state_stale:
    "Stan przebiegu zmienił się od czasu Twojej inspekcji. Sprawdź przebieg ponownie i użyj aktualnego stanu.",
  run_already_running:
    "Ten przebieg już działa; ponowne uruchomienie etapu nie jest teraz potrzebne.",
  stage_not_failed:
    "Wznowić można tylko etap nieudany albo zablokowany (pozostawiony w toku w przebiegu, który się nie powiódł).",
  run_superseded: "Ten przebieg został zastąpiony; historii nie można wznowić.",
  workflow_identity_missing:
    "Ten przebieg nie ma tożsamości workflow, którą bieżące wdrożenie mogłoby wznowić.",
  workflow_version_unsupported:
    "Wersja pipeline tego przebiegu nie jest obsługiwana przez bieżące wdrożenie; nie zgadzamy się udawać, że ją wznawiamy.",
  source_not_active:
    "Źródło zostało wycofane lub usunięte; ponowna analiza nie jest możliwa.",
  newer_run_exists:
    "Od czasu Twojej inspekcji powstał nowszy przebieg tego źródła. Sprawdź źródło ponownie.",
};

/** The Polish hint for a closed-error code, this lane's then B4's, or null. */
export function gmProcessingFailureHint(code: string | undefined): string | null {
  if (code === undefined) {
    return null;
  }
  return processingCodeHints[code] ?? gmFailureHint(code);
}
