/**
 * Server-side value construction for planned findings (E3): temporal and
 * financial values from decoded model proposals.
 *
 * The rules that make this the SERVER's job, never the model's:
 *
 * - relative language resolves against the SOURCE's `sentAt` and timezone
 *   snapshot through the C2 pure resolver — a retry days later yields the
 *   same day, and the model never does date arithmetic;
 * - an explicit day proposed alongside a bounded relative expression is
 *   VERIFIED against the server's own resolution: a mismatch is refused
 *   (`relative_day_disagrees`), not merged;
 * - money amounts decode through the contract schema (exact BigDecimal
 *   decimal strings, bounded ranges); a net/gross basis requires the
 *   evidence quote to state it — VAT is never inferred;
 * - precision is preserved: a month/year/range proposal never invents a
 *   day, and an unresolvable expression produces an explicit unresolved
 *   marker (the caller routes it to a clarification), never a guess.
 */

import { Schema } from "effect";
import { MoneyValue, TemporalValue, type MoneyValue as MoneyValueType, type TemporalValue as TemporalValueType } from "@kiero/contracts";
import { resolveRelativeDay } from "@kiero/domain";
import type { MoneyProposal, TemporalProposal } from "./tools";
import { quoteStatesTaxBasis } from "./quotes";

/**
 * Polish weekday inflection map (accusative/locative back to nominative):
 * the C2 resolver's bounded vocabulary lists weekday names in the
 * nominative ("środa"), while spoken Polish says "w środę". Mapping the
 * common inflected forms here keeps the RESOLUTION rule in @kiero/domain
 * (one authority) while this lane's proposals still resolve.
 */
const WEEKDAY_INFLECTIONS: Readonly<Record<string, string>> = {
  "poniedziałek": "poniedziałek",
  "wtorek": "wtorek",
  "środę": "środa",
  "środe": "środa",
  "czwartek": "czwartek",
  "piątek": "piątek",
  "piatek": "piątek",
  "sobotę": "sobota",
  "sobote": "sobota",
  "niedzielę": "niedziela",
  "niedziele": "niedziela",
};

/** Normalizes one relative expression for the bounded resolver. */
export function normalizeRelativeExpression(expression: string): string {
  const normalized = expression.trim().toLowerCase().replace(/\s+/g, " ");
  const withoutPreposition = normalized.replace(/^w[e]?\s+/, "");
  return WEEKDAY_INFLECTIONS[withoutPreposition] ?? normalized;
}

/** The outcome of building one temporal value. */
export type TemporalBuild =
  | { readonly built: true; readonly value: TemporalValueType }
  /** Unresolvable relative language: route to a clarification, never guess. */
  | { readonly built: false; readonly reason: "relative_unresolvable" }
  /** The model's explicit day disagrees with the server's resolution. */
  | { readonly built: false; readonly reason: "relative_day_disagrees"; serverDay: string }
  /** A model datetime that is not a zoned ISO string. */
  | { readonly built: false; readonly reason: "datetime_unparseable" };

/** Builds one temporal value from the proposal, anchored to the source. */
export function buildTemporalValue(
  proposal: TemporalProposal,
  sentAtMs: number,
  timezone: string,
): TemporalBuild {
  const { basis } = proposal;
  switch (basis._tag) {
    case "relative": {
      const resolution = resolveRelativeDay(
        normalizeRelativeExpression(basis.expression),
        sentAtMs,
        timezone,
      );
      if (!resolution.matched) {
        return { built: false, reason: "relative_unresolvable" };
      }
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: { _tag: "day", day: resolution.day },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
    case "day": {
      // When the original words are a bounded relative expression, verify
      // the explicit day against the server's own anchored resolution.
      const resolution = resolveRelativeDay(
        normalizeRelativeExpression(proposal.originalExpression),
        sentAtMs,
        timezone,
      );
      if (resolution.matched && resolution.day !== basis.day) {
        return {
          built: false,
          reason: "relative_day_disagrees",
          serverDay: resolution.day,
        };
      }
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: { _tag: "day", day: basis.day },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
    case "month": {
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: { _tag: "month", month: basis.month },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
    case "year": {
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: { _tag: "year", year: basis.year },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
    case "datetime": {
      const parsed = Schema.decodeUnknownOption(
        Schema.DateTimeZonedFromString,
      )(basis.iso);
      if (parsed._tag === "None") {
        return { built: false, reason: "datetime_unparseable" };
      }
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: { _tag: "date_time", value: basis.iso },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
    case "range": {
      return {
        built: true,
        value: Schema.decodeUnknownSync(TemporalValue)({
          shape: {
            _tag: "range",
            start:
              basis.start === null
                ? null
                : basis.start.length === 10
                  ? { _tag: "day", day: basis.start }
                  : { _tag: "month", month: basis.start },
            end:
              basis.end === null
                ? null
                : basis.end.length === 10
                  ? { _tag: "day", day: basis.end }
                  : { _tag: "month", month: basis.end },
          },
          originalExpression: proposal.originalExpression,
          role: proposal.role,
        }),
      };
    }
  }
}

/** The outcome of building one money value. */
export type MoneyBuild =
  | { readonly built: true; readonly value: MoneyValueType }
  /** The quote does not state netto/brutto, so the basis cannot be claimed. */
  | { readonly built: false; readonly reason: "tax_basis_not_stated" }
  /** The decimal strings/range do not decode through the contract schema. */
  | { readonly built: false; readonly reason: "amount_invalid" };

/**
 * Builds one money value from the proposal. `companyDefaultCurrency` fills
 * an unstated currency (origin `company_default`, PLN baseline); a stated
 * one keeps origin `stated`. The net/gross basis is honored only when the
 * grounding quote actually says netto/brutto.
 */
export function buildMoneyValue(
  proposal: MoneyProposal,
  evidenceQuote: string,
  companyDefaultCurrency: string,
): MoneyBuild {
  if (
    proposal.taxBasis !== "not_specified" &&
    !quoteStatesTaxBasis(evidenceQuote)
  ) {
    return { built: false, reason: "tax_basis_not_stated" };
  }
  const wire =
    proposal.amount._tag === "exact"
      ? { _tag: "exact" as const, value: proposal.amount.value }
      : {
          _tag: "range" as const,
          min: proposal.amount.min,
          max: proposal.amount.max,
        };
  const decoded = Schema.decodeUnknownOption(MoneyValue)({
    role: proposal.role,
    amount: wire,
    currency: proposal.currency ?? companyDefaultCurrency,
    currencyOrigin: proposal.currency === null ? "company_default" : "stated",
    taxBasis: proposal.taxBasis,
    certainty: proposal.certainty,
  });
  if (decoded._tag === "None") {
    return { built: false, reason: "amount_invalid" };
  }
  return { built: true, value: decoded.value };
}
