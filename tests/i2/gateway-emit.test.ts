/**
 * Gateway telemetry tests (I2, round-1 repairs): request-scoped redacted
 * events scheduled OFF the critical path (waitUntil seam), the ONE Axiom
 * client, single-emission heartbeat, all against local fake fetch.
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

/** A collect-only scheduler: lets tests await what waitUntil would run. */
function collector(): {
  scheduler: { waitUntil(promise: Promise<unknown>): void };
  pending: Promise<unknown>[];
} {
  const pending: Promise<unknown>[] = [];
  return { scheduler: { waitUntil: (promise) => pending.push(promise) }, pending };
}

const baseEnv = {
  CONVEX_SITE_URL: "https://backend.example",
  KIERO_SERVICE_TOKEN: "token-value",
  ENVIRONMENT: "dev",
};

describe("delivery paths", () => {
  it("prefers Axiom direct when the token binding exists (one sink client)", async () => {
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
      expect(capture.init?.headers).toMatchObject({
        authorization: "Bearer axiom-token",
        "content-type": "application/json",
      });
      // The sink mapping (toSinkEvent) produced the exact event shape.
      const body = JSON.parse(String(capture.init?.body)) as {
        _time: string;
        service: string;
        environment: string;
        kind: string;
        metadata: Record<string, string>;
      }[];
      expect(body[0]).toMatchObject({
        service: "gateway.worker",
        environment: "dev",
        kind: "ops.gateway.request",
      });
      expect(body[0]?.metadata.route).toBe("/platform/health");
      expect(Object.keys(body[0] ?? {})).toEqual([
        "_time",
        "service",
        "environment",
        "kind",
        "metadata",
      ]);
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
          kind: "ops.gateway.request",
          metadata: [
            { key: "route", value: "/platform/health" },
            { key: "httpStatus", value: "200" },
            { key: "latencyMs", value: "5" },
            { key: "environment", value: "dev" },
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

describe("request wrapper (off the critical path)", () => {
  it("resolves the response while the telemetry POST is still pending (never blocks)", async () => {
    const captures: Capture[] = [];
    let releaseTelemetry: (() => void) | undefined;
    const telemetryGate = new Promise<void>((resolve) => {
      releaseTelemetry = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captures.push({ url: String(url), init });
      await telemetryGate; // the telemetry POST hangs until released
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const { scheduler, pending } = collector();
    try {
      const response = await withGatewayTelemetry(
        baseEnv,
        scheduler,
        "/platform/health",
        async () => new Response("ok", { status: 200 }),
      );
      // The response is fully usable although the telemetry POST has NOT
      // answered (and never will until released): telemetry is off the
      // critical path.
      expect(await response.text()).toBe("ok");
      expect(captures).toHaveLength(1);
      releaseTelemetry?.();
      await Promise.all(pending);
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture !== undefined) {
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
      }
    } finally {
      releaseTelemetry?.();
      globalThis.fetch = originalFetch;
    }
  });

  it("still emits (500) when the handler throws, and rethrows the original error", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const { scheduler, pending } = collector();
    try {
      await expect(
        withGatewayTelemetry(baseEnv, scheduler, "/platform/bridge", async () => {
          throw new Error("handler exploded");
        }),
      ).rejects.toThrow("handler exploded");
      await Promise.all(pending);
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      if (capture !== undefined) {
        const body = JSON.parse(String(capture.init?.body)) as {
          events: { metadata: { key: string; value: string }[] }[];
        };
        expect(
          Object.fromEntries(body.events[0]?.metadata.map((m) => [m.key, m.value]) ?? []),
        ).toMatchObject({ httpStatus: "500", route: "/platform/bridge" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("gateway heartbeat (one emission point)", () => {
  it("records ONLY the Convex ledger row: exactly one POST, no ingest duplication", async () => {
    const { captures, fetchImpl } = withCapturingFetch(200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await sendGatewayHeartbeat(baseEnv);
      expect(result).toEqual({ recorded: true });
      // ONE request total: the heartbeat endpoint. The ops.health.heartbeat
      // event is emitted server-side by recordHeartbeat (the single sink
      // path for every prober, gateway included).
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (capture !== undefined) {
        expect(capture.url).toBe("https://backend.example/platform/telemetry/heartbeat");
        expect(JSON.parse(String(capture.init?.body))).toEqual({
          serviceName: "gateway.worker",
          status: "ok",
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unreachable backends without throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    try {
      const result = await sendGatewayHeartbeat(baseEnv);
      expect(result).toEqual({ recorded: false, reason: "convex_unreachable" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
