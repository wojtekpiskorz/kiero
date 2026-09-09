/**
 * Outbox and durable-job decision tests (A3): idempotency, retry bounds,
 * uncertain-outcome rules — the pure decisions the Convex transactions use.
 */

import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  decideEventPublication,
  decideJobRegistration,
  nextDeliveryState,
  reconcileMayRetry,
} from "@kiero/runtime";

describe("publication idempotency", () => {
  it("inserts when no existing row carries the dedup key", () => {
    expect(decideEventPublication(null)).toEqual({ decision: "insert" });
  });

  it("deduplicates a replay onto the existing event identity", () => {
    const decision = decideEventPublication({ eventId: "evt-1" });
    expect(decision).toEqual({ decision: "deduplicated", existingEventId: "evt-1" });
  });
});

describe("durable job registration decisions", () => {
  it("registers when no row exists", () => {
    expect(decideJobRegistration(null)).toEqual({ decision: "register" });
  });

  it("never re-registers succeeded or active work", () => {
    expect(decideJobRegistration("succeeded")).toEqual({
      decision: "skip",
      reason: "already_succeeded",
    });
    expect(decideJobRegistration("cancelled")).toEqual({
      decision: "skip",
      reason: "already_succeeded",
    });
    expect(decideJobRegistration("queued")).toEqual({
      decision: "skip",
      reason: "active_attempt",
    });
    expect(decideJobRegistration("running")).toEqual({
      decision: "skip",
      reason: "active_attempt",
    });
  });

  it("re-registers definite failures only (uncertainty reconciles instead)", () => {
    expect(decideJobRegistration("failed")).toEqual({ decision: "register" });
  });
});

describe("delivery state machine", () => {
  const base = 1_000;

  it("delivers on success", () => {
    expect(
      nextDeliveryState({ outcome: "succeeded", attempts: 1, maxAttempts: 3 }, 0, base),
    ).toEqual({ to: "delivered" });
  });

  it("retries definite failures with capped exponential backoff", () => {
    const first = nextDeliveryState(
      { outcome: "failed", attempts: 1, maxAttempts: 3 },
      10_000,
      base,
    );
    expect(first).toEqual({ to: "in_flight", nextAttemptAtMs: 10_000 + base });
    const later = nextDeliveryState(
      { outcome: "failed", attempts: 5, maxAttempts: 9 },
      0,
      base,
    );
    expect(later.to).toBe("in_flight");
    if (later.to === "in_flight") {
      // base * 2^4 (fifth failure, exponent capped at 6 -> one minute max)
      expect(later.nextAttemptAtMs).toBe(16_000);
    }
  });

  it("fails terminally when attempts are exhausted", () => {
    expect(
      nextDeliveryState({ outcome: "failed", attempts: 3, maxAttempts: 3 }, 0, base),
    ).toEqual({ to: "failed", terminal: true });
  });

  it("NEVER auto-retries uncertain outcomes (timeout after possible success)", () => {
    const timeout = nextDeliveryState(
      { outcome: "timeout", attempts: 1, maxAttempts: 9 },
      0,
      base,
    );
    expect(timeout).toEqual({ to: "failed", terminal: false });
    const unknown = nextDeliveryState(
      { outcome: "unknown", attempts: 1, maxAttempts: 9 },
      0,
      base,
    );
    expect(unknown).toEqual({ to: "failed", terminal: false });
  });

  it("backoff is bounded and positive", () => {
    expect(backoffDelayMs(0, base)).toBe(base);
    expect(backoffDelayMs(1, base)).toBe(1_000); // base after the first failure
    expect(backoffDelayMs(50, base)).toBe(60_000); // capped exponent 2^6
  });

  it("reconciliation retries only a provably-undelivered effect", () => {
    expect(reconcileMayRetry("delivered")).toBe(false);
    expect(reconcileMayRetry("not_delivered")).toBe(true);
  });
});
