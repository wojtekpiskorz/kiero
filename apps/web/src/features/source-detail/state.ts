/**
 * Source-detail feature state (H3): Polish copy, the anchor/representation
 * vocabularies and the closed-error hints for the source-history surface.
 *
 * Label maps are TYPED by the wire schemas the exposition read carries
 * (convex/sources/read/exposition.ts), so a vocabulary change on the
 * producing side fails this build instead of rendering a raw machine code.
 * The copy renders exactly what is there: a withdrawn source keeps its
 * content and history ("Źródło wycofane", CONTEXT.md) and never reads as
 * deleted; a finding left `updating` by recomputation says so; a
 * representation that no longer serves reads says why.
 */

import { signInCopy } from "../sign-in/state";
import { sessionFailureHints } from "../conversation/state";
import type {
  FragmentAnchor,
  SourceExpositionRow,
} from "../../../../../convex/sources/read/exposition";

export { signInCopy };

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the source-history surface. */
export const sourceDetailCopy = {
  title: "Źródło",
  intro:
    "Niezmienne po wysłaniu: wpis użytkownika: treść, zachowane materiały, transkrypcje i odczyty, ustalenia na niej oparte oraz pełna historia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  noSourceHint:
    "Nie wskazano źródła. Otwórz wiadomość z rozmowy firmy lub wyszukaj na ekranie Szukaj.",
  noSourceLink: "Wróć do rozmowy firmy",
  notFound: "Takie źródło nie istnieje albo nie należy do Twojej firmy.",
  // Identity
  identityHeading: "Wiadomość źródłowa",
  authorLabel: "Autor",
  unknownAuthorLabel: "Nieznany autor",
  sentAtLabel: "Wysłano",
  stateLabel: "Stan przetwarzania",
  projectsLabel: "Projekty",
  noProjects: "Brak powiązanych projektów (wiedza ogólna firmy).",
  canonicalLinkLabel: "Bezpośredni odnośnik do tej wiadomości (działa w każdym widoku):",
  openInConversation: "Otwórz w rozmowie firmy",
  // Withdrawal
  activeLifecycleLabel: "aktualne (podstawa ustaleń)",
  withdrawnHeading: "Źródło wycofane",
  withdrawnByLabel: "wycofał",
  withdrawnAtLabel: "wycofano",
  withdrawnReasonLabel: "powód",
  withdrawnDisclosedNote:
    "Wycofanie nie jest trwałym usunięciem: treść, autor i rola w historii pozostają, a zależne ustalenia są ponownie rozpatrywane.",
  withdrawButton: "Wycofaj to źródło",
  withdrawHeading: "Wycofanie źródła",
  withdrawIntro:
    "Wiadomość przestaje być podstawą aktualnych ustaleń; jej wcześniejsza rola i przyczyna pozostają w historii. Ustalenia, które straciły podstawę, zostaną oznaczone do ponownego rozpatrzenia.",
  withdrawReasonLabel: "Powód wycofania",
  withdrawReasonPlaceholder: "np. Pomyłka: dotyczyło innego projektu.",
  withdrawSubmit: "Wycofaj źródło",
  withdrawSaving: "Wycofywanie…",
  withdrawDone:
    "Źródło wycofane. Treść i historia pozostają; zależne ustalenia są oznaczane do ponownego rozpatrzenia.",
  reassignmentNote:
    "Przypisanie tej wiadomości do projektów zmienia się obecnie tylko przy wysyłce (podpowiedzi projektów). Osobna operacja przypisania źródła do projektów nie jest jeszcze udostępniona.",
  // Evidence chain
  networkUnavailable: "Brak połączenia z serwerem. Spróbuj ponownie za chwilę.",
  evidenceHeading: "Ustalenia oparte na tym źródle",
  evidenceIntro:
    "Każdy dowód wskazuje fragment wiadomości i aktualny stan ustalenia, które z niego wynika.",
  noEvidence: "Żadne ustalenie nie opiera się (jeszcze) na tym źródle.",
  loadMoreEvidence: "Pokaż więcej ustaleń",
  findingLinkLabel: "ustalenie w pamięci",
  citedRevisionLabel: "rewizja",
  supersededBadge: "zastąpione nowszą rewizją",
  currentBadge: "aktualne",
  recomputationBadge: "wymaga ponownego potwierdzenia",
  // Media
  mediaHeading: "Zachowane materiały",
  noAttachments: "Ta wiadomość nie ma załączników.",
  gatewayUnconfigured:
    "Brak adresu bramki mediów (VITE_GATEWAY_URL), więc materiały nie mogą być odczytane z bezpiecznego kanału.",
  tokenMissing: "Sesja nie pozwala teraz pobrać materiałów. Odśwież i spróbuj ponownie.",
  mediaDenied:
    "Odmowa dostępu do materiału (sesja, członkostwo albo źródło). Żaden bajt nie został podany.",
  mediaUnavailable: "Kanał mediów jest chwilowo niedostępny. Spróbuj ponownie.",
  loadAudioButton: "Odtwórz nagranie (bezpieczny kanał)",
  loadingMedia: "Pobieranie przez bezpieczny kanał…",
  showImageButton: "Pokaż zdjęcie (bezpieczny kanał)",
  rangeProbeButton: "Sprawdź dostęp zakresowy",
  rangeProbeSatisfied: (contentRange: string): string =>
    `Zakres obsługiwany na żywo: ${contentRange}.`,
  // Representations
  representationsLabel: "reprezentacje",
  representationRoleLabels: {
    received: "odebrana (oryginał)",
    retained: "zachowana (znormalizowana)",
    thumbnail: "miniatura",
    processing: "robocza",
  } as const,
  representationVerified: "zweryfikowana",
  representationUnverified: "niezweryfikowana (nie służy odczytom)",
  representationRemoved: "usunięte bajty (zapis o historii)",
  representationException: (kind: string): string =>
    `wyjątek normalizacji: zachowaliśmy oryginał (${kind})`,
  // Transcripts
  transcriptsHeading: "Transkrypcja nagrania",
  noTranscripts: "Brak transkrypcji dla tego źródła.",
  transcriptStateLabels: {
    planning: "planowanie",
    pending: "oczekuje",
    partial: "częściowa",
    complete: "kompletna",
    failed: "niepowodzenie",
  } as const,
  segmentsLabel: "segmenty",
  segmentPending: "czeka",
  segmentFailed: "niepowodzenie",
  seekSegmentButton: "Przewiń do tego fragmentu",
  // OCR
  ocrHeading: "Odczyt zdjęcia (OCR)",
  noOcr: "Brak odczytu zdjęć dla tego źródła.",
  visionStateLabels: {
    pending: "oczekuje",
    complete: "kompletny",
    failed: "niepowodzenie",
  } as const,
  ocrSpaceLabel: "przestrzeń współrzędnych",
  ocrHighlightLabel: "podświetlony obszar odczytu",
  // Fragments
  fragmentsHeading: "Fragmenty źródła",
  noFragments: "Brak wskazanych fragmentów.",
  matchedFragmentBadge: "trafienie wyszukiwania",
  // Read state
  readStateNotice: "Otwarcie oryginału oznacza go jako przeczytanego dla Ciebie w każdym widoku.",
  markReadFailure: "Nie udało się zapisać stanu przeczytania. Spróbuj ponownie.",
  cancel: "Anuluj",
} as const;

