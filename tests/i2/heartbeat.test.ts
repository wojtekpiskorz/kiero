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
  silenceIncidents,
} from "../../convex/operations/telemetry/heartbeat";
import { sanitizeDiagnosticEvent } from "../../convex/operations/telemetry/redact";
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

describe("silence incidents (the tick's emission decisions)", () => {
  const cadence = HEARTBEAT_CADENCE_MS["gateway.worker"];
  const staleAtMs = NOW - cadence * (SILENCE_TOLERANCE + 2);

  it("emits once per silence episode, anchored to the newest heartbeat", () => {
    const incidents = silenceIncidents(
      { "gateway.worker": { atMs: staleAtMs, status: "ok" } },
      NOW,
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ops.health.silence_detected",
      dedupKey: `silence:gateway.worker:${staleAtMs}`,
    });
    // A continuing silence has the same anchor -> same dedup key -> deduped.
    expect(silenceIncidents({ "gateway.worker": { atMs: staleAtMs, status: "ok" } }, NOW + 60_000)).toHaveLength(1);
  });

  it("a recovery followed by a new silence is a NEW episode (new anchor)", () => {
    const first = silenceIncidents({ "gateway.worker": { atMs: staleAtMs, status: "ok" } }, NOW);
    const recovered = { "gateway.worker": { atMs: NOW - 60_000, status: "ok" as const } };
    expect(silenceIncidents(recovered, NOW)).toHaveLength(0);
    const nextSilenceAt = NOW + cadence * (SILENCE_TOLERANCE + 2);
    const second = silenceIncidents(recovered, nextSilenceAt);
    expect(second).toHaveLength(1);
    expect(second[0]?.dedupKey).not.toBe(first[0]?.dedupKey);
  });

  it("never_seen and fresh/late services produce no in-app incident", () => {
    expect(silenceIncidents({}, NOW)).toEqual([]);
    const fresh = silenceIncidents({ "gateway.worker": { atMs: NOW - cadence, status: "ok" } }, NOW);
    expect(fresh).toEqual([]);
    const lateAt = NOW - cadence * 2.5;
    const late = silenceIncidents({ "gateway.worker": { atMs: lateAt, status: "ok" } }, NOW);
    expect(late).toEqual([]);
  });

  it("the metadata survives the sanitizer unchanged", () => {
    const incidents = silenceIncidents({ "gateway.worker": { atMs: staleAtMs, status: "ok" } }, NOW);
    const incident = incidents[0];
    expect(incident).toBeDefined();
    if (incident === undefined) {
      return;
    }
    const sanitized = sanitizeDiagnosticEvent({
      kind: incident.kind,
      metadata: incident.metadata,
    });
    expect(sanitized.status).toBe("ok");
    if (sanitized.status === "ok") {
      expect(sanitized.event.redactionsApplied).toBe(0);
    }
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
    // Round-1 repair: the loop is closed - the emitted silence events are
    // part of this monitor's query.
    expect(silence?.apl.includes("ops.health.silence_detected")).toBe(true);
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
