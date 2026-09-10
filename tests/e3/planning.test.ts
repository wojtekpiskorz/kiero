/**
 * E3 focused verification, part 1: the PURE planning decisions from
 * packages/agent/planning — the autonomous-versus-clarification contract
 * (issue #8), group bounding, stale-context refusal, decoded-not-executed
 * tool handling, pending-segment honesty, server-side temporal anchoring
 * and the money-basis guard.
 *
 * The transaction/deployment halves run against the leased dev deployment
 * (tests/e3/live-proof.mjs); what MUST hold structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ASK_CLARIFICATION_TOOL,
  AskClarificationArgs,
  IDENTIFY_PROJECT_TOOL,
  UPSERT_FINDING_TOOL,
  UpsertFindingArgs,
  applyDecodedCall,
  boundPublicationGroups,
  buildMoneyValue,
  buildTemporalValue,
  decideGroupPublish,
  decideRunCompleteness,
  emptyPlanningState,
  groupIsTextGrounded,
  isCompleteTranscript,
  locateQuote,
  sameScope,
  analysisSystemPrompt,
  sourceUserMessage,
  PLANNING_PROMPT_VERSION,
  PLANNING_SCHEMA_VERSION,
  TEXT_ANALYSIS_PIPELINE_VERSION,
  type AnalysisContext,
  type DecodedPlanningCall,
} from "@kiero/agent";
import { decidePublish } from "@kiero/domain";

// ---------------------------------------------------------------------------
// Fixtures: one Polish source, Wednesday plan, its context.
// ---------------------------------------------------------------------------

/** 2026-09-08 is a Tuesday; 18:30 Warsaw time (the C2 anchor fixture). */
const SENT_AT_MS = Date.parse("2026-09-08T16:30:00.000Z");
const TIMEZONE = "Europe/Warsaw";

const WEDNESDAY_TEXT = [
  "Dowóz płytek na Buniewice w środę rano.",
  "Klient Kaczmarek potwierdza odbiór.",
  "Wycena dla projektu Banan: około 10 tysięcy.",
].join(" ");

const FINDING_WEDNESDAY = {
  findingId: "findings_wednesday",
  scope: { kind: "project", projectId: "projects_banan" } as const,
  semanticKey: "termin_dostawy",
  revisionCounter: 1,
  value: { _tag: "temporal", temporal: { shape: { _tag: "day", day: "2026-09-09" } } },
  knowledgeState: { _tag: "known" },
  currentProvenanceSourceId: "sources_s1",
  currentProvenanceSourceSentAtMs: SENT_AT_MS,
};

function contextOf(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    source: {
      sourceId: "sources_s1",
      authorText: WEDNESDAY_TEXT,
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: TIMEZONE,
      lifecycle: "active",
      hintProjectIds: ["projects_banan"],
    },
    coverage: { extractedKinds: ["text"], pendingSegments: [] },
    projects: [
      { projectId: "projects_banan", displayName: "Banan", codename: "banan" },
      { projectId: "projects_kaczmarek", displayName: "Kaczmarek", codename: null },
    ],
    findings: [FINDING_WEDNESDAY],
    recentSources: [],
    run: { runId: "runs_r1", kind: "initial_analysis", reanalysisOfRunId: null },
    ...overrides,
  };
}

/** Decodes raw tool-argument JSON the way E2's adapter does (decode proof). */
function decodedUpsert(raw: unknown): DecodedPlanningCall {
  const args = Schema.decodeUnknownSync(UpsertFindingArgs)(raw);
  return { id: "call_1", name: UPSERT_FINDING_TOOL, arguments: args };
}

const UPSERT_WEDNESDAY = {
  intent: "record",
  semanticKey: "termin_odbioru",
  scopeKind: "project",
  projectId: "projects_kaczmarek",
  value: {
    _tag: "temporal",
    temporal: {
      // Accusative "w środę" sits outside C2's bounded relative vocabulary,
      // so the honest proposal carries the explicit stated day; the server
      // cross-checks only vocabulary it can resolve itself.
      basis: { _tag: "day", day: "2026-09-09" },
      originalExpression: "w środę",
      role: "agreed",
    },
  },
  quotes: ["Kaczmarek potwierdza odbiór"],
  replacesFindingId: null,
  derivesFromFindingIds: [],
  readConfidence: 0.9,
};

// ---------------------------------------------------------------------------
// Decoded-not-executed tool handling.
// ---------------------------------------------------------------------------

