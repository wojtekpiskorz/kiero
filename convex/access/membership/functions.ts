/**
 * The B3 Convex function surface (generated-call APIs).
 *
 * One core set, three callable entries (no drift by construction):
 *
 * - `dispatchMembership` (public mutation): the typed command dispatch for
 *   company-scoped membership operations (revokeInvitation,
 *   changeMembershipRole, revokeMembership, transferAdministration), with
 *   B1 identity resolution and the B3 policy.
 * - `admitCommand` (public mutation): the checked admission dispatch for a
 *   verified person without an active firm (createCompany,
 *   acceptInvitation, rejectInvitation) — the same envelope, contract
 *   decodes and closed errors as the dispatch, entered one seam earlier
 *   because the runtime dispatch requires a company scope (B1's own
 *   membership-less pattern).
 * - `createInvitationCommand` (public action): the issuance leg whose
 *   email delivery must run outside the transaction; the code crosses the
 *   internal boundary exactly once and never appears in results.
 *
 * `membershipOverview` (public query) is the barebones UI read: it resolves
 * the actor through the SAME canonical read-only chain B1's protected reads
 * use, and everything it returns is derived from the RESOLVED company
 * scope — no company or user id is ever accepted from client input.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, internalMutation, mutation, query } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Schema } from "effect";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import type { Id, Doc } from "../../_generated/dataModel";
import { liveSessionIdentity, liveSessionStore, resolveLiveSession } from "../identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import { normalizeEmail } from "../identity/userPolicy";
import { deliverApplicationEmail } from "../../integrations/email/send";
import {
  dispatchAdmissionCommand,
  dispatchCreateInvitation,
  dispatchMembershipCommand,
} from "./dispatch";
import { createInvitationEntry } from "./operations";

/** The sanitized denial error every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

/** Resolves the read-only actor chain, or throws the sanitized denial. */
async function requireLiveSession(
  db: Parameters<typeof liveSessionStore>[0],
  auth: { getUserIdentity(): Promise<{ subject: string } | null> },
) {
  const live = await resolveLiveSession(liveSessionStore(db), auth, Date.now());
  if (live.tag === "denied") {
    denialError(live.reason);
  }
  return live.session;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The company-scoped typed command dispatch (client path). */
export const dispatchMembership = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchMembershipCommand(ctx, args.envelope),
});

/** The admission typed command dispatch (verified, membership-less path). */
export const admitCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchAdmissionCommand(ctx, args.envelope),
});

/** The issuance transaction the action wraps (internal only). */
export const createInvitationTransaction = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchCreateInvitation(ctx, args.envelope),
});

/**
 * The issuance entry: dispatch inside the transaction, email delivery from
 * the action (the one place a fetch may run), and the honest delivery state
 * composed into the client envelope. The invitation row exists regardless
 * of delivery outcome; a failed delivery never fabricates a `sent`.
 */
