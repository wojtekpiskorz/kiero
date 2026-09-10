/**
 * Read-state queries (F1): the unread projection consumers subscribe to.
 *
 * One projection shape serves every consumer (issue 41: "query functions
 * for unread projections"): the caller supplies canonical `sourceId`s —
 * exactly the identity D1's `SourceConversationRow` carries in BOTH the
 * company and the project view — and receives this person's state per
 * source. Because the stored row has no view or device dimension, the same
 * query answers the company view, any project view and every device of
 * that person identically.
 *
 * Reads enforce the same tenant rules as mutations: every requested source
 * must exist and belong to the resolved company, or the whole request
 * fails `forbidden` (forged cross-company identifiers are rejected, never
 * silently filtered).
 *
 * `gmReadStateOverview` is the audited-GM INSPECTION read: it resolves GM
 * authority over one target company (open grant + open alpha activation,
 * the B4 decision functions) and lists that company's read-state rows
 * WITHOUT writing anything — GM reads never touch boss read state or
 * ordinary activity counters (issue 41 acceptance).
 *
 * Two callable shapes, one checked resolution (the D1 lane pattern):
 *
 * - public queries (Convex Auth identity; honestly `unauthenticated` until
 *   B1 ships sign-in),
 * - internal queries + guarded dev-proof actions (the A3 service-bridge
 *   identity; see ./probe.ts).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import { internalQuery, query } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { decideGmCompanyAccess, openGrantOfUser } from "../../access/gm/cores";
import {
  bridgeIdentity,
  identityFromConvexAuth,
  resolveRequestContext,
} from "../../platform/context";
import { MAX_PROJECTION_SOURCE_IDS, projectReadState, type StoredReadState } from "./state";

/** The DB reader surface these queries need (any Convex ctx.db). */
type ReadDb = QueryCtx["db"];

async function resolveOwnScope(ctx: QueryCtx) {
  const identity = await identityFromConvexAuth(ctx.auth, Date.now());
  const context = await resolveRequestContext(ctx.db, identity);
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

/** Tenant-checks and loads the read-state rows for the requested sources. */
async function readStateEntries(
  db: ReadDb,
  companyId: Id<"companies">,
  userId: Id<"users">,
  sourceIds: Id<"sources">[],
): Promise<ResultEnvelope> {
  if (sourceIds.length === 0) {
    return okResult({ userId, entries: [] });
  }
  if (sourceIds.length > MAX_PROJECTION_SOURCE_IDS) {
    return errorResult(forbiddenError("projection_too_large", "sources"));
  }
  const seen = new Set<Id<"sources">>();
  for (const sourceId of sourceIds) {
    if (seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);
    const source = await db.get(sourceId);
    if (source === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    if (source.companyId !== companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "sources"));
    }
  }
  const rows: StoredReadState[] = [];
  for (const sourceId of seen) {
    const row = await db
      .query("readStates")
      .withIndex("by_user_source", (q) => q.eq("userId", userId).eq("sourceId", sourceId))
      .first();
    if (row !== null) {
      rows.push({ sourceId: row.sourceId, read: row.read, readAtMs: row.readAtMs });
    }
  }
  return okResult({ userId, entries: projectReadState(sourceIds, rows) });
}

// --- public queries (Convex Auth identity) -----------------------------------

/** This person's read state over canonical source ids (client path). */
export const readStateForSources = query({
  args: { sourceIds: v.array(v.id("sources")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveOwnScope(ctx);
    if (scope === null) {
      return errorResult(unauthenticatedError());
    }
    return readStateEntries(ctx.db, scope.companyId, scope.userId, args.sourceIds);
  },
});

// --- internal queries (verified service session; the A3 bridge identity) ----

/** The same projection for a verified service session (bridge path). */
export const readStateForSourcesFor = internalQuery({
  args: { serviceSessionId: v.string(), sourceIds: v.array(v.id("sources")) },
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
    return readStateEntries(ctx.db, companyId, userId, args.sourceIds);
  },
});

/**
 * The audited-GM inspection read (READ-ONLY): lists one target company's
 * read-state rows under GM authority. It writes nothing — no boss's row,
 * no activity counter, no event. Authority resolution mirrors the B4 GM
 * dispatch gate (live session -> user -> OPEN grant; membership is
 * deliberately NOT consulted — GM is separate from company membership,
 * CONTEXT.md "GM"), and the per-company access is the B4 decision
 * (open grant + existing company + open alpha activation), re-decided
 * here inside the read.
 */
export const gmReadStateOverview = internalQuery({
  args: { gmSessionId: v.string(), companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const sessionId = ctx.db.normalizeId("sessions", args.gmSessionId);
    if (sessionId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const session = await ctx.db.get(sessionId);
    if (session === null || session.revokedAtMs !== undefined) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const grants = await ctx.db
      .query("gmAccessGrants")
      .withIndex("by_user_open", (q) => q.eq("userId", session.userId))
      .collect();
    const grant = openGrantOfUser(
      grants.map((row) => ({
        id: row._id,
        userId: row.userId,
        reason: row.reason,
        enteredAtMs: row.enteredAtMs,
        closedAtMs: row.closedAtMs ?? null,
      })),
    );
    const companyId = ctx.db.normalizeId("companies", args.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("company_not_found", "companies"));
    }
    const company = await ctx.db.get(companyId);
    const activation = await ctx.db
      .query("gmCompanyActivations")
      .withIndex("by_company_open", (q) => q.eq("companyId", companyId))
      .first();
    const access = decideGmCompanyAccess({
      grantOpen: grant !== null,
      companyExists: company !== null,
      activation:
        activation === null
          ? null
          : {
              id: activation._id,
              companyId: activation.companyId,
              activatedAtMs: activation.activatedAtMs,
              endedAtMs: activation.endedAtMs ?? null,
            },
    });
    if (!access.ok) {
      return errorResult(forbiddenError(access.code, "gm"));
    }
    const rows = await ctx.db
      .query("readStates")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      companyId,
      readStates: rows.map((row) => ({
        userId: row.userId,
        sourceId: row.sourceId,
        read: row.read,
        readAtMs: row.readAtMs,
      })),
    });
  },
});
