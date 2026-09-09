/**
 * Closed, sanitized error contract.
 *
 * Every operation result carries either a payload or one of these errors.
 * The union is closed: adding a kind is a coordinated contract change. The
 * payload is sanitized by construction: there is no field for stacks,
 * provider payloads, internal paths or raw exception messages. A `message`
 * here is stable, safe-to-show text (Polish user-facing copy in the product),
 * not a forwarded internal error string.
 *
 * `unsupported` is the honest failure of contract placeholders: until a lane
 * implements an operation, invoking it fails closed with `unsupported` and
 * never claims business work. Candidate contract until A3 certifies it.
 */

import { Schema } from "effect";
import { ExpectedRecordTable } from "./tableIds";

/** Closed vocabulary of error kinds. */
export const ClosedErrorKind = Schema.Literals([
  "validation",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "unsupported",
  "unavailable",
]);
export type ClosedErrorKind = Schema.Schema.Type<typeof ClosedErrorKind>;

/** Stable machine-readable detail within a kind (e.g. `revision_mismatch`). */
export const ErrorCode = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)),
  Schema.brand("ErrorCode"),
);
export type ErrorCode = Schema.Schema.Type<typeof ErrorCode>;

const Base = {
  code: ErrorCode,
  message: Schema.NonEmptyString,
};

/** The closed error type. No internals can leak: there is nowhere to put them. */
export const ClosedError = Schema.TaggedUnion({
  validation: { ...Base },
  unauthenticated: { ...Base },
  forbidden: { ...Base, entity: Schema.optionalKey(Schema.NonEmptyString) },
  not_found: { ...Base, entity: Schema.NonEmptyString },
  conflict: {
    ...Base,
    recordTable: Schema.optionalKey(ExpectedRecordTable),
    recordId: Schema.optionalKey(Schema.String),
  },
  idempotency_conflict: { ...Base, idempotencyKey: Schema.String },
  unsupported: { ...Base, operation: Schema.NonEmptyString },
  unavailable: { ...Base, retryable: Schema.Boolean },
});
export type ClosedError = Schema.Schema.Type<typeof ClosedError>;

const decodeClosedError = Schema.decodeUnknownSync(ClosedError);

/**
 * Constructs the fail-closed error for a not-yet-implemented operation.
 * Built by decoding through the schema: no unchecked construction.
 */
export function notImplemented(operationName: string): ClosedError {
  return decodeClosedError({
    _tag: "unsupported",
    code: "not_implemented",
    message: `Operacja ${operationName} nie jest jeszcze zaimplementowana.`,
    operation: operationName,
  });
}

/** Type guard mirroring the schema for narrow consumers. */
export function isClosedError(value: unknown): value is ClosedError {
  return Schema.is(ClosedError)(value);
}
