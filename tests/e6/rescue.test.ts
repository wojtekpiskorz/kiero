/**
 * E6 focused verification, part 3: the text-encoded tool-call rescue
 * (packages/agent/tools/rescue.ts), one of the two inherited-defect
 * fixes the PR pins deterministically.
 *
 * The rescue must decode a flash model's prose-encoded
 * `{"narzedzie":...,"argumenty":...}` through the DECLARED tool's
 * schema and nothing else: undeclared names, malformed JSON and
 * undecodable arguments stay plain text (fail closed; the tool surface
 * never widens).
 */

import { describe, expect, it } from "vitest";
import { parseTextToolCalls } from "@kiero/agent/tools";

describe("parseTextToolCalls", () => {
  it("rescues a prose-encoded tool call through the declared schema", () => {
    const text = [
      "Sprawdzę źródła: ",
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"zaliczka Kaczmarek","projectId":null}}',
      " i tyle.",
    ].join("");
    const calls = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("agent_search_evidence");
    expect(calls[0]?.arguments).toEqual({
      query: "zaliczka Kaczmarek",
      projectId: null,
    });
  });

  it("rescues multiple encoded calls with stable generated ids", () => {
    const text = [
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"zaliczka","projectId":null}}',
      " a potem ",
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"dostawa płytek","projectId":null}}',
    ].join("");
    const calls = parseTextToolCalls(text);
    expect(calls.map((call) => call.id)).toEqual(["text-0", "text-1"]);
    expect(calls.map((call) => call.name)).toEqual([
      "agent_search_evidence",
      "agent_search_evidence",
    ]);
  });

  it("matches nested braces of a structured answer body", () => {
    const text = [
      "Odpowiadam: ",
      '{"narzedzie":"agent_submit_answer","argumenty":{"answerText":"Tak.","statements":[{"text":"Kaczmarek wpłacił zaliczkę.","basis":"direct","evidenceIds":["ev1"],"derivedFromFindingIds":[]}],"disclosures":{"updatingFindingIds":[],"processingSourceIds":[]}}}',
      " koniec.",
    ].join("");
    const calls = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({
      answerText: "Tak.",
      statements: [
        {
          text: "Kaczmarek wpłacił zaliczkę.",
          basis: "direct",
          evidenceIds: ["ev1"],
          derivedFromFindingIds: [],
        },
      ],
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    });
  });

  it("does not let escaped quotes or in-string braces break the walk", () => {
    const text = String.raw`{"narzedzie":"agent_ask_clarification","argumenty":{"question":"Co znaczy \"}\" w zapisie?","evidenceIds":["ev1","ev2"],"scopeKind":"company","projectId":null}}`;
    const calls = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("agent_ask_clarification");
    expect(calls[0]?.arguments).toEqual({
      question: 'Co znaczy "}" w zapisie?',
      evidenceIds: ["ev1", "ev2"],
      scopeKind: "company",
      projectId: null,
    });
  });

  it("keeps an undeclared tool name as plain text (the surface never widens)", () => {
    const text =
      '{"narzedzie":"db_raw_insert","argumenty":{"table":"users","rows":[]}}';
    expect(parseTextToolCalls(text)).toHaveLength(0);
  });

  it("keeps malformed JSON as plain text", () => {
    const truncated =
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"zaliczka"';
    expect(parseTextToolCalls(truncated)).toHaveLength(0);
  });

  it("keeps arguments that fail the declared schema as plain text (fail closed)", () => {
    // query shorter than the schema minimum of 2 characters
    const tooShortQuery =
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"x","projectId":null}}';
    expect(parseTextToolCalls(tooShortQuery)).toHaveLength(0);
    // a required field missing entirely
    const missingFields =
      '{"narzedzie":"agent_ask_clarification","argumenty":{"question":"??"}}';
    expect(parseTextToolCalls(missingFields)).toHaveLength(0);
  });

  it("skips a marker with no opening brace and still rescues the next object", () => {
    const text = [
      'Mówił o "narzedzie" jako o polu. Potem ',
      '{"narzedzie":"agent_search_evidence","argumenty":{"query":"zaliczka","projectId":null}}',
    ].join("");
    const calls = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({ query: "zaliczka", projectId: null });
  });
});
