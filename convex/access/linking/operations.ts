/**
 * Access linking operations (B2): the typed command registrations through
 * the A3 runtime seam.
 *
 * - `access.linkVerifiedMethod` (declared in @kiero/contracts) is a
 *   READ-ONLY CONFIRMATION in both directions — one side-effect contract:
 *   none. `verifiedIdentity` names the ceremony; the operation confirms
 *   THAT ceremony committed for the actor's account (method-specific
 *   evidence: the Google subject on the account, or the email-code
 *   credential attached). It never writes: the identity-layer surface
 *   (./functions.ts `verifyProofCode` and the OAuth callback hook in
 *   ./authHook.ts) drives the legs and performs the atomic commits. The
 *   earlier email_code variant consumed a staged code here, which made a
 *   typed error follow a successful write (the review's finding 2); this
 *   shape makes both branches confirmation-only by construction — the
 *   handler reads through `linkingStore`, which has no write methods.
 *
 * - `access.recoverAccount`: the CHECKED MANUAL-RECOVERY COMMAND defined
 *   here per the issue text. B4 registered its contract entry and its only
 *   alpha invoker (GM authority, convex/access/gm/operations.ts): the
 *   handler takes the RESOLVED GM ACTOR as `performedBy`, runs the same
 *   recoverAccountCore the guarded dev proof uses, and the GM transaction
 *   writes its audit row alongside. The guarded dev action (./probe.ts)
 *   keeps calling the core directly for evidence.
 */

import { Schema } from "effect";
import { accessOperations, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, forbiddenError, type HandlerRegistry } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import { recoverAccountCore } from "./recovery";
import { linkingStore, linkingTx } from "./storeAdapter";
import type { LinkingStore } from "./store";

const linkVerifiedMethodEntry = accessOperations["access.linkVerifiedMethod"];
const linkResult = Schema.Struct({ linked: Schema.Literal("linked") });

/** The recovery command's pinned input (checked decode; B4 wires the invoker). */
export const RecoverAccountInput = Schema.Struct({
  userId: Schema.String,
  verificationBasis: Schema.NonEmptyString,
});
export type RecoverAccountInput = Schema.Schema.Type<typeof RecoverAccountInput>;

/** The recovery command's pinned output. */
export const RecoverAccountResult = Schema.Struct({
  recoveredAtMs: Schema.Number,
  revokedSessions: Schema.Number,
  clearedAccounts: Schema.Number,
  clearedGoogleSubject: Schema.Boolean,
});

/**
 * The checked manual-recovery command (defined; invoker supplied by B4).
 * B4 amendment (issue #23): `run` takes the RESOLVED GM ACTOR as
 * `performedBy` — the GM-authority handler (convex/access/gm/) passes the
 * acting operator's user id so the ledger records the real person, never a
 * placeholder.
 */
export const recoverAccountCommand = {
  name: "access.recoverAccount",
  input: RecoverAccountInput,
  result: RecoverAccountResult,
  /**
   * The handler runs the recovery core; only the B4 GM dispatch (and the
   * guarded dev proof) may call it — the performedBy argument is supplied
   * by the resolved authority, never client input.
   */
  run: async (
    ctx: MutationCtx,
    input: RecoverAccountInput,
    performedBy: string,
  ): Promise<ResultEnvelope> => {
    const outcome = await recoverAccountCore(linkingTx(ctx), {
      targetUserId: input.userId,
      verificationBasis: input.verificationBasis,
      performedBy,
      nowMs: Date.now(),
    });
    if (outcome.state === "rejected") {
      return errorResult(conflictError("account_not_found", "users", input.userId));
    }
    return okResult(
      Schema.decodeUnknownSync(RecoverAccountResult)({
        recoveredAtMs: outcome.recoveredAtMs,
        revokedSessions: outcome.revokedSessionIds.length,
        clearedAccounts: outcome.clearedAccountIds.length,
        clearedGoogleSubject: outcome.clearedGoogleSubject,
      }),
    );
  },
} as const;

/**
 * The B2 handler table, composed into the access dispatch by the B1 entry
 * (convex/access/identity/operations.ts — one spread, no drift). The
 * store parameter is injectable so tests run the REAL dispatch path over
 * an in-memory store; production uses the generated-ctx adapter's read
 * surface (a `LinkingStore` — write-free by construction).
 */
export function linkingHandlers(
  buildStore: (ctx: MutationCtx) => LinkingStore = (ctx) => linkingStore(ctx.db),
): HandlerRegistry<MutationCtx> {
  return {
    "access.linkVerifiedMethod": {
      // Read-only confirmation: the checked query shape of a commit that
      // already happened through the identity-layer write path.
      intent: "read",
      run: async (ctx, context, input) => {
        const decoded = Schema.decodeUnknownSync(linkVerifiedMethodEntry.input)(input);
        if (decoded.userId !== context.actor.userId) {
          // Linking is self-service: only the actor's own account.
          return errorResult(forbiddenError("not_own_account", "users"));
        }
        const store = buildStore(ctx);
        const latest = await store.latestAttemptByUser(decoded.userId);
        if (
          latest === null ||
          decoded.verifiedIdentity !== latest.id ||
          latest.targetMethod !== decoded.method
        ) {
          // The referenced ceremony is not the actor's latest for this
          // method: nothing honest to confirm.
          return errorResult(conflictError("link_ceremony_mismatch"));
        }
        if (latest.state !== "committed") {
          // Proof legs still pending (or the ceremony was rejected): the
          // identity-layer write path owns every state change.
          return errorResult(conflictError("link_proofs_incomplete"));
        }
        // Method-specific committed evidence on the account itself.
        if (decoded.method === "google") {
          const account = await store.userById(decoded.userId);
          return account !== null && account.googleSubject !== null
            ? okResult(Schema.decodeUnknownSync(linkResult)({ linked: "linked" }))
            : errorResult(conflictError("link_proofs_incomplete"));
        }
        const credentialAttached = await store.hasEmailCodeCredential(decoded.userId);
        return credentialAttached
          ? okResult(Schema.decodeUnknownSync(linkResult)({ linked: "linked" }))
          : errorResult(conflictError("link_proofs_incomplete"));
      },
    },
  };
}
