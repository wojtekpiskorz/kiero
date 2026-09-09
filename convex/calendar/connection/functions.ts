/**
 * The G1 Convex function surface (generated-call APIs).
 *
 * The status read and the typed command dispatch follow the B1/B3 pattern
 * (generated API + canonical resolution). The OAuth START has two
 * identity-verified entries over ONE implementation (`performStartAuthorization`
 * in ./operations.ts): the HTTP boundary (`POST /calendar/oauth/start`,
 * ./http.ts — the gateway's path; it derives the redirect origin from the
 * request) and the public `startAuthorization` mutation below (the PWA's
 * path; it derives the redirect origin from the deployment-injected
 * `CONVEX_SITE_URL`). Both resolve the user/company scope through the SAME
 * canonical chain and never trust a client-supplied redirect.
 *
 * `refreshCredentials` is the credential capability G2/G3 consume: ONE
 * bounded refresh attempt with the echo uncertainty semantics (never a
 * retry loop), returning the typed outcome for the caller's own
 * reconciliation decisions.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalQuery, mutation, query } from "../../_generated/server";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, forbiddenError, unauthenticatedError } from "@kiero/runtime";
import type { Id } from "../../_generated/dataModel";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveAccessContextFromConvexAuth,
  resolveLiveSession,
} from "../../access/identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import {
  availableActions,
  decideRefreshOutcome,
  type ConnectionAction,
  type ReconnectReason,
} from "./cores";
import { openCredential, sealCredential } from "./credentialStore";
import {
  calendarOAuthConfig,
  callbackRedirectUri,
  earliestActiveCompanyId,
  performStartAuthorization,
} from "./operations";
import { dispatchCalendarCommand } from "./dispatch";
import {
  GOOGLE_CALENDAR_API_BASE,
  refreshAccessToken,
  scopesSatisfied,
  splitScopes,
} from "./protocol";

/** The sanitized denial every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

// ---------------------------------------------------------------------------
// Subject-based canonical resolution (the verified-subject scope seam).
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical user/company scope for a VERIFIED Convex Auth
 * subject (the same read-only chain every protected surface uses). Shared
 * by the HTTP boundary's internal query and the public start mutation.
 */
async function resolveSubjectScope(
  db: QueryCtx["db"] | MutationCtx["db"],
  subject: string,
  nowMs: number,
): Promise<{ userId: Id<"users">; companyId: Id<"companies"> } | null> {
  const context = await resolveAccessContextFromConvexAuth(
    db,
    { getUserIdentity: async () => ({ subject }) },
    nowMs,
  );
  if (context === null) {
    return null;
  }
  const userId = db.normalizeId("users", context.actor.userId);
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (userId === null || companyId === null) {
    return null;
  }
  return { userId, companyId };
}

/**
 * The internal subject resolution the HTTP boundary calls (only ./http.ts,
 * always with the subject Convex itself verified from the request's
 * Authorization header).
 */
export const resolveSubjectContext = internalQuery({
  args: { subject: v.string() },
  handler: async (ctx, args) => await resolveSubjectScope(ctx.db, args.subject, Date.now()),
});

/** The company name (the dedicated calendar's summary source). */
export const companyNameFor = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    return company?.name ?? null;
  },
});

// ---------------------------------------------------------------------------
// Start authorization (the PWA entry; the HTTP boundary is ./http.ts).
// ---------------------------------------------------------------------------

/**
 * Public: starts (or restarts) the actor's Calendar authorization and
 * returns the constructed Google authorization URL. The redirect origin is
 * the deployment's OWN site URL (injected by Convex) or the explicit
 * KIERO_CALENDAR_REDIRECT_URI — never a client-supplied value. The state,
 * PKCE verifier and every credential stay server-side.
 */
