/**
 * The incident classification model (I2): which platform rows, as they stand,
 * must produce a redacted diagnostic event right now.
 *
 * PURE MODULE (unit-testable without Convex). The scan mutation reads the
 * A3 surfaces (`durableJobs`, `outboxEvents`, `processingRuns`) and hands the
 * rows here; this module decides - including the A3 handoff note "attempts-
 * exhausted replay diagnostics": a durable job that exhausted maxAttempts
 * across every replay is diagnosed EXACTLY once (dedup key from jobKey).
 */

/** A processing run still `running` after this long is stuck (target: 95% under 60s). */
export const STUCK_RUN_MS = 30 * 60 * 1000;

export interface JobRowLike {
  readonly jobKey: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastErrorKind?: string;
}

export interface OutboxRowLike {
  readonly eventId: string;
  readonly eventName: string;
  readonly deliveryState: string;
  readonly attempts: number;
  readonly lastErrorKind?: string;
}

export interface RunRowLike {
  readonly runId: string;
  readonly state: string;
  readonly startedAtMs: number;
}

/** One incident the scan must emit (kind + dedup identity + safe metadata). */
export interface IncidentEmit {
  readonly kind: "ops.job.attempts_exhausted" | "ops.outbox.delivery_failed" | "ops.processing.stuck";
  readonly dedupKey: string;
  readonly metadata: readonly { key: string; value: string }[];
}

/**
 * Classifies current rows into incident emissions. Only terminal/failed work
 * and stuck runs produce incidents; healthy and in-flight rows never do.
 */
export function classifyIncidents(
  rows: {
    readonly jobs: readonly JobRowLike[];
    readonly outbox: readonly OutboxRowLike[];
    readonly runs: readonly RunRowLike[];
  },
  nowMs: number,
): IncidentEmit[] {
  const incidents: IncidentEmit[] = [];

  for (const job of rows.jobs) {
    if (job.state === "failed" && job.attempts >= job.maxAttempts) {
      incidents.push({
        kind: "ops.job.attempts_exhausted",
        dedupKey: `incident:job_exhausted:${job.jobKey}`,
        metadata: [
          { key: "jobKey", value: job.jobKey },
          { key: "jobKind", value: job.kind },
          { key: "errorKind", value: job.lastErrorKind ?? "max_attempts_exceeded" },
          { key: "attempts", value: String(job.attempts) },
          { key: "maxAttempts", value: String(job.maxAttempts) },
        ],
      });
    }
  }

  for (const row of rows.outbox) {
    if (row.deliveryState === "failed") {
      incidents.push({
        kind: "ops.outbox.delivery_failed",
        dedupKey: `incident:outbox_failed:${row.eventId}`,
        metadata: [
          { key: "eventId", value: row.eventId },
          { key: "eventName", value: row.eventName },
          { key: "errorKind", value: row.lastErrorKind ?? "unknown" },
          { key: "attempts", value: String(row.attempts) },
        ],
      });
    }
  }

  for (const run of rows.runs) {
    const ageMs = nowMs - run.startedAtMs;
    if (run.state === "running" && ageMs > STUCK_RUN_MS) {
      incidents.push({
        kind: "ops.processing.stuck",
        dedupKey: `incident:run_stuck:${run.runId}`,
        metadata: [
          { key: "runId", value: run.runId },
          { key: "ageMs", value: String(ageMs) },
          { key: "state", value: "running" },
        ],
      });
    }
  }

  return incidents;
}
