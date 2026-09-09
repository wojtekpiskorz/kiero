/**
 * The generated-ctx adapter (B2): maps the Convex mutation/query context
 * onto the snapshot store surfaces from ./store.ts.
 *
 * `normalizeId` is the proved bridge (A3) from the cores' plain-string ids
 * to branded table ids; typed index chains live only here. The Convex Auth
 * callback's generic ctx has its own adapter (./authHook.ts). Revocation
 * goes through B1's `revokeSessionCore` with its canonical event
 * publication, and the issuance throttle delegates to the shared
 * `commitIssuanceAttempt` core (identity/issuanceLimit.ts).
 */

import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalizeEmail } from "../identity/userPolicy";
import {
  commitIssuanceAttempt,
  type IssuanceThrottleStore,
} from "../identity/issuanceLimit";
import { revokeSessionCore, revocationSurface } from "../identity/operations";
import { attemptActive, attemptStateOpen } from "./policy";
import type { AttemptSnapshot, LinkingStore, LinkingTx } from "./store";

type IdentityDb = QueryCtx["db"];

function attemptSnapshotOf(row: {
  _id: string;
  userId: string;
  email: string;
  initiatingMethod: "google" | "email_code";
  targetMethod: "google" | "email_code";
  state: AttemptSnapshot["state"];
  startedAtMs: number;
  expiresAtMs: number;
  firstProofAtMs?: number;
  pendingCodeHash?: string;
  pendingCodeExpiresAtMs?: number;
}): AttemptSnapshot {
  return {
    id: row._id,
    userId: row.userId,
    email: row.email,
    initiatingMethod: row.initiatingMethod,
    targetMethod: row.targetMethod,
    state: row.state,
    startedAtMs: row.startedAtMs,
    expiresAtMs: row.expiresAtMs,
    firstProofAtMs: row.firstProofAtMs ?? null,
    pendingCodeHash: row.pendingCodeHash ?? null,
    pendingCodeExpiresAtMs: row.pendingCodeExpiresAtMs ?? null,
  };
}

/** Adapts a Convex reader to the linking read surface. */
export function linkingStore(db: IdentityDb): LinkingStore {
  return {
    userById: async (id) => {
      const userId = db.normalizeId("users", id);
      if (userId === null) {
        return null;
      }
      const user = await db.get(userId);
      if (user === null) {
        return null;
      }
      return {
        id: user._id,
        email: user.email,
        googleSubject: user.googleSubject ?? null,
      };
    },
    usersByEmail: async (email) => {
      const rows = await db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
        .collect();
      return rows
        .filter((row) => normalizeEmail(row.email) === normalizeEmail(email))
        .map((row) => ({
          id: row._id,
          email: row.email,
          googleSubject: row.googleSubject ?? null,
        }));
    },
    openAttemptsByEmail: async (email) => {
      const rows = await db
        .query("linkingAttempts")
        .withIndex("by_email_state", (q) => q.eq("email", normalizeEmail(email)))
        .collect();
      return rows
        .map(attemptSnapshotOf)
        // Open = non-terminal only; freshness is decided per proof leg.
        .filter(attemptStateOpen);
    },
    activeAttemptByUser: async (userId, nowMs) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const rows = await db
        .query("linkingAttempts")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .collect();
      const active = rows
        .map(attemptSnapshotOf)
        .filter((attempt) => attemptActive(attempt, nowMs))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      return active[0] ?? null;
    },
    latestAttemptByUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const row = await db
        .query("linkingAttempts")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .order("desc")
        .first();
      return row === null ? null : attemptSnapshotOf(row);
    },
    emailCodeCredentialOwner: async (email) => {
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "email_code").eq("providerAccountId", normalizeEmail(email)),
        )
        .unique();
      return account === null ? null : account.userId;
    },
    hasEmailCodeCredential: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return false;
      }
      const accounts = await db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", uid))
        .collect();
      return accounts.some((account) => account.provider === "email_code");
    },
    googleCredentialOwner: async (sub) => {
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "google").eq("providerAccountId", sub),
        )
        .unique();
      return account === null ? null : account.userId;
    },
    usersWithGoogleSubject: async (sub) => {
      const rows = await db
        .query("users")
        .filter((q) => q.eq(q.field("googleSubject"), sub))
        .take(2);
      return rows.map((row) => row._id);
    },
    registrySessionsByUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return [];
      }
      const rows = await db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", uid))
        .collect();
      return rows.map((row) => ({ id: row._id, revokedAtMs: row.revokedAtMs ?? null }));
    },
    pendingEmailChange: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return null;
      }
      const rows = await db
        .query("emailChangeRequests")
        .withIndex("by_user_requested", (q) => q.eq("userId", uid))
        .collect();
      const pending = rows
        .filter((row) => row.confirmedAtMs === undefined)
        .sort((a, b) => b.requestedAtMs - a.requestedAtMs);
      const row = pending[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row._id,
        newEmail: row.newEmail,
        previousEmail: row.previousEmail,
        codeHash: row.codeHash,
        requestedAtMs: row.requestedAtMs,
        expiresAtMs: row.expiresAtMs,
        confirmed: false,
      };
    },
  };
}

