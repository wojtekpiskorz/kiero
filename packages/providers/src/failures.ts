/**
 * Provider failure classification (E2).
 *
 * A provider failure is classified into a closed vocabulary BEFORE any
 * fallback decision, and only the classification survives: provider error
 * bodies, exception messages, stacks and raw payloads have nowhere to go in
 * these types (architecture: secrets, prompts, source bodies, media,
 * transcripts and tokens stay out of general diagnostics).
 *
 * Fallback policy (issue acceptance criteria): an ordered fallback attempt
 * happens ONLY on a classified eligible failure — a transport/availability
 * problem with the route that was actually tried. Incompatible output
 * (malformed JSON, schema mismatch, unknown tool name, wrong vector
 * dimensions) fails closed: trying another model would mask a capability
 * incompatibility the corpus runner (J3) must observe, and provider output
 * must never be normalized into acceptance.
 */

import { Schema } from "effect";
import { ClosedError } from "@kiero/contracts";
import type { ClosedErrorKind } from "@kiero/contracts";

/** Closed vocabulary of provider failure kinds. */
export const ProviderFailureKind = Schema.Literals([
  /** The bounded per-attempt deadline was exceeded (our AbortController). */
  "deadline_exceeded",
  /** Network-level failure before a provider response existed. */
  "connection_failed",
  /** The route reported rate limiting (429). */
  "rate_limited",
  /** The route/model was unavailable (404, 408, 5xx, provider overloaded). */
  "provider_unavailable",
  /** The API key was rejected (401): configuration problem, not a route problem. */
  "unauthenticated",
  /** Credits/quota exhausted (402): configuration/budget problem. */
  "insufficient_credits",
  /** The route rejected a requested parameter (400): capability mismatch. */
  "unsupported_parameters",
  /** The response did not decode: malformed JSON or schema mismatch. */
  "output_rejected",
  /** The model called a tool that was not declared in the request. */
  "unknown_tool",
]);
export type ProviderFailureKind = Schema.Schema.Type<typeof ProviderFailureKind>;

/** The sanitized outcome of one classified provider failure. */
export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  /** Whether the ordered fallback loop may try the next accepted model. */
  readonly fallbackEligible: boolean;
}

/**
 * Failures for which the accepted order's next model may be tried.
 * Everything else (auth, credits, parameter rejection, incompatible output)
 * is terminal for the call: recorded, reported, never retried into another
 * model.
 */
const FALLBACK_ELIGIBLE: ReadonlySet<ProviderFailureKind> = new Set([
  "deadline_exceeded",
  "connection_failed",
  "rate_limited",
  "provider_unavailable",
]);

/** Constructs the sanitized failure for a classified kind. */
export function providerFailure(kind: ProviderFailureKind): ProviderFailure {
  return { kind, fallbackEligible: FALLBACK_ELIGIBLE.has(kind) };
}

/** Maps an HTTP status observed on a provider call to a failure kind. */
export function classifyStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) {
    return providerFailure("unauthenticated");
  }
  if (status === 402) {
    return providerFailure("insufficient_credits");
  }
  if (status === 400 || status === 422) {
    return providerFailure("unsupported_parameters");
  }
  if (status === 429) {
    return providerFailure("rate_limited");
  }
  return providerFailure("provider_unavailable");
}

/**
 * Classifies a failure reported by the TanStack adapter as an AG-UI
 * RUN_ERROR event (or a thrown error) using only its machine-readable
 * `code` — never the message text, which is provider-controlled.
 *
 * `code === "aborted"` is the adapter's shape for an aborted/deadline hit;
 * numeric codes are HTTP statuses. An unrecognized/absent code from a
 * stream-level failure is treated as route unavailability: it keeps the
 * bounded loop moving instead of hanging, and the kind is recorded so the
 * probe evidence can demand better codes later.
 */
