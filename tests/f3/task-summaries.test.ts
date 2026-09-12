/**
 * F3/R3 focused verification (issue #128): the TYPED delivery-summary
 * surface. F4 writes task-reminder deliveryJson with `taskIds` and NO
 * `scope` (convex/attention/reminders/operations.ts), so the push prepare
 * must decode that summary through a runtime-decoded union (never a cast
 * after JSON.parse), render bounded Polish reminder copy from CURRENT
 * task rows, and emit an allowed relative target. Completed, deleted and
 * cross-company tasks suppress. Source and clarification adapters recheck
 * R2's lifecycle state immediately before transport, and every retry
 * reloads the payload instead of replaying the stored one.
 *
 * The red test this file started from: prepare of an F4-shaped summary
 * crashed reading `summary.scope.projectIds` of a summary that has no
 * scope (the integration defect the 2026-09-12 map review recorded).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asTx, fakeCtx, type FakeCtx } from "../d2/harness";
import {
  performCompletePushLegs,
  performPreparePushDelivery,
  performStalePendingIntentIds,
} from "../../convex/attention/push/operations";
import {
  composePushPayload,
  decodeDeliverySummary,
  type TaskPreview,
} from "../../convex/attention/push/model";

/** RFC 8291-shaped fixture keys: 65-byte 0x04-prefixed point, 16-byte auth. */
const VALID_P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "projects",
  "sources",
  "attachments",
  "sourceFragments",
  "clarifications",
  "tasks",
  "notificationPreferences",
  "notificationIntents",
  "pushSubscriptions",
  "pushDeliveries",
  "notificationAttempts",
  "outboxEvents",
  "durableJobs",
] as const;

const T0 = Date.parse("2026-09-09T10:00:00.000Z");

let ctx: FakeCtx;
const tx = () => asTx(ctx);

interface Firm {
  readonly companyId: string;
  readonly authorId: string;
  readonly bossId: string;
  readonly otherCompanyId: string;
  readonly sessionId: string;
}

async function seedFirm(): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: "R3 test firm",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const authorId = await ctx.db.insert("users", {
    email: "r3-author@kiero.invalid",
    displayName: "Autor",
    createdAtMs: T0,
  });
  const bossId = await ctx.db.insert("users", {
    email: "r3-boss@kiero.invalid",
    displayName: "Anna",
    createdAtMs: T0,
  });
  for (const userId of [authorId, bossId]) {
    await ctx.db.insert("memberships", {
      companyId,
      userId,
      role: "member",
      state: "active",
      createdAtMs: T0,
    });
  }
  const sessionId = await ctx.db.insert("sessions", {
    userId: bossId,
    startedAtMs: T0,
    lastSeenAtMs: T0,
    deviceLabel: "telefon Anny",
  });
  const otherCompanyId = await ctx.db.insert("companies", {
    name: "R3 other firm",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  return { companyId, authorId, bossId, otherCompanyId, sessionId };
}

async function seedSubscription(firm: Firm): Promise<void> {
  await ctx.db.insert("pushSubscriptions", {
    userId: firm.bossId,
    companyId: firm.companyId,
    sessionId: firm.sessionId,
    endpoint: "https://push.example.net/p/r3-1",
    p256dhKeyBase64: VALID_P256DH,
    authKeyBase64: VALID_AUTH,
    deviceLabel: "telefon Anny",
    createdAtMs: T0,
  });
}

interface TaskSeed {
  readonly title?: string;
  readonly state?: string;
  readonly companyId?: string;
}

async function seedTask(firm: Firm, seed: TaskSeed = {}): Promise<string> {
  return await ctx.db.insert("tasks", {
    companyId: seed.companyId ?? firm.companyId,
    projectId: undefined,
    title: seed.title ?? "Przygotować wycenę dla Kaczmarka",
    state: seed.state ?? "todo",
    revisionCounter: 1,
    createdAtMs: T0,
    updatedAtMs: T0,
    stateChangedAtMs: T0,
  });
}

/** One delivered intent carrying an F4-shaped summary (taskIds, no scope). */
async function seedTaskReminderIntent(
  firm: Firm,
  taskIds: readonly string[],
  options: { readonly reminderKinds?: readonly string[] } = {},
): Promise<string> {
  return await ctx.db.insert("notificationIntents", {
    companyId: firm.companyId,
    recipientUserId: firm.bossId,
    semanticKind: "task_reminder",
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : {}),
    dedupKey: `task_reminder:${taskIds.join("|")}:${firm.bossId}`,
    state: "delivered",
    dueAtMs: T0 + 60_000,
    deliveryJson: JSON.stringify({
      semanticKind: "task_reminder",
      bucket: "task_reminders",
      taskIds,
      reminderKinds: options.reminderKinds ?? taskIds.map(() => "pre_due"),
      deliveredAtMs: T0 + 60_000,
    } satisfies Record<string, unknown>),
    deliveredAtMs: T0 + 60_000,
    payloadJson: "{}",
    createdAtMs: T0,
  });
}

