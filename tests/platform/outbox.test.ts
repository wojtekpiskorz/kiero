/**
 * Outbox and durable-job decision tests (A3): idempotency, retry bounds,
 * uncertain-outcome rules: the pure decisions the Convex transactions use.
 */

import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  decideEventPublication,
  decideJobRegistration,
  isUncertainJobFailure,
  nextDeliveryState,
  reconcileMayRetry,
} from "@kiero/runtime";
import {
  CONSUMER_PROJECTION_MISSING,
  projectEventToJobInputs,
} from "../../convex/platform/outbox";

describe("publication idempotency", () => {
  it("inserts when no existing row carries the dedup key", () => {
    expect(decideEventPublication(null)).toEqual({ decision: "insert" });
  });

  it("deduplicates a replay onto the existing event identity", () => {
    const decision = decideEventPublication({ eventId: "evt-1" });
    expect(decision).toEqual({
      decision: "deduplicated",
      existingEventId: "evt-1",
    });
  });
});

describe("durable job registration decisions", () => {
  it("registers when no row exists", () => {
    expect(decideJobRegistration(null)).toEqual({ decision: "register" });
  });

  it("never re-registers succeeded or active work", () => {
    expect(
      decideJobRegistration({ externalOutcome: undefined, state: "succeeded" }),
    ).toEqual({
      decision: "skip",
      reason: "already_succeeded",
    });
    expect(
      decideJobRegistration({ externalOutcome: undefined, state: "cancelled" }),
    ).toEqual({
      decision: "skip",
      reason: "already_succeeded",
    });
    expect(
      decideJobRegistration({ externalOutcome: undefined, state: "queued" }),
    ).toEqual({
      decision: "skip",
      reason: "active_attempt",
    });
    expect(
      decideJobRegistration({ externalOutcome: undefined, state: "running" }),
    ).toEqual({
      decision: "skip",
      reason: "active_attempt",
    });
  });

  it("re-registers definite failures only (uncertainty reconciles instead)", () => {
    expect(
      decideJobRegistration({ externalOutcome: undefined, state: "failed" }),
    ).toEqual({ decision: "register" });
    expect(
      decideJobRegistration({ state: "failed", externalOutcome: "failed" }),
    ).toEqual({
      decision: "register",
    });
  });

  it("REFUSES re-registration of uncertain failures (timeout/unknown after possible success)", () => {
    expect(
      decideJobRegistration({ state: "failed", externalOutcome: "timeout" }),
    ).toEqual({
      decision: "skip",
      reason: "uncertain_outcome",
    });
    expect(
      decideJobRegistration({ state: "failed", externalOutcome: "unknown" }),
    ).toEqual({
      decision: "skip",
      reason: "uncertain_outcome",
    });
    // A succeeded external outcome on a failed row is not uncertainty.
    expect(
      decideJobRegistration({ state: "failed", externalOutcome: "succeeded" }),
    ).toEqual({
      decision: "register",
    });
  });
});

