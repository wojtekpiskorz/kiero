/**
 * Access identity operations (B1): the revocation core and the typed
 * command dispatch registered through the A3 runtime seam.
 *
 * `dispatchAccessCommand` is the same checked path as the platform's
 * probe dispatch (`dispatchCommand` from @kiero/runtime): envelope decode
 * -> operation registry -> B1 identity resolution (provision-or-refresh
 * the live session, then A3's canonical chain) -> the B1 policy
 * (`liveSessionPolicy` over `membershipPolicy`) -> contract input decode
 * -> handler. This is the producer registration B2/B3/GM consume for
 * their boundaries; auth package tables are never exposed.
 *
 * `revokeSessionCore` is the single revocation implementation shared by
 * the typed dispatch entry and the identity-layer mutation (the
 * barebones UI path, which must work before any membership exists).
 * Revocation is authoritative on the app registry: a still-valid upstream
 * JWT stops resolving the moment the registry row is revoked.
 *
 * `buildAccessSnapshot` is the ONE access-snapshot builder: both the
 * typed dispatch handler and the identity-layer query assemble the
 * snapshot here, validated once against the contract `AccessSnapshot`
 * schema (no local mirrors that could drift).
 */

import { Schema } from "effect";
import {
  AccessSnapshot,
  accessOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  dispatchCommand,
  forbiddenError,
  notFoundError,
  type HandlerRegistry,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
  type IdentityDb,
} from "./resolution";
import { liveSessionPolicy } from "./policy";
import { linkingHandlers } from "../linking/operations";

const resolveCurrentAccessEntry = accessOperations["access.resolveCurrentAccess"];
const revokeSessionEntry = accessOperations["access.revokeSession"];

const revokedResult = Schema.Struct({ revokedAtMs: Schema.Number });

export interface RevocationOutcome {
  readonly result: ResultEnvelope;
}

/**
 * The minimal surface revocation consumes. The real mutation ctx adapts
 * to it (below); in-memory fakes implement it in tests (tests/b1) so the
 * revocation core is unit-testable without a deployment.
 */
export interface RevocationSurface {
  getSession(id: Id<"sessions">): Promise<Doc<"sessions"> | null>;
  revokeSession(id: Id<"sessions">, revokedAtMs: number): Promise<void>;
  publishSessionRevoked(args: {
    companyId: Id<"companies">;
    sessionId: Id<"sessions">;
  }): Promise<void>;
}

/** Adapts one Convex mutation transaction to the revocation surface. */
export function revocationSurface(tx: MutationCtx): RevocationSurface {
  return {
    getSession: (id) => tx.db.get(id),
    revokeSession: async (id, revokedAtMs) => {
      await tx.db.patch(id, { revokedAtMs });
    },
    publishSessionRevoked: async ({ companyId, sessionId }) => {
      await publishEvent(tx, {
        companyId,
        eventName: "access.sessionRevoked",
        payload: { sessionId },
        dedupKey: `access.sessionRevoked:${sessionId}`,
      });
    },
  };
}

/**
 * Revokes one registry row, self-service: the acting user may revoke only
 * their own sessions. Idempotent: revoking an already-revoked session
 * returns its original revocation time. When `companyIdForEvent` is
 * provided (an active membership exists), the canonical
 * `access.sessionRevoked` event publishes atomically with the patch.
 */
export async function revokeSessionCore(
  surface: RevocationSurface,
  args: {
    readonly actorUserId: Id<"users">;
    readonly targetSessionId: Id<"sessions">;
    readonly nowMs: number;
    readonly companyIdForEvent: Id<"companies"> | null;
  },
): Promise<RevocationOutcome> {
  const session = await surface.getSession(args.targetSessionId);
  if (session === null) {
    return { result: errorResult(notFoundError("sessions")) };
  }
  if (session.userId !== args.actorUserId) {
    // Device management is self-service; revoking other users' sessions
    // belongs to B3's administrator surface.
    return { result: errorResult(forbiddenError("not_own_session", "session")) };
  }
  if (session.revokedAtMs !== undefined) {
    return {
      result: okResult(
        Schema.decodeUnknownSync(revokedResult)({ revokedAtMs: session.revokedAtMs }),
      ),
    };
  }
  await surface.revokeSession(args.targetSessionId, args.nowMs);
  if (args.companyIdForEvent !== null) {
    await surface.publishSessionRevoked({
      companyId: args.companyIdForEvent,
      sessionId: args.targetSessionId,
    });
  }
  return {
    result: okResult(
      Schema.decodeUnknownSync(revokedResult)({ revokedAtMs: args.nowMs }),
    ),
  };
}

