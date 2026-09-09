/**
 * The cost-alert model (I2): all-in monthly spend accounting with the
 * accepted 400 PLN warning / 500 PLN stronger alert and per-level cooldown.
 *
 * PURE MODULE (shared definition; mirrored in infra/observability/
 * cost-limits.json, which tests/i2 asserts cannot drift).
 *
 * Amounts are PLN minor units (grosze). Provider-native hard caps are
 * tracked per provider in their own units in the descriptor - never silently
 * converted - while the owner-visible budget thresholds stay PLN.
 */

/** The providers whose spend makes up the all-in budget. */
export const SPEND_PROVIDERS = [
  "convex",
  "workers",
  "r2",
  "containers",
  "images",
  "ai_openrouter",
  "email_resend",
  "observability_axiom",
  "backup",
] as const;

export type SpendProvider = (typeof SPEND_PROVIDERS)[number];

/** The accepted owner-visible thresholds (alpha contract: 400/500 PLN). */
export const COST_THRESHOLDS = {
  warningMinor: 40_000,
  alertMinor: 50_000,
} as const;

/** Re-alert cooldown while a threshold condition stays active. */
export const COST_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type CostAlertLevel = "warning_400" | "alert_500";

/** Threshold state of one period's total. */
export interface CostThresholdState {
  readonly warning: boolean;
  readonly alert: boolean;
}

/** Evaluates the 400/500 PLN thresholds against a period total (minor units). */
export function evaluateCostThresholds(totalMinor: number): CostThresholdState {
  return {
    warning: totalMinor >= COST_THRESHOLDS.warningMinor,
    alert: totalMinor >= COST_THRESHOLDS.alertMinor,
  };
}

/** Cooldown state of one (period, level) pair, if it ever fired. */
export interface CostAlertCooldownState {
  readonly level: CostAlertLevel;
  readonly lastFiredAtMs: number;
}

export type CostAlertDecision =
  | { readonly emit: true; readonly reason: "first_fire" | "cooldown_expired" }
  | { readonly emit: false; readonly reason: "cooldown_active" };

/**
 * Decides whether a threshold alert may fire now. Suppression is per level:
 * the 500 PLN alert is never silenced by a recent 400 PLN warning, and a
 * downgrade/upgrade inside a level respects the same cooldown.
 */
export function shouldEmitCostAlert(
  state: CostAlertCooldownState | null,
  level: CostAlertLevel,
  nowMs: number,
  cooldownMs: number = COST_ALERT_COOLDOWN_MS,
): CostAlertDecision {
  if (state === null || state.level !== level) {
    return { emit: true, reason: "first_fire" };
  }
  if (nowMs - state.lastFiredAtMs >= cooldownMs) {
    return { emit: true, reason: "cooldown_expired" };
  }
  return { emit: false, reason: "cooldown_active" };
}

/** Sums cost entries per provider and returns the all-in total. */
export function sumCostEntries(
  entries: readonly { provider: string; amountMinor: number }[],
): { perProvider: Record<string, number>; totalMinor: number } {
  const perProvider: Record<string, number> = {};
  let totalMinor = 0;
  for (const entry of entries) {
    perProvider[entry.provider] = (perProvider[entry.provider] ?? 0) + entry.amountMinor;
    totalMinor += entry.amountMinor;
  }
  return { perProvider, totalMinor };
}

/** The UTC calendar month ("YYYY-MM") containing a timestamp. */
export function periodOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** True when a period string is well-formed ("YYYY-MM"). */
export function isValidPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}
