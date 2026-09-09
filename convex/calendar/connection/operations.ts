/**
 * Calendar connection transactions (G1): the write halves of the cores,
 * each inside ONE Convex mutation.
 *
 * Every step that can throw (row lookups, decodes, hashing, sealing) runs
 * BEFORE the first insert/patch (the B3 atomicity contract). The external
 * legs NEVER run inside a transaction: mutations cannot fetch, and the
 * callback protocol is deliberately split into
 * `prepareCallbackTransaction` (consume the single-use state, re-check
 * membership) -> the httpAction's bounded external calls -> one terminal
 * `completeCallbackTransaction`, mirroring the A3 echo template
 * (intent commits first, the effect leaves the transaction, the outcome is
 * recorded exactly once).
 *
 * Environment names consumed here (values are owner-supplied, never
 * committed): AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET (the owner's Google
 * Cloud OAuth client, shared with B1's sign-in), KIERO_CALENDAR_TOKEN_KEY
 * (credential sealing), KIERO_CALENDAR_REDIRECT_URI (explicit redirect
 * override), and the proof-only names guarded by KIERO_G1_PROOF_ENABLED
 * (see ./proof.ts).
 */

import { v } from "convex/values";
import {
  errorResult,
  okResult,
  parseTableId,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  AUTHORIZATION_TTL_MS,
  decideCallbackCorrelation,
  decideDisconnect,
  decideStartAuthorization,
  type AuthorizationMode,
  type ConnectionRowView,
  type ReconnectReason,
} from "./cores";
import {
  GOOGLE_TOKEN_ENDPOINT,
  buildAuthorizationUrl,
  generateAuthorizationChallenge,
  sha256Hex,
} from "./protocol";
import { proofFixtureClient } from "./proof";

// ---------------------------------------------------------------------------
// Environment shape (names only; values are deploy-time snapshots).
// ---------------------------------------------------------------------------

/** The OAuth configuration one deployment offers (honest when absent). */
export interface CalendarOAuthConfig {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly tokenEndpoint: string;
  readonly proofMode: boolean;
}

/** Reads the OAuth configuration; proof fixtures never mask real values. */
export function calendarOAuthConfig(env: {
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  KIERO_G1_PROOF_ENABLED?: string;
  KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE?: string;
}): CalendarOAuthConfig {
  const proofMode = env.KIERO_G1_PROOF_ENABLED === "1";
  const clientId =
    typeof env.AUTH_GOOGLE_ID === "string" && env.AUTH_GOOGLE_ID.length > 0
      ? env.AUTH_GOOGLE_ID
      : proofMode
        ? proofFixtureClient().clientId
        : null;
  const clientSecret =
    typeof env.AUTH_GOOGLE_SECRET === "string" && env.AUTH_GOOGLE_SECRET.length > 0
      ? env.AUTH_GOOGLE_SECRET
      : proofMode
        ? proofFixtureClient().clientSecret
        : null;
  return {
    clientId,
    clientSecret,
    tokenEndpoint:
      proofMode && typeof env.KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE === "string"
        ? env.KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE
        : GOOGLE_TOKEN_ENDPOINT,
    proofMode,
  };
}

/** The redirect URI for one request: explicit env override wins. */
export function callbackRedirectUri(env: { KIERO_CALENDAR_REDIRECT_URI?: string }, requestOrigin: string): string {
  const override = env.KIERO_CALENDAR_REDIRECT_URI;
  return typeof override === "string" && override.length > 0
    ? override
    : `${requestOrigin.replace(/\/$/, "")}/calendar/oauth/callback`;
}

// ---------------------------------------------------------------------------
// Row plumbing.
// ---------------------------------------------------------------------------

/** The row view the pure cores consume (never client input). */
export function connectionView(row: Doc<"calendarConnections">): ConnectionRowView {
  return {
    state: row.state,
    authorizationMode: row.authorizationMode ?? null,
    authorizationExpiresAtMs: row.authorizationExpiresAtMs ?? null,
    googleCalendarId: row.googleCalendarId ?? null,
    googleAccountSubject: row.googleAccountSubject ?? null,
    reconnectReason: (row.reconnectReason as ReconnectReason | undefined) ?? null,
  };
}

