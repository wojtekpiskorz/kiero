/**
 * Shared fixtures for the F4 transactional test suites (the pure model
 * lives in tests/f4/model.test.ts; the split is PR #102 review round 1).
 *
 * One module-level fake context (tests/d2/harness.ts) reset per test, the
 * seeded firm/project/deadline/task rows, the unwrapped recompute and
 * evaluator helpers, and the intent/summary readers the suites assert
 * with. Every helper is deterministic under the fixed T0 anchor.
 */

import { Schema } from "effect";
import { ActorContext, parseTableId } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import {
  performEvaluateDueReminders,
  performRecomputeTaskReminders,
} from "../../convex/attention/reminders/operations";
import { asTx, fakeCtx, valueOf, type FakeCtx } from "../d2/harness";

/** The tables the reminder transactions touch (the harness fakes them). */
export const TABLES = [
  "companies",
  "users",
  "memberships",
  "projects",
  "findings",
  "findingRevisions",
  "tasks",
  "notificationIntents",
  "notificationPreferences",
  "readStates",
  "reminderSchedules",
  "reminderSnoozes",
  "outboxEvents",
  "durableJobs",
  "workRevisions",
  "sources",
] as const;

/** Warsaw anchors: September 2026 is CEST (UTC+2). */
export const T0 = Date.parse("2026-09-09T10:00:00.000Z"); // 12:00 Warsaw: outside quiet hours
export const WARSAW = "Europe/Warsaw";

let ctx: FakeCtx;

/** Resets the shared fake context (every test's beforeEach). */
export function useFakeContext(): void {
  ctx = fakeCtx([...TABLES]);
}

/** The transaction handle over the shared fake context. */
export function tx() {
  return asTx(ctx);
}

/** The raw fake db (row reads the assertions need). */
export function db() {
  return ctx.db;
}

/** The scheduler calls the durable chain registered (hop assertions). */
export function scheduled() {
  return ctx.scheduled;
}

/** The seeded firm: three bosses, one company. */
export interface Firm {
  readonly companyId: string;
  readonly bossA: string; // the (re)assigned coordinator
  readonly bossB: string; // the reassignment target / second boss
  readonly bossC: string; // the third boss (unassigned fan-out)
  readonly membershipA: string;
  readonly membershipB: string;
  readonly membershipC: string;
}

export async function seedFirm(): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: "F4 test firm",
    timezone: WARSAW,
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const bosses = await Promise.all(
    ["f4-a", "f4-b", "f4-c"].map(async (label) => {
      const userId = await ctx.db.insert("users", {
        email: `${label}@kiero.invalid`,
        displayName: label,
        createdAtMs: T0,
      });
      const membershipId = await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "member",
        state: "active",
        createdAtMs: T0,
      });
      return { userId, membershipId };
    }),
  );
  return {
    companyId,
    bossA: bosses[0]!.userId,
    bossB: bosses[1]!.userId,
    bossC: bosses[2]!.userId,
    membershipA: bosses[0]!.membershipId,
    membershipB: bosses[1]!.membershipId,
    membershipC: bosses[2]!.membershipId,
  };
}

export async function seedProject(firm: Firm, name = "Banan"): Promise<string> {
  return ctx.db.insert("projects", {
    companyId: firm.companyId,
    displayName: name,
    stage: "inquiry",
    createdAtMs: T0,
  });
}

/** One KNOWN temporal deadline finding (date-only day or zoned date/time). */
export async function seedDeadline(
  firm: Firm,
  projectId: string,
  term: { readonly day: string } | { readonly iso: string },
): Promise<string> {
  const shape =
    "day" in term
      ? { _tag: "day" as const, day: term.day }
      : { _tag: "date_time" as const, value: term.iso };
  const findingId = await ctx.db.insert("findings", {
    companyId: firm.companyId,
    scopeKind: "project",
    scopeProjectId: projectId,
    semanticKey: `f4-term-${shape._tag}-${Date.now()}-${Math.random()}`,
    knowledgeState: { _tag: "known" },
    revisionCounter: 1,
    updatedAtMs: T0,
  });
  const revisionId = await ctx.db.insert("findingRevisions", {
    findingId,
    revision: 1,
    value: {
      _tag: "temporal",
      temporal: { shape, originalExpression: "f4 test term", role: "agreed" },
    },
    knowledgeState: { _tag: "known" },
    origin: "publication",
    recordedByUserId: firm.bossA,
    recordedAtMs: T0,
  });
  await ctx.db.patch(findingId, { currentRevisionId: revisionId });
  return findingId;
}

/** Revises the finding's CURRENT term in place (a date correction). */
export async function reviseDeadline(
  firm: Firm,
  findingId: string,
  term: { readonly day: string } | { readonly iso: string },
): Promise<void> {
  const finding = (await ctx.db.get(findingId))!;
  const shape =
    "day" in term
      ? { _tag: "day" as const, day: term.day }
      : { _tag: "date_time" as const, value: term.iso };
  const revisionId = await ctx.db.insert("findingRevisions", {
    findingId,
    revision: (finding.revisionCounter as number) + 1,
    value: {
      _tag: "temporal",
      temporal: { shape, originalExpression: "f4 corrected term", role: "agreed" },
    },
    knowledgeState: { _tag: "known" },
    origin: "correction",
    recordedByUserId: firm.bossA,
    recordedAtMs: T0,
  });
  await ctx.db.patch(findingId, {
    currentRevisionId: revisionId,
    revisionCounter: (finding.revisionCounter as number) + 1,
    updatedAtMs: T0,
  });
}

