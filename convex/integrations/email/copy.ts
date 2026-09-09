/**
 * Application email copy (Polish, product text per AGENTS.md).
 *
 * One home for every email Kiero sends through the Resend adapter
 * (architecture: Integrations "send application email"; Resend selected in
 * Q209). B1 owns the sign-in code template and the shared rendering; B3
 * owns finalizing the invitation template through the same adapter; B2
 * added the linking-ceremony and email-change code templates (same shape:
 * code, expiry, nothing else).
 *
 * The renderer is pure and unit-tested: outputs carry the code, the
 * expiry and nothing else; no secrets, tokens or internal paths appear in
 * email text.
 */

/** When the rendered copy says the code stops working. */
export function formatExpiryPl(expiresAtMs: number): string {
  return new Date(expiresAtMs).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export interface SignInCodeEmail {
  readonly kind: "sign_in_code";
  /** The one-time code (never logged, only emailed). */
  readonly code: string;
  readonly expiresAtMs: number;
}

export interface InvitationEmail {
  readonly kind: "invitation_code";
  /** Company name extending the invitation (B3 wires real values). */
  readonly companyName: string;
  readonly code: string;
  readonly expiresAtMs: number;
}

/** B2: the one-time code proving control of a method inside a linking ceremony. */
export interface MethodLinkCodeEmail {
  readonly kind: "method_link_code";
  readonly code: string;
  readonly expiresAtMs: number;
}

/** B2: the one-time code confirming a new address during an email change. */
export interface EmailChangeCodeEmail {
  readonly kind: "email_change_code";
  readonly code: string;
  readonly expiresAtMs: number;
}

/** Every application email Kiero can currently send. */
export type ApplicationEmail =
  | SignInCodeEmail
  | InvitationEmail
  | MethodLinkCodeEmail
  | EmailChangeCodeEmail;

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
}

/** Renders one application email (pure; Polish product copy). */
export function renderApplicationEmail(email: ApplicationEmail): RenderedEmail {
  switch (email.kind) {
    case "sign_in_code":
      return {
        subject: "Kiero — kod do logowania",
        text: [
          "Dzień dobry,",
          "",
          `Twój kod do zalogowania w Kiero: ${email.code}`,
          "",
          `Kod działa do ${formatExpiryPl(email.expiresAtMs)}.`,
          "Jeśli to nie Ty prosiłeś o kod, zignoruj tę wiadomość.",
          "",
          "— Kiero",
        ].join("\n"),
      };
    case "invitation_code":
      return {
        subject: "Kiero — zaproszenie do firmy",
        text: [
          "Dzień dobry,",
          "",
          `Zaproszenie do firmy ${email.companyName} w Kiero.`,
          `Kod zaproszenia: ${email.code}`,
          "",
          `Kod działa do ${formatExpiryPl(email.expiresAtMs)}.`,
          "",
          "— Kiero",
        ].join("\n"),
      };
    case "method_link_code":
      return {
        subject: "Kiero — kod do potwierdzenia metody logowania",
        text: [
          "Dzień dobry,",
          "",
          `Kod do potwierdzenia metody logowania w Kiero: ${email.code}`,
          "",
          `Kod działa do ${formatExpiryPl(email.expiresAtMs)}.`,
          "Jeśli to nie Ty łączysz metody logowania, zignoruj tę wiadomość.",
          "",
          "— Kiero",
        ].join("\n"),
      };
    case "email_change_code":
      return {
        subject: "Kiero — kod do zmiany adresu e-mail",
        text: [
          "Dzień dobry,",
          "",
          `Kod do potwierdzenia nowego adresu e-mail w Kiero: ${email.code}`,
          "",
          `Kod działa do ${formatExpiryPl(email.expiresAtMs)}.`,
          "Jeśli to nie Ty zmieniasz adres e-mail, zignoruj tę wiadomość.",
          "",
          "— Kiero",
        ].join("\n"),
      };
  }
}