export const createInvitationCommand = action({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const transaction = await ctx.runMutation(
      internal.access.membership.functions.createInvitationTransaction,
      { envelope: args.envelope },
    );
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
    return okResult(
      Schema.decodeUnknownSync(createInvitationEntry.result)({
        invitationId: issued.invitationId,
        expiresAtMs: issued.expiresAtMs,
        delivery: outcome.outcome === "sent" ? "sent" : "delivery_failed",
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Reads (barebones UI)
// ---------------------------------------------------------------------------

/** One pending invitation as the invitee sees it (no codes, ever). */
export interface PendingInvitationView {
  readonly invitationId: Id<"invitations">;
  readonly companyName: string;
  readonly role: "admin" | "member";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** One current member of the resolved company. */
export interface MemberView {
  readonly membershipId: Id<"memberships">;
  readonly userId: Id<"users">;
  readonly displayName: string;
  readonly email: string;
  readonly role: "admin" | "member";
  readonly isSelf: boolean;
}

/** One invitation of the resolved company, as an administrator sees it. */
export interface CompanyInvitationView {
  readonly invitationId: Id<"invitations">;
  readonly email: string;
  readonly role: "admin" | "member";
  readonly state: "pending" | "accepted" | "revoked" | "expired" | "rejected";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** The membership overview: admission state for a firm-less person, or the
 *  resolved company scope for a member. */
export type MembershipOverview =
  | {
      readonly state: "no_company";
      readonly sessionId: Id<"sessions">;
      readonly email: string;
      readonly displayName: string;
      readonly pendingInvitations: PendingInvitationView[];
    }
  | {
      readonly state: "member";
      readonly sessionId: Id<"sessions">;
      readonly company: {
        readonly companyId: Id<"companies">;
        readonly name: string;
        readonly timezone: string;
        readonly defaultCurrency: string;
      };
      readonly myRole: "admin" | "member";
      readonly members: MemberView[];
      readonly invitations: CompanyInvitationView[] | null;
    };

/** How many closed invitations the admin list keeps (bounded read). */
const MAX_INVITATION_ROWS = 50;

/**
 * Authenticated: the barebones membership surface read. A verified person
 * without an active firm sees their targeted pending invitations (their
 * entry to admission); a member sees the company and its members, plus the
 * invitation list when they administer the firm. Nothing from another
 * tenant can appear: every row is resolved through the canonical chain.
 */
export const membershipOverview = query({
  args: {},
  handler: async (ctx, args): Promise<MembershipOverview> => {
    void args;
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(session, Date.now()),
    );
    const user = await ctx.db.get(session.userId);
    if (user === null) {
      denialError("registry_missing");
    }
    const nowMs = Date.now();

    if (context === null) {
      // No active firm: the admission view (sign-in never confers access).
      const invitations = await ctx.db
        .query("invitations")
        .withIndex("by_email", (q) => q.eq("email", normalizeEmail(user.email)))
        .collect();
      const pending: PendingInvitationView[] = [];
      for (const invitation of invitations) {
        if (invitation.state !== "pending" || invitation.expiresAtMs <= nowMs) {
          continue;
        }
        const company = await ctx.db.get(invitation.companyId);
        if (company === null) {
          continue;
        }
        pending.push({
          invitationId: invitation._id,
          companyName: company.name,
          role: invitation.role,
          createdAtMs: invitation.createdAtMs,
          expiresAtMs: invitation.expiresAtMs,
        });
      }
      pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
      return {
        state: "no_company",
        sessionId: session.sessionId,
        email: user.email,
        displayName: user.displayName,
        pendingInvitations: pending,
      };
    }

    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      denialError("registry_missing");
    }
    const company = await ctx.db.get(companyId);
    if (company === null) {
      denialError("registry_missing");
    }

    const membershipRows = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
      .collect();
    const active = membershipRows
      .filter((row) => row.state === "active")
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    const members: MemberView[] = [];
    for (const row of active) {
      const memberUser = await ctx.db.get(row.userId);
      if (memberUser === null) {
        continue;
      }
      members.push({
        membershipId: row._id,
        userId: row.userId,
        displayName: memberUser.displayName,
        email: memberUser.email,
        role: row.role,
        isSelf: row.userId === session.userId,
      });
    }

    let invitations: CompanyInvitationView[] | null = null;
    if (context.actor.membershipRole === "admin") {
      const invitationRows = await ctx.db
        .query("invitations")
        .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
        .collect();
      invitations = invitationRows
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, MAX_INVITATION_ROWS)
        .map((row: Doc<"invitations">) => ({
          invitationId: row._id,
          email: row.email,
          role: row.role,
          state: row.state,
          createdAtMs: row.createdAtMs,
          expiresAtMs: row.expiresAtMs,
        }));
    }

    return {
      state: "member",
      sessionId: session.sessionId,
      company: {
        companyId,
        name: company.name,
        timezone: company.timezone,
        defaultCurrency: company.defaultCurrency,
      },
      myRole: context.actor.membershipRole,
      members,
      invitations,
    };
  },
});
