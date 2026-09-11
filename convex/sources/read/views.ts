/**
 * Company and project conversation views (D1).
 *
 * "Rozmowa firmy" (company conversation) is the canonical history:
 * `companyConversation` paginates `sources.by_company_order` — company plus
 * conversation order, the index the architecture declares for this read.
 *
 * "Rozmowa projektowa" (project conversation) is an ordered PROJECTION of
 * the same entries: `projectConversation` paginates `sourceProjectLinks.
 * by_project_order` and dereferences each link to the one immutable
 * original. No row is copied; both views decode through the same
 * SourceConversationRow, so source id, author, send snapshot, lifecycle,
 * processing state and project links resolve identically in either scope.
 *
 * Reads enforce current company membership: the context resolves from a
 * verified identity through the canonical chain (session -> user -> one
 * active membership -> company), and every row is additionally scoped by the
 * resolved company id in the query itself. Two callable shapes, one checked
 * resolution (mirroring the accept lane):
 *
 * - public queries (Convex Auth identity; honestly `unauthenticated` until
 *   B1 ships sign-in),
 * - internal queries + guarded dev-proof actions (the A3 service-bridge
 *   identity; see ./probe.ts).
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError, type RequestContext } from "@kiero/runtime";
import { internalQuery, query } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  bridgeIdentity,
  resolveRequestContext,
  type ResolutionDb,
} from "../../platform/context";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { Schema } from "effect";
import {
  ConversationPage,
  SourceConversationRow,
  deriveProcessingState,
  type ConversationPage as ConversationPageType,
} from "./rows";
// H3 exposition cores (additive, flagged): the dossier + evidence reads.
import { readSourceExpositionRows, readSourceEvidenceRows } from "./exposition";

type PaginationOpts = { cursor: string | null; numItems: number };
type RawPage<T> = { page: T[]; isDone: boolean; continueCursor: string };

/** Builds one conversation row from the immutable source and its durable context. */
async function conversationRow(
  db: ResolutionDb,
  source: Doc<"sources">,
): Promise<SourceConversationRow> {
  const links = await db
    .query("sourceProjectLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", source._id))
    .collect();
  const latestRun = await db
    .query("processingRuns")
    .withIndex("by_source_started", (q) => q.eq("sourceId", source._id))
    .order("desc")
    .first();
  return Schema.decodeUnknownSync(SourceConversationRow)({
    sourceId: source._id,
    authorUserId: source.authorUserId,
    authorText: source.authorText,
    sentAtMs: source.sentAtMs,
    sentAtTimezone: source.sentAtTimezone,
    fullyAcceptedAtMs: source.fullyAcceptedAtMs,
    lifecycle: source.lifecycle,
    processingState: deriveProcessingState(
      latestRun === null ? null : { state: latestRun.state },
    ),
    projectIds: links.map((link) => link.projectId),
  });
}

/** Canonical history page for one company (newest send intention first). */
async function companyConversationPage(
  db: ResolutionDb,
  companyId: Id<"companies">,
  pagination: PaginationOpts,
): Promise<ConversationPageType> {
  const raw: RawPage<Doc<"sources">> = await db
    .query("sources")
    .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
    .order("desc")
    .paginate(pagination);
  const page = await Promise.all(raw.page.map((source) => conversationRow(db, source)));
  return Schema.decodeUnknownSync(ConversationPage)({
    page,
    isDone: raw.isDone,
    continueCursor: raw.continueCursor,
  });
}

/** Project conversation projection: links in order, dereferenced, never copied. */
async function projectConversationPage(
  db: ResolutionDb,
  companyId: Id<"companies">,
  projectId: Id<"projects">,
  pagination: PaginationOpts,
): Promise<ResultEnvelope> {
  const project = await db.get(projectId);
  if (project === null) {
    return errorResult(forbiddenError("project_not_in_company", "projects"));
  }
  if (project.companyId !== companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "projects"));
  }
  const raw: RawPage<Doc<"sourceProjectLinks">> = await db
    .query("sourceProjectLinks")
    .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
    .order("desc")
    .paginate(pagination);
  const rows: SourceConversationRow[] = [];
  const seen = new Set<string>();
  for (const link of raw.page) {
    if (seen.has(link.sourceId)) {
      continue;
    }
    seen.add(link.sourceId);
    const source = await db.get(link.sourceId);
    if (source === null || source.companyId !== companyId) {
      continue;
    }
    rows.push(await conversationRow(db, source));
  }
  return okResult(
    Schema.decodeUnknownSync(ConversationPage)({
      page: rows,
      isDone: raw.isDone,
      continueCursor: raw.continueCursor,
    }),
  );
}

/** One immutable original by id, tenant-scoped (the "same source" anchor). */
async function sourceDetailRow(
  db: ResolutionDb,
  companyId: Id<"companies">,
  sourceId: Id<"sources">,
): Promise<ResultEnvelope> {
  const source = await db.get(sourceId);
  if (source === null) {
    return errorResult(forbiddenError("source_not_in_company", "sources"));
  }
  if (source.companyId !== companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "sources"));
  }
  return okResult(await conversationRow(db, source));
}

