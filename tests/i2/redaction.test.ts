/**
 * Adversarial redaction tests (I2): the sanitizer must structurally reject or
 * redact every sensitive payload class the issue names - raw source text,
 * audio bytes markers, prompt fragments, token-shaped strings, filenames,
 * auth headers, URLs and provider error strings - while honest events pass.
 */

import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_EVENT_KINDS,
  KIND_METADATA_ALLOWLIST,
  MAX_METADATA_ENTRIES,
  REDACTED,
  REDACTION_VERSION,
  sanitizeDiagnosticEvent,
  valuePasses,
} from "../../convex/operations/telemetry/redact";

const RAW_MESSAGE = "wycena dachu Baniewice za 45 tysięcy netto";
const AUDIO_MARKER = "UklGRh4AAAA3";
const PROMPT_FRAGMENT = "Jesteś agentem firmy budowlanej. Zawsze odpowiadaj po polsku";
const TOKEN_SHAPED = "sk-proj-4f8a9b2c1d6e7f80a9b2c1d6e7f80a9b2c1d6e7f80";
const JWT_SHAPED = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
const AUTH_HEADER = "Bearer eyJhbGciOiJIUzI1NiJ9.secret";
const FILENAME = "wycena_dachu_baniewice.jpg";
const URL = "https://api.openrouter.ai/v1/chat/completions?key=abc123";
const PROVIDER_ERROR = "429 Too Many Requests: rate limit exceeded for model";
const TRANSCRIPT = "no to zrobimy tak jak mowilem w zeszlym tygodniu";
const POLISH_TEXT = "Zapraszam na miejsce zlecenia jutro o 8:00";
const BLOB_64 = "a".repeat(80);

function run(kind: string, metadata: unknown, extra?: Record<string, unknown>) {
  return sanitizeDiagnosticEvent({ kind, metadata, ...(extra ?? {}) });
}

describe("structural rejection (malformed events never reach the sink)", () => {
  it("rejects non-object events", () => {
    expect(sanitizeDiagnosticEvent("nope").status).toBe("rejected");
    expect(sanitizeDiagnosticEvent(null).status).toBe("rejected");
    expect(sanitizeDiagnosticEvent([]).status).toBe("rejected");
  });

  it("rejects unknown kinds", () => {
    const result = run("ops.evil.kind", []);
    expect(result).toEqual({ status: "rejected", reason: "kind_unknown" });
  });

  it("rejects metadata that is not an array, is oversized, has malformed entries or duplicate keys", () => {
    expect(run("ops.processing.failed", "not-array")).toEqual({
      status: "rejected",
      reason: "metadata_not_array",
    });
    const tooMany = Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_, i) => ({
      key: "count",
      value: String(i),
    }));
    expect(run("ops.cost.entry", tooMany)).toEqual({
      status: "rejected",
      reason: "metadata_too_large",
    });
    expect(run("ops.processing.failed", [{ key: 5, value: "1" }])).toEqual({
      status: "rejected",
      reason: "metadata_entry_malformed",
    });
    expect(
      run("ops.processing.failed", [
        { key: "state", value: "running" },
        { key: "state", value: "failed" },
      ]),
    ).toEqual({ status: "rejected", reason: "metadata_duplicate_key" });
  });
});

