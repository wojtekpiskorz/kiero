/**
 * GM access feature state: Polish copy and the closed-error
 * classification for the B4 surface.
 *
 * The sign-in leg lives in B1's shared gate (../sign-in/SignInGate.ts);
 * this module carries only the GM copy. GM operation results arrive as
 * `ResultEnvelope`s; every closed error maps to honest Polish copy (the
 * server message) plus hints for the load-bearing machine codes.
 */

import { signInCopy } from "../../sign-in/state";

export { signInCopy };

/** Polish copy for the GM access surface (stable product text). */
export const gmCopy = {
  title: "GM — dostęp operatora",
  signedIn: (email: string): string => `Zalogowano jako ${email}.`,
  bannerActive: "TRYB GM AKTYWNY",
  bannerReason: (reason: string): string => `Podstawa wejścia: ${reason}`,
  bannerSince: (enteredAtMs: number): string =>
    `Tryb aktywny od ${new Date(enteredAtMs).toLocaleString("pl-PL", {
      dateStyle: "medium",
      timeStyle: "short",
    })}.`,
  membershipContextNote: (role: "admin" | "member"): string =>
    `Twoje członkostwo w firmie (rola: ${role}) jest odrębne od uprawnienia GM i nie wynika z niego.`,
  membershipContextNone:
    "Nie należysz do żadnej firmy — działasz wyłącznie przez uprawnienie GM, tak jak przewiduje tryb operatora.",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingState: "Sprawdzamy stan trybu GM…",
  notGmHeading: "Tryb GM nieaktywny",
  notGmIntro:
    "Uprawnienie GM jest odrębne od członkostwa w firmie. Wejście w tryb GM jest jednoznaczne, wymaga podania podstawy i zostaje zapisane w chronionym dzienniku.",
  reasonLabel: "Podstawa wejścia w tryb GM",
  reasonPlaceholder: "np. rozmowa z firmą Budowa Kowalscy o błędzie przetwarzania",
  enterGm: "Wejdź w tryb GM",
  enteringGm: "Wchodzimy w tryb GM…",
  exitGm: "Zakończ tryb GM",
  exitGmConfirm:
    "Zakończyć tryb GM? Twój dostęp operatora wygaśnie natychmiast; wpis w dzienniku pozostanie.",
  enteredNotice: "Tryb GM aktywny. Każda czynność GM zapisuje się w dzienniku wraz z podstawą.",
  exitedNotice: "Tryb GM zakończony.",
  companiesHeading: "Firmy objęte udziałem w alfie",
  companiesEmpty:
    "Brak firm objętych udziałem w alfie. Możesz dołączyć istniejącą firmę lub założyć nową wraz z zaproszeniem pierwszego administratora.",
  companySince: (activatedAtMs: number): string =>
    `Udział w alfie od ${new Date(activatedAtMs).toLocaleString("pl-PL", {
      dateStyle: "medium",
      timeStyle: "short",
    })}.`,
  inspectHeading: "Inspekcja firmy",
  inspectIntro:
    "Inspekcja jest czynnością GM: wymaga podstawy, zapisuje się w dzienniku i pokazuje przebiegi przetwarzania oraz zadania wytrwałe wybranej firmy.",
  inspectCompanyLabel: "Identyfikator firmy (companyId)",
  inspectBasisLabel: "Podstawa inspekcji",
  inspectSubmit: "Inspekcjonuj",
  inspecting: "Inspekcjonujemy…",
  inspectResultHeading: (name: string): string => `Wynik inspekcji: ${name}`,
  inspectAdmins: (count: number): string => `Aktywni administratorzy: ${count}.`,
  inspectRunsHeading: "Przebiegi przetwarzania (najnowsze)",
  inspectRunsEmpty: "Brak przebiegów przetwarzania.",
  inspectJobsHeading: "Zadania wytrwałe",
  inspectJobsEmpty: "Brak zadań wytrwałe.",
  recoverHeading: "Odzyskanie konta (weryfikacja ręczna)",
  recoverIntro:
    "Odzyskanie unieważnia wszystkie sesje i metody logowania osoby, zachowując konto, członkostwa i historię. Osoba musi ustawić nową metodę logowania.",
  recoverUserLabel: "Identyfikator konta (userId)",
  recoverBasisLabel: "Podstawa weryfikacji tożsamości",
  recoverBasisPlaceholder: "np. potwierdzenie tożsamości przez wizję lokalną / telefon",
  recoverSubmit: "Odzyskaj konto",
  recovering: "Odzyskujemy konto…",
  recoveredNotice: (revoked: number, cleared: number): string =>
    `Konto odzyskane. Unieważnione sesje: ${revoked}. Usunięte metody logowania: ${cleared}.`,
  onboardHeading: "Nowa firma w alfie z pierwszym administratorem",
  onboardIntro:
    "Firma powstaje pod Twoim uprawnieniem GM (nie uzyskujesz członkostwa), uczestniczy w alfie, a pierwszy administrator wchodzi przez zwykłe zaproszenie.",
  onboardNameLabel: "Nazwa firmy",
  onboardTimezoneLabel: "Strefa czasu firmy",
  onboardCurrencyLabel: "Waluta domyślna (3 litery)",
  onboardEmailLabel: "Adres e-mail pierwszego administratora",
  onboardBasisLabel: "Podstawa wdrożenia",
  onboardSubmit: "Utwórz firmę i zaproś",
  onboarding: "Tworzymy firmę…",
  onboardedNotice: "Firma utworzona i objęta alfą. Zaproszenie dla pierwszego administratora wystawione.",
  activateHeading: "Objęcie firmy udziałem w alfie",
  activateIntro: "Bez otwartego udziału w alfie firma jest niedostępna dla trybu GM.",
  activateCompanyLabel: "Identyfikator firmy (companyId)",
  activateBasisLabel: "Podstawa objęcia",
  activateSubmit: "Rozpocznij udział w alfie",
  activating: "Rozpoczynamy udział…",
  activatedNotice: "Firma objęta udziałem w alfie.",
  restoreHeading: "Przywrócenie administratora",
  restoreIntro:
    "Awans jednego aktywnego członka firmy na administratora pod uprawnieniem GM, z wpisem w dzienniku.",
  restoreCompanyLabel: "Identyfikator firmy (companyId)",
  restoreUserLabel: "Identyfikator konta (userId)",
  restoreBasisLabel: "Podstawa przywrócenia",
  restoreSubmit: "Przywróć administratora",
  restoring: "Przywracamy…",
  restoredNotice: "Administrator przywrócony.",
  endAlphaHeading: "Zakończenie udziału firmy w alfie",
  endAlphaIntro:
    "Dostęp GM do firmy wygasa natychmiast; członkostwa i historia firmy pozostają bez zmian. Upływ czasu sam w sobie nie kończy udziału.",
  endAlphaCompanyLabel: "Identyfikator firmy (companyId)",
  endAlphaBasisLabel: "Podstawa zakończenia",
  endAlphaSubmit: "Zakończ udział w alfie",
  endAlphaConfirm:
    "Zakończyć udział tej firmy w alfie? Twój dostęp GM do niej wygaśnie natychmiast.",
  endingAlpha: "Kończymy udział…",
  endedAlphaNotice: "Udział firmy w alfie zakończony.",
} as const;

