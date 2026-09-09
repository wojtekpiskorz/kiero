/**
 * Checked input decoding against contract schemas.
 *
 * This is the one validation path for operation input: the operation entry's
 * Effect Schema decodes untrusted input BEFORE any handler runs, so invalid
 * input reaches no domain effect. The same schemas expose Standard Schema
 * `~standard.validate`, which is the integration point the TanStack AI tool
 * adapter uses (see ./tools.ts).
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { validationError } from "./errors";

/** The outcome of decoding untrusted input: either a value or a closed error. */
export type DecodeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResultEnvelope };

/**
 * Decodes untrusted input against a contract codec.
 *
 * Returns an error envelope (not a throw): the closed `validation` error is a
 * value like any other result. Callers must not run any domain work when
 * `ok === false`.
 */
export function decodeInput<T>(
  codec: Schema.Codec<T, unknown, never, never>,
  input: unknown,
): DecodeOutcome<T> {
  const decoded = Schema.decodeUnknownOption(codec)(input);
  if (decoded._tag === "Some") {
    return { ok: true, value: decoded.value };
  }
  return { ok: false, error: errorResult(validationError("input_rejected_by_contract_schema")) };
}

/**
 * Validates input through the Standard Schema v1 interface.
 *
 * Effect schemas implement `~standard` after `Schema.toStandardSchema`; this
 * exercises exactly the interface TanStack AI tools and any other
 * standard-schema consumer see. Returns the same closed-error envelope shape.
 */
export async function validateStandard<T>(
  codec: Schema.Codec<T, unknown, never, never>,
  input: unknown,
): Promise<DecodeOutcome<T>> {
  const standard = Schema.toStandardSchemaV1(codec);
  const result = await standard["~standard"].validate(input);
  if (result.issues === undefined) {
    return { ok: true, value: result.value };
  }
  return { ok: false, error: errorResult(validationError("input_rejected_by_contract_schema")) };
}

/** Wraps a decoded value into an ok envelope (identity helper). */
export function decodedOk(value: unknown): ResultEnvelope {
  return okResult(value);
}
