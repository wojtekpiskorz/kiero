/**
 * Notification-preference mutation transaction (F1):
 * `attention.changeNotificationPreferences`.
 *
 * ONE Convex mutation performs the whole change: resolve the actor's own
 * preference row, validate every PRESENT patch key (the contract made the
 * keys optional — omission leaves that control unchanged, which is the
 * acceptance criterion "can be changed independently"), and upsert the ONE
 * row per user+company. There is no event to publish: F2 re-reads
 * preferences at due time (reactive consistency comes from Convex queries,
 * not notifications).
 *
 * Validation performed here (beyond the contract decode):
 *
 * - the patch carries at least one key (an empty patch is rejected, not
 *   silently treated as a no-op receipt of "changed");
 * - every muted project id exists and belongs to the actor's company
 *   (forged cross-company identifiers fail `forbidden`);
 * - a personal quiet-hours window must be non-degenerate (start != end);
 *   `quietHours: null` REVERTS to the company default window (20:00–06:00).
 */

import { Schema } from "effect";
import {
  attentionOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, validationError, type RequestContext } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QuietHoursWindow } from "./evaluation";

/** The contract entry this transaction implements (decode/typed authority). */
export const changePreferencesOperation =
  attentionOperations["attention.changeNotificationPreferences"];
export type ChangePreferencesInput = Schema.Schema.Type<typeof changePreferencesOperation.input>;
export type ChangePreferencesResult = Schema.Schema.Type<typeof changePreferencesOperation.result>;

/** Bounded preference: at most this many distinct muted projects. */
export const MAX_MUTED_PROJECTS = 256;

/** The stored fields the evaluation and round-trip reads consume. */
export interface StoredPreferences {
  readonly mutedProjectIds: string[];
  readonly companyEntriesMuted: boolean;
  readonly taskRemindersMuted: boolean;
  readonly hidePreviewContent: boolean;
  readonly quietHours: QuietHoursWindow | null;
}

/** Reads one stored row into the evaluation shape (null when absent). */
export function storedPreferencesOf(row: Doc<"notificationPreferences">): StoredPreferences {
  return {
    mutedProjectIds: [...row.mutedProjectIds],
    companyEntriesMuted: row.companyEntriesMuted,
    taskRemindersMuted: row.taskRemindersMuted,
    hidePreviewContent: row.hidePreviewContent,
    quietHours:
      row.quietHoursStartMinute !== undefined && row.quietHoursEndMinute !== undefined
        ? {
            startMinuteOfDay: row.quietHoursStartMinute,
            endMinuteOfDay: row.quietHoursEndMinute,
          }
        : null,
  };
}

/** Order-preserving de-duplication of muted project ids. */
export function dedupeProjectIds(projectIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const projectId of projectIds) {
    if (!seen.has(projectId)) {
      seen.add(projectId);
      out.push(projectId);
    }
  }
  return out;
}

/** The row's write shape (Convex Ids for the muted projects). */
interface PreferenceWrite {
  readonly mutedProjectIds: Id<"projects">[];
  readonly companyEntriesMuted: boolean;
  readonly taskRemindersMuted: boolean;
  readonly hidePreviewContent: boolean;
  readonly quietHours: QuietHoursWindow | null;
}

/**
 * The ONE row-to-write mapping: a stored row (or null for a first change)
 * becomes the carry-over base in exactly the shape insert/patch consume.
 */
export function preferenceWriteOf(row: Doc<"notificationPreferences"> | null): PreferenceWrite {
  if (row === null) {
    return {
      mutedProjectIds: [],
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: false,
      quietHours: null,
    };
  }
  return {
    mutedProjectIds: [...row.mutedProjectIds],
    companyEntriesMuted: row.companyEntriesMuted,
    taskRemindersMuted: row.taskRemindersMuted,
    hidePreviewContent: row.hidePreviewContent,
    quietHours:
      row.quietHoursStartMinute !== undefined && row.quietHoursEndMinute !== undefined
        ? {
            startMinuteOfDay: row.quietHoursStartMinute,
            endMinuteOfDay: row.quietHoursEndMinute,
          }
        : null,
  };
}

/**
 * The quiet-hours override columns for one window (the SET case), spelled
 * once for both write branches. The null case differs honestly between
 * them: insert omits the columns (absent = not set), patch writes explicit
 * `undefined` (which removes them); absence IS the "not set" state the
 * evaluation resolves to the company default, and there is deliberately no
 * way to store "no quiet hours".
 */
export function quietHoursFields(window: QuietHoursWindow): {
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
} {
  return {
    quietHoursStartMinute: window.startMinuteOfDay,
    quietHoursEndMinute: window.endMinuteOfDay,
  };
}

