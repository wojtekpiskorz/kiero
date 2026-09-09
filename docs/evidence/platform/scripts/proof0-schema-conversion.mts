/**
 * A3 proof 0 (offline): the TanStack tool/schema adapter conversion over A2
 * contract schemas, with NO provider calls.
 *
 * Path proved: Effect Schema (A2 contract value) -> Standard Schema
 * (`~standard`, draft-07) -> `convertSchemaToJsonSchema` from the pinned
 * @tanstack/ai -> provider JSON Schema. Also pins the structured-output
 * widening behavior and the ~standard validation rejection path.
 *
 * Rows produced:
 *   S1 deterministic conversion       S2 enum/union structure preserved
 *   S3 structured-output widening     S4 malformed input rejected
 *
 * Usage: npx tsx docs/evidence/platform/scripts/proof0-schema-conversion.mts
 */

import { Schema } from "effect";
import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { MoneyValue } from "@kiero/contracts";
import { toolJsonSchema, toolJsonSchemaForStructuredOutput } from "@kiero/runtime";

let pass = 0;
let fail = 0;
function record(id: string, ok: boolean, detail: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id} :: ${detail}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.log(`# proof0 schema conversion (offline) :: ${new Date().toISOString()}`);

// --- S1: deterministic conversion -----------------------------------------------

const json1 = toolJsonSchema(MoneyValue);
const json2 = toolJsonSchema(MoneyValue);
record(
  "S1 standard-schema -> JSON-schema conversion is deterministic",
  JSON.stringify(json1) === JSON.stringify(json2) && json1.type === "object",
  `type=${String(json1.type)} keys=${Object.keys(json1).sort().join(",")}`,
);

// --- S2: union structure preserved ----------------------------------------------

const amounts = (json1 as { properties?: Record<string, { anyOf?: unknown[]; oneOf?: unknown[] }> })
  .properties?.amount;
const amountVariants = (amounts?.anyOf ?? amounts?.oneOf ?? []) as { properties?: Record<string, unknown> }[];
const taxBasis = (json1 as { properties?: Record<string, { enum?: unknown[] }> }).properties?.taxBasis
  ?.enum;
record(
  "S2 union/enums survive conversion (amount variants, taxBasis enum)",
  amountVariants.length === 2 &&
    JSON.stringify(taxBasis) === JSON.stringify(["net", "gross", "not_specified"]),
  `amountVariants=${amountVariants.length} taxBasis=[${String(taxBasis?.join(","))}]`,
);

// --- S3: structured-output widening ----------------------------------------------

const widened = toolJsonSchemaForStructuredOutput(MoneyValue) as {
  required?: string[];
  properties?: Record<string, unknown>;
};
record(
  "S3 structured-output mode requires all properties (null-widening active)",
  Array.isArray(widened.required) &&
    JSON.stringify([...widened.required].sort()) ===
      JSON.stringify(Object.keys(widened.properties ?? {}).sort()),
  `required=[${String(widened.required?.join(","))}]`,
);

// --- S4: malformed input rejected on the ~standard path -----------------------------

const standard = Schema.toStandardSchemaV1(MoneyValue);
const invalid = await standard["~standard"].validate({
  role: "price_proposal",
  amount: { _tag: "exact", value: "not-a-decimal" },
  currency: "PLN",
  currencyOrigin: "stated",
  taxBasis: "net",
  certainty: "exact",
} as never);
record(
  "S4 malformed input is rejected with issues through ~standard.validate",
  Array.isArray(invalid.issues) && invalid.issues.length > 0,
  `issues=${invalid.issues?.length ?? 0}`,
);

console.log(`\nSummary: {"PASS": ${pass}, "FAIL": ${fail}} of ${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
