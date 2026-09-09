/**
 * The proved conversion path (A2 focused verification).
 *
 * For every semantic value family in `convex/schema/shared.ts`:
 *
 * 1. a valid fixture is decoded through the pinned Effect 4 RC schema
 *    (unknown → decoded, malformed input throws `SchemaError`);
 * 2. the decoded value is encoded back to its wire form;
 * 3. the wire form survives the pinned Convex JSON serialization round trip
 *    (`convexToJson` → `jsonToConvex`), proving it is a legal Convex value;
 * 4. the Convex-wire value decodes again through the Effect schema to an
 *    equal value.
 *
 * The static half of the proof is this file compiling at all: every
 * `semanticValueValidators` entry is declared as
 * `Validator<Schema.Codec.Encoded<typeof SchemaX>, "required", string>`, so
 * the pinned Convex validator's inferred type must equal the Effect schema's
 * Encoded type exactly. There is no runtime untyped validate entry in the
 * pinned convex 1.45.0 (its `convexToJson` input is fully typed), so
 * deployment-time Convex validator enforcement remains A3's runtime proof.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { convexToJson, jsonToConvex, type JSONValue } from "convex/values";
import {
  ExtensionValue,
  FindingValue,
  KnowledgeState,
  MoneyValue,
  TemporalValue,
} from "@kiero/contracts";
import { semanticValueValidators } from "../../convex/schema/shared";

/**
 * decode → encode → Convex wire → decode → compare.
 *
 * `wire` is `convexToJson`, whose parameter type is the pinned Convex
 * `Value`. Passing it here forces the schema's Encoded type to be assignable
 * to `Value` at every concrete call site: a semantic value whose wire form
 * is not a legal Convex value fails to compile in this file. (Where generic
 * inference cannot resolve the schema's exact codec shape, call sites pin
 * D/E explicitly via the schema's own Type/Encoded accessors.)
 */
function roundTrip<D, E>(
  schema: Schema.Codec<D, E, never, never>,
  wire: (value: E) => JSONValue,
  fixture: unknown,
): void {
  const decoded = Schema.decodeUnknownSync(schema)(fixture);
  const encoded: E = Schema.encodeSync(schema)(decoded);
  const convexWire = jsonToConvex(wire(encoded));
  const decodedAgain = Schema.decodeUnknownSync(schema)(convexWire);
  // Compare encoded (plain data) forms: decoded instances may carry lazy
  // internal fields (e.g. BigDecimal normalization) that make structural
  // equality flaky without changing the value.
  expect(Schema.encodeSync(schema)(decodedAgain)).toEqual(encoded);
}

