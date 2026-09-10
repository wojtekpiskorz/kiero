/**
 * E6 focused verification, part 1: the PURE answer contract from
 * packages/agent/tools — grounded versus ungrounded statements, the C5
 * updating gate, ambiguity-→-clarification discipline, tool-argument
 * re-validation against the tenant-filtered context, domain-change
 * staleness checks and the in-flight freshness decision (issue #40).
 *
 * The Convex halves (checked executions, the bounded loop) run against
 * the leased dev deployment (tests/e6/live-proof.mjs); what MUST hold
 * structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  ANSWER_TOOLS_VERSION,
  ASK_CLARIFICATION_TOOL,
  CHANGE_TASK_TOOL,
  SUBMIT_ANSWER_TOOL,
  applyAnswerToolCall,
  decideAnswerFreshness,
  emptyAnswerState,
  extendEvidenceLedger,
  type AnswerContext,
  type AnswerEvidenceEntry,
  type DecodedAnswerCall,
} from "@kiero/agent/tools";

// ---------------------------------------------------------------------------
// Fixtures: one Polish question, a money finding with a not_specified tax
// basis, an updating derivation, a conflicted pair and a corroborated note.
// ---------------------------------------------------------------------------

const SENT_AT_MS = Date.parse("2026-09-09T07:30:00.000Z");
const TIMEZONE = "Europe/Warsaw";

const QUESTION_TEXT = "Jaka zaliczka wpłynęła od Kaczmarka i kiedy dostawa płytek?";

const EV_DEPOSIT: AnswerEvidenceEntry = {
  evidenceId: "ev1",
  sourceId: "sources_s1",
  sourceSentAtMs: SENT_AT_MS - 3_600_000,
  fragmentId: "sourceFragments_f1",
  quote: "Kaczmarek wpłacił zaliczkę 5000",
  startOffset: 0,
  endOffset: 28,
  groundsFindingId: "findings_deposit",
  groundsUpdating: false,
};

const EV_DEPOSIT_CORROBORATION: AnswerEvidenceEntry = {
  evidenceId: "ev2",
  sourceId: "sources_s2",
  sourceSentAtMs: SENT_AT_MS - 1_800_000,
  fragmentId: null,
  quote: "potwierdzam wpłatę pięciu tysięcy zaliczki",
  startOffset: null,
  endOffset: null,
  groundsFindingId: "findings_deposit",
  groundsUpdating: false,
};

const EV_UPDATING_BASIS: AnswerEvidenceEntry = {
  evidenceId: "ev3",
  sourceId: "sources_s3",
  sourceSentAtMs: SENT_AT_MS - 7_200_000,
  fragmentId: null,
  quote: "dostawa uzgodniona na piątek rano",
  startOffset: null,
  endOffset: null,
  groundsFindingId: "findings_delivery",
  groundsUpdating: true,
};

const EV_CONFLICT_A: AnswerEvidenceEntry = {
  evidenceId: "ev4",
  sourceId: "sources_s4",
  sourceSentAtMs: SENT_AT_MS - 5_400_000,
  fragmentId: null,
  quote: "montaż w środę",
  startOffset: null,
  endOffset: null,
  groundsFindingId: "findings_montaz",
  groundsUpdating: false,
};

const EV_CONFLICT_B: AnswerEvidenceEntry = {
  evidenceId: "ev5",
  sourceId: "sources_s5",
  sourceSentAtMs: SENT_AT_MS - 3_600_000,
  fragmentId: null,
  quote: "montaż jednak w piątek",
  startOffset: null,
  endOffset: null,
  groundsFindingId: "findings_montaz",
  groundsUpdating: false,
};

function contextOf(overrides: Partial<AnswerContext> = {}): AnswerContext {
  return {
    question: {
      sourceId: "sources_question",
      authorText: QUESTION_TEXT,
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: TIMEZONE,
    },
    projects: [
      { projectId: "projects_banan", displayName: "Banan", codename: "banan" },
    ],
    findings: [
      {
        findingId: "findings_deposit",
        scope: { kind: "project", projectId: "projects_banan" },
        semanticKey: "zaliczka_klienta",
        revisionCounter: 2,
        value: {
          _tag: "money",
          money: {
            role: "deposit_received",
            amount: { _tag: "exact", value: "5000" },
            currency: "PLN",
            currencyOrigin: "stated",
            taxBasis: "not_specified",
            certainty: "exact",
          },
        },
        knowledgeTag: "known",
        updating: false,
        evidenceIds: ["ev1", "ev2"],
      },
      {
        findingId: "findings_delivery",
        scope: { kind: "project", projectId: "projects_banan" },
        semanticKey: "termin_dostawy",
        revisionCounter: 1,
        value: { _tag: "text_note", text: "piątek rano" },
        knowledgeTag: "updating",
        updating: true,
        evidenceIds: ["ev3"],
      },
      {
        findingId: "findings_montaz",
        scope: { kind: "project", projectId: "projects_banan" },
        semanticKey: "termin_montazu",
        revisionCounter: 3,
        value: { _tag: "text_note", text: "środa lub piątek" },
        knowledgeTag: "conflicted",
        updating: false,
        evidenceIds: ["ev4", "ev5"],
      },
      {
        findingId: "findings_risk",
        scope: { kind: "company" },
        semanticKey: "wniosek_ryzyko",
        revisionCounter: 1,
        value: { _tag: "text_note", text: "ryzyko kary niskie" },
        knowledgeTag: "known",
        updating: false,
        evidenceIds: [],
      },
    ],
    sources: [
      { sourceId: "sources_s1", sentAtMs: SENT_AT_MS - 3_600_000, preview: "", lifecycle: "active", processing: "complete" },
      { sourceId: "sources_s6", sentAtMs: SENT_AT_MS - 600_000, preview: "", lifecycle: "active", processing: "processing" },
    ],
    tasks: [
      {
        taskId: "tasks_t1",
        projectId: "projects_banan",
        title: "Zamówić płytki",
        state: "todo",
        revisionCounter: 4,
      },
    ],
    events: [],
    clarifications: [
      {
        clarificationId: "clarifications_c1",
        question: "Który termin montażu obowiązuje?",
        scopeKind: "project",
        scopeProjectId: "projects_banan",
      },
    ],
    contacts: [
      { contactId: "contacts_zbyszek", displayName: "Zbyszek Płytki (podwykonawca)" },
    ],
    memberships: [
      { membershipId: "memberships_admin", bossName: "Szef Bananowy" },
    ],
    evidence: [EV_DEPOSIT, EV_DEPOSIT_CORROBORATION, EV_UPDATING_BASIS, EV_CONFLICT_A, EV_CONFLICT_B],
    run: { runId: "e6-run-1", nowMs: SENT_AT_MS },
    ...overrides,
  };
}

/** One submit-answer call from raw wire arguments (decode proof included). */
function submitCall(raw: unknown): DecodedAnswerCall {
  const args = raw instanceof Object ? raw : {};
  // Decode only when shaped; malformed shapes are the schema tests' proof.
  return {
    id: "call_submit",
    name: SUBMIT_ANSWER_TOOL,
    arguments: args,
  };
}