describe("delivery state machine", () => {
  const base = 1_000;

  it("delivers on success", () => {
    expect(
      nextDeliveryState(
        { outcome: "succeeded", attempts: 1, maxAttempts: 3 },
        0,
        base,
      ),
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
      nextDeliveryState(
        { outcome: "failed", attempts: 3, maxAttempts: 3 },
        0,
        base,
      ),
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

describe("drain event projection (three-way)", () => {
  it("classifies projected, unconsumed and unprojected events", () => {
    expect(
      projectEventToJobInputs("platform.echoRequested", { message: "m" }, "dk"),
    ).toEqual([
      {
        kind: "job",
        jobKind: "platform.echo_delivery",
        input: { dedupKey: "dk", message: "m" },
        dedupKey: "dk",
      },
    ]);
    expect(
      projectEventToJobInputs("operations.diagnosticEmitted", {}, "dk"),
    ).toEqual([{ kind: "no_consumer" }]);
    // An event may carry SEVERAL edges (the fan-out precedent is D5):
    // sourceAccepted projects onto E3's extract projection (row dedup
    // identity), D5's normalize projection, E4's join projection (issue
    // #38, flagged coordinated append) and F2's notification-intents
    // (issue #42, flagged coordinated append) — the latter three with
    // payload-derived dedups, never the row's.
    expect(
      projectEventToJobInputs(
        "sources.sourceAccepted",
        { sourceId: "s1", attachmentIds: ["a1"] },
        "dk",
      ),
    ).toEqual([
      {
        kind: "job",
        jobKind: "processing.extract_fragments",
        input: { sourceId: "s1", extractionId: null },
        dedupKey: "dk",
      },
      {
        kind: "job",
        jobKind: "processing.normalize_photo",
        input: { sourceId: "s1", attachmentIds: ["a1"] },
        dedupKey: "processing.normalize_photo:s1",
      },
      {
        kind: "job",
        jobKind: "processing.join_multimodal",
        input: {
          sourceId: "s1",
          processingRunId: null,
          reanalysisOfRunId: null,
        },
        dedupKey: "processing.join_multimodal:s1",
      },
      {
        kind: "job",
        jobKind: "attention.evaluate_due_intents",
        input: {
          trigger: "source_accepted",
          sourceId: "s1",
          clarificationId: null,
          changeSetId: null,
        },
        dedupKey: "attention.evaluate_due_intents:source:s1",
      },
    ]);

    expect(
      projectEventToJobInputs("platform.echoRequested", { message: "m" }, "dk"),
    ).toEqual([
      {
        kind: "job",
        jobKind: "platform.echo_delivery",
        input: { dedupKey: "dk", message: "m" },
        dedupKey: "dk",
      },
    ]);
    expect(
      projectEventToJobInputs("operations.diagnosticEmitted", {}, "dk"),
    ).toEqual([{ kind: "no_consumer" }]);
    // E3 owns this edge's projection: an accepted source drains into the
    // extract executor, which resolves the text extraction in-company when
    // the payload cannot name it (D1's publisher registered the real job
    // atomically under the same dedup key).
    expect(
      projectEventToJobInputs(
        "sources.sourceAccepted",
        { sourceId: "s1" },
        "dk",
      ).map((projection) =>
        projection.kind === "job" ? projection.jobKind : projection.kind,
      ),
    ).toEqual([
      "processing.extract_fragments",
      "processing.normalize_photo",
      "processing.join_multimodal",
      "attention.evaluate_due_intents",
    ]);
    expect(CONSUMER_PROJECTION_MISSING).toBe("consumer_projection_missing");
  });
});

describe("the one uncertain-failure predicate (single definition)", () => {
  it("is uncertain only for failed rows with timeout/unknown external outcomes", () => {
    expect(
      isUncertainJobFailure({ state: "failed", externalOutcome: "timeout" }),
    ).toBe(true);
    expect(
      isUncertainJobFailure({ state: "failed", externalOutcome: "unknown" }),
    ).toBe(true);
    // Definite external failure is not uncertainty.
    expect(
      isUncertainJobFailure({ state: "failed", externalOutcome: "failed" }),
    ).toBe(false);
    // Failures with NO external outcome (max attempts, not implemented) are
    // never conflated with uncertainty: nothing left the transaction.
    expect(
      isUncertainJobFailure({ state: "failed", externalOutcome: undefined }),
    ).toBe(false);
    expect(
      isUncertainJobFailure({ state: "failed", externalOutcome: "succeeded" }),
    ).toBe(false);
    // Non-failed states never count.
    expect(
      isUncertainJobFailure({ state: "succeeded", externalOutcome: "timeout" }),
    ).toBe(false);
    expect(
      isUncertainJobFailure({ state: "queued", externalOutcome: "timeout" }),
    ).toBe(false);
  });
});
