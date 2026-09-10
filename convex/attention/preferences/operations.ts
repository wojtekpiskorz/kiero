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

  // Carry-over base in the WRITE shape (Convex Ids for the muted projects);
  // omitted keys keep the stored value (defaults for a first change: no
  // mutes, nothing hidden).
  const base = existing === null
    ? {
        mutedProjectIds: [] as Id<"projects">[],
        companyEntriesMuted: false,
        taskRemindersMuted: false,
        hidePreviewContent: false,
        quietHours: null as QuietHoursWindow | null,
      }
    : {
        mutedProjectIds: [...existing.mutedProjectIds],
        companyEntriesMuted: existing.companyEntriesMuted,
        taskRemindersMuted: existing.taskRemindersMuted,
        hidePreviewContent: existing.hidePreviewContent,
        quietHours:
          existing.quietHoursStartMinute !== undefined && existing.quietHoursEndMinute !== undefined
            ? {
                startMinuteOfDay: existing.quietHoursStartMinute,
                endMinuteOfDay: existing.quietHoursEndMinute,
              }
            : null,
      };
  const next = {
    mutedProjectIds:
      mutedProjectIds !== undefined ? [...mutedProjectIds] : base.mutedProjectIds,
    companyEntriesMuted: input.companyEntriesMuted ?? base.companyEntriesMuted,
    taskRemindersMuted: input.taskRemindersMuted ?? base.taskRemindersMuted,
    hidePreviewContent: input.hidePreviewContent ?? base.hidePreviewContent,
    // `null` reverts to the company default window by REMOVING the override
    // columns (absence is the "not set" state; the evaluation resolves the
    // default). There is deliberately no way to store "no quiet hours".
    quietHours: input.quietHours === undefined ? base.quietHours : input.quietHours,
  };

  if (existing === null) {
    await tx.db.insert("notificationPreferences", {
      companyId,
      userId,
      mutedProjectIds: next.mutedProjectIds,
      companyEntriesMuted: next.companyEntriesMuted,
      taskRemindersMuted: next.taskRemindersMuted,
      hidePreviewContent: next.hidePreviewContent,
      ...(next.quietHours === null
        ? {}
        : {
            quietHoursStartMinute: next.quietHours.startMinuteOfDay,
            quietHoursEndMinute: next.quietHours.endMinuteOfDay,
          }),
      updatedAtMs: nowMs,
    });
  } else {
    await tx.db.patch(existing._id, {
      mutedProjectIds: next.mutedProjectIds,
      companyEntriesMuted: next.companyEntriesMuted,
      taskRemindersMuted: next.taskRemindersMuted,
      hidePreviewContent: next.hidePreviewContent,
      ...(next.quietHours === null
        ? { quietHoursStartMinute: undefined, quietHoursEndMinute: undefined }
        : {
            quietHoursStartMinute: next.quietHours.startMinuteOfDay,
            quietHoursEndMinute: next.quietHours.endMinuteOfDay,
          }),
      updatedAtMs: nowMs,
    });
  }
  return okResult(
    Schema.decodeUnknownSync(changePreferencesOperation.result)({ changed: "changed" }),
  );
}