/** One delivered source_entry intent for the boss (the F2 summary shape). */
async function seedSourceEntryIntent(
  firm: Firm,
  options: {
    readonly authorText?: string;
    readonly lifecycle?: string;
    readonly sourceIds?: string[];
  } = {},
): Promise<{ intentId: string; sourceId: string }> {
  const sourceId = await ctx.db.insert("sources", {
    companyId: firm.companyId,
    authorUserId: firm.authorId,
    authorText: options.authorText ?? "Klient potwierdził termin na piątek.",
    sentAtMs: T0,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: T0,
    lifecycle: options.lifecycle ?? "active",
  });
  const sourceIds = options.sourceIds ?? [sourceId];
  const intentId = await ctx.db.insert("notificationIntents", {
    companyId: firm.companyId,
    recipientUserId: firm.bossId,
    semanticKind: "source_entry",
    sourceId,
    dedupKey: `source_entry:${sourceId}:${firm.bossId}`,
    state: "delivered",
    dueAtMs: T0 + 60_000,
    deliveryJson: JSON.stringify({
      semanticKind: "source_entry",
      bucket: "company",
      scope: { kind: "company", projectIds: [] },
      sourceIds,
      clarificationIds: [],
      deliveredAtMs: T0 + 60_000,
    }),
    deliveredAtMs: T0 + 60_000,
    payloadJson: "{}",
    createdAtMs: T0,
  });
  return { intentId, sourceId };
}

/** One delivered clarification intent (the F2 summary shape). */
async function seedClarificationIntent(
  firm: Firm,
  options: {
    readonly question?: string;
    readonly state?: string;
    readonly redacted?: boolean;
  } = {},
): Promise<{ intentId: string; clarificationId: string }> {
  const clarificationId = await ctx.db.insert("clarifications", {
    companyId: firm.companyId,
    scopeKind: "company",
    question: options.question ?? "Który termin betonowania jest właściwy?",
    conflictingFragmentIds: [],
    state: options.state ?? "open",
    raisedAtMs: T0,
    ...(options.redacted
      ? {
          purgeAudit: {
            redactedSourceIds: ["k1234567890123456789zz"],
            questionRedactedAtMs: T0,
          },
        }
      : {}),
  });
  const intentId = await ctx.db.insert("notificationIntents", {
    companyId: firm.companyId,
    recipientUserId: firm.bossId,
    semanticKind: "clarification",
    clarificationId,
    dedupKey: `clarification:${clarificationId}:${firm.bossId}`,
    state: "delivered",
    dueAtMs: T0 + 60_000,
    deliveryJson: JSON.stringify({
      semanticKind: "clarification",
      bucket: "clarification:company",
      scope: { kind: "company", projectIds: [] },
      sourceIds: [],
      clarificationIds: [clarificationId],
      deliveredAtMs: T0 + 60_000,
    }),
    deliveredAtMs: T0 + 60_000,
    payloadJson: "{}",
    createdAtMs: T0,
  });
  return { intentId, clarificationId };
}

