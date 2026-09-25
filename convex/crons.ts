import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { TELEMETRY_TICK_INTERVAL_MS } from "./operations/telemetry/heartbeat";

// Pre-user cadences (docs/adr/mvp-cost-envelope-2026-09.md, 2026-09-25
// amendment). Every run is a billed function call on every deployment,
// with or without users, so this table stays sparse.
//
// The hourly jobs are safety nets: the real work is scheduled with
// ctx.scheduler when the triggering event happens (publication, intent,
// reminder slot, push job, deletion), so a sweep only matters after a lost
// scheduled hop. Google Calendar sync has no cron while the integration is
// deferred beyond v1 (docs/adr/calendar-deferral-2026-09.md).
//
// tests/platform/crons.test.ts caps the monthly invocation budget.
const crons = cronJobs();

crons.hourly(
  "outbox-drain-safety-net",
  { minuteUTC: 5 },
  internal.platform.outbox.drainOutbox,
);

crons.hourly(
  "attention-intent-safety-net",
  { minuteUTC: 10 },
  internal.attention.delivery.evaluate.evaluateDueIntentsTick,
);

crons.hourly(
  "attention-reminder-safety-net",
  { minuteUTC: 15 },
  internal.attention.reminders.evaluate.evaluateDueRemindersTick,
);

crons.hourly(
  "attention-push-safety-net",
  { minuteUTC: 20 },
  internal.attention.push.functions.pushSafetyNetTick,
);

// Purged content has a 24-hour deadline; an hourly pass keeps it well inside.
crons.hourly(
  "deletion-purge-tick",
  { minuteUTC: 25 },
  internal.operations.deletion.tick.purgeOverdueTick,
);

crons.interval(
  "telemetry-tick",
  { minutes: TELEMETRY_TICK_INTERVAL_MS / 60_000 },
  internal.operations.telemetry.cron.cronTick,
);

// The backup Container's own trigger runs at 02:00 UTC
// (apps/backup-worker/wrangler.jsonc); this tick checks freshness an hour
// later and pings the worker if the day's slot still has no row.
crons.daily(
  "backup-schedule-tick",
  { hourUTC: 3, minuteUTC: 0 },
  internal.operations.backups.functions.backupTick,
);

export default crons;
