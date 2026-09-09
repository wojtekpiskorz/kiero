/**
 * The gateway telemetry surface (I2): request-scoped redacted events for the
 * architecture's GW -> OBS flow.
 *
 * Delivery is two-path and best effort:
 *
 * 1. AXIOM DIRECT: when the Worker holds `AXIOM_API_TOKEN` +
 *    `AXIOM_DATASET`, events go straight to the sink (the architecture's
 *    primary flow; the token is a Worker secret binding, never a value).
 * 2. CONVEX INGEST fallback: otherwise events are posted to the verified
 *    Convex ingest endpoint, where they pass the SAME single sanitizer
 *    (imported from the Convex tree - one definition, no drifting copy) and
 *    become readable through the query surface. This keeps the dev/alpha
 *    (pre-Axiom) window honest without pretending delivery happened.
 * 3. Neither configured: events are dropped and counted as such.
 *
 * Nothing here ever throws into request handling.
 */

import {
  sanitizeDiagnosticEvent,
  type SanitizedDiagnosticEvent,
} from "../../../../convex/operations/telemetry/redact";

/** The telemetry bindings this surface consumes (names only; secrets injected). */
export interface TelemetryEnv {
  readonly AXIOM_API_TOKEN?: string;
  readonly AXIOM_DATASET?: string;
  readonly ENVIRONMENT?: string;
}

/** One raw gateway event before redaction (trusted only after sanitizing). */
export interface GatewayEventInput {
  readonly kind: string;
  readonly metadata: { key: string; value: string }[];
}

export type TelemetryDelivery =
  | { readonly delivered: true; readonly via: "axiom" | "convex"; readonly accepted: number }
  | { readonly delivered: false; readonly via: "dropped"; readonly reason: string };

function environmentTag(env: TelemetryEnv): string {
  return env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "alpha-production"
    ? env.ENVIRONMENT
    : "dev";
}

/** Sanitizes events locally first: the sink must never see unsanitized shapes. */
export function sanitizeGatewayEvents(
  env: TelemetryEnv,
  events: readonly GatewayEventInput[],
): SanitizedDiagnosticEvent[] {
  const sanitized: SanitizedDiagnosticEvent[] = [];
  for (const event of events) {
    const result = sanitizeDiagnosticEvent({
      kind: event.kind,
      metadata: event.metadata,
      serviceName: "gateway.worker",
      environment: environmentTag(env),
    });
    if (result.status === "ok") {
      sanitized.push(result.event);
    }
  }
  return sanitized;
}

async function postAxiom(
  env: TelemetryEnv,
  events: readonly SanitizedDiagnosticEvent[],
): Promise<TelemetryDelivery> {
  const dataset = env.AXIOM_DATASET;
  if (dataset === undefined || dataset === "") {
    return { delivered: false, via: "dropped", reason: "axiom_dataset_missing" };
  }
  const payload = events.map((event) => ({
    _time: new Date().toISOString(),
    service: "gateway.worker",
    environment: environmentTag(env),
    kind: event.kind,
    metadata: Object.fromEntries([
      ...event.metadata.map((entry) => [entry.key, entry.value] as const),
      ...(event.redactionsApplied > 0
        ? ([["redactionsApplied", String(event.redactionsApplied)]] as const)
        : []),
    ]),
  }));
  try {
    const response = await fetch(`https://api.axiom.co/v1/datasets/${dataset}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AXIOM_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { delivered: false, via: "dropped", reason: `axiom_status_${response.status}` };
    }
    return { delivered: true, via: "axiom", accepted: events.length };
  } catch {
    return { delivered: false, via: "dropped", reason: "axiom_unreachable" };
  }
}

/** The Convex HTTP endpoint base + service token (bridge bindings). */
export interface ConvexIngestEnv {
  readonly CONVEX_SITE_URL?: string;
  readonly KIERO_SERVICE_TOKEN?: string;
}

async function postConvexIngest(
  env: ConvexIngestEnv,
  events: readonly SanitizedDiagnosticEvent[],
): Promise<TelemetryDelivery> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return { delivered: false, via: "dropped", reason: "convex_ingest_not_configured" };
  }
  try {
    const response = await fetch(`${site.replace(/\/$/, "")}/platform/telemetry/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
    });
    if (!response.ok) {
      return { delivered: false, via: "dropped", reason: `convex_status_${response.status}` };
    }
    return { delivered: true, via: "convex", accepted: events.length };
  } catch {
    return { delivered: false, via: "dropped", reason: "convex_unreachable" };
  }
}

/** Emits redacted gateway events: Axiom when configured, Convex ingest otherwise. */
export async function emitGatewayEvents(
  env: TelemetryEnv & ConvexIngestEnv,
  events: readonly GatewayEventInput[],
): Promise<TelemetryDelivery> {
  if (events.length === 0) {
    return { delivered: true, via: "convex", accepted: 0 };
  }
  const sanitized = sanitizeGatewayEvents(env, events);
  if (sanitized.length === 0) {
    return { delivered: false, via: "dropped", reason: "all_events_rejected" };
  }
  if (env.AXIOM_API_TOKEN !== undefined && env.AXIOM_API_TOKEN !== "") {
    return postAxiom(env, sanitized);
  }
  return postConvexIngest(env, sanitized);
}

/** Wraps one request handler with request-scoped redacted telemetry. */
export async function withGatewayTelemetry(
  env: TelemetryEnv & ConvexIngestEnv,
  pathname: string,
  handle: () => Promise<Response>,
): Promise<Response> {
  const startedAtMs = Date.now();
  let response: Response;
  try {
    response = await handle();
  } catch (error) {
    // Best effort: the failure itself is the telemetry, never the error text.
    await emitGatewayEvents(env, [
      {
        kind: "ops.gateway.request",
        metadata: [
          { key: "route", value: pathname.slice(0, 120) },
          { key: "httpStatus", value: "500" },
          { key: "latencyMs", value: String(Date.now() - startedAtMs) },
          { key: "environment", value: environmentTag(env) },
        ],
      },
    ]).catch(() => undefined);
    throw error;
  }
  await emitGatewayEvents(env, [
    {
      kind: "ops.gateway.request",
      metadata: [
        { key: "route", value: pathname.slice(0, 120) },
        { key: "httpStatus", value: String(response.status) },
        { key: "latencyMs", value: String(Date.now() - startedAtMs) },
        { key: "environment", value: environmentTag(env) },
      ],
    },
  ]).catch(() => undefined);
  return response;
}
