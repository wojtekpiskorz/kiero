/**
 * E6 focused verification, part 5: the loop's tool-call dispatch routing.
 *
 * Round-3 review finding: a tool can be DECLARED (so the model's call
 * decodes) yet DEAD, because the loop's routing and the reducer's case
 * list drifted apart silently — `agent_validate_extension_value` landed
 * in the reducer-first branch whose default refuses it, and nothing
 * ever executed. These tests drive EVERY declared tool name through
 * `dispatchAnswerToolCall` with a FAKE ActionCtx that records which
 * internal Convex function each call actually reached (executor vs
 * reducer refusal), so a future declared-but-dead tool fails here:
 *
 * - every declared name has a routing fixture (no fixture, no route);
 * - each fixture's expected executor set matches what really ran;
 * - validate executes end to end through its checked executor;
 * - a reducer-refused plan executes nothing;
 * - a transient search failure returns the shared technical refusal
 *   instead of throwing the whole action;
 * - an undeclared name (impossible through the adapter, possible through
 *   wiring mistakes) fails closed on the reducer's default refusal.
 */

import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import {
  ANSWER_TOOLS,
  emptyAnswerState,
  type AnswerContext,
  type AnswerEvidenceEntry,
} from "@kiero/agent/tools";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ActionCtx } from "../../convex/_generated/server";
import { dispatchAnswerToolCall } from "../../convex/agent/loop";

// ---------------------------------------------------------------------------
// The executor paths the dispatch may reach (derived from the real
// internal function references, so a moved module fails loudly here).
// ---------------------------------------------------------------------------

const SEARCH_PATH = getFunctionName(internal.agent.evidence.searchEvidenceRows);
const RECHECK_PATH = getFunctionName(internal.agent.execute.stalenessRecheck);
const LOAD_STAGE_PATH = getFunctionName(internal.agent.loop.loadAnswerStage);
const CLARIFY_PATH = getFunctionName(internal.agent.execute.executeClarification);
const RESOLVE_PATH = getFunctionName(
  internal.agent.execute.executeResolveClarification,
);
const WORK_CHANGE_PATH = getFunctionName(internal.agent.execute.executeWorkChange);
const VALIDATE_PATH = getFunctionName(
  internal.agent.execute.executeExtensionValidate,
);

type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

/** One recorded internal call (which function, with which arguments). */
interface RecordedCall {
  readonly kind: "query" | "mutation";
  readonly path: string;
  readonly args: Record<string, unknown>;
}

/**
 * Builds a fake ActionCtx recording every internal query/mutation and
 * answering each by its function path (the e2 dispatch-test pattern).
 */
function fakeActionCtx(answers: {
  query?: (path: string, args: Record<string, unknown>) => unknown;
  mutation?: (path: string, args: Record<string, unknown>) => unknown;
}) {
  const calls: RecordedCall[] = [];
  const ctx = {
    runQuery: async (ref: AnyFunctionReference, args: Record<string, unknown>) => {
      const path = getFunctionName(ref);
      calls.push({ kind: "query", path, args });
      return answers.query?.(path, args);
    },
    runMutation: async (
      ref: AnyFunctionReference,
      args: Record<string, unknown>,
    ) => {
      const path = getFunctionName(ref);
      calls.push({ kind: "mutation", path, args });
      return answers.mutation?.(path, args);
    },
  };
  return { ctx: ctx as unknown as ActionCtx, calls };
}

/** A checked-execution ResultEnvelope in the wire shape the loop unwraps. */
function okEnvelope(value: Record<string, unknown>): unknown {
  return { _tag: "ok", value };
}

