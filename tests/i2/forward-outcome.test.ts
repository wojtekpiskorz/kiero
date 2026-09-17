/**
 * Forward-outcome tests (R27, issue #235): the Convex->Axiom ingest leg's
 * closed status vocabulary, its DURABLE persistence (the status class on
 * the attempted event rows and on the `telemetry.sink` tick ledger row),
 * the health-surface exposure of a persistent failure, and the no-secret
 * guarantee - status class only, never response bodies or token material.
 *
 * Persistence and the health read run through the REAL transaction/read
 * functions over the in-memory db (tests/d2/harness.ts - the D5/F2
 * precedent); the cron wiring runs through the internalAction `_handler`
 * seam with a stub action context (the tests/g1/r13 pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  FORWARD_STATUSES,
  FORWARD_TICK_SERVICE,
  classifySinkResult,
  sinkForwardHealth,
  type ForwardStatus,
  type SinkForwardTickRow,
} from "../../convex/operations/telemetry/forward";
import {
  SINK_REASON_NOT_CONFIGURED,
  SINK_REASON_UNREACHABLE,
  SINK_STATUS_REASON_PREFIX,
  type SinkIngestResult,
} from "../../convex/operations/telemetry/sink";
import { valuePasses } from "../../convex/operations/telemetry/redact";
import {
  HEARTBEAT_CADENCE_MS,
  HEARTBEATS_KEPT_PER_SERVICE,
  HEARTBEAT_SERVICES,
} from "../../convex/operations/telemetry/heartbeat";
import { emitDiagnosticEvent } from "../../convex/operations/telemetry/emit";
import {
  performMarkForwarded,
  performRecordHeartbeat,
  readForwardingState,
} from "../../convex/operations/telemetry/functions";
import { cronTick, type CronTickSummary } from "../../convex/operations/telemetry/cron";
import { asReaderDb, asTx, fakeCtx, type FakeCtx } from "../d2/harness";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// The closed vocabulary and the classification
// ---------------------------------------------------------------------------

describe("the closed forward-status vocabulary", () => {
  it("is exactly the six accepted classes (no payloads, no status digits)", () => {
    expect([...FORWARD_STATUSES]).toEqual([
      "ok",
      "not_configured",
      "refused_credentials",
      "refused_target",
      "unreachable",
      "unknown",
    ]);
    // Classes carry no digits: the HTTP code itself must not be persisted.
    for (const status of FORWARD_STATUSES) {
      expect(status).toMatch(/^[a-z_]+$/);
    }
  });

  it("every member is sanitizer-safe (fits the closed status metadata format)", () => {
    for (const status of FORWARD_STATUSES) {
      expect(valuePasses("status", status)).toBe(true);
    }
  });

  it("the tick's service identity is in the closed heartbeat vocabulary at the cron cadence", () => {
    expect(HEARTBEAT_SERVICES).toContain(FORWARD_TICK_SERVICE);
    // HEARTBEAT_CADENCE_MS is the SINGLE cadence definition (convex/crons.ts
    // registers the tick every minute).
    expect(HEARTBEAT_CADENCE_MS[FORWARD_TICK_SERVICE]).toBe(60 * 1000);
  });
});

describe("classifySinkResult maps every sink result into a class", () => {
  const matrix: readonly { readonly result: SinkIngestResult; readonly expected: ForwardStatus }[] = [
    { result: { ok: true, ingested: 3 }, expected: "ok" },
    { result: { ok: true, ingested: 0 }, expected: "ok" },
    { result: { ok: false, ingested: 0, reason: `${SINK_STATUS_REASON_PREFIX}401` }, expected: "refused_credentials" },
    { result: { ok: false, ingested: 0, reason: `${SINK_STATUS_REASON_PREFIX}403` }, expected: "refused_credentials" },
    { result: { ok: false, ingested: 0, reason: `${SINK_STATUS_REASON_PREFIX}404` }, expected: "refused_target" },
    { result: { ok: false, ingested: 0, reason: `${SINK_STATUS_REASON_PREFIX}500` }, expected: "unknown" },
    { result: { ok: false, ingested: 0, reason: `${SINK_STATUS_REASON_PREFIX}429` }, expected: "unknown" },
    { result: { ok: false, ingested: 0, reason: SINK_REASON_UNREACHABLE }, expected: "unreachable" },
    { result: { ok: false, ingested: 0, reason: SINK_REASON_NOT_CONFIGURED }, expected: "not_configured" },
    { result: { ok: false, ingested: 0 }, expected: "unknown" },
  ];

  for (const { result, expected } of matrix) {
    it(`${JSON.stringify(result)} -> ${expected}`, () => {
      expect(classifySinkResult(result)).toBe(expected);
    });
  }

  it("collapses adversarial credential-shaped junk into the closed set, leaking nothing", () => {
    const adversarial = [
      "Bearer sk-live-abcdef1234567890abcdef",
      `${SINK_STATUS_REASON_PREFIX}401; drop table diagnosticEvents`,
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      "https://evil.test//exfil?token=secret-value",
      `${SINK_STATUS_REASON_PREFIX}9999`,
      "",
    ];
    for (const reason of adversarial) {
      const status = classifySinkResult({ ok: false, ingested: 0, reason });
      expect(FORWARD_STATUSES).toContain(status);
      expect(status).toMatch(/^[a-z_]+$/);
    }
    // The juicy cases are explicitly "unknown", never echoed material.
    expect(classifySinkResult({ ok: false, ingested: 0, reason: "Bearer sk-live-abcdef1234567890abcdef" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The pure health derivation (what the composed state exposes)
// ---------------------------------------------------------------------------

describe("sinkForwardHealth derives the leg's state from the tick ledger", () => {
  const tick = (atMs: number, forwardStatus?: ForwardStatus): SinkForwardTickRow => ({
    atMs,
    ...(forwardStatus === undefined ? {} : { forwardStatus }),
  });

  it("no rows at all is never_recorded", () => {
    expect(sinkForwardHealth([])).toEqual({
      state: "never_recorded",
      status: null,
      lastTickAtMs: null,
      lastOkAtMs: null,
      consecutiveFailures: 0,
    });
  });

  it("a tick with an empty window is idle: alive, nothing attempted, no class claimed", () => {
    expect(sinkForwardHealth([tick(1_000)])).toEqual({
      state: "idle",
      status: null,
      lastTickAtMs: 1_000,
      lastOkAtMs: null,
      consecutiveFailures: 0,
    });
  });

  it("a healthy leg is ok with the last success time", () => {
    expect(sinkForwardHealth([tick(3_000, "ok"), tick(2_000, "ok")])).toEqual({
      state: "ok",
      status: "ok",
      lastTickAtMs: 3_000,
      lastOkAtMs: 3_000,
      consecutiveFailures: 0,
    });
  });

  it("a persistent failure carries its class, the streak and the last success", () => {
    const ticks = [
      tick(5_000, "refused_credentials"),
      tick(4_000, "refused_credentials"),
      tick(3_000, "ok"),
      tick(2_000),
    ];
    expect(sinkForwardHealth(ticks)).toEqual({
      state: "failing",
      status: "refused_credentials",
      lastTickAtMs: 5_000,
      lastOkAtMs: 3_000,
      consecutiveFailures: 2,
    });
  });

  it("a failure streak older than the tail has no remembered success (bounded honesty)", () => {
    const ticks = [tick(3_000, "unreachable"), tick(2_000, "unreachable")];
    expect(sinkForwardHealth(ticks)).toEqual({
      state: "failing",
      status: "unreachable",
      lastTickAtMs: 3_000,
      lastOkAtMs: null,
      consecutiveFailures: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Durable persistence through the REAL transaction function
// ---------------------------------------------------------------------------

const PERSIST_TABLES = ["diagnosticEvents", "healthHeartbeats"] as const;

function seedDiagnosticEvent(ctx: FakeCtx): Promise<Id<"diagnosticEvents">> {
  const result = emitDiagnosticEvent(asTx(ctx), {
    kind: "ops.health.heartbeat",
    metadata: [
      { key: "serviceName", value: "gateway.worker" },
      { key: "status", value: "ok" },
    ],
  });
  return result.then((r) => {
    if (r.diagnosticEventId === undefined) {
      throw new Error("fixture event must emit");
    }
    return r.diagnosticEventId;
  });
}

function tickRows(ctx: FakeCtx) {
  return ctx.db
    .rows("healthHeartbeats")
    .filter((row) => row.serviceName === FORWARD_TICK_SERVICE)
    .sort((a, b) => Number(b.atMs) - Number(a.atMs));
}

describe("the tick ledger's writer gate (the external heartbeat surface cannot flip the forward leg)", () => {
  it("recordHeartbeat refuses the tick's own service: only the cron's markForwarded writes it", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const refused = await performRecordHeartbeat(asTx(ctx), {
      serviceName: FORWARD_TICK_SERVICE,
      status: "ok",
    });
    expect(refused).toEqual({ recorded: false, reason: "service_tick_internal" });
    expect(tickRows(ctx)).toEqual([]);
  });

  it("a normal external service still records through the shared tail helper", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const recorded = await performRecordHeartbeat(asTx(ctx), {
      serviceName: "media.worker",
      status: "ok",
    });
    expect(recorded.recorded).toBe(true);
  });
});

describe("performMarkForwarded persists the outcome on rows and the tick ledger", () => {
  it("a refusal class lands on the rows with forwardedAtMs still 0, plus a degraded tick row", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const idA = await seedDiagnosticEvent(ctx);
    const idB = await seedDiagnosticEvent(ctx);
    const atMs = Date.parse("2026-09-17T12:00:00Z");

    const outcome = await performMarkForwarded(asTx(ctx), {
      ids: [idA, idB],
      atMs,
      status: "refused_credentials",
    });
    expect(outcome).toEqual({ marked: 2, tickRecorded: true });

    for (const id of [idA, idB]) {
      const row = await ctx.db.get(id);
      expect(row).toMatchObject({ forwardedAtMs: 0, forwardStatus: "refused_credentials" });
    }
    // The tick row is exactly the closed shape: service, coarse state,
    // class, time - nothing else (no reason strings, no payload).
    expect(tickRows(ctx)).toEqual([
      { _id: expect.any(String), serviceName: "telemetry.sink", status: "degraded", forwardStatus: "refused_credentials", atMs },
    ]);
  });

  it("an ok class marks delivery exactly like the I2 behavior, plus the class", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const id = await seedDiagnosticEvent(ctx);
    const atMs = Date.parse("2026-09-17T12:01:00Z");

    await performMarkForwarded(asTx(ctx), { ids: [id], atMs, status: "ok" });
    expect(await ctx.db.get(id)).toMatchObject({
      forwardedAtMs: atMs,
      forwardStatus: "ok",
    });
    expect(tickRows(ctx)[0]).toMatchObject({
      serviceName: "telemetry.sink",
      status: "ok",
      forwardStatus: "ok",
      atMs,
    });
  });

  it("the empty-window tick records liveness only: no class is claimed", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const atMs = Date.parse("2026-09-17T12:02:00Z");

    await performMarkForwarded(asTx(ctx), { ids: [], atMs });
    const rows = tickRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serviceName: "telemetry.sink", status: "ok", atMs });
    expect("forwardStatus" in (rows[0] ?? {})).toBe(false);
  });

  it("the tick ledger keeps only the bounded per-service tail", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    for (let i = 0; i < HEARTBEATS_KEPT_PER_SERVICE + 5; i += 1) {
      await performMarkForwarded(asTx(ctx), { ids: [], atMs: 1_000 + i });
    }
    expect(tickRows(ctx)).toHaveLength(HEARTBEATS_KEPT_PER_SERVICE);
    // The NEWEST rows survive (the loop's highest atMs).
    expect(tickRows(ctx)[0]).toMatchObject({ atMs: 1_000 + HEARTBEATS_KEPT_PER_SERVICE + 4 });
  });

  it("a legacy status-less call over ids still marks delivery (I2 compatibility)", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    const id = await seedDiagnosticEvent(ctx);
    const atMs = Date.parse("2026-09-17T12:03:00Z");

    await performMarkForwarded(asTx(ctx), { ids: [id], atMs });
    expect(await ctx.db.get(id)).toMatchObject({ forwardedAtMs: atMs });
  });
});

// ---------------------------------------------------------------------------
// The health-surface exposure through the REAL read
// ---------------------------------------------------------------------------

describe("readForwardingState exposes the persistent failure the composed state shows", () => {
  it("an empty ledger reads as never_recorded", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    expect(await readForwardingState(asReaderDb(ctx))).toEqual({
      state: "never_recorded",
      status: null,
      lastTickAtMs: null,
      lastOkAtMs: null,
      consecutiveFailures: 0,
    });
  });

  it("a persisted refusal streak reads as failing with its class - the WHY the owner lacked", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 1_000, status: "ok" });
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 2_000, status: "refused_target" });
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 3_000, status: "refused_target" });

    expect(await readForwardingState(asReaderDb(ctx))).toEqual({
      state: "failing",
      status: "refused_target",
      lastTickAtMs: 3_000,
      lastOkAtMs: 1_000,
      consecutiveFailures: 2,
    });
  });

  it("an idle leg (alive, nothing to forward) reads as idle, not as failure", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 1_000 });
    expect(await readForwardingState(asReaderDb(ctx))).toMatchObject({
      state: "idle",
      status: null,
    });
  });

  it("a recovered leg reads as ok", async () => {
    const ctx = fakeCtx([...PERSIST_TABLES]);
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 1_000, status: "unreachable" });
    await performMarkForwarded(asTx(ctx), { ids: [], atMs: 2_000, status: "ok" });
    expect(await readForwardingState(asReaderDb(ctx))).toEqual({
      state: "ok",
      status: "ok",
      lastTickAtMs: 2_000,
      lastOkAtMs: 2_000,
      consecutiveFailures: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// The cron wiring: the outcome reaches the mutation and the summary
// ---------------------------------------------------------------------------

type CronHandlerFn = (ctx: ActionCtx, args: Record<string, never>) => Promise<CronTickSummary>;

interface RecordedForwardCall {
  readonly ids: readonly string[];
  readonly atMs: number;
  readonly status: ForwardStatus | undefined;
}

const ENV_NAMES = ["KIERO_ENVIRONMENT", "AXIOM_API_TOKEN", "AXIOM_DATASET"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

/**
 * Drives the REAL cronTick handler with canned monitor answers and one
 * unforwarded row; the sink leg hits the stubbed global fetch.
 */
