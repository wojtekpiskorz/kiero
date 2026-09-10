/**
 * The C4 Convex function surface (generated-call APIs).
 *
 * One core set, two callable entries (no drift by construction):
 *
 * - `dispatchWork` (public mutation): the typed command dispatch for the
 *   company-scoped work operations (changeTask, changeTaskState,
 *   changeChecklistItem, promoteChecklistItem, changeEvent,
 *   changeEventState), with B1 identity resolution and the C4 policy. Each
 *   command, its history row and its canonical event commit atomically
 *   inside the mutation.
 * - `workOverview` (public query): the barebones work read. It resolves
 *   the actor through the SAME canonical read-only chain B1/B3/C1 protected
 *   reads use, and everything it returns is derived from the RESOLVED
 *   company scope — no company, task or event id is ever accepted from
 *   client input, so no other tenant's row can appear. Dueness and
 *   effective coordination are derived at read time in the company
 *   timezone; the reactive query re-evaluates as rows change (the clock
 *   itself is sampled per evaluation — consumers needing a live overdue
 *   tick re-query).
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import type { Id } from "../_generated/dataModel";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
} from "../access/identity/resolution";
import { resolveRequestContext } from "../platform/context";
import { dispatchWorkCommand } from "./dispatch";
import { readWorkOverview, type WorkOverview } from "./read";

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
export const dispatchWork = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchWorkCommand(ctx, args.envelope),
});

// ---------------------------------------------------------------------------
// Reads (barebones work list)
// ---------------------------------------------------------------------------

/** The work overview plus the session it was resolved for. */
export interface WorkOverviewRead extends WorkOverview {
  readonly sessionId: Id<"sessions">;
}

/**
 * Authenticated: the barebones work read. Tasks (with checklists, derived
 * dueness and effective coordination) and events (with derived timing) of
 * the RESOLVED company, including those of closed projects.
 */
export const workOverview = query({
  args: {},
  handler: async (ctx): Promise<WorkOverviewRead> => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(session, Date.now()),
    );
    if (context === null) {
      // Work is company knowledge: a verified person without an active firm
      // has no queue to read (their surface is the admission path).
      denialError("no_company_scope");
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      denialError("registry_missing");
    }
    const overview = await readWorkOverview(ctx.db, companyId, Date.now());
    return { sessionId: session.sessionId, ...overview };
  },
});