// ---------------------------------------------------------------------------
// Typed vocabularies (a producing-side change fails the build)
// ---------------------------------------------------------------------------

/** Source lifecycle labels (full map: the identity line always states one). */
export const lifecycleLabels: Record<SourceExpositionRow["lifecycle"], string> = {
  active: sourceDetailCopy.activeLifecycleLabel,
  withdrawn: "wycofana (nie jest podstawą aktualnych ustaleń; historia zachowana)",
  purged: "trwale usunięta",
};

/** Processing-state labels reuse D1's own vocabulary (the same derivation). */
export const processingStateLabels: Record<SourceExpositionRow["processingState"], string> = {
  accepted: "przyjęta",
  processing: "przetwarzana",
  partial: "częściowo przetworzona",
  processed: "przetworzona",
  failed: "niepowodzenie przetwarzania",
};

/** Transcript-state labels (D6's order vocabulary). */
export const transcriptStateLabels: Record<
  SourceExpositionRow["transcripts"][number]["state"],
  string
> = sourceDetailCopy.transcriptStateLabels;

/** Vision-order-state labels (E4's order vocabulary). */
export const visionStateLabels: Record<
  SourceExpositionRow["visionOrders"][number]["state"],
  string
> = sourceDetailCopy.visionStateLabels;

/** Representation-role labels (D5's role vocabulary). */
export const representationRoleLabels: Record<
  SourceExpositionRow["attachments"][number]["representations"][number]["role"],
  string
> = sourceDetailCopy.representationRoleLabels;

// ---------------------------------------------------------------------------
// Anchor rendering (the four "Fragment źródła" families)
// ---------------------------------------------------------------------------

/** One human-readable anchor label (Polish, exact coordinates shown). */
export function anchorLabel(anchor: FragmentAnchor): string {
  switch (anchor._tag) {
    case "text_range":
      return `fragment tekstu (znaki ${anchor.startOffset}–${anchor.endOffset})`;
    case "audio_interval":
      return `zakres nagrania (${Math.round(anchor.startMs)}–${Math.round(anchor.endMs)} ms)`;
    case "image_region":
      return `obszar zdjęcia (${Math.round(anchor.x)}, ${Math.round(anchor.y)}, ${Math.round(
        anchor.width,
      )}×${Math.round(anchor.height)} px)`;
    case "whole_source":
      return "cała wiadomość";
  }
}

/** The text excerpt one text_range anchor covers (null when it covers none). */
export function textRangeExcerpt(
  authorText: string,
  anchor: FragmentAnchor,
): string | null {
  if (anchor._tag !== "text_range") {
    return null;
  }
  const start = Math.max(0, Math.floor(anchor.startOffset));
  const end = Math.min(authorText.length, Math.ceil(anchor.endOffset));
  if (end <= start) {
    return null;
  }
  return authorText.slice(start, end);
}

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish context for the machine codes this surface can meet. */
const failureHints: Partial<Record<string, string>> = {
  ...sessionFailureHints,
  source_not_in_company: sourceDetailCopy.notFound,
  source_withdrawn: sourceDetailCopy.withdrawnHeading,
  media_reference_not_found: sourceDetailCopy.mediaDenied,
  client_credential_missing: sourceDetailCopy.tokenMissing,
};

/** The notice text for one closed error code (hint or server message). */
export function failureHint(code: string, serverMessage: string): string {
  return failureHints[code] ?? serverMessage;
}
