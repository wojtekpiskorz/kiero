/**
 * E3 focused verification, part 2: the Convex-side wiring — executor
 * registration behind the A3 seam, the run-version labels, the amended
 * extract input contract, and the tool schemas' conversion through the A3
 * JSON-schema path (what the provider actually receives).
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  analyzeChangePlanInput,
  extractFragmentsInput,
} from "@kiero/contracts";
import { toolJsonSchema } from "@kiero/runtime";
import {
  AskClarificationArgs,
  IdentifyProjectArgs,
  PLANNING_TOOLS,
  UpsertFindingArgs,
} from "@kiero/agent";
import {
  CLARIFICATION_SEQUENCE_BASE,
  GROUP_SEQUENCE_BASE,
  LOAD_CONTEXT_SEQUENCE,
  MODEL_ANALYSIS_SEQUENCE,
  MODEL_CONFIGURATION_VERSION,
  analyzeChangePlanExecutor,
} from "../../convex/processing/text/analyze";
import {
  EXTRACT_STEP_SEQUENCE,
  extractFragmentsExecutor,
} from "../../convex/processing/text/extract";

describe("executor registration behind the A3 seam", () => {
  it("the E3 executors claim exactly the registered job kinds", () => {
    expect(analyzeChangePlanExecutor.jobKind).toBe("processing.analyze_change_plan");
    expect(extractFragmentsExecutor.jobKind).toBe("processing.extract_fragments");
  });

  it("the amended extract input accepts a null extractionId (the drain projection)", () => {
    const decoded = Schema.decodeUnknownSync(extractFragmentsInput)({
      sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      extractionId: null,
    });
    expect(decoded.extractionId).toBeNull();
    // The named form (D1's publisher registration) still decodes.
    expect(
      Schema.decodeUnknownSync(extractFragmentsInput)({
        sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
        extractionId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      }).extractionId,
    ).toBeTypeOf("string");
  });

  it("the analyze input decodes the drain projection's reanalysis shape", () => {
    const decoded = Schema.decodeUnknownSync(analyzeChangePlanInput)({
      sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      processingRunId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      reanalysisOfRunId: null,
    });
    expect(decoded.reanalysisOfRunId).toBeNull();
  });
});

describe("run versions and resumable stage sequences", () => {
  it("pins the pipeline/prompt/schema/model-configuration labels", () => {
    expect(MODEL_CONFIGURATION_VERSION).toBe("e2.routing/e2.0#chat_analysis");
  });

  it("stage sequences are distinct and ordered (resumable status)", () => {
    expect(EXTRACT_STEP_SEQUENCE).toBeLessThan(LOAD_CONTEXT_SEQUENCE);
    expect(LOAD_CONTEXT_SEQUENCE).toBeLessThan(MODEL_ANALYSIS_SEQUENCE);
    expect(MODEL_ANALYSIS_SEQUENCE).toBeLessThan(CLARIFICATION_SEQUENCE_BASE);
    expect(CLARIFICATION_SEQUENCE_BASE).toBeLessThan(GROUP_SEQUENCE_BASE);
  });
});

describe("the tool schemas convert through the A3 JSON-schema path", () => {
  it("every planning tool produces a JSON Schema the provider can receive", () => {
    expect(PLANNING_TOOLS).toHaveLength(3);
    for (const tool of PLANNING_TOOLS) {
      const converted = toolJsonSchema(
        tool.input as Parameters<typeof toolJsonSchema>[0],
      );
      expect(converted).toBeDefined();
      expect(typeof converted).toBe("object");
    }
  });

  it("the schemas round-trip wire arguments (the decode authority)", () => {
    const upsert = Schema.decodeUnknownSync(UpsertFindingArgs)({
      intent: "record",
      semanticKey: "termin_dostawy",
      scopeKind: "company",
      projectId: null,
      value: { _tag: "text_note", text: "dowóz potwierdzony" },
      quotes: ["dowóz potwierdzony"],
      replacesFindingId: null,
      derivesFromFindingIds: [],
      readConfidence: 0.5,
    });
    expect(upsert.intent).toBe("record");
    const identify = Schema.decodeUnknownSync(IdentifyProjectArgs)({
      projectId: null,
      displayName: "Banan 2",
    });
    expect(identify.displayName).toBe("Banan 2");
    const clarify = Schema.decodeUnknownSync(AskClarificationArgs)({
      question: "Który termin obowiązuje?",
      quotes: ["w środę", "w piątek"],
      scopeKind: "company",
      projectId: null,
    });
    expect(clarify.quotes).toHaveLength(2);
  });

  it("rejects out-of-vocabulary and malformed argument shapes", () => {
    expect(() =>
      Schema.decodeUnknownSync(UpsertFindingArgs)({
        intent: "guess",
        semanticKey: "x",
        scopeKind: "firm",
        projectId: null,
        value: { _tag: "text_note", text: "x" },
        quotes: ["x"],
        replacesFindingId: null,
        derivesFromFindingIds: [],
        readConfidence: 0.5,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UpsertFindingArgs)({
        intent: "record",
        semanticKey: "x_y",
        scopeKind: "company",
        projectId: null,
        value: { _tag: "text_note", text: "x" },
        quotes: [],
        replacesFindingId: null,
        derivesFromFindingIds: [],
        readConfidence: 5,
      }),
    ).toThrow();
  });
});
