/**
 * D1 focused tests: conversation view rows and processing-state derivation.
 *
 * Both scopes decode through ONE row schema (the same source resolves
 * identically in the company and the project view), and the honest
 * processing state is derived from durable rows — never stored beside the
 * source, so it cannot drift.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ConversationPage,
  SourceConversationRow,
  deriveProcessingState,
} from "../../convex/sources/read/rows";

const rowFixture = {
  sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
  authorUserId: "j57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
  authorText: "Banan: klient potwierdza termin 12 września",
  sentAtMs: 1_757_411_700_000,
  sentAtTimezone: "Europe/Warsaw",
  fullyAcceptedAtMs: 1_757_411_705_000,
  lifecycle: "active",
  processingState: "processing",
  projectIds: ["q57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f"],
};

describe("SourceConversationRow (one schema for both scopes)", () => {
  it("decodes a valid conversation entry", () => {
    expect(Schema.decodeUnknownSync(SourceConversationRow)(rowFixture)).toEqual(rowFixture);
  });

  it("rejects a drifted lifecycle or processing state", () => {
    expect(() =>
      Schema.decodeUnknownSync(SourceConversationRow)({ ...rowFixture, lifecycle: "edited" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SourceConversationRow)({
        ...rowFixture,
        processingState: "maybe",
      }),
    ).toThrow();
  });

  it("rejects a row missing the send snapshot", () => {
    const { sentAtTimezone: _dropped, ...withoutZone } = rowFixture;
    expect(() => Schema.decodeUnknownSync(SourceConversationRow)(withoutZone)).toThrow();
  });

  it("decodes a page with the Convex pagination shape", () => {
    const page = {
      page: [rowFixture],
      isDone: false,
      continueCursor: "cursor-1",
    };
    expect(Schema.decodeUnknownSync(ConversationPage)(page)).toEqual(page);
  });
});

describe("deriveProcessingState (honest, derived from durable rows)", () => {
  it("maps every run state exactly once", () => {
    expect(deriveProcessingState(null)).toBe("accepted");
    expect(deriveProcessingState({ state: "running" })).toBe("processing");
    expect(deriveProcessingState({ state: "failed" })).toBe("failed");
    expect(deriveProcessingState({ state: "succeeded" })).toBe("processed");
    expect(deriveProcessingState({ state: "superseded" })).toBe("processed");
  });
});
