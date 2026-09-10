/**
 * The Convex cron table (I2, carrying the A3 handoff note).
 *
 * A3's drain loop is event-driven (publish schedules drain atomically), so
 * no cron table existed for the composition proof. A3 explicitly noted that
 * "a cron table becomes worthwhile when business lanes publish" and handed
 * the upgrade to H4/I2: under total scheduler loss the event-driven kick
 * disappears, so the drain now also has a cron safety net.
 *
 * The telemetry tick runs the three monitor scans (processing/save
 * incidents, health/cost evaluation) plus windowed retention every minute.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The outbox drain safety net (A3 handoff note: cron-table drain upgrade).
crons.cron(
  "outbox-drain-safety-net",
  "*/5 * * * *",
  internal.platform.outbox.drainOutbox,
);

// G3 append (flagged shared-file change, the drain safety net's shape):
// the Calendar reconciliation safety net. Event-driven observation (the
// copyOutcomeRecorded consumer edge) is the fast path; this pass converges
// stragglers — reconnect rebuilds, drift re-checks and copies whose events
// were never delivered. Suspended connections contribute zero Google legs.
crons.cron(
  "calendar-sync-safety-net",
  "*/5 * * * *",
  internal.calendar.sync.functions.runCalendarSyncPass,
  {},
);
// F2 amendment (issue #42, flagged coordinated change — the I2 outbox-cron
// precedent): the notification-intent evaluator's safety net. The evaluator
// is primarily event/scheduler driven (intent creation schedules the hop
// atomically; each sweep schedules the next), so under total scheduler loss
// this once-a-minute sweep keeps due intents converging. Idempotent: the
// pending-state index range makes replays no-ops.
crons.cron(
  "attention-intent-safety-net",
  "* * * * *",
  internal.attention.delivery.evaluate.evaluateDueIntentsTick,
);
// F4 amendment (issue #44, flagged coordinated change - the drain/F2
// precedent): the task-reminder evaluator's safety net at the drain's
// once-every-five-minutes cadence (sparse by the quota guardrail; the
// primary path is the atomic scheduled hop at each slot's due instant).
// Idempotent through the pending-state index range.
crons.cron(
  "attention-reminder-safety-net",
  "*/5 * * * *",
  internal.attention.reminders.evaluate.evaluateDueRemindersTick,
);

// Incident scan + cost thresholds + retention + best-effort sink forward.
crons.interval(
  "telemetry-tick",
  { minutes: 1 },
  internal.operations.telemetry.cron.cronTick,
);

export default crons;
