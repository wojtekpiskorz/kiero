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
  // F1 amendment (issue #41, flagged in the issue report): the A2 candidate
  // input expressed the mute vocabulary as per-source ids, but the accepted
  // product decision (issue 7 resolution: "Nowe wpisy, odbiorcy i
  // grupowanie" / "Przypomnienia o zadaniach" / "Podgląd, otwarcie i
  // urządzenia") defines PERSONAL mutes per project conversation, a separate
  // personal mute of company entries, a separate personal task-reminder
  // mute, a personal preview-content preference and personal quiet hours in
  // the company timezone. The input is therefore the decision's vocabulary
  // as independent PATCH keys: an omitted key leaves that control unchanged
  // (issue 41 acceptance: the controls "can be changed independently"), and
  // `quietHours: null` reverts to the company default window. No operation
  // or event name changed; nothing implemented or consumed the candidate
  // shape (dispatch failed closed `unsupported` until F1).
  "attention.changeNotificationPreferences": operationEntry({
    kind: "operation",
    name: "attention.changeNotificationPreferences",
    input: Schema.Struct({
      mutedProjectIds: Schema.optionalKey(Schema.Array(tableIdSchema("projects"))),
      companyEntriesMuted: Schema.optionalKey(Schema.Boolean),
      taskRemindersMuted: Schema.optionalKey(Schema.Boolean),
      hidePreviewContent: Schema.optionalKey(Schema.Boolean),
      quietHours: Schema.optionalKey(
        Schema.NullOr(
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
  // F3 amendment (issue #43, flagged in the sibling pattern - the F1
  // input-shape precedent): the candidate input lacked the device label
  // the settings screen shows ("To urządzenie" of each browser), so the
  // optional `deviceLabel` joins additively; the subscription still binds
  // to the RESOLVED actor (user, company, session), never to client
  // assertions. Re-registering an existing endpoint is the browser's
  // renewal path and refreshes keys in place.
  "attention.registerPushSubscription": operationEntry({
    kind: "operation",
    name: "attention.registerPushSubscription",
    input: Schema.Struct({
      endpoint: Schema.NonEmptyString,
      p256dhKeyBase64: Schema.NonEmptyString,
      authKeyBase64: Schema.NonEmptyString,
      deviceLabel: Schema.optionalKey(Schema.String),
    }),
    result: Schema.Struct({ pushSubscriptionId: tableIdSchema("pushSubscriptions") }),
    errorKinds: ["forbidden", "validation"],
  }),
  // F3 amendment (issue #43): removing this device's subscription. The
  // screen offers enabling/removing THIS device; removal is idempotent and
  // only ever touches the actor's OWN subscription row.
  "attention.revokePushSubscription": operationEntry({
    kind: "operation",
    name: "attention.revokePushSubscription",
    input: Schema.Struct({
      pushSubscriptionId: tableIdSchema("pushSubscriptions"),
    }),
    result: Schema.Struct({ revoked: Schema.Literal("revoked") }),
    errorKinds: ["forbidden", "not_found"],
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
