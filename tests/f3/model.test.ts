/**
 * F3 model tests: the pure payload-composition and leg-settlement rules
 * (issue 43's focused verification), Polish copy included - the preview
 * matrix (project or Firma, author, fragment, Głosówka/photo counts,
 * hide-preview), the once-per-device idempotency decisions and the
 * outcome vocabulary mapping.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_LEG_ATTEMPTS,
  composePushPayload,
  fragmentOf,
  legMayRetry,
  scopeNameOf,
  settleLegOutcome,
  sourcePreviewLine,
  ttlSecondsOf,
  type ClarificationPreview,
  type DeliveredSummary,
  type ScopeView,
  type SourcePreview,
} from "../../convex/attention/push/model";

const T0 = Date.parse("2026-09-09T10:00:00.000Z");

const companySummary: DeliveredSummary = {
  semanticKind: "source_entry",
  bucket: "company",
  scope: { kind: "company", projectIds: [] },
  sourceIds: ["k1111111111111111111111"],
  clarificationIds: [],
  deliveredAtMs: T0,
};

const companyScope: ScopeView = { kind: "company", projectNames: [] };

function source(overrides: Partial<SourcePreview> = {}): SourcePreview {
  return {
    sourceId: "k1111111111111111111111",
    authorName: "Anna",
    authorText: "Klient potwierdził termin na piątek.",
    audioCount: 0,
    photoCount: 0,
    stillActive: true,
    ...overrides,
  };
}

describe("the preview matrix", () => {
  it("carries Firma, author and fragment for a company entry", () => {
    const payload = composePushPayload({
      summary: companySummary,
      scope: companyScope,
      sources: [source()],
      clarifications: [],
      hidePreview: false,
    });
    expect(payload.title).toBe("Nowy wpis: Firma");
    expect(payload.body).toBe("Anna: Klient potwierdził termin na piątek.");
    expect(payload.data.sourceIds).toEqual(["k1111111111111111111111"]);
  });

  it("carries the project name for a project conversation", () => {
    const payload = composePushPayload({
      summary: { ...companySummary, scope: { kind: "project", projectIds: ["p1", "p2"] }, bucket: "project:p1|p2" },
      scope: { kind: "project", projectNames: ["Banan", "Kaczmarek"] },
      sources: [source()],
      clarifications: [],
      hidePreview: false,
    });
    expect(payload.title).toBe("Nowy wpis: Banan, Kaczmarek");
  });

  it("shows the Głosówka and photo counts when there is no text", () => {
    const line = sourcePreviewLine(source({ authorText: "", audioCount: 1, photoCount: 3 }));
    expect(line).toBe("Anna: Głosówka i Zdjęcia: 3");
    expect(
      sourcePreviewLine(source({ authorText: "", audioCount: 0, photoCount: 1 })),
    ).toBe("Anna: Zdjęcie");
  });

  it("bounds and collapses the fragment", () => {
    const long = "słowo ".repeat(60);
    expect(fragmentOf(long).length).toBeLessThanOrEqual(121);
    expect(fragmentOf("  wiele     spacji  ")).toBe("wiele spacji");
  });

  it("collapses a multi-entry batch into ONE notification", () => {
    const payload = composePushPayload({
      summary: {
        ...companySummary,
        sourceIds: ["k1111111111111111111111", "k2222222222222222222222"],
      },
      scope: companyScope,
      sources: [
        source(),
        source({ sourceId: "k2222222222222222222222", authorName: "Bogdan", authorText: "Inna sprawa" }),
      ],
      clarifications: [],
      hidePreview: false,
    });
    expect(payload.title).toBe("Nowe wpisy (2): Firma");
    expect(payload.body).toBe("2 nowych wpisów: Anna, Bogdan");
  });

  it("honors hide-preview with a neutral notice while keeping routing ids", () => {
    const payload = composePushPayload({
      summary: companySummary,
      scope: companyScope,
      sources: [source()],
      clarifications: [],
      hidePreview: true,
    });
    expect(payload.title).toBe("Nowe powiadomienie");
    expect(payload.body).toBe("Otwórz Kiero, żeby zobaczyć.");
    // Ids are routing hints, not content: they stay so the click resolves
    // current data; the preview content is gone.
    expect(payload.data.sourceIds).toEqual(["k1111111111111111111111"]);
  });

  it("drops withdrawn sources from the preview and goes neutral when all died", () => {
    const mixed = composePushPayload({
      summary: { ...companySummary, sourceIds: ["k1111111111111111111111", "k2222222222222222222222"] },
      scope: companyScope,
      sources: [source(), source({ sourceId: "k2222222222222222222222", stillActive: false })],
      clarifications: [],
      hidePreview: false,
    });
    expect(mixed.title).toBe("Nowy wpis: Firma");
    const allDead = composePushPayload({
      summary: companySummary,
      scope: companyScope,
      sources: [source({ stillActive: false })],
      clarifications: [],
      hidePreview: false,
    });
    expect(allDead.title).toBe("Nowe powiadomienie");
  });

  it("previews an open clarification with the agent-question shape", () => {
    const clarification: ClarificationPreview = {
      clarificationId: "k9999999999999999999999",
      question: "Który termin betonowania jest właściwy?",
      stillOpen: true,
    };
    const payload = composePushPayload({
      summary: {
        semanticKind: "clarification",
        bucket: "clarification:company",
        scope: { kind: "company", projectIds: [] },
        sourceIds: [],
        clarificationIds: [clarification.clarificationId],
        deliveredAtMs: T0,
      },
      scope: companyScope,
      sources: [],
      clarifications: [clarification],
      hidePreview: false,
    });
    expect(payload.title).toBe("Pytanie agenta: Firma");
    expect(payload.body).toBe("Który termin betonowania jest właściwy?");
    expect(payload.data.clarificationIds).toEqual([clarification.clarificationId]);
  });
});

describe("leg settlement", () => {
  const base = { deliveryId: "d1", subscriptionId: "s1" };

  it("maps every provider answer to the honest per-device state", () => {
    expect(settleLegOutcome({ ...base, report: { kind: "delivered" } })).toMatchObject({
      state: "delivered",
      attemptOutcome: "delivered",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ ...base, report: { kind: "gone" } })).toMatchObject({
      state: "failed",
      errorKind: "push_subscription_gone",
      revokeSubscription: true,
      attemptOutcome: "failed",
    });
    expect(settleLegOutcome({ ...base, report: { kind: "rejected" } })).toMatchObject({
      state: "failed",
      errorKind: "push_payload_rejected",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ ...base, report: { kind: "unauthorized" } })).toMatchObject({
      state: "failed",
      errorKind: "push_unauthorized",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ ...base, report: { kind: "retry_later" } })).toMatchObject({
      state: "pending",
      errorKind: "push_retry_later",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ ...base, report: { kind: "unknown", cause: "timeout" } })).toMatchObject({
      state: "unknown",
      errorKind: "push_timeout_after_send",
      attemptOutcome: "unknown",
    });
    expect(settleLegOutcome({ ...base, report: { kind: "unknown" } })).toMatchObject({
      state: "unknown",
      errorKind: "push_outcome_unknown",
    });
  });

  it("bounds retry_later legs and never retries uncertain ones", () => {
    expect(legMayRetry(0, { kind: "retry_later" })).toBe(true);
    expect(legMayRetry(MAX_LEG_ATTEMPTS - 1, { kind: "retry_later" })).toBe(true);
    expect(legMayRetry(MAX_LEG_ATTEMPTS, { kind: "retry_later" })).toBe(false);
    expect(legMayRetry(0, { kind: "unknown" })).toBe(false);
    expect(legMayRetry(0, { kind: "delivered" })).toBe(false);
  });
});

describe("helpers", () => {
  it("names the scope with Firma for the company bucket", () => {
    expect(scopeNameOf({ kind: "company", projectNames: [] })).toBe("Firma");
    expect(scopeNameOf({ kind: "company", projectNames: ["X"] })).toBe("Firma");
    expect(scopeNameOf({ kind: "project", projectNames: ["Banan"] })).toBe("Banan");
  });

  it("keeps a working-day TTL for every kind", () => {
    expect(ttlSecondsOf()).toBe(24 * 60 * 60);
  });
});
