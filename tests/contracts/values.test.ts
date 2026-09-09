/**
 * Semantic value contract tests (A2 focused verification).
 *
 * Valid/invalid semantic values: date-only versus timed versus range, exact
 * money with not_specified tax basis, knowledge states. All assertions run
 * through the actual pinned Effect 4 RC schemas; failures must be
 * `SchemaError`.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  DateRange,
  KnowledgeState,
  MoneyValue,
  TemporalValue,
  ExtensionValue,
} from "@kiero/contracts";

const decodeTemporal = Schema.decodeUnknownSync(TemporalValue);
const decodeKnowledge = Schema.decodeUnknownSync(KnowledgeState);
const decodeMoney = Schema.decodeUnknownSync(MoneyValue);
const decodeExtension = Schema.decodeUnknownSync(ExtensionValue);

function expectSchemaError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(Schema.isSchemaError(error)).toBe(true);
    return;
  }
  expect.unreachable("expected a SchemaError");
}

describe("knowledge states", () => {
  it("decodes all four epistemic states", () => {
    expect(decodeKnowledge({ _tag: "known" })).toEqual({ _tag: "known" });
    expect(decodeKnowledge({ _tag: "unknown", reason: "nie podano" })).toEqual({
      _tag: "unknown",
      reason: "nie podano",
    });
    expect(decodeKnowledge({ _tag: "conflicted" })).toEqual({ _tag: "conflicted" });
    expect(decodeKnowledge({ _tag: "not_applicable" })).toEqual({
      _tag: "not_applicable",
    });
  });

  it("rejects unknown states and empty reasons", () => {
    expectSchemaError(() => decodeKnowledge({ _tag: "maybe" }));
    expectSchemaError(() => decodeKnowledge({ _tag: "unknown", reason: "" }));
    expectSchemaError(() => decodeKnowledge({ state: "known" }));
  });
});

describe("temporal values", () => {
  it("keeps a date-only value without inventing a time", () => {
    const decoded = decodeTemporal({
      shape: { _tag: "day", day: "2026-01-09" },
      originalExpression: "w piątek",
      role: "agreed",
    });
    expect(decoded.shape).toEqual({ _tag: "day", day: "2026-01-09" });
  });

  it("keeps month and year precision instead of picking a day", () => {
    const month = decodeTemporal({
      shape: { _tag: "month", month: "2026-01" },
      originalExpression: "koniec stycznia",
      role: "proposed",
    });
    expect(month.shape).toEqual({ _tag: "month", month: "2026-01" });
    const year = decodeTemporal({
      shape: { _tag: "year", year: "2026" },
      originalExpression: "w przyszłym roku",
      role: "internal",
    });
    expect(year.shape).toEqual({ _tag: "year", year: "2026" });
  });

  it("rejects invented precision components", () => {
    expectSchemaError(() =>
      decodeTemporal({ shape: { _tag: "day", day: "2026-01" }, originalExpression: "x", role: "agreed" }),
    );
    expectSchemaError(() =>
      decodeTemporal({ shape: { _tag: "month", month: "2026-1" }, originalExpression: "x", role: "agreed" }),
    );
    expectSchemaError(() =>
      decodeTemporal({ shape: { _tag: "day", day: "2023-02-29" }, originalExpression: "x", role: "agreed" }),
    );
  });

  it("decodes a zoned date-time with a resolved instant", () => {
    const decoded = decodeTemporal({
      shape: {
        _tag: "date_time",
        value: "2026-01-05T10:30:00+01:00[Europe/Warsaw]",
      },
      originalExpression: "5 stycznia o 10:30",
      role: "agreed",
    });
    if (!("_tag" in decoded.shape) || decoded.shape._tag !== "date_time") {
      throw new Error("expected a date_time shape");
    }
    expect(String(decoded.shape.value)).toContain("Europe/Warsaw");
  });

  it("preserves justified open bounds in ranges and rejects fully open ones", () => {
    const openEnd = decodeTemporal({
      shape: { _tag: "range", start: { _tag: "day", day: "2026-01-05" }, end: null },
      originalExpression: "od 5 stycznia",
      role: "proposed",
    });
    expect(openEnd.shape).toEqual({
      _tag: "range",
      start: { _tag: "day", day: "2026-01-05" },
      end: null,
    });
    expectSchemaError(() =>
      decodeTemporal({
        shape: { _tag: "range", start: null, end: null },
        originalExpression: "kiedyś",
        role: "proposed",
      }),
    );
    const quarter = decodeTemporal({
      shape: {
        _tag: "range",
        start: { _tag: "month", month: "2026-01" },
        end: { _tag: "month", month: "2026-03" },
      },
      originalExpression: "pierwszy kwartał",
      role: "internal",
    });
    if (quarter.shape._tag !== "range") {
      throw new Error("expected a range shape");
    }
    expect(quarter.shape.start).toEqual({ _tag: "month", month: "2026-01" });
  });

  it("rejects unknown roles and missing original expression", () => {
    expectSchemaError(() =>
      decodeTemporal({ shape: { _tag: "day", day: "2026-01-05" }, originalExpression: "x", role: "guessed" }),
    );
    expectSchemaError(() =>
      decodeTemporal({ shape: { _tag: "day", day: "2026-01-05" }, originalExpression: "", role: "agreed" }),
    );
  });

  it("range schema encodes bounds back to null-able tagged dates", () => {
    const range = Schema.decodeUnknownSync(DateRange)({
      _tag: "range",
      start: { _tag: "day", day: "2026-01-05" },
      end: null,
    });
    expect(Schema.encodeSync(DateRange)(range)).toEqual({
      _tag: "range",
      start: { _tag: "day", day: "2026-01-05" },
      end: null,
    });
  });
});

describe("money values", () => {
  it("decodes an exact amount with not_specified tax basis", () => {
    const decoded = decodeMoney({
      role: "agreed_price",
      amount: { _tag: "exact", value: "1234.56" },
      currency: "PLN",
      currencyOrigin: "stated",
      taxBasis: "not_specified",
      certainty: "exact",
    });
    expect(decoded.taxBasis).toBe("not_specified");
    // Assert on the encoded wire form: the exact amount stays a decimal
    // string and nothing about net/gross is invented alongside it.
    const encoded = Schema.encodeSync(MoneyValue)(decoded);
    expect(encoded.taxBasis).toBe("not_specified");
    expect(encoded.amount).toEqual({ _tag: "exact", value: "1234.56" });
    expect(Object.keys(encoded).sort()).toEqual([
      "amount",
      "certainty",
      "currency",
      "currencyOrigin",
      "role",
      "taxBasis",
    ]);
  });

  it("decodes exact decimals without float error and rejects malformed decimals", () => {
    const decoded = decodeMoney({
      role: "material_cost",
      amount: { _tag: "exact", value: "0.1" },
      currency: "PLN",
      currencyOrigin: "company_default",
      taxBasis: "net",
      certainty: "estimate",
    });
    const encoded = Schema.encodeSync(MoneyValue)(decoded);
    expect(encoded.amount).toEqual({ _tag: "exact", value: "0.1" });
    expectSchemaError(() =>
      decodeMoney({
        role: "material_cost",
        amount: { _tag: "exact", value: "12,50" },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "net",
        certainty: "exact",
      }),
    );
  });

  it("decodes ranges with open bounds and rejects range without any bound", () => {
    const range = decodeMoney({
      role: "price_proposal",
      amount: { _tag: "range", min: "9000", max: null },
      currency: "PLN",
      currencyOrigin: "stated",
      taxBasis: "not_specified",
      certainty: "estimate",
    });
    expect(range.amount._tag).toBe("range");
    expectSchemaError(() =>
      decodeMoney({
        role: "price_proposal",
        amount: { _tag: "range", min: null, max: null },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "not_specified",
        certainty: "estimate",
      }),
    );
  });

  it("keeps currency origin explicit and rejects lowercase currency codes", () => {
    expect(
      decodeMoney({
        role: "deposit_received",
        amount: { _tag: "exact", value: "500" },
        currency: "PLN",
        currencyOrigin: "company_default",
        taxBasis: "not_specified",
        certainty: "exact",
      }).currencyOrigin,
    ).toBe("company_default");
    expectSchemaError(() =>
      decodeMoney({
        role: "deposit_received",
        amount: { _tag: "exact", value: "500" },
        currency: "pln",
        currencyOrigin: "stated",
        taxBasis: "not_specified",
        certainty: "exact",
      }),
    );
  });
});

describe("extension values", () => {
  it("decodes scalar, object and bounded list values", () => {
    expect(
      decodeExtension({ _tag: "quantity", amount: "120", unit: "m2" })._tag,
    ).toBe("quantity");
    const object = decodeExtension({
      _tag: "object",
      fields: [{ fieldId: "width_mm", value: { _tag: "quantity", amount: "600", unit: "mm" } }],
    });
    expect(object._tag).toBe("object");
    expect(
      decodeExtension({
        _tag: "list",
        items: [{ _tag: "text", text: "wiadro" }, { _tag: "text", text: "farba" }],
      })._tag,
    ).toBe("list");
  });

  it("rejects unstable field ids and oversized bounded lists", () => {
    expectSchemaError(() =>
      decodeExtension({ _tag: "enum", optionId: "Bad Option" }),
    );
    expectSchemaError(() =>
      decodeExtension({
        _tag: "list",
        items: Array.from({ length: 65 }, () => ({ _tag: "text", text: "x" })),
      }),
    );
  });

  it("embeds money and temporal payloads with their own rules", () => {
    expectSchemaError(() =>
      decodeExtension({
        _tag: "financial",
        money: {
          role: "agreed_price",
          amount: { _tag: "exact", value: "1.2.3" },
          currency: "PLN",
          currencyOrigin: "stated",
          taxBasis: "net",
          certainty: "exact",
        },
      }),
    );
    expect(
      decodeExtension({
        _tag: "temporal",
        temporal: {
          shape: { _tag: "day", day: "2026-01-09" },
          originalExpression: "jutro",
          role: "actual",
        },
      })._tag,
    ).toBe("temporal");
  });
});
