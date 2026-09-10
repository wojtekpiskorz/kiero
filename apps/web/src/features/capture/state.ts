/**
 * Capture feature state (D4): the Polish copy of the mobile composer and
 * the closed-vocabularies it renders.
 *
 * Product text uses the accepted glossary exactly (CONTEXT.md): the
 * composed object is one "wiadomość źródłowa" that "może łączyć tekst,
 * nagranie i zdjęcia". Local phases are named honestly: nothing here says
 * "zapisana" (saved) about a draft that has no server receipt — the saved/
 * processing/partial/failed vocabulary after acceptance reuses the
 * conversation surface's typed labels so both surfaces speak identically
 * about the same source states.
 */

import {
  processingStateLabels,
  sessionFailureHints,
  signInCopy,
} from "../conversation/state";
import type { DraftPhase, DraftStoreErrorKind } from "../../storage/drafts/store";
import type { RecorderFailure } from "./recorder";

export { processingStateLabels, sessionFailureHints, signInCopy };

/** Copy for the capture surface (stable product text). */
export const captureCopy = {
  title: "Nowy wpis",
  intro:
    "Wyślij jedną wiadomość źródłową: tekst, opcjonalnie jedno nagranie i zdjęcia. Szkic jest zachowywany na tym urządzeniu do potwierdzonego wysłania.",
  gatewayUnconfigured:
    "Aplikacja nie ma adresu bramy mediów (VITE_GATEWAY_URL nie jest ustawiony) — wysyłanie nagrań i zdjęć jest niedostępne.",
  draftLoading: "Odczytujemy szkic z tego urządzenia…",
  checkingState: "Sprawdzamy stan wiadomości…",
  // Project pill
  projectPillLabel: "Kontekst wiadomości",
  projectAutoLabel: "Auto (wiedza ogólna firmy)",
  projectPrefixLabel: "Projekt",
  // Text
  textLabel: "Treść wiadomości",
  textPlaceholder: "np. Banan: dowóz płytek w środę rano, klient potwierdził odbiór.",
  textRequiredNote:
    "Obecnie wiadomość wymaga choć krótkiego tekstu — nagranie i zdjęcia go uzupełniają.",
  // Photos
  photosLabel: "Zdjęcia",
  photoRemoveButton: "Usuń",
  photosEmpty: "Brak zdjęć.",
  attachmentsTooMany:
    "Jedna wiadomość może mieć najwyżej 8 załączników: jedno nagranie i zdjęcia łącznie.",
  // Recording
  recordingLegend: "Nagranie głosowe",
  recordButton: "Nagraj głos",
  stopButton: "Zatrzymaj nagrywanie",
  recordingActive: "Nagrywam… dotknij Zatrzymaj, aby zakończyć.",
  recordingReady: "Nagranie gotowe do wysłania:",
  recordingListenLabel: "Posłuchaj nagrania",
  recordingDiscardButton: "Odrzuć nagranie",
  // States
  draftStateLabel: "Stan szkicu",
  phaseComposing: "szkic lokalny (nic nie wysłano)",
  phaseUploading: "wysyłanie materiałów…",
  phaseAccepting: "potwierdzanie zapisu wiadomości…",
  phaseSent: "zapisana na serwerze",
  uploadingProgress: (doneParts: number, totalParts: number, attachmentIndex: number, attachmentTotal: number) =>
    `Wysyłanie: materiał ${attachmentIndex + 1} z ${attachmentTotal}, części ${doneParts}/${totalParts}.`,
  savedNotice: "Wiadomość zapisana. Agent przetwarza…",
  // Send
  sendButton: "Wyślij",
  sending: "Wysyłanie…",
  retryButton: "Wznów wysyłkę",
  discardDraftButton: "Odrzuć szkic",
  // Interruption
  interruptedHeading: "Przerwana wysyłka wiadomości",
  interruptedIntro:
    "Poprzednie wysyłanie zostało przerwane. Poniżej jest dokładnie to, co zachowało się na tym urządzeniu — możesz posłuchać, odrzucić, wznowić albo dopisać coś przed ponownym wysłaniem.",
  lostResponseNotice:
    "Odpowiedź zaginęła podczas potwierdzania. Wiadomość mogła zostać zapisana — wznowienie nie utworzy duplikatu.",
  uploadNetworkNotice:
    "Połączenie przerwało wysyłanie materiałów. Wznów wysyłkę — części, które dotarły, nie będą wysyłane ponownie.",
  localMaterialUnreadable:
    "Nie udało się odczytać całości szkicu z tego urządzenia. Wiadomość nie została wysłana — odrzuć szkic i zacznij od nowa.",
  // Failures
  storageDegradedNotice:
    "Nie udało się zapisać całości szkicu na tym urządzeniu: wysłanie teraz zadziała, ale po przerwaniu nagranie może być nie do odzyskania.",
} as const;