export function classifyChatFailure(code: string | number | undefined): ProviderFailure {
  if (code === "aborted" || code === "AbortError" || code === "TimeoutError") {
    return providerFailure("deadline_exceeded");
  }
  const status = typeof code === "number" ? code : Number(code);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return classifyStatus(status);
  }
  return providerFailure("provider_unavailable");
}

/**
 * Classifies an error thrown by the OpenRouter SDK (STT/embeddings paths).
 * Uses `statusCode` when present; abort/timeout shapes map to the deadline;
 * everything unrecognized is connection-level (nothing was decoded).
 */
export function classifySdkFailure(cause: unknown): ProviderFailure {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { name: string }).name === "PermanentError"
  ) {
    // SDK retry machinery signalled a non-retryable condition upstream.
    return providerFailure("unsupported_parameters");
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "statusCode" in cause &&
    typeof (cause as { statusCode: unknown }).statusCode === "number"
  ) {
    return classifyStatus((cause as { statusCode: number }).statusCode);
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { name: string }).name === "RequestTimeoutError"
  ) {
    return providerFailure("deadline_exceeded");
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
    return providerFailure("deadline_exceeded");
  }
  return providerFailure("connection_failed");
}

/** Mapping of provider failure kinds to closed operation error kinds. */
const CLOSED_KIND: Readonly<Record<ProviderFailureKind, ClosedErrorKind>> = {
  deadline_exceeded: "unavailable",
  connection_failed: "unavailable",
  rate_limited: "unavailable",
  provider_unavailable: "unavailable",
  unauthenticated: "unauthenticated",
  insufficient_credits: "unavailable",
  unsupported_parameters: "unavailable",
  output_rejected: "validation",
  unknown_tool: "validation",
};

/** Stable machine-readable closed-error codes per provider failure kind. */
const CLOSED_CODE: Readonly<Record<ProviderFailureKind, string>> = {
  deadline_exceeded: "provider_deadline_exceeded",
  connection_failed: "provider_connection_failed",
  rate_limited: "provider_rate_limited",
  provider_unavailable: "provider_unavailable",
  unauthenticated: "provider_key_rejected",
  insufficient_credits: "provider_credits_exhausted",
  unsupported_parameters: "provider_rejected_parameters",
  output_rejected: "provider_output_rejected",
  unknown_tool: "provider_unknown_tool",
};

/** Polish user-facing copy for provider failures (safe to show; no internals). */
const CLOSED_MESSAGE: Readonly<Record<ProviderFailureKind, string>> = {
  deadline_exceeded: "Model nie odpowiedział na czas. Spróbuj ponownie za chwilę.",
  connection_failed: "Chwilowy błąd połączenia z modelem. Spróbuj ponownie za chwilę.",
  rate_limited: "Model jest chwilowo przeciążony. Spróbuj ponownie za chwilę.",
  provider_unavailable: "Wybrana trasa modelu jest chwilowo niedostępna.",
  unauthenticated: "Kiero nie może teraz korzystać z modeli. Zgłoś to administratorowi.",
  insufficient_credits: "Limit środków na modele został wyczerpany.",
  unsupported_parameters: "Wybrana trasa modelu nie obsługuje wymaganych parametrów.",
  output_rejected: "Model zwrócił nieprawidłową odpowiedź. Spróbuj ponownie.",
  unknown_tool: "Model wywołał nieznaną funkcję. Spróbuj ponownie.",
};

/** The closed-error projection of one provider failure kind (sanitized). */
export function failureToClosedError(failure: ProviderFailure): ClosedError {
  return Schema.decodeUnknownSync(ClosedError)({
    _tag: CLOSED_KIND[failure.kind],
    code: CLOSED_CODE[failure.kind],
    message: CLOSED_MESSAGE[failure.kind],
    ...(CLOSED_KIND[failure.kind] === "unavailable"
      ? { retryable: failure.fallbackEligible }
      : {}),
  });
}
