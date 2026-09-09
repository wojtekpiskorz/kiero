/**
 * Financial value contract ("Value contracts", architecture design).
 *
 * Rules encoded here:
 *
 * - Amounts are exact decimals (Effect `BigDecimal`, encoded as decimal
 *   strings) or an explicit range; binary floats never carry money.
 * - Business role and scope are carried explicitly (a quote never silently
 *   becomes an agreed price; see issue 8).
 * - Currency is explicit; when the speaker did not state one the origin is
 *   recorded as `company_default` (PLN initial default), never guessed.
 * - Tax basis `not_specified` is a first-class state. VAT is never inferred;
 *   net and gross may coexist as separate findings, and changing the basis
 *   creates a revision rather than rewriting history.
 *
 * Certified by A3 on 2026-09-09 (docs/implementation/contracts/README.md).
 */

import { Schema, BigDecimal } from "effect";
import { atLeastOneBound } from "./bounds";

/** Exact decimal amount, encoded as a plain decimal string (`"1234.56"`). */
export const ExactDecimal = Schema.BigDecimalFromString;
export type ExactDecimal = Schema.Schema.Type<typeof ExactDecimal>;

const MoneyRange = Schema.TaggedStruct("range", {
  min: Schema.NullOr(ExactDecimal),
  max: Schema.NullOr(ExactDecimal),
});
type MoneyRange = Schema.Schema.Type<typeof MoneyRange>;

const hasAtLeastOneBound = atLeastOneBound<MoneyRange>((value) => [value.min, value.max]);

const boundsInOrder = (value: MoneyRange): value is MoneyRange =>
  value.min === null || value.max === null || BigDecimal.isLessThanOrEqualTo(value.min, value.max);

/** Amount: exact value, or a range with open (`null`) bounds where justified. */
export const MoneyAmount = Schema.Union([
  Schema.TaggedStruct("exact", { value: ExactDecimal }),
  MoneyRange.pipe(
    Schema.refine(hasAtLeastOneBound),
    Schema.refine(boundsInOrder),
  ),
]);
export type MoneyAmount = Schema.Schema.Type<typeof MoneyAmount>;

/** ISO 4217 code; the company default for alpha firms is PLN. */
export const CurrencyCode = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Z]{3}$/)),
  Schema.brand("CurrencyCode"),
);
export type CurrencyCode = Schema.Schema.Type<typeof CurrencyCode>;

/** Whether the currency was stated in the source or taken from company settings. */
export const CurrencyOrigin = Schema.Literals(["stated", "company_default"]);
export type CurrencyOrigin = Schema.Schema.Type<typeof CurrencyOrigin>;

/** Tax basis of a quoted amount. `not_specified` must stay visible; VAT is never inferred. */
export const TaxBasis = Schema.Literals(["net", "gross", "not_specified"]);
export type TaxBasis = Schema.Schema.Type<typeof TaxBasis>;

/** Whether the amount is an exact figure or an estimate; estimates never upgrade silently. */
export const MoneyCertainty = Schema.Literals(["exact", "estimate"]);
export type MoneyCertainty = Schema.Schema.Type<typeof MoneyCertainty>;

/**
 * Business role of the amount. Closed vocabulary from the accepted memory
 * contract (issue 8): price proposal, agreed price, material cost, deposit
 * received, estimated labor. Extending it is a coordinated contract change.
 */
export const MoneyRole = Schema.Literals([
  "price_proposal",
  "agreed_price",
  "material_cost",
  "deposit_received",
  "estimated_labor",
]);
export type MoneyRole = Schema.Schema.Type<typeof MoneyRole>;

/** One financial finding value. */
export const MoneyValue = Schema.Struct({
  role: MoneyRole,
  amount: MoneyAmount,
  currency: CurrencyCode,
  currencyOrigin: CurrencyOrigin,
  taxBasis: TaxBasis,
  certainty: MoneyCertainty,
});
export type MoneyValue = Schema.Schema.Type<typeof MoneyValue>;
