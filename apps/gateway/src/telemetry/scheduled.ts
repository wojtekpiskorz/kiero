/**
 * The gateway scheduled handler (I2): the cron-trigger entry that makes the
 * Worker the external heartbeat prober.
 *
 * Wired as the `scheduled` export of the Worker entry (the wrangler cron
 * trigger is configured by the gateway wrangler config owner; the handler is
 * correct and inert until that trigger exists). One run = one heartbeat.
 */

import { sendGatewayHeartbeat } from "./heartbeat";
import type { ConvexIngestEnv, TelemetryEnv } from "./emit";

/** The cron entry: sends one gateway heartbeat, never throws. */
export async function telemetryScheduled(
  _controller: ScheduledController,
  env: TelemetryEnv & ConvexIngestEnv,
): Promise<void> {
  await sendGatewayHeartbeat(env).catch(() => undefined);
}
