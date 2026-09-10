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

import type { MoneyCertainty, MoneyRole, TaxBasis, TemporalRole } from "@kiero/contracts";

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
