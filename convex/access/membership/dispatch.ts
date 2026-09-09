/**
 * Membership command dispatch wiring (B3): the SAME checked path A3 proved
 * and B1/D1 reuse, with this lane's handler registry and policy.
 *
 * Three entry kinds, one core set (no drift by construction):
 *
 * 1. `dispatchMembershipCommand` — the typed command dispatch for
 *    company-scoped operations (revokeInvitation, changeMembershipRole,
 *    revokeMembership, transferAdministration). Context resolution is B1's
 *    write path: provision-or-refresh the live session, then the canonical
 *    chain (user -> earliest active membership -> company) that THIS lane's
 *    membership rows complete. A verified person without an active firm
 *    resolves null and fails `unauthenticated` — by design, their surface
 *    is the admission path below.
 *
 * 2. `dispatchCreateInvitation` — the issuance leg whose email delivery
 *    must happen OUTSIDE the transaction (mutations cannot fetch). It runs
 *    the full dispatch inside the mutation, captures the single-use code in
 *    the transaction's closure and hands it to the action wrapper
 *    (./functions.ts), which delivers through the B1 Resend adapter and
 *    composes the honest delivery state into the client envelope. The code
 *    never crosses a client boundary.
 *
 * 3. `dispatchAdmissionCommand` — `createCompany`, `acceptInvitation`,
 *    `rejectInvitation`: the checked admission path for a verified person
 *    who has no active firm yet. The runtime dispatch REQUIRES a
 *    company-scoped RequestContext, so (exactly like B1's own
 *    membership-less revokeSession surface) these entries run the same
 *    envelope decode, the same contract input decode, the same sanitized
 *    error surface and the same cores one seam earlier, over the verified
 *    live-session identity. See ./operations.ts for the atomicity contract.
 */

import { Schema } from "effect";
import {
  CommandEnvelope,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  decodeInput,
  dispatchCommand,
  notFoundError,
  sanitizeUnknownError,
  unauthenticatedError,
  type HandlerRegistry,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
  provisionOrRefreshLiveSession,
  liveSessionTx,
} from "../identity/resolution";
import { membershipLanePolicy } from "./policy";
import {
  acceptInvitationEntry,
  changeMembershipRoleEntry,
  createCompanyEntry,
  createInvitationEntry,
  performAcceptInvitation,
  performChangeMembershipRole,
  performCreateCompany,
  performCreateInvitation,
  performRejectInvitation,
  performRevokeInvitation,
  performRevokeMembership,
  performTransferAdministration,
  rejectInvitationEntry,
  revokeInvitationEntry,
  revokeMembershipEntry,
  transferAdministrationEntry,
  type AdmissionActor,
} from "./operations";

/** The issued invitation the action wrapper delivers (internal only). */
export interface IssuedInvitation {
  readonly invitationId: Id<"invitations">;
  readonly expiresAtMs: number;
  readonly email: string;
  readonly companyName: string;
  readonly code: string;
}

/** Handler table for the company-scoped membership dispatch (exported for tests). */
export function membershipHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "access.revokeInvitation": {
      intent: "administer",
      run: async (tx, context, input) => {
        const { invitationId } = Schema.decodeUnknownSync(revokeInvitationEntry.input)(input);
        const id = tx.db.normalizeId("invitations", invitationId);
        if (id === null) {
          return errorResult(notFoundError("invitations"));
        }
        return performRevokeInvitation(tx, context, id);
      },
    },
    "access.changeMembershipRole": {
      intent: "administer",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(changeMembershipRoleEntry.input)(input);
        const id = tx.db.normalizeId("memberships", decoded.membershipId);
        if (id === null) {
          return errorResult(notFoundError("memberships"));
        }
        return performChangeMembershipRole(tx, context, id, decoded.role);
      },
    },
    "access.revokeMembership": {
      // "write", not "administer": a plain boss may leave their own firm;
      // the core decides self-vs-administer over the target row.
      intent: "write",
      run: async (tx, context, input) => {
        const { membershipId } = Schema.decodeUnknownSync(revokeMembershipEntry.input)(input);
        const id = tx.db.normalizeId("memberships", membershipId);
        if (id === null) {
          return errorResult(notFoundError("memberships"));
        }
        return performRevokeMembership(tx, context, id);
      },
    },
    "access.transferAdministration": {
      intent: "administer",
      run: async (tx, context, input) => {
        const { toUserId } = Schema.decodeUnknownSync(transferAdministrationEntry.input)(input);
        const id = tx.db.normalizeId("users", toUserId);
        if (id === null) {
          return errorResult(notFoundError("memberships", "target_membership_not_found"));
        }
        return performTransferAdministration(tx, context, id);
      },
    },
  };
}

