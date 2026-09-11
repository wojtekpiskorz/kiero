/**
 * Polish rendering of the contract's closed finding-value vocabularies
 * (H2 review round 1): the ONE source of the temporal-role, tax-basis,
 * money-role and certainty labels, following the TASK_STATE_LABELS
 * pattern (packages/domain/work/taskState.ts). The machine tokens come
 * from the certified contract surface (`TemporalRole`, `TaxBasis`,
 * `MoneyRole`, `MoneyCertainty` in @kiero/contracts); a vocabulary change
 * there fails the build of every consumer instead of drifting between
 * surface copies.
 *
 * Pure module: no I/O, no React; the web surfaces (work, memory and the
 * extension value editor) and any backend lane consume the same maps.
 */

import type { MoneyCertainty, MoneyRole, TaxBasis, TemporalRole, TemporalValue } from "@kiero/contracts";

/** Polish product rendering of every temporal value role. */
export const TEMPORAL_ROLE_LABELS: Readonly<Record<TemporalRole, string>> = {
  proposed: "propozycja",
  internal: "plan wewnętrzny",
  agreed: "uzgodnione",
  actual: "stan faktyczny",
};

/** Polish product rendering of every money value role. */
export const MONEY_ROLE_LABELS: Readonly<Record<MoneyRole, string>> = {
  price_proposal: "wycena",
  agreed_price: "uzgodniona cena",
  material_cost: "koszt materiałów",
  deposit_received: "otrzymana zaliczka",
  estimated_labor: "szacunek robocizny",
};

/** Polish product rendering of every tax basis. */
export const TAX_BASIS_LABELS: Readonly<Record<TaxBasis, string>> = {
  net: "netto",
  gross: "brutto",
  // The first-class honest state: never guessed, always visible.
  not_specified: "podatek nieokreślony",
};

/** Polish product rendering of every money certainty. */
export const MONEY_CERTAINTY_LABELS: Readonly<Record<MoneyCertainty, string>> = {
  exact: "kwota dokładna",
  estimate: "kwota szacunkowa",
};


/** Renders one decoded date-only bound; no component is invented. */
export function dateOnlyLabel(
  bound: Extract<TemporalValue["shape"], { _tag: "day" | "month" | "year" }>,
): string {
  switch (bound._tag) {
    case "day":
      return bound.day;
    case "month":
      return `${bound.month} (do danego miesiąca)`;
    case "year":
      return `${bound.year} (do danego roku)`;
  }
}

/**
 * Renders one decoded temporal value: calendar facts plus the original
 * words. An exact date/time stays an exact instant; a date-only term names
 * the day it ends with; an open range end stays open.
 */
export function temporalValueLabel(temporal: TemporalValue): string {
  let when: string;
  switch (temporal.shape._tag) {
    case "day":
    case "month":
    case "year":
      when = dateOnlyLabel(temporal.shape);
      break;
    case "date_time":
      when = temporal.shape.value.toString();
      break;
    case "range": {
      const { start, end } = temporal.shape;
      when =
        start === null && end === null
          ? "zakres nieokreślony"
          : `od ${start === null ? "…" : dateOnlyLabel(start)} do ${end === null ? "…" : dateOnlyLabel(end)}`;
      break;
    }
  }
  return temporal.originalExpression === "" ? when : `${when} (${temporal.originalExpression})`;
}
