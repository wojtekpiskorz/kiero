/**
 * The pre-user cron budget (docs/adr/mvp-cost-envelope-2026-09.md).
 *
 * Every cron run is a billed Convex function call on every deployment,
 * with or without users. A minute-level telemetry tick and 5-minute safety
 * nets cost ~130k scheduled calls per deployment per month before the
 * calls they fan out to; this test keeps that from coming back unnoticed.
 */

import { describe, expect, it } from "vitest";
import crons from "../../convex/crons";

const MINUTES_PER_MONTH = 30 * 24 * 60;

/** Runs per 30-day month of one Convex schedule. */
function runsPerMonth(schedule: Record<string, unknown>): number {
  switch (schedule.type) {
    case "interval": {
      const minutes =
        typeof schedule.seconds === "number"
          ? schedule.seconds / 60
          : typeof schedule.minutes === "number"
            ? schedule.minutes
            : (schedule.hours as number) * 60;
      return MINUTES_PER_MONTH / minutes;
    }
    case "hourly":
      return 30 * 24;
    case "daily":
      return 30;
    case "weekly":
      return 5;
    case "monthly":
      return 1;
    default:
      // Raw cron expressions hide their frequency; use the helpers instead.
      throw new Error(`unsupported schedule type in convex/crons.ts: ${String(schedule.type)}`);
  }
}

const jobs = Object.entries(crons.crons).map(([name, job]) => ({
  name,
  runs: runsPerMonth(job.schedule as Record<string, unknown>),
}));

describe("convex/crons.ts stays inside the pre-user budget", () => {
  it("no job runs more often than hourly", () => {
    for (const job of jobs) {
      expect(job.runs, job.name).toBeLessThanOrEqual(30 * 24);
    }
  });

  it("all jobs together stay under 5,000 scheduled runs per month", () => {
    const total = jobs.reduce((sum, job) => sum + job.runs, 0);
    expect(total).toBeLessThan(5_000);
  });

  it("Google Calendar sync has no cron while the integration is deferred", () => {
    expect(jobs.map((job) => job.name)).not.toContain("calendar-sync-safety-net");
  });
});