/**
 * Dispatches one company-scoped membership command envelope inside ONE
 * mutation transaction, through the checked path with B1's identity source
 * and the B3 policy. Unimplemented operations fail closed `unsupported`.
 */
export async function dispatchMembershipCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: membershipLanePolicy,
      handlers: membershipHandlers(),
    },
    ctx,
    envelope,
  );
}

/**
 * The issuance dispatch: the FULL checked path inside the transaction, with
 * the single-use code captured for the action wrapper. The mutation-side
 * envelope value is an internal transport detail (delivery state is
 * composed honestly by the caller after the real send attempt); the client
 * envelope comes only from ./functions.ts.
 */
export async function dispatchCreateInvitation(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<{ readonly result: ResultEnvelope; readonly issued: IssuedInvitation | null }> {
  let issued: IssuedInvitation | null = null;
  const result = await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: membershipLanePolicy,
      handlers: {
        "access.createInvitation": {
          intent: "administer",
          run: async (tx, context, input) => {
            const decoded = Schema.decodeUnknownSync(createInvitationEntry.input)(input);
            const outcome = await performCreateInvitation(tx, context, decoded);
            if (!outcome.ok) {
              return outcome.result;
            }
            issued = {
              invitationId: outcome.invitationId,
              expiresAtMs: outcome.expiresAtMs,
              email: outcome.email,
              companyName: outcome.companyName,
              code: outcome.code,
            };
            return okResult({ pendingDelivery: true });
          },
        },
      },
    },
    ctx,
    envelope,
  );
  return { result, issued };
}

/** The verified live-session actor the admission path resolves. */
export interface AdmissionContext {
  readonly userId: Id<"users">;
}

/**
 * The checked admission dispatch for verified, membership-less persons:
 * envelope decode -> operation must be an admission operation -> live
 * session resolution (B1's provision-or-refresh; every admission command
 * refreshes session activity like every other command) -> contract input
 * decode -> the core. Sanitization and closed errors identical to the
 * runtime dispatch.
 */
export async function dispatchAdmissionCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const decodedEnvelope = decodeInput(CommandEnvelope, envelope);
  if (!decodedEnvelope.ok) {
    return decodedEnvelope.error;
  }
  const command = decodedEnvelope.value;
  if (
    command.operation !== "access.createCompany" &&
    command.operation !== "access.acceptInvitation" &&
    command.operation !== "access.rejectInvitation"
  ) {
    // Company-scoped and unknown operations do not enter here; the
    // company-scoped dispatch entry is the honest surface for them.
    return errorResult(unauthenticatedError("no_company_scope_for_operation"));
  }

  const live = await provisionOrRefreshLiveSession(
    liveSessionTx(ctx.db),
    ctx.auth,
    Date.now(),
    DEFAULT_DEVICE_LABEL,
  );
  if (live.tag === "denied") {
    return errorResult(unauthenticatedError(`no_live_session_${live.reason}`));
  }
  const actor: AdmissionActor = { userId: live.session.userId };

  try {
    switch (command.operation) {
      case "access.createCompany": {
        const decodedInput = decodeInput(createCompanyEntry.input, command.input);
        if (!decodedInput.ok) {
          return decodedInput.error;
        }
        return await performCreateCompany(ctx, actor, decodedInput.value);
      }
      case "access.acceptInvitation": {
        const decodedInput = decodeInput(acceptInvitationEntry.input, command.input);
        if (!decodedInput.ok) {
          return decodedInput.error;
        }
        return await performAcceptInvitation(
          ctx,
          actor,
          decodedInput.value.invitationId,
          decodedInput.value.verificationCode,
        );
      }
      case "access.rejectInvitation": {
        const decodedInput = decodeInput(rejectInvitationEntry.input, command.input);
        if (!decodedInput.ok) {
          return decodedInput.error;
        }
        return await performRejectInvitation(ctx, actor, decodedInput.value.invitationId);
      }
    }
  } catch (cause) {
    return errorResult(sanitizeUnknownError(cause));
  }
}