describe("semantic value conversion through the pinned validators", () => {
  it("all entries in the proved mapping are genuine pinned convex validators", () => {
    for (const [name, validator] of Object.entries(semanticValueValidators)) {
      expect(validator.isConvexValidator, name).toBe(true);
    }
    expect(Object.keys(semanticValueValidators).sort()).toEqual([
      "extensionValue",
      "findingValue",
      "knowledgeState",
      "moneyValue",
      "temporalValue",
    ]);
  });

  it("knowledge state round-trips through the Convex wire", () => {
    roundTrip(KnowledgeState, convexToJson, { _tag: "unknown", reason: "klient nie podał" });
    roundTrip(KnowledgeState, convexToJson, { _tag: "not_applicable" });
  });

  it("temporal value round-trips: date-only, timed and range", () => {
    roundTrip(TemporalValue, convexToJson, {
      shape: { _tag: "day", day: "2026-01-09" },
      originalExpression: "jutro",
      role: "agreed",
    });
    roundTrip(TemporalValue, convexToJson, {
      shape: { _tag: "date_time", value: "2026-01-05T10:30:00.000+01:00[Europe/Warsaw]" },
      originalExpression: "o 10:30",
      role: "actual",
    });
    roundTrip(TemporalValue, convexToJson, {
      shape: {
        _tag: "range",
        start: { _tag: "month", month: "2026-01" },
        end: { _tag: "month", month: "2026-03" },
      },
      originalExpression: "Q1",
      role: "internal",
    });
  });

  it("money round-trips exactly with not_specified basis", () => {
    roundTrip(MoneyValue, convexToJson, {
      role: "agreed_price",
      amount: { _tag: "exact", value: "1234.56" },
      currency: "PLN",
      currencyOrigin: "stated",
      taxBasis: "not_specified",
      certainty: "exact",
    });
    roundTrip(MoneyValue, convexToJson, {
      role: "estimated_labor",
      amount: { _tag: "range", min: "2000", max: null },
      currency: "PLN",
      currencyOrigin: "company_default",
      taxBasis: "not_specified",
      certainty: "estimate",
    });
  });

  it("extension and finding values round-trip", () => {
    roundTrip<Schema.Schema.Type<typeof ExtensionValue>, Schema.Codec.Encoded<typeof ExtensionValue>>(ExtensionValue, convexToJson, {
      _tag: "object",
      fields: [
        { fieldId: "width_mm", value: { _tag: "quantity", amount: "600", unit: "mm" } },
        { fieldId: "approved", value: { _tag: "boolean", value: true } },
      ],
    });
    roundTrip<Schema.Schema.Type<typeof FindingValue>, Schema.Codec.Encoded<typeof FindingValue>>(FindingValue, convexToJson, {
      _tag: "temporal",
      temporal: {
        shape: { _tag: "day", day: "2026-01-09" },
        originalExpression: "jutro",
        role: "proposed",
      },
    });
    roundTrip<Schema.Schema.Type<typeof FindingValue>, Schema.Codec.Encoded<typeof FindingValue>>(FindingValue, convexToJson, { _tag: "text_note", text: "kolor bananowy" });
  });

  it("rejects malformed and unknown input at the Effect boundary", () => {
    const cases: ReadonlyArray<
      [name: string, schema: Schema.Codec<unknown, unknown, never, never>, input: unknown]
    > = [
      ["knowledge bad state", KnowledgeState, { _tag: "guess" }],
      ["knowledge wrong key", KnowledgeState, { state: "known" }],
      ["temporal bad calendar day", TemporalValue, {
        shape: { _tag: "day", day: "2026-02-30" },
        originalExpression: "x",
        role: "agreed",
      }],
      ["money bad decimal", MoneyValue, {
        role: "agreed_price",
        amount: { _tag: "exact", value: "10.5.6" },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "net",
        certainty: "exact",
      }],
      ["extension unknown tag", ExtensionValue, { _tag: "html", text: "<b>x</b>" }],
      ["finding unknown tag", FindingValue, { _tag: "audio", blob: "..." }],
    ];
    for (const [name, schema, input] of cases) {
      try {
        Schema.decodeUnknownSync(schema)(input);
      } catch (error) {
        expect(Schema.isSchemaError(error), name).toBe(true);
        continue;
      }
      expect.unreachable(`expected rejection: ${name}`);
    }
  });

  it("encoded semantic values serialize through the pinned convex wire", () => {
    // The pinned convexToJson signature only accepts Convex values, so a
    // non-Convex payload (Date, symbol, class instance like BigDecimal)
    // cannot reach it through this typed boundary at all. Runtime evidence:
    // the encoder output of every semantic value is a plain Convex value.
    const encoded: Schema.Codec.Encoded<typeof MoneyValue> = Schema.encodeSync(MoneyValue)(
      Schema.decodeUnknownSync(MoneyValue)({
        role: "agreed_price",
        amount: { _tag: "exact", value: "10" },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "gross",
        certainty: "exact",
      }),
    );
    const json = convexToJson(encoded);
    expect(typeof json).toBe("object");
    // JSON.stringify must also succeed: the encoded form is plain wire data.
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
