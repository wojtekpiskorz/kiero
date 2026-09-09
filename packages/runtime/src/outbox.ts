/**
 * Outbox and durable-job decision logic (pure).
 *
 * The transactional half lives in `convex/platform/publish.ts` (it needs the
 * Convex transaction handle); this module owns every decision those
 * transactions make, so idempotency, retry and uncertain-outcome rules are
 * unit-testable without Convex and have exactly one definition.
 *
 * Uncertain outcomes (architecture protocol step 9): a timeout after possible
 * provider success never justifies a blind retry. An `unknown` outcome blocks
 * re-execution until reconciliation observes the external system's actual
 * state; only a reconciled "not delivered" may retry.
 */

import type { DurableJobState, OutboxDeliveryState } from "@kiero/contracts";

/** Delivery states of the outbox state machine. */
export const deliveryStates = [
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "superseded",
] as const satisfies readonly OutboxDeliveryState[];

/** Durable job states. */
export const jobStates = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly DurableJobState[];

/** The outcome an external (non-transactional) call can have. */
export type ExternalOutcome = "succeeded" | "failed" | "timeout" | "unknown";

/** What a publisher should do given any existing row with the same dedup key. */
export type PublicationDecision =
  | { readonly decision: "insert" }
  | { readonly decision: "deduplicated"; readonly existingEventId: string };

/**
 * Decides an outbox publication against a possible existing row with the same
 * semantic dedup key. Replaying the same logical operation never creates a
 * second row: the existing event identity is returned instead.
 */
export function decideEventPublication(
  existing: { readonly eventId: string } | null,
): PublicationDecision {
  if (existing === null) {
    return { decision: "insert" };
  }
  return { decision: "deduplicated", existingEventId: existing.eventId };
}

/** The failure nature of an existing durable job row, when it failed. */
export type JobFailureNature = "definite" | "uncertain";

/** What a durable registration should do given the current row state. */
export type JobRegistrationDecision =
  | { readonly decision: "register" }
  | {
      readonly decision: "skip";
      readonly reason: "already_succeeded" | "active_attempt" | "uncertain_outcome";
    };

/** The existing-row shape the registration decision is made from. */
export interface ExistingJobRow {
  readonly state: DurableJobState;
  /**
   * Outcome of the attempt that left the transaction, when there was one.
   * `timeout`/`unknown` mark an UNCERTAIN failure: the external effect may
   * have happened, so re-registration is forbidden until reconciliation
   * observes the external system.
   */
  readonly externalOutcome: ExternalOutcome | undefined;
}

/**
 * Decides a durable job registration against an existing row with the same
 * dedup identity. Succeeded jobs replay as no-ops; an active attempt is
 * never duplicated; a failure re-registers ONLY when it is definite
 * (`externalOutcome` failed or absent). Uncertain failures
 * (`timeout`/`unknown`) skip with their own reason: the blind retry the
 * protocol exists to prevent would duplicate the external effect, and only
 * reconciliation (which observes the external system) may re-queue.
 */
export function decideJobRegistration(
  existing: ExistingJobRow | null,
): JobRegistrationDecision {
  if (existing === null) {
    return { decision: "register" };
  }
  if (existing.state === "succeeded" || existing.state === "cancelled") {
    return { decision: "skip", reason: "already_succeeded" };
  }
  if (existing.state === "queued" || existing.state === "running") {
    return { decision: "skip", reason: "active_attempt" };
  }
  if (isUncertainJobFailure(existing)) {
    return { decision: "skip", reason: "uncertain_outcome" };
  }
  // definite failure: register again (bounded by maxAttempts at execution time).
  return { decision: "register" };
}

/**
 * The ONE definition of an uncertain failure (timeout/unknown after an
 * attempt that left the transaction). A row failed without an external
 * outcome (max attempts exhausted, not implemented, bad input) is NOT
 * uncertain: nothing left the transaction, so a retry cannot duplicate an
 * external effect.
 */
export function isUncertainJobFailure(row: ExistingJobRow): boolean {
  return (
    row.state === "failed" &&
    (row.externalOutcome === "timeout" || row.externalOutcome === "unknown")
  );
}

/** Bounded exponential backoff for delivery/job retries (capped at 1 minute). */
export function backoffDelayMs(failedAttempts: number, baseMs: number): number {
  if (failedAttempts <= 0) {
    return baseMs;
  }
  const exponent = Math.min(failedAttempts - 1, 6);
  return Math.min(baseMs * 2 ** exponent, 60_000);
}

/** The result a delivery attempt produces, before state transitions. */
export interface DeliveryAttemptResult {
  readonly outcome: ExternalOutcome;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/** The state transition a delivery attempt implies for the outbox row. */
export type DeliveryTransition =
  | { readonly to: "delivered" }
  | { readonly to: "in_flight"; readonly nextAttemptAtMs: number }
  | { readonly to: "failed"; readonly terminal: boolean };

/**
 * Applies the delivery state machine to one attempt result.
 *
 * `succeeded` delivers. `failed` retries with backoff until `maxAttempts`,
 * then fails terminally. `timeout`/`unknown` NEVER auto-retry: the row moves
 * to `failed` with `terminal: false` semantics expressed by remaining
 * reconcilable; reconciliation decides retry from observed external state.
 * (The outbox row keeps its attempts so the reconciler can distinguish a
 * terminal failure from an uncertain one.)
 */
export function nextDeliveryState(
  result: DeliveryAttemptResult,
  nowMs: number,
  baseMs: number,
): DeliveryTransition {
  if (result.outcome === "succeeded") {
    return { to: "delivered" };
  }
  if (result.outcome === "unknown" || result.outcome === "timeout") {
    // Uncertain: record and stop. Reconciliation owns the next move.
    return { to: "failed", terminal: false };
  }
  if (result.attempts >= result.maxAttempts) {
    return { to: "failed", terminal: true };
  }
  return {
    to: "in_flight",
    nextAttemptAtMs: nowMs + backoffDelayMs(result.attempts, baseMs),
  };
}

/** Whether a failed delivery may be retried after reconciliation. */
export function reconcileMayRetry(
  observedExternalState: "delivered" | "not_delivered",
): boolean {
  // Observed delivered: nothing left to do. Observed not delivered: retry.
  return observedExternalState === "not_delivered";
}
