/**
 * Live-session resolution: the B1 identity source for the A3 seam.
 *
 * This is the swap-in point the platform evidence names ("B1 swaps the
 * identity source into the same canonical resolution seam"): Convex Auth
 * issues a JWT whose `sub` is `<userId>|<authSessions id>`. The platform's
 * generic `identityFromConvexAuth` (convex/platform/context.ts) cannot map
 * that subject onto the app-owned `sessions` registry, so THIS module is
 * the authoritative user-identity source:
 *
 *   verified JWT -> strict subject parse -> live authSessions row
 *     -> app session registry row -> VerifiedIdentity(subject = registry
 *     row id) -> A3's resolveRequestContext (user -> earliest active
 *     membership -> company -> GM -> ActorContext).
 *
 * Every protected read rejects a session whose authSessions row is gone
 * (signed out upstream — the JWT may still be cryptographically valid),
 * whose registry row is revoked, or whose trusted activity time is older
 * than the accepted 30-day inactivity rule. The upstream token's validity
 * alone never grants access.
 *
 * The subject parse and the session-state decision are pure and pinned by
 * unit tests (tests/b1); the db halves are thin adapters.
 */

import { Schema } from "effect";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { VerifiedIdentity, RequestContext } from "@kiero/runtime";
import { resolveRequestContext } from "../../platform/context";

/**
 * The accepted inactivity rule: a session expires after 30 days without
 * authenticated activity (issue #4 grilling; Convex Auth refresh tokens
 * enforce the same window for token refresh — this is the read-side rule).
 */
export const SESSION_INACTIVITY_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** The auth surface any Convex ctx satisfies (structural, like A3's). */
export type AuthReader = {
  getUserIdentity(): Promise<{ readonly subject: string } | null>;
};

/** The read surface resolution needs. */
export type IdentityDb = QueryCtx["db"];
/** The write surface provisioning needs. */
export type IdentityTx = MutationCtx["db"];

/**
 * The minimal store surface the live-session cores consume. The real
 * Convex db adapts to it (below); in-memory fakes implement it in tests
 * (tests/b1) so the db-halves are unit-testable without a deployment.
 * Direct per-entity methods (not the full query-chain types) keep both
 * the adapter and the fakes one line each.
 */
export interface LiveSessionStore {
  normalizeAuthSessionId(id: string): Id<"authSessions"> | null;
  normalizeUserId(id: string): Id<"users"> | null;
  authSessionById(id: Id<"authSessions">): Promise<Doc<"authSessions"> | null>;
  userById(id: Id<"users">): Promise<Doc<"users"> | null>;
  registryByAuthSession(authSessionId: Id<"authSessions">): Promise<Doc<"sessions"> | null>;
}

/** The write extension provisioning needs (fake-able the same way). */
export interface LiveSessionTx extends LiveSessionStore {
  insertRegistry(row: {
    userId: Id<"users">;
    startedAtMs: number;
    lastSeenAtMs: number;
    deviceLabel: string;
    authSessionId: Id<"authSessions">;
  }): Promise<Id<"sessions">>;
  registryRowById(id: Id<"sessions">): Promise<Doc<"sessions"> | null>;
  patchRegistry(id: Id<"sessions">, patch: { lastSeenAtMs?: number }): Promise<void>;
}

/** Adapts a Convex reader to the store surface. */
export function liveSessionStore(db: IdentityDb): LiveSessionStore {
  return {
    normalizeAuthSessionId: (id) => db.normalizeId("authSessions", id),
    normalizeUserId: (id) => db.normalizeId("users", id),
    authSessionById: (id) => db.get(id),
    userById: (id) => db.get(id),
    registryByAuthSession: (authSessionId) =>
      db
        .query("sessions")
        .withIndex("by_authSession", (q) => q.eq("authSessionId", authSessionId))
        .unique(),
  };
}

/** Adapts a Convex writer to the provisioning surface. */
export function liveSessionTx(tx: IdentityTx): LiveSessionTx {
  return {
    ...liveSessionStore(tx),
    insertRegistry: (row) => tx.insert("sessions", row),
    registryRowById: (id) => tx.get(id),
    patchRegistry: (id, patch) => tx.patch(id, patch),
  };
}

/** Why a request did not resolve to a live session (machine-readable). */
export type LiveSessionDenial =
  | "no_identity"
  | "malformed_subject"
  | "subject_mismatch"
  | "auth_session_missing"
  | "auth_session_expired"
  | "registry_missing"
  | "revoked"
  | "inactive";

/** The trusted snapshot of one live device session. */
export interface LiveSessionSnapshot {
  /** The app `sessions` registry row id (the VerifiedIdentity subject). */
  readonly sessionId: Id<"sessions">;
  readonly userId: Id<"users">;
  readonly startedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly deviceLabel: string;
}

export type LiveSessionResult =
  | { readonly tag: "live"; readonly session: LiveSessionSnapshot }
  | { readonly tag: "denied"; readonly reason: LiveSessionDenial };

/** Convex Auth JWT subjects: `<userId>|<authSessions id>`, nothing else. */
const ConvexAuthSubject = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^|]+\|[^|]+$/)),
);

