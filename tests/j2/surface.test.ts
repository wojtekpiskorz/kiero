/**
 * J2 focused tests, surface half: the joined conversation mount (all
 * capture modes through D4's composer, the agent-answer flow's wire
 * contract and Polish labels) and the honest voice-only material rule at
 * both ends (the D1 pure decision and the composer copy).
 *
 * The live halves (the joined app against the real dev/j2 deployment,
 * real Chromium, real provider answers) run in e2e/core-flow/live-proof.mjs
 * and are transcribed into docs/evidence/core-flow/.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { validateSourceMaterial, MAX_AUTHOR_TEXT_LENGTH } from "../../convex/sources/accept/acceptance";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { resolveFeatureScreen } from "../../apps/web/src/app/feature-pending";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";
import {
  AnswerRefusalWire,
  AnswerResultWire,
  AnswerRunWire,
  answerBasisLabel,
  answerOutcomeLabel,
  conversationCopy,
} from "../../apps/web/src/features/conversation/state";
import { captureCopy } from "../../apps/web/src/features/capture/state";
import { nextPrefillApplication } from "../../apps/web/src/features/capture/CaptureFeature";

// ---------------------------------------------------------------------------
// The joined mount
// ---------------------------------------------------------------------------

describe("the joined conversation mount (J2's fold of all capture modes)", () => {
  it("keeps the conversation the default route with the composer's send operations", () => {
    const conversation = appFeatures[0];
    expect(conversation?.featureId).toBe("conversation.company");
    expect(conversation?.routePath).toBe("/");
    expect(conversation?.implementation).toBe("mounted");
    expect([...(conversation?.consumedOperations ?? [])].sort()).toEqual([
      "attention.markSourceRead",
      "sources.acceptSource",
      "sources.prepareUpload",
    ]);
  });

  it("retires the separate capture nav entry: no 'Nowy wpis' route composes", () => {
    expect(appFeatures.some((entry) => entry.navLabel === "Nowy wpis")).toBe(false);
    expect(appFeatures.some((entry) => entry.routePath === "/wpis")).toBe(false);
  });

  it("renders the honest disconnected state through the host screen dispatch", () => {
    const conversation = appFeatures[0];
    if (conversation === undefined || conversation.implementation !== "mounted") {
      throw new Error("conversation entry missing or not mounted");
    }
    const html = renderToString(
      createElement(AppServicesProvider, {
        services: { config: loadAppConfig({}) },
        children: createElement(resolveFeatureScreen(conversation)),
      }),
    );
    expect(html).toContain("Rozmowa firmy");
    expect(html).toContain("VITE_CONVEX_URL");
    // No faked entries: the disconnected gate shows no conversation rows.
    expect(html).not.toContain("<li>");
  });

  it("keeps the J1 send-loop vocabulary honest for the joined composer", () => {
    // The conversation entry no longer renders its own send form, but the
    // state copy the composer re-uses (justSentNotice) stays exhaustive
    // over D1's derived states, pinned separately in tests/j1.
    expect(conversationCopy.answerRefused.length).toBeGreaterThan(0);
    expect(conversationCopy.answerUnavailable.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The voice-only material rule (the J2 contract decision, both ends)
// ---------------------------------------------------------------------------

describe("the source material rule (words OR retained media)", () => {
  it("refuses an empty text with no attachments, exactly as before", () => {
    expect(validateSourceMaterial("   \n\t ", false)).toEqual({
      ok: false,
      code: "author_text_empty",
    });
  });

  it("accepts an empty text when retained media exists (voice-only/photo-only)", () => {
    expect(validateSourceMaterial("", true)).toEqual({ ok: true, value: "" });
    expect(validateSourceMaterial("   ", true)).toEqual({ ok: true, value: "   " });
  });

  it("keeps the length cap regardless of attachments", () => {
    const tooLong = "a".repeat(MAX_AUTHOR_TEXT_LENGTH + 1);
    expect(validateSourceMaterial(tooLong, true)).toEqual({
      ok: false,
      code: "author_text_too_long",
    });
    expect(validateSourceMaterial(tooLong, false)).toEqual({
      ok: false,
      code: "author_text_too_long",
    });
  });

  it("keeps the text-only refusal identical through the one material rule (tests/d1 authority)", () => {
    // `validateSourceMaterial(text, false)` IS the old text-only rule
    // (D1's pinned decision, now the one author-text rule in production).
    expect(validateSourceMaterial("Dowóz płytek w czwartek", false)).toEqual({
      ok: true,
      value: "Dowóz płytek w czwartek",
    });
    expect(validateSourceMaterial("  ", false)).toEqual({ ok: false, code: "author_text_empty" });
  });

  it("renders the honest composer note: text is one channel, not a requirement", () => {
    expect(captureCopy.textOptionalNote).toContain("nagranie albo zdjęcia");
    // The old required-note is gone; the refusal copy stays load-bearing.
    expect(captureCopy.textOptionalNote).not.toContain("wymaga");
  });
});

// ---------------------------------------------------------------------------
// The correction prefill's once-per-REQUEST rule (the repeat click)
// ---------------------------------------------------------------------------

describe("the correction prefill decision (Korekta repeat on the same message)", () => {
  it("applies the request once, then re-renders of the same prefill never rewrite", () => {
    // First request: lands.
    expect(nextPrefillApplication(null, "Poprawka do wiadomości…")).toEqual({
      lastApplied: "Poprawka do wiadomości…",
      apply: "Poprawka do wiadomości…",
    });
    // The parent drops the request to null (applied or cancelled): the
    // memory clears, so the composer's text stays the boss's own.
    expect(nextPrefillApplication("Poprawka do wiadomości…", null)).toEqual({
      lastApplied: null,
      apply: null,
    });
  });

  it("lands a byte-identical repeat request (second Korekta click on the same message)", () => {
    // The exact effect-run sequence of the repeat: request, drop to null
    // (applied or cancelled), then the SAME regenerated prefill arrives
    // again. A value-only dedup swallows it; the null reset makes it land.
    let lastApplied: string | null = null;
    const first = nextPrefillApplication(lastApplied, "Poprawka: ta sama treść");
    lastApplied = first.lastApplied;
    const dropped = nextPrefillApplication(lastApplied, null);
    lastApplied = dropped.lastApplied;
    const repeat = nextPrefillApplication(lastApplied, "Poprawka: ta sama treść");
    expect(repeat.apply).toBe("Poprawka: ta sama treść");
  });

  it("never rewrites an applied prefill that is still outstanding", () => {
    // The request has not been dropped yet (still non-null): identical
    // re-renders must not rewrite text the boss may already have edited.
    expect(nextPrefillApplication("Poprawka: ta sama treść", "Poprawka: ta sama treść")).toEqual({
      lastApplied: "Poprawka: ta sama treść",
      apply: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The agent-answer payload (E6's AnswerRunResult rendered by the join)
// ---------------------------------------------------------------------------

describe("the answer wire contract and its Polish labels", () => {
  const answeredRun = {
    outcome: "answered",
    versions: { pipeline: "e6.answer/2", tools: "t", prompt: "p", schema: "s", modelConfiguration: "m" },
    answer: {
      answerText: "Zaliczka wynosi 5000 PLN, podatek nieokreślony.",
      statements: [
        {
          text: "Zaliczka wynosi 5000 PLN.",
          basis: "direct",
          evidenceIds: ["ev1"],
          derivedFromFindingIds: [],
        },
      ],
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    },
    clarificationsRaised: [],
    changes: [
      { kind: "task", operation: "work.changeTask", entityId: "tasks_x", revision: 1 },
    ],
    evidence: [
      {
        evidenceId: "ev1",
        sourceId: "sources_y",
        sourceSentAtMs: 1,
        fragmentId: null,
        quote: "zaliczka 5000",
        startOffset: null,
        endOffset: null,
        groundsFindingId: null,
        groundsUpdating: false,
      },
    ],
    turns: 3,
    refreshes: 0,
    observedModels: ["glm-5.3-flash"],
    finalText: "done",
  };

  it("decodes a representative answered run at the boundary", () => {
    const decoded = Schema.decodeUnknownSync(AnswerRunWire)(answeredRun);
    expect(decoded.outcome).toBe("answered");
    expect(decoded.answer?.statements[0]?.basis).toBe("direct");
    expect(decoded.evidence[0]?.quote).toBe("zaliczka 5000");
  });

  it("decodes a clarified run and refuses a malformed one", () => {
    const clarified = {
      ...answeredRun,
      outcome: "clarified",
      answer: null,
      clarificationsRaised: [{ clarificationId: "clar_1", question: "Środa czy piątek?" }],
    };
    const decoded = Schema.decodeUnknownSync(AnswerRunWire)(clarified);
    expect(decoded.clarificationsRaised[0]?.question).toBe("Środa czy piątek?");
    expect(() =>
      Schema.decodeUnknownSync(AnswerRunWire)({ outcome: "guessed" }),
    ).toThrow();
  });

  it("labels outcomes with the glossary's exact terms", () => {
    expect(answerOutcomeLabel(Schema.decodeUnknownSync(AnswerRunWire)(answeredRun))).toBe(
      "Odpowiedź agenta",
    );
    const clarified = Schema.decodeUnknownSync(AnswerRunWire)({
      ...answeredRun,
      outcome: "clarified",
      answer: null,
    });
    expect(answerOutcomeLabel(clarified)).toBe("Sprawa do wyjaśnienia");
  });

  it("renders honest failure notices for gave_up and provider_failed", () => {
    const gaveUp = Schema.decodeUnknownSync(AnswerRunWire)({
      ...answeredRun,
      outcome: "gave_up",
      answer: null,
    });
    expect(answerOutcomeLabel(gaveUp)).toContain("Agent nie udzielił odpowiedzi");
    const providerFailed = Schema.decodeUnknownSync(AnswerRunWire)({
      ...answeredRun,
      outcome: "provider_failed",
      answer: null,
      failure: "route_exhausted",
    });
    expect(answerOutcomeLabel(providerFailed)).toContain("route_exhausted");
  });

  it("marks a Wniosek agenta as an inference, never as an ustalenie", () => {
    expect(answerBasisLabel("inference")).toBe("wniosek agenta");
    expect(answerBasisLabel("direct")).toBe("bezpośrednio w źródle");
    expect(answerBasisLabel("corroboration")).toBe("potwierdzone niezależnie");
  });

  it("decodes the honest pre-loop refusals through the SAME boundary union", () => {
    // askAgent's answer | refusal comes back as one shape family: the
    // boundary decodes ONCE through AnswerResultWire and narrows by
    // schema, never by a hand-rolled "outcome" in raw data.
    const refusal = Schema.decodeUnknownSync(AnswerResultWire)({ outcome: "missing" });
    expect(Schema.is(AnswerRefusalWire)(refusal)).toBe(true);
    expect(refusal).toMatchObject({ outcome: "missing" });
    const run = Schema.decodeUnknownSync(AnswerResultWire)(answeredRun);
    expect(Schema.is(AnswerRefusalWire)(run)).toBe(false);
    // Wire drift (an unknown outcome string) fails the decode instead of
    // rendering a guess.
    expect(() => Schema.decodeUnknownSync(AnswerResultWire)({ outcome: "guessed" })).toThrow();
  });
});