/**
 * Machine-readable GM failure causes the UI distinguishes beyond the
 * server's Polish message (codes are stable English identifiers).
 */
export type GmFailureCode = string;

/** Extra Polish hints for the load-bearing closed-error codes. */
const codeHints: Record<GmFailureCode, string> = {
  gm_mode_not_active:
    "Tryb GM nie jest aktywny. Najpierw wejdź w tryb GM, podając podstawę.",
  gm_not_designated:
    "To konto nie jest wskazane jako operator GM w tej instalacji.",
  gm_mode_already_active:
    "Tryb GM jest już aktywny. Najpierw zakończ obecny tryb.",
  gm_grant_not_open: "Ten tryb GM jest już zakończony.",
  gm_not_own_grant: "Możesz zakończyć tylko własny tryb GM.",
  gm_reason_invalid: "Podstawa musi być wypełniona (do 500 znaków).",
  gm_basis_invalid: "Podstawa musi być wypełniona (do 500 znaków).",
  company_not_found: "Nie znaleziono takiej firmy.",
  company_alpha_not_active:
    "Ta firma nie uczestniczy obecnie w alfie. Dostęp GM do niej nie obowiązuje.",
  company_alpha_already_active: "Ta firma już uczestniczy w alfie.",
  target_membership_not_found:
    "Ta osoba nie jest obecnie członkiem wskazanej firmy.",
  account_not_found: "Nie znaleziono takiego konta.",
  one_active_company_rule:
    "Ta osoba należy już do firmy. W tej wersji Kiero można należeć do jednej aktywnej firmy.",
};

/** The Polish hint for a closed-error code, or null when the server message suffices. */
export function gmFailureHint(code: GmFailureCode | undefined): string | null {
  if (code === undefined) {
    return null;
  }
  return codeHints[code] ?? null;
}
