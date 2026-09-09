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
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "./resolution";
import { liveSessionPolicy } from "./policy";

const resolveCurrentAccessEntry = accessOperations["access.resolveCurrentAccess"];
const revokeSessionEntry = accessOperations["access.revokeSession"];

const accessSnapshotResult = Schema.Struct({
  userId: Schema.String,
  companyId: Schema.String,
  membershipRole: Schema.Literals(["admin", "member"]),
  isGm: Schema.Boolean,
  companyTimezone: Schema.String,
  defaultCurrency: Schema.String,
});

const revokedResult = Schema.Struct({ revokedAtMs: Schema.Number });

export interface RevocationOutcome {
  readonly result: ResultEnvelope;
}

/**
 * Revokes one registry row, self-service: the acting user may revoke only
 * their own sessions. Idempotent: revoking an already-revoked session
 * returns its original revocation time. When `companyIdForEvent` is
 * provided (an active membership exists), the canonical
 * `access.sessionRevoked` event publishes atomically with the patch.
 */
export async function revokeSessionCore(
  tx: MutationCtx,
  args: {
    readonly actorUserId: Id<"users">;
    readonly targetSessionId: Id<"sessions">;
    readonly nowMs: number;
    readonly companyIdForEvent: Id<"companies"> | null;
  },
): Promise<RevocationOutcome> {
  const session = await tx.db.get(args.targetSessionId);
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
  await tx.db.patch(args.targetSessionId, { revokedAtMs: args.nowMs });
  if (args.companyIdForEvent !== null) {
    await publishEvent(tx, {
      companyId: args.companyIdForEvent,
      eventName: "access.sessionRevoked",
      payload: { sessionId: args.targetSessionId },
      dedupKey: `access.sessionRevoked:${args.targetSessionId}`,
    });
  }
  return {
    result: okResult(
      Schema.decodeUnknownSync(revokedResult)({ revokedAtMs: args.nowMs }),
    ),
  };
}

/** Builds the current access snapshot for a resolved actor context. */
export async function currentAccessSnapshot(
  db: MutationCtx["db"],
  actor: {
    readonly userId: Id<"users">;
    readonly companyId: Id<"companies">;
    readonly membershipRole: "admin" | "member";
    readonly isGm: boolean;
  },
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
        const snapshot = await currentAccessSnapshot(tx.db, {
          userId,
          companyId,
          membershipRole: context.actor.membershipRole,
          isGm: context.actor.isGm,
        });
        if (snapshot === null) {
          return errorResult(notFoundError("companies"));
        }
        return okResult(
          Schema.decodeUnknownSync(accessSnapshotResult)({
            userId: snapshot.userId,
            companyId: snapshot.companyId,
            membershipRole: snapshot.membershipRole,
            isGm: snapshot.isGm,
            companyTimezone: snapshot.companyTimezone,
            defaultCurrency: snapshot.defaultCurrency,
          }),
        );
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
        const outcome = await revokeSessionCore(tx, {
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
 * linking, GM mode — B2/B3/B4) stay fail-closed `unsupported`.
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