// --- public queries (Convex Auth identity) ---------------------------------

async function contextOrFail(ctx: QueryCtx) {
  // J1 prerequisite repair (same defect C4 flagged on C2's public entries):
  // B1's live-session read chain (no provisioning — queries never write).
  // The platform-generic subject is not a sessions-registry id, so ordinary
  // user tokens failed the resolution and the conversation views were
  // unreachable from the app.
  const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
  if (context === null) {
    return null;
  }
  const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return null;
  }
  return { companyId };
}

/** Company conversation view (client path; unauthenticated until B1). */
export const companyConversation = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await contextOrFail(ctx);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    return okResult(await companyConversationPage(ctx.db, resolved.companyId, args.paginationOpts));
  },
});

/** Project conversation view (client path; unauthenticated until B1). */
export const projectConversation = query({
  args: { projectId: v.id("projects"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await contextOrFail(ctx);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) {
      return errorResult(forbiddenError("project_not_in_company", "projects"));
    }
    return projectConversationPage(ctx.db, resolved.companyId, projectId, args.paginationOpts);
  },
});

/** One source detail (client path; unauthenticated until B1). */
export const sourceDetail = query({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await contextOrFail(ctx);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    return sourceDetailRow(ctx.db, resolved.companyId, sourceId);
  },
});

// --- internal queries (verified service session; the A3 bridge identity) ----

async function serviceContextOrFail(ctx: QueryCtx, serviceSessionId: string) {
  const context = await resolveRequestContext(ctx.db, bridgeIdentity(serviceSessionId, Date.now()));
  if (context === null) {
    return null;
  }
  const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return null;
  }
  return { companyId };
}

/** Company conversation view for the verified service session. */
export const companyConversationFor = internalQuery({
  args: { serviceSessionId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await serviceContextOrFail(ctx, args.serviceSessionId);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    return okResult(
      await companyConversationPage(ctx.db, resolved.companyId, args.paginationOpts),
    );
  },
});

/** Project conversation view for the verified service session. */
export const projectConversationFor = internalQuery({
  args: {
    serviceSessionId: v.string(),
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await serviceContextOrFail(ctx, args.serviceSessionId);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) {
      return errorResult(forbiddenError("project_not_in_company", "projects"));
    }
    return projectConversationPage(ctx.db, resolved.companyId, projectId, args.paginationOpts);
  },
});

/** One source detail for the verified service session. */
export const sourceDetailFor = internalQuery({
  args: { serviceSessionId: v.string(), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await serviceContextOrFail(ctx, args.serviceSessionId);
    if (resolved === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    return sourceDetailRow(ctx.db, resolved.companyId, sourceId);
  },
});

// --- H3 exposition reads (additive, flagged on the H1 memory-exposition
// precedent): the source dossier and the paginated evidence chain. Cores
// live in ./exposition.ts; rows carry their wire shapes and decode through
// the Effect schemas defined there. Unlike the helpers above (which narrow
// to the company id), these two keep the full RequestContext the cores'
// tenant checks read.

/** The client-path context (full) for the H3 exposition cores. */
async function expositionContextOrFail(ctx: QueryCtx): Promise<RequestContext | null> {
  return resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
}

/** The bridge-path context (full) for the H3 exposition cores. */
async function expositionServiceContextOrFail(
  ctx: QueryCtx,
  serviceSessionId: string,
): Promise<RequestContext | null> {
  return resolveRequestContext(ctx.db, bridgeIdentity(serviceSessionId, Date.now()));
}

/** The full dossier of one source (client path). */
export const sourceExposition = query({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await expositionContextOrFail(ctx);
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const row = await readSourceExpositionRows(ctx.db, context, sourceId);
    return row.ok ? okResult(row.row) : errorResult(row.error);
  },
});

/** The paginated evidence chain of one source (client path). */
export const sourceEvidence = query({
  args: { sourceId: v.id("sources"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await expositionContextOrFail(ctx);
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const page = await readSourceEvidenceRows(ctx.db, context, sourceId, args.paginationOpts);
    return page.ok ? okResult(page.page) : errorResult(page.error);
  },
});

/** The source dossier for the verified service session. */
export const sourceExpositionFor = internalQuery({
  args: { serviceSessionId: v.string(), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await expositionServiceContextOrFail(ctx, args.serviceSessionId);
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const row = await readSourceExpositionRows(ctx.db, context, sourceId);
    return row.ok ? okResult(row.row) : errorResult(row.error);
  },
});

/** The paginated evidence chain for the verified service session. */
export const sourceEvidenceFor = internalQuery({
  args: {
    serviceSessionId: v.string(),
    sourceId: v.id("sources"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await expositionServiceContextOrFail(ctx, args.serviceSessionId);
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const page = await readSourceEvidenceRows(ctx.db, context, sourceId, args.paginationOpts);
    return page.ok ? okResult(page.page) : errorResult(page.error);
  },
});
