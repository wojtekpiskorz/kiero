/**
 * The Convex Auth callback hooks (B2 amendment of the B1 auth entry).
 *
 * The library calls `createOrUpdateUser` from its own generic mutation
 * context (untyped data model), which is why this adapter exists
 * separately from the generated-ctx adapter (./storeAdapter.ts): it maps
 * the generic rows onto the SAME `GoogleHookStore` surface through
 * explicit field validation (no casts), then runs the identical ceremony
 * cores (./ceremony.ts). Two hooks:
 *
 * - `recordGoogleProofHook`: a Google sign-in RESUMED an existing account
 *   — if that account's ceremony awaits its fresh Google first proof, the
 *   proof is recorded. No ceremony: one bounded lookup, no writes.
 * - `googleLinkFromCallbackHook`: B1's sign-in user policy decided
 *   `method_conflict` (a Google sign-in whose address collides with an
 *   email-code account). The hook replaces the rejection with the explicit
 *   link commit exactly when an active ceremony proves BOTH methods
 *   (fresh email-code proof inside the window + the OAuth proof happening
 *   now); otherwise the typed reason keeps the rejection honest.
 */

import type { AnyDataModel, GenericMutationCtx } from "convex/server";
import { normalizeEmail } from "../identity/userPolicy";
import {
  attemptActive,
  attemptStateOpen,
  decodeGoogleLinkProfile,
  type LinkRejectionCode,
} from "./policy";
import { googleLinkFromCallbackCore, recordGoogleProofCore } from "./ceremony";
import type { AttemptPatch, AttemptSnapshot, GoogleHookStore } from "./store";

/** The generic db of the library's callback context. */
type HookDb = GenericMutationCtx<AnyDataModel>["db"];

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`linking hook: field ${field} is not a non-empty string`);
  }
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`linking hook: field ${field} is not a number`);
  }
  return value;
}

/**
 * Maps one generic ceremony row onto the snapshot. Validated field by
 * field, no casts; every failure THROWS, so the result is never null.
 */
function attemptOf(row: Record<string, unknown>): AttemptSnapshot {
  const state = row.state;
  if (
    state !== "awaiting_first_proof" &&
    state !== "awaiting_target_proof" &&
    state !== "committed" &&
    state !== "rejected"
  ) {
    throw new Error("linking hook: unknown ceremony state");
  }
  const initiatingMethod = row.initiatingMethod;
  const targetMethod = row.targetMethod;
  if (initiatingMethod !== "google" && initiatingMethod !== "email_code") {
    throw new Error("linking hook: unknown initiating method");
  }
  if (targetMethod !== "google" && targetMethod !== "email_code") {
    throw new Error("linking hook: unknown target method");
  }
  return {
    id: str(row._id, "_id"),
    userId: str(row.userId, "userId"),
    email: str(row.email, "email"),
    initiatingMethod,
    targetMethod,
    state,
    startedAtMs: num(row.startedAtMs, "startedAtMs"),
    expiresAtMs: num(row.expiresAtMs, "expiresAtMs"),
    firstProofAtMs: typeof row.firstProofAtMs === "number" ? row.firstProofAtMs : null,
    pendingCodeHash: typeof row.pendingCodeHash === "string" ? row.pendingCodeHash : null,
    pendingCodeExpiresAtMs:
      typeof row.pendingCodeExpiresAtMs === "number" ? row.pendingCodeExpiresAtMs : null,
  };
}

/** Builds the hook store over the generic db (the cores' GoogleHookStore). */
export function hookStore(db: HookDb): GoogleHookStore {
  return {
    userById: async (id) => {
      const uid = db.normalizeId("users", id);
      if (uid === null) {
        return null;
      }
      const user = await db.get(uid);
      if (user === null) {
        return null;
      }
      return {
        id: user._id,
        email: str(user.email, "email"),
        googleSubject: typeof user.googleSubject === "string" ? user.googleSubject : null,
      };
    },
    openAttemptsByEmail: async (email) => {
      const rows = await db
        .query("linkingAttempts")
        .filter((q) => q.eq(q.field("email"), normalizeEmail(email)))
        .collect();
      // The canonical open-state predicate (policy.ts); freshness is
      // decided per proof leg by the ceremony cores.
      return rows.map(attemptOf).filter(attemptStateOpen);
    },
    activeAttemptByUser: async (userId, nowMs) => {
      const rows = await db
        .query("linkingAttempts")
        .filter((q) => q.eq(q.field("userId"), userId))
        .collect();
      const active = rows
        .map(attemptOf)
        .filter((attempt) => attemptActive(attempt, nowMs))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      return active[0] ?? null;
    },
    googleCredentialOwner: async (sub) => {
      const account = await db
        .query("authAccounts")
        .filter((q) => q.eq(q.field("providerAccountId"), sub))
        .first();
      if (account === null || account.provider !== "google") {
        return null;
      }
      return str(account.userId, "userId");
    },
    usersWithGoogleSubject: async (sub) => {
      const rows = await db
        .query("users")
        .filter((q) => q.eq(q.field("googleSubject"), sub))
        .take(2);
      return rows.map((row) => str(row._id, "_id"));
    },
    patchAttempt: async (id, patch) => {
      const attemptId = db.normalizeId("linkingAttempts", id);
      if (attemptId === null) {
        throw new Error("linking hook: invalid attempt id");
      }
      // An explicit undefined clears the field (Convex patch semantics).
      await db.patch(attemptId, patch);
    },
    patchUser: async (id, patch) => {
      const userId = db.normalizeId("users", id);
      if (userId === null) {
        throw new Error("linking hook: invalid user id");
      }
      const { googleSubject } = patch;
      await db.patch(userId, {
        ...(googleSubject === undefined ? {} : { googleSubject: googleSubject ?? undefined }),
      });
    },
  };
}

/** The patch shape the hook store accepts (re-exported for tests). */
export type { AttemptPatch };

/**
 * Records the fresh Google proof after a RESUMED Google sign-in. Called by
 * the B1 auth entry's createOrUpdateUser on every oauth resume; a no-op
 * when the account has no awaiting email-direction ceremony.
 */
export async function recordGoogleProofHook(
  ctx: GenericMutationCtx<AnyDataModel>,
  args: { userId: string; rawProfile: Record<string, unknown>; nowMs: number },
): Promise<void> {
  const profile = decodeGoogleLinkProfile(args.rawProfile);
  if (profile === null) {
    return;
  }
  await recordGoogleProofCore(hookStore(ctx.db), {
    userId: args.userId,
    profile,
    nowMs: args.nowMs,
  });
}

/**
 * Resolves the explicit link commit for a `method_conflict` Google
 * sign-in. Called by the B1 auth entry INSTEAD of throwing the conflict
 * error; when no ceremony proves both methods the typed reason keeps the
 * original rejection (the caller then fails exactly like B1 did).
 */
export async function googleLinkFromCallbackHook(
  ctx: GenericMutationCtx<AnyDataModel>,
  args: {
    rawProfile: Record<string, unknown>;
    usersWithEmail: readonly { id: string; email: string; googleSubject: string | null }[];
    nowMs: number;
  },
): Promise<{ committed: true; userId: string } | { committed: false; reason: LinkRejectionCode }> {
  return await googleLinkFromCallbackCore(hookStore(ctx.db), args);
}
