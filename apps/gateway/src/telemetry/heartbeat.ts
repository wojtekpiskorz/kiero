/**
 * The gateway heartbeat (I2): the external prober role in backend-silence
 * detection.
 *
 * The Worker cron trigger (`scheduled` in the entry, configured by the
 * gateway wrangler config) pings the Convex heartbeat endpoint every few
 * minutes. Two independent detection layers result:
 *
 * - Convex-side: heartbeats land in `healthHeartbeats`; the telemetry state
 *   read computes staleness per service, and the cron tick emits
 *   `ops.health.silence_detected` for services whose latest heartbeat is
 *   beyond the silence threshold.
 * - Sink-side: the monitor alerts when heartbeat EVENTS stop arriving at
 *   the observability sink - a condition Convex can never report itself.
 *
 * ONE emission point per signal (round-1 repair): the heartbeat endpoint's
 * `recordHeartbeat` emits the single `ops.health.heartbeat` event (it is
 * the only sink path for non-gateway probers too); the gateway client only
 * records the ledger row and never emits a second event for the same ping.
 * A heartbeat failure is logged-and-continued; it never throws.
 */

import type { ConvexIngestEnv, TelemetryEnv } from "./emit";

export interface HeartbeatResult {
  readonly recorded: boolean;
  readonly reason?: string;
}

/** Records one gateway heartbeat row (the endpoint emits the single event). */
export async function sendGatewayHeartbeat(
  env: TelemetryEnv & ConvexIngestEnv,
  status: "ok" | "degraded" = "ok",
): Promise<HeartbeatResult> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return { recorded: false, reason: "convex_ingest_not_configured" };
  }
  try {
    const response = await fetch(`${site.replace(/\/$/, "")}/platform/telemetry/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ serviceName: "gateway.worker", status }),
    });
    if (!response.ok) {
      return { recorded: false, reason: `convex_status_${response.status}` };
    }
    return { recorded: true };
  } catch {
    return { recorded: false, reason: "convex_unreachable" };
  }
}
