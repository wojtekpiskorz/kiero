/**
 * Membership feature state: Polish copy and the closed-error
 * classification for the B3 surface.
 *
 * The sign-in leg composes B1's exported state machine and copy
 * (../sign-in/state.ts) verbatim — same steps, same failure mapping — so
 * the mounted surface cannot drift from B1's product text. Membership
 * operation results arrive as `ResultEnvelope`s; every closed error maps
 * to honest Polish copy, with machine codes the tests can pin.
 */

import {
  classifySignInError,
  pendingLabel,
  sessionDeniedView,
  signInCopy,
  isValidEmail,
  type SessionDeniedView,
  type SessionDenialReason,
  type SignInFailure,
  type SignInState,
} from "../sign-in/state";

export {
  classifySignInError,
  pendingLabel,
  sessionDeniedView,
  signInCopy,
  isValidEmail,
};
export type {
  SessionDeniedView,
  SessionDenialReason,
  SignInFailure,
  SignInState,
};

/** Polish copy for the membership surface (stable product text). */
export const membershipCopy = {
  title: "Firma i członkostwo",
  intro:
    "Zarządzaj firmą, jej członkami i zaproszeniami. Dostęp do firmy odbywa się wyłącznie przez zaproszenie.",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  verifyingSession: "Rejestrujemy sesję tego urządzenia…",
  signedInAs: (email: string): string => `Zalogowano jako ${email}.`,
  signOut: "Wyloguj się",
  // Admission (no company yet)
  noCompanyHeading: "Nie należysz jeszcze do żadnej firmy",
  noCompanyIntro:
    "Możesz przyjąć zaproszenie od administratora swojej firmy albo założyć nową firmę i zostać jej pierwszym administratorem.",
  pendingInvitationsHeading: "Zaproszenia dla Ciebie",
  noPendingInvitations:
    "Brak oczekujących zaproszeń na Twój adres e-mail. Poproś administratora firmy o zaproszenie.",
  invitationFor: (companyName: string): string => `Firma ${companyName}`,
  invitationRole: {
    admin: "Rola: administrator firmy",
    member: "Rola: członek firmy",
  } as const,
  invitationCodeLabel: "Kod zaproszenia z wiadomości",
  invitationCodePlaceholder: "8 cyfr",
  acceptInvitation: "Przyjmij zaproszenie",
  rejectInvitation: "Odrzuć zaproszenie",
  invitationValidUntil: (expiresAtMs: number): string =>
    `Zaproszenie ważne do ${new Date(expiresAtMs).toLocaleString("pl-PL", {
      dateStyle: "medium",
      timeStyle: "short",
    })}.`,
  createCompanyHeading: "Załóż nową firmę",
  createCompanyIntro:
    "Zakładając firmę, zostajesz jej pierwszym administratorem: możesz zapraszać szefów i przekazywać im administrację.",
  companyNameLabel: "Nazwa firmy",
  companyNamePlaceholder: "np. Budowa Kowalscy",
  companyTimezoneLabel: "Strefa czasu firmy",
  companyCurrencyLabel: "Waluta domyślna (3 litery)",
  createCompany: "Załóż firmę",
  creatingCompany: "Zakładamy firmę…",
  // Member surface
  companyHeading: (name: string): string => `Firma ${name}`,
  companyMeta: (timezone: string, currency: string): string =>
    `Strefa czasu: ${timezone}. Waluta domyślna: ${currency}.`,
  yourRole: {
    admin: "Jesteś administratorem tej firmy.",
    member: "Jesteś członkiem tej firmy.",
  } as const,
  membersHeading: "Członkowie firmy",
  memberYou: "(to Ty)",
  memberRoleLabel: "Rola",
  changeRole: "Zmień rolę",
  transferAdmin: "Przekaż administrację",
  transferAdminConfirm:
    "Przekazać administrację tej osobie? Twoja rola zmieni się na członka firmy.",
  revokeMember: "Odbierz dostęp",
  revokeMemberConfirm: "Odebrać tej osobie dostęp do firmy? Jej dane i historia pozostaną zachowane.",
  leaveCompany: "Opuść firmę",
  leaveCompanyConfirm:
    "Opuścić firmę? Twój dostęp zakończy się natychmiast, a Twoje wiadomości i historia pozostaną zachowane.",
  invitationsHeading: "Zaproszenia",
  invitationsAdminNote:
    "Zaproszenie jest skierowane do jednego adresu e-mail, ważne 7 dni, jednorazowe i można je cofnąć.",
  inviteEmailLabel: "Adres e-mail zapraszanego szefa",
  inviteEmailPlaceholder: "np. brygadzista@firma.pl",
  inviteRoleLabel: "Rola zapraszanego",
  invite: "Zaproś",
  inviting: "Zapraszamy…",
  invitationState: {
    pending: "oczekujące",
    accepted: "przyjęte",
    revoked: "cofnięte",
    expired: "wygasłe",
    rejected: "odrzucone",
  } as const,
  revokeInvitation: "Cofnij zaproszenie",
  noInvitations: "Brak zaproszeń.",
  operationPending: "Wykonujemy…",
} as const;

/**
 * Machine-readable membership failure causes the UI distinguishes beyond
 * the server's Polish message (codes are stable English identifiers).
 */
export type MembershipFailureCode = string;

/** Extra Polish hints for the load-bearing closed-error codes. */
const codeHints: Record<MembershipFailureCode, string> = {
  one_active_company_rule:
    "Należysz już do firmy. W tej wersji Kiero można należeć do jednej aktywnej firmy.",
  invitation_expired: "Zaproszenie wygasło. Poproś administratora o nowe.",
  invitation_not_pending:
    "Zaproszenie zostało już użyte, cofnięte lub odrzucone. Poproś administratora o nowe.",
  invitation_not_addressed_to_actor:
    "To zaproszenie nie jest skierowane do Twojego adresu e-mail.",
  email_control_unproven:
    "Nie potwierdzono jeszcze władania tym adresem e-mail. Zaloguj się kodem wysłanym na ten adres.",
  verification_code_mismatch: "Kod zaproszenia jest nieprawidłowy. Sprawdź wiadomość i spróbuj ponownie.",
  last_administrator:
    "To ostatni administrator firmy. Najpierw przekaż administrację innej osobie.",
  invitation_already_pending:
    "Na ten adres czeka już aktywne zaproszenie tej firmy. Cofnij je, aby wysłać nowe.",
  target_membership_not_found:
    "Ta osoba nie jest obecnie członkiem Twojej firmy.",
  transfer_to_self: "Administrację można przekazać innej osobie, nie sobie.",
  membership_not_active: "To członkostwo jest już zakończone.",
  delivery_failed:
    "Zaproszenie zostało utworzone, ale wiadomość z kodem nie została wysłana. Cofnij je i spróbuj ponownie później.",
};

/** The Polish hint for a closed-error code, or null when the server message suffices. */
export function failureHint(code: MembershipFailureCode | undefined): string | null {
  if (code === undefined) {
    return null;
  }
  return codeHints[code] ?? null;
}
