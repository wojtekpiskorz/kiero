/**
 * The telemetry sink boundary (I2).
 *
 * Axiom is the accepted observability destination, but account provisioning
 * is an OWNER action (no AXIOM_API_TOKEN exists in any environment yet; see
 * infra/observability/README.md for the exact PENDING steps). The emitter is
 * therefore behind this interface:
 *
 * - `axiomHttpSink`: the real ingest client (Axiom REST ingest, dataset
 *   events). Constructed only when the deployment actually holds a token.
 * - `nullSink`: the honest not-configured sink (reports, never throws).
 *
 * Delivery is BEST EFFORT by design: telemetry never blocks or fails domain
 * work, and the Convex tables (plus canonical domain records) remain the
 * authority. Fetch is injectable so tests run against a local sink without
 * any network.
 */


/** One event shaped for the sink (Axiom ingest event format). */
export interface SinkEvent {
  readonly _time: string;
  readonly service: string;
  readonly environment: string;
  readonly kind: string;
  /** Flat string map; the sanitizer guarantees format-checked values only. */
  readonly metadata: Record<string, string>;
}

export interface SinkIngestResult {
  readonly ok: boolean;
  readonly ingested: number;
  /** Machine-readable not-success reason (never payload content). */
  readonly reason?: string;
}

/** The one delivery interface every telemetry producer talks to. */
export interface TelemetrySink {
  readonly name: string;
  ingest(events: readonly SinkEvent[]): Promise<SinkIngestResult>;
}

/**
 * A stored/redacted event in its unbranded form: rows read back from
 * `diagnosticEvents` were sanitized at write time, so the sink mapping only
 * needs the structural shape (no new escape hatch around the sanitizer).
 */
export interface StoredDiagnosticEvent {
  readonly kind: string;
  readonly metadata: readonly { key: string; value: string }[];
  readonly redactionsApplied: number;
  readonly redactionVersion: string;
  readonly serviceName?: string;
  readonly environment?: string;
}

/** Maps a sanitized event into the sink shape (no new escape hatch). */
export function toSinkEvent(
  event: StoredDiagnosticEvent,
  atMs: number,
  defaultService: string,
  defaultEnvironment: string,
): SinkEvent {
  const metadata: Record<string, string> = {};
  for (const entry of event.metadata) {
    metadata[entry.key] = entry.value;
  }
  if (event.redactionsApplied > 0) {
    metadata.redactionsApplied = String(event.redactionsApplied);
  }
  return {
    _time: new Date(atMs).toISOString(),
    service: event.serviceName ?? defaultService,
    environment: event.environment ?? defaultEnvironment,
    kind: event.kind,
    metadata,
  };
}

export interface AxiomSinkConfig {
  readonly apiToken: string;
  readonly dataset: string;
  /** Override for tests/local sinks; defaults to the Axiom REST endpoint. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The real Axiom ingest client. Failures return `{ok: false}` with a closed
 * reason; they never throw into callers (best-effort contract).
 */
export function axiomHttpSink(config: AxiomSinkConfig): TelemetrySink {
  return {
    name: "axiom",
    ingest: async (events) => {
      if (events.length === 0) {
        return { ok: true, ingested: 0 };
      }
      const doFetch = config.fetchImpl ?? fetch;
      const base = config.baseUrl ?? "https://api.axiom.co/v1";
      try {
        const response = await doFetch(`${base}/datasets/${config.dataset}/ingest`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(events),
        });
        if (!response.ok) {
          return { ok: false, ingested: 0, reason: `axiom_status_${response.status}` };
        }
        return { ok: true, ingested: events.length };
      } catch {
        return { ok: false, ingested: 0, reason: "axiom_unreachable" };
      }
    },
  };
}

/** The not-configured sink: reports honestly instead of pretending delivery. */
export function nullSink(reason: string): TelemetrySink {
  return {
    name: "null",
    ingest: async (_events) => ({ ok: false, ingested: 0, reason }),
  };
}
