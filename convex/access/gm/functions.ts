/**
 * The B4 Convex function surface (generated-call APIs).
 *
 * Entry ways, one core each (no drift by construction):
 *
 * - `enterGmMode` (public ACTION): the ONLY way GM mode opens. Actions are
 *   the one place deployment variables are readable, so the operator
 *   allow-list (`KIERO_GM_EMAILS`, comma-separated normalized addresses —
 *   deployment configuration, fail-closed when absent) is checked here
 *   against the caller's REAL live-session email, then the internal
 *   mutation runs the checked core (which re-resolves the session and
 *   re-decides entry). Eligibility is a deployment-owner decision; the
 *   audited grant is the explicit act.
 * - `exitGmMode` / `dispatchGmCommand` (public mutations): the typed GM
 *   command dispatch (exit, inspection, recovery, activation, restoration,
 *   alpha-ending) — every one re-resolves current GM authority inside the
 *   transaction.
 * - `gmOnboardCommand` (public ACTION): the issuance leg whose email
 *   delivery must run outside the transaction (B3's pattern verbatim).
 * - `gmOverview` (public query): the barebones UI read — the actor's OWN
 *   mode state plus the directory of firms under open alpha activation.
 *   Company internals leave the database only through the audited
 *   `access.gmInspectCompany` command.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Schema } from "effect";
import { CommandEnvelope, accessOperations, type ResultEnvelope } from "@kiero/contracts";
import { decodeInput, forbiddenError, unauthenticatedError } from "@kiero/runtime";
import type { Id } from "../../_generated/dataModel";
import { deliverApplicationEmail } from "../../integrations/email/send";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
} from "../identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import {
  decideGmEntryEligibility,
  parseGmOperatorAllowList,
} from "./cores";
import { performEnterGmMode } from "./operations";
import { dispatchGmCommand, dispatchGmOnboard } from "./dispatch";
import { gmTx } from "./storeAdapter";

/** The sanitized denial every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

// ---------------------------------------------------------------------------
// GM mode entry (the audited, eligibility-gated act)
// ---------------------------------------------------------------------------

/** Resolves the caller's live session identity for the eligibility check. */
export const sessionIdentityInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ userId: string; email: string } | null> => {
    const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
    if (live.tag === "denied") {
      return null;
    }
    const user = await ctx.db.get(live.session.userId);
    return user === null ? null : { userId: user._id, email: user.email };
  },
});

/** The entry transaction (internal only; the action is the public entry). */
export const enterGmModeTransaction = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const decodedEnvelope = decodeInput(CommandEnvelope, args.envelope);
    if (!decodedEnvelope.ok) {
      return decodedEnvelope.error;
    }
    const command = decodedEnvelope.value;
    if (command.operation !== "access.enterGmMode") {
      return {
        _tag: "error",
        error: forbiddenError("gm_entry_only", "gm"),
      } satisfies ResultEnvelope;
    }
    const entry = accessOperations["access.enterGmMode"];
    const decodedInput = decodeInput(entry.input, command.input);
    if (!decodedInput.ok) {
      return decodedInput.error;
    }
    const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
    if (live.tag === "denied") {
      return {
        _tag: "error",
        error: unauthenticatedError(`no_live_session_${live.reason}`),
      } satisfies ResultEnvelope;
    }
    return performEnterGmMode(gmTx(ctx), {
      userId: live.session.userId,
      reason: decodedInput.value.reason,
    });
  },
});

/**
 * The audited GM mode entry: envelope decode -> caller eligibility (the
 * deployment's operator allow-list against the REAL live-session email) ->
 * the checked entry transaction. An absent or empty allow-list means NOBODY
 * enters GM mode on that deployment.
 */
export const enterGmMode = action({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const decodedEnvelope = decodeInput(CommandEnvelope, args.envelope);
    if (!decodedEnvelope.ok) {
      return decodedEnvelope.error;
    }
    const allowList = parseGmOperatorAllowList(process.env.KIERO_GM_EMAILS);
    const identity = await ctx.runQuery(internal.access.gm.functions.sessionIdentityInternal, {});
    if (identity === null) {
      return {
        _tag: "error",
        error: unauthenticatedError("no_live_session_no_identity"),
      } satisfies ResultEnvelope;
    }
    if (!decideGmEntryEligibility(identity.email, allowList)) {
      return {
        _tag: "error",
        error: forbiddenError("gm_not_designated", "gm"),
      } satisfies ResultEnvelope;
    }
    return await ctx.runMutation(internal.access.gm.functions.enterGmModeTransaction, {
      envelope: args.envelope,
    });
  },
});

// ---------------------------------------------------------------------------
// Commands (the typed GM dispatch)
// ---------------------------------------------------------------------------

