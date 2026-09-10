/**
 * Module surface and registration integrity tests (A2 focused
 * verification): the composed registry is complete, names are unique,
 * consumers reference existing events, executors are unique, generated ids
 * are well-formed, and unimplemented operations fail closed with the
 * sanitized `unsupported` error.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { featureEntry } from "@kiero/contracts";
import {
  assertFeaturesCoherent,
  assertFeaturesCoverRegistrations,
  assertNoDuplicateExecutors,
  ClosedError,
  CommandEnvelope,
  DomainEventEnvelope,
  DurableJobEnvelope,
  EventIdSchema,
  events,
  eventConsumers,
  executors,
  FeatureId,
  features,
  DurableJobKeySchema,
  IdempotencyKeySchema,
  newDurableJobKey,
  newEventId,
  newIdempotencyKey,
  notImplemented,
  okResult,
  operations,
  errorResult,
  ResultEnvelope,
  OutboxEnvelope,
  parseTableId,
} from "@kiero/contracts";
import type { FeatureEntry } from "@kiero/contracts";

describe("composed registry integrity", () => {
  it("declares every module surface with unique names", () => {
    const operationNames = Object.keys(operations);
    const eventNames = Object.keys(events);
    // Exact counts: an accidentally deleted surface entry fails here.
    // (60/40 are the real registry sizes since B3's coordinated amendment
    // added the four admission/issuance/transfer operations to the access
    // surface; 66 since the B4 amendment added the six audited GM operations
    // (recoverAccount, gmInspectCompany, gmOnboardCompany, gmActivateCompany,
    // gmRestoreAdministrator, gmEndCompanyAlpha); 68/40 since the C3
    // amendment added the catalog and validate-value operations; 69/41 with
    // C4's work.promoteChecklistItem and work.eventChanged; 71/41 with H1's
    // readFindingHistory and readClarifications exposition reads;
    // naive greps of `kind: "operation"` overcount by one because
    // registration.ts declares the interface field.)
    expect(operationNames).toHaveLength(71);
    expect(eventNames).toHaveLength(41);
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
      const count = Object.keys(operations).filter((name) =>
        name.startsWith(prefix),
      ).length;
      expect(count, prefix).toBeGreaterThan(0);
    }
  });

  it("registers the four named cross-module consumer seams", () => {
    // access-revocation cleanup
    expect(
      eventConsumers.filter((c) => c.jobKind === "access.cleanup_revocation")
        .length,
    ).toBeGreaterThanOrEqual(2);
    // reanalysis (linked new run)
    expect(
      eventConsumers.some(
        (c) => c.eventName === "operations.reanalysisRequested",
      ),
    ).toBe(true);
    // deletion
    expect(
      eventConsumers.some((c) => c.eventName === "sources.sourcePurged"),
    ).toBe(true);
    // Calendar outcomes
    expect(
      eventConsumers.some(
        (c) => c.eventName === "calendar.copyOutcomeRecorded",
      ),
    ).toBe(true);
    // Every consumer edge points at a declared event and a registered executor.
    for (const consumer of eventConsumers) {
      expect(events[consumer.eventName], consumer.eventName).toBeDefined();
      expect(executors.some((e) => e.jobKind === consumer.jobKind)).toBe(true);
    }
    const jobKinds = executors.map((e) => e.jobKind);
    expect(new Set(jobKinds).size).toBe(jobKinds.length);
  });

  it("derives coherent features and rejects incoherent hand-written parts", () => {
    // One feature per executor; consumed edges and executed job kinds are
    // derived from the executor/consumer tables, never hand-written.
    // 11 executors: platform.echo (A3) + B3 cleanup + E3 extract/analyze +
    // D5 normalize + D6 transcribe + C5 recompute + G3 calendar.reconcile +
    // E4 join + F2 attention.evaluate (each lane's sanctioned append).
    expect(features).toHaveLength(11);
    expect(
      features.every((feature) => feature.providesOperations.length === 0),
    ).toBe(true);
    // The sourceAccepted edge belongs to processing.extract (the executor of
    // processing.extract_fragments), not processing.analyze.
    const extract = features.find((f) => f.featureId === "processing.extract");
    expect(extract?.consumesEvents).toEqual(["sources.sourceAccepted"]);
    const analyze = features.find((f) => f.featureId === "processing.analyze");
    expect(analyze?.consumesEvents).toEqual(["operations.reanalysisRequested"]);
    // Deliberately incoherent hand-written parts: one drifted entry with an
    // unknown provided operation, one with an unknown published event (the
    // two branches of assertFeaturesCoherent each get a fixture; A2 round 6
    // left the event branch uncovered, resolved by A3).
    const drifted: readonly FeatureEntry[] = [
      ...features,
      featureEntry({
        kind: "feature",
        featureId: Schema.decodeUnknownSync(FeatureId)("drifted.feature"),
        providesOperations: ["drifted.nonexistentOperation"],
        publishesEvents: [],
        consumesEvents: [],
        executesJobs: [],
      }),
    ];
    expect(() =>
      assertFeaturesCoherent(drifted, operations, events),
    ).toThrowError(/unknown operation drifted.nonexistentOperation/);
    expect(() =>
      assertFeaturesCoherent(
        [
          ...features,
          featureEntry({
            kind: "feature",
            featureId: Schema.decodeUnknownSync(FeatureId)("drifted.events"),
            providesOperations: [],
            publishesEvents: ["drifted.nonexistentEvent"],
            consumesEvents: [],
            executesJobs: [],
          }),
        ],
        operations,
        events,
      ),
    ).toThrowError(/unknown event drifted.nonexistentEvent/);
    expect(() =>
      assertFeaturesCoherent(features, operations, events),
    ).not.toThrow();
    // Cross-check: derived edges equal declared edges; dropping one feature
    // (and with it its executor coverage) must throw.
    expect(() =>
      assertFeaturesCoverRegistrations(features, executors, eventConsumers),
    ).not.toThrow();
    expect(() =>
      assertFeaturesCoverRegistrations(
        features.slice(1),
        executors,
        eventConsumers,
      ),
    ).toThrowError(/expected exactly 1|has no feature/);
  });

  it("fails loudly when two executors claim one job kind", () => {
    const first = executors[0];
    if (first === undefined) {
      throw new Error("expected at least one registered executor");
    }
    const duplicated = [...executors, first];
    expect(() => assertNoDuplicateExecutors(duplicated)).toThrowError(
      /duplicate executor/,
    );
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
    expect(Object.keys(encoded).sort()).toEqual([
      "_tag",
      "code",
      "message",
      "operation",
    ]);
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
      Schema.decodeUnknownSync(ResultEnvelope)({
        _tag: "error",
        error: new Error("boom"),
      }),
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
    expect(Schema.is(DurableJobKeySchema)(newDurableJobKey())).toBe(true);
    expect(newDurableJobKey().startsWith("job_")).toBe(true);
  });
});

describe("envelopes decode end to end", () => {
  it("a command envelope with expected revisions and idempotency key", () => {
    const command = Schema.decodeUnknownSync(CommandEnvelope)({
      operation: "memory.correctFinding",
      input: { findingId: "f1" },
      expectedRevisions: [
        { recordTable: "findings", recordId: "f1", revision: 3 },
      ],
      idempotencyKey: newIdempotencyKey(),
    });
    expect(command.expectedRevisions[0]?.revision).toBe(3);
    expect(() =>
      Schema.decodeUnknownSync(CommandEnvelope)({
        operation: "memory.correctFinding",
        input: {},
        expectedRevisions: [
          { recordTable: "findings", recordId: "f1", revision: 0 },
        ],
      }),
    ).toThrow();
  });

  it("a domain event and its outbox state decode", () => {
    const event = Schema.decodeUnknownSync(DomainEventEnvelope)({
      eventId: newEventId(),
      name: "sources.sourceAccepted",
      companyId: parseTableId("companies", "c1"),
      occurredAt: "2026-09-09T08:00:00.000Z",
      payload: { sourceId: "s1", attachmentIds: [] },
    });
    expect(event.name).toBe("sources.sourceAccepted");
    // The outbox stores the event in its wire (encoded) form.
    const outbox = Schema.decodeUnknownSync(OutboxEnvelope)({
      event: Schema.encodeSync(DomainEventEnvelope)(event),
      deliveryState: "pending",
      deduplicationKey: "sources.sourceAccepted:s1",
      attempts: 0,
    });
    expect(outbox.deliveryState).toBe("pending");
    expect(outbox.attempts).toBe(0);
    expect(() =>
      Schema.decodeUnknownSync(OutboxEnvelope)({
        event: Schema.encodeSync(DomainEventEnvelope)(event),
        deliveryState: "delivered",
        attempts: -1,
      }),
    ).toThrow();
  });

  it("a durable job envelope decodes with provenance and policy", () => {
    const job = Schema.decodeUnknownSync(DurableJobEnvelope)({
      jobKey: "job_00000000-0000-4000-8000-000000000000",
      kind: "deletion.purge_source",
      input: { sourceId: "s1" },
      provenance: {
        companyId: parseTableId("companies", "c1"),
        sourceId: "s1",
      },
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