describe("adversarial content redaction (signal survives, content cannot)", () => {
  const adversarialValues = [
    RAW_MESSAGE,
    AUDIO_MARKER,
    PROMPT_FRAGMENT,
    TOKEN_SHAPED,
    JWT_SHAPED,
    AUTH_HEADER,
    FILENAME,
    URL,
    PROVIDER_ERROR,
    TRANSCRIPT,
    POLISH_TEXT,
    BLOB_64,
  ];

  it("every adversarial value fails every metadata key's format", () => {
    const keys = ["runId", "errorKind", "state", "latencyMs", "providerRoute", "traceId"] as const;
    for (const value of adversarialValues) {
      for (const key of keys) {
        expect(valuePasses(key, value), `${key} <- ${value.slice(0, 24)}`).toBe(false);
      }
    }
    expect(KIND_METADATA_ALLOWLIST["ops.processing.failed"].length).toBeGreaterThan(0);
  });

  it("adversarial values in allowed keys are replaced with the placeholder and counted", () => {
    const result = run("ops.processing.failed", [
      { key: "errorKind", value: PROVIDER_ERROR },
      { key: "state", value: RAW_MESSAGE },
      { key: "runId", value: TOKEN_SHAPED },
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    const byKey = Object.fromEntries(result.event.metadata.map((e) => [e.key, e.value]));
    expect(byKey.errorKind).toBe(REDACTED);
    expect(byKey.state).toBe(REDACTED);
    expect(byKey.runId).toBe(REDACTED);
    expect(result.event.redactionsApplied).toBe(3);
    expect(result.event.redactionVersion).toBe(REDACTION_VERSION);
    // The raw content is nowhere in the sanitized event.
    const serialized = JSON.stringify(result.event);
    for (const value of [RAW_MESSAGE, TOKEN_SHAPED, PROVIDER_ERROR]) {
      expect(serialized.includes(value)).toBe(false);
    }
  });

  it("smuggling via unknown keys or wrong-kind keys drops the entry", () => {
    const result = run("ops.processing.failed", [
      { key: "message", value: RAW_MESSAGE },
      { key: "prompt", value: PROMPT_FRAGMENT },
      { key: "transcript", value: TRANSCRIPT },
      { key: "authorization", value: AUTH_HEADER },
      { key: "route", value: "/platform/bridge" }, // valid key, wrong kind
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.event.metadata).toEqual([]);
    expect(result.event.redactionsApplied).toBe(5);
  });

  it("adversarial serviceName and environment are dropped, honest ones pass", () => {
    const bad = run("ops.gateway.request", [], {
      serviceName: RAW_MESSAGE,
      environment: "prod?x",
    });
    expect(bad.status).toBe("ok");
    if (bad.status === "ok") {
      expect(bad.event.serviceName).toBeUndefined();
      expect(bad.event.environment).toBeUndefined();
      expect(bad.event.redactionsApplied).toBe(2);
    }
    const good = run("ops.gateway.request", [], {
      serviceName: "gateway.worker",
      environment: "dev",
    });
    expect(good.status).toBe("ok");
    if (good.status === "ok") {
      expect(good.event.serviceName).toBe("gateway.worker");
      expect(good.event.environment).toBe("dev");
    }
  });

  it("URL-shaped values are impossible: no format admits // and route forbids query strings", () => {
    expect(valuePasses("providerRoute", "openrouter/microsoft/mai-transcribe-2")).toBe(true);
    expect(valuePasses("providerRoute", "https://api.openrouter.ai/v1")).toBe(false);
    expect(valuePasses("route", "/platform/bridge")).toBe(true);
    expect(valuePasses("route", "/platform/bridge?token=x")).toBe(false);
    expect(valuePasses("route", "/platform/bridge#secret")).toBe(false);
  });
});

describe("honest events pass unchanged", () => {
  it("a well-formed provider call survives with zero redactions", () => {
    const result = run("ops.provider.call", [
      { key: "providerRoute", value: "openrouter/z-ai/glm-5.3-flash" },
      { key: "model", value: "z-ai/glm-5.3-flash" },
      { key: "latencyMs", value: "1840" },
      { key: "usageIn", value: "512" },
      { key: "usageOut", value: "1204" },
      { key: "usageTotal", value: "1716" },
      { key: "costMinor", value: "120" },
      { key: "outcome", value: "succeeded" },
    ]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.event.redactionsApplied).toBe(0);
      expect(result.event.metadata).toHaveLength(8);
    }
  });

  it("the closed kind vocabulary is exactly the fifteen monitor-grouped kinds", () => {
    // I5 append (issue #57, flagged shared-file change): ops.backup.stale
    // joined the recovery/health group (13 -> 14). I4 append (issue #56,
    // flagged shared-file change): ops.deletion.overdue joined it (14 -> 15).
    expect(DIAGNOSTIC_EVENT_KINDS).toHaveLength(15);
  });
});