export interface TaskFixture {
  readonly taskId: string;
  readonly deadlineFindingId: string | null;
}

/** One task row with optional deadline binding and coordinator. */
export async function seedTask(
  firm: Firm,
  projectId: string,
  options: {
    readonly deadlineFindingId?: string | undefined;
    readonly coordinatorMembershipId?: string | undefined;
    readonly state?: "todo" | "in_progress" | "waiting" | "done" | "cancelled";
    readonly revisionCounter?: number;
  } = {},
): Promise<TaskFixture> {
  const taskId = await ctx.db.insert("tasks", {
    companyId: firm.companyId,
    projectId,
    title: "Przygotować wycenę",
    state: options.state ?? "todo",
    ...(options.coordinatorMembershipId !== undefined
      ? { coordinatorMembershipId: options.coordinatorMembershipId }
      : {}),
    ...(options.deadlineFindingId !== undefined
      ? { deadlineFindingId: options.deadlineFindingId }
      : {}),
    revisionCounter: options.revisionCounter ?? 1,
    createdAtMs: T0,
    updatedAtMs: T0,
    stateChangedAtMs: T0,
  });
  return { taskId, deadlineFindingId: options.deadlineFindingId ?? null };
}

/** The task row's current revision (the fake row is unknown-typed). */
export async function revisionOf(taskId: string): Promise<number> {
  const row = await ctx.db.get(taskId);
  return (row?.revisionCounter as number | undefined) ?? 1;
}

/** The recompute transaction, unwrapped. */
export async function recompute(taskId: string, nowMs: number) {
  return valueOf(await performRecomputeTaskReminders(tx(), taskId as never, nowMs)) as {
    status: string;
    recipientCount: number;
    createdIntentIds: string[];
    suppressedIntentIds: string[];
    snoozesCleared: number;
  };
}

/** The evaluator sweep, unwrapped. */
export async function evaluate(nowMs: number) {
  return valueOf(await performEvaluateDueReminders(tx(), { nowMs })) as {
    evaluatedIntentIds: string[];
  };
}

/** One boss's task-reminder intents in one state, sorted by dedup key. */
export function remindersOf(userId: string, state?: string) {
  return ctx.db
    .rows("notificationIntents")
    .filter(
      (row) =>
        row.recipientUserId === userId &&
        row.semanticKind === "task_reminder" &&
        (state === undefined || row.state === state),
    )
    .sort((a, b) => String(a.dedupKey).localeCompare(String(b.dedupKey)));
}

/** The DISTINCT collapsed summaries delivered to one boss. */
export function summariesOf(userId: string) {
  const distinct = new Set(
    remindersOf(userId, "delivered").map((row) => String(row.deliveryJson)),
  );
  return [...distinct].map((json) => JSON.parse(json));
}

/** The PENDING reminder intent of one (user, kind). */
export function pendingOfKind(userId: string, kind: "pre_due" | "overdue") {
  return ctx.db
    .rows("notificationIntents")
    .find(
      (row) =>
        row.recipientUserId === userId &&
        row.semanticKind === "task_reminder" &&
        row.state === "pending" &&
        JSON.parse(String(row.payloadJson)).reminderKind === kind,
    )!;
}

/** One dated task with a coordinator, recomputed at `nowMs`. */
export async function datedTask(
  firm: Firm,
  projectId: string,
  term: { readonly day: string } | { readonly iso: string },
  coordinatorMembershipId: string | undefined,
  nowMs: number,
): Promise<TaskFixture> {
  const deadlineFindingId = await seedDeadline(firm, projectId, term);
  const task = await seedTask(firm, projectId, {
    deadlineFindingId,
    coordinatorMembershipId,
  });
  await recompute(task.taskId, nowMs);
  return task;
}

/** A context fixture independent of the seeded firm (the dispatch surface). */
export function contextOfFixture(): RequestContext {
  return contextOf({ companyId: "k0000company00000000000" }, "k0000user00000000000000");
}

/** One request context for a seeded boss (canonical actor shape). */
export function contextOf(firm: { readonly companyId: string }, userId: string): RequestContext {
  return {
    actor: Schema.decodeUnknownSync(ActorContext)({
      userId: parseTableId("users", userId),
      companyId: parseTableId("companies", firm.companyId),
      membershipRole: "member",
      isGm: false,
      sessionId: parseTableId("sessions", "k0000session00000000"),
      via: "user",
    }),
    resolvedAtMs: T0,
  };
}

/** One durable-job row stand-in (only kind/jobKey are read). */
export function jobOf(jobKey: string) {
  return {
    _id: "kjob",
    jobKey,
    kind: "attention.schedule_task_reminders",
    state: "running",
    attempts: 1,
    maxAttempts: 3,
    inputJson: "{}",
    createdAtMs: T0,
    updatedAtMs: T0,
  } as never;
}
