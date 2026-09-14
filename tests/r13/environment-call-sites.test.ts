/**
 * R13 focused verification, part 2: every migrated call site routes through
 * the ONE shared deployment environment rule
 * (`packages/runtime/src/deployment.ts`).
 *
 * Five runtime readers existed before R13; each is driven here through its
 * REAL seam with a matrix of environment values, asserting the module's
 * observable classification EQUALS the shared helper's answer for every
 * input (one shared failure the moment any copy drifts):
 *
 * - `convex/operations/telemetry/cron.ts`: the every-minute tick, invoked
 *   through the internalAction `_handler` seam with a stub action context
 *   (dispatched by function name, the tests/g1 pattern) and the REAL axiom
 *   sink pointed at a stubbed global fetch; the label is observed in the
 *   ingest payload the sink forwards.
 * - `convex/operations/backups/http.ts`: the complete handler through the
 *   httpAction `_handler` seam with a generated service credential; the
 *   label is observed in the recorded cost entries.
 * - `convex/operations/telemetry/redact.ts`: the sanitizer keeps an
 *   environment value exactly when the shared rule admits it, and the
 *   metadata format IS the shared pattern object (identity, not a twin).
 * - `convex/calendar/connection/return.ts`: a plain-http return origin
 *   survives exactly when the helper classifies the environment as dev
 *   (the security property that motivated the consolidation).
 * - `apps/gateway/src/telemetry/emit.ts` (the review's fifth copy): the
 *   Worker's `ENVIRONMENT` binding, observed both in the sanitized event
 *   and in the emitted telemetry payload the wrapped request handler
 *   delivers through the REAL axiom sink.
 *
 * The @kiero/runtime barrel is wrapped with a pass-through spy, so each
 * test ALSO asserts the call site invoked the shared helper with the exact
 * server-side input: routing is proven, not just today's equivalence.
 *
 * Every credential-shaped fixture (the Axiom token/dataset names and the
 * service token) is generated at run time; no real credential value
 * appears anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  DEPLOYMENT_ENVIRONMENT_PATTERN,
  deploymentEnvironment,
} from "@kiero/runtime";
import { cronTick } from "../../convex/operations/telemetry/cron";
import { backupsCompleteHandler } from "../../convex/operations/backups/http";
import {
  METADATA_KEY_FORMATS,
  REDACTED,
  sanitizeDiagnosticEvent,
} from "../../convex/operations/telemetry/redact";
import {
  CALENDAR_APP_BASE_URL_ENV,
  calendarAppReturnHref,
} from "../../convex/calendar/connection/return";
import {
  sanitizeGatewayEvents,
  withGatewayTelemetry,
  type TelemetryEnv,
} from "../../apps/gateway/src/telemetry/emit";

// Pass-through spy over the shared helper: behavior is unchanged, but the
// tests can assert the call sites really route through it.
vi.mock("@kiero/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kiero/runtime")>();
  return { ...actual, deploymentEnvironment: vi.fn(actual.deploymentEnvironment) };
});

const helperSpy = vi.mocked(deploymentEnvironment);

/** The matrix each call site must answer identically to the helper. */
interface MatrixRow {
  readonly value: string | undefined;
  readonly expected: "dev" | "staging" | "alpha-production";
}

const CALL_SITE_MATRIX: readonly MatrixRow[] = [
  { value: "dev", expected: "dev" },
  { value: "staging", expected: "staging" },
  { value: "alpha-production", expected: "alpha-production" },
  { value: undefined, expected: "dev" },
  { value: "", expected: "dev" },
  { value: "production", expected: "dev" },
  { value: "prod", expected: "dev" },
  { value: "Dev", expected: "dev" },
];

const show = (value: string | undefined): string =>
  value === undefined ? "absent" : JSON.stringify(value);

// Every deployment variable the touched paths read; saved and restored
// around each test so no test leaks configuration into another.
const ENV_NAMES = [
  "KIERO_ENVIRONMENT",
  "AXIOM_API_TOKEN",
  "AXIOM_DATASET",
  "KIERO_SERVICE_TOKEN",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  helperSpy.mockClear();
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

function setEnvironment(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.KIERO_ENVIRONMENT;
  } else {
    process.env.KIERO_ENVIRONMENT = value;
  }
}