/** The resolved-actor fields the access snapshot is built from. */
export interface SnapshotActor {
  readonly userId: Id<"users">;
  readonly companyId: Id<"companies">;
  readonly membershipRole: "admin" | "member";
  readonly isGm: boolean;
}

/**
 * THE access-snapshot builder: reads the company row and validates the
 * result once against the contract `AccessSnapshot` schema. Returns null
 * when the company row is gone (the caller decides the honest failure).
 */
export async function buildAccessSnapshot(
  db: IdentityDb,
  actor: SnapshotActor,
): Promise<AccessSnapshot | null> {
  const company = await db.get(actor.companyId);
  if (company === null) {
    return null;
  }
  return Schema.decodeUnknownSync(AccessSnapshot)({
    userId: actor.userId,
    companyId: actor.companyId,
    membershipRole: actor.membershipRole,
    isGm: actor.isGm,
    companyTimezone: company.timezone,
    defaultCurrency: company.defaultCurrency,
  });
}

/** The B1 handler table for the typed access operations. */
function accessHandlers(): HandlerRegistry<MutationCtx> {
  return {
    ...linkingHandlers(),
    "access.resolveCurrentAccess": {
      intent: "read",
      run: async (tx, context, input) => {
        const { sessionId } = Schema.decodeUnknownSync(resolveCurrentAccessEntry.input)(input);
        if (sessionId !== context.actor.sessionId) {
          // The client's session belief is stale; only the resolved
          // current session may be read. (Declared errorKinds widen by
          // this one forbidden case; recorded for B2/B3 contract pass.)
          return errorResult(forbiddenError("session_scope_mismatch", "session"));
        }
        const userId = tx.db.normalizeId("users", context.actor.userId);
        const companyId = tx.db.normalizeId("companies", context.actor.companyId);
        if (userId === null || companyId === null) {
          return errorResult(notFoundError("users", "unresolvable_actor_reference"));
        }
        const snapshot = await buildAccessSnapshot(tx.db, {
          userId,
          companyId,
          membershipRole: context.actor.membershipRole,
          isGm: context.actor.isGm,
        });
        if (snapshot === null) {
          return errorResult(notFoundError("companies"));
        }
        return okResult(snapshot);
      },
    },
    "access.revokeSession": {
      intent: "write",
      run: async (tx, context, input) => {
        const { sessionId } = Schema.decodeUnknownSync(revokeSessionEntry.input)(input);
        const targetSessionId = tx.db.normalizeId("sessions", sessionId);
        if (targetSessionId === null) {
          return errorResult(notFoundError("sessions"));
        }
        const actorUserId = tx.db.normalizeId("users", context.actor.userId);
        if (actorUserId === null) {
          return errorResult(notFoundError("users", "unresolvable_actor_reference"));
        }
        const outcome = await revokeSessionCore(revocationSurface(tx), {
          actorUserId,
          targetSessionId,
          nowMs: Date.now(),
          companyIdForEvent: tx.db.normalizeId("companies", context.actor.companyId),
        });
        return outcome.result;
      },
    },
  };
}

/**
 * The B1 dispatch entry: the checked command path with the live-session
 * identity source and B1 policy. Operations not listed here (invitations,
 * GM mode — B3/B4) stay fail-closed `unsupported`. The B2 amendment
 * composes the linking handlers (`access.linkVerifiedMethod`) into the
 * same registry: one dispatch, one checked path, no drift.
 */
export async function dispatchAccessCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: liveSessionPolicy,
      handlers: accessHandlers(),
    },
    ctx,
    envelope,
  );
}