export const startAuthorization = mutation({
  args: {
    mode: v.optional(
      v.union(v.literal("connect"), v.literal("switch"), v.literal("recreate")),
    ),
    acknowledgeUnknownCreation: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return errorResult(unauthenticatedError("no_verified_identity"));
    }
    const resolved = await resolveSubjectScope(ctx.db, identity.subject, Date.now());
    if (resolved === null) {
      // Sign-in alone never confers a company scope (the B3 rule).
      return errorResult(forbiddenError("no_company_scope", "company"));
    }
    const config = calendarOAuthConfig(process.env);
    if (config.clientId === null || config.clientSecret === null) {
      // Refuse BEFORE any consent walk: without BOTH client names the
      // exchange can never run (the same honest earlier refusal the HTTP
      // start applies).
      return errorResult(conflictError("google_client_not_configured"));
    }
    const redirectUri = callbackRedirectUri(
      process.env,
      typeof process.env.CONVEX_SITE_URL === "string" ? process.env.CONVEX_SITE_URL : "",
    );
    if (!/^https:\/\//.test(redirectUri)) {
      // No honest absolute callback target: refuse rather than guess.
      return errorResult(conflictError("callback_origin_unresolvable"));
    }
    return await performStartAuthorization(
      ctx,
      {
        userId: resolved.userId,
        companyId: resolved.companyId,
        mode: args.mode ?? "connect",
        acknowledgeUnknownCreation: args.acknowledgeUnknownCreation ?? false,
        redirectUri,
        clientId: config.clientId,
      },
      Date.now(),
    );
  },
});

// ---------------------------------------------------------------------------
// Status (the barebones UI read).
// ---------------------------------------------------------------------------

/** The typed connection state G2/G3 and the Polish screen consume. */
export interface CalendarConnectionStatus {
  readonly state: "unavailable_no_company" | "pending_authorization" | "connected" | "disconnected" | "error";
  /** The row id (null before any connection ever existed). */
  readonly connectionId: Id<"calendarConnections"> | null;
  readonly availableActions: readonly ConnectionAction[];
  readonly googleCalendarId: string | null;
  readonly googleAccountEmail: string | null;
  readonly connectedAtMs: number | null;
  readonly disconnectedAtMs: number | null;
  readonly authorizationExpiresAtMs: number | null;
  readonly reconnectReason: ReconnectReason | null;
  readonly cleanupStatus: "not_applicable" | "unconfirmed" | null;
  readonly lastSuccessfulContactMs: number | null;
  /** The scopes Google granted on the last successful exchange. */
  readonly grantedScopes: readonly string[] | null;
  /** How the credential material is stored (encrypted or dev plaintext). */
  readonly credentialStorage: "encrypted_aesgcm" | "plaintext_dev" | "none" | null;
  /** Whether the connection can currently serve projections. */
  readonly credentialCapability: "ready" | "absent";
  /** Whether this deployment's Google OAuth client names carry values. */
  readonly providerConfigured: boolean;
}

/**
 * Authenticated: the actor's own connection status, resolved through the
 * canonical chain. A verified person without an active firm sees
 * `unavailable_no_company` — sign-in and identity are never this table's
 * business (disconnect leaves every login method untouched).
 *
 * Membership re-check (issue #45: membership loss follows the stop/cleanup
 * path): a row whose firm is no longer the actor's active firm reads as
 * the honest membership-lost STOP even before any write persists it — no
 * credential capability, no stale binding data, reconnect offered (the
 * restart re-scopes the row to the actor's current firm). The durable
 * stop lands on the next persisting operation (refresh, callback,
 * dispatch); the event-driven fan-out from B3's revocation is a named
 * prerequisite on the access lane.
 */
