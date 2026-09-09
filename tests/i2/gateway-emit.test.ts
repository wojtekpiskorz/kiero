/**
 * Gateway telemetry tests (I2): request-scoped redacted events with the
 * two-path delivery (Axiom direct / Convex ingest fallback / honest drop),
 * all against local fake fetch with no network.
 */

import { describe, expect, it } from "vitest";
import {
  emitGatewayEvents,
  withGatewayTelemetry,
} from "../../apps/gateway/src/telemetry/emit";
import { sendGatewayHeartbeat } from "../../apps/gateway/src/telemetry/heartbeat";

interface Capture {
  url: string;
  init: RequestInit | undefined;
}

function withCapturingFetch(
  status: number,
): { captures: Capture[]; fetchImpl: typeof fetch } {
  const captures: Capture[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    captures.push({ url: String(url), init });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { captures, fetchImpl };
}

const baseEnv = {
  CONVEX_SITE_URL: "https://backend.example",
  KIERO_SERVICE_TOKEN: "token-value",
  ENVIRONMENT: "dev",
};

describe("delivery paths", () => {
  it("prefers Axiom direct when the token binding exists", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await emitGatewayEvents(
        { ...baseEnv, AXIOM_API_TOKEN: "axiom-token", AXIOM_DATASET: "kiero-observability" },
        [
          {
            kind: "ops.gateway.request",
            metadata: [
              { key: "route", value: "/platform/health" },
              { key: "httpStatus", value: "200" },
              { key: "latencyMs", value: "12" },
              { key: "environment", value: "dev" },
            ],
          },
        ],
      );
      expect(result).toEqual({ delivered: true, via: "axiom", accepted: 1 });
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture === undefined) {
        return;
      }
      expect(capture.url).toContain("api.axiom.co/v1/datasets/kiero-observability/ingest");
      const body = JSON.parse(String(capture.init?.body)) as {
        kind: string;
        service: string;
        metadata: Record<string, string>;
      }[];
      expect(body[0]?.kind).toBe("ops.gateway.request");
      expect(body[0]?.service).toBe("gateway.worker");
      expect(body[0]?.metadata.route).toBe("/platform/health");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the Convex ingest endpoint without the token", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await emitGatewayEvents(baseEnv, [
        {
          kind: "ops.health.heartbeat",
          metadata: [
            { key: "serviceName", value: "gateway.worker" },
            { key: "status", value: "ok" },
          ],
        },
      ]);
      expect(result).toEqual({ delivered: true, via: "convex", accepted: 1 });
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture !== undefined) {
        expect(capture.url).toBe("https://backend.example/platform/telemetry/ingest");
        expect(capture.init?.headers).toMatchObject({
          authorization: "Bearer token-value",
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adversarial gateway events are sanitized before any delivery", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await emitGatewayEvents(baseEnv, [
        {
          kind: "ops.gateway.request",
          metadata: [
            { key: "route", value: "/platform/health" },
            { key: "httpStatus", value: "200" },
            { key: "message", value: "wycena dachu Baniewice" },
          ],
        },
      ]);
      expect(result).toEqual({ delivered: true, via: "convex", accepted: 1 });
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture === undefined) {
        return;
      }
      const body = JSON.parse(String(capture.init?.body)) as {
        events: { metadata: { key: string; value: string }[] }[];
      };
      expect(body.events[0]?.metadata).toEqual([
        { key: "route", value: "/platform/health" },
        { key: "httpStatus", value: "200" },
      ]);
      expect(JSON.stringify(body).includes("wycena")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops honestly when nothing is configured", async () => {
    const result = await emitGatewayEvents(
      { ENVIRONMENT: "dev" },
      [
        {
          kind: "ops.gateway.request",
          metadata: [
            { key: "route", value: "/x" },
            { key: "httpStatus", value: "404" },
            { key: "latencyMs", value: "1" },
            { key: "environment", value: "dev" },
          ],
        },
      ],
    );
    expect(result).toEqual({
      delivered: false,
      via: "dropped",
      reason: "convex_ingest_not_configured",
    });
  });
});

describe("request wrapper", () => {
  it("emits one redacted request event around the handler and returns its response", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const response = await withGatewayTelemetry(baseEnv, "/platform/health", async () => {
        return new Response("ok", { status: 200 });
      });
      expect(await response.text()).toBe("ok");
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture === undefined) {
        return;
      }
      const body = JSON.parse(String(capture.init?.body)) as {
        events: { kind: string; metadata: { key: string; value: string }[] }[];
      };
      const event = body.events[0];
      expect(event).toBeDefined();
      if (event !== undefined) {
        expect(event.kind).toBe("ops.gateway.request");
        expect(Object.fromEntries(event.metadata.map((m) => [m.key, m.value]))).toMatchObject({
          route: "/platform/health",
          httpStatus: "200",
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("gateway heartbeat", () => {
  it("records the Convex ledger row and emits the sink event", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await sendGatewayHeartbeat(baseEnv);
      expect(result).toEqual({ recorded: true, eventEmitted: true });
      const urls = captures.map((capture) => capture.url);
      expect(urls).toContain("https://backend.example/platform/telemetry/ingest");
      expect(urls).toContain("https://backend.example/platform/telemetry/heartbeat");
      const heartbeat = captures.find((c) => c.url.endsWith("/heartbeat"));
      expect(JSON.parse(String(heartbeat?.init?.body))).toEqual({
        serviceName: "gateway.worker",
        status: "ok",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
