/**
 * D1 conversation-view dev proofs (guarded by KIERO_PROBE_ENABLED, like the
 * A3 platform probes; shared plumbing lives in
 * convex/sources/accept/probe_shared.ts).
 *
 * Each action resolves the default service session (or an explicitly seeded
 * session) and runs the SAME internal view query the Worker bridge would,
 * so the evidence exercises the real authorization and projection path — no
 * development-auth shortcut, no client-supplied identity.
 */

import { v } from "convex/values";
import { action } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

/** Company conversation page (guarded; service or seeded session). */
export const probeCompanyConversation = action({
  args: { sessionId: v.optional(v.string()), numItems: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.companyConversationFor, {
      serviceSessionId: sessionId,
      paginationOpts: { numItems: args.numItems, cursor: args.cursor ?? null },
    });
  },
});

/** Project conversation page (guarded; service or seeded session). */
export const probeProjectConversation = action({
  args: {
    sessionId: v.optional(v.string()),
    projectId: v.id("projects"),
    numItems: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.projectConversationFor, {
      serviceSessionId: sessionId,
      projectId: args.projectId,
      paginationOpts: { numItems: args.numItems, cursor: args.cursor ?? null },
    });
  },
});

/** One immutable source detail (guarded; service or seeded session). */
export const probeSourceDetail = action({
  args: { sessionId: v.optional(v.string()), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.sourceDetailFor, {
      serviceSessionId: sessionId,
      sourceId: args.sourceId,
    });
  },
});
