/**
 * Schema + descriptor integrity tests (I2): the telemetry fragment's tables,
 * indexes and closed unions; the infra/observability descriptors cannot
 * drift from the single definitions; the incident classification model.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import schema from "../../convex/schema";
import { TABLE_ID_NAMES } from "@kiero/contracts";
import {
  diagnosticEventSpec,
  sanitizeDiagnosticEvent,
  DIAGNOSTIC_EVENT_KINDS,
} from "../../convex/operations/telemetry/redact";
import {
  HEARTBEAT_SERVICES,
  HEARTBEATS_KEPT_PER_SERVICE,
} from "../../convex/operations/telemetry/heartbeat";
import { SPEND_PROVIDERS } from "../../convex/operations/telemetry/costs";
import { OBSERVABILITY_HONESTY } from "../../convex/operations/telemetry/observability";
import {
  classifyIncidents,
  STUCK_RUN_MS,
} from "../../convex/operations/telemetry/incidents";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const observabilityDir = path.resolve(fixturesDir, "../../infra/observability");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(observabilityDir, name), "utf8"),
  ) as Record<string, unknown>;
}

interface LooseField {
  kind: string;
  value?: unknown;
  members?: LooseField[];
}
interface LooseValidator {
  kind: string;
  fields?: Record<string, LooseField>;
  members?: LooseField[];
}

/** Pulls the literal members out of a table's closed vocabulary column. */
function literalMembers(
  table: "diagnosticEvents" | "healthHeartbeats" | "costEntries",
  column: "kind" | "serviceName" | "provider",
): string[] {
  const validator = schema.tables[table]?.validator as unknown as
    LooseValidator | undefined;
  if (
    validator === undefined ||
    validator.kind !== "object" ||
    validator.fields === undefined
  ) {
    throw new Error(`${table}: expected an object validator`);
  }
  const field = validator.fields[column] as LooseField | undefined;
  if (
    field === undefined ||
    field.kind !== "union" ||
    field.members === undefined
  ) {
    throw new Error(`${table}.${column}: expected a union validator`);
  }
  return field.members
    .map((member) => (member.kind === "literal" ? String(member.value) : null))
    .filter((value): value is string => value !== null);
}

describe("telemetry fragment tables", () => {
  it("adds exactly the three I2 tables to the closed inventory", () => {
    const inventory = new Set(TABLE_ID_NAMES);
    for (const table of [
      "healthHeartbeats",
      "costEntries",
      "costAlertStates",
    ]) {
      expect(
        inventory.has(table as (typeof TABLE_ID_NAMES)[number]),
        table,
      ).toBe(true);
    }
    // 55 at I2 integration (52 + 3); 61 after B1; 64 after B2; 65 after B4;
    // 66 after C4's workRevisions; 68 after D6's audioTranscripts/audioSegments;
    // 70 after G3's calendarSyncAttempts/calendarProofEvents; 71 after
    // E4's visionOrders; 73 after F3's pushDeliveries and pushProofDevices.
    expect(TABLE_ID_NAMES).toHaveLength(73);
  });

  it("the table unions are pinned to the single model definitions", () => {
    expect(new Set(literalMembers("diagnosticEvents", "kind"))).toEqual(
      new Set(DIAGNOSTIC_EVENT_KINDS),
    );
    expect(new Set(literalMembers("healthHeartbeats", "serviceName"))).toEqual(
      new Set(HEARTBEAT_SERVICES),
    );
    expect(new Set(literalMembers("costEntries", "provider"))).toEqual(
      new Set(SPEND_PROVIDERS),
    );
  });

  it("carries the indexes the monitors and retention need", () => {
    type IndexableTable = {
      " indexes"(): { indexDescriptor: string; fields: string[] }[];
    };
    const indexFields = (
      table:
        | "diagnosticEvents"
        | "healthHeartbeats"
        | "costEntries"
        | "costAlertStates",
      index: string,
    ): string[] => {
      const tableDefinition = schema.tables[table] as
        IndexableTable | undefined;
      if (tableDefinition === undefined) {
        throw new Error(`${table}.${index} missing`);
      }
      const found = tableDefinition[" indexes"]().find(
        (d) => d.indexDescriptor === index,
      );
      if (found === undefined) {
        throw new Error(`${table}.${index} missing`);
      }
      return [...found.fields];
    };
    expect(indexFields("diagnosticEvents", "by_time")).toEqual(["atMs"]);
    expect(indexFields("diagnosticEvents", "by_dedup")).toEqual(["dedupKey"]);
    expect(indexFields("diagnosticEvents", "by_kind_time")).toEqual([
      "kind",
      "atMs",
    ]);
    expect(indexFields("healthHeartbeats", "by_service_time")).toEqual([
      "serviceName",
      "atMs",
    ]);
    expect(indexFields("costEntries", "by_period_provider")).toEqual([
      "period",
      "provider",
    ]);
    expect(indexFields("costAlertStates", "by_period_level")).toEqual([
      "period",
      "level",
    ]);
  });
});