beforeEach(() => {
  ctx = fakeCtx([...TABLES]);
});

// ---------------------------------------------------------------------------
// The red integration defect: F4's summary shape must reach the transport.
// ---------------------------------------------------------------------------

describe("F4 task-reminder summaries (taskIds, no scope)", () => {
  it("RED baseline: prepare decodes the F4 deliveryJson and delivers bounded Polish copy", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, {
      title: "Przygotować wycenę dla Kaczmarka",
    });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);

    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error("unreachable");
    }
    expect(prepared.legs).toHaveLength(1);
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload).toMatchObject({
      v: 1,
      kind: "task_reminder",
      title: "Przypomnienie o zadaniu",
      body: "Przygotować wycenę dla Kaczmarka",
    });
    // The allowed relative target of the accepted task record route.
    expect(payload.data).toMatchObject({
      taskIds: [taskId],
      target: `/praca?zadanie=${taskId}`,
    });
  });

  it("collapses several open tasks into ONE current reminder with a bounded body", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const first = await seedTask(firm, { title: "Przygotować wycenę" });
    const second = await seedTask(firm, { title: "Zadzwonić do Kaczmarka" });
    const intentId = await seedTaskReminderIntent(firm, [first, second]);

    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.title).toBe("Przypomnienia o zadaniach (2)");
    expect(payload.body).toBe("Przygotować wycenę (i 1 więcej)");
    expect(payload.data.taskIds).toEqual([first, second].sort());
    expect(payload.data.target).toBe(
      `/praca?zadanie=${[first, second].sort()[0]}`,
    );
  });

  it("bounds the reminder copy to the shared fragment limit", async () => {
    const long = "zadanie ".repeat(40);
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, { title: long });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.body.length).toBeLessThanOrEqual(121);
    expect(payload.body).not.toContain(long.trim());
  });

  it("honors hide-preview with the neutral notice while keeping the target", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, { title: "Przygotować wycenę" });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    await ctx.db.insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossId,
      mutedProjectIds: [],
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: true,
      updatedAtMs: T0,
    });
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.title).toBe("Nowe powiadomienie");
    expect(payload.body).toBe("Otwórz Kiero, żeby zobaczyć.");
    expect(payload.data.target).toBe(`/praca?zadanie=${taskId}`);
  });
});

// ---------------------------------------------------------------------------
// The task rendering matrix: active, completed, missing, cross-company.
// ---------------------------------------------------------------------------

