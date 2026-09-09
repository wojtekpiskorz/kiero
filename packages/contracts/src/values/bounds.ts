/**
 * Shared predicate for range-shaped values: at least one bound must be
 * present. One copy lives here; temporal and money ranges both derive their
 * type guards from it, keeping the open-bound rule identical everywhere.
 */

/**
 * Builds a type-guard refine for a range shape by picking its two nullable
 * bounds. Returns true only when at least one bound is present (an
 * everything-open range carries no information and is rejected).
 */
export function atLeastOneBound<Bounds>(
  pick: (bounds: Bounds) => readonly [unknown, unknown],
): (value: Bounds) => value is Bounds {
  return (value): value is Bounds => {
    const [lower, upper] = pick(value);
    return lower !== null || upper !== null;
  };
}
