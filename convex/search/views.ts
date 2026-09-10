/**
 * Search internal views (E5): the read halves the action-side query core and
 * the guarded probes drive through `runQuery` (actions have no db handle).
 *
 * Every view is tenant-scoped by a SERVER-RESOLVED company id (the context
 * queries) or by an explicit company+generation pair (the index reads): no
 * view accepts a client-supplied scope, and the entry reads go through the
 * `by_company_generation` index so neither a text nor a semantic result can
 * cross company scope.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";
import { resolveAccessContextFromConvexAuth } from "../access/identity/resolution";
import type { RequestContext } from "@kiero/runtime";
import { activeGenerationId } from "./generations";

/** The request context plus the Convex-normalized company id (action calls have no db). */
export type ScopedContext = RequestContext & {
  readonly normalizedCompanyId: Id<"companies"> | null;
};

/** Resolves the USER context through the B1 live-session chain (app path). */
export const userContext = internalQuery({
  args: {},
  handler: async (ctx): Promise<ScopedContext | null> => {
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      return null;
    }
    const normalizedCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (normalizedCompanyId === null) {
      return null;
    }
    return { ...context, normalizedCompanyId };
  },
});

/** Resolves the SERVICE context through the verified bridge identity. */
export const serviceContext = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ScopedContext | null> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return null;
    }
    const normalizedCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (normalizedCompanyId === null) {
      return null;
    }
    return { ...context, normalizedCompanyId };
  },
});

/** The active generation scope (null = degraded coverage). */
export interface ActiveGenerationResult {
  readonly generationId: Id<"searchIndexGenerations">;
}

export const activeGeneration = internalQuery({
  args: {},
  handler: async (ctx): Promise<ActiveGenerationResult | null> => {
    const generationId = await activeGenerationId(ctx);
    return generationId === null ? null : { generationId };
  },
});

/** One company-scoped index row over the wire. */
export interface EntryWireRow {
  readonly _id: Id<"searchEntries">;
  readonly sourceFragmentId: Id<"sourceFragments"> | null;
  readonly sourceId: Id<"sources"> | null;
  readonly findingId: Id<"findings"> | null;
  readonly findingRevisionId: Id<"findingRevisions"> | null;
  readonly preparedText: string;
  /** The raw vector when requested; `hasEmbedding` always tells the truth. */
  readonly embedding: number[] | null;
  readonly hasEmbedding: boolean;
}

/** Reads every index row of one company and generation (barebones scale). */
export const companyEntries = internalQuery({
  args: {
    companyId: v.id("companies"),
    generationId: v.id("searchIndexGenerations"),
    includeEmbeddings: v.boolean(),
  },
  handler: async (ctx, args): Promise<EntryWireRow[]> => {
    const rows = await ctx.db
      .query("searchEntries")
      .withIndex("by_company_generation", (q) =>
        q.eq("companyId", args.companyId).eq("generationId", args.generationId),
      )
      .collect();
    return rows.map((row) => ({
      _id: row._id,
      sourceFragmentId: row.sourceFragmentId ?? null,
      sourceId: row.sourceId ?? null,
      findingId: row.findingId ?? null,
      findingRevisionId: row.findingRevisionId ?? null,
      preparedText: row.preparedText,
      embedding: args.includeEmbeddings && row.embedding !== undefined ? row.embedding : null,
      hasEmbedding: row.embedding !== undefined,
    }));
  },
});

/** The canonical source state one hydration pass returns. */
export interface HydratedSourceWire {
  readonly sourceId: Id<"sources">;
  readonly companyId: Id<"companies">;
  readonly lifecycle: Doc<"sources">["lifecycle"];
  readonly linkedProjectIds: Id<"projects">[];
  readonly authorUserId: Id<"users">;
  readonly sentAtMs: number;
}

/** The canonical finding state one hydration pass returns. */
export interface HydratedFindingWire {
  readonly findingId: Id<"findings">;
  readonly companyId: Id<"companies">;
  readonly currentRevisionId: Id<"findingRevisions"> | null;
}

/** The hydration result: canonical records re-read for the candidates. */
export interface HydrationResult {
  readonly sources: HydratedSourceWire[];
  readonly findings: HydratedFindingWire[];
}

/** Re-reads the canonical records of the candidates (the hydration half). */
export const hydrateEntries = internalQuery({
  args: {
    companyId: v.id("companies"),
    sourceIds: v.array(v.id("sources")),
    findingIds: v.array(v.id("findings")),
  },
  handler: async (ctx, args): Promise<HydrationResult> => {
    const sources: HydratedSourceWire[] = [];
    for (const sourceId of args.sourceIds) {
      const source = await ctx.db.get(sourceId);
      if (source === null) {
        continue;
      }
      const links = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
        .collect();
      sources.push({
        sourceId: source._id,
        companyId: source.companyId,
        lifecycle: source.lifecycle,
        linkedProjectIds: links.map((link) => link.projectId),
        authorUserId: source.authorUserId,
        sentAtMs: source.sentAtMs,
      });
    }
    const findings: HydratedFindingWire[] = [];
    for (const findingId of args.findingIds) {
      const finding = await ctx.db.get(findingId);
      if (finding === null) {
        continue;
      }
      findings.push({
        findingId: finding._id,
        companyId: finding.companyId,
        currentRevisionId: finding.currentRevisionId ?? null,
      });
    }
    return { sources, findings };
  },
});
