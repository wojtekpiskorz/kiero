/**
 * G5 focused verification, part 1: the certified `calendar.setSelection`
 * contract entry (issue #107's minimal certificate amendment: G2's report
 * flagged the write as the named prerequisite, G4 proved the honest
 * `unsupported` refusal live, G5 lands the entry in the contracts file).
 *
 * What MUST hold structurally: the entry exists with the flat
 * { mode, projectIds? } shape G4's recorded dispatch used, over the SAME
 * vocabulary the calendarSyncState column stores; the empty explicit list
 * is representable (the honest opt-out); malformed selections (an explicit
 * mode without the list, unknown modes, non-list ids) fail decode BEFORE
 * any handler runs; the result is the effective selection with null ids
 * only on the all-projects mode.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { calendarOperations } from "@kiero/contracts";

const entry = calendarOperations["calendar.setSelection"];

describe("the certified calendar.setSelection entry", () => {
  it("exists as an operation with the sibling write's error vocabulary", () => {
    expect(entry.kind).toBe("operation");
    expect(entry.name).toBe("calendar.setSelection");
    expect(entry.errorKinds).toEqual(["forbidden", "validation", "not_found"]);
  });

  it("decodes all_projects without ids and explicit with a project id list", () => {
    expect(Schema.decodeUnknownSync(entry.input)({ mode: "all_projects" })).toEqual({
      mode: "all_projects",
    });
    expect(
      Schema.decodeUnknownSync(entry.input)({ mode: "explicit", projectIds: ["p1", "p2"] }),
    ).toEqual({ mode: "explicit", projectIds: ["p1", "p2"] });
    // The empty explicit list is representable: the honest opt-out that
    // projects nothing (every subject falls out_of_personal_scope).
    expect(Schema.decodeUnknownSync(entry.input)({ mode: "explicit", projectIds: [] })).toEqual({
      mode: "explicit",
      projectIds: [],
    });
  });

  it("rejects malformed selections before any handler could run", () => {
    expect(() => Schema.decodeUnknownSync(entry.input)({ mode: "explicit" })).toThrow();
    expect(() => Schema.decodeUnknownSync(entry.input)({ mode: "everything" })).toThrow();
    expect(() => Schema.decodeUnknownSync(entry.input)({ mode: "explicit", projectIds: "p1" })).toThrow();
    expect(() => Schema.decodeUnknownSync(entry.input)({})).toThrow();
  });

  it("results in the effective selection (the stored column's mirror)", () => {
    expect(
      Schema.decodeUnknownSync(entry.result)({ mode: "all_projects", projectIds: null }),
    ).toEqual({ mode: "all_projects", projectIds: null });
    expect(Schema.decodeUnknownSync(entry.result)({ mode: "explicit", projectIds: [] })).toEqual({
      mode: "explicit",
      projectIds: [],
    });
    expect(() => Schema.decodeUnknownSync(entry.result)({ mode: "everything" })).toThrow();
    expect(() => Schema.decodeUnknownSync(entry.result)({ mode: "explicit" })).toThrow();
  });
});
