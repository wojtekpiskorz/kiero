/**
 * F4 durable-edge tests: the outbox projections, the registered executor,
 * the C4 integration (a boss-created own task still gets its reminder) and
 * the checked dispatch surface (the split from tests/f4/reminders.test.ts
 * is PR #102 review round 1; fixtures live in tests/f4/fixtures.ts).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { okResult, parseTableId } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy } from "@kiero/runtime";
import { valueOf } from "../d2/harness";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { performChangeTask } from "../../convex/work/operations";
import { taskRemindersExecutor } from "../../convex/attention/reminders/executor";
import { remindersHandlers } from "../../convex/attention/reminders/dispatch";
import {
  T0,
  contextOf,
  contextOfFixture,
  db,
  evaluate,
  jobOf,
  recompute,
  remindersOf,
  seedDeadline,
  seedFirm,
  seedProject,
  seedTask,
  summariesOf,
  tx,
  useFakeContext,
  reviseDeadline,
} from "./fixtures";

beforeEach(() => {
  useFakeContext();
});

describe("the outbox projections", () => {
  it("projects the work events onto the reminder job with the row's identity", () => {
    const taskChanged = projectEventToJobInputs(
      "work.taskChanged",
      { taskId: "k task 1" },
      "work.taskChanged:ktask1:2",
    );
    expect(taskChanged).toHaveLength(1);
    expect(taskChanged[0]).toMatchObject({
      kind: "job",
      jobKind: "attention.schedule_task_reminders",
      input: { trigger: "task_changed", taskId: "k task 1", findingId: null },
      dedupKey: "work.taskChanged:ktask1:2",
    });
    const stateChanged = projectEventToJobInputs(
      "work.taskStateChanged",
      { taskId: "k task 1", fromState: "todo", toState: "done" },
      "work.taskStateChanged:ktask1:2",
    );
    // Both work events share the one `task_changed` reaction (PR #102
    // review round 1 dropped the never-produced `task_state_changed`).
    expect(stateChanged[0]).toMatchObject({
      kind: "job",
      input: { trigger: "task_changed" },
    });
    const revised = projectEventToJobInputs(
      "memory.findingRevised",
      { findingId: "kfinding1", revisionId: "krevision9", supersedesRevisionId: null },
      "memory.findingRevised:krevision9",
    );
    // The event fans out to C5's recompute walk AND F4's reminder edge.
    // E5 appended the derived-search refresh beside C5 and F4: three edges.
    expect(revised).toHaveLength(3);
    const reminderEdge = revised.find(
      (projection) =>
        projection.kind === "job" && projection.jobKind === "attention.schedule_task_reminders",
    )!;
    expect(reminderEdge).toMatchObject({
      kind: "job",
      input: { trigger: "finding_revised", taskId: null, findingId: "kfinding1" },
      // Payload-derived identity: the event fans out to C5's edge under the
      // row's key, and one dedup key may never carry two job kinds.
      dedupKey: "attention.schedule_task_reminders:finding:kfinding1:krevision9",
    });
  });
});

describe("the reminder executor", () => {
  it("recomputes the task's schedule from the job input", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    const task = await seedTask(firm, projectId, {
      deadlineFindingId,
      coordinatorMembershipId: firm.membershipA,
    });
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k1"), {
      trigger: "task_changed",
      taskId: task.taskId,
      findingId: null,
    });
    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
  });

  it("recomputes every task bound to a revised deadline finding", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    const t1 = await seedTask(firm, projectId, { deadlineFindingId });
    const t2 = await seedTask(firm, projectId, { deadlineFindingId });
    await recompute(t1.taskId, T0);
    await recompute(t2.taskId, T0);
    // The correction moves the term; the finding_revised job recomputes both.
    await reviseDeadline(firm, deadlineFindingId, { day: "2026-09-15" });
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k2"), {
      trigger: "finding_revised",
      taskId: null,
      findingId: deadlineFindingId,
    });
    expect(outcome).toEqual({ outcome: "succeeded" });
    for (const task of [t1, t2]) {
      const bossRow = db()
        .rows("notificationIntents")
        .filter((row) => row.taskId === task.taskId && row.state === "pending");
      expect(bossRow).toHaveLength(6); // 3 bosses x 2 slots, unassigned tasks
      const anchor = db()
        .rows("reminderSchedules")
        .find((row) => row.taskId === task.taskId)!;
      expect(anchor.termAnchor).toBe("day:2026-09-15");
    }
  });

  it("fails closed on malformed input", async () => {
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k3"), {
      trigger: "task_changed",
      taskId: null,
      findingId: null,
    });
    expect(outcome).toMatchObject({ outcome: "failed", errorKind: "task_id_missing" });
  });
});

describe("the C4 integration: a boss-created own task still gets its reminder", () => {
  it("creates and delivers the creating boss's reminder through the real work transaction", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    // The boss creates their OWN task and coordinates it themselves (the
    // source-entry author exclusion deliberately does not exist here).
    const created = await performChangeTask(tx(), contextOf(firm, firm.bossA), {
      taskId: null,
      projectId: parseTableId("projects", projectId)!,
      title: "Zadanie szefa",
      executorContactId: null,
      coordinatorMembershipId: parseTableId("memberships", firm.membershipA)!,
      deadlineFindingId: parseTableId("findings", deadlineFindingId)!,
      expectedRevision: 1,
    });
    expect(created._tag).toBe("ok");
    const taskId = (valueOf(created) as { taskId: string }).taskId;
    const taskRow = (await db().get(taskId))!;
    expect(taskRow.coordinatorMembershipId).toBe(firm.membershipA);
    // The canonical task event the durable edge consumes.
    const events = db()
      .rows("outboxEvents")
      .filter((row) => row.eventName === "work.taskChanged");
    expect(events).toHaveLength(1);
    // The recompute runs (the executor's transaction) and the CREATING
    // boss receives their own reminder, unlike a source entry.
    await recompute(taskId, T0);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The checked dispatch surface.
// ---------------------------------------------------------------------------

describe("the reminder handler registration", () => {
  it("registers exactly the two contract operations of this lane", () => {
    const handlers = remindersHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "attention.evaluateDueReminders",
      "attention.snoozeTaskReminders",
    ]);
    for (const binding of Object.values(handlers)) {
      expect(binding.intent).toBe("write");
    }
  });

  it("fails closed on invented reminder operations", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextOfFixture(),
        policy: membershipPolicy,
        handlers: {
          "attention.snoozeTaskReminders": { intent: "write", run: async () => okResult({}) },
        },
      },
      null,
      { operation: "attention.clearTaskReminders", input: {}, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("never invokes the handler when the contract rejects the input", async () => {
    const handlerRun = { called: false };
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextOfFixture(),
        policy: membershipPolicy,
        handlers: {
          "attention.snoozeTaskReminders": {
            intent: "write",
            run: async () => {
              handlerRun.called = true;
              return okResult({});
            },
          },
        },
      },
      null,
      { operation: "attention.snoozeTaskReminders", input: { taskId: 42 }, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    expect(handlerRun.called).toBe(false);
  });
});
