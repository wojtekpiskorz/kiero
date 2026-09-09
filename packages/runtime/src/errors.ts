/**
 * Closed-error constructors and sanitization for the platform runtime.
 *
 * Every error crossing an operation seam is one of the closed union kinds from
 * `@kiero/contracts`. Construction always decodes through the schema (no
 * unchecked objects), and `sanitizeUnknownError` maps arbitrary internal
 * failures to a sanitized `unavailable` error: internal messages, stacks and
 * provider payloads have nowhere to go by construction.
 *
 * Messages are stable Polish user-facing copy (see CONTEXT.md language rules;
 * codes are stable machine-readable English identifiers).
 */

import { Schema } from "effect";
import { ClosedError } from "@kiero/contracts";

const decodeClosedError = Schema.decodeUnknownSync(ClosedError);

/** Polish user-facing copy (stable; safe to show). */
export const closedErrorMessages = {
  validation: "Kiero nie przyjęło tych danych. Popraw je i spróbuj ponownie.",
  unauthenticated: "Najpierw się zaloguj.",
  forbidden: "Nie masz uprawnień do tej czynności.",
  notFound: "Nie znaleziono.",
  conflict: "Dane zmieniły się w międzyczasie. Odśwież i spróbuj ponownie.",
  idempotencyConflict: "Ta operacja była już wykonana z innymi danymi.",
  unsupported: "Ta operacja nie jest jeszcze dostępna.",
  unavailable: "Chwilowy błąd po stronie Kiero. Spróbuj ponownie za chwilę.",
} as const;

/** Constructs a sanitized `validation` closed error. */
export function validationError(code: string): ClosedError {
  return decodeClosedError({
    _tag: "validation",
    code,
    message: closedErrorMessages.validation,
  });
}

/** Constructs a sanitized `unauthenticated` closed error. */
export function unauthenticatedError(code = "no_verified_identity"): ClosedError {
  return decodeClosedError({
    _tag: "unauthenticated",
    code,
    message: closedErrorMessages.unauthenticated,
  });
}

/** Constructs a sanitized `forbidden` closed error. */
export function forbiddenError(code = "access_denied", entity?: string): ClosedError {
  return decodeClosedError({
    _tag: "forbidden",
    code,
    message: closedErrorMessages.forbidden,
    ...(entity === undefined ? {} : { entity }),
  });
}

/** Constructs a sanitized `not_found` closed error. */
export function notFoundError(entity: string, code = "record_not_found"): ClosedError {
  return decodeClosedError({
    _tag: "not_found",
    code,
    entity,
    message: closedErrorMessages.notFound,
  });
}

/** Constructs a sanitized `conflict` closed error. */
export function conflictError(
  code = "state_mismatch",
  recordTable?: string,
  recordId?: string,
): ClosedError {
  return decodeClosedError({
    _tag: "conflict",
    code,
    message: closedErrorMessages.conflict,
    ...(recordTable === undefined ? {} : { recordTable }),
    ...(recordId === undefined ? {} : { recordId }),
  });
}

/** Constructs a sanitized `idempotency_conflict` closed error. */
export function idempotencyConflictError(idempotencyKey: string): ClosedError {
  return decodeClosedError({
    _tag: "idempotency_conflict",
    code: "same_key_different_operation",
    idempotencyKey,
    message: closedErrorMessages.idempotencyConflict,
  });
}

/** Constructs a sanitized `unsupported` closed error. */
export function unsupportedError(operation: string, code = "not_implemented"): ClosedError {
  return decodeClosedError({
    _tag: "unsupported",
    code,
    operation,
    message: closedErrorMessages.unsupported,
  });
}

/** Constructs a sanitized `unavailable` closed error. */
export function unavailableError(retryable: boolean, code = "internal_failure"): ClosedError {
  return decodeClosedError({
    _tag: "unavailable",
    code,
    retryable,
    message: closedErrorMessages.unavailable,
  });
}

/**
 * Maps an arbitrary internal failure to a sanitized closed error.
 *
 * Effect `SchemaError` (input rejected by a contract schema) becomes
 * `validation`; `ValidationError` thrown by Convex validators becomes
 * `validation`; everything else becomes `unavailable`. The internal message,
 * stack and cause never leave this function.
 */
export function sanitizeUnknownError(cause: unknown): ClosedError {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = (cause as { _tag: string })._tag;
    if (tag === "ParseError" || tag === "SchemaError") {
      return validationError("input_rejected_by_contract_schema");
    }
  }
  if (cause instanceof Error && cause.name === "ValidationError") {
    // Convex runtime validator rejection at a function boundary.
    return validationError("input_rejected_by_convex_validator");
  }
  return unavailableError(true, "internal_failure");
}