async function runTick(options: {
  readonly httpStatus: number;
  readonly configured: boolean;
  readonly windowEmpty?: boolean;
}): Promise<{
  summary: CronTickSummary;
  forwardCall: RecordedForwardCall;
  fetchCalls: number;
}> {
  const forwardCalls: RecordedForwardCall[] = [];
  let fetchCalls = 0;
  if (options.configured) {
    process.env.AXIOM_API_TOKEN = `test-token-${crypto.randomUUID()}`;
    process.env.AXIOM_DATASET = `test-dataset-${crypto.randomUUID().slice(0, 8)}`;
  }
  vi.stubGlobal(
    "fetch",
    (async () => {
      fetchCalls += 1;
      return new Response("nope", { status: options.httpStatus });
    }) as typeof fetch,
  );

  const ctx = {
    runMutation: async (reference: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
      if (name.endsWith("markForwarded")) {
        forwardCalls.push({
          ids: (args.ids ?? []) as string[],
          atMs: args.atMs as number,
          status: args.status as ForwardStatus | undefined,
        });
        return { marked: (args.ids as string[]).length, tickRecorded: true };
      }
      if (name.endsWith("scanIncidents")) {
        return { scannedAtMs: 0, incidents: 0, emitted: [] };
      }
      if (name.endsWith("detectSilence")) {
        return { silent: 0, emitted: [] };
      }
      if (name.endsWith("evaluateCostAlerts")) {
        return { period: "2026-09", totalMinor: 0, perProvider: {}, thresholds: { warning: false, alert: false }, results: [] };
      }
      if (name.endsWith("pruneExpired")) {
        return { prunedDiagnostics: 0, prunedCostEntries: 0, prunedAlertStates: 0 };
      }
      throw new Error(`unexpected mutation in test: ${name}`);
    },
    runQuery: async (reference: unknown, _args: Record<string, unknown>) => {
      const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
      if (name.endsWith("unforwardedRecent")) {
        return options.windowEmpty === true
          ? []
          : [
              {
                _id: "k57fixture",
                kind: "ops.health.heartbeat",
                technicalMetadata: [],
                redactionsApplied: 0,
                redactionVersion: "i2.redact.1",
                atMs: Date.now() - 1_000,
              },
            ];
      }
      throw new Error(`unexpected query in test: ${name}`);
    },
  } as unknown as ActionCtx;

  const handler = (cronTick as unknown as { _handler: CronHandlerFn })._handler;
  const summary = await handler(ctx, {});
  const forwardCall = forwardCalls[0];
  if (forwardCall === undefined) {
    throw new Error("the tick never recorded a forward outcome");
  }
  return { summary, forwardCall, fetchCalls };
}