export interface AuthSubjectParts {
  readonly authUserId: string;
  readonly authSessionId: string;
}

/**
 * Strictly parses a Convex Auth subject; null for any malformed value.
 * The schema check guarantees exactly one `|` with non-empty parts, so the
 * slices cannot produce empty or undefined components.
 */
export function parseConvexAuthSubject(subject: string): AuthSubjectParts | null {
  const decoded = Schema.decodeUnknownOption(ConvexAuthSubject)(subject);
  if (decoded._tag === "None") {
    return null;
  }
  const divider = decoded.value.indexOf("|");
  return {
    authUserId: decoded.value.slice(0, divider),
    authSessionId: decoded.value.slice(divider + 1),
  };
}

/** The registry-row fields the pure decision consumes. */
export interface SessionRegistryView {
  readonly revokedAtMs: number | null;
  readonly lastSeenAtMs: number;
}

/** The upstream authSessions-row projection the decision consumes. */
export interface AuthSessionView {
  readonly userId: string;
  readonly expirationTime: number;
}

/**
 * The pure live-session decision over one registry row.
 *
 * Boundary: a session is inactive only AFTER a full 30 days elapsed
 * (`now - lastSeen > limit`), so "just inside 30 days" stays live and
 * "beyond 30 days" expires, deterministically.
 */
export function liveSessionDecision(
  session: SessionRegistryView,
  nowMs: number,
): { readonly tag: "live" } | { readonly tag: "denied"; readonly reason: "revoked" | "inactive" } {
  if (session.revokedAtMs !== null) {
    return { tag: "denied", reason: "revoked" };
  }
  if (nowMs - session.lastSeenAtMs > SESSION_INACTIVITY_LIMIT_MS) {
    return { tag: "denied", reason: "inactive" };
  }
  return { tag: "live" };
}

/** The pure upstream check over the mirrored authSessions row. */
export function authSessionDecision(
  authSession: AuthSessionView | null,
  expectedUserId: string,
  nowMs: number,
): { readonly tag: "live" } | { readonly tag: "denied"; readonly reason: LiveSessionDenial } {
  if (authSession === null) {
    // Signed out (or session deleted) upstream; the JWT may still verify.
    return { tag: "denied", reason: "auth_session_missing" };
  }
  if (authSession.userId !== expectedUserId) {
    // The subject's user half disagrees with the session row: distinct
    // from a malformed subject string, but equally fail-closed.
    return { tag: "denied", reason: "subject_mismatch" };
  }
  if (authSession.expirationTime <= nowMs) {
    return { tag: "denied", reason: "auth_session_expired" };
  }
  return { tag: "live" };
}

function snapshotOf(row: Doc<"sessions">): LiveSessionSnapshot {
  return {
    sessionId: row._id,
    userId: row.userId,
    startedAtMs: row.startedAtMs,
    lastSeenAtMs: row.lastSeenAtMs,
    deviceLabel: row.deviceLabel,
  };
}

/**
 * The shared resolution prologue: verified identity -> strict subject
 * parse -> well-formed authSessions id -> upstream liveness decision.
 * Both the read path and the write path start here; only what they do
 * with the registry row differs.
 */
async function resolveVerifiedUpstreamSession(
  db: LiveSessionStore,
  auth: AuthReader,
  nowMs: number,
): Promise<
  | { readonly authUserId: string; readonly authSessionId: Id<"authSessions"> }
  | { readonly tag: "denied"; readonly reason: LiveSessionDenial }
> {
  const identity = await auth.getUserIdentity();
  if (identity === null) {
    return { tag: "denied", reason: "no_identity" };
  }
  const parts = parseConvexAuthSubject(identity.subject);
  if (parts === null) {
    return { tag: "denied", reason: "malformed_subject" };
  }
  const authSessionId = db.normalizeAuthSessionId(parts.authSessionId);
  if (authSessionId === null) {
    return { tag: "denied", reason: "malformed_subject" };
  }
  const authSession = await db.authSessionById(authSessionId);
  const upstream = authSessionDecision(
    authSession === null
      ? null
      : { userId: authSession.userId, expirationTime: authSession.expirationTime },
    parts.authUserId,
    nowMs,
  );
  if (upstream.tag === "denied") {
    return upstream;
  }
  return { authUserId: parts.authUserId, authSessionId };
}

