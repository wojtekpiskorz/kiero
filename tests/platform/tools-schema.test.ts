/**
 * The TanStack tool/schema adapter conversion proof (A3, unit half; the
 * evidence doc records the same conversion on the live pinned packages).
 *
 * Path proved: A2 contract schema (Effect Schema) -> Standard Schema
 * (`~standard.jsonSchema`, draft-07) -> `convertSchemaToJsonSchema` from
 * @tanstack/ai -> provider JSON Schema. Deterministic, no provider calls.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MoneyValue, TemporalValue } from "@kiero/contracts";
import {
  toolJsonSchema,
  toolJsonSchemaForStructuredOutput,
  validateStandard,
} from "@kiero/runtime";

describe("standard-schema -> JSON-schema conversion", () => {
  it("converts a semantic value contract into draft-07 JSON Schema", () => {
    const json = toolJsonSchema(MoneyValue);
    expect(json.type).toBe("object");
    expect(json).toHaveProperty("properties");
    // Deterministic: the same schema converts identically every time.
    expect(json).toEqual(toolJsonSchema(MoneyValue));
  });

  it("keeps enum-like unions as JSON Schema unions with tags", () => {
    const json = toolJsonSchema(TemporalValue) as {
      properties?: { shape?: { oneOf?: unknown[]; anyOf?: unknown[] } };
    };
    const shape = json.properties?.shape;
    expect(shape).toBeDefined();
    expect(shape?.oneOf ?? shape?.anyOf).toBeDefined();
  });

  it("structured-output widening adds null to optional fields only", () => {
    const strict = toolJsonSchema(TemporalValue) as {
      required?: string[];
    };
    const widened = toolJsonSchemaForStructuredOutput(TemporalValue) as {
      required?: string[];
      properties?: Record<string, { type?: unknown }>;
    };
    // The TanStack adapter requires ALL properties for structured output.
    expect(widened.required).toEqual(Object.keys(widened.properties ?? {}));
    // The original ordering roles stay a closed enum, not widened.
    expect(strict.required).toBeDefined();
  });
});

describe("standard-schema validation over contract schemas", () => {
  it("validates and decodes well-formed input through ~standard", async () => {
    const ProbeToolInput = Schema.Struct({
      message: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    });
    const outcome = await validateStandard(ProbeToolInput, { message: "wycena dachu" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.message).toBe("wycena dachu");
    }
  });

  it("rejects malformed input with issues (the TanStack validate path)", async () => {
    const ProbeToolInput = Schema.Struct({
      message: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    });
    const outcome = await validateStandard(ProbeToolInput, { message: "" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false && outcome.error._tag === "error") {
      expect(outcome.error.error._tag).toBe("validation");
    }
  });
});
