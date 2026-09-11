/**
 * The export worker's envelope constructors (I3): the wire shape of the
 * typed result envelopes this worker answers to the Convex build action.
 * Zero-dependency on purpose — the container image runs plain Node with no
 * bundled workspace packages (the D6 zero-dependency ruling) — while the
 * Convex side still DECODES every answer through the one certified
 * `ResultEnvelope` schema (convex/operations/exports/executor.ts), so a
 * malformed answer can never be mistaken for success. The shapes here are
 * the serialization of that contract, never a second validator.
 */

export type WireErrorKind =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "unsupported"
  | "unavailable";

export interface WireEnvelope {
  readonly _tag: "ok" | "error";
  readonly value?: unknown;
  readonly error?: {
    readonly _tag: WireErrorKind;
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

export function okEnvelope(value: unknown): WireEnvelope {
  return { _tag: "ok", value };
}

export function errorEnvelope(
  _tag: WireErrorKind,
  code: string,
  message = "Przygotowanie eksportu nie powiodło się.",
  retryable?: boolean,
): WireEnvelope {
  return {
    _tag: "error",
    error: { _tag, code, message, ...(retryable === undefined ? {} : { retryable }) },
  };
}