describe("the task rendering matrix", () => {
  it("an ACTIVE task renders (todo, in_progress and waiting are all open work)", async () => {
    for (const state of ["todo", "in_progress", "waiting"]) {
      const firm = await seedFirm();
      await seedSubscription(firm);
      const taskId = await seedTask(firm, { state });
      const intentId = await seedTaskReminderIntent(firm, [taskId]);
      const prepared = await performPreparePushDelivery(
        tx(),
        intentId as never,
      );
      expect(prepared.kind).toBe("prepared");
    }
  });

  it("a COMPLETED task suppresses: no delivery row, no leg, no fetch", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, { state: "done" });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
    expect(ctx.db.rows("pushDeliveries")).toHaveLength(0);
  });

  it("a CANCELLED task suppresses the same way", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, { state: "cancelled" });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("a MISSING task (deleted row) suppresses", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedTaskReminderIntent(firm, [
      "k1234567890123456789zz",
    ]);
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("a CROSS-COMPANY task suppresses (ids are routing hints, never access)", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const foreignTaskId = await seedTask(firm, {
      companyId: firm.otherCompanyId,
    });
    const intentId = await seedTaskReminderIntent(firm, [foreignTaskId]);
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("a mixed batch renders only the open tasks and routes only their ids", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const open = await seedTask(firm, { title: "Zamówić płytki" });
    const done = await seedTask(firm, {
      state: "done",
      title: "Wykonane already",
    });
    const foreign = await seedTask(firm, { companyId: firm.otherCompanyId });
    const intentId = await seedTaskReminderIntent(firm, [open, done, foreign]);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.title).toBe("Przypomnienie o zadaniu");
    expect(payload.body).toBe("Zamówić płytki");
    expect(payload.data.taskIds).toEqual([open]);
    expect(payload.data.target).toBe(`/praca?zadanie=${open}`);
  });

  it("a pending row whose tasks all closed is terminally suppressed, not re-driven", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm);
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    const first = await performPreparePushDelivery(tx(), intentId as never);
    if (first.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    // The task completes while the transport leg sits pending.
    await ctx.db.patch(taskId, { state: "done" });
    const retry = await performPreparePushDelivery(tx(), intentId as never);
    expect(retry).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
    const row = ctx.db.rows("pushDeliveries")[0]!;
    expect(row.state).toBe("suppressed");
    expect(row.lastErrorKind).toBe("content_no_longer_available");
    // The safety net never sees suppressed work as stale-pending input.
    expect(await performStalePendingIntentIds(tx())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The decoder matrix: three valid kinds, malformed, confirmation, foreign ids.
// ---------------------------------------------------------------------------

describe("the runtime delivery-summary decoder", () => {
  it("decodes the three valid summary kinds without unsafe casts", () => {
    const sourceEntry = decodeDeliverySummary(
      JSON.stringify({
        semanticKind: "source_entry",
        bucket: "company",
        scope: { kind: "company", projectIds: [] },
        sourceIds: ["k1111111111111111111111"],
        clarificationIds: [],
        deliveredAtMs: T0,
      }),
    );
    expect(sourceEntry.kind).toBe("decoded");
    if (
      sourceEntry.kind === "decoded" &&
      sourceEntry.summary.semanticKind === "source_entry"
    ) {
      expect(sourceEntry.summary.scope).toEqual({
        kind: "company",
        projectIds: [],
      });
    }

    const clarification = decodeDeliverySummary(
      JSON.stringify({
        semanticKind: "clarification",
        bucket: "clarification:company",
        scope: { kind: "project", projectIds: ["p1"] },
        sourceIds: [],
        clarificationIds: ["k2222222222222222222222"],
        deliveredAtMs: T0,
      }),
    );
    expect(clarification.kind).toBe("decoded");
    if (clarification.kind === "decoded") {
      expect(clarification.summary.semanticKind).toBe("clarification");
    }

    const task = decodeDeliverySummary(
      JSON.stringify({
        semanticKind: "task_reminder",
        bucket: "task_reminders",
        taskIds: ["k3333333333333333333333"],
        reminderKinds: ["pre_due"],
        deliveredAtMs: T0,
      }),
    );
    expect(task.kind).toBe("decoded");
    if (
      task.kind === "decoded" &&
      task.summary.semanticKind === "task_reminder"
    ) {
      expect(task.summary.taskIds).toEqual(["k3333333333333333333333"]);
    }
  });

  it("refuses malformed summaries (never JSON, wrong shapes, missing fields)", () => {
    expect(decodeDeliverySummary("not json").kind).toBe("invalid");
    expect(decodeDeliverySummary("null").kind).toBe("invalid");
    expect(decodeDeliverySummary("[]").kind).toBe("invalid");
    expect(decodeDeliverySummary("{}").kind).toBe("invalid");
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "source_entry",
          bucket: "company",
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "source_entry",
          bucket: "company",
          scope: { kind: "galaxy", projectIds: [] },
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "task_reminder",
          bucket: "task_reminders",
          taskIds: [],
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "task_reminder",
          bucket: "task_reminders",
          taskIds: [42],
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "mystery",
          bucket: "x",
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("invalid");
  });

  it("names the confirmation kind explicitly (F2 never pushes it)", () => {
    expect(
      decodeDeliverySummary(
        JSON.stringify({
          semanticKind: "confirmation",
          bucket: "x",
          deliveredAtMs: T0,
        }),
      ).kind,
    ).toBe("confirmation");
  });

  it("decodes foreign id SHAPES (ownership is the adapter's check, not the decoder's)", () => {
    const foreign = decodeDeliverySummary(
      JSON.stringify({
        semanticKind: "task_reminder",
        bucket: "task_reminders",
        taskIds: ["k9999999999999999999999"],
        deliveredAtMs: T0,
      }),
    );
    expect(foreign.kind).toBe("decoded");
  });

  it("prepare refuses malformed summaries BEFORE any delivery row exists", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await ctx.db.insert("notificationIntents", {
      companyId: firm.companyId,
      recipientUserId: firm.bossId,
      semanticKind: "source_entry",
      dedupKey: "source_entry:malformed",
      state: "delivered",
      dueAtMs: T0 + 60_000,
      deliveryJson: "{malformed",
      deliveredAtMs: T0 + 60_000,
      payloadJson: "{}",
      createdAtMs: T0,
    });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "summary_invalid",
    });
    expect(ctx.db.rows("pushDeliveries")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source and clarification preflight: R2 lifecycle immediately before transport.
// ---------------------------------------------------------------------------

describe("source and clarification preflight (R2 lifecycle)", () => {
  it("an ACTIVE source previews and targets its canonical dossier route", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId, sourceId } = await seedSourceEntryIntent(firm);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.body).toContain("Klient potwierdził termin na piątek.");
    expect(payload.data.target).toBe(`/zrodlo?zrodlo=${sourceId}`);
  });

  it("a WITHDRAWN source no longer notifies (F2's own lifecycle rule, rechecked)", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId } = await seedSourceEntryIntent(firm, {
      lifecycle: "withdrawn",
    });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("a PURGED source no longer notifies", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId } = await seedSourceEntryIntent(firm, {
      lifecycle: "purged",
    });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("an OPEN, unredacted clarification previews and targets the Co teraz route", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId } = await seedClarificationIntent(firm);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.title).toBe("Sprawa do wyjaśnienia: Firma");
    expect(payload.body).toBe("Który termin betonowania jest właściwy?");
    expect(payload.data.target).toBe("/co-teraz");
  });

  it("a REDACTED open case (R2's shared content rule) suppresses: no deleted-derived text leaves", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId } = await seedClarificationIntent(firm, {
      question: "Pytanie z usuniętej wiadomości?",
      redacted: true,
    });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });

  it("a RESOLVED clarification no longer notifies", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId } = await seedClarificationIntent(firm, {
      state: "resolved",
    });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
  });
});

