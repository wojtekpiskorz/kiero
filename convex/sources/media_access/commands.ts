/**
 * Sources media-access callable entries (D3).
 *
 * `mediaAccessFor` (internal query): the per-user channel's read
 * resolution the gateway's media routes consult on EVERY request. The HTTP
 * boundary (`./http.ts`) forwards the browser's Authorization header
 * verbatim; Convex propagates it into this query's `ctx.auth`, where B1's
 * live-session resolution and the canonical chain resolve the acting user
 * (live session -> active membership -> company) — the same identity path
 * as `uploadStateFor` (D2). A revoked session or membership answers the
 * sanitized `unauthenticated` refusal BEFORE any attachment row is read,
 * and the tenant-scoped resolution (access.ts) answers the uniform
 * `not_found` for anything the caller may not read — both before the
 * Worker touches R2.
 *
 * The checked body (`mediaAccessChecked`) is exported for tests/d3: the
 * SAME identity -> policy -> resolution path runs against the in-memory
 * harness (revoked session/membership denials included) without a
 * deployment; the live proofs run it against the real one.
 */

import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { membershipPolicy, unauthenticatedError } from "@kiero/runtime";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { mediaAccessDb, resolveMediaAccess } from "./access";

/**
 * The checked read path: caller identity (live session -> membership ->
 * company) -> policy authorization -> tenant-scoped resolution. Exported
 * for tests; the query below only adapts it to Convex.
 */
export async function mediaAccessChecked(
  db: Parameters<typeof resolveAccessContextFromConvexAuth>[0],
  auth: Parameters<typeof resolveAccessContextFromConvexAuth>[1],
  input: unknown,
  nowMs: number = Date.now(),
): Promise<ResultEnvelope> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, nowMs);
  if (context === null) {
    return errorResult(unauthenticatedError());
  }
  const decision = await membershipPolicy.authorize(context, { intent: "read" });
  if (!decision.allowed) {
    return errorResult(decision.error);
  }
  return resolveMediaAccess(mediaAccessDb(db), context, input);
}

/** The per-user media-access resolution (the forwarded user identity). */
export const mediaAccessFor = internalQuery({
  args: { attachmentId: v.optional(v.string()), representationId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    mediaAccessChecked(ctx.db, ctx.auth, args),
});