describe("the cron tick records the outcome it used to drop", () => {
  it("a 401 refusal persists refused_credentials on the attempted rows and the summary", async () => {
    const { summary, forwardCall } = await runTick({ httpStatus: 401, configured: true });
    expect(forwardCall).toMatchObject({ ids: ["k57fixture"], status: "refused_credentials" });
    expect(summary.forwarded).toMatchObject({
      ok: false,
      attempted: 1,
      status: "refused_credentials",
    });
  });

  it("a missing dataset target (404) persists refused_target", async () => {
    const { summary, forwardCall } = await runTick({ httpStatus: 404, configured: true });
    expect(forwardCall.status).toBe("refused_target");
    expect(summary.forwarded.status).toBe("refused_target");
  });

  it("an unconfigured deployment persists not_configured (the null sink is honest)", async () => {
    const { summary, forwardCall } = await runTick({ httpStatus: 200, configured: false });
    expect(forwardCall).toMatchObject({ ids: ["k57fixture"], status: "not_configured" });
    expect(summary.forwarded.status).toBe("not_configured");
  });

  it("a success persists ok and still carries the ids (the I2 marking path)", async () => {
    const { summary, forwardCall } = await runTick({ httpStatus: 200, configured: true });
    expect(forwardCall).toMatchObject({ ids: ["k57fixture"], status: "ok" });
    expect(summary.forwarded).toMatchObject({ ok: true, ingested: 1, attempted: 1, status: "ok" });
  });

  it("an empty window records the liveness tick with NO class claimed", async () => {
    const { summary, forwardCall, fetchCalls } = await runTick({
      httpStatus: 500,
      configured: true,
      windowEmpty: true,
    });
    expect(forwardCall).toEqual({ ids: [], atMs: forwardCall.atMs, status: undefined });
    expect(summary.forwarded).toEqual({ ok: true, ingested: 0, attempted: 0, status: "ok" });
    // The sink is never asked: no attempt happened, so no class is claimed.
    expect(fetchCalls).toBe(0);
  });
});