/** The typed GM command dispatch (client path). */
export const dispatchGm = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => dispatchGmCommand(ctx, args.envelope),
});

/** The onboarding transaction the action wraps (internal only). */
export const gmOnboardTransaction = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchGmOnboard(ctx, args.envelope),
});

/**
 * The onboarding entry: dispatch inside the transaction, invitation email
 * delivery from the action (the one place a fetch may run), and the honest
 * delivery state composed into the client envelope. The company,
 * activation and invitation rows exist regardless of delivery outcome.
 */
export const gmOnboardCommand = action({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const transaction = await ctx.runMutation(internal.access.gm.functions.gmOnboardTransaction, {
      envelope: args.envelope,
    });
    if (transaction.result._tag === "error" || transaction.issued === null) {
      return transaction.result;
    }
    const issued = transaction.issued;
    const outcome = await deliverApplicationEmail(issued.email, {
      kind: "invitation_code",
      companyName: issued.companyName,
      code: issued.code,
      expiresAtMs: issued.expiresAtMs,
    });
    return {
      _tag: "ok",
      value: Schema.decodeUnknownSync(accessOperations["access.gmOnboardCompany"].result)({
        companyId: issued.companyId,
        activationId: issued.activationId,
        invitationId: issued.invitationId,
        expiresAtMs: issued.expiresAtMs,
        delivery: outcome.outcome === "sent" ? "sent" : "delivery_failed",
      }),
    } satisfies ResultEnvelope;
  },
});

// ---------------------------------------------------------------------------
// Reads (barebones UI)
// ---------------------------------------------------------------------------

/** One firm under open alpha activation, as the GM directory shows it. */
export interface GmCompanyDirectoryEntry {
  readonly companyId: Id<"companies">;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly activationId: Id<"gmCompanyActivations">;
  readonly activatedAtMs: number;
}

/** The GM panel read: the actor's own mode state + the activated-firm directory. */
export type GmOverview =
  | { readonly state: "anonymous" }
  | { readonly state: "not_gm"; readonly email: string }
  | {
      readonly state: "gm";
      readonly email: string;
      readonly grantId: Id<"gmAccessGrants">;
      readonly reason: string;
      readonly enteredAtMs: number;
      readonly membershipContext: { readonly companyId: Id<"companies">; readonly role: "admin" | "member" } | null;
      readonly companies: GmCompanyDirectoryEntry[];
    };

/** How many directory rows the bounded overview returns. */
const MAX_DIRECTORY_ROWS = 50;

/**
 * Authenticated: the barebones GM surface read. `anonymous` for no live
 * session, `not_gm` for a live session without an open grant (the panel
 * then offers entry, which the action re-gates), `gm` for an open grant
 * with the firm directory. The directory lists ONLY firms under OPEN alpha
 * activation: a firm whose participation ended is invisible again — no
 * target data leaks past the authority that ended.
 */
export const gmOverview = query({
  args: {},
  handler: async (ctx): Promise<GmOverview> => {
    const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
    if (live.tag === "denied") {
      return { state: "anonymous" };
    }
    const user = await ctx.db.get(live.session.userId);
    if (user === null) {
      denialError("registry_missing");
    }
    const grants = await ctx.db
      .query("gmAccessGrants")
      .withIndex("by_user_open", (q) => q.eq("userId", live.session.userId))
      .collect();
    const open = grants.find((grant) => grant.closedAtMs === undefined);
    if (open === undefined) {
      return { state: "not_gm", email: user.email };
    }

    // Honest layering display: membership context, if any, is shown as the
    // SEPARATE thing it is (the GM authority is not derived from it).
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(live.session, Date.now()),
    );
    let membershipContext: {
      readonly companyId: Id<"companies">;
      readonly role: "admin" | "member";
    } | null = null;
    if (context !== null) {
      const contextCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
      if (contextCompanyId !== null) {
        membershipContext = { companyId: contextCompanyId, role: context.actor.membershipRole };
      }
    }

    const activations = await ctx.db
      .query("gmCompanyActivations")
      .withIndex("by_activated")
      .order("desc")
      .collect();
    const companies: GmCompanyDirectoryEntry[] = [];
    for (const activation of activations) {
      if (activation.endedAtMs !== undefined || companies.length >= MAX_DIRECTORY_ROWS) {
        continue;
      }
      const company = await ctx.db.get(activation.companyId);
      if (company === null) {
        continue;
      }
      companies.push({
        companyId: company._id,
        name: company.name,
        timezone: company.timezone,
        defaultCurrency: company.defaultCurrency,
        activationId: activation._id,
        activatedAtMs: activation.activatedAtMs,
      });
    }
    return {
      state: "gm",
      email: user.email,
      grantId: open._id,
      reason: open.reason,
      enteredAtMs: open.enteredAtMs,
      membershipContext,
      companies,
    };
  },
});
