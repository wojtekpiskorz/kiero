/**
 * Cost threshold + cooldown tests (I2): the 400/500 PLN alerts and the
 * per-level cooldown, plus provider accounting sums and period handling.
 */

import { describe, expect, it } from "vitest";
import {
  COST_ALERT_COOLDOWN_MS,
  COST_THRESHOLDS,
  SPEND_PROVIDERS,
  costAlertDedupKey,
  evaluateCostThresholds,
  isValidPeriod,
  periodOf,
  shouldEmitCostAlert,
  sumCostEntries,
} from "../../convex/operations/telemetry/costs";
import { validateCostEntry } from "../../convex/operations/telemetry/functions";
import costLimits from "../../infra/observability/cost-limits.json";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00Z");

describe("400/500 PLN thresholds", () => {
  it("401 PLN is the exact warning boundary in minor units", () => {
    expect(evaluateCostThresholds(COST_THRESHOLDS.warningMinor - 1)).toEqual({
      warning: false,
      alert: false,
    });
    expect(evaluateCostThresholds(COST_THRESHOLDS.warningMinor)).toEqual({
      warning: true,
      alert: false,
    });
    expect(COST_THRESHOLDS.warningMinor).toBe(40_000);
    expect(COST_THRESHOLDS.alertMinor).toBe(50_000);
  });

  it("501 PLN activates the stronger alert; both levels stay independent", () => {
    expect(evaluateCostThresholds(COST_THRESHOLDS.alertMinor - 1).alert).toBe(false);
    const atAlert = evaluateCostThresholds(COST_THRESHOLDS.alertMinor);
    expect(atAlert).toEqual({ warning: true, alert: true });
  });

  it("matches the infra descriptor (the two files cannot drift silently)", () => {
    expect(costLimits.budget.thresholds.warning.minor).toBe(COST_THRESHOLDS.warningMinor);
    expect(costLimits.budget.thresholds.alert.minor).toBe(COST_THRESHOLDS.alertMinor);
    expect(costLimits.budget.thresholds.warning.label).toBe("400 PLN");
    expect(costLimits.budget.thresholds.alert.label).toBe("500 PLN");
    expect(costLimits.budget.alertCooldownHours * 60 * 60 * 1000).toBe(COST_ALERT_COOLDOWN_MS);
    expect(new Set(costLimits.providers.map((p) => p.provider))).toEqual(new Set(SPEND_PROVIDERS));
  });
});

describe("alert cooldown", () => {
  it("fires when no state exists", () => {
    expect(shouldEmitCostAlert(null, "warning_400", NOW)).toEqual({
      emit: true,
      reason: "first_fire",
    });
  });

  it("suppresses a same-level re-alert inside 24h and re-fires after expiry", () => {
    const state = { level: "warning_400" as const, lastFiredAtMs: NOW - 1 * DAY + 60_000 };
    expect(shouldEmitCostAlert(state, "warning_400", NOW)).toEqual({
      emit: false,
      reason: "cooldown_active",
    });
    const expired = { level: "warning_400" as const, lastFiredAtMs: NOW - COST_ALERT_COOLDOWN_MS };
    expect(shouldEmitCostAlert(expired, "warning_400", NOW)).toEqual({
      emit: true,
      reason: "cooldown_expired",
    });
  });

  it("a 500 PLN alert is never silenced by a recent 400 PLN warning (escalation)", () => {
    const warningJustFired = { level: "warning_400" as const, lastFiredAtMs: NOW };
    expect(shouldEmitCostAlert(warningJustFired, "alert_500", NOW)).toEqual({
      emit: true,
      reason: "first_fire",
    });
  });
});

describe("alert dedup identity", () => {
  it("is stable per level+period+fireCount and distinct across levels/fires", () => {
    expect(costAlertDedupKey("warning_400", "2026-09", 1)).toBe(
      "cost_alert:warning_400:2026-09:1",
    );
    expect(costAlertDedupKey("warning_400", "2026-09", 1)).toBe(
      costAlertDedupKey("warning_400", "2026-09", 1),
    );
    expect(costAlertDedupKey("warning_400", "2026-09", 2)).not.toBe(
      costAlertDedupKey("warning_400", "2026-09", 1),
    );
    expect(costAlertDedupKey("alert_500", "2026-09", 1)).not.toBe(
      costAlertDedupKey("warning_400", "2026-09", 1),
    );
    expect(costAlertDedupKey("warning_400", "2026-10", 1)).not.toBe(
      costAlertDedupKey("warning_400", "2026-09", 1),
    );
  });
});

describe("accounting", () => {
  it("sums per provider and in total", () => {
    const { perProvider, totalMinor } = sumCostEntries([
      { provider: "convex", amountMinor: 100 },
      { provider: "convex", amountMinor: 50 },
      { provider: "ai_openrouter", amountMinor: 250 },
    ]);
    expect(perProvider).toEqual({ convex: 150, ai_openrouter: 250 });
    expect(totalMinor).toBe(400);
  });

  it("periods are UTC months; malformed periods and providers are rejected", () => {
    expect(periodOf(NOW)).toBe("2026-09");
    expect(isValidPeriod("2026-09")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("september")).toBe(false);
    expect(validateCostEntry({ period: "2026-09", provider: "convex", category: "compute", amountMinor: 100, basis: "estimate" })).toEqual({ ok: true });
    expect(validateCostEntry({ period: "2026-09", provider: "not-a-provider", category: "compute", amountMinor: 100, basis: "estimate" })).toEqual({ ok: false, reason: "provider_unknown" });
    expect(validateCostEntry({ period: "2026-9", provider: "convex", category: "compute", amountMinor: 100, basis: "estimate" })).toEqual({ ok: false, reason: "period_invalid" });
    expect(validateCostEntry({ period: "2026-09", provider: "convex", category: "Compute!", amountMinor: 100, basis: "estimate" })).toEqual({ ok: false, reason: "category_invalid" });
    expect(validateCostEntry({ period: "2026-09", provider: "convex", category: "compute", amountMinor: 1.5, basis: "estimate" })).toEqual({ ok: false, reason: "amount_invalid" });
    expect(validateCostEntry({ period: "2026-09", provider: "convex", category: "compute", amountMinor: 100, basis: "guess" as "observed" })).toEqual({ ok: false, reason: "basis_invalid" });
  });
});
