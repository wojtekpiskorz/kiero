/**
 * The gateway telemetry surface (I2): request-scoped redacted events for the
 * architecture's GW -> OBS flow.
 *
 * Round-1 repairs:
 * - Delivery is scheduled through `ctx.waitUntil` when the Worker runtime
 *   provides an ExecutionContext: best-effort telemetry is NEVER on the
 *   request critical path (the response is already on its way when the
 *   emit POST runs). Without a context (tests) the emit is fire-and-forget.
 * - The Axiom client is the ONE shipped sink (`convex/operations/telemetry/
 *   sink.ts`: ingest POST, metadata flattening, redactionsApplied injection,
 *   injectable fetch) - this module no longer reimplements any of it.
 *
 * Delivery remains two-path and best effort: Axiom direct when the Worker
 * holds `AXIOM_API_TOKEN` + `AXIOM_DATASET`, otherwise the verified Convex
 * ingest endpoint (where the SAME single sanitizer applies), otherwise an
 * honest drop. Nothing here ever throws into request handling.
 */

import {
  axiomHttpSink,
  toSinkEvent,
} from "../../../../convex/operations/telemetry/sink";
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

/** The Convex HTTP endpoint base + service token (bridge bindings). */
export interface ConvexIngestEnv {
  readonly CONVEX_SITE_URL?: string;
  readonly KIERO_SERVICE_TOKEN?: string;
}

/** The scheduling seam: Workers pass ExecutionContext; tests pass a collector. */
export interface TelemetryScheduler {
  waitUntil(promise: Promise<unknown>): void;
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
    // The single sanitizer definition, imported across the tree.
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
  const sink = axiomHttpSink({ apiToken: env.AXIOM_API_TOKEN ?? "", dataset });
  const sinkEvents = events.map((event) =>
    toSinkEvent(event, Date.now(), "gateway.worker", environmentTag(env)),
  );
  const result = await sink.ingest(sinkEvents);
  return result.ok
    ? { delivered: true, via: "axiom", accepted: result.ingested }
    : { delivered: false, via: "dropped", reason: result.reason ?? "axiom_failed" };
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

/**
 * Wraps one request handler with request-scoped redacted telemetry. The
 * emit is scheduled through `scheduler.waitUntil` (Workers: the real
 * ExecutionContext) so the response is never blocked on telemetry delivery;
 * without a scheduler it degrades to fire-and-forget.
 */
export async function withGatewayTelemetry(
  env: TelemetryEnv & ConvexIngestEnv,
  scheduler: TelemetryScheduler | undefined,
  pathname: string,
  handle: () => Promise<Response>,
): Promise<Response> {
  const startedAtMs = Date.now();
  const requestEvent = (httpStatus: string): GatewayEventInput => ({
    kind: "ops.gateway.request",
    metadata: [
      { key: "route", value: pathname.slice(0, 120) },
      { key: "httpStatus", value: httpStatus },
      { key: "latencyMs", value: String(Date.now() - startedAtMs) },
      { key: "environment", value: environmentTag(env) },
    ],
  });
  const emit = (httpStatus: string) =>
    emitGatewayEvents(env, [requestEvent(httpStatus)]).catch(() => undefined);

  let response: Response;
  try {
    response = await handle();
  } catch (error) {
    // Best effort: the failure itself is the telemetry, never the error text.
    const pending = emit("500");
    if (scheduler !== undefined) {
      scheduler.waitUntil(pending);
    } else {
      void pending;
    }
    throw error;
  }
  const pending = emit(String(response.status));
  if (scheduler !== undefined) {
    scheduler.waitUntil(pending);
  } else {
    void pending;
  }
  return response;
}