/** Answers every executor with its happy-path envelope. */
const happyAnswers = {
  query: (path: string): unknown => {
    if (path === SEARCH_PATH) {
      return okEnvelope({ hits: [], scope: "ok" });
    }
    throw new Error(`unexpected query ${path}`);
  },
  mutation: (path: string): unknown => {
    switch (path) {
      case RECHECK_PATH:
        return { decision: { decision: "current" } };
      case CLARIFY_PATH:
        return okEnvelope({
          outcome: "raised",
          clarificationId: "clarifications_c9",
        });
      case RESOLVE_PATH:
        return okEnvelope({ outcome: "resolved" });
      case WORK_CHANGE_PATH:
        return okEnvelope({ outcome: "changed", entityId: "tasks_t1", revision: 5 });
      case VALIDATE_PATH:
        return okEnvelope({ outcome: "valid" });
      default:
        throw new Error(`unexpected mutation ${path}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Fixtures: one minimal tenant-filtered context whose ids the
// reducer-validated arguments below must address.
// ---------------------------------------------------------------------------

const SENT_AT_MS = Date.parse("2026-09-09T07:30:00.000Z");

const EV_QUOTE: AnswerEvidenceEntry = {
  evidenceId: "ev1",
  sourceId: "sources_s1",
  sourceSentAtMs: SENT_AT_MS,
  fragmentId: null,
  quote: "Kaczmarek wpłacił zaliczkę 5000",
  startOffset: 0,
  endOffset: 28,
  groundsFindingId: null,
  groundsUpdating: false,
};

function contextOf(overrides: Partial<AnswerContext> = {}): AnswerContext {
  return {
    question: {
      sourceId: "sources_question",
      authorText: "Jaka zaliczka wpłynęła od Kaczmarka?",
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: "Europe/Warsaw",
    },
    projects: [
      { projectId: "projects_banan", displayName: "Banan", codename: "banan" },
    ],
    findings: [
      {
        findingId: "findings_delivery",
        scope: { kind: "project", projectId: "projects_banan" },
        semanticKey: "termin_dostawy",
        revisionCounter: 1,
        value: { _tag: "text_note", text: "piątek rano" },
        knowledgeTag: "updating",
        updating: true,
        evidenceIds: ["ev1"],
      },
    ],
    sources: [
      {
        sourceId: "sources_s1",
        sentAtMs: SENT_AT_MS,
        preview: "",
        lifecycle: "active",
        processing: "complete",
      },
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
    contacts: [],
    memberships: [],
    evidence: [EV_QUOTE],
    run: { runId: "e6-routing", nowMs: SENT_AT_MS },
    ...overrides,
  };
}

const SOURCE_ID = "sources_question" as Id<"sources">;

// ---------------------------------------------------------------------------
// The routing table: for every declared tool, arguments its reducer (when
// it has one) accepts and the internal functions its path must reach.
// A tool declared in ANSWER_TOOLS without an entry here fails the suite;
// an entry whose executors never ran fails the suite. The two together
// are what keeps the dispatch and the declared vocabulary in lockstep.
// ---------------------------------------------------------------------------

const ROUTES: Record<
  string,
  { args: unknown; executors: { kind: "query" | "mutation"; path: string }[]; done?: boolean }
> = {
  agent_search_evidence: {
    args: { query: "zaliczka Kaczmarka", projectId: null },
    executors: [{ kind: "query", path: SEARCH_PATH }],
  },
  agent_submit_answer: {
    args: {
      answerText: "Kaczmarek wpłacił zaliczkę 5000 PLN.",
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
    executors: [{ kind: "mutation", path: RECHECK_PATH }],
    done: true,
  },
  agent_ask_clarification: {
    args: {
      question: "Jaka kwota zaliczki obowiązuje?",
      evidenceIds: ["ev1"],
      scopeKind: "company",
      projectId: null,
    },
    executors: [{ kind: "mutation", path: CLARIFY_PATH }],
  },
  agent_resolve_clarification: {
    args: {
      clarificationId: "clarifications_c1",
      resolutionNote: "Piątek — potwierdzone nową wiadomością.",
      evidenceIds: ["ev1"],
    },
    executors: [{ kind: "mutation", path: RESOLVE_PATH }],
  },
  agent_change_task: {
    args: {
      taskId: "tasks_t1",
      projectId: "projects_banan",
      title: "Zamówić płytki",
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: null,
      expectedRevision: 4,
    },
    executors: [{ kind: "mutation", path: WORK_CHANGE_PATH }],
  },
  agent_change_event: {
    args: {
      eventId: null,
      projectId: "projects_banan",
      title: "Dostawa płytek",
      timeFindingId: null,
      expectedRevision: 1,
    },
    executors: [{ kind: "mutation", path: WORK_CHANGE_PATH }],
  },
  agent_validate_extension_value: {
    args: { versionId: "extensionVersions_v1", value: { _tag: "text", text: "stal" } },
    executors: [{ kind: "mutation", path: VALIDATE_PATH }],
  },
};

function callOf(name: string, args: unknown) {
  return { id: `call_${name}`, name, arguments: args };
}

describe("the loop's tool dispatch routes every declared tool", () => {
  it("the routing fixtures cover exactly the declared vocabulary", () => {
    // Bidirectional: no declared tool without a route, no stale route for
    // an undeclared tool.
    expect(Object.keys(ROUTES).sort()).toEqual(
      ANSWER_TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it("drives every declared tool to its live path, never a dead refusal", async () => {
    for (const tool of ANSWER_TOOLS) {
      const route = ROUTES[tool.name];
      if (route === undefined) {
        throw new Error(`declared tool ${tool.name} has no routing fixture`);
      }
      const { ctx, calls } = fakeActionCtx(happyAnswers);
      const context = contextOf();
      const dispatched = await dispatchAnswerToolCall(
        ctx,
        SOURCE_ID,
        "e6-routing",
        context,
        emptyAnswerState(context),
        0,
        callOf(tool.name, route.args),
      );
      if (dispatched.kind !== "executed") {
        throw new Error(`${tool.name}: expected executed, got ${dispatched.kind}`);
      }
      // The path actually taken: exactly the expected internal functions.
      expect(
        calls.map((call) => ({ kind: call.kind, path: call.path })),
        tool.name,
      ).toEqual(route.executors);
      // And the call was not refused on the way (a dead tool lands on the
      // reducer's wiring-mistake refusal and executes nothing).
      expect(dispatched.result.toolResult, tool.name).not.toContain("ODRZUCONO");
      if (route.done !== undefined) {
        expect(dispatched.result.done, tool.name).toBe(route.done);
      }
    }
  });

  it("executes agent_validate_extension_value end to end through its checked executor", async () => {
    // The round-3 casualty: validate must reach executeExtensionValidate
    // (and through it C3's memory.validateExtensionValue), not the
    // reducer that has nothing to validate it against.
    const { ctx, calls } = fakeActionCtx(happyAnswers);
    const context = contextOf();
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      emptyAnswerState(context),
      0,
      callOf("agent_validate_extension_value", ROUTES["agent_validate_extension_value"]!.args),
    );
    expect(dispatched.kind).toBe("executed");
    expect(calls).toEqual([
      {
        kind: "mutation",
        path: VALIDATE_PATH,
        args: {
          questionSourceId: "sources_question",
          versionId: "extensionVersions_v1",
          value: { _tag: "text", text: "stal" },
        },
      },
    ]);
    if (dispatched.kind === "executed") {
      expect(dispatched.result.toolResult).toBe(
        "Wartość przechodzi walidację definicji.",
      );
    }

    // A value the checked rules reject comes back as the model-facing
    // refusal, still without touching the reducer.
    const failed = fakeActionCtx({
      mutation: (path) =>
        path === VALIDATE_PATH
          ? okEnvelope({ outcome: "failed", error: "value_invalid" })
          : Promise.reject(new Error(`unexpected mutation ${path}`)),
    });
    const rejected = await dispatchAnswerToolCall(
      failed.ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      emptyAnswerState(context),
      0,
      callOf("agent_validate_extension_value", {
        versionId: "extensionVersions_v1",
        value: { _tag: "money", money: {} },
      }),
    );
    expect(rejected.kind).toBe("executed");
    if (rejected.kind === "executed") {
      expect(rejected.result.toolResult).toContain("ODRZUCONO");
      expect(rejected.result.toolResult).toContain("value_invalid");
    }
  });

  it("a reducer-refused plan never reaches an executor", async () => {
    const { ctx, calls } = fakeActionCtx({
      mutation: (path) => {
        throw new Error(`no mutation may run: ${path}`);
      },
    });
    const context = contextOf();
    const state = emptyAnswerState(context);
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      state,
      0,
      callOf("agent_change_task", {
        // A project outside the tenant-filtered context: the reducer
        // refuses before any checked execution.
        taskId: null,
        projectId: "projects_obcej_firmy",
        title: "Zadanie poza kontekstem",
        executorContactId: null,
        coordinatorMembershipId: null,
        deadlineFindingId: null,
        expectedRevision: 1,
      }),
    );
    expect(dispatched.kind).toBe("executed");
    expect(calls).toEqual([]);
    if (dispatched.kind === "executed") {
      expect(dispatched.result.toolResult).toContain("ODRZUCONO");
      expect(dispatched.result.toolResult).toContain("projectId");
      expect(dispatched.result.state).toBe(state);
    }
  });

  it("a transient search failure is the shared technical refusal, not a thrown action", async () => {
    const { ctx, calls } = fakeActionCtx({
      query: () => {
        throw new Error("transient storage error");
      },
    });
    const context = contextOf();
    const state = emptyAnswerState(context);
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      state,
      0,
      callOf("agent_search_evidence", { query: "zaliczka", projectId: null }),
    );
    expect(dispatched.kind).toBe("executed");
    expect(calls).toHaveLength(1);
    if (dispatched.kind === "executed") {
      expect(dispatched.result.toolResult).toBe(
        "ODRZUCONO: wykonanie wyszukiwania nie powiodło się (błąd techniczny)",
      );
      expect(dispatched.result.done).toBe(false);
      expect(dispatched.result.state).toBe(state);
    }
  });

  it("fails closed on a name outside the declared vocabulary (wiring mistake)", async () => {
    const { ctx, calls } = fakeActionCtx(happyAnswers);
    const context = contextOf();
    const state = emptyAnswerState(context);
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      state,
      0,
      callOf("agent_undeclared_tool", { anything: true }),
    );
    expect(dispatched.kind).toBe("executed");
    expect(calls).toEqual([]);
    if (dispatched.kind === "executed") {
      expect(dispatched.result.toolResult).toContain("ODRZUCONO");
      expect(dispatched.result.state).toBe(state);
    }
  });

  it("hands a gate-mandated refresh back as the round's refresh outcome", async () => {
    const refreshed = contextOf({
      question: {
        sourceId: "sources_question",
        authorText: "Jaka zaliczka wpłynęła od Kaczmarka (ponowione)?",
        sentAtMs: SENT_AT_MS + 1,
        sentAtTimezone: "Europe/Warsaw",
      },
    });
    const { ctx, calls } = fakeActionCtx({
      mutation: (path) => {
        if (path === RECHECK_PATH) {
          return {
            decision: {
              decision: "refresh",
              moved: [
                {
                  findingId: "findings_delivery",
                  loadRevision: 1,
                  currentRevision: 2,
                },
              ],
            },
          };
        }
        if (path === LOAD_STAGE_PATH) {
          return { context: refreshed };
        }
        throw new Error(`unexpected mutation ${path}`);
      },
    });
    const context = contextOf();
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      SOURCE_ID,
      "e6-routing",
      context,
      emptyAnswerState(context),
      0,
      callOf("agent_submit_answer", ROUTES["agent_submit_answer"]!.args),
    );
    expect(dispatched.kind).toBe("refresh");
    if (dispatched.kind === "refresh") {
      expect(dispatched.context).toBe(refreshed);
      expect(dispatched.refreshResult).toContain("ODRZUCONO");
      expect(dispatched.nudge).toContain("findings_delivery");
    }
    expect(calls.map((call) => call.path)).toEqual([RECHECK_PATH, LOAD_STAGE_PATH]);
  });
});
