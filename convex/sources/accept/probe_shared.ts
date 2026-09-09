/**
 * Shared plumbing for the sources lanes' guarded probe surfaces (D1; D2/D3
 * and later lanes reuse it instead of growing copies).
 *
 * One place for: the deployment-variable guard (the A3 probe pattern —
 * platform's own copy stays in convex/platform/probe.ts, which the sources
 * lanes do not own), the service-session resolution through the A3-proved
 * bridge identity, and the seeded-identity email → user → live session →
 * canonical request-context chain. Sessions are created server-side by the
 * seeding mutations; no identity is ever accepted from client input, and a
 * missing/revoked/incomplete chain resolves to null, which callers surface
 * as the sanitized `forbidden` service-identity error.
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unsupportedError, type RequestContext } from "@kiero/runtime";
import { api } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { bridgeIdentity, resolveRequestContext, type ResolutionDb } from "../../platform/context";

/** The A3 platform proof service account (seeded by platform/probe:probeSeed). */
export const SERVICE_EMAIL = "platform-service@kiero.invalid";

/** The D1 tenant-isolation fixture account (seeded by ./probe seedIsolation). */
export const ISOLATION_EMAIL = "d1-isolation@kiero.invalid";

/** The D1 tenant-isolation fixture company name. */
export const ISOLATION_COMPANY = "Kiero Dev Proof B (D1 isolation)";

/** The deployment guard, identical to the A3 platform probes. */
export function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

/** The guarded-entry refusal envelope (probe mechanics disabled). */
export function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("sources.probe", "probe_guard_disabled"));
}

/** The sanitized refusal for an unresolvable service identity. */
export function serviceIdentityUnavailable(): ResultEnvelope {
  return errorResult(forbiddenError("service_identity_unavailable"));
}

/** Resolves the service account's session id (the A3 fixture identity). */
export async function serviceSessionId(ctx: ActionCtx): Promise<string | null> {
  const session = await ctx.runQuery(api.platform.probe.serviceSession, {});
  return session === null ? null : session.sessionId;
}

/**
 * Resolves an explicitly seeded session id, falling back to the service
 * session. Explicit ids come only from server-side seeding mutations.
 */
export async function resolveProbeSession(
  ctx: ActionCtx,
  sessionId: string | undefined,
): Promise<string | null> {
  return sessionId ?? (await serviceSessionId(ctx));
}

/**
 * The seeded-identity chain for one email: user row → latest non-revoked
 * session → canonical request context through the verified bridge identity.
 * Returns null for any broken chain (unknown email, no live session,
 * revoked session, no active membership, missing company).
 */
export async function bridgeContextForEmail(
  db: ResolutionDb,
  email: string,
): Promise<RequestContext | null> {
  const user = await db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (user === null) {
    return null;
  }
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", user._id))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  if (session === null) {
    return null;
  }
  return resolveRequestContext(db, bridgeIdentity(session._id, Date.now()));
}