const nameOf = (reference: unknown): string =>
  getFunctionName(reference as Parameters<typeof getFunctionName>[0]);

// ---------------------------------------------------------------------------
// The telemetry cron: the label reaches the sink payload.
// ---------------------------------------------------------------------------

type CronHandlerFn = (ctx: ActionCtx, args: Record<string, never>) => Promise<unknown>;

interface CapturedIngest {
  readonly url: string;
  readonly events: readonly { readonly environment: string }[];
}

async function runCronTick(): Promise<CapturedIngest> {
  const captured: CapturedIngest[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        events: JSON.parse(String(init?.body)) as { environment: string }[],
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  );
  // Generated fixtures (never real credentials) so the cron builds the REAL
  // axiom sink instead of the not-configured null sink.
  process.env.AXIOM_API_TOKEN = `test-token-${crypto.randomUUID()}`;
  process.env.AXIOM_DATASET = `test-dataset-${crypto.randomUUID().slice(0, 8)}`;

  // One canned answer per mutation the tick drives before forwarding; the
  // summary fields are not under test here.
  const ctx = {
    runMutation: async (reference: unknown, _args: Record<string, unknown>) => {
      const name = nameOf(reference);
      if (name.endsWith("markForwarded")) {
        return {};
      }
      if (name.endsWith("scanIncidents")) {
        return { incidents: 0 };
      }
      if (name.endsWith("detectSilence")) {
        return { silent: 0 };
      }
      if (name.endsWith("evaluateCostAlerts")) {
        return { period: "2026-09", totalMinor: 0 };
      }
      if (name.endsWith("pruneExpired")) {
        return { prunedDiagnostics: 0, prunedCostEntries: 0, prunedAlertStates: 0 };
      }
      throw new Error(`unexpected mutation in test: ${name}`);
    },
    // One unforwarded row WITHOUT its own environment, so the payload's
    // environment is exactly the cron's classification of the deployment.
    runQuery: async (reference: unknown, _args: Record<string, unknown>) => {
      const name = nameOf(reference);
      if (name.endsWith("unforwardedRecent")) {
        return [
          {
            _id: "k57fixture",
            kind: "ops.health.heartbeat",
            technicalMetadata: [],
            redactionsApplied: 0,
            redactionVersion: "i2.redact.1",
            atMs: 1_750_000_000_000,
          },
        ];
      }
      throw new Error(`unexpected query in test: ${name}`);
    },
  } as unknown as ActionCtx;

  const handler = (cronTick as unknown as { _handler: CronHandlerFn })._handler;
  await handler(ctx, {});

  const [ingest] = captured;
  if (ingest === undefined) {
    throw new Error("the sink fetch was not intercepted");
  }
  // The REAL sink was chosen (dataset in the URL), proving the label path
  // under test is the forwarding path, not the not-configured shortcut.
  expect(ingest.url).toContain(`https://api.axiom.co/v1/datasets/${process.env.AXIOM_DATASET}`);
  return ingest;
}

describe("cron.ts routes its environment read through the shared helper", () => {
  for (const row of CALL_SITE_MATRIX) {
    it(`labels the forwarded sink payload ${show(row.value)} as ${row.expected}`, async () => {
      setEnvironment(row.value);
      const ingest = await runCronTick();
      const [event] = ingest.events;
      if (event === undefined) {
        throw new Error("no event in the captured ingest payload");
      }
      expect(event.environment).toBe(row.expected);
      expect(helperSpy).toHaveBeenCalledWith(row.value);
    });
  }
});

// ---------------------------------------------------------------------------
// The backups HTTP boundary: the label reaches the cost entries.
// ---------------------------------------------------------------------------

type HttpHandlerFn = (ctx: ActionCtx, request: Request) => Promise<Response>;

interface RecordedCost {
  readonly category: string;
  readonly label: string;
}

