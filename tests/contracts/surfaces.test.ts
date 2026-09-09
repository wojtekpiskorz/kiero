/**
 * Module surface and registration integrity tests (A2 focused
 * verification): the composed registry is complete, names are unique,
 * consumers reference existing events, executors are unique, generated ids
 * are well-formed, and unimplemented operations fail closed with the
 * sanitized `unsupported` error.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ClosedError,
  assertNoDuplicateExecutors,
  CommandEnvelope,
  DurableJobEnvelope,
  DomainEventEnvelope,
  EventIdSchema,
  IdempotencyKeySchema,
  ResultEnvelope,
  errorResult,
  events,
  executors,
  eventConsumers,
  newEventId,
  newIdempotencyKey,
  notImplemented,
  okResult,
  operations,
  parseTableId,
} from "@kiero/contracts";

describe("composed registry integrity", () => {
  it("declares every module surface with unique names", () => {
    const operationNames = Object.keys(operations);
    const eventNames = Object.keys(events);
    expect(operationNames.length).toBeGreaterThan(30);
    expect(eventNames.length).toBeGreaterThan(20);
    for (const name of operationNames) {
      expect(operations[name]?.name).toBe(name);
      expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_]*$/);
    }
    for (const name of eventNames) {
      expect(events[name]?.name).toBe(name);
      expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_]*$/);
    }
  });

  it("covers one operation per architecture deep module", () => {
    for (const prefix of [
      "access.",
      "sources.",
      "memory.",
      "projects.",
      "work.",
      "attention.",
      "calendar.",
      "operations.",
      "search.",
      "integrations.",
    ]) {
      const count = Object.keys(operations).filter((name) => name.startsWith(prefix)).length;
      expect(count, prefix).toBeGreaterThan(0);
    }
  });

  it("registers the four named cross-module consumer seams", () => {
    // access-revocation cleanup
    expect(
      eventConsumers.filter((c) => c.jobKind === "access.cleanup_revocation").length,
    ).toBeGreaterThanOrEqual(2);
    // reanalysis (linked new run)
    expect(eventConsumers.some((c) => c.eventName === "operations.reanalysisRequested")).toBe(true);
    // deletion
    expect(eventConsumers.some((c) => c.eventName === "sources.sourcePurged")).toBe(true);
    // Calendar outcomes
    expect(eventConsumers.some((c) => c.eventName === "calendar.copyOutcomeRecorded")).toBe(true);
    // Every consumer edge points at a declared event and a registered executor.
    for (const consumer of eventConsumers) {
      expect(events[consumer.eventName], consumer.eventName).toBeDefined();
      expect(executors.some((e) => e.jobKind === consumer.jobKind)).toBe(true);
    }
    const jobKinds = executors.map((e) => e.jobKind);
    expect(new Set(jobKinds).size).toBe(jobKinds.length);
  });

  it("fails loudly when two executors claim one job kind", () => {
    const first = executors[0];
    if (first === undefined) {
      throw new Error("expected at least one registered executor");
    }
    const duplicated = [...executors, first];
    expect(() => assertNoDuplicateExecutors(duplicated)).toThrowError(/duplicate executor/);
    expect(() => assertNoDuplicateExecutors(executors)).not.toThrow();
  });
});

describe("fail-closed placeholders", () => {
  it("notImplemented returns a sanitized closed error", () => {
    const error = notImplemented("access.resolveCurrentAccess");
    expect(error._tag).toBe("unsupported");
    expect(Schema.is(ClosedError)(error)).toBe(true);
    // No internals leak: the closed error has no stack/cause/detail fields.
    const encoded = Schema.encodeSync(ClosedError)(error);
    expect(Object.keys(encoded).sort()).toEqual(["_tag", "code", "message", "operation"]);
  });

  it("result envelopes decode on both branches", () => {
    const ok = okResult({ some: "value" });
    const err = errorResult(notImplemented("sources.acceptSource"));
    expect(Schema.is(ResultEnvelope)(ok)).toBe(true);
    expect(Schema.is(ResultEnvelope)(err)).toBe(true);
    expect(ok._tag).toBe("ok");
    expect(err._tag).toBe("error");
    // Envelope rejects a raw internal error without the closed shape.
    expect(() =>
      Schema.decodeUnknownSync(ResultEnvelope)({ _tag: "error", error: new Error("boom") }),
    ).toThrow();
  });
});

describe("typed ids", () => {
  it("document ids normalize without casts and reject non-strings", () => {
    const companyId = parseTableId("companies", "abc123");
    expect(companyId).toBe("abc123");
    expect(parseTableId("companies", 42)).toBeNull();
    expect(parseTableId("companies", null)).toBeNull();
  });

  it("generated ids match their schemas", () => {
    expect(Schema.is(EventIdSchema)(newEventId())).toBe(true);
    expect(Schema.is(IdempotencyKeySchema)(newIdempotencyKey())).toBe(true);
    expect(newIdempotencyKey().startsWith("idem_")).toBe(true);
  });
});

describe("envelopes decode end to end", () => {
  it("a command envelope with expected revisions and idempotency key", () => {
    const command = Schema.decodeUnknownSync(CommandEnvelope)({
      operation: "memory.correctFinding",
      input: { findingId: "f1" },
      expectedRevisions: [{ recordTable: "findings", recordId: "f1", revision: 3 }],
      idempotencyKey: newIdempotencyKey(),
    });
    expect(command.expectedRevisions[0]?.revision).toBe(3);
    expect(() =>
      Schema.decodeUnknownSync(CommandEnvelope)({
        operation: "memory.correctFinding",
        input: {},
        expectedRevisions: [{ recordTable: "findings", recordId: "f1", revision: 0 }],
      }),
    ).toThrow();
  });

  it("a domain event and outbox state decode", () => {
    const event = Schema.decodeUnknownSync(DomainEventEnvelope)({
      eventId: newEventId(),
      name: "sources.sourceAccepted",
      companyId: parseTableId("companies", "c1"),
      occurredAt: "2026-09-09T08:00:00.000Z",
      payload: { sourceId: "s1", attachmentIds: [] },
    });
    expect(event.name).toBe("sources.sourceAccepted");
  });

  it("a durable job envelope decodes with provenance and policy", () => {
    const job = Schema.decodeUnknownSync(DurableJobEnvelope)({
      jobKey: "job_00000000-0000-4000-8000-000000000000",
      kind: "deletion.purge_source",
      input: { sourceId: "s1" },
      provenance: { companyId: parseTableId("companies", "c1"), sourceId: "s1" },
      policy: { maxAttempts: 3, backoffBaseMs: 1000 },
      state: "queued",
    });
    expect(job.kind).toBe("deletion.purge_source");
    expect(() =>
      Schema.decodeUnknownSync(DurableJobEnvelope)({
        jobKey: "job_not-a-uuid",
        kind: "deletion.purge_source",
        input: {},
        provenance: { companyId: "c1" },
        policy: { maxAttempts: 3, backoffBaseMs: 1000 },
        state: "queued",
      }),
    ).toThrow();
  });
});