/**
 * Resolves the current live session WITHOUT writes: the read path for
 * protected queries and subscriptions. A missing registry row denies
 * (`registry_missing`) — provisioning happens only in mutation contexts.
 */
export async function resolveLiveSession(
  db: LiveSessionStore,
  auth: AuthReader,
  nowMs: number,
): Promise<LiveSessionResult> {
  const prologue = await resolveVerifiedUpstreamSession(db, auth, nowMs);
  if ("tag" in prologue) {
    return prologue;
  }
  const row = await db.registryByAuthSession(prologue.authSessionId);
  if (row === null) {
    return { tag: "denied", reason: "registry_missing" };
  }
  const decision = liveSessionDecision(
    { revokedAtMs: row.revokedAtMs ?? null, lastSeenAtMs: row.lastSeenAtMs },
    nowMs,
  );
  if (decision.tag === "denied") {
    return decision;
  }
  return { tag: "live", session: snapshotOf(row) };
}

/**
 * Resolves the current live session, PROVISIONING the registry row when a
 * verified Convex Auth session has none yet, and bumping trusted activity
 * time. This is the write path: sign-in bootstrap and the checked command
 * dispatch (every command refreshes the session's activity).
 */
export async function provisionOrRefreshLiveSession(
  tx: LiveSessionTx,
  auth: AuthReader,
  nowMs: number,
  deviceLabel: string,
): Promise<LiveSessionResult> {
  const prologue = await resolveVerifiedUpstreamSession(tx, auth, nowMs);
  if ("tag" in prologue) {
    return prologue;
  }
  const existing = await tx.registryByAuthSession(prologue.authSessionId);
  if (existing === null) {
    const user = tx.normalizeUserId(prologue.authUserId);
    if (user === null || (await tx.userById(user)) === null) {
      // The verified token names no existing person row: fail closed
      // instead of provisioning a registry row for a ghost.
      return { tag: "denied", reason: "subject_mismatch" };
    }
    const inserted = await tx.insertRegistry({
      userId: user,
      startedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      deviceLabel,
      authSessionId: prologue.authSessionId,
    });
    const row = await tx.registryRowById(inserted);
    if (row === null) {
      return { tag: "denied", reason: "registry_missing" };
    }
    return { tag: "live", session: snapshotOf(row) };
  }
  const decision = liveSessionDecision(
    { revokedAtMs: existing.revokedAtMs ?? null, lastSeenAtMs: existing.lastSeenAtMs },
    nowMs,
  );
  if (decision.tag === "denied") {
    return decision;
  }
  await tx.patchRegistry(existing._id, { lastSeenAtMs: nowMs });
  return { tag: "live", session: { ...snapshotOf(existing), lastSeenAtMs: nowMs } };
}

/** Constructs the seam identity: subject IS the registry row id. */
export function liveSessionIdentity(session: LiveSessionSnapshot, nowMs: number): VerifiedIdentity {
  return { issuer: "convex-auth", subject: session.sessionId, verifiedAtMs: nowMs };
}

/**
 * The full canonical chain from a verified Convex Auth token to an actor
 * context (read-only; no provisioning, no activity bump). Returns null for
 * any broken chain — a session without an active membership resolves to
 * null, which the checked path fails `unauthenticated`.
 */
export async function resolveAccessContextFromConvexAuth(
  db: IdentityDb,
  auth: AuthReader,
  nowMs: number,
): Promise<RequestContext | null> {
  const live = await resolveLiveSession(liveSessionStore(db), auth, nowMs);
  if (live.tag === "denied") {
    return null;
  }
  return await resolveRequestContext(db, liveSessionIdentity(live.session, nowMs));
}

/**
 * The dispatch resolution (write path): provision-or-refresh first, then
 * the same canonical A3 chain. This is the resolveContext B1 hands to
 * `dispatchCommand` and the surface B2/B3/GM reuse for their boundaries.
 */
export async function resolveAccessContextWithProvisioning(
  tx: IdentityTx,
  auth: AuthReader,
  nowMs: number,
  deviceLabel: string,
): Promise<RequestContext | null> {
  const live = await provisionOrRefreshLiveSession(liveSessionTx(tx), auth, nowMs, deviceLabel);
  if (live.tag === "denied") {
    return null;
  }
  return await resolveRequestContext(tx, liveSessionIdentity(live.session, nowMs));
}

/** Default barebones device label (client labels are optional, bounded). */
export const DEFAULT_DEVICE_LABEL = "Przeglądarka";