async function runBackupsComplete(): Promise<{
  readonly costs: readonly RecordedCost[];
  readonly heartbeats: readonly string[];
}> {
  const token = `svc-${crypto.randomUUID()}`;
  process.env.KIERO_SERVICE_TOKEN = token;
  const costs: RecordedCost[] = [];
  const heartbeats: string[] = [];
  const ctx = {
    runMutation: async (reference: unknown, args: Record<string, unknown>) => {
      const name = nameOf(reference);
      if (name.endsWith("completeRun")) {
        return { ok: true, manifestId: "kman-fixture" };
      }
      if (name.endsWith("recordCostEntry")) {
        costs.push({ category: String(args.category), label: String(args.label) });
        return {};
      }
      if (name.endsWith("recordHeartbeat")) {
        heartbeats.push(String(args.status));
        return {};
      }
      throw new Error(`unexpected mutation in test: ${name}`);
    },
  } as unknown as ActionCtx;

  const handler = (backupsCompleteHandler as unknown as { _handler: HttpHandlerFn })._handler;
  const response = await handler(
    ctx,
    new Request("https://convex-host.example/operations/backups/complete", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ manifestId: "kman-fixture" }),
    }),
  );
  expect(response.status).toBe(200);
  return { costs, heartbeats };
}

describe("backups/http.ts routes its environment read through the shared helper", () => {
  for (const row of CALL_SITE_MATRIX) {
    it(`labels the run's cost entries ${show(row.value)} as ${row.expected}`, async () => {
      setEnvironment(row.value);
      const { costs, heartbeats } = await runBackupsComplete();
      expect(costs.map((cost) => cost.category).sort()).toEqual(["egress", "export", "storage"]);
      for (const cost of costs) {
        expect(cost.label).toBe(row.expected);
      }
      expect(heartbeats).toEqual(["ok"]);
      expect(helperSpy).toHaveBeenCalledWith(row.value);
    });
  }
});

// ---------------------------------------------------------------------------
// The redaction format set: the label set IS the shared one.
// ---------------------------------------------------------------------------

const STRING_MATRIX = CALL_SITE_MATRIX.filter(
  (row): row is MatrixRow & { readonly value: string } => typeof row.value === "string",
);

describe("redact.ts routes its environment label set through the shared helper", () => {
  it("the environment metadata format IS the shared pattern object (no twin regex)", () => {
    expect(METADATA_KEY_FORMATS.environment).toBe(DEPLOYMENT_ENVIRONMENT_PATTERN);
  });

  for (const row of STRING_MATRIX) {
    it(`keeps a metadata environment ${show(row.value)} exactly when the shared rule admits it`, () => {
      const result = sanitizeDiagnosticEvent({
        kind: "ops.gateway.request",
        metadata: [
          { key: "route", value: "/platform/calendar/oauth/callback" },
          { key: "httpStatus", value: "200" },
          { key: "environment", value: row.value },
        ],
      });
      if (result.status !== "ok") {
        throw new Error(`event rejected: ${result.reason}`);
      }
      const entry = result.event.metadata.find((item) => item.key === "environment");
      const admitted = deploymentEnvironment(row.value) === row.value;
      expect(admitted).toBe(row.expected === row.value);
      expect(entry?.value).toBe(admitted ? row.value : REDACTED);
    });

    it(`keeps the event-level environment field ${show(row.value)} under the same rule`, () => {
      const result = sanitizeDiagnosticEvent({
        kind: "ops.health.heartbeat",
        metadata: [],
        serviceName: "convex.heartbeat",
        environment: row.value,
      });
      if (result.status !== "ok") {
        throw new Error(`event rejected: ${result.reason}`);
      }
      const admitted = deploymentEnvironment(row.value) === row.value;
      expect(admitted).toBe(row.expected === row.value);
      expect(result.event.environment).toBe(admitted ? row.value : undefined);
    });
  }
});

// ---------------------------------------------------------------------------
// The Calendar return resolver: dev is exactly what re-allows plain http.
// ---------------------------------------------------------------------------

