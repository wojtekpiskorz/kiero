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
 * The identity-to-scope resolution lives in the two helpers below, each
 * spelled once (the resolveOwnScope pattern of the sibling read lane).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError, type RequestContext } from "@kiero/runtime";
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
  type PersonalNotificationSettings,
} from "./evaluation";
import { preferenceWriteOf } from "./operations";

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

/** One resolved actor scope: the company and user every query below reads. */
interface ActorScope {
  readonly companyId: Id<"companies">;
  readonly userId: Id<"users">;
}

/** Resolves the caller's scope from Convex Auth (the user path). */
async function resolveOwnScope(ctx: QueryCtx): Promise<ActorScope | null> {
  const identity = await identityFromConvexAuth(ctx.auth, Date.now());
  const context = await resolveRequestContext(ctx.db, identity);
  return scopeOf(ctx, context);
}

/** Resolves the caller's scope from a verified service session (bridge path). */
async function resolveBridgeScope(
  ctx: QueryCtx,
  serviceSessionId: string,
): Promise<ActorScope | null> {
  const context = await resolveRequestContext(ctx.db, bridgeIdentity(serviceSessionId, Date.now()));
  return scopeOf(ctx, context);
}

/** Narrows a resolved context into the query scope (null when unresolvable). */
async function scopeOf(ctx: QueryCtx, context: RequestContext | null): Promise<ActorScope | null> {
  if (context === null) {
    return null;
  }
  const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
  const userId = ctx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return null;
  }
  return { companyId, userId };
}

/** The personal settings plus the quiet-hours window that applies. */
async function effectivePreferences(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
): Promise<ResultEnvelope> {
  const row = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  // The ONE row decoder: absent row/columns resolve the neutral defaults,
  // and an absent quiet-hours override means the company default applies.
  const stored = preferenceWriteOf(row);
  const window = effectiveQuietHours(stored);
  return okResult({
    userId,
    mutedProjectIds: stored.mutedProjectIds,
    companyEntriesMuted: stored.companyEntriesMuted,
    taskRemindersMuted: stored.taskRemindersMuted,
    hidePreviewContent: stored.hidePreviewContent,
    quietHours: { startMinuteOfDay: window.startMinuteOfDay, endMinuteOfDay: window.endMinuteOfDay },
    quietHoursSource: stored.quietHours === null ? "company_default" : "personal",
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
    settings: preferenceWriteOf(row),
    companyTimezone: company.timezone,
  };
}

/** Runs the pure evaluation over the actor's REAL row at one instant. */
async function evaluateDelivery(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
  request: DeliveryRequest,
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

/** One hypothetical delivery the evaluation decides over (the seam input). */
export interface DeliveryRequest {
  readonly kind: DeliveryDecisionInput["kind"];
  readonly scope: DeliveryDecisionInput["scope"];
  readonly projectIds: string[];
  readonly isAuthor: boolean;
  readonly read: boolean;
  readonly nowMs: number;
}

/** The Convex args validator for one delivery request (shared with the probe). */
export const deliveryRequestValidator = v.object({
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

// --- public queries (Convex Auth identity) -----------------------------------

/** The effective personal notification settings (client path). */
export const myNotificationPreferences = query({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const scope = await resolveOwnScope(ctx);
    if (scope === null) {
      return errorResult(unauthenticatedError());
    }
    return effectivePreferences(ctx, scope.companyId, scope.userId);
  },
});

// --- internal queries (verified service session; the A3 bridge identity) ----

/** The effective settings for a verified service session (bridge path). */
export const myNotificationPreferencesFor = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    return effectivePreferences(ctx, scope.companyId, scope.userId);
  },
});

/**
 * The live evaluation seam: the actor's REAL stored preferences and REAL
 * company timezone decide one hypothetical delivery at `nowMs` (bridge
 * path; the dev-proof surface and F2's exact seam).
 */
export const evaluatePersonalDeliveryFor = internalQuery({
  args: { serviceSessionId: v.string(), request: deliveryRequestValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    return evaluateDelivery(ctx, scope.companyId, scope.userId, args.request);
  },
});
