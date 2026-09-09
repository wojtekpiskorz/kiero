/**
 * The TanStack tool/schema adapter conversion path.
 *
 * The selected AI SDK is TanStack AI (`@tanstack/ai`); tool and structured
 * output schemas are Standard Schema inputs converted to JSON Schema by the
 * adapter's own converter (`convertSchemaToJsonSchema`). Effect Schema exposes
 * that interface after `Schema.toStandardJSONSchemaV1` attaches the
 * `~standard.jsonSchema` converter (target draft-07).
 *
 * This module is the one wiring between the A2 contract schemas and that
 * converter. It makes no provider calls; E2 reuses it against OpenRouter.
 */

import { Schema } from "effect";
import { convertSchemaToJsonSchema } from "@tanstack/ai";

/**
 * Converts a contract schema into the JSON Schema the TanStack adapter sends
 * to providers. Deterministic and provider-free: the same schema always
 * yields the same JSON Schema.
 */
export function toolJsonSchema<Type, Encoded>(
  schema: Schema.Codec<Type, Encoded, never, never>,
): Record<string, unknown> {
  const standard = Schema.toStandardJSONSchemaV1(schema);
  const converted = convertSchemaToJsonSchema(standard);
  if (converted === undefined || typeof converted !== "object") {
    throw new Error("toolJsonSchema: the TanStack converter returned no schema");
  }
  return converted;
}

/**
 * The structured-output variant: the adapter widens optional fields to
 * null-unions for strict provider modes. Exposed so the conversion proof can
 * pin both halves of the adapter's behavior.
 */
export function toolJsonSchemaForStructuredOutput<Type, Encoded>(
  schema: Schema.Codec<Type, Encoded, never, never>,
): Record<string, unknown> {
  const standard = Schema.toStandardJSONSchemaV1(schema);
  const converted = convertSchemaToJsonSchema(standard, { forStructuredOutput: true });
  if (converted === undefined || typeof converted !== "object") {
    throw new Error("toolJsonSchemaForStructuredOutput: the TanStack converter returned no schema");
  }
  return converted;
}