const HTTP_PWA = "http://localhost:5173";
const HTTPS_PWA = "https://kiero-web.example.workers.dev";

describe("return.ts routes its environment read through the shared helper", () => {
  for (const row of CALL_SITE_MATRIX) {
    it(`allows a plain-http return origin exactly when ${show(row.value)} classifies as dev`, () => {
      expect(deploymentEnvironment(row.value)).toBe(row.expected);
      expect(
        calendarAppReturnHref({
          [CALENDAR_APP_BASE_URL_ENV]: HTTP_PWA,
          KIERO_ENVIRONMENT: row.value,
        }),
      ).toBe(row.expected === "dev" ? HTTP_PWA : null);
      expect(helperSpy).toHaveBeenCalledWith(row.value);
    });

    it(`keeps an https return origin valid for ${show(row.value)}`, () => {
      expect(
        calendarAppReturnHref({
          [CALENDAR_APP_BASE_URL_ENV]: HTTPS_PWA,
          KIERO_ENVIRONMENT: row.value,
        }),
      ).toBe(HTTPS_PWA);
    });
  }
});

// ---------------------------------------------------------------------------
// The gateway telemetry surface: the Worker's ENVIRONMENT tag.
// ---------------------------------------------------------------------------

/** The gateway telemetry bindings for one matrix row (ENVIRONMENT optional). */
function gatewayEnv(row: MatrixRow): TelemetryEnv {
  return { ...(row.value === undefined ? {} : { ENVIRONMENT: row.value }) };
}

describe("emit.ts routes its ENVIRONMENT tag through the shared helper", () => {
  for (const row of CALL_SITE_MATRIX) {
    it(`tags sanitized gateway events ${show(row.value)} as ${row.expected}`, () => {
      const sanitized = sanitizeGatewayEvents(gatewayEnv(row), [
        {
          kind: "ops.gateway.request",
          metadata: [
            { key: "route", value: "/platform/health" },
            { key: "httpStatus", value: "200" },
          ],
        },
      ]);
      expect(sanitized.length).toBe(1);
      expect(sanitized[0]?.environment).toBe(row.expected);
      expect(helperSpy).toHaveBeenCalledWith(row.value);
    });

    it(`lands the tag for ${show(row.value)} in the emitted telemetry payload`, async () => {
      const captured: {
        url: string;
        events: readonly { readonly environment: string; readonly metadata: Record<string, string> }[];
      }[] = [];
      vi.stubGlobal(
        "fetch",
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          captured.push({
            url: String(input),
            events: JSON.parse(String(init?.body)) as {
              environment: string;
              metadata: Record<string, string>;
            }[],
          });
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      );
      // Generated fixtures (never real credentials) so the emit takes the
      // REAL axiom delivery path.
      const env = {
        AXIOM_API_TOKEN: `test-token-${crypto.randomUUID()}`,
        AXIOM_DATASET: `test-dataset-${crypto.randomUUID().slice(0, 8)}`,
        ...gatewayEnv(row),
      };
      const pending: Promise<unknown>[] = [];
      const response = await withGatewayTelemetry(
        env,
        { waitUntil: (promise) => pending.push(promise) },
        "/platform/health",
        async () => new Response("ok", { status: 200 }),
      );
      // The response is off the telemetry critical path; then delivery runs.
      expect(await response.text()).toBe("ok");
      await Promise.all(pending);

      const [ingest] = captured;
      if (ingest === undefined) {
        throw new Error("the telemetry POST was not intercepted");
      }
      const [event] = ingest.events;
      if (event === undefined) {
        throw new Error("no event in the captured telemetry payload");
      }
      expect(ingest.url).toContain(`datasets/${env.AXIOM_DATASET}/ingest`);
      // Both observable uses of the tag: the sink event's environment field
      // and the flattened request metadata entry.
      expect(event.environment).toBe(row.expected);
      expect(event.metadata.environment).toBe(row.expected);
      expect(helperSpy).toHaveBeenCalledWith(row.value);
    });
  }
});
