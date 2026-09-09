/**
 * Access linking operations (B2): the typed command registrations through
 * the A3 runtime seam.
 *
 * - `access.linkVerifiedMethod` (declared in @kiero/contracts): the typed
 *   COMMIT operation of the ceremony. The email-code direction takes the
 *   one-time code as `verifiedIdentity` (the server verifies the hash
 *   against the ceremony's staged code before anything writes); the Google
 *   direction takes the ceremony reference — its atomic commit happens in
 *   the OAuth callback (the library attaches the provider account in the
 *   same transaction), so the typed operation is the checked idempotent
 *   confirmation of that commit. One core decides both entry ways.
 *
 * - `access.recoverAccount`: the CHECKED MANUAL-RECOVERY COMMAND defined
 *   here per the issue text. Its invoker is deliberately unavailable: no
 *   public function routes to the handler until B4 supplies explicit GM
 *   authority. The pinned input/output schemas and the handler (running
 *   the same recoverAccountCore the guarded dev proof uses) are the
 *   contract B4 wires; until then dispatching the name fails closed with
 *   `unknown_operation` (it is not in the composed contracts registry — a
 *   named prerequisite recorded in the B2 report).
 */

import { Schema } from "effect";
import { accessOperations, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, forbiddenError, type HandlerRegistry } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import { linkingTx, recoverAccountCore, verifyProofCodeCore, type LinkingTx } from "./cores";

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

/** The checked manual-recovery command (defined; invoker withheld for B4). */
export const recoverAccountCommand = {
  name: "access.recoverAccount",
  input: RecoverAccountInput,
  result: RecoverAccountResult,
  /**
   * The handler runs the recovery core; nothing registers it in a public
   * dispatch surface until B4's GM authority exists. Exported for the
   * guarded dev proof and for B4's registration — the only two sanctioned
   * callers.
   */
  run: async (ctx: MutationCtx, input: RecoverAccountInput): Promise<ResultEnvelope> => {
    const outcome = await recoverAccountCore(linkingTx(ctx), {
      targetUserId: input.userId,
      verificationBasis: input.verificationBasis,
      performedBy: "gm-authority", // B4 replaces with the resolved GM actor.
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
 * (convex/access/identity/operations.ts — one spread, no drift). The tx
 * factory parameter is injectable so tests run the REAL dispatch path over
 * an in-memory store; production uses the generated-ctx adapter.
 */
export function linkingHandlers(
  buildTx: (ctx: MutationCtx) => LinkingTx = linkingTx,
): HandlerRegistry<MutationCtx> {
  return {
    "access.linkVerifiedMethod": {
      intent: "write",
      run: async (ctx, context, input) => {
        const decoded = Schema.decodeUnknownSync(linkVerifiedMethodEntry.input)(input);
        if (decoded.userId !== context.actor.userId) {
          // Linking is self-service: only the actor's own account.
          return errorResult(forbiddenError("not_own_account", "users"));
        }
        const tx = buildTx(ctx);
        if (decoded.method === "email_code") {
          // verifiedIdentity IS the one-time code mailed for the ceremony's
          // email leg; the core verifies its hash before any write.
          const outcome = await verifyProofCodeCore(tx, {
            actorUserId: decoded.userId,
            code: decoded.verifiedIdentity,
            nowMs: Date.now(),
          });
          if (!outcome.ok) {
            // The typed code carries the LinkRejectionCode (link_<code>);
            // the conflict error takes no recordTable because a ceremony is
            // not an expected-revision record.
            return errorResult(conflictError(`link_${outcome.code}`));
          }
          if (!outcome.value.linked) {
            // The ceremony's FIRST leg verified, but no link committed yet.
            return errorResult(conflictError("link_proofs_incomplete"));
          }
          return okResult(Schema.decodeUnknownSync(linkResult)({ linked: "linked" }));
        }
        // Google direction: the atomic commit already happened in the OAuth
        // callback (library transaction). The typed operation is the checked
        // idempotent confirmation over the actor's latest ceremony.
        const latest = await tx.latestAttemptByUser(decoded.userId);
        const account = await tx.userById(decoded.userId);
        if (
          latest === null ||
          latest.state !== "committed" ||
          account === null ||
          account.googleSubject === null
        ) {
          return errorResult(conflictError("link_proofs_incomplete"));
        }
        return okResult(Schema.decodeUnknownSync(linkResult)({ linked: "linked" }));
      },
    },
  };
}
