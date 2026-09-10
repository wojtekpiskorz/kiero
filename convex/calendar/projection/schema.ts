/**
 * Calendar projection and sync tables (A2 candidate, certified by A3).
 *
 * Owning implementers: G2 (deterministic projection, personal scope),
 * G3 (reconciliation of writes, unknown outcomes, reconnects).
 * A copy mirrors one task deadline or event time into a personal calendar
 * and links back to the Kiero record. Hiding a copy is personal and never
 * cancels the underlying work. Unknown remote outcomes require
 * reconciliation; another POST is not automatically safe.
 *
 * G2 amendments (the owning lane completes the candidate fragment; the
 * table NAME stays in the closed inventory, G1 precedent):
 * - `calendarCopies` carries the full DESIRED state: the deterministic
 *   semantic id (stable per user/company/Google account/subject), the
 *   desired outcome (`projected` with its managed Google payload vs
 *   `withdrawn` with a machine reason), the finding revision the desire
 *   derives from, and the personal-hide bookkeeping. `googleEventId` and
 *   `remoteOutcome` remain G3's remote ledger: G2 only ever sets the
 *   initial `unknown` and resets it when the account binding changes
 *   (the old calendar's linkage honestly stops being knowable).
 * - `calendarSyncState` additionally records the boss's personal project
 *   selection (default: all projects, independent of notification
 *   preferences) and the honest suspension reason of the last projection
 *   pass (a lost or refresh-unknown connection suspends publishing).
 *
 * Tables: calendarCopies, calendarSyncState.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { CalendarRemoteOutcome } from "@kiero/contracts";
import type { DesiredGoogleEvent, WithdrawReason } from "@kiero/domain";

// Vocabulary pin: the copy's remote outcome must equal the contracts-side
// CalendarRemoteOutcome literals exactly (unknown stays first-class), or this
// file fails typecheck.
const calendarRemoteOutcome: ValueValidator<Encoded<typeof CalendarRemoteOutcome>> =
  v.union(
    v.literal("confirmed"),
    v.literal("absent"),
    v.literal("unknown"),
  );

/** The hide-origin validator pinned to the runtime list above. */
const hideOrigin: ValueValidator<HideOrigin> = v.union(
  v.literal("user_request"),
  v.literal("deleted_in_google"),
  v.literal("moved_in_google"),
);

/**
 * The withdraw-reason validator PINNED to the domain's runtime list
 * (packages/domain/calendar/projection.ts owns the vocabulary; the same
 * pin style as `calendarRemoteOutcome` below — a reason added to the
 * domain without its literal here fails typecheck instead of silently
 * dropping out of a patch).
 */
const withdrawReason: ValueValidator<WithdrawReason> = v.union(
  v.literal("subject_closed"),
  v.literal("out_of_personal_scope"),
  v.literal("no_binding"),
  v.literal("term_unresolved"),
  v.literal("term_not_temporal"),
  v.literal("term_proposed"),
  v.literal("term_actual"),
  v.literal("term_approximate"),
  v.literal("term_open_ended"),
  v.literal("term_invalid"),
);

/** How a personal hide came about ("Ukrycie kopii kalendarzowej"). */
export const HIDE_ORIGINS = ["user_request", "deleted_in_google", "moved_in_google"] as const;
export type HideOrigin = (typeof HIDE_ORIGINS)[number];

/**
 * The managed Google-event payload validator, PINNED to the domain's
 * DesiredGoogleEvent type (packages/domain/calendar/projection.ts owns the
 * shape; drift here fails typecheck).
 */
const desiredPayload: ValueValidator<DesiredGoogleEvent> = v.object({
  summary: v.string(),
  description: v.string(),
  start: v.object({ date: v.optional(v.string()), dateTime: v.optional(v.string()) }),
  end: v.object({ date: v.optional(v.string()), dateTime: v.optional(v.string()) }),
  transparency: v.literal("transparent"),
  reminders: v.object({ useDefault: v.literal(false), overrides: v.array(v.string()) }),
});

export const calendarProjectionTables = {
  /**
   * One projected calendar entry for one user's connection. One row per
   * (connection, subject): repeated passes update, they never duplicate.
   */
  calendarCopies: defineTable({
    connectionId: shared.calendarConnectionId,
    userId: shared.userId,
    subjectKind: v.union(v.literal("task"), v.literal("event")),
    taskId: v.optional(shared.taskId),
    eventId: v.optional(shared.workEventId),
    /** Deterministic projection identity (packages/domain/calendar). */
    semanticId: v.string(),
    /** Whether the copy should exist in Google (`projected`) or not. */
    desiredState: v.union(v.literal("projected"), v.literal("withdrawn")),
    withdrawReason: v.optional(withdrawReason),
    /** Managed-fields payload while `desiredState === "projected"`. */
    payload: v.optional(desiredPayload),
    /** Remote id once known; absent while the first POST is unresolved. */
    googleEventId: v.optional(v.string()),
    /** Desired state follows this finding revision; drift triggers sync. */
    desiredRevisionId: shared.findingRevisionId,
    hidden: v.boolean(),
    hiddenOrigin: v.optional(hideOrigin),
    hiddenAtMs: v.optional(shared.tsMs),
    remoteOutcome: calendarRemoteOutcome,
    updatedAtMs: shared.tsMs,
  })
    .index("by_connection", ["connectionId"])
    .index("by_task", ["taskId"])
    .index("by_event", ["eventId"])
    .index("by_connection_semantic", ["connectionId", "semanticId"]),

  /** Reconciliation cursor, personal selection and suspension of one connection. */
  calendarSyncState: defineTable({
    connectionId: shared.calendarConnectionId,
    state: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("needs_reconcile"),
    ),
    /** The boss's personal project selection (default: all projects). */
    selectedProjects: v.optional(
      v.object({
        mode: v.union(v.literal("all_projects"), v.literal("explicit")),
        projectIds: v.optional(v.array(shared.projectId)),
      }),
    ),
    /** Why the last pass suspended publishing, when it did. */
    suspendedReason: v.optional(v.string()),
    cursor: v.optional(v.string()),
    lastSyncedAtMs: v.optional(shared.tsMs),
    lastPassAtMs: v.optional(shared.tsMs),
    updatedAtMs: shared.tsMs,
  }).index("by_connection", ["connectionId"]),
} as const;
