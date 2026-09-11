/**
 * The deletion lane's scheduled entries (I4): the cron safety net's
 * callable form. The bounded overdue pass itself lives in ./functions.ts
 * (`runPurgeOverduePass`); this module only exposes it to the scheduler
 * (the I5 backup-tick module shape).
 */

import { internalMutation } from "../../_generated/server";
import { runPurgeOverduePass } from "./functions";

/** The 24-hour tracking tick the cron table calls. */
export const purgeOverdueTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    await runPurgeOverduePass(ctx);
  },
});