/**
 * Applies one patch over the carry-over base: present keys replace, omitted
 * keys pass the stored value through verbatim (independent changes cannot
 * clobber each other). `validatedMutedProjectIds` is the already
 * tenant-checked list when the patch carries one.
 */
export function applyPreferencePatch(
  base: PreferenceWrite,
  input: ChangePreferencesInput,
  validatedMutedProjectIds: Id<"projects">[] | undefined,
): PreferenceWrite {
  return {
    mutedProjectIds:
      validatedMutedProjectIds !== undefined
        ? [...validatedMutedProjectIds]
        : base.mutedProjectIds,
    companyEntriesMuted: input.companyEntriesMuted ?? base.companyEntriesMuted,
    taskRemindersMuted: input.taskRemindersMuted ?? base.taskRemindersMuted,
    hidePreviewContent: input.hidePreviewContent ?? base.hidePreviewContent,
    quietHours: input.quietHours === undefined ? base.quietHours : input.quietHours,
  };
}

/** Whether a patch carries at least one control to change. */
export function patchIsEmpty(input: ChangePreferencesInput): boolean {
  return (
    input.mutedProjectIds === undefined &&
    input.companyEntriesMuted === undefined &&
    input.taskRemindersMuted === undefined &&
    input.hidePreviewContent === undefined &&
    input.quietHours === undefined
  );
}

/**
 * Performs the whole preference change in the caller's transaction. The
 * row key is the RESOLVED actor (user + company from the checked dispatch),
 * never client input; the stored values for omitted keys are carried over
 * verbatim, so independent changes cannot clobber each other.
 */
export async function performChangeNotificationPreferences(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangePreferencesInput,
): Promise<ResultEnvelope> {
  if (patchIsEmpty(input)) {
    return errorResult(validationError("preference_patch_empty"));
  }
  const nowMs = Date.now();
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(forbiddenError("actor_scope_unresolved"));
  }

  // Validate present keys BEFORE the first write (the D1 structural rule:
  // every failing check leaves nothing committed).
  let mutedProjectIds: Id<"projects">[] | undefined;
  if (input.mutedProjectIds !== undefined) {
    const deduped = dedupeProjectIds(input.mutedProjectIds);
    if (deduped.length > MAX_MUTED_PROJECTS) {
      return errorResult(validationError("too_many_muted_projects"));
    }
    const checked: Id<"projects">[] = [];
    for (const candidate of deduped) {
      const projectId = tx.db.normalizeId("projects", candidate);
      if (projectId === null) {
        return errorResult(validationError("project_reference_not_found"));
      }
      const project = await tx.db.get(projectId);
      if (project === null) {
        return errorResult(validationError("project_reference_not_found"));
      }
      if (project.companyId !== companyId) {
        return errorResult(forbiddenError("tenant_scope_mismatch", "projects"));
      }
      checked.push(projectId);
    }
    mutedProjectIds = checked;
  }
  if (input.quietHours !== undefined && input.quietHours !== null) {
    if (input.quietHours.startMinuteOfDay === input.quietHours.endMinuteOfDay) {
      return errorResult(validationError("quiet_hours_window_empty"));
    }
  }

  const existing = await tx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();

  // Carry-over base through the ONE row-to-write mapping; omitted keys keep
  // the stored value (defaults for a first change: no mutes, nothing
  // hidden).
  const next = applyPreferencePatch(preferenceWriteOf(existing), input, mutedProjectIds);

  if (existing === null) {
    await tx.db.insert("notificationPreferences", {
      companyId,
      userId,
      mutedProjectIds: next.mutedProjectIds,
      companyEntriesMuted: next.companyEntriesMuted,
      taskRemindersMuted: next.taskRemindersMuted,
      hidePreviewContent: next.hidePreviewContent,
      // Insert omits the override columns when reverting (absent = not set).
      ...(next.quietHours === null ? {} : quietHoursFields(next.quietHours)),
      updatedAtMs: nowMs,
    });
  } else {
    await tx.db.patch(existing._id, {
      mutedProjectIds: next.mutedProjectIds,
      companyEntriesMuted: next.companyEntriesMuted,
      taskRemindersMuted: next.taskRemindersMuted,
      hidePreviewContent: next.hidePreviewContent,
      // Patch removes the override columns when reverting (undefined clears).
      ...(next.quietHours === null
        ? { quietHoursStartMinute: undefined, quietHoursEndMinute: undefined }
        : quietHoursFields(next.quietHours)),
      updatedAtMs: nowMs,
    });
  }
  return okResult(
    Schema.decodeUnknownSync(changePreferencesOperation.result)({ changed: "changed" }),
  );
}