async function rowByUser(db: MutationCtx["db"], userId: Id<"users">): Promise<Doc<"calendarConnections"> | null> {
  return await db
    .query("calendarConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

async function rowByStateHash(db: MutationCtx["db"], stateHash: string): Promise<Doc<"calendarConnections"> | null> {
  return await db
    .query("calendarConnections")
    .withIndex("by_state_hash", (q) => q.eq("oauthStateHash", stateHash))
    .first();
}

function bridgedConnectionId(rowId: Id<"calendarConnections">): ReturnType<typeof parseTableId<"calendarConnections">> {
  const bridged = parseTableId("calendarConnections", rowId);
  if (bridged === null) {
    throw new Error("calendar connection: malformed row id");
  }
  return bridged;
}

/** parseTableId's non-null half over user row ids. */
function bridgedUserId(rowId: Id<"users">): ReturnType<typeof parseTableId<"users">> {
  const bridged = parseTableId("users", rowId);
  if (bridged === null) {
    throw new Error("calendar connection: malformed user id");
  }
  return bridged;
}

// ---------------------------------------------------------------------------
// Start authorization.
// ---------------------------------------------------------------------------

/**
 * The start transaction: checked decision, then ONE insert-or-patch that
 * replaces the flow fields. A switch keeps the previous binding's calendar,
 * account and credentials on the row until the new authorization completes
 * (a failed switch restores, it never destroys).
 */
export async function performStartAuthorization(
  ctx: MutationCtx,
  args: {
    readonly userId: Id<"users">;
    readonly companyId: Id<"companies">;
    readonly mode: AuthorizationMode;
    readonly acknowledgeUnknownCreation: boolean;
    readonly redirectUri: string;
    readonly clientId: string;
  },
  nowMs: number,
): Promise<ResultEnvelope> {
  const existing = await rowByUser(ctx.db, args.userId);
  const decision = decideStartAuthorization(
    existing === null ? null : connectionView(existing),
    { mode: args.mode, acknowledgeUnknownCreation: args.acknowledgeUnknownCreation },
    nowMs,
  );
  if (decision.kind === "refuse") {
    return errorResult(conflictError(decision.code));
  }
  const challenge = await generateAuthorizationChallenge();
  const flow = {
    oauthStateHash: challenge.stateHash,
    pkceVerifier: challenge.verifier,
    authorizationMode: args.mode,
    authorizationExpiresAtMs: nowMs + AUTHORIZATION_TTL_MS,
  };
  if (existing === null) {
    await ctx.db.insert("calendarConnections", {
      companyId: args.companyId,
      userId: args.userId,
      state: "pending_authorization",
      updatedAtMs: nowMs,
      ...flow,
    });
  } else {
    await ctx.db.patch(existing._id, {
      state: "pending_authorization",
      updatedAtMs: nowMs,
      // An error reason never survives a new attempt.
      reconnectReason: undefined,
      ...flow,
    });
  }
  const authorizationUrl = buildAuthorizationUrl({
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    state: challenge.state,
    codeChallenge: challenge.codeChallenge,
  });
  return okResult({
    authorizationUrl,
    expiresAtMs: flow.authorizationExpiresAtMs,
  });
}

/** Internal wrapper the HTTP start route uses (identity already verified). */
export const startFlowTransaction = internalMutation({
  args: {
    userId: v.id("users"),
    companyId: v.id("companies"),
    mode: v.union(v.literal("connect"), v.literal("switch"), v.literal("recreate")),
    acknowledgeUnknownCreation: v.boolean(),
    redirectUri: v.string(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const config = calendarOAuthConfig(process.env);
    if (config.clientId === null) {
      return errorResult(
        conflictError("google_client_not_configured"),
      );
    }
    return await performStartAuthorization(
      ctx,
      { ...args, clientId: config.clientId },
      Date.now(),
    );
  },
});

// ---------------------------------------------------------------------------
// Callback: prepare (consume state) -> external legs -> complete.
// ---------------------------------------------------------------------------

/** The flow data the httpAction's external legs need. */
export interface PreparedCallback {
  readonly connectionId: Id<"calendarConnections">;
  readonly companyId: Id<"companies">;
  readonly userId: Id<"users">;
  readonly verifier: string;
  readonly mode: AuthorizationMode;
  readonly redirectUri: string;
  /** Known dedicated calendar of a previous/same binding, when one exists. */
  readonly knownCalendarId: string | null;
  readonly knownGoogleSubject: string | null;
}

export type PreparedCallbackResult =
  | { readonly status: "proceed"; readonly flow: PreparedCallback }
  | { readonly status: "invalid_state" }
  | { readonly status: "finish_error"; readonly reason: ReconnectReason };

/**
 * Consumes the single-use state and re-checks membership. The state hash is
 * REMOVED here, atomically with the read: a replayed or raced callback finds
 * no correlation and fails closed, whatever it presents.
 */
export const prepareCallbackTransaction = internalMutation({
  args: { state: v.string(), redirectUri: v.string() },
  handler: async (ctx, args): Promise<PreparedCallbackResult> => {
    if (args.state.length === 0 || args.state.length > 256) {
      return { status: "invalid_state" };
    }
    const stateHash = await sha256Hex(args.state);
    const row = await rowByStateHash(ctx.db, stateHash);
    const correlation = decideCallbackCorrelation(
      row === null
        ? null
        : {
            state: row.state,
            oauthStateHash: row.oauthStateHash ?? null,
            authorizationExpiresAtMs: row.authorizationExpiresAtMs ?? null,
          },
      Date.now(),
    );
    if (correlation.kind === "invalid_state") {
      return { status: "invalid_state" };
    }
    if (row === null) {
      // Unreachable after a matched correlation; kept fail-closed.
      return { status: "invalid_state" };
    }
    if (correlation.kind === "expired") {
      await ctx.db.patch(row._id, {
        oauthStateHash: undefined,
        pkceVerifier: undefined,
        state: "error",
        reconnectReason: "authorization_expired",
        updatedAtMs: Date.now(),
      });
      return { status: "finish_error", reason: "authorization_expired" };
    }
    // Membership re-check at the callback: the canonical earliest-active
    // membership must still be this row's company (a revoked boss never
    // completes a connection).
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .collect();
    const active = memberships
      .filter((m) => m.state === "active")
      .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
    if (active === undefined || active.companyId !== row.companyId) {
      await ctx.db.patch(row._id, {
        oauthStateHash: undefined,
        pkceVerifier: undefined,
        credentialCiphertext: undefined,
        credentialStorage: "none",
        accessTokenExpiresAtMs: undefined,
        state: "error",
        reconnectReason: "membership_lost",
        updatedAtMs: Date.now(),
      });
      return { status: "finish_error", reason: "membership_lost" };
    }
    await ctx.db.patch(row._id, { oauthStateHash: undefined, updatedAtMs: Date.now() });
    return {
      status: "proceed",
      flow: {
        connectionId: row._id,
        companyId: row.companyId,
        userId: row.userId,
        verifier: row.pkceVerifier ?? "",
        mode: row.authorizationMode ?? "connect",
        redirectUri: args.redirectUri,
        knownCalendarId: row.googleCalendarId ?? null,
        knownGoogleSubject: row.googleAccountSubject ?? null,
      },
    };
  },
});

/** The terminal outcome shapes the completion mutation accepts. */
export type CallbackCompletion =
  | { readonly kind: "connected"; readonly calendarId: string; readonly calendarReused: boolean }
  | { readonly kind: "error"; readonly reason: ReconnectReason };

/**
 * Applies the terminal completion: exactly ONE row patch plus the canonical
 * events. Raw Google tokens never appear in this mutation's ARGUMENTS
 * (Convex records function arguments in its logs): the calling ACTION seals
 * the bundle with the deployment key first, and only the sealed storage and
 * expiry cross the boundary. An account-switch publishes the honest
 * disconnected -> connected pair so the copy lane can reconcile the old
 * calendar.
 */
export const completeCallbackTransaction = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    completion: v.any(),
    /** Sealed by the calling action (see sealCredential); never raw tokens. */
    credentialStorage: v.optional(v.string()),
    credentialCiphertext: v.optional(v.string()),
    accessTokenExpiresAtMs: v.optional(v.float64()),
    googleAccountSubject: v.optional(v.string()),
    googleAccountEmail: v.optional(v.string()),
    grantedScope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; state: string }> => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null || row.state !== "pending_authorization") {
      // Disconnected/expired meanwhile: the terminal write loses the race
      // by design (disconnect-during-pending wins).
      return { ok: false, state: row?.state ?? "missing" };
    }
    const completion = args.completion as CallbackCompletion;
    const nowMs = Date.now();
    const view = connectionView(row);
    const wasSwitch = view.authorizationMode === "switch" && view.googleCalendarId !== null;

    if (completion.kind === "connected") {
      const accountChanged =
        view.googleAccountSubject !== null &&
        view.googleAccountSubject !== args.googleAccountSubject;
      await ctx.db.patch(row._id, {
        state: "connected",
        googleCalendarId: completion.calendarId,
        ...(args.googleAccountSubject === undefined
          ? {}
          : { googleAccountSubject: args.googleAccountSubject }),
        ...(args.googleAccountEmail === undefined
          ? {}
          : { googleAccountEmail: args.googleAccountEmail }),
        grantedScopes: (args.grantedScope ?? "").split(/\s+/).filter((s) => s.length > 0),
        ...(args.credentialStorage === undefined
          ? {}
          : { credentialStorage: args.credentialStorage as "encrypted_aesgcm" | "plaintext_dev" | "none" }),
        ...(args.credentialCiphertext === undefined
          ? {}
          : { credentialCiphertext: args.credentialCiphertext }),
        ...(args.accessTokenExpiresAtMs === undefined
          ? {}
          : { accessTokenExpiresAtMs: args.accessTokenExpiresAtMs }),
        pkceVerifier: undefined,
        authorizationMode: undefined,
        authorizationExpiresAtMs: undefined,
        reconnectReason: undefined,
        cleanupStatus: "not_applicable",
        lastSuccessfulContactMs: nowMs,
        connectedAtMs: row.connectedAtMs ?? nowMs,
        disconnectedAtMs: undefined,
        updatedAtMs: nowMs,
      });
      if (wasSwitch && accountChanged) {
        // The previous binding's calendar is no longer managed by this
        // connection: record unconfirmed cleanup for the copy lane.
        await ctx.db.patch(row._id, { cleanupStatus: "unconfirmed" });
        await publishEvent(ctx, {
          companyId: row.companyId,
          eventName: "calendar.disconnected",
          payload: { connectionId: bridgedConnectionId(row._id) },
          dedupKey: `calendar.switch-disconnect:${row._id}:${nowMs}`,
        });
      }
      await publishEvent(ctx, {
        companyId: row.companyId,
        eventName: "calendar.connected",
        payload: {
          connectionId: bridgedConnectionId(row._id),
          userId: bridgedUserId(row.userId),
        },
        dedupKey: `calendar.connected:${row._id}:${nowMs}`,
      });
      return { ok: true, state: "connected" };
    }

    // Failure shapes: a failed switch restores the still-working binding.
    if (wasSwitch) {
      await ctx.db.patch(row._id, {
        state: "connected",
        pkceVerifier: undefined,
        authorizationMode: undefined,
        authorizationExpiresAtMs: undefined,
        updatedAtMs: nowMs,
      });
      return { ok: true, state: "connected" };
    }
    // When the flow consented a DIFFERENT Google account than the recorded
    // binding, the old account's calendar id is no longer this row's
    // recovery path: record the consenting account, drop the stale id, and
    // let the honest error state carry the reason.
    const subjectChanged =
      args.googleAccountSubject !== undefined &&
      row.googleAccountSubject !== undefined &&
      args.googleAccountSubject !== row.googleAccountSubject;
    await ctx.db.patch(row._id, {
      state: "error",
      reconnectReason: completion.kind === "error" ? completion.reason : "exchange_failed",
      pkceVerifier: undefined,
      authorizationMode: undefined,
      authorizationExpiresAtMs: undefined,
      credentialCiphertext: undefined,
      credentialStorage: "none",
      accessTokenExpiresAtMs: undefined,
      ...(subjectChanged
        ? {
            googleAccountSubject: args.googleAccountSubject ?? undefined,
            googleCalendarId: undefined,
            googleAccountEmail: undefined,
          }
        : {}),
      updatedAtMs: nowMs,
    });
    return { ok: true, state: "error" };
  },
});