// ---------------------------------------------------------------------------
// Every retry reloads the payload right before its transport attempt.
// ---------------------------------------------------------------------------

describe("retry reloads routing identities before each transport attempt", () => {
  it("a retried pending row carries the RE-COMPOSED payload, not the stored one", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const taskId = await seedTask(firm, { title: "Stary tytuł" });
    const intentId = await seedTaskReminderIntent(firm, [taskId]);
    const first = await performPreparePushDelivery(tx(), intentId as never);
    if (first.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    expect(JSON.parse(first.legs[0]!.payloadJson).body).toBe("Stary tytuł");

    // The transport defers (retry_later) and the task is retitled while the
    // row sits pending: the next attempt must reload current data.
    await performCompletePushLegs(tx(), [
      {
        deliveryId: first.legs[0]!.deliveryId,
        subscriptionId: first.legs[0]!.subscriptionId,
        report: { kind: "retry_later" },
      },
    ]);
    await ctx.db.patch(taskId, { title: "Nowy tytuł po edycji" });

    const retry = await performPreparePushDelivery(tx(), intentId as never);
    if (retry.kind !== "prepared") {
      throw new Error("expected prepared on retry");
    }
    expect(retry.legs).toHaveLength(1);
    expect(JSON.parse(retry.legs[0]!.payloadJson).body).toBe(
      "Nowy tytuł po edycji",
    );
    const stored = ctx.db.rows("pushDeliveries")[0]!;
    expect(JSON.parse(stored.payloadJson as string).body).toBe(
      "Nowy tytuł po edycji",
    );
  });

  it("a source retitled after prepare loses its preview only when the content died", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const { intentId, sourceId } = await seedSourceEntryIntent(firm);
    const first = await performPreparePushDelivery(tx(), intentId as never);
    if (first.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    // The source is withdrawn between attempts: the retry denies outright.
    await ctx.db.patch(sourceId, { lifecycle: "withdrawn" });
    const retry = await performPreparePushDelivery(tx(), intentId as never);
    expect(retry).toEqual({
      kind: "denied",
      reason: "content_no_longer_available",
    });
    const row = ctx.db.rows("pushDeliveries")[0]!;
    expect(row.state).toBe("suppressed");
    expect(JSON.stringify(row.payloadJson)).not.toContain("Klient potwierdził");
  });
});

