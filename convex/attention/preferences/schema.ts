/**
 * Personal notification preferences.
 *
 * Muting and quiet hours are personal: they defer
 * or suppress push delivery for one boss without changing task deadlines,
 * reminders of other bosses, or information availability in the app
 * (CONTEXT.md "Godziny ciszy", "Strefa czasu firmy").
 *
 * The certified candidate stored a
 * per-source mute list; the accepted notification decision (issue 7
 * resolution) defines the personal vocabulary as DISTINCT controls, so each
 * control is one field and each can be changed independently through
 * `attention.changeNotificationPreferences`:
 *
 * - `mutedProjectIds`: personal mute of project conversations ("Każdy może
 *   osobiście wyciszyć rozmowę projektu"). Muting is keyed on the project,
 *   not on copies of entries, exactly like read state is keyed on the
 *   logical source.
 * - `companyEntriesMuted`: the separate personal mute of company entries
 *   ("Mają one osobne, osobiste wyciszenie wpisów firmowych").
 * - `taskRemindersMuted`: the personal task-reminder mute, separate from
 *   conversation mutes ("Wyciszenie rozmowy i wyciszenie przypomnień ...
 *   są osobnymi, osobistymi ustawieniami"). This lane stores and round-trips it;
 *   the reminder evaluation consumes it.
 * - `hidePreviewContent`: the personal preview-content preference
 *   ("Użytkownik może ukryć treść podglądów"). Web push and the UI consume it when
 *   rendering push payloads.
 * - `quietHoursStartMinute`/`quietHoursEndMinute`: the PERSONAL quiet-hours
 *   window as minute-of-day bounds interpreted in the company timezone.
 *   Absent means the company default window applies (20:00–06:00, issue 7);
 *   `attention.changeNotificationPreferences` with `quietHours: null`
 *   reverts to that default.
 *
 * Snooze ("Odroczenie przypomnień") is deliberately NOT here: it is a
 * per-user-per-task deferral in convex/attention/reminders.
 *
 * Tables: notificationPreferences.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const preferencesTables = {
  /**
   * One row per user (and company scope) with the personal delivery
   * settings. All fields are required on the row itself; a user who never
   * changed anything has NO row and reads resolve the documented defaults
   * (no mutes, default quiet hours).
   */
  notificationPreferences: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    /** Personally muted project conversations (logical projects, not copies). */
    mutedProjectIds: v.array(shared.projectId),
    /** Personal mute of company entries (general/unassigned). */
    companyEntriesMuted: v.boolean(),
    /** Personal task-reminder mute (consumed by the reminder evaluation). */
    taskRemindersMuted: v.boolean(),
    /** Personal preference hiding notification preview content. */
    hidePreviewContent: v.boolean(),
    /** Personal quiet-hours window override; absent = company default. */
    quietHoursStartMinute: v.optional(v.float64()),
    quietHoursEndMinute: v.optional(v.float64()),
    updatedAtMs: shared.tsMs,
  }).index("by_company_user", ["companyId", "userId"]),
} as const;
