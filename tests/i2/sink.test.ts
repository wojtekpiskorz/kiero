/**
 * Sink tests (I2): the Axiom emitter behind the TelemetrySink interface,
 * exercised against a LOCAL sink (injected fetch) with no network, plus the
 * honest not-configured behavior.
 */

import { describe, expect, it } from "vitest";
import {
  axiomHttpSink,
  nullSink,
  toSinkEvent,
  type SinkEvent,
} from "../../convex/operations/telemetry/sink";
import { sanitizeDiagnosticEvent } from "../../convex/operations/telemetry/redact";

describe("axiomHttpSink with a local sink", () => {
  it("POSTs sanitized events to the dataset ingest endpoint with the bearer token", async () => {
    const captures: { url: string; init: RequestInit; body: SinkEvent[] }[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      captures.push({
        url: String(url),
        init: init ?? {},
        body: JSON.parse(String(init?.body)) as SinkEvent[],
      });
      return new Response('{"ingested":1}', { status: 200 });
    }) as typeof fetch;

    const sink = axiomHttpSink({
      apiToken: "test-token-value",
      dataset: "kiero-observability",
      baseUrl: "https://local-sink.test/v1",
      fetchImpl: fakeFetch,
    });

    const sanitized = sanitizeDiagnosticEvent({
      kind: "ops.health.heartbeat",
      metadata: [
        { key: "serviceName", value: "gateway.worker" },
        { key: "status", value: "ok" },
      ],
    });
    expect(sanitized.status).toBe("ok");

    if (sanitized.status !== "ok") {
      throw new Error("fixture event must sanitize");
    }
    const event = toSinkEvent(
      sanitized.event,
      Date.parse("2026-09-09T12:00:00Z"),
      "convex",
      "dev",
    );
    const result = await sink.ingest([event]);

    expect(result).toEqual({ ok: true, ingested: 1 });
    expect(captures).toHaveLength(1);
    const capture = captures[0];
    expect(capture).toBeDefined();
    if (capture === undefined) {
      return;
    }
    expect(capture.url).toBe("https://local-sink.test/v1/datasets/kiero-observability/ingest");
    expect(capture.init.headers).toMatchObject({
      authorization: "Bearer test-token-value",
      "content-type": "application/json",
    });
    expect(capture.body[0]).toMatchObject({
      service: "convex",
      environment: "dev",
      kind: "ops.health.heartbeat",
    });
    expect(capture.body[0]?.metadata).toEqual({
      serviceName: "gateway.worker",
      status: "ok",
    });
    // The sanitized event carries no content-bearing field at all.
    const sentEvent = captures[0]?.body[0];
    expect(sentEvent).toBeDefined();
    if (sentEvent !== undefined) {
      expect(Object.keys(sentEvent)).toEqual([
        "_time",
        "service",
        "environment",
        "kind",
        "metadata",
      ]);
    }
  });

  it("reports non-2xx as a closed reason, never throws", async () => {
    const sink = axiomHttpSink({
      apiToken: "t",
      dataset: "d",
      baseUrl: "https://local-sink.test/v1",
      fetchImpl: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    const result = await sink.ingest([
      { _time: "2026-09-09T12:00:00.000Z", service: "s", environment: "dev", kind: "k", metadata: {} },
    ]);
    expect(result).toEqual({ ok: false, ingested: 0, reason: "axiom_status_401" });
  });

  it("network failure is a closed reason, never a throw into domain code", async () => {
    const sink = axiomHttpSink({
      apiToken: "t",
      dataset: "d",
      baseUrl: "https://local-sink.test/v1",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    const result = await sink.ingest([
      { _time: "2026-09-09T12:00:00.000Z", service: "s", environment: "dev", kind: "k", metadata: {} },
    ]);
    expect(result).toEqual({ ok: false, ingested: 0, reason: "axiom_unreachable" });
  });

  it("an empty batch is a no-op success", async () => {
    const sink = axiomHttpSink({
      apiToken: "t",
      dataset: "d",
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    expect(await sink.ingest([])).toEqual({ ok: true, ingested: 0 });
  });
});

describe("the not-configured sink", () => {
  it("reports honestly instead of pretending delivery", async () => {
    const sink = nullSink("axiom_not_configured");
    expect(await sink.ingest([
      { _time: "2026-09-09T12:00:00.000Z", service: "s", environment: "dev", kind: "k", metadata: {} },
    ])).toEqual({ ok: false, ingested: 0, reason: "axiom_not_configured" });
    expect(sink.name).toBe("null");
  });
});
