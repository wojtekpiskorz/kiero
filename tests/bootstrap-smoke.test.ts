import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { createElement, version as reactVersion } from "react";
import { v } from "convex/values";
import { createModel, toolDefinition } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";

/**
 * A1 bootstrap smoke test.
 *
 * This proves that the pinned versions in the root package.json install,
 * load and interoperate at the most basic level:
 *
 * - Effect 4 RC: a small Effect Schema value definition compiles and a
 *   decode-through-validate round trip succeeds on valid input and rejects
 *   invalid input.
 * - Convex: the `convex/values` validator module imports and constructs
 *   validators.
 * - React: the runtime imports and produces elements.
 * - TanStack AI + OpenRouter adapter: the published core and adapter
 *   packages import with callable model/tool factories.
 *
 * This is an import/compat smoke only. It is explicitly NOT the deeper A3
 * runtime composition proof (real Effect runtime conversion, Convex
 * codegen, actual provider calls). No network access happens here.
 */

describe("pinned dependency smoke", () => {
  it("effect 4 RC schema decodes and validates a round trip", () => {
    const SourcePlaceholder = Schema.Struct({
      id: Schema.String,
      state: Schema.Union([
        Schema.Literal("draft"),
        Schema.Literal("accepted"),
      ]),
      attachmentCount: Schema.Number,
    });

    const decode = Schema.decodeUnknownSync(SourcePlaceholder);

    const decoded = decode({
      id: "src_bootstrap_1",
      state: "accepted",
      attachmentCount: 2,
    });
    expect(decoded).toEqual({
      id: "src_bootstrap_1",
      state: "accepted",
      attachmentCount: 2,
    });

    expect(() =>
      decode({ id: "src_bootstrap_2", state: "withdrawn", attachmentCount: 0 }),
    ).toThrow();
    expect(() =>
      decode({ id: "src_bootstrap_3", state: "draft", attachmentCount: "two" }),
    ).toThrow();
  });

  it("convex/values constructs document validators", () => {
    const sourceDocument = v.object({
      text: v.string(),
      attachments: v.array(v.id("_storage")),
      fullyAcceptedAt: v.optional(v.number()),
    });

    expect(sourceDocument.kind).toBe("object");
    expect(Object.keys(sourceDocument.fields).sort()).toEqual([
      "attachments",
      "fullyAcceptedAt",
      "text",
    ]);
  });

  it("react imports and produces elements at the pinned version", () => {
    expect(reactVersion).toMatch(/^19\./);
    const element = createElement("p", null, "Kiero — rdzeń w przygotowaniu");
    expect(element.type).toBe("p");
    expect(element.props.children).toBe("Kiero — rdzeń w przygotowaniu");
  });

  it("tanstack ai core and openrouter adapter import with callable factories", () => {
    expect(typeof createModel).toBe("function");
    expect(typeof toolDefinition).toBe("function");
    expect(typeof createOpenRouterText).toBe("function");
  });
});
