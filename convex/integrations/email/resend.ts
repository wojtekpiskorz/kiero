/**
 * The Resend adapter: the one HTTP delivery path for application email.
 *
 * Reusable by design — B1's sign-in OTP and B3's invitations both send
 * through `sendViaResend`; only the rendered copy differs (./copy.ts).
 *
 * Server-side key handling: the API key is read from the environment by
 * NAME (`RESEND_API_KEY`) inside the server runtime only, never imported
 * by web client code, never logged and never included in a failure.
 * Delivery outcomes are typed and sanitized:
 *
 * - `sent`: the provider accepted and returned an email id;
 * - `failed/not_configured`: no key in the environment — recorded
 *   honestly, the code path stays testable without faking delivery;
 * - `failed/rejected`: the provider refused the request;
 * - `unknown`: the deadline fired after the request was sent (the email
 *   may have been delivered — retry-safe identity is owned upstream by
 *   the caller replacing, not duplicating, the pending message).
 *
 * The HTTP call enforces an explicit `AbortController` deadline
 * (A3 finding: `AbortSignal.timeout` is not guaranteed in the Convex
 * action runtime). No provider payload, header or URL crosses the seam.
 */

import { Schema } from "effect";

/** Resend's successful send response (the only fields we consume). */
const ResendSuccess = Schema.Struct({ id: Schema.String });

export interface ResendRequest {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Barebones: plain text only until a visual system exists. */
  readonly html?: string;
}

/** Environment variable names (values are never committed or logged). */
export const RESEND_API_KEY_NAME = "RESEND_API_KEY";
export const RESEND_FROM_NAME = "RESEND_FROM";

/**
 * Default sender: Resend's sandbox address works on the free plan for
 * development; production sets RESEND_FROM to the verified app sender.
 */
export const DEFAULT_RESEND_FROM = "Kiero <onboarding@resend.dev>";

export type EmailDeliveryOutcome =
  | { readonly outcome: "sent"; readonly providerEmailId: string }
  | {
      readonly outcome: "failed";
      readonly reason: "not_configured" | "rejected";
    }
  | {
      readonly outcome: "unknown";
      readonly reason: "deadline_exceeded" | "network_error" | "unexpected_response";
    };

/** Injectable seams so every branch is unit-testable without a key. */
export interface ResendDeps {
  readonly fetchImpl: typeof fetch;
  readonly apiKey: string | undefined;
  readonly from: string;
  readonly deadlineMs: number;
}

/** Reads the environment by NAME only; absence is an honest outcome. */
export function resendDepsFromEnv(env: {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
}): ResendDeps {
  return {
    fetchImpl: fetch,
    apiKey: env.RESEND_API_KEY === "" ? undefined : env.RESEND_API_KEY,
    from: env.RESEND_FROM && env.RESEND_FROM.length > 0 ? env.RESEND_FROM : DEFAULT_RESEND_FROM,
    deadlineMs: 8_000,
  };
}

/** Sends one application email through Resend. */
export async function sendViaResend(
  request: ResendRequest,
  deps: ResendDeps,
): Promise<EmailDeliveryOutcome> {
  if (deps.apiKey === undefined) {
    return { outcome: "failed", reason: "not_configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.deadlineMs);
  try {
    const response = await deps.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: deps.from,
        to: [request.to],
        subject: request.subject,
        text: request.text,
        ...(request.html === undefined ? {} : { html: request.html }),
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const decoded = Schema.decodeUnknownOption(ResendSuccess)(body);
      if (decoded._tag === "Some") {
        return { outcome: "sent", providerEmailId: decoded.value.id };
      }
      // 2xx with an unexpected shape: never counted as success.
      return { outcome: "unknown", reason: "unexpected_response" };
    }
    // Non-2xx: the provider refused the send. Its payload is dropped here;
    // only the sanitized fact crosses the seam.
    return { outcome: "failed", reason: "rejected" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { outcome: "unknown", reason: "deadline_exceeded" };
    }
    return { outcome: "unknown", reason: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
