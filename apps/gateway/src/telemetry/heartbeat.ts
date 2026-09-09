/**
 * The gateway heartbeat (I2): the external prober role in backend-silence
 * detection.
 *
 * The Worker cron trigger (`scheduled` in the entry, configured by the
 * gateway wrangler config) pings the Convex heartbeat endpoint every few
 * minutes. Two independent detection layers result:
 *
 * - Convex-side: heartbeats land in `healthHeartbeats`; the telemetry state
 *   read computes staleness per service.
 * - Sink-side: the gateway ALSO emits `ops.health.heartbeat` events (Axiom
 *   direct when configured): when they stop arriving at the monitor, the
 *   backend is totally silent - a condition Convex can never report itself.
 *
 * A heartbeat failure is logged-and-continued; it never throws.
 */

import { emitGatewayEvents, type ConvexIngestEnv, type TelemetryEnv } from "./emit";

export interface HeartbeatResult {
  readonly recorded: boolean;
  readonly eventEmitted: boolean;
  readonly reason?: string;
}

/** Sends one gateway heartbeat: sink event + Convex ledger row, best effort. */
export async function sendGatewayHeartbeat(
  env: TelemetryEnv & ConvexIngestEnv,
  status: "ok" | "degraded" = "ok",
): Promise<HeartbeatResult> {
  const delivery = await emitGatewayEvents(env, [
    {
      kind: "ops.health.heartbeat",
      metadata: [
        { key: "serviceName", value: "gateway.worker" },
        { key: "status", value: status },
      ],
    },
  ]).catch(() => undefined);

  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return { recorded: false, eventEmitted: delivery?.delivered === true, reason: "convex_ingest_not_configured" };
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
      return { recorded: false, eventEmitted: delivery?.delivered === true, reason: `convex_status_${response.status}` };
    }
    return { recorded: true, eventEmitted: delivery?.delivered === true };
  } catch {
    return { recorded: false, eventEmitted: delivery?.delivered === true, reason: "convex_unreachable" };
  }
}