function callOf(name: string, args: unknown): DecodedAnswerCall {
  return { id: `call_${name}`, name, arguments: args };
}

// ---------------------------------------------------------------------------
// Grounded versus ungrounded (the answer contract's core).
// ---------------------------------------------------------------------------

describe("grounded versus ungrounded statements", () => {
  it("accepts a direct statement citing ledger evidence", () => {
    const context = contextOf();
    const state = emptyAnswerState(context);
    const outcome = applyAnswerToolCall(
      state,
      context,
      submitCall({
        answerText: "Kaczmarek wpłacił zaliczkę 5000 PLN.",
        statements: [
          { text: "Zaliczka wynosi 5000 PLN.", basis: "direct", evidenceIds: ["ev1"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: ["findings_delivery"], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(true);
    expect(outcome.state.submitted?.statements[0]?.basis).toBe("direct");
  });

  it("refuses an invented citation (ungrounded)", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "Zaliczka wynosi 7000 PLN.",
        statements: [
          { text: "Zaliczka wynosi 7000 PLN.", basis: "direct", evidenceIds: ["ev99"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.state.submitted).toBeNull();
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("ev99");
  });

  it("refuses a direct statement with no citation at all", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "Podанная kwota to 5000.",
        statements: [
          { text: "Kwota 5000.", basis: "direct", evidenceIds: [], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("corroboration needs two DISTINCT sources — one source twice is not independent", () => {
    const context = contextOf();
    const base = {
      answerText: "x",
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    };
    const sameSource = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        ...base,
        statements: [
          { text: "Potwierdzone.", basis: "corroboration", evidenceIds: ["ev1", "ev1"], derivedFromFindingIds: [] },
        ],
      }),
    );
    expect(sameSource.done).toBe(false);
    expect(sameSource.toolResult).toContain("NIEZALEŻNYCH");

    const twoSources = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        ...base,
        statements: [
          { text: "Potwierdzone.", basis: "corroboration", evidenceIds: ["ev1", "ev2"], derivedFromFindingIds: [] },
        ],
      }),
    );
    expect(twoSources.done).toBe(true);
  });

  it("inference requires an established derivation basis", () => {
    const context = contextOf();
    const base = {
      answerText: "x",
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    };
    const noBasis = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        ...base,
        statements: [
          { text: "Wniosek.", basis: "inference", evidenceIds: [], derivedFromFindingIds: [] },
        ],
      }),
    );
    expect(noBasis.done).toBe(false);

    const updatingBasis = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        ...base,
        statements: [
          { text: "Wniosek z dostawy.", basis: "inference", evidenceIds: [], derivedFromFindingIds: ["findings_delivery"] },
        ],
      }),
    );
    expect(updatingBasis.done).toBe(false);
    expect(updatingBasis.toolResult).toContain("nie jest ustalona");

    const establishedBasis = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        ...base,
        statements: [
          { text: "Wniosek z zaliczki.", basis: "inference", evidenceIds: [], derivedFromFindingIds: ["findings_deposit"] },
        ],
      }),
    );
    expect(establishedBasis.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The updating gate (C5): updating findings are disclosed, never asserted.
// ---------------------------------------------------------------------------

describe("the updating gate", () => {
  it("refuses an established statement grounded on an updating finding's evidence", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "Dostawa w piątek rano.",
        statements: [
          { text: "Dostawa jest w piątek rano.", basis: "direct", evidenceIds: ["ev3"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.toolResult).toContain("w trakcie aktualizacji");
    expect(outcome.toolResult).toContain("termin_dostawy");
  });

  it("accepts the honest disclosure of the updating finding", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "Termin dostawy jest ponownie weryfikowany.",
        statements: [
          { text: "Zaliczka wynosi 5000 PLN.", basis: "direct", evidenceIds: ["ev1"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: ["findings_delivery"], processingSourceIds: ["sources_s6"] },
      }),
    );
    expect(outcome.done).toBe(true);
    expect(outcome.state.submitted?.disclosures.updatingFindingIds).toEqual(["findings_delivery"]);
  });

  it("refuses an invented disclosure (an updating id that is not updating)", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "x",
        statements: [
          { text: "Zaliczka 5000 PLN.", basis: "direct", evidenceIds: ["ev1"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: ["findings_deposit"], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.toolResult).toContain("ujawnienie");
  });

  it("refuses a disclosure naming a source that is not processing", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "x",
        statements: [
          { text: "Zaliczka 5000 PLN.", basis: "direct", evidenceIds: ["ev1"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: [], processingSourceIds: ["sources_s1"] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.toolResult).toContain("w trakcie przetwarzania");
  });
});

// ---------------------------------------------------------------------------
// Ambiguity: a clarification, never a guess.
// ---------------------------------------------------------------------------

describe("ambiguity → clarification, not guess", () => {
  it("refuses a direct statement resting on a conflicted finding", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      submitCall({
        answerText: "Montaż w środę.",
        statements: [
          { text: "Montaż jest w środę.", basis: "direct", evidenceIds: ["ev4"], derivedFromFindingIds: [] },
        ],
        disclosures: { updatingFindingIds: [], processingSourceIds: [] },
      }),
    );
    expect(outcome.done).toBe(false);
    expect(outcome.toolResult).toContain("sprzecznego ustalenia");
    expect(outcome.toolResult).toContain("agent_ask_clarification");
  });

  it("admits a clarification citing the conflicting evidence of both sides", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(ASK_CLARIFICATION_TOOL, {
        question: "Który termin montażu obowiązuje: środa czy piątek?",
        evidenceIds: ["ev4", "ev5"],
        scopeKind: "project",
        projectId: "projects_banan",
      }),
    );
    expect(outcome.toolResult).not.toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("PYTANIE PRZYJĘTE");
  });

  it("refuses a clarification whose citations do not resolve", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(ASK_CLARIFICATION_TOOL, {
        question: "Który termin?",
        evidenceIds: ["ev404"],
        scopeKind: "company",
        projectId: null,
      }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("refuses resolving a clarification that is not in the context", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf("agent_resolve_clarification", {
        clarificationId: "clarifications_nope",
        resolutionNote: "Piątek.",
        evidenceIds: ["ev1"],
      }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });
});

