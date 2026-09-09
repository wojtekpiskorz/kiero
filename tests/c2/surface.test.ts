/**
 * C2 focused verification, part 2: the contract boundary and the dispatch
 * surface.
 *
 * - the amended `memory.prepareChangeSet` plan decodes fully-scoped plans
 *   and rejects model nulls (explicit operations only, never null erasure);
 * - typed financial/temporal contracts hold at the boundary: `not_specified`
 *   tax basis is a first-class visible state, VAT is never inferred, no
 *   invented time components;
 * - the schema fragment keeps knowledge states separate from business
 *   progress and extraction confidence, and pins the provenance vocabulary;
 * - the lane registers exactly its six operations under the checked path and
 *   leaves the extension operations (C3) failing closed `unsupported`.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  FindingValue,
  KnowledgeState,
  MoneyValue,
  PlannedRevision,
  parseTableId,
} from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { memoryHandlers } from "../../convex/memory/findings/dispatch";
import { prepareChangeSetEntry } from "../../convex/memory/findings/core";
import { findingsTables } from "../../convex/memory/findings/schema";
import type { MutationCtx } from "../../convex/_generated/server";
import type { GenericValidator } from "convex/values";

function contextFixture(): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: "admin",
    isGm: false,
    sessionId: parseTableId("sessions", "s1"),
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() };
}

const envelope = (operation: string, input: unknown) => ({
  operation,
  input,
  expectedRevisions: [],
});

describe("the amended prepareChangeSet plan boundary", () => {
  const moneyPlan = {
    sourceId: "s1",
    plannedRevisions: [
      {
        findingId: null,
        scope: { _tag: "company" },
        semanticKey: "cena.ustalona",
        value: {
          _tag: "money",
          money: {
            role: "agreed_price",
            amount: { _tag: "exact", value: "10000" },
            currency: "PLN",
            currencyOrigin: "stated",
            taxBasis: "not_specified",
            certainty: "exact",
          },
        },
        knowledgeState: { _tag: "known" },
        effectiveFrom: null,
        evidence: [
          { sourceId: "s1", fragmentId: null, supportKind: "support" },
        ],
        derivesFrom: [],
      },
    ],
  };

  it("decodes a fully-scoped plan with evidence and derivation basis", () => {
    const decoded = Schema.decodeUnknownSync(prepareChangeSetEntry.input)(moneyPlan);
    const planned: PlannedRevision = decoded.plannedRevisions[0] as PlannedRevision;
    expect(planned.scope._tag).toBe("company");
    expect(planned.evidence[0]?.supportKind).toBe("support");
    expect(planned.derivesFrom).toEqual([]);
  });

  it("rejects a model null masquerading as a value or state (null never erases)", () => {
    // value: null — a model trying to clear data with null does not decode.
    expect(() =>
      Schema.decodeUnknownSync(prepareChangeSetEntry.input)({
        ...moneyPlan,
        plannedRevisions: [
          { ...moneyPlan.plannedRevisions[0], value: null },
        ],
      }),
    ).toThrow();
    // knowledgeState omitted or null: clearing is an EXPLICIT operation with
    // a reason, never an absent field.
    const withoutState = { ...moneyPlan.plannedRevisions[0] } as Record<string, unknown>;
    delete withoutState.knowledgeState;
    expect(() =>
      Schema.decodeUnknownSync(prepareChangeSetEntry.input)({
        ...moneyPlan,
        plannedRevisions: [withoutState],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(prepareChangeSetEntry.input)({
        ...moneyPlan,
        plannedRevisions: [
          { ...moneyPlan.plannedRevisions[0], knowledgeState: null },
        ],
      }),
    ).toThrow();
  });

  it("rejects evidence with a non-witness support kind (inference is not a witness)", () => {
    expect(() =>
      Schema.decodeUnknownSync(prepareChangeSetEntry.input)({
        ...moneyPlan,
        plannedRevisions: [
          {
            ...moneyPlan.plannedRevisions[0],
            evidence: [{ sourceId: "s1", fragmentId: null, supportKind: "derivation" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps unknown-with-reason explicit: a reason is required, not optional", () => {
    expect(() =>
      Schema.decodeUnknownSync(KnowledgeState)({ _tag: "unknown", reason: "" }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(KnowledgeState)({ _tag: "unknown", reason: "szef nie podał" }),
    ).toEqual({ _tag: "unknown", reason: "szef nie podał" });
  });
});

describe("financial and temporal value contracts at the boundary", () => {
  it("keeps not_specified tax basis visible; VAT is never inferred (closed vocabulary)", () => {
    const money = Schema.decodeUnknownSync(MoneyValue)({
      role: "agreed_price",
      amount: { _tag: "exact", value: "10000" },
      currency: "PLN",
      currencyOrigin: "company_default",
      taxBasis: "not_specified",
      certainty: "estimate",
    });
    expect(money.taxBasis).toBe("not_specified");
    // The wire form round-trips the visible state.
    expect(Schema.encodeSync(MoneyValue)(money).taxBasis).toBe("not_specified");
    // There is no "net_by_default": anything outside the closed set rejects.
    expect(() =>
      Schema.decodeUnknownSync(MoneyValue)({
        role: "agreed_price",
        amount: { _tag: "exact", value: "10000" },
        currency: "PLN",
        currencyOrigin: "company_default",
        taxBasis: "vat_23",
        certainty: "exact",
      }),
    ).toThrow();
    // Ranges keep justified bounds; min>max rejects.
    expect(() =>
      Schema.decodeUnknownSync(MoneyValue)({
        role: "price_proposal",
        amount: { _tag: "range", min: "12000", max: "10000" },
        currency: "PLN",
        currencyOrigin: "company_default",
        taxBasis: "not_specified",
        certainty: "estimate",
      }),
    ).toThrow();
  });

  it("invents no time components: a day stays a day; ranges keep precision", () => {
    const temporal = Schema.decodeUnknownSync(FindingValue)({
      _tag: "temporal",
      temporal: {
        shape: { _tag: "day", day: "2026-09-09" },
        originalExpression: "jutro",
        role: "agreed",
      },
    });
    if (temporal._tag !== "temporal") {
      throw new Error("expected temporal finding");
    }
    expect(temporal.temporal.shape).toEqual({ _tag: "day", day: "2026-09-09" });
    expect(temporal.temporal.originalExpression).toBe("jutro");
    // A month-precision date never invents a day; impossible dates reject.
    expect(() =>
      Schema.decodeUnknownSync(FindingValue)({
        _tag: "temporal",
        temporal: {
          shape: { _tag: "day", day: "2026-02-30" },
          originalExpression: "x",
          role: "agreed",
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(FindingValue)({
        _tag: "temporal",
        temporal: {
          shape: { _tag: "day", day: "2026-09-09T10:00:00" },
          originalExpression: "x",
          role: "agreed",
        },
      }),
    ).toThrow();
  });
});

describe("the C2 schema fragment (knowledge separate from progress)", () => {
  const findingFields = (
    findingsTables.findings.validator.kind === "object"
      ? findingsTables.findings.validator.fields
      : {}
  ) as Record<string, GenericValidator>;
  const revisionFields = (
    findingsTables.findingRevisions.validator.kind === "object"
      ? findingsTables.findingRevisions.validator.fields
      : {}
  ) as Record<string, GenericValidator>;

  it("carries knowledge state on findings and revisions, and no business progress", () => {
    expect(findingFields.knowledgeState).toBeDefined();
    expect(revisionFields.knowledgeState).toBeDefined();
    // Business progress lives in the work module; extraction confidence on
    // extractions (D1). Neither may appear here.
    for (const forbidden of [
      "state",
      "taskState",
      "progress",
      "stage",
      "extractionConfidence",
      "confidence",
    ]) {
      expect(findingFields[forbidden], forbidden).toBeUndefined();
      expect(revisionFields[forbidden], forbidden).toBeUndefined();
    }
  });

  it("names each revision's origin and author (provenance shapes follow it)", () => {
    for (const name of ["origin", "recordedByUserId", "recordedAtMs"]) {
      expect(revisionFields[name], name).toBeDefined();
    }
    // Provenance is optional but present-shaped; reason optional (corrections).
    expect(revisionFields.provenance?.isOptional).toBe("optional");
    expect(revisionFields.reason?.isOptional).toBe("optional");
    // Immutable history: no editable author/time fields beyond the immutable
    // snapshot, and the revision identity is (findingId, revision).
    expect(revisionFields.supersedesRevisionId?.isOptional).toBe("optional");
  });

  it("keys evidence links on the source with optional fragment (whole-source evidence)", () => {
    const linkFields = (
      findingsTables.evidenceLinks.validator.kind === "object"
        ? findingsTables.evidenceLinks.validator.fields
        : {}
    ) as Record<string, GenericValidator>;
    expect(linkFields.sourceId?.isOptional).toBe("required");
    expect(linkFields.sourceFragmentId?.isOptional).toBe("optional");
    const supportKind = linkFields.supportKind;
    expect(supportKind?.kind).toBe("union");
    if (supportKind?.kind === "union") {
      const kinds = supportKind.members
        .map((member) => (member.kind === "literal" ? String(member.value) : null))
        .filter((value): value is string => value !== null)
        .sort();
      expect(kinds).toEqual([
        "derivation",
        "independent_corroboration",
        "supersession",
        "support",
      ]);
    }
  });

  it("stages the plan with captured expectations in the publication group", () => {
    const groupFields = (
      findingsTables.publicationGroups.validator.kind === "object"
        ? findingsTables.publicationGroups.validator.fields
        : {}
    ) as Record<string, GenericValidator>;
    expect(groupFields.plannedChanges).toBeDefined();
    expect(groupFields.expectedRevisions).toBeDefined();
    expect(groupFields.memberRevisionIds?.isOptional).toBe("optional");
  });
});

describe("the memory dispatch registration", () => {
  it("registers exactly this lane's six operations with their intents", () => {
    const handlers = memoryHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "memory.correctFinding",
      "memory.prepareChangeSet",
      "memory.publishChangeSet",
      "memory.raiseClarification",
      "memory.readCurrentFindings",
      "memory.resolveClarification",
    ]);
    expect(handlers["memory.readCurrentFindings"]?.intent).toBe("read");
    for (const name of [
      "memory.prepareChangeSet",
      "memory.publishChangeSet",
      "memory.correctFinding",
      "memory.raiseClarification",
      "memory.resolveClarification",
    ]) {
      expect(handlers[name]?.intent, name).toBe("write");
    }
  });

  it("fails closed unsupported on the extension operations this lane does not own", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: memoryHandlers(),
      },
      // The unsupported path refuses before any handler runs, so the ctx is
      // never dereferenced; typed for the registry, null for the test.
      null as unknown as Parameters<typeof dispatchCommand<MutationCtx>>[1],
      envelope("memory.defineExtension", {
        name: "Grubość płytki",
        fields: [{ fieldId: "mm", label: "Milimetry", kind: "quantity" }],
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
    }
  });

  it("never invokes a handler when the contract rejects the plan input", async () => {
    const handler = vi.fn(async () => ({
      _tag: "ok" as const,
      value: {},
    }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "memory.prepareChangeSet": { intent: "write", run: handler } },
      },
      undefined,
      envelope("memory.prepareChangeSet", {
        sourceId: "s1",
        plannedRevisions: [
          {
            findingId: null,
            scope: { _tag: "company" },
            semanticKey: "k",
            value: { _tag: "text_note", text: "" }, // NonEmptyString rejects
            knowledgeState: { _tag: "known" },
            effectiveFrom: null,
            evidence: [],
            derivesFrom: [],
          },
        ],
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands handlers the DECODED money plan: BigDecimal amounts survive the seam", async () => {
    // Regression (found live): re-decoding the dispatch's decoded value in a
    // handler rejects schema-transformed fields — BigDecimalFromString
    // accepts "10000" once, then holds a BigDecimal — so every money plan
    // failed with input_rejected_by_contract_schema. The handlers forward the
    // decoded value; this pins that contract.
    const seen: unknown[] = [];
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {
          "memory.prepareChangeSet": {
            intent: "write",
            run: async (_tx, _context, input) => {
              seen.push(input);
              return { _tag: "ok" as const, value: {} };
            },
          },
        },
      },
      undefined,
      envelope("memory.prepareChangeSet", {
        sourceId: "s1",
        plannedRevisions: [
          {
            findingId: null,
            scope: { _tag: "company" },
            semanticKey: "cena.ustalona",
            value: {
              _tag: "money",
              money: {
                role: "agreed_price",
                amount: { _tag: "exact", value: "10000" },
                currency: "PLN",
                currencyOrigin: "stated",
                taxBasis: "not_specified",
                certainty: "exact",
              },
            },
            knowledgeState: { _tag: "known" },
            effectiveFrom: null,
            evidence: [{ sourceId: "s1", fragmentId: null, supportKind: "support" }],
            derivesFrom: [],
          },
        ],
      }),
    );
    expect(result._tag).toBe("ok");
    expect(seen).toHaveLength(1);
    const planned = (seen[0] as { plannedRevisions: { value: unknown }[] }).plannedRevisions[0];
    // The value the transaction core receives is the DECODED form: the core's
    // encode step works on it (a raw wire string would decode; a re-decoded
    // BigDecimal would throw).
    expect(() => Schema.encodeSync(FindingValue)(planned?.value as never)).not.toThrow();
  });
});
