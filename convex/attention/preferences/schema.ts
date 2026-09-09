/**
 * Personal notification preferences (candidate fragment, A2).
 *
 * Owning implementer: F1. Muting sources and quiet hours are personal:
 * they defer or suppress push delivery for one boss without changing task
 * deadlines, reminders of other bosses, or information availability in the
 * app. Quiet hours use the company timezone context.
 *
 * Tables: notificationPreferences.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const preferencesTables = {
  /** One row per user (and company scope) with personal delivery settings. */
  notificationPreferences: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    mutedSourceIds: v.array(shared.sourceId),
    /** Minute-of-day bounds interpreted in the company timezone. */
    quietHoursStartMinute: v.optional(v.float64()),
    quietHoursEndMinute: v.optional(v.float64()),
    updatedAtMs: shared.tsMs,
  }).index("by_company_user", ["companyId", "userId"]),
} as const;