// ---------------------------------------------------------------------------
// Domain changes: context validation before the checked dispatch.
// ---------------------------------------------------------------------------

describe("domain-change validation (untrusted plan, checked execution later)", () => {
  const TASK_ARGS = {
    taskId: null,
    projectId: "projects_banan",
    title: "Zamówić płytki na montaż",
    executorContactId: null,
    coordinatorMembershipId: null,
    deadlineFindingId: null,
    expectedRevision: 1,
  };

  it("admits a task creation grounded in a context project", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, TASK_ARGS),
    );
    expect(outcome.toolResult).not.toContain("ODRZUCONO");
  });

  it("refuses a cross-tenant/unknown project (no context project, no scope)", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, { ...TASK_ARGS, projectId: "projects_other_firm" }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("projektu tej firmy");
  });

  it("refuses an invented coordinator membership (no such boss in context)", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, { ...TASK_ARGS, coordinatorMembershipId: "memberships_invented" }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("członkostwa szefa");
  });

  it("admits a task change with a context coordinator and executor", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, {
        ...TASK_ARGS,
        executorContactId: "contacts_zbyszek",
        coordinatorMembershipId: "memberships_admin",
      }),
    );
    expect(outcome.toolResult).not.toContain("ODRZUCONO");
  });

  it("refuses a stale expectedRevision for an existing task", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, { ...TASK_ARGS, taskId: "tasks_t1", expectedRevision: 2 }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("rewizja 4");
  });

  it("refuses binding a deadline to an updating finding", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf(CHANGE_TASK_TOOL, { ...TASK_ARGS, deadlineFindingId: "findings_delivery" }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.toolResult).toContain("w trakcie aktualizacji");
  });
});

