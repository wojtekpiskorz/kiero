/**
 * Retention windowing tests (I2): the accepted 30-day diagnostic window,
 * the longer cost-accounting horizon, and the heartbeat tail bound.
 */

import { describe, expect, it } from "vitest";
import {
  COST_RETENTION_MS,
  DIAGNOSTIC_RETENTION_MS,
  FORWARD_WINDOW_MS,
  costPeriodCutoff,
  isCostPeriodExpired,
  isExpired,
  retentionCutoffMs,
} from "../../convex/operations/telemetry/retention";
import { HEARTBEATS_KEPT_PER_SERVICE } from "../../convex/operations/telemetry/heartbeat";
import retentionConfig from "../../infra/observability/retention.json";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00Z");

describe("the accepted diagnostic window", () => {
  it("is exactly 30 days and matches the infra descriptor", () => {
    expect(DIAGNOSTIC_RETENTION_MS).toBe(30 * DAY);
    expect(retentionConfig.diagnosticEvents.windowDays).toBe(30);
  });

  it("cutoff and expiry are pure clock arithmetic", () => {
    expect(retentionCutoffMs(NOW)).toBe(NOW - 30 * DAY);
    expect(isExpired(NOW - 30 * DAY - 1, NOW)).toBe(true);
    expect(isExpired(NOW - 30 * DAY, NOW)).toBe(false);
    expect(isExpired(NOW - 29 * DAY, NOW)).toBe(false);
  });

  it("a custom window (tests, drills) composes with the same function", () => {
    expect(retentionCutoffMs(NOW, DAY)).toBe(NOW - DAY);
    expect(isExpired(NOW - 2 * DAY, NOW, DAY)).toBe(true);
  });
});

describe("cost accounting outlives diagnostics", () => {
  it("cost horizon is ~13 months and older periods are expired", () => {
    expect(COST_RETENTION_MS).toBe(400 * DAY);
    expect(retentionConfig.costAccounting.windowDays).toBe(400);
    expect(isCostPeriodExpired("2023-06", NOW)).toBe(true);
    expect(isCostPeriodExpired("2025-07", NOW)).toBe(true); // beyond the 400-day horizon
    expect(isCostPeriodExpired("2025-09", NOW)).toBe(false); // 12 months back: retained
    expect(isCostPeriodExpired("2026-09", NOW)).toBe(false);
    expect(costPeriodCutoff(NOW)).toBe("2025-08");
  });
});

describe("heartbeat tail and forward window", () => {
  it("keeps a bounded heartbeat tail per service", () => {
    expect(HEARTBEATS_KEPT_PER_SERVICE).toBe(20);
    expect(retentionConfig.healthHeartbeats.keptPerService).toBe(20);
  });

  it("events older than one hour are not worth forwarding", () => {
    expect(FORWARD_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});