export const calendarStatus = query({
  args: {},
  handler: async (ctx): Promise<CalendarConnectionStatus> => {
    const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
    if (live.tag === "denied") {
      denialError(live.reason);
    }
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(live.session, Date.now()),
    );
    const config = calendarOAuthConfig(process.env);
    const base = {
      providerConfigured: config.clientId !== null && config.clientSecret !== null,
    };
    if (context === null) {
      return {
        state: "unavailable_no_company",
        connectionId: null,
        availableActions: [],
        googleCalendarId: null,
        googleAccountEmail: null,
        connectedAtMs: null,
        disconnectedAtMs: null,
        authorizationExpiresAtMs: null,
        reconnectReason: null,
        cleanupStatus: null,
        lastSuccessfulContactMs: null,
        grantedScopes: null,
        credentialStorage: null,
        credentialCapability: "absent",
        ...base,
      };
    }
    const row = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", live.session.userId))
      .first();
    if (row === null) {
      return {
        state: "disconnected",
        connectionId: null,
        availableActions: availableActions(null),
        googleCalendarId: null,
        googleAccountEmail: null,
        connectedAtMs: null,
        disconnectedAtMs: null,
        authorizationExpiresAtMs: null,
        reconnectReason: null,
        cleanupStatus: null,
        lastSuccessfulContactMs: null,
        grantedScopes: null,
        credentialStorage: null,
        credentialCapability: "absent",
        ...base,
      };
    }
    const activeCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (activeCompanyId !== null && row.companyId !== activeCompanyId) {
      // The row belongs to a firm the actor no longer actively belongs to:
      // report the stopped view (queries cannot persist; the durable stop
      // lands on the next persisting operation — refresh, callback,
      // dispatch — and on the access lane's revocation fan-out once wired).
      return {
        state: "error",
        connectionId: row._id,
        availableActions: availableActions({
          state: "error",
          authorizationMode: null,
          authorizationExpiresAtMs: null,
          googleCalendarId: null,
          googleAccountSubject: null,
          reconnectReason: "membership_lost",
        }),
        googleCalendarId: null,
        googleAccountEmail: null,
        connectedAtMs: null,
        disconnectedAtMs: row.disconnectedAtMs ?? null,
        authorizationExpiresAtMs: null,
        reconnectReason: "membership_lost",
        cleanupStatus: row.cleanupStatus ?? null,
        lastSuccessfulContactMs: null,
        grantedScopes: null,
        credentialStorage: null,
        credentialCapability: "absent",
        ...base,
      };
    }
    const credential =
      row.state === "connected"
        ? await openCredential(row.credentialStorage, row.credentialCiphertext, process.env)
        : null;
    return {
      state: row.state,
      connectionId: row._id,
      availableActions: availableActions({
        state: row.state,
        authorizationMode: row.authorizationMode ?? null,
        authorizationExpiresAtMs: row.authorizationExpiresAtMs ?? null,
        googleCalendarId: row.googleCalendarId ?? null,
        googleAccountSubject: row.googleAccountSubject ?? null,
        reconnectReason: row.reconnectReason ?? null,
      }),
      googleCalendarId: row.googleCalendarId ?? null,
      googleAccountEmail: row.googleAccountEmail ?? null,
      connectedAtMs: row.connectedAtMs ?? null,
      disconnectedAtMs: row.disconnectedAtMs ?? null,
      authorizationExpiresAtMs: row.authorizationExpiresAtMs ?? null,
      reconnectReason: row.reconnectReason ?? null,
      cleanupStatus: row.cleanupStatus ?? null,
      lastSuccessfulContactMs: row.lastSuccessfulContactMs ?? null,
      grantedScopes: row.grantedScopes ?? null,
      credentialStorage: row.credentialStorage ?? null,
      credentialCapability:
        row.state === "connected" && credential !== null ? "ready" : "absent",
      ...base,
    };
  },
});

// ---------------------------------------------------------------------------
// Typed command dispatch (the certified contract operations).
// ---------------------------------------------------------------------------

/** The company-scoped typed command dispatch (client path). */
export const dispatchCalendar = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchCalendarCommand(ctx, args.envelope),
});

// ---------------------------------------------------------------------------
// Credential capability (G2/G3 consumer surface).
// ---------------------------------------------------------------------------

/** One refresh attempt's typed result for the projection/reconciliation lanes. */
export interface RefreshResult {
  readonly outcome:
    | "refreshed"
    | "definitely_lost"
    | "unknown"
    | "membership_lost"
    | "no_connection"
    | "no_credential";
}

/**
 * The credential capability action: ONE bounded refresh attempt against the
 * configured token endpoint. The membership re-check runs FIRST: a
 * connected row whose firm is no longer the user's active firm is STOPPED
 * here (credentials cleared, unconfirmed cleanup recorded, the
 * `calendar.disconnected` event published) and answers `membership_lost` —
 * G2 must treat that as "stop publishing; the user reconnects for their
 * current firm".
 *
 * Uncertain outcomes are reported and recorded (updatedAtMs only) — never
 * retried here; a definite invalid_grant marks the connection
 * `error/refresh_failed` (the documented >1-week Testing-mode shape). G2
 * must treat `unknown` as "do not publish, do not retry blindly" and hand
 * the decision to reconciliation (G3).
 */
