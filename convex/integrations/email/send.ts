/**
 * Application email facade: render + deliver one Kiero email.
 *
 * B1's sign-in OTP calls `deliverApplicationEmail` from its provider
 * config (convex/access/identity/authEntry.ts); B3's invitations will
 * call the same function with the invitation template. The facade keeps
 * ONE delivery path with typed, sanitized outcomes (the adapter owns the
 * HTTP details; this file owns template selection and the Polish error
 * surface callers show when delivery cannot be proven).
 *
 * Safe failure: outcomes never contain the code, the key, the provider
 * payload or any URL — only machine-readable reasons and Polish copy.
 */

import { renderApplicationEmail, type ApplicationEmail } from "./copy";
import {
  resendDepsFromEnv,
  sendViaResend,
  RESEND_API_KEY_NAME,
  type EmailDeliveryOutcome,
} from "./resend";

export type { EmailDeliveryOutcome };

/** Polish copy for delivery paths that cannot send (barebones UI text). */
export const emailDeliveryFailureCopy = {
  not_configured:
    "Kiero nie może teraz wysłać wiadomości: usługa poczty nie jest skonfigurowana. Skontaktuj się z administratorem.",
  rejected:
    "Kiero nie mogło wysłać wiadomości na ten adres. Sprawdź adres i spróbuj ponownie.",
  unknown:
    "Nie wiemy, czy wiadomość została wysłana. Poczekaj chwilę i poproś o nowy kod.",
} as const;

/** Maps a delivery outcome to the user-facing copy (safe to display). */
export function deliveryFailureCopy(outcome: EmailDeliveryOutcome): string | null {
  switch (outcome.outcome) {
    case "sent":
      return null;
    case "failed":
      return outcome.reason === "not_configured"
        ? emailDeliveryFailureCopy.not_configured
        : emailDeliveryFailureCopy.rejected;
    case "unknown":
      return emailDeliveryFailureCopy.unknown;
  }
}

/**
 * Renders and sends one application email.
 *
 * Env is injected (a plain record) so tests drive every branch without
 * touching the process environment; production passes `process.env`
 * (names only are ever read: RESEND_API_KEY, RESEND_FROM).
 */
export async function deliverApplicationEmail(
  to: string,
  email: ApplicationEmail,
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string } = process.env,
): Promise<EmailDeliveryOutcome> {
  const rendered = renderApplicationEmail(email);
  return await sendViaResend(
    { to, subject: rendered.subject, text: rendered.text },
    resendDepsFromEnv(env),
  );
}

/** Re-exported so callers can cite the key name without importing env. */
export { RESEND_API_KEY_NAME };

/**
 * Machine marker prefixing OUR delivery-failure messages, so client-side
 * classification keys on it instead of Polish prose. The web feature's
 * twin literal is pinned equal by tests/b1.
 */
export const EMAIL_DELIVERY_FAILED_MARKER = "[kiero:email_delivery_failed]";