/** The shared throttle core over this generated ctx's rate-limit rows. */
function throttleStore(db: MutationCtx["db"]): IssuanceThrottleStore {
  return {
    throttleRow: async (identifier) => {
      const row = await db
        .query("authRateLimits")
        .filter((q) => q.eq(q.field("identifier"), identifier))
        .first();
      return row === null
        ? null
        : {
            id: row._id,
            lastAttemptTime: row.lastAttemptTime,
            attemptsLeft: row.attemptsLeft,
          };
    },
    insertThrottleRow: async (identifier, row) => {
      await db.insert("authRateLimits", {
        identifier,
        lastAttemptTime: row.lastAttemptTime,
        attemptsLeft: row.attemptsLeft,
      });
    },
    patchThrottleRow: async (id, row) => {
      const rowId = db.normalizeId("authRateLimits", id);
      if (rowId === null) {
        throw new Error("linking: invalid rate limit id");
      }
      await db.patch(rowId, {
        lastAttemptTime: row.lastAttemptTime,
        attemptsLeft: row.attemptsLeft,
      });
    },
  };
}

/**
 * Adapts one Convex mutation context to the linking write surface. The
 * full ctx (not just db) is required: revocation goes through B1's
 * `revokeSessionCore` with its canonical event publication.
 */