// ---------------------------------------------------------------------------
// Disconnect (user path, cancel path, membership-loss stop).
// ---------------------------------------------------------------------------

/** The disconnect transaction: one patch + the canonical stop event. */
export async function performDisconnect(
  ctx: MutationCtx,
  args: {
    readonly userId: Id<"users">;
    readonly initiator: "user" | "membership_loss";
    readonly reason?: ReconnectReason;
  },
  nowMs: number,
): Promise<{ ok: boolean; state: string }> {
  const row = await rowByUser(ctx.db, args.userId);
  if (row === null) {
    return { ok: true, state: "none" };
  }
  const decision = decideDisconnect(connectionView(row));
  if (decision.kind === "noop") {
    return { ok: true, state: row.state };
  }
  if (decision.kind === "cancel_switch") {
    await ctx.db.patch(row._id, {
      state: "connected",
      oauthStateHash: undefined,
      pkceVerifier: undefined,
      authorizationMode: undefined,
      authorizationExpiresAtMs: undefined,
      updatedAtMs: nowMs,
    });
    return { ok: true, state: "connected" };
  }
  const wasConnected = row.state === "connected";
  await ctx.db.patch(row._id, {
    state: "disconnected",
    oauthStateHash: undefined,
    pkceVerifier: undefined,
    authorizationMode: undefined,
    authorizationExpiresAtMs: undefined,
    // Structural stop: no credential material survives a disconnect.
    credentialCiphertext: undefined,
    credentialStorage: "none",
    accessTokenExpiresAtMs: undefined,
    ...(args.initiator === "membership_loss" ? { reconnectReason: "membership_lost" } : {}),
    ...(decision.recordCleanup ? { cleanupStatus: "unconfirmed" as const } : {}),
    disconnectedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  if (wasConnected || row.state === "pending_authorization") {
    await publishEvent(ctx, {
      companyId: row.companyId,
      eventName: "calendar.disconnected",
      payload: { connectionId: bridgedConnectionId(row._id) },
      dedupKey: `calendar.disconnected:${row._id}:${nowMs}`,
    });
  }
  return { ok: true, state: "disconnected" };
}

/** Internal entry the membership-loss stop path uses (B3-join ready). */
export const disconnectForMembershipTransaction = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => performDisconnect(ctx, { userId: args.userId, initiator: "membership_loss" }, Date.now()),
});