// ---------------------------------------------------------------------------
// The in-flight freshness decision (stale answer/change guard).
// ---------------------------------------------------------------------------

describe("decideAnswerFreshness", () => {
  it("reports current when nothing moved", () => {
    const decision = decideAnswerFreshness({
      loadRevisions: [{ findingId: "findings_deposit", revision: 2 }],
      currentRevisions: new Map([["findings_deposit", 2]]),
    });
    expect(decision).toEqual({ decision: "current" });
  });

  it("forces a refresh listing the moved findings when a correction landed", () => {
    const decision = decideAnswerFreshness({
      loadRevisions: [
        { findingId: "findings_deposit", revision: 2 },
        { findingId: "findings_delivery", revision: 1 },
      ],
      currentRevisions: new Map([
        ["findings_deposit", 3],
        ["findings_delivery", 1],
      ]),
    });
    expect(decision.decision).toBe("refresh");
    if (decision.decision === "refresh") {
      expect(decision.moved).toEqual([
        { findingId: "findings_deposit", loadRevision: 2, currentRevision: 3 },
      ]);
    }
  });

  it("a vanished finding is not a move (nothing stale-addresses it)", () => {
    const decision = decideAnswerFreshness({
      loadRevisions: [{ findingId: "findings_gone", revision: 1 }],
      currentRevisions: new Map(),
    });
    expect(decision.decision).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// The evidence ledger: search results are citations, bounded and deduped.
// ---------------------------------------------------------------------------

describe("the evidence ledger", () => {
  it("extends with search results and dedupes by handle", () => {
    const context = contextOf();
    let state = emptyAnswerState(context);
    const first = extendEvidenceLedger(state, [
      {
        evidenceId: "ev6",
        sourceId: "sources_s7",
        sourceSentAtMs: SENT_AT_MS,
        fragmentId: null,
        quote: "dostawa płytek",
        startOffset: 3,
        endOffset: 16,
        groundsFindingId: null,
        groundsUpdating: false,
      },
    ]);
    state = first.state;
    expect(state.evidence.map((entry) => entry.evidenceId)).toContain("ev6");
    const replay = extendEvidenceLedger(state, [
      {
        evidenceId: "ev6",
        sourceId: "sources_s7",
        sourceSentAtMs: SENT_AT_MS,
        fragmentId: null,
        quote: "dostawa płytek",
        startOffset: 3,
        endOffset: 16,
        groundsFindingId: null,
        groundsUpdating: false,
      },
    ]);
    expect(replay.accepted).toHaveLength(0);
    expect(replay.state.evidence).toHaveLength(state.evidence.length);
  });
});

// ---------------------------------------------------------------------------
// Unknown tools and the versioned surface.
// ---------------------------------------------------------------------------

describe("closed tool vocabulary and versions", () => {
  it("refuses an undeclared tool name (the model cannot widen its own surface)", () => {
    const context = contextOf();
    const outcome = applyAnswerToolCall(
      emptyAnswerState(context),
      context,
      callOf("db_raw_insert", { table: "users", rows: [{ role: "gm" }] }),
    );
    expect(outcome.toolResult).toContain("ODRZUCONO");
    expect(outcome.state.submitted).toBeNull();
  });

  it("pins the answer-tools version labels", () => {
    expect(ANSWER_TOOLS_VERSION).toBe("e6.tools/1");
  });
});
