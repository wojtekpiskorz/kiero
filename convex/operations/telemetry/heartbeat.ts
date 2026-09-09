/**
 * The backend-silence model (I2).
 *
 * PURE MODULE. Two independent detection layers, per the accepted
 * architecture ("External missing-health detection must still find total
 * backend silence"):
 *
 * 1. IN-APP staleness (this module): services record heartbeats through the
 *    Convex HTTP boundary; the telemetry state read computes per-service
 *    freshness. This catches a worker/backup job stopping while Convex is up.
 * 2. SINK-SIDE absence (infra/observability/monitors.json): the external
 *    monitor alerts when heartbeat EVENTS stop arriving at the observability
 *    sink. This layer works even when Convex itself is totally silent - the
 *    monitor never depended on Convex's own liveness or on application event
 *    delivery succeeding.
 */

/** Services whose heartbeats are recorded (closed vocabulary). */
export const HEARTBEAT_SERVICES = [
  "gateway.worker",
  "backup.job",
  "media.worker",
  "export.worker",
] as const;

export type HeartbeatService = (typeof HEARTBEAT_SERVICES)[number];

/**
 * Expected heartbeat cadence per service (milliseconds). The silence
 * threshold is three missed cadences, so one skipped run never pages.
 */
export const HEARTBEAT_CADENCE_MS: Record<HeartbeatService, number> = {
  // Gateway cron trigger runs every 5 minutes (the external prober role).
  "gateway.worker": 5 * 60 * 1000,
  // Backup container runs every 15 minutes (I5's schedule).
  "backup.job": 15 * 60 * 1000,
  "media.worker": 15 * 60 * 1000,
  "export.worker": 15 * 60 * 1000,
};

/** How many missed cadences count as silence. */
export const SILENCE_TOLERANCE = 3;

/** Bounded heartbeat history kept per service (the recorder prunes the tail). */
export const HEARTBEATS_KEPT_PER_SERVICE = 20;

export type ServiceSilenceState = "never_seen" | "ok" | "late" | "silent";

export interface ServiceSilence {
  readonly serviceName: HeartbeatService;
  readonly state: ServiceSilenceState;
  /** Age of the newest heartbeat, if any. */
  readonly ageMs: number | null;
  /** Silence threshold in ms (3x cadence). */
  readonly thresholdMs: number;
  readonly lastStatus: "ok" | "degraded" | null;
}

/**
 * Computes one service's silence state from its newest heartbeat.
 * `ok` within 2x cadence, `late` within 3x, `silent` beyond.
 */
export function serviceSilence(
  serviceName: HeartbeatService,
  lastHeartbeat: { atMs: number; status: "ok" | "degraded" } | null,
  nowMs: number,
): ServiceSilence {
  const cadence = HEARTBEAT_CADENCE_MS[serviceName];
  const thresholdMs = cadence * SILENCE_TOLERANCE;
  if (lastHeartbeat === null) {
    return { serviceName, state: "never_seen", ageMs: null, thresholdMs, lastStatus: null };
  }
  const ageMs = Math.max(0, nowMs - lastHeartbeat.atMs);
  const state: ServiceSilenceState =
    ageMs <= cadence * 2 ? "ok" : ageMs <= thresholdMs ? "late" : "silent";
  return { serviceName, state, ageMs, thresholdMs, lastStatus: lastHeartbeat.status };
}

/** Computes every watched service's silence state. */
export function backendSilenceState(
  latest: Readonly<Record<string, { atMs: number; status: "ok" | "degraded" } | undefined>>,
  nowMs: number,
): { services: readonly ServiceSilence[]; anySilent: boolean } {
  const services = HEARTBEAT_SERVICES.map((service) =>
    serviceSilence(service, latest[service] ?? null, nowMs),
  );
  return {
    services,
    anySilent: services.some(
      (service) => service.state === "silent" || service.state === "never_seen",
    ),
  };
}
