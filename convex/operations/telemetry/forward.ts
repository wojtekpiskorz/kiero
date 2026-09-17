/**
 * The sink-forward outcome model (R27, issue #235).
 *
 * PURE MODULE, single definition: the closed status-class vocabulary for the
 * Convex->Axiom ingest leg, the classification of a `SinkIngestResult` into
 * it, and the health derivation the composed telemetry state exposes.
 *
 * Why this module exists: the every-minute telemetry tick dropped the
 * `SinkIngestResult` (`cron.ts`'s forwardRecentToSink), so a refused or
 * unreachable forward was indistinguishable from a forward that never ran -
 * every dashboard silence since I11's qualification is explained by that gap.
 * The bounded repair (this issue) records the outcome DURABLY: status class
 * only, never response bodies, credential values or token material.
 *
 * The honest-state pattern is the backup lane's (freshness state persisted on
 * rows and surfaced through the composed reads, not guessed from silence):
 * the tick records one `telemetry.sink` heartbeat row per attempt (and one
 * liveness row when the window is empty), so a persistently failing forward
 * leg is visible in the existing health/ops surfaces even when zero events
 * ever leave the table.
 */

import {
  SINK_REASON_NOT_CONFIGURED,
  SINK_REASON_UNREACHABLE,
  SINK_STATUS_REASON_PREFIX,
  type SinkIngestResult,
} from "./sink";
import type { HeartbeatService } from "./heartbeat";

/**
 * The closed status-class vocabulary for one sink-forward attempt.
 * Deliberately classes, never payloads: the owner reads WHICH failure mode
 * (wrong token, wrong dataset, unreachable, not configured), not why in
 * prose - response bodies and credential material cannot appear.
 */
export const FORWARD_STATUSES = [
  /** The sink accepted the batch. */
  "ok",
  /** No sink was constructed: the deployment holds no token/dataset. */
  "not_configured",
  /** The sink refused the request as unauthenticated/unauthorized (401/403). */
  "refused_credentials",
  /** The sink refused the target (404 - e.g. a wrong dataset name). */
  "refused_target",
  /** The sink endpoint could not be reached (network error). */
  "unreachable",
  /** Any other non-success the closed classes above do not name. */
  "unknown",
] as const;

export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

/**
 * The heartbeat service identity of the telemetry tick's forward leg. The
 * tick records one bounded-tail `healthHeartbeats` row per run, so the
 * existing silence machinery also detects the tick itself stopping.
 */
export const FORWARD_TICK_SERVICE = "telemetry.sink" as const satisfies HeartbeatService;

/** The cron cadence the silence machinery must assume for the tick. */
export const FORWARD_TICK_CADENCE_MS = 60 * 1000;

/**
 * Maps one sink result into the closed vocabulary. Total: any reason string
 * - including junk or adversarial content - collapses into a class, so no
 * raw reason, status line or body fragment can ever be persisted or exposed
 * through this path.
 */
export function classifySinkResult(result: SinkIngestResult): ForwardStatus {
  if (result.ok) {
    return "ok";
  }
  const reason = result.reason ?? "";
  if (reason === SINK_REASON_UNREACHABLE) {
    return "unreachable";
  }
  if (reason === SINK_REASON_NOT_CONFIGURED) {
    return "not_configured";
  }
  if (reason.startsWith(SINK_STATUS_REASON_PREFIX)) {
    const code = reason.slice(SINK_STATUS_REASON_PREFIX.length);
    if (code === "401" || code === "403") {
      return "refused_credentials";
    }
    if (code === "404") {
      return "refused_target";
    }
  }
  return "unknown";
}

/** One `telemetry.sink` tick row in the shape the health derivation reads. */
export interface SinkForwardTickRow {
  readonly atMs: number;
  /** The heartbeat ledger's coarse state: degraded = the attempt failed. */
  readonly status: "ok" | "degraded";
  /** The attempt's status class; absent = the window was empty (no attempt). */
  readonly forwardStatus?: ForwardStatus;
}

/** The honest states of the forward leg the health surface reports. */
export type SinkForwardState = "never_recorded" | "ok" | "idle" | "failing";

/** The composed state's forward block: what the owner reads instead of guessing. */
export interface SinkForwardHealth {
  readonly state: SinkForwardState;
  /** The newest attempt's status class; null when no attempt is recorded. */
  readonly status: ForwardStatus | null;
  /** When the tick last ran at all (liveness of the leg, attempts aside). */
  readonly lastTickAtMs: number | null;
  /** When an attempt last succeeded (bounded by the heartbeat tail). */
  readonly lastOkAtMs: number | null;
  /** Consecutive failed attempts through the newest tick (tail-bounded). */
  readonly consecutiveFailures: number;
}

/**
 * Derives the forward-leg health from the `telemetry.sink` tick rows,
 * NEWEST FIRST (the composed read's index order). The same honest-state
 * derivation the backup lane's freshness model uses: state from persisted
 * rows, never from the absence of events.
 */
export function sinkForwardHealth(
  ticksNewestFirst: readonly SinkForwardTickRow[],
): SinkForwardHealth {
  const newest = ticksNewestFirst[0];
  if (newest === undefined) {
    return {
      state: "never_recorded",
      status: null,
      lastTickAtMs: null,
      lastOkAtMs: null,
      consecutiveFailures: 0,
    };
  }
  let lastOkAtMs: number | null = null;
  let consecutiveFailures = 0;
  for (const tick of ticksNewestFirst) {
    if (tick.forwardStatus === "ok") {
      lastOkAtMs = tick.atMs;
      break;
    }
    if (tick.forwardStatus !== undefined) {
      consecutiveFailures += 1;
    }
  }
  const status = newest.forwardStatus ?? null;
  const state: SinkForwardState =
    status === null ? "idle" : status === "ok" ? "ok" : "failing";
  return {
    state,
    status,
    lastTickAtMs: newest.atMs,
    lastOkAtMs,
    consecutiveFailures,
  };
}