/** The honest local phase labels (one per persisted draft phase). */
export const phaseLabels: Record<DraftPhase, string> = {
  composing: captureCopy.phaseComposing,
  uploading: captureCopy.phaseUploading,
  accepting: captureCopy.phaseAccepting,
  sent: captureCopy.phaseSent,
};

/** Polish copy for the classified storage failures (never silent). */
export const storageErrorCopy: Record<DraftStoreErrorKind, string> = {
  unavailable:
    "Nie można zapisać szkicu na tym urządzeniu (pamięć przeglądarki jest niedostępna). Do zamknięcia karty nic nie przepadnie, ale odzyskanie szkicu po przerwaniu nie jest możliwe.",
  quota:
    "Pamięć przeglądarki na tym urządzeniu jest pełna. Zwolnij miejsce — dopóki go nie ma, odzyskanie szkicu po przerwaniu nie jest możliwe.",
  corrupt:
    "Zapisany szkic jest uszkodzony i nie może być odczytany w całości. Odrzuć go i zacznij wiadomość od nowa.",
};

/** Polish copy for the typed recording failures. */
export function recorderFailureCopy(failure: RecorderFailure): string {
  switch (failure.kind) {
    case "permission_denied":
      return "Brak zgody na mikrofon. Zezwól na dostęp w ustawieniach przeglądarki i spróbuj ponownie.";
    case "mic_unavailable":
      return "Mikrofon jest niedostępny. Sprawdź, czy inne aplikacje nie używają go w tej chwili.";
    case "recorder_unsupported":
      return "Ta przeglądarka nie pozwala nagrać dźwięku w obsługiwanym formacie.";
    case "storage_degraded":
      return captureCopy.storageDegradedNotice;
  }
}

/**
 * Extra Polish context for the machine codes this surface can meet (the
 * session hints compose from the conversation surface; gateway codes from
 * the D2 protocol keep their exact server meanings).
 */
const captureFailureHints: Partial<Record<string, string>> = {
  ...sessionFailureHints,
  upload_not_owned_by_actor: "Szkic wysyłki należy do innej osoby. Zacznij wiadomość od nowa.",
  draft_expired_restart_required:
    "Szkic wysyłki wygasł na serwerze. Odrzuć go i wyślij wiadomość ponownie.",
  draft_declaration_mismatch:
    "Szkic zmienił się po rozpoczęciu wysyłki. Odrzuć go i zacznij wiadomość od nowa.",
  attachment_declaration_mismatch:
    "Sesja wysyłki nie zgadza się z lokalnym szkicem. Odrzuć szkic i zacznij wiadomość od nowa.",
  part_receipt_conflict:
    "Serwer zapisał inne dane dla jednej z części. Odrzuć szkic i zacznij wiadomość od nowa.",
  upload_stage_not_acceptable:
    "Materiały nie są jeszcze w całości na serwerze. Wznów wysyłkę.",
  author_text_empty: captureCopy.textRequiredNote,
  client_credential_missing: "Sesja wygasła. Zaloguj się ponownie i wznów wysyłkę.",
  part_manifest_empty: "Materiał nie dotarł w całości. Wznów wysyłkę.",
  attachment_bytes_mismatch: "Serwer zapisał inną liczbę bajtów. Wznów wysyłkę.",
};

/** The notice text for one typed gateway/acceptance code (hint or message). */
export function captureFailureHint(code: string, serverMessage: string): string {
  return captureFailureHints[code] ?? serverMessage;
}

/** Bytes as the Polish human size (no invented precision). */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(0)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** The recording length as m:ss (what a boss expects a fragment to read). */
export function durationLabel(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