// ---------------------------------------------------------------------------
// Contract operations (calendar.connectCalendar / calendar.disconnectCalendar).
// ---------------------------------------------------------------------------

/**
 * `calendar.connectCalendar`: completes the ACTOR'S pending flow with a
 * known dedicated calendar id. It is the typed-dispatch completion surface
 * (tests, the barebones UI, future integrators); the OAuth callback runs
 * the same connected transition with credentials through
 * completeCallbackTransaction. A connection completed here records
 * credentialStorage "none": without a credential capability G2 projection
 * stays idle — an honest state, never a fake one.
 */
export async function performConnectCalendar(
  ctx: MutationCtx,
  context: RequestContext,
  input: { readonly googleCalendarId: string },
): Promise<ResultEnvelope> {
  const row = await rowByUser(ctx.db, normalizedUserId(ctx, context));
  if (row === null || row.state !== "pending_authorization") {
    return errorResult(conflictError("no_pending_authorization"));
  }
  const nowMs = Date.now();
  await ctx.db.patch(row._id, {
    state: "connected",
    googleCalendarId: input.googleCalendarId,
    credentialStorage: "none",
    pkceVerifier: undefined,
    oauthStateHash: undefined,
    authorizationMode: undefined,
    authorizationExpiresAtMs: undefined,
    reconnectReason: undefined,
    cleanupStatus: "not_applicable",
    connectedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await publishEvent(ctx, {
    companyId: row.companyId,
    eventName: "calendar.connected",
    payload: {
      connectionId: bridgedConnectionId(row._id),
      userId: bridgedUserId(row.userId),
    },
    dedupKey: `calendar.connected:${row._id}:${nowMs}`,
  });
  return okResult({ connectionId: row._id });
}

function normalizedUserId(ctx: MutationCtx, context: RequestContext): Id<"users"> {
  const id = ctx.db.normalizeId("users", context.actor.userId);
  if (id === null) {
    throw new Error("calendar connection: malformed actor user id");
  }
  return id;
}

/**
 * `calendar.disconnectCalendar`: the same stop core as the UI path, entered
 * through the typed dispatch. A foreign connection id is not the actor's
 * business: not_found, no existence leak.
 */
export async function performDisconnectCalendar(
  ctx: MutationCtx,
  context: RequestContext,
  input: { readonly connectionId: string },
): Promise<ResultEnvelope> {
  const id = ctx.db.normalizeId("calendarConnections", input.connectionId);
  if (id === null) {
    return errorResult(notFoundError("calendarConnections"));
  }
  const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(notFoundError("calendarConnections"));
  }
  const row = await ctx.db.get(id);
  if (row === null || row.userId !== normalizedUserId(ctx, context) || row.companyId !== companyId) {
    return errorResult(notFoundError("calendarConnections"));
  }
  const outcome = await performDisconnect(
    ctx,
    { userId: row.userId, initiator: "user" },
    Date.now(),
  );
  if (!outcome.ok) {
    return errorResult(validationError("disconnect_not_applied"));
  }
  return okResult({ connectionId: id });
}

// ---------------------------------------------------------------------------
// Refresh outcome recording (the action half lives in functions.ts).
// ---------------------------------------------------------------------------

/** Applies one refresh decision to the row (never a retry loop). */
export const recordRefreshTransaction = internalMutation({
  args: {
    connectionId: v.string(),
    decision: v.union(
      v.literal("refreshed"),
      v.literal("definitely_lost"),
      v.literal("unknown"),
    ),
    /** Sealed by the calling action; raw tokens never cross this boundary. */
    credentialStorage: v.optional(v.string()),
    credentialCiphertext: v.optional(v.string()),
    accessTokenExpiresAtMs: v.optional(v.float64()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; state: string }> => {
    const id = ctx.db.normalizeId("calendarConnections", args.connectionId);
    if (id === null) {
      return { ok: false, state: "missing" };
    }
    const row = await ctx.db.get(id);
    if (row === null || row.state !== "connected") {
      return { ok: false, state: row?.state ?? "missing" };
    }
    const nowMs = Date.now();
    if (args.decision === "refreshed") {
      await ctx.db.patch(row._id, {
        ...(args.credentialStorage === undefined
          ? {}
          : { credentialStorage: args.credentialStorage as "encrypted_aesgcm" | "plaintext_dev" | "none" }),
        ...(args.credentialCiphertext === undefined
          ? {}
          : { credentialCiphertext: args.credentialCiphertext }),
        ...(args.accessTokenExpiresAtMs === undefined
          ? {}
          : { accessTokenExpiresAtMs: args.accessTokenExpiresAtMs }),
        lastSuccessfulContactMs: nowMs,
        updatedAtMs: nowMs,
      });
      return { ok: true, state: "connected" };
    }
    if (args.decision === "definitely_lost") {
      // The documented Testing-mode shape: after more than a week the
      // refresh grant is gone; the connection records it and stops.
      await ctx.db.patch(row._id, {
        state: "error",
        reconnectReason: "refresh_failed",
        credentialCiphertext: undefined,
        credentialStorage: "none",
        accessTokenExpiresAtMs: undefined,
        updatedAtMs: nowMs,
      });
      return { ok: true, state: "error" };
    }
    // Unknown: no state change beyond honest contact bookkeeping; the
    // caller reports unknown and reconciliation owns the next move.
    await ctx.db.patch(row._id, { updatedAtMs: nowMs });
    return { ok: true, state: "connected" };
  },
});