describe("tool argument handling: decoded, validated, never executed", () => {
  it("rejects malformed arguments at the schema boundary (E2 fails closed before the reducer)", () => {
    expect(() =>
      Schema.decodeUnknownSync(UpsertFindingArgs)({
        intent: "record",
        semanticKey: "Not A Key",
        scopeKind: "company",
        projectId: null,
        value: { _tag: "text_note" },
        quotes: [],
        replacesFindingId: null,
        derivesFromFindingIds: [],
        readConfidence: 2,
      }),
    ).toThrow();
  });

  it("accumulates a decoded, grounded proposal without any write", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert(UPSERT_WEDNESDAY),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(1);
    expect(outcome.state.proposals[0]?.semanticKey).toBe("termin_odbioru");
    expect(outcome.state.proposals[0]?.evidence[0]?.startOffset).toBeGreaterThan(0);
    expect(outcome.toolResult).toContain("ZAPROPONOWANO");
  });

  it("refuses a proposal whose project is not in the tenant-filtered context", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({ ...UPSERT_WEDNESDAY, projectId: "projects_other_firm" }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("refuses a hallucinated quote: evidence must occur in the source", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({ ...UPSERT_WEDNESDAY, quotes: ["cytat, którego nie ma"] }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("refuses creating a second identity for a live finding (must address by id)", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        scopeKind: "project",
        projectId: "projects_banan",
        semanticKey: "termin_dostawy",
      }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("intent=correct");
  });

  it("refuses a correction that retargets another finding's meaning or scope", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        intent: "correct",
        semanticKey: "termin_dostawy",
        scopeKind: "project",
        projectId: "projects_banan",
        replacesFindingId: "findings_wednesday",
        quotes: ["w środę rano"],
      }),
      "PLN",
    );
    // semanticKey and scope match: this correction is legitimate.
    expect(outcome.state.proposals).toHaveLength(1);
    expect(outcome.state.proposals[0]?.intent).toBe("correct");
    const retargeted = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        intent: "correct",
        replacesFindingId: "findings_wednesday",
        quotes: ["w środę rano"],
      }),
      "PLN",
    );
    expect(retargeted.state.proposals).toHaveLength(0);
  });

  it("refuses a self-derivation and unknown derivation bases", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        derivesFromFindingIds: ["findings_unknown"],
      }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
  });

  it("refuses unknown tool names (defense in depth under E2's own guard)", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      { id: "c", name: "memory.drop_table", arguments: {} },
      "PLN",
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });
});

// ---------------------------------------------------------------------------
// The #8 contract: clear changes autonomous, ambiguity asks.
// ---------------------------------------------------------------------------