// ---------------------------------------------------------------------------
// The pure task rendering core (bounded Polish copy, target, kinds).
// ---------------------------------------------------------------------------

describe("the pure task rendering core", () => {
  const taskSummary = {
    semanticKind: "task_reminder" as const,
    bucket: "task_reminders",
    taskIds: ["k1111111111111111111111"],
    reminderKinds: ["pre_due" as const],
    deliveredAtMs: T0,
  };

  function task(overrides: Partial<TaskPreview> = {}): TaskPreview {
    return {
      taskId: "k1111111111111111111111",
      title: "Przygotować wycenę",
      stillOpen: true,
      ...overrides,
    };
  }

  it("renders the glossary name with the bounded title and the record target", () => {
    const payload = composePushPayload({
      summary: taskSummary,
      scope: { kind: "company", projectNames: [] },
      sources: [],
      clarifications: [],
      tasks: [task()],
      hidePreview: false,
    });
    expect(payload.kind).toBe("task_reminder");
    expect(payload.title).toBe("Przypomnienie o zadaniu");
    expect(payload.body).toBe("Przygotować wycenę");
    expect(payload.data.taskIds).toEqual(["k1111111111111111111111"]);
    expect(payload.data.target).toBe("/praca?zadanie=k1111111111111111111111");
  });

  it("orders a batch by task id and labels the count", () => {
    const payload = composePushPayload({
      summary: taskSummary,
      scope: { kind: "company", projectNames: [] },
      sources: [],
      clarifications: [],
      tasks: [
        task({
          taskId: "k2222222222222222222222",
          title: "Zadzwonić do Kaczmarka",
        }),
        task({
          taskId: "k1111111111111111111111",
          title: "Przygotować wycenę",
        }),
      ],
      hidePreview: false,
    });
    expect(payload.title).toBe("Przypomnienia o zadaniach (2)");
    expect(payload.body).toBe("Przygotować wycenę (i 1 więcej)");
    expect(payload.data.taskIds).toEqual([
      "k1111111111111111111111",
      "k2222222222222222222222",
    ]);
    expect(payload.data.target).toBe("/praca?zadanie=k1111111111111111111111");
  });

  it("drops closed tasks and goes neutral when every task closed (pure path)", () => {
    const mixed = composePushPayload({
      summary: taskSummary,
      scope: { kind: "company", projectNames: [] },
      sources: [],
      clarifications: [],
      tasks: [
        task(),
        task({ taskId: "k3333333333333333333333", stillOpen: false }),
      ],
      hidePreview: false,
    });
    expect(mixed.title).toBe("Przypomnienie o zadaniu");
    expect(mixed.data.taskIds).toEqual(["k1111111111111111111111"]);
    const allClosed = composePushPayload({
      summary: taskSummary,
      scope: { kind: "company", projectNames: [] },
      sources: [],
      clarifications: [],
      tasks: [task({ stillOpen: false })],
      hidePreview: false,
    });
    expect(allClosed.title).toBe("Nowe powiadomienie");
  });
});
