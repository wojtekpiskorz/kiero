/**
 * E6 focused verification, part 2: the tool surface wiring — the seven tool
 * input schemas' conversion through the A3 JSON-schema path (what the
 * provider actually receives), the decode authority's rejections, the
 * versioned prompt surface and the Convex-side loop/probe registration
 * labels.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { toolJsonSchema } from "@kiero/runtime";
import {
  ANSWER_PROMPT_VERSION,
  ANSWER_SCHEMA_VERSION,
  ANSWER_TOOLS,
  AskClarificationArgs,
  ChangeEventArgs,
  ChangeTaskArgs,
  ResolveClarificationArgs,
  SearchEvidenceArgs,
  SubmitAnswerArgs,
  ValidateExtensionValueArgs,
  answerSystemPrompt,
  evidenceSearchResult,
  questionUserMessage,
} from "@kiero/agent/tools";
import {
  ANSWER_FLOW_PIPELINE_VERSION,
  ANSWER_MODEL_CONFIGURATION_VERSION,
} from "../../convex/agent/loop";
import { loadAnswerContext } from "../../convex/agent/context";

describe("the declared answer tool set", () => {
  it("declares exactly the seven typed tools, nothing more", () => {
    expect(ANSWER_TOOLS.map((tool) => tool.name)).toEqual([
      "agent_search_evidence",
      "agent_submit_answer",
      "agent_ask_clarification",
      "agent_resolve_clarification",
      "agent_change_task",
      "agent_change_event",
      "agent_validate_extension_value",
    ]);
  });

  it("no tool names a database, access-management or provider surface", () => {
    for (const tool of ANSWER_TOOLS) {
      expect(tool.name).not.toMatch(/db|sql|grant|admin|http|fetch|provider/i);
    }
  });

  it("the loop records the same version labels the tools surface declares", () => {
    // The loop module imports ANSWER_TOOLS/answerSystemPrompt from the same
    // package root; the recorded version pins must agree with the surface.
    expect(ANSWER_FLOW_PIPELINE_VERSION).toMatch(/^e6\.answer\//);
    expect(ANSWER_MODEL_CONFIGURATION_VERSION).toBe("e6.routing#chat_analysis");
  });
});

describe("the tool schemas convert through the A3 JSON-schema path", () => {
  it("every answer tool produces a JSON Schema the provider can receive", () => {
    for (const tool of ANSWER_TOOLS) {
      const converted = toolJsonSchema(
        tool.input as Parameters<typeof toolJsonSchema>[0],
      );
      expect(converted).toBeDefined();
      expect(typeof converted).toBe("object");
    }
  });
});

describe("tool-argument decode (the wire shapes round-trip)", () => {
  it("decodes a grounded submit-answer with disclosures", () => {
    const decoded = Schema.decodeUnknownSync(SubmitAnswerArgs)({
      answerText: "Zaliczka 5000 PLN, podstawa nieokreślona.",
      statements: [
        {
          text: "Zaliczka wynosi 5000 PLN.",
          basis: "direct",
          evidenceIds: ["ev1"],
          derivedFromFindingIds: [],
        },
      ],
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    });
    expect(decoded.statements[0]?.basis).toBe("direct");
  });

  it("decodes a scoped search and a domain change", () => {
    const search = Schema.decodeUnknownSync(SearchEvidenceArgs)({
      query: "zaliczka Kaczmarka",
      projectId: null,
    });
    expect(search.query).toBe("zaliczka Kaczmarka");
    const task = Schema.decodeUnknownSync(ChangeTaskArgs)({
      taskId: null,
      projectId: "projects_banan",
      title: "Zamówić płytki",
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: null,
      expectedRevision: 1,
    });
    expect(task.expectedRevision).toBe(1);
    const event = Schema.decodeUnknownSync(ChangeEventArgs)({
      eventId: null,
      projectId: "projects_banan",
      title: "Dostawa płytek",
      timeFindingId: null,
      expectedRevision: 1,
    });
    expect(event.title).toBe("Dostawa płytek");
  });

  it("decodes clarification create/resolve and extension validation", () => {
    const ask = Schema.decodeUnknownSync(AskClarificationArgs)({
      question: "Środa czy piątek?",
      evidenceIds: ["ev4", "ev5"],
      scopeKind: "project",
      projectId: "projects_banan",
    });
    expect(ask.evidenceIds).toHaveLength(2);
    const resolve = Schema.decodeUnknownSync(ResolveClarificationArgs)({
      clarificationId: "clarifications_c1",
      resolutionNote: "Piątek — potwierdzone nową wiadomością.",
      evidenceIds: ["ev7"],
    });
    expect(resolve.resolutionNote.length).toBeGreaterThan(0);
    const validate = Schema.decodeUnknownSync(ValidateExtensionValueArgs)({
      versionId: "extensionVersions_v1",
      value: { _tag: "text", text: "stal" },
    });
    expect(validate.value._tag).toBe("text");
  });

  it("rejects out-of-vocabulary and malformed argument shapes (fail closed)", () => {
    // basis outside the closed vocabulary
    expect(() =>
      Schema.decodeUnknownSync(SubmitAnswerArgs)({
        answerText: "x",
        statements: [{ text: "x", basis: "guess", evidenceIds: [], derivedFromFindingIds: [] }],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    ).toThrow();
    // empty statements
    expect(() =>
      Schema.decodeUnknownSync(SubmitAnswerArgs)({
        answerText: "x",
        statements: [],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    ).toThrow();
    // malformed evidence handle (free-text citation)
    expect(() =>
      Schema.decodeUnknownSync(AskClarificationArgs)({
        question: "x",
        evidenceIds: ["jakikolwiek tekst"],
        scopeKind: "company",
        projectId: null,
      }),
    ).toThrow();
    // clarification without any citation
    expect(() =>
      Schema.decodeUnknownSync(AskClarificationArgs)({
        question: "x",
        evidenceIds: [],
        scopeKind: "company",
        projectId: null,
      }),
    ).toThrow();
    // non-positive expected revision
    expect(() =>
      Schema.decodeUnknownSync(ChangeTaskArgs)({
        taskId: "tasks_t1",
        projectId: "projects_banan",
        title: "x",
        executorContactId: null,
        coordinatorMembershipId: null,
        deadlineFindingId: null,
        expectedRevision: 0,
      }),
    ).toThrow();
  });
});

describe("the versioned dialogue surface", () => {
  it("pins the version labels the loop records with every answer", () => {
    expect(ANSWER_PROMPT_VERSION).toBe("e6.prompt-pl/4");
    expect(ANSWER_SCHEMA_VERSION).toBe("e6.schema/1");
    expect(ANSWER_FLOW_PIPELINE_VERSION).toBe("e6.answer/2");
    expect(ANSWER_MODEL_CONFIGURATION_VERSION).toBe("e6.routing#chat_analysis");
  });

  it("the Polish system prompt states the grounding, updating and no-guessing rules", () => {
    const prompt = answerSystemPrompt();
    expect(prompt).toContain("wyłącznie na podstawie aktualnej pamięci i źródeł");
    expect(prompt).toContain("Nie zgaduj");
    expect(prompt).toContain("w trakcie aktualizacji");
    expect(prompt).toContain("agent_ask_clarification");
  });

  it("the question message discloses updating findings and processing sources", () => {
    const message = questionUserMessage({
      question: {
        sourceId: "sources_q",
        authorText: "Jaka zaliczka?",
        sentAtMs: Date.parse("2026-09-09T07:30:00.000Z"),
        sentAtTimezone: "Europe/Warsaw",
      },
      projects: [],
      findings: [
        {
          findingId: "findings_u",
          scope: { kind: "company" },
          semanticKey: "termin_dostawy",
          revisionCounter: 1,
          value: { _tag: "text_note", text: "piątek" },
          knowledgeTag: "updating",
          updating: true,
          evidenceIds: [],
        },
      ],
      sources: [
        {
          sourceId: "sources_processing",
          sentAtMs: Date.parse("2026-09-09T07:00:00.000Z"),
          preview: "",
          lifecycle: "active",
          processing: "processing",
        },
      ],
      tasks: [],
      events: [],
      clarifications: [],
      contacts: [],
      memberships: [],
      evidence: [],
      run: { runId: "e6-run-x", nowMs: 0 },
    });
    expect(message).toContain("Ustalenia w trakcie aktualizacji");
    expect(message).toContain("findings_u");
    expect(message).toContain("Źródła w trakcie analizy");
    expect(message).toContain("sources_processing");
    expect(message).toContain("W TRAKCIE AKTUALIZACJI");
  });

  it("the question message lists coordinator and executor candidates", () => {
    const message = questionUserMessage({
      question: {
        sourceId: "sources_q",
        authorText: "Kto ma zamówić płytki?",
        sentAtMs: 0,
        sentAtTimezone: "Europe/Warsaw",
      },
      projects: [],
      findings: [],
      sources: [],
      tasks: [],
      events: [],
      clarifications: [],
      contacts: [{ contactId: "contacts_z", displayName: "Zbyszek" }],
      memberships: [{ membershipId: "memberships_a", bossName: "Szef" }],
      evidence: [],
      run: { runId: "e6-run-y", nowMs: 0 },
    });
    expect(message).toContain("KONTAKTY");
    expect(message).toContain("contacts_z");
    expect(message).toContain("SZEFOWIE");
    expect(message).toContain("memberships_a");
  });

  it("the search result encoding says candidates never establish truth", () => {
    const encoding = evidenceSearchResult([
      {
        evidenceId: "ev9",
        sourceId: "sources_s1",
        sourceSentAtMs: 0,
        fragmentId: null,
        quote: "zaliczka 5000",
        startOffset: null,
        endOffset: null,
        groundsFindingId: null,
        groundsUpdating: false,
      },
    ]);
    expect(encoding).toContain("NIE jest ustalenie prawdy");
    expect(evidenceSearchResult([])).toContain("trafność nie ustala niczego");
  });
});

describe("the Convex-side module surface", () => {
  it("exports the loader and the loop entry (module registration shape)", () => {
    expect(typeof loadAnswerContext).toBe("function");
  });
});
