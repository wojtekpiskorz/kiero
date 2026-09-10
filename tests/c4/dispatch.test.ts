/**
 * C4 focused verification, part 2: the checked dispatch surface, the lane
 * policy registration and the contract-vocabulary enforcement.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/c4/live-proof.mjs) exercises them end to end against the leased
 * dev deployment. What MUST hold structurally is pinned here: exactly the
 * six work operations are registered under the write intent; unknown or
 * invented operations (including any "complete from checklist", "occurred
 * because the date passed" or "auto-complete overdue" operation) fail
 * closed `unsupported`; wrong-vocabulary input fails `validation` BEFORE
 * any handler runs; no resolved identity means `unauthenticated`; the
 * decoded inputs carry no clock and no checklist progress; and the schema
 * fragment's vocabulary pins.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  parseTableId,
  workEvents,
  workOperations,
} from "@kiero/contracts";
import { dispatchCommand, type RequestContext } from "@kiero/runtime";
import { workHandlers } from "../../convex/work/dispatch";
import { workLanePolicy } from "../../convex/work/policy";
import { workTables } from "../../convex/work/schema";

function contextFixture(role: "admin" | "member"): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: role,
    isGm: false,
    sessionId: parseTableId("sessions", "s1"),
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() };
}

const envelope = (operation: string, input: unknown) => ({
  operation,
  input,
  expectedRevisions: [],
});

const taskId = () => parseTableId("tasks", "t1");
const projectId = () => parseTableId("projects", "p1");
const eventId = () => parseTableId("events", "e1");

const validTask = () => ({
  taskId: null,
  projectId: projectId(),
  title: "Odebrać dostawę",
  executorContactId: null,
  coordinatorMembershipId: null,
  deadlineFindingId: null,
  expectedRevision: 1,
});

describe("the C4 work handler registration", () => {
  it("registers exactly the six contract operations of the work surface", () => {
    const handlers = workHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "work.changeChecklistItem",
      "work.changeEvent",
      "work.changeEventState",
      "work.changeTask",
      "work.changeTaskState",
      "work.promoteChecklistItem",
    ]);
    expect(Object.keys(workOperations).sort()).toEqual(Object.keys(handlers).sort());
  });

  it("binds every operation to the write intent (boss-level collaborative work)", () => {
    for (const binding of Object.values(workHandlers())) {
      expect(binding.intent).toBe("write");
    }
  });

  it("fails closed on invented operations: no automatic completion or occurrence exists", async () => {
    for (const operation of [
      "work.completeTaskFromChecklist",
      "work.markEventOccurredOnElapsedDate",
      "work.autoCompleteOverdue",
      "work.reopenOnChecklistChange",
      "work.assignCoordinatorToAuthor",
    ]) {
      const result = await dispatchCommand(
        {
          resolveContext: async () => contextFixture("admin"),
          policy: workLanePolicy,
          // An invented name is unknown at the COMPOSED registry (step 2 of
          // the checked path), so no handler table is ever consulted.
          handlers: {},
        },
        null,
        envelope(operation, {}),
      );
      expect(result._tag, operation).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("unsupported");
        expect(result.error.code).toBe("unknown_operation");
      }
    }
  });

  it("never invokes a handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const cases: ReadonlyArray<[string, unknown]> = [
      // Task states are a closed vocabulary; no "blocked"/"paused" exists.
      ["work.changeTaskState", { taskId: taskId(), expectedRevision: 1, state: "blocked" }],
      ["work.changeTaskState", { taskId: taskId(), expectedRevision: 1, state: "paused" }],
      ["work.changeTaskState", { taskId: taskId(), expectedRevision: 1, state: "Wykonane" }],
      // A missing state is not a command.
      ["work.changeTaskState", { taskId: taskId(), expectedRevision: 1 }],
      // An empty reason is not a reason (the schema requires non-empty).
      ["work.changeTaskState", { taskId: taskId(), expectedRevision: 1, state: "waiting", waitingReason: "" }],
      // Event states: no "happened"/"delivered".
      ["work.changeEventState", { eventId: eventId(), expectedRevision: 1, state: "happened" }],
      ["work.changeEventState", { eventId: eventId(), expectedRevision: 1, state: "delivered" }],
      // Checklist marks: no "done"/"partial".
      ["work.changeChecklistItem", { taskId: taskId(), itemId: null, description: "x", state: "done", expectedRevision: 1 }],
      // expectedRevision is a positive integer.
      ["work.changeTask", { ...validTask(), expectedRevision: 0 }],
      ["work.changeTask", { ...validTask(), expectedRevision: 1.5 }],
      // Titles and descriptions are non-empty strings.
      ["work.changeTask", { ...validTask(), title: "" }],
      ["work.changeEvent", { eventId: null, projectId: projectId(), title: "", timeFindingId: null, expectedRevision: 1 }],
      // Required references cannot be omitted.
      ["work.changeTask", { taskId: null, title: "x", expectedRevision: 1 }],
      ["work.promoteChecklistItem", { taskId: taskId(), expectedRevision: 1 }],
    ];
    for (const [operation, input] of cases) {
      const result = await dispatchCommand(
        {
          resolveContext: async () => contextFixture("member"),
          policy: workLanePolicy,
          handlers: { [operation]: { intent: "write", run: handler } },
        },
        undefined,
        envelope(operation, input),
      );
      expect(result._tag, `${operation}: ${JSON.stringify(input)}`).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, `${operation}: ${JSON.stringify(input)}`).toBe("validation");
      }
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("decodes well-formed commands, with the optional basis and link keys absent by default", () => {
    const task = Schema.decodeUnknownSync(workOperations["work.changeTask"].input)(validTask());
    expect(task.basisSourceId).toBeUndefined();
    expect(task.linkedEventId).toBeUndefined();
    const withBasis = Schema.decodeUnknownSync(workOperations["work.changeTask"].input)({
      ...validTask(),
      basisSourceId: parseTableId("sources", "src1"),
      linkedEventId: eventId(),
    });
    expect(withBasis.basisSourceId).toBe("src1");
    expect(withBasis.linkedEventId).toBe("e1");
    const waiting = Schema.decodeUnknownSync(workOperations["work.changeTaskState"].input)({
      taskId: taskId(),
      expectedRevision: 3,
      state: "waiting",
      waitingReason: "czekamy na okna",
    });
    expect(waiting.waitingReason).toBe("czekamy na okna");
  });

  it("gives the handler no clock and no checklist progress, whatever the caller sends", () => {
    // Excess keys are dropped by the contract decode: even a caller that
    // sends "now" or "checkedCount" cannot get them to a handler. There is
    // no field through which time or list progress enters a state command.
    const decoded = Schema.decodeUnknownSync(workOperations["work.changeTaskState"].input)({
      taskId: taskId(),
      expectedRevision: 1,
      state: "done",
      nowMs: 1,
      checkedCount: 3,
      totalCount: 3,
      elapsed: true,
    });
    expect(Object.keys(decoded).sort()).toEqual(["expectedRevision", "state", "taskId"]);
    const eventDecoded = Schema.decodeUnknownSync(workOperations["work.changeEventState"].input)({
      eventId: eventId(),
      expectedRevision: 1,
      state: "occurred",
      nowMs: 1,
      datePassed: true,
    });
    expect(Object.keys(eventDecoded).sort()).toEqual(["eventId", "expectedRevision", "state"]);
  });

  it("denies work commands without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: workLanePolicy,
        handlers: { "work.changeTask": { intent: "write", run: handler } },
      },
      undefined,
      envelope("work.changeTask", validTask()),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the C4 policy registration", () => {
  it("is the C4 registration over the platform seam", () => {
    expect(workLanePolicy.policyId).toBe("work.c4-work-v1");
  });

  it("allows any active boss (member or admin) to write work", async () => {
    for (const role of ["member", "admin"] as const) {
      const decision = await workLanePolicy.authorize(contextFixture(role), { intent: "write" });
      expect(decision.allowed).toBe(true);
    }
    const denied = await workLanePolicy.authorize(null, { intent: "write" });
    expect(denied.allowed).toBe(false);
  });
});

describe("the work events and schema fragment", () => {
  it("declares the five canonical work events, including the C4 eventChanged addition", () => {
    expect(Object.keys(workEvents).sort()).toEqual([
      "work.checklistItemChanged",
      "work.eventChanged",
      "work.eventStateChanged",
      "work.taskChanged",
      "work.taskStateChanged",
    ]);
    const payload = Schema.decodeUnknownSync(workEvents["work.taskStateChanged"].payload)({
      taskId: taskId(),
      fromState: "todo",
      toState: "done",
    });
    expect(payload.toState).toBe("done");
    expect(() =>
      Schema.decodeUnknownSync(workEvents["work.taskStateChanged"].payload)({
        taskId: taskId(),
        fromState: "todo",
        toState: "finished",
      }),
    ).toThrow();
  });

  it("owns exactly the four work tables, history included", () => {
    expect(Object.keys(workTables).sort()).toEqual(["checklistItems", "events", "tasks", "workRevisions"]);
  });
});