export const refreshCredentials = internalAction({
  args: { connectionId: v.string() },
  handler: async (ctx, args): Promise<RefreshResult> => {
    const loaded = await ctx.runQuery(
      internal.calendar.connection.functions.connectionCredentialForRefresh,
      { connectionId: args.connectionId },
    );
    if (loaded === null) {
      return { outcome: "no_connection" };
    }
    // The revocation path (issue #45: membership loss follows the
    // stop/cleanup path): the row's firm must still be the user's active
    // firm, or the connection stops before any Google leg runs.
    if (loaded.activeCompanyId === null || loaded.activeCompanyId !== loaded.companyId) {
      await ctx.runMutation(
        internal.calendar.connection.operations.disconnectForMembershipTransaction,
        { userId: loaded.userId },
      );
      return { outcome: "membership_lost" };
    }
    // Only the SEALED material crossed back from the query (function outputs
    // are logged too); the action opens it here, in memory.
    const bundle =
      loaded.sealed === null
        ? null
        : await openCredential(loaded.sealed.storage, loaded.sealed.ciphertext, process.env);
    if (bundle === null) {
      return { outcome: "no_credential" };
    }
    const config = calendarOAuthConfig(process.env);
    if (config.clientId === null || config.clientSecret === null || bundle.refreshToken === null) {
      return { outcome: "no_credential" };
    }
    const leg = await refreshAccessToken({
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: bundle.refreshToken,
    });
    const decision = decideRefreshOutcome(
      leg.kind === "granted"
        ? { kind: "granted", scopesSatisfied: scopesSatisfied(splitScopes(leg.grant.grantedScope)) }
        : { kind: "failed", failure: leg.failure },
    );
    if (decision.kind === "refreshed" && leg.kind === "granted") {
      // The action seals the refreshed bundle BEFORE the recording mutation:
      // raw tokens never appear in mutation arguments (function logs).
      const nowMs = Date.now();
      const sealed = await sealCredential(
        {
          accessToken: leg.grant.accessToken,
          refreshToken: leg.grant.refreshToken ?? bundle.refreshToken,
          accessTokenExpiresAtMs: nowMs + leg.grant.expiresInSeconds * 1000,
          obtainedAtMs: nowMs,
        },
        process.env,
      );
      await ctx.runMutation(internal.calendar.connection.operations.recordRefreshTransaction, {
        connectionId: args.connectionId,
        decision: "refreshed",
        credentialStorage: sealed.storage,
        credentialCiphertext: sealed.ciphertext,
        accessTokenExpiresAtMs: nowMs + leg.grant.expiresInSeconds * 1000,
      });
      return { outcome: "refreshed" };
    }
    if (decision.kind === "definitely_lost") {
      await ctx.runMutation(internal.calendar.connection.operations.recordRefreshTransaction, {
        connectionId: args.connectionId,
        decision: "definitely_lost",
      });
      return { outcome: "definitely_lost" };
    }
    await ctx.runMutation(internal.calendar.connection.operations.recordRefreshTransaction, {
      connectionId: args.connectionId,
      decision: "unknown",
    });
    return { outcome: "unknown" };
  },
});

/**
 * Loads a connected row's credential for the refresh action. Returns the
 * SEALED material only (query outputs are logged; the action opens it),
 * plus the row's firm and the user's active firm for the membership
 * re-check (earliestActiveCompanyId, the house rule).
 */
export const connectionCredentialForRefresh = internalQuery({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("calendarConnections", args.connectionId);
    if (id === null) {
      return null;
    }
    const row = await ctx.db.get(id);
    if (row === null || row.state !== "connected") {
      return null;
    }
    return {
      state: row.state,
      companyId: row.companyId,
      userId: row.userId,
      activeCompanyId: await earliestActiveCompanyId(ctx.db, row.userId),
      sealed:
        row.credentialStorage === undefined ||
        row.credentialStorage === "none" ||
        row.credentialCiphertext === undefined
          ? null
          : { storage: row.credentialStorage, ciphertext: row.credentialCiphertext },
    };
  },
});

/** Exported for tests: the API base with the proof override honored. */
export function calendarApiBase(env: { KIERO_G1_PROOF_ENABLED?: string; KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE?: string }): string {
  if (
    env.KIERO_G1_PROOF_ENABLED === "1" &&
    typeof env.KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE === "string" &&
    env.KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE.length > 0
  ) {
    return env.KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE;
  }
  return GOOGLE_CALENDAR_API_BASE;
}