export function linkingTx(ctx: MutationCtx): LinkingTx {
  const db = ctx.db;
  const store = linkingStore(db);
  const surface = revocationSurface(ctx);
  const throttle = throttleStore(db);
  return {
    ...store,
    insertAttempt: async (row) => {
      const userId = db.normalizeId("users", row.userId);
      if (userId === null) {
        throw new Error("linking: invalid user id");
      }
      return await db.insert("linkingAttempts", {
        userId,
        email: row.email,
        initiatingMethod: row.initiatingMethod,
        targetMethod: row.targetMethod,
        state: "awaiting_first_proof",
        startedAtMs: row.startedAtMs,
        expiresAtMs: row.expiresAtMs,
      });
    },
    patchAttempt: async (id, patch) => {
      const attemptId = db.normalizeId("linkingAttempts", id);
      if (attemptId === null) {
        throw new Error("linking: invalid attempt id");
      }
      await db.patch(attemptId, patch);
    },
    patchUser: async (id, patch) => {
      const userId = db.normalizeId("users", id);
      if (userId === null) {
        throw new Error("linking: invalid user id");
      }
      // googleSubject null clears the marker (Convex patch: undefined
      // removes the field); the interface stays exact-optional-clean.
      const { googleSubject, ...rest } = patch;
      await db.patch(userId, {
        ...rest,
        ...(googleSubject === undefined ? {} : { googleSubject: googleSubject ?? undefined }),
      });
    },
    insertEmailCodeAccount: async ({ userId, email, nowMs }) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      await db.insert("authAccounts", {
        userId: uid,
        provider: "email_code",
        providerAccountId: normalizeEmail(email),
        emailVerified: normalizeEmail(email),
      });
      await db.patch(uid, { emailVerificationTime: nowMs });
    },
    repointEmailCodeCredential: async ({ userId, previousEmail, newEmail }) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return false;
      }
      const account = await db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "email_code").eq("providerAccountId", normalizeEmail(previousEmail)),
        )
        .unique();
      if (account === null || account.userId !== uid) {
        return false;
      }
      await db.patch(account._id, {
        providerAccountId: normalizeEmail(newEmail),
        emailVerified: normalizeEmail(newEmail),
      });
      return true;
    },
    insertEmailChange: async (row) => {
      const uid = db.normalizeId("users", row.userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      return await db.insert("emailChangeRequests", {
        userId: uid,
        newEmail: row.newEmail,
        previousEmail: row.previousEmail,
        codeHash: row.codeHash,
        requestedAtMs: row.requestedAtMs,
        expiresAtMs: row.expiresAtMs,
      });
    },
    patchEmailChange: async (id, patch) => {
      const requestId = db.normalizeId("emailChangeRequests", id);
      if (requestId === null) {
        throw new Error("linking: invalid request id");
      }
      await db.patch(requestId, patch);
    },
    applyIssuanceThrottle: (identifier, nowMs) =>
      commitIssuanceAttempt(throttle, identifier, nowMs),
    insertRecovery: async (row) => {
      const uid = db.normalizeId("users", row.userId);
      if (uid === null) {
        throw new Error("linking: invalid user id");
      }
      const revokedSessionIds = row.revokedSessionIds.map((id) => {
        const sessionId = db.normalizeId("sessions", id);
        if (sessionId === null) {
          throw new Error("recovery: invalid session id");
        }
        return sessionId;
      });
      const clearedAccountIds = row.clearedAccountIds.map((id) => {
        const accountId = db.normalizeId("authAccounts", id);
        if (accountId === null) {
          throw new Error("recovery: invalid account id");
        }
        return accountId;
      });
      await db.insert("accountRecoveries", {
        userId: uid,
        verificationBasis: row.verificationBasis,
        performedBy: row.performedBy,
        performedAtMs: row.performedAtMs,
        revokedSessionIds,
        clearedAccountIds,
        clearedGoogleSubject: row.clearedGoogleSubject,
      });
    },
    revokeRegistrySession: async (args) => {
      const targetSessionId = db.normalizeId("sessions", args.targetSessionId);
      const actorUserId = db.normalizeId("users", args.actorUserId);
      if (targetSessionId === null || actorUserId === null) {
        return { revoked: false };
      }
      const companyId =
        args.companyIdForEvent === null
          ? null
          : db.normalizeId("companies", args.companyIdForEvent);
      const outcome = await revokeSessionCore(surface, {
        actorUserId,
        targetSessionId,
        nowMs: args.nowMs,
        companyIdForEvent: companyId,
      });
      return outcome.result._tag === "ok" ? { revoked: true } : { revoked: false };
    },
    deleteAuthSessionsOfUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return 0;
      }
      const sessions = await db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", uid))
        .collect();
      for (const session of sessions) {
        // Same cleanup order as the library's deleteSession: refresh
        // tokens first, then the session row itself.
        const tokens = await db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .collect();
        for (const token of tokens) {
          await db.delete(token._id);
        }
        await db.delete(session._id);
      }
      return sessions.length;
    },
    deleteAuthAccountsOfUser: async (userId) => {
      const uid = db.normalizeId("users", userId);
      if (uid === null) {
        return [];
      }
      const accounts = await db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", uid))
        .collect();
      const deleted: string[] = [];
      for (const account of accounts) {
        await db.delete(account._id);
        deleted.push(account._id);
      }
      return deleted;
    },
  };
}
