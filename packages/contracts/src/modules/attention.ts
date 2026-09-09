/**
 * Attention module surface (architecture "Deep modules": Notifications).
 * Implements lanes: F1 (read state/preferences), F2 (intents/batching),
 * F3 (push), F4 (reminders/snooze).
 *
 * Read state belongs to the logical source and the user: seeing the original
 * in any view marks it everywhere for that person. Reminders are based on
 * tasks, never on conversation read state. Quiet hours defer push delivery
 * without hiding information. A reminder for a contested date stays suspended
 * (issue 8/9).
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { operationEntry, eventEntry } from "./registration";

export const attentionOperations = {
  "attention.markSourceRead": operationEntry({
    kind: "operation",
    name: "attention.markSourceRead",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      read: Schema.Boolean,
    }),
    result: Schema.Struct({ sourceId: tableIdSchema("sources") }),
    errorKinds: ["forbidden", "not_found"],
  }),
  "attention.changeNotificationPreferences": operationEntry({
    kind: "operation",
    name: "attention.changeNotificationPreferences",
    input: Schema.Struct({
      mutedSourceIds: Schema.Array(tableIdSchema("sources")),
      quietHours: Schema.NullOr(
        Schema.Struct({
          startMinuteOfDay: Schema.Number.pipe(
            Schema.check(Schema.isInt()),
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
          ),
          endMinuteOfDay: Schema.Number.pipe(
            Schema.check(Schema.isInt()),
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
          ),
        }),
      ),
    }),
    result: Schema.Struct({ changed: Schema.Literal("changed") }),
    errorKinds: ["forbidden", "validation"],
  }),
  "attention.snoozeTaskReminders": operationEntry({
    kind: "operation",
    name: "attention.snoozeTaskReminders",
    input: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      untilMs: Schema.Number,
    }),
    result: Schema.Struct({ taskId: tableIdSchema("tasks") }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
  "attention.registerPushSubscription": operationEntry({
    kind: "operation",
    name: "attention.registerPushSubscription",
    input: Schema.Struct({
      endpoint: Schema.NonEmptyString,
      p256dhKeyBase64: Schema.NonEmptyString,
      authKeyBase64: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ pushSubscriptionId: tableIdSchema("pushSubscriptions") }),
    errorKinds: ["forbidden", "validation"],
  }),
  "attention.evaluateDueIntents": operationEntry({
    kind: "operation",
    name: "attention.evaluateDueIntents",
    input: Schema.Struct({ nowMs: Schema.Number }),
    result: Schema.Struct({ evaluatedIntentIds: Schema.Array(tableIdSchema("notificationIntents")) }),
    errorKinds: ["forbidden"],
  }),
} as const;

export const attentionEvents = {
  "attention.sourceReadChanged": eventEntry({
    kind: "event",
    name: "attention.sourceReadChanged",
    payload: Schema.Struct({
      userId: tableIdSchema("users"),
      sourceId: tableIdSchema("sources"),
      read: Schema.Boolean,
    }),
  }),
  "attention.reminderSnoozed": eventEntry({
    kind: "event",
    name: "attention.reminderSnoozed",
    payload: Schema.Struct({
      userId: tableIdSchema("users"),
      taskId: tableIdSchema("tasks"),
    }),
  }),
  "attention.intentDelivered": eventEntry({
    kind: "event",
    name: "attention.intentDelivered",
    payload: Schema.Struct({
      notificationIntentId: tableIdSchema("notificationIntents"),
      outcome: Schema.Literals(["delivered", "suppressed", "failed"]),
    }),
  }),
} as const;
