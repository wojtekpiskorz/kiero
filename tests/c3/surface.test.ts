/**
 * C3 focused verification, part 2: the contract boundary and the dispatch
 * surface.
 *
 * - the extension branch of FindingValue carries its definition version and
 *   decodes/rejects exactly (the C3 amendment);
 * - the four extension operations' inputs are bounded data: recursive
 *   (object-kind / container-item) shapes, oversized shapes and
 *   executable-looking payloads reject through the Effect schemas — and the
 *   Convex table validators pin the same closed vocabulary;
 * - the merged memory dispatch registers the extension operations with
 *   their intents, and the operation inputs still fail closed before any
 *   handler runs.
 *
 * Transaction halves (tenant visibility, OCC races, atomic usage counters,
 * the Convex-validator insert refusal) run live in tests/c3/live-proof.mjs.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  ExtensionValue,
  FindingValue,
  memoryOperations,
  parseTableId,
} from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { memoryHandlers } from "../../convex/memory/findings/dispatch";
import { extensionHandlers } from "../../convex/memory/extensions/dispatch";
import { extensionsTables } from "../../convex/memory/extensions/schema";
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

const quantityFieldWire = {
  fieldId: "grubosc",
  label: "Grubość płytki",
  kind: "quantity",
  unit: "mm",
};

describe("the extension finding value carries its definition version", () => {
  it("decodes the versioned extension branch", () => {
    const decoded = Schema.decodeUnknownSync(FindingValue)({
      _tag: "extension",
      definitionVersionId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      extensionValue: { _tag: "quantity", amount: "8", unit: "mm" },
    });
    if (decoded._tag !== "extension") {
      throw new Error("expected an extension finding");
    }
    expect(decoded.extensionValue._tag).toBe("quantity");
    expect(() =>
      Schema.encodeSync(FindingValue)(decoded as never),
    ).not.toThrow();
  });

  it("rejects an extension value without its definition version (never versionless)", () => {
    expect(() =>
      Schema.decodeUnknownSync(FindingValue)({
        _tag: "extension",
        extensionValue: { _tag: "text", text: "bez wersji" },
      }),
    ).toThrow();
  });

  it("keeps the value contract bounded: no recursion, no oversize", () => {
    // Objects hold scalar members only: a nested object member cannot decode.
    expect(() =>
      Schema.decodeUnknownSync(ExtensionValue)({
        _tag: "object",
        fields: [
          { fieldId: "a", value: { _tag: "object", fields: [] } },
        ],
      }),
    ).toThrow();
    // Lists are bounded: 65 items reject (the bound is 64).
    expect(() =>
      Schema.decodeUnknownSync(ExtensionValue)({
        _tag: "list",
        items: Array.from({ length: 65 }, () => ({ _tag: "text", text: "x" })),
      }),
    ).toThrow();
  });
});

describe("definition operation inputs are bounded data (no executable anything)", () => {
  const defineEntry = memoryOperations["memory.defineExtension"];
  const versionEntry = memoryOperations["memory.versionExtensionDefinition"];

  it("decodes a well-formed definition draft", () => {
    const decoded = Schema.decodeUnknownSync(defineEntry.input)({
      name: "Grubość płytki (mm)",
      fields: [quantityFieldWire],
    });
    expect(decoded.fields[0]?.kind).toBe("quantity");
  });

  it("rejects recursive shapes: object fields and container item kinds", () => {
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Rekurencyjna",
        fields: [{ fieldId: "wezel", label: "Węzeł", kind: "object" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(versionEntry.input)({
        definitionId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
        changeNote: "zmiana",
        fields: [{ fieldId: "macierz", label: "Macierz", kind: "list", itemKind: "list" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Obiekty w liście",
        fields: [{ fieldId: "x", label: "X", kind: "list", itemKind: "object" }],
      }),
    ).toThrow();
  });

  it("rejects oversized drafts beyond the value-contract bounds", () => {
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Za duża",
        fields: Array.from({ length: 33 }, (_, index) => ({
          ...quantityFieldWire,
          fieldId: `f${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Za dużo opcji",
        fields: [
          {
            fieldId: "kolor",
            label: "Kolor",
            kind: "enum",
            options: Array.from({ length: 65 }, (_, index) => ({
              optionId: `o${index}`,
              label: `O${index}`,
            })),
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects executable-looking payloads: no invented kinds, no code as data", () => {
    // A kind outside the closed vocabulary is refused — including anything
    // shaped like code ("() => {}") or a query name ("db.query").
    for (const kind of ["() => {}", "db.query('findings')", "function", "typescript"]) {
      expect(() =>
        Schema.decodeUnknownSync(defineEntry.input)({
          name: "Wykonywalna",
          fields: [{ fieldId: "f", label: "F", kind }],
        }),
      ).toThrow();
    }
    // TypeScript keys cannot appear: the field id pattern is closed and an
    // object/function value for a field rejects.
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Klucze TS",
        fields: [{ fieldId: "F", label: "F", kind: "text" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(defineEntry.input)({
        name: "Funkcja jako wartość",
        fields: [{ fieldId: "f", label: "F", kind: "text", unit: () => "mm" }],
      }),
    ).toThrow();
  });
});

describe("the Convex table validators pin the same closed vocabulary", () => {
  const versionFields = (
    extensionsTables.extensionVersions.validator.kind === "object"
      ? extensionsTables.extensionVersions.validator.fields
      : {}
  ) as Record<string, GenericValidator>;
  const fieldsValidator = versionFields.fields;

  it("stores version snapshots with the definition-field kind union (no object)", () => {
    expect(fieldsValidator).toBeDefined();
    expect(fieldsValidator?.kind).toBe("array");
    if (fieldsValidator?.kind === "array") {
      const element = fieldsValidator.element;
      expect(element.kind).toBe("object");
      if (element.kind === "object") {
        const kind = element.fields["kind"] as GenericValidator | undefined;
        expect(kind?.kind).toBe("union");
        if (kind?.kind === "union") {
          const literals = kind.members
            .map((member) => (member.kind === "literal" ? String(member.value) : null))
            .filter((value): value is string => value !== null)
            .sort();
          // The value kind "object" is deliberately absent: an object field
          // would demand forbidden nesting, and the Convex validator itself
          // refuses recursive shapes at insert time (proved live).
          expect(literals).toEqual([
            "boolean",
            "entity_ref",
            "enum",
            "financial",
            "list",
            "quantity",
            "temporal",
            "text",
          ]);
        }
      }
    }
  });

  it("keeps usage counters keyed per company and definition", () => {
    const usageFields = (
      extensionsTables.extensionUsage.validator.kind === "object"
        ? extensionsTables.extensionUsage.validator.fields
        : {}
    ) as Record<string, GenericValidator>;
    for (const name of ["companyId", "definitionId", "usedVersionId", "usageCount"]) {
      expect(usageFields[name], name).toBeDefined();
    }
  });
});

describe("the merged memory dispatch registration", () => {
  it("registers the four extension operations with their intents", () => {
    const extensionOps = extensionHandlers();
    expect(Object.keys(extensionOps).sort()).toEqual([
      "memory.defineExtension",
      "memory.searchExtensionCatalog",
      "memory.validateExtensionValue",
      "memory.versionExtensionDefinition",
    ]);
    expect(extensionOps["memory.searchExtensionCatalog"]?.intent).toBe("read");
    expect(extensionOps["memory.validateExtensionValue"]?.intent).toBe("read");
    for (const name of ["memory.defineExtension", "memory.versionExtensionDefinition"]) {
      expect(extensionOps[name]?.intent, name).toBe("write");
    }
    // The merged findings registry carries them all through ONE checked path.
    const merged = memoryHandlers();
    for (const name of Object.keys(extensionOps)) {
      expect(merged[name], name).toBeDefined();
    }
  });

  it("never invokes a handler when the contract rejects the definition draft", async () => {
    const handler = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "memory.defineExtension": { intent: "write", run: handler } },
      },
      undefined,
      envelope("memory.defineExtension", {
        name: "Zła definicja",
        fields: [{ fieldId: "wezel", label: "Węzeł", kind: "object" }], // recursive: rejects
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands handlers the DECODED draft (the C2 forwarding contract)", async () => {
    const seen: unknown[] = [];
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {
          "memory.defineExtension": {
            intent: "write",
            run: async (_tx, _context, input) => {
              seen.push(input);
              return { _tag: "ok" as const, value: {} };
            },
          },
        },
      },
      undefined,
      envelope("memory.defineExtension", {
        name: "Grubość płytki (mm)",
        fields: [quantityFieldWire],
      }),
    );
    expect(result._tag).toBe("ok");
    expect(seen).toHaveLength(1);
    const draft = seen[0] as { fields: { kind: string }[] };
    expect(draft.fields[0]?.kind).toBe("quantity");
  });
});
