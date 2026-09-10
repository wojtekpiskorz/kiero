/**
 * Notification-preference queries (F1): the personal-settings read F2/F4/H
 * consume, plus the live evaluation seam hook.
 *
 * `myNotificationPreferences` returns the EFFECTIVE settings: the stored
 * personal row with every control present (defaults when no row exists)
 * and the quiet-hours window that currently applies — personal override or
 * the company default 20:00–06:00 — together with which one applies, so a
 * consumer never re-implements the defaulting rule.
 *
 * `evaluatePersonalDeliveryFor` runs the PURE evaluation
 * (`./evaluation.ts`) over the actor's REAL stored row and the REAL
 * company timezone, at a caller-supplied instant: the dev-proof surface
 * for quiet-hour boundary and DST evidence, and the exact seam F2's
 * evaluator calls at due time.
 *
 * Two callable shapes, one checked resolution (the lane pattern): public
 * queries (Convex Auth; honestly `unauthenticated` until B1) and internal
 * queries behind the verified service session (the A3 bridge identity).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import { internalQuery, query } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import {
  bridgeIdentity,
  identityFromConvexAuth,
  resolveRequestContext,
} from "../../platform/context";
import {
  DEFAULT_QUIET_HOURS,
  decidePersonalDelivery,
  effectiveQuietHours,
  isValidTimezone,
  type DeliveryDecisionInput,
  type DeliveryKind,
  type EntryScope,
  type PersonalNotificationSettings,
} from "./evaluation";
import { storedPreferencesOf } from "./operations";

/** The effective personal settings every consumer resolves identically. */
export interface EffectivePreferences {
  readonly userId: string;
  readonly mutedProjectIds: string[];
  readonly companyEntriesMuted: boolean;
  readonly taskRemindersMuted: boolean;
  readonly hidePreviewContent: boolean;
  /** The window that currently applies (personal override or company default). */
  readonly quietHours: { readonly startMinuteOfDay: number; readonly endMinuteOfDay: number };
  /** Whether `quietHours` is a personal override or the company default. */
  readonly quietHoursSource: "personal" | "company_default";
}

async function effectivePreferences(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
): Promise<ResultEnvelope> {
  const row = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  const stored = row === null ? null : storedPreferencesOf(row);
  const window = effectiveQuietHours(stored);
  return okResult({
    userId,
    mutedProjectIds: stored?.mutedProjectIds ?? [],
    companyEntriesMuted: stored?.companyEntriesMuted ?? false,
    taskRemindersMuted: stored?.taskRemindersMuted ?? false,
    hidePreviewContent: stored?.hidePreviewContent ?? false,
    quietHours: { startMinuteOfDay: window.startMinuteOfDay, endMinuteOfDay: window.endMinuteOfDay },
    quietHoursSource:
      stored === null || stored.quietHours === null ? "company_default" : "personal",
  } satisfies EffectivePreferences);
}

/** Resolves the actor's stored settings row (or null) plus the company row. */
async function resolveEvaluationInputs(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
): Promise<
  { ok: true; settings: PersonalNotificationSettings | null; companyTimezone: string } | { ok: false }
> {
  const company = await ctx.db.get(companyId);
  if (company === null || !isValidTimezone(company.timezone)) {
    return { ok: false };
  }
  const row = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  return {
    ok: true,
    settings: row === null ? null : storedPreferencesOf(row),
    companyTimezone: company.timezone,
  };
}

/** Runs the pure evaluation over the actor's REAL row at one instant. */
async function evaluateDelivery(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
  request: {
    readonly kind: DeliveryKind;
    readonly scope: EntryScope;
    readonly projectIds: string[];
    readonly isAuthor: boolean;
    readonly read: boolean;
    readonly nowMs: number;
  },
): Promise<ResultEnvelope> {
  const inputs = await resolveEvaluationInputs(ctx, companyId, userId);
  if (!inputs.ok) {
    return errorResult(forbiddenError("company_timezone_unresolved"));
  }
  const decisionInput: DeliveryDecisionInput = {
    kind: request.kind,
    scope: request.scope,
    projectIds: request.projectIds,
    isAuthor: request.isAuthor,
    read: request.read,
    nowMs: request.nowMs,
    companyTimezone: inputs.companyTimezone,
    settings: inputs.settings,
  };
  const decision = decidePersonalDelivery(decisionInput);
  return okResult({
    decision,
    defaultQuietHours: {
      startMinuteOfDay: DEFAULT_QUIET_HOURS.startMinuteOfDay,
      endMinuteOfDay: DEFAULT_QUIET_HOURS.endMinuteOfDay,
    },
    companyTimezone: inputs.companyTimezone,
  });
}

// --- public queries (Convex Auth identity) -----------------------------------

/** The effective personal notification settings (client path). */
export const myNotificationPreferences = query({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const identity = await identityFromConvexAuth(ctx.auth, Date.now());
    const context = await resolveRequestContext(ctx.db, identity);
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return errorResult(unauthenticatedError());
    }
    return effectivePreferences(ctx, companyId, userId);
  },
});

// --- internal queries (verified service session; the A3 bridge identity) ----

/** The effective settings for a verified service session (bridge path). */
export const myNotificationPreferencesFor = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    return effectivePreferences(ctx, companyId, userId);
  },
});

const deliveryRequestValidator = v.object({
  kind: v.union(
    v.literal("source_entry"),
    v.literal("clarification"),
    v.literal("task_reminder"),
  ),
  scope: v.union(v.literal("project"), v.literal("company")),
  projectIds: v.array(v.id("projects")),
  isAuthor: v.boolean(),
  read: v.boolean(),
  nowMs: v.float64(),
});

/**
 * The live evaluation seam: the actor's REAL stored preferences and REAL
 * company timezone decide one hypothetical delivery at `nowMs` (bridge
 * path; the dev-proof surface and F2's exact seam).
 */
export const evaluatePersonalDeliveryFor = internalQuery({
  args: { serviceSessionId: v.string(), request: deliveryRequestValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    return evaluateDelivery(ctx, companyId, userId, args.request);
  },
});