describe("autonomous versus clarification (issue #8)", () => {
  it("an explicit correction accumulates autonomously (no approval gate)", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({
        intent: "correct",
        semanticKey: "termin_dostawy",
        scopeKind: "project",
        projectId: "projects_banan",
        value: {
          _tag: "temporal",
          temporal: {
            basis: { _tag: "relative", expression: "w piątek" },
            originalExpression: "w piątek",
            role: "agreed",
          },
        },
        quotes: ["w środę rano"],
        replacesFindingId: "findings_wednesday",
        derivesFromFindingIds: [],
        readConfidence: 0.95,
      }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(1);
    // Friday (2026-09-11) resolved by the server, not the model.
    const value = outcome.state.proposals[0]?.valueWire as {
      temporal: { shape: { _tag: string; day: string } };
    };
    expect(value.temporal.shape.day).toBe("2026-09-11");
  });

  it("re-analysis of an older source cannot revert a truth published from a newer source (#8)", () => {
    const corrected = contextOf({
      findings: [
        {
          ...FINDING_WEDNESDAY,
          revisionCounter: 2,
          value: { _tag: "temporal", temporal: { shape: { _tag: "day", day: "2026-09-11" } } },
          // Friday's revision stands on source B, sent a day later.
          currentProvenanceSourceId: "sources_b_friday",
          currentProvenanceSourceSentAtMs: SENT_AT_MS + 86_400_000,
        },
      ],
    });
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      corrected,
      decodedUpsert({
        intent: "correct",
        semanticKey: "termin_dostawy",
        scopeKind: "project",
        projectId: "projects_banan",
        value: {
          _tag: "temporal",
          temporal: {
            basis: { _tag: "day", day: "2026-09-09" },
            originalExpression: "w środę",
            role: "agreed",
          },
        },
        quotes: ["w środę rano"],
        replacesFindingId: "findings_wednesday",
        derivesFromFindingIds: [],
        readConfidence: 0.9,
      }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("nowszej wiadomości");
    // The same correction from an analysis of the NEWER source itself is fine.
    const fromNewer = contextOf({
      source: {
        sourceId: "sources_b_friday",
        authorText: "Zmieniamy dostawę na piątek.",
        sentAtMs: SENT_AT_MS + 86_400_000,
        sentAtTimezone: TIMEZONE,
        lifecycle: "active",
        hintProjectIds: ["projects_banan"],
      },
      findings: [
        {
          ...FINDING_WEDNESDAY,
          revisionCounter: 1,
          currentProvenanceSourceId: "sources_s1",
          currentProvenanceSourceSentAtMs: SENT_AT_MS,
        },
      ],
    });
    const later = applyDecodedCall(
      emptyPlanningState(),
      fromNewer,
      decodedUpsert({
        intent: "correct",
        semanticKey: "termin_dostawy",
        scopeKind: "project",
        projectId: "projects_banan",
        value: {
          _tag: "temporal",
          temporal: {
            basis: { _tag: "relative", expression: "w piątek" },
            originalExpression: "na piątek",
            role: "agreed",
          },
        },
        quotes: ["Zmieniamy dostawę na piątek."],
        replacesFindingId: "findings_wednesday",
        derivesFromFindingIds: [],
        readConfidence: 0.95,
      }),
      "PLN",
    );
    expect(later.state.proposals).toHaveLength(1);
  });

  it("a contradiction routes to a clarification with real quotes, never a guess", () => {
    const state = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      {
        id: "c1",
        name: ASK_CLARIFICATION_TOOL,
        arguments: Schema.decodeUnknownSync(AskClarificationArgs)({
          question: "Który termin dostawy obowiązuje: środa czy piątek?",
          quotes: ["w środę rano"],
          scopeKind: "project",
          projectId: "projects_banan",
        }),
      },
      "PLN",
    ).state;
    expect(state.clarifications).toHaveLength(1);
    expect(state.proposals).toHaveLength(0);
  });

  it("a clarification needs at least one verbatim quote from THIS source", () => {
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      {
        id: "c1",
        name: ASK_CLARIFICATION_TOOL,
        arguments: {
          question: "Który termin?",
          quotes: ["nie istnieje dosłownie"],
          scopeKind: "company",
          projectId: null,
        },
      },
      "PLN",
    );
    expect(outcome.state.clarifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Temporal anchoring and the money basis guard.
// ---------------------------------------------------------------------------

describe("server-side value anchoring", () => {
  it("resolves relative Polish dates against the source's sentAt/timezone, never the model's clock", () => {
    const built = buildTemporalValue(
      {
        basis: { _tag: "relative", expression: "jutro" },
        originalExpression: "jutro",
        role: "proposed",
      },
      SENT_AT_MS,
      TIMEZONE,
    );
    expect(built.built).toBe(true);
    if (built.built) {
      expect(built.value.shape).toEqual({ _tag: "day", day: "2026-09-09" });
      expect(built.value.originalExpression).toBe("jutro");
    }
  });

  it("refuses a model-computed day that disagrees with the server's resolution", () => {
    const built = buildTemporalValue(
      {
        basis: { _tag: "day", day: "2026-09-10" },
        originalExpression: "jutro",
        role: "proposed",
      },
      SENT_AT_MS,
      TIMEZONE,
    );
    expect(built).toEqual({
      built: false,
      reason: "relative_day_disagrees",
      serverDay: "2026-09-09",
    });
  });

  it("routes unresolvable relative language to a clarification, never a guess", () => {
    const built = buildTemporalValue(
      {
        basis: { _tag: "relative", expression: "kiedyś tam" },
        originalExpression: "kiedyś tam",
        role: "proposed",
      },
      SENT_AT_MS,
      TIMEZONE,
    );
    expect(built).toEqual({ built: false, reason: "relative_unresolvable" });
  });

  it("keeps taxBasis not_specified unless the quote states netto/brutto (VAT never inferred)", () => {
    const proposal = {
      role: "price_proposal" as const,
      amount: { _tag: "exact" as const, value: "10000" },
      currency: null,
      taxBasis: "not_specified" as const,
      certainty: "estimate" as const,
    };
    const honest = buildMoneyValue(proposal, "około 10 tysięcy", "PLN");
    expect(honest.built).toBe(true);
    if (honest.built) {
      expect(honest.value.taxBasis).toBe("not_specified");
      expect(honest.value.currencyOrigin).toBe("company_default");
      expect(honest.value.currency).toBe("PLN");
    }
    const inferred = buildMoneyValue(
      { ...proposal, taxBasis: "net" },
      "około 10 tysięcy",
      "PLN",
    );
    expect(inferred).toEqual({ built: false, reason: "tax_basis_not_stated" });
    const stated = buildMoneyValue(
      { ...proposal, taxBasis: "net", certainty: "exact" },
      "10 tysięcy netto",
      "PLN",
    );
    expect(stated.built).toBe(true);
  });

  it("locates quotes tolerantly (whitespace/case) with stable offsets", () => {
    expect(locateQuote(WEDNESDAY_TEXT, "Dowóz płytek")).toEqual({
      located: true,
      startOffset: 0,
      endOffset: 12,
    });
    expect(locateQuote(WEDNESDAY_TEXT, "dowóz  płytek").located).toBe(true);
    expect(locateQuote(WEDNESDAY_TEXT, "nie ma tego").located).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group bounding and independent completion.
// ---------------------------------------------------------------------------

describe("publication-group bounding", () => {
  function planWithTwoProjects() {
    let state = emptyPlanningState();
    state = applyDecodedCall(
      state,
      contextOf(),
      {
        id: "i1",
        name: IDENTIFY_PROJECT_TOOL,
        arguments: { projectId: null, displayName: "Nowy domek" },
      },
      "PLN",
    ).state;
    state = applyDecodedCall(
      state,
      contextOf(),
      decodedUpsert(UPSERT_WEDNESDAY),
      "PLN",
    ).state;
    state = applyDecodedCall(
      state,
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        semanticKey: "termin_dostawy_nowy",
        scopeKind: "project",
        projectId: "projects_banan",
        quotes: ["w środę rano"],
      }),
      "PLN",
    ).state;
    state = applyDecodedCall(
      state,
      contextOf(),
      decodedUpsert({
        ...UPSERT_WEDNESDAY,
        semanticKey: "zasada_firmy",
        scopeKind: "company",
        projectId: null,
        value: { _tag: "text_note", text: "Zawsze potwierdzamy odbiór pisemnie" },
        quotes: ["Kaczmarek potwierdza odbiór"],
      }),
      "PLN",
    ).state;
    // Identify was made but never used by a proposal: the new project
    // group must NOT appear (no proposal = no group).
    return state;
  }

  it("bounds independent groups per scope: company, each existing project; unused bindings create nothing", () => {
    const bounded = boundPublicationGroups(planWithTwoProjects(), contextOf());
    const keys = bounded.groups.map((g) => `${g.key.kind}:${g.key.projectId ?? "-"}`).sort();
    expect(keys).toEqual(["company:-", "project:projects_banan", "project:projects_kaczmarek"]);
  });

  it("each group carries the analysis's input revisions (the caller expectations)", () => {
    const bounded = boundPublicationGroups(planWithTwoProjects(), contextOf());
    for (const group of bounded.groups) {
      expect(group.analysisRevisions).toEqual([
        { findingId: "findings_wednesday", revision: 1 },
      ]);
    }
  });

  it("clarifications stay apart from publications", () => {
    let state = planWithTwoProjects();
    state = applyDecodedCall(
      state,
      contextOf(),
      {
        id: "q1",
        name: ASK_CLARIFICATION_TOOL,
        arguments: {
          question: "O który odbiór chodzi?",
          quotes: ["Kaczmarek potwierdza odbiór"],
          scopeKind: "company",
          projectId: null,
        },
      },
      "PLN",
    ).state;
    const bounded = boundPublicationGroups(state, contextOf());
    expect(bounded.clarifications).toHaveLength(1);
    expect(bounded.groups.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Stale context: the mid-run correction refusal, wired to C2's guard.
// ---------------------------------------------------------------------------

describe("stale-context handling (reanalysis cannot overwrite a newer correction)", () => {
  it("refuses when a finding the analysis read has moved since (mid-run correction)", () => {
    const analysisRevisions = [{ findingId: "findings_wednesday", revision: 1 }];
    expect(
      decideGroupPublish({
        analysisRevisions,
        currentRevisions: { findings_wednesday: 2 },
      }),
    ).toEqual({ decision: "refuse", code: "analysis_context_stale" });
  });

  it("publishes when the world still matches the analysis", () => {
    expect(
      decideGroupPublish({
        analysisRevisions: [{ findingId: "findings_wednesday", revision: 1 }],
        currentRevisions: { findings_wednesday: 1 },
      }),
    ).toEqual({ decision: "publish" });
  });

  it("the same expectations feed C2's stale-plan guard (the composition wiring)", () => {
    // What the publish stage passes as caller expectations:
    const analysisRevisions = [{ findingId: "findings_wednesday", revision: 1 }];
    // A Friday correction landed: the current counter moved to 2.
    const current = { findings_wednesday: 2 };
    expect(
      decidePublish({
        changeSetState: "prepared",
        captured: analysisRevisions,
        caller: analysisRevisions,
        current,
      }),
    ).toEqual({ decision: "refuse", code: "stale_plan" });
    // Without the correction the same plan publishes.
    expect(
      decidePublish({
        changeSetState: "prepared",
        captured: analysisRevisions,
        caller: analysisRevisions,
        current: { findings_wednesday: 1 },
      }),
    ).toEqual({ decision: "publish" });
  });
});

// ---------------------------------------------------------------------------
// Pending-segment honesty.
// ---------------------------------------------------------------------------

describe("pending-segment honesty (text-only cannot claim a pending image)", () => {
  const pending = { extractedKinds: ["text" as const], pendingSegments: ["image" as const] };

  it("a source with a pending segment is not a complete transcript", () => {
    expect(isCompleteTranscript(pending)).toBe(false);
    expect(decideRunCompleteness(pending)).toBe("partial_pending_segments");
    expect(decideRunCompleteness({ extractedKinds: ["text"], pendingSegments: [] })).toBe(
      "complete",
    );
  });

  it("the inspection guard is structural: evidence must locate verbatim in this source's text", () => {
    // There is no per-kind runtime predicate because the tool surface
    // exposes no other basis kind: a quote that does not occur in the
    // author text is refused by the reducer, so a text-only run can never
    // cite a segment it did not inspect.
    const outcome = applyDecodedCall(
      emptyPlanningState(),
      contextOf(),
      decodedUpsert({ ...UPSERT_WEDNESDAY, quotes: ["zdjęcie z delivering-notatki"] }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });
});

describe("one scope-equality rule (sameScope)", () => {
  it("equal kinds and project identities compare equal; everything else does not", () => {
    expect(sameScope({ kind: "company" }, { kind: "company", projectId: null })).toBe(true);
    expect(
      sameScope(
        { kind: "project", projectId: "p1" },
        { kind: "project", projectId: "p1" },
      ),
    ).toBe(true);
    expect(
      sameScope(
        { kind: "project", projectId: "p1" },
        { kind: "project", projectId: "p2" },
      ),
    ).toBe(false);
    expect(sameScope({ kind: "company" }, { kind: "project", projectId: "p1" })).toBe(false);
  });
});

describe("one grounding predicate (groupIsTextGrounded)", () => {
  it("every proposal needs textual evidence or a derivation basis", () => {
    const grounded = {
      proposals: [
        { evidence: [{ quote: "q" }], derivesFromFindingIds: [] },
        { evidence: [], derivesFromFindingIds: ["f1"] },
      ],
    };
    const ungrounded = {
      proposals: [
        { evidence: [{ quote: "q" }], derivesFromFindingIds: [] },
        { evidence: [], derivesFromFindingIds: [] },
      ],
    };
    expect(groupIsTextGrounded(grounded)).toBe(true);
    expect(groupIsTextGrounded(ungrounded)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Versioned prompt surface.
// ---------------------------------------------------------------------------

describe("versioned prompt and pipeline labels", () => {
  it("pins the Polish system prompt and the pipeline/schema versions", () => {
    expect(PLANNING_PROMPT_VERSION).toBe("e3.prompt-pl/3");
    expect(PLANNING_SCHEMA_VERSION).toBe("e3.schema/1");
    expect(TEXT_ANALYSIS_PIPELINE_VERSION).toBe("e3.text/1");
    expect(analysisSystemPrompt()).toContain("agentem pamięci firmy budowlanej");
    expect(analysisSystemPrompt()).not.toContain("clalification");
  });

  it("the first user message carries the anchored source, scope hints and revisions", () => {
    const message = sourceUserMessage(contextOf());
    expect(message).toContain("Europe/Warsaw");
    expect(message).toContain(WEDNESDAY_TEXT);
    expect(message).toContain("projects_banan");
    expect(message).toContain("rewizja 1");
  });
});