describe("descriptors cannot drift from the single definitions", () => {
  it("events.json equals diagnosticEventSpec()", () => {
    const descriptor = readJson("events.json");
    expect(descriptor).toEqual(diagnosticEventSpec());
  });

  it("retention.json matches the windowing constants", () => {
    const descriptor = readJson("retention.json") as {
      diagnosticEvents: { windowDays: number };
      healthHeartbeats: { keptPerService: number };
    };
    expect(descriptor.diagnosticEvents.windowDays).toBe(30);
    expect(descriptor.healthHeartbeats.keptPerService).toBe(
      HEARTBEATS_KEPT_PER_SERVICE,
    );
  });

  it("the honesty block states the Free-plan blind spots", () => {
    expect(OBSERVABILITY_HONESTY.nativeConvexLogHistory).toBe(
      "unavailable_on_free_plan",
    );
    expect(OBSERVABILITY_HONESTY.applicationEvents).toBe(
      "explicit_redacted_events_only",
    );
    expect(OBSERVABILITY_HONESTY.diagnosticWindowDays).toBe(30);
    expect(OBSERVABILITY_HONESTY.blindSpots.length).toBe(3);
    expect(OBSERVABILITY_HONESTY.authority).toBe(
      "domain_tables_canonical_telemetry_best_effort",
    );
  });
});

describe("incident classification (monitor scan 1)", () => {
  const nowMs = Date.parse("2026-09-09T12:00:00Z");

  it("diagnoses attempts-exhausted durable jobs exactly once (dedup by jobKey)", () => {
    const incidents = classifyIncidents(
      {
        jobs: [
          {
            jobKey: "job_abc123-def456",
            kind: "processing.transcribe_segment",
            state: "failed",
            attempts: 3,
            maxAttempts: 3,
            lastErrorKind: "echo_target_not_configured",
          },
          {
            jobKey: "job_retry-pending",
            kind: "platform.echo_delivery",
            state: "failed",
            attempts: 1,
            maxAttempts: 3,
          }, // not exhausted
          {
            jobKey: "job_ok-000000",
            kind: "platform.echo_delivery",
            state: "succeeded",
            attempts: 1,
            maxAttempts: 3,
          },
        ],
        outbox: [],
        runs: [],
      },
      nowMs,
    );
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    expect(incident).toMatchObject({
      kind: "ops.job.attempts_exhausted",
      dedupKey: "incident:job_exhausted:job_abc123-def456",
    });
    // The metadata itself must survive the sanitizer unchanged.
    const sanitized =
      incident === undefined
        ? { status: "rejected" as const }
        : sanitizeDiagnosticEvent({
            kind: incident.kind,
            metadata: incident.metadata,
          });
    expect(sanitized.status).toBe("ok");
    if (sanitized.status === "ok") {
      expect(sanitized.event.redactionsApplied).toBe(0);
    }
  });

  it("diagnoses failed outbox rows and stuck runs", () => {
    const incidents = classifyIncidents(
      {
        jobs: [],
        outbox: [
          {
            eventId: "c4d62f5c-0000-4000-8000-000000000000",
            eventName: "sources.sourceAccepted",
            deliveryState: "failed",
            attempts: 1,
            lastErrorKind: "consumer_projection_missing",
          },
          {
            eventId: "c4d62f5c-0000-4000-8000-000000000001",
            eventName: "platform.echoRequested",
            deliveryState: "delivered",
            attempts: 1,
          },
        ],
        runs: [
          {
            runId: "p97bxdbr9x2jd9x73ha8dtc9hkchm0f1",
            state: "running",
            startedAtMs: nowMs - STUCK_RUN_MS - 1,
          },
          {
            runId: "p97bxdbr9x2jd9x73ha8dtc9hkchm0f2",
            state: "running",
            startedAtMs: nowMs - 60_000,
          },
          {
            runId: "p97bxdbr9x2jd9x73ha8dtc9hkchm0f3",
            state: "succeeded",
            startedAtMs: nowMs - STUCK_RUN_MS - 1,
          },
        ],
      },
      nowMs,
    );
    expect(incidents.map((i) => i.kind).sort()).toEqual([
      "ops.outbox.delivery_failed",
      "ops.processing.stuck",
    ]);
  });
});
