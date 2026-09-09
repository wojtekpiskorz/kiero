/**
 * The Calendar OAuth callback answer vocabulary (G1): the Polish page and
 * HTTP status for every terminal outcome the callback surfaces.
 *
 * A PURE module (no Convex imports): the Convex HTTP boundary
 * (./http.ts) and the gateway's callback route
 * (apps/gateway/src/calendar-oauth/routes.ts) render the SAME pages, so
 * the copy lives once, here. Keyed by the closed machine-reason union
 * (./cores RECONNECT_REASONS, mirrored by the schema's reconnectReason
 * validator) plus `invalid_state`: a missing page is a COMPILE error,
 * never a silent fallback.
 */

import type { ReconnectReason } from "./cores";

/** One completion's terminal view for the response surfaces (no secrets). */
export interface CallbackAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly code: string;
  readonly polishTitle: string;
  readonly polishDetail: string;
}

/** The page vocabulary: every machine reconnect reason plus the flow-level codes. */
export type AnswerCode = ReconnectReason | "invalid_state";

export const ANSWERS: Record<AnswerCode, CallbackAnswer> = {
  invalid_state: {
    status: 400,
    ok: false,
    code: "invalid_state",
    polishTitle: "Nieprawidłowe połączenie.",
    polishDetail: "Ten link wygasł albo został już użyty. Zacznij połączenie od nowa w Kiero.",
  },
  authorization_expired: {
    status: 400,
    ok: false,
    code: "authorization_expired",
    polishTitle: "Upłynął czas na połączenie.",
    polishDetail: "Rozpocznij połączenie kalendarza od nowa w Kiero.",
  },
  membership_lost: {
    status: 403,
    ok: false,
    code: "membership_lost",
    polishTitle: "Brak dostępu do firmy.",
    polishDetail: "Twoje członkostwo w tej firmie zostało cofnięte, więc połączenia kalendarza nie można dokończyć.",
  },
  authorization_denied: {
    status: 400,
    ok: false,
    code: "authorization_denied",
    polishTitle: "Nie udostępniono kalendarza.",
    polishDetail: "Zgoda w Google nie została udzielona. Możesz spróbować ponownie w Kiero.",
  },
  // Upstream (Google-leg) outcomes answer 200 with the typed result in the
  // payload: the Cloudflare edge in front of *.convex.site replaces origin
  // 502/504 bodies with its own error page (verified live), which would hide
  // the honest Polish page and JSON envelope from the user.
  exchange_failed: {
    status: 200,
    ok: false,
    code: "exchange_failed",
    polishTitle: "Google odrzucił połączenie.",
    polishDetail: "Wymiana uprawnienia nie powiodła się. Spróbuj połączyć kalendarz ponownie w Kiero.",
  },
  exchange_unknown: {
    status: 200,
    ok: false,
    code: "exchange_unknown",
    polishTitle: "Wynik połączenia jest niepewny.",
    polishDetail: "Odpowiedź Google nie dotarła w całości. Kiero nie powtórzy wymiany automatycznie — spróbuj ponownie w Kiero.",
  },
  scopes_missing: {
    status: 400,
    ok: false,
    code: "scopes_missing",
    polishTitle: "Brak wymaganych uprawnień.",
    polishDetail: "Kiero potrzebuje zgody wyłącznie na własny kalendarz Kiero. Połącz ponownie i zostaw wymagane uprawnienia.",
  },
  creation_failed: {
    status: 200,
    ok: false,
    code: "creation_failed",
    polishTitle: "Nie udało się utworzyć kalendarza.",
    polishDetail: "Google odmówił utworzenia kalendarza Kiero. Spróbuj ponownie w Kiero.",
  },
  creation_unknown: {
    status: 200,
    ok: false,
    code: "creation_unknown",
    polishTitle: "Wynik tworzenia kalendarza jest niepewny.",
    polishDetail: "Kalendarz mógł zostać utworzony, ale odpowiedź Google nie dotarła. Kiero nie utworzy drugiego kalendarza automatycznie — wróć do Kiero i zdecyduj o ponownej próbie.",
  },
  calendar_access_lost: {
    status: 409,
    ok: false,
    code: "calendar_access_lost",
    polishTitle: "Kalendarz Kiero jest niedostępny.",
    polishDetail: "Zapisany kalendarz nie odpowiada (mógł zostać usunięty). Jeśli na pewno go usunąłeś, użyj opcji Odtwórz w Kiero.",
  },
  calendar_read_unknown: {
    status: 200,
    ok: false,
    code: "calendar_read_unknown",
    polishTitle: "Stan kalendarza jest niepewny.",
    polishDetail: "Odpowiedź Google nie dotarła w całości. Kiero nie utworzy drugiego kalendarza automatycznie — spróbuj ponownie w Kiero.",
  },
  refresh_failed: {
    status: 200,
    ok: false,
    code: "refresh_failed",
    polishTitle: "Google cofnął dostęp do kalendarza.",
    polishDetail: "Połączenie zostało zatrzymane. Połącz kalendarz ponownie w Kiero.",
  },
};

/** The typed lookup (compile-checked completeness). */
export function answerFor(code: AnswerCode): CallbackAnswer {
  return ANSWERS[code];
}

/**
 * The runtime lookup for untrusted string codes (the gateway's JSON
 * boundary decodes the envelope, not the vocabulary): null for an unknown
 * code so callers render their honest generic fallback.
 */
export function answerOrNull(code: string): CallbackAnswer | null {
  return Object.hasOwn(ANSWERS, code) ? ANSWERS[code as AnswerCode] : null;
}
