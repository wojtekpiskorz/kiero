/**
 * F3 model tests: the pure payload-composition and leg-settlement rules
 * (issue 43's focused verification), Polish copy included - the preview
 * matrix (project or Firma, author, fragment, nagranie/photo counts,
 * hide-preview), the once-per-device idempotency decisions and the
 * outcome vocabulary mapping.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_LEG_ATTEMPTS,
  composePushPayload,
  fragmentOf,
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

  it("shows the nagranie and photo counts when there is no text (the glossary media names)", () => {
    const line = sourcePreviewLine(source({ authorText: "", audioCount: 1, photoCount: 3 }));
    expect(line).toBe("Anna: Nagranie i Zdjęcia: 3");
    expect(
      sourcePreviewLine(source({ authorText: "", audioCount: 2, photoCount: 0 })),
    ).toBe("Anna: Nagrania: 2");
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

  it("previews an open clarification with the glossary name (Sprawa do wyjaśnienia)", () => {
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
    expect(payload.title).toBe("Sprawa do wyjaśnienia: Firma");
    expect(payload.body).toBe("Który termin betonowania jest właściwy?");
    expect(payload.data.clarificationIds).toEqual([clarification.clarificationId]);
  });

  it("labels a task_reminder summary task_reminder in BOTH preview paths", () => {
    const taskSummary: DeliveredSummary = {
      semanticKind: "task_reminder",
      bucket: "task:k1111111111111111111111",
      scope: { kind: "company", projectIds: [] },
      sourceIds: ["k1111111111111111111111"],
      clarificationIds: [],
      deliveredAtMs: T0,
    };
    const visible = composePushPayload({
      summary: taskSummary,
      scope: companyScope,
      sources: [source()],
      clarifications: [],
      hidePreview: false,
    });
    const hidden = composePushPayload({
      summary: taskSummary,
      scope: companyScope,
      sources: [source()],
      clarifications: [],
      hidePreview: true,
    });
    // One kind value for both paths (the payload kind mirrors the
    // summary's semantic kind); the source-entry copy matrix is what F4
    // inherits and narrows.
    expect(visible.kind).toBe("task_reminder");
    expect(hidden.kind).toBe("task_reminder");
  });
});

describe("leg settlement", () => {
  it("maps every provider answer to the honest per-device state", () => {
    expect(settleLegOutcome({ kind: "delivered" }, 1)).toMatchObject({
      state: "delivered",
      attemptOutcome: "delivered",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ kind: "gone" }, 1)).toMatchObject({
      state: "failed",
      errorKind: "push_subscription_gone",
      revokeSubscription: true,
      attemptOutcome: "failed",
    });
    expect(settleLegOutcome({ kind: "rejected" }, 1)).toMatchObject({
      state: "failed",
      errorKind: "push_payload_rejected",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ kind: "unauthorized" }, 1)).toMatchObject({
      state: "failed",
      errorKind: "push_unauthorized",
      revokeSubscription: false,
    });
    expect(settleLegOutcome({ kind: "unknown", cause: "timeout" }, 1)).toMatchObject({
      state: "unknown",
      errorKind: "push_timeout_after_send",
      attemptOutcome: "unknown",
    });
    expect(settleLegOutcome({ kind: "unknown" }, 1)).toMatchObject({
      state: "unknown",
      errorKind: "push_outcome_unknown",
    });
  });

  it("keeps retry_later legs pending only while attempts remain, then exhausts them", () => {
    expect(settleLegOutcome({ kind: "retry_later" }, 1)).toMatchObject({
      state: "pending",
      errorKind: "push_retry_later",
      attemptOutcome: "failed",
    });
    expect(settleLegOutcome({ kind: "retry_later" }, MAX_LEG_ATTEMPTS - 1)).toMatchObject({
      state: "pending",
      errorKind: "push_retry_later",
    });
    expect(settleLegOutcome({ kind: "retry_later" }, MAX_LEG_ATTEMPTS)).toMatchObject({
      state: "failed",
      errorKind: "push_attempts_exhausted",
      attemptOutcome: "failed",
    });
    // Uncertain and terminal answers never retry, whatever the count.
    expect(settleLegOutcome({ kind: "unknown" }, MAX_LEG_ATTEMPTS).state).toBe("unknown");
    expect(settleLegOutcome({ kind: "delivered" }, MAX_LEG_ATTEMPTS).state).toBe("delivered");
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
