/**
 * Backend-silence detection tests (I2): per-service staleness from heartbeats
 * and the external/independent second layer's vocabulary.
 */

import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_CADENCE_MS,
  HEARTBEAT_SERVICES,
  SILENCE_TOLERANCE,
  backendSilenceState,
  serviceSilence,
} from "../../convex/operations/telemetry/heartbeat";
import monitors from "../../infra/observability/monitors.json";

const NOW = Date.parse("2026-09-09T12:00:00Z");

describe("per-service silence states", () => {
  it("fresh heartbeat is ok; up to 3 missed cadences is late; beyond is silent", () => {
    const cadence = HEARTBEAT_CADENCE_MS["gateway.worker"]; // 5 min
    const fresh = serviceSilence("gateway.worker", { atMs: NOW - cadence, status: "ok" }, NOW);
    expect(fresh.state).toBe("ok");
    const late = serviceSilence("gateway.worker", { atMs: NOW - cadence * 2.5, status: "ok" }, NOW);
    expect(late.state).toBe("late");
    const silent = serviceSilence("gateway.worker", { atMs: NOW - cadence * (SILENCE_TOLERANCE + 1), status: "ok" }, NOW);
    expect(silent.state).toBe("silent");
    expect(silent.thresholdMs).toBe(cadence * SILENCE_TOLERANCE);
  });

  it("a missing service is never_seen and counts as silent overall", () => {
    const state = backendSilenceState({}, NOW);
    expect(state.services.map((s) => s.state)).toEqual(
      HEARTBEAT_SERVICES.map(() => "never_seen"),
    );
    expect(state.anySilent).toBe(true);
  });

  it("all services fresh means no silence", () => {
    const latest = Object.fromEntries(
      HEARTBEAT_SERVICES.map((service) => [service, { atMs: NOW - 60_000, status: "ok" as const }]),
    );
    expect(backendSilenceState(latest, NOW).anySilent).toBe(false);
  });

  it("a degraded-but-fresh service is not silence (it is an incident, not silence)", () => {
    const latest = Object.fromEntries(
      HEARTBEAT_SERVICES.map((service) => [
        service,
        {
          atMs: NOW - 60_000,
          status: service === "gateway.worker" ? ("degraded" as const) : ("ok" as const),
        },
      ]),
    );
    const state = backendSilenceState(latest, NOW);
    expect(state.anySilent).toBe(false);
    expect(state.services.find((s) => s.serviceName === "gateway.worker")?.lastStatus).toBe(
      "degraded",
    );
  });
});

describe("the external monitor layer", () => {
  it("defines exactly the three accepted monitor groups", () => {
    const groups = monitors.monitors.map((monitor) => monitor.group).sort();
    expect(groups).toEqual([
      "costs/limits",
      "processing/save incidents",
      "recovery/health",
    ].sort());
    expect(monitors.monitors).toHaveLength(3); // Axiom Personal permits exactly three
  });

  it("the silence monitor watches heartbeat events, not Convex liveness", () => {
    const silence = monitors.monitors.find((m) => m.id === "kiero-backend-silence");
    expect(silence).toBeDefined();
    expect(silence?.apl.includes("ops.health.heartbeat")).toBe(true);
    expect(silence?.trigger.threshold).toBe("15m");
  });

  it("every notification destination is explicitly PENDING (no live alerting yet)", () => {
    for (const monitor of monitors.monitors) {
      for (const notification of monitor.notifications) {
        expect(notification.status.startsWith("PENDING")).toBe(true);
      }
    }
  });
});
