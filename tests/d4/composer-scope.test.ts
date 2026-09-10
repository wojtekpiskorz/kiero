/**
 * D4 focused tests: the ONE fresh-draft scope seeding rule (review
 * round 1's state-model fix).
 *
 * The project pill renders the draft record's stored scope (there is no
 * second React state to drift), so the only way scope enters a draft is
 * `scopedFreshDraft`: the conversation route's ?projekt= param, read at
 * draft creation. The four creation sites (first open, post-send cleanup,
 * sent-crash cleanup, explicit discard) share this one function, so none
 * of them can seed scope oppositely again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedFreshDraft } from "../../apps/web/src/features/capture/use-capture-composer";
import { PROJECT_PARAM } from "../../apps/web/src/features/company/route-params";

const stubRoute = (search: string): void => {
  vi.stubGlobal("window", { location: { search } });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scopedFreshDraft (the one scope seeding rule)", () => {
  it("seeds Auto (null scope) on plain /wpis", () => {
    stubRoute("");
    const draft = scopedFreshDraft("user-1", 1_000);
    expect(draft.scopeProjectId).toBeNull();
    expect(draft.userId).toBe("user-1");
    expect(draft.createdAtMs).toBe(1_000);
    expect(draft.phase).toBe("composing");
    // The stable identity shape: prepare draftId AND idempotency key.
    expect(draft.draftId).toMatch(/^idem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("seeds the ?projekt= param as the stored scope (a project view retains its project)", () => {
    stubRoute(`?${PROJECT_PARAM}=k57projects0000000000000000a`);
    expect(scopedFreshDraft("user-1", Date.now()).scopeProjectId).toBe(
      "k57projects0000000000000000a",
    );
  });

  it("treats an empty ?projekt= value as Auto (null, never an empty string)", () => {
    stubRoute(`?${PROJECT_PARAM}=`);
    expect(scopedFreshDraft("user-1", Date.now()).scopeProjectId).toBeNull();
  });

  it("mints a fresh stable id per draft (a new logical message, not a reused key)", () => {
    stubRoute("");
    const first = scopedFreshDraft("user-1", 1_000);
    const second = scopedFreshDraft("user-1", 1_001);
    expect(first.draftId).not.toBe(second.draftId);
  });
});
