/**
 * GM command dispatch wiring (B4): the checked path for audited GM
 * operations, with this lane's authority resolution.
 *
 * Why a dedicated dispatch (not the runtime's `dispatchCommand`): the
 * runtime seam requires a company-scoped RequestContext (ActorContext
 * carries companyId + membershipRole), which a GM WITHOUT membership can
 * never honestly have. Exactly like B3's admission surface, GM operations
 * enter one seam earlier: envelope decode -> operation allowlist (this
 * lane's) -> B1 identity resolution (provision-or-refresh) -> OPEN GRANT
 * resolution -> contract input decode -> handler. The check order mirrors
 * `dispatchCommand` (packages/runtime/src/command.ts) so the closed-error
 * discipline is identical; the authority object carries {userId, grantId}
 * and every handler re-decides per-company authority inside the
 * transaction (current authority at commit, OCC-serialized).
 *
 * The GM authority NEVER confers membership: member operations are absent
 * from this registry by construction, and the membership dispatches
 * (B1/B3) register none of these names — fail-closed both ways.
 */

import { Schema } from "effect";
import {
  CommandEnvelope,
  errorResult,
  okResult,
  operations as composedOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  decodeInput,
  forbiddenError,
  sanitizeUnknownError,
  unauthenticatedError,
  unsupportedError,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import {
  DEFAULT_DEVICE_LABEL,
  liveSessionTx,
  provisionOrRefreshLiveSession,
} from "../identity/resolution";
import { recoverAccountCommand } from "../linking/operations";
import { gmTx } from "./storeAdapter";
import {
  performExitGmMode,
  performGmActivateCompany,
  performGmEndCompanyAlpha,
  performGmInspectCompany,
  performGmOnboardCompany,
  performGmRecoverAccount,
  performGmRestoreAdministrator,
  type GmAuthority,
} from "./operations";
import { gmActivateCompanyEntry, gmInspectCompanyEntry, gmOnboardCompanyEntry, gmRestoreAdministratorEntry, gmEndCompanyAlphaEntry, exitGmModeEntry, recoverAccountEntry } from "./operations";
import { GM_OPERATIONS, GM_POLICY_ID } from "./policy";
import type { GmTx } from "./store";

/** The onboarding outcome the action wrapper delivers (internal only). */
export interface IssuedOnboarding {
  readonly result: ResultEnvelope;
  readonly issued: {
    readonly companyId: string;
    readonly activationId: string;
    readonly invitationId: string;
    readonly expiresAtMs: number;
    readonly email: string;
    readonly companyName: string;
    readonly code: string;
  } | null;
}

/** One GM handler: decoded input, the resolved authority, one transaction. */
export interface GmHandler {
  run: (
    ctx: MutationCtx,
    tx: GmTx,
    authority: GmAuthority,
    input: unknown,
  ) => Promise<ResultEnvelope>;
}

/** The GM handler table (exported for tests: exact keys are pinned). */
export function gmHandlers(onboardCapture?: {
  capture: (issued: IssuedOnboarding["issued"]) => void;
}): Record<string, GmHandler> {
  return {
    "access.exitGmMode": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(exitGmModeEntry.input)(input);
        return performExitGmMode(tx, { userId: authority.userId, grantId: decoded.grantId });
      },
    },
    "access.recoverAccount": {
      run: async (ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(recoverAccountEntry.input)(input);
        // The production recovery runner: B2's checked command with the
        // RESOLVED GM actor as the performer, in this transaction.
        return performGmRecoverAccount(tx, authority, decoded, (recoveryInput, performedBy) =>
          recoverAccountCommand.run(ctx, recoveryInput, performedBy),
        );
      },
    },
    "access.gmInspectCompany": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(gmInspectCompanyEntry.input)(input);
        return performGmInspectCompany(tx, authority, decoded);
      },
    },
    "access.gmOnboardCompany": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(gmOnboardCompanyEntry.input)(input);
        const outcome = await performGmOnboardCompany(tx, authority, decoded);
        if (!outcome.ok) {
          return outcome.result;
        }
        onboardCapture?.capture({
          companyId: outcome.companyId,
          activationId: outcome.activationId,
          invitationId: outcome.invitationId,
          expiresAtMs: outcome.expiresAtMs,
          email: outcome.email,
          companyName: outcome.companyName,
          code: outcome.code,
        });
        // The action wrapper composes the honest delivery state into the
        // client envelope; this transport value never leaves the server
        // (same shape as B3's issuance leg).
        return okResult({ pendingDelivery: true });
      },
    },
    "access.gmActivateCompany": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(gmActivateCompanyEntry.input)(input);
        return performGmActivateCompany(tx, authority, decoded);
      },
    },
    "access.gmRestoreAdministrator": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(gmRestoreAdministratorEntry.input)(input);
        return performGmRestoreAdministrator(tx, authority, decoded);
      },
    },
    "access.gmEndCompanyAlpha": {
      run: async (_ctx, tx, authority, input) => {
        const decoded = Schema.decodeUnknownSync(gmEndCompanyAlphaEntry.input)(input);
        return performGmEndCompanyAlpha(tx, authority, decoded);
      },
    },
  };
}

/** The resolved GM authority or the closed denial that replaces it. */
export type AuthorityResolution =
  | { readonly ok: true; readonly authority: GmAuthority }
  | { readonly ok: false; readonly result: ResultEnvelope };

/** What a GM dispatch needs (injectable so tests run the REAL path). */
export interface GmDispatchDeps {
  readonly policyId: string;
  readonly allowlist: readonly string[];
  readonly resolveAuthority: (ctx: MutationCtx) => Promise<AuthorityResolution>;
  readonly handlers: Record<string, GmHandler>;
}

/** The production authority resolution: live session -> open grant. */
export async function resolveGmAuthority(ctx: MutationCtx): Promise<AuthorityResolution> {
  const live = await provisionOrRefreshLiveSession(
    liveSessionTx(ctx.db),
    ctx.auth,
    Date.now(),
    DEFAULT_DEVICE_LABEL,
  );
  if (live.tag === "denied") {
    return { ok: false, result: errorResult(unauthenticatedError(`no_live_session_${live.reason}`)) };
  }
  const grants = await ctx.db
    .query("gmAccessGrants")
    .withIndex("by_user_open", (q) => q.eq("userId", live.session.userId))
    .collect();
  const open = grants.find((grant) => grant.closedAtMs === undefined);
  if (open === undefined) {
    return {
      ok: false,
      result: errorResult(forbiddenError("gm_mode_not_active", "gm")),
    };
  }
  return { ok: true, authority: { userId: live.session.userId, grantId: open._id } };
}

/** The production deps (the policy id is pinned by tests and evidence). */
export function gmCommandDeps(onboardCapture?: {
  capture: (issued: IssuedOnboarding["issued"]) => void;
}): GmDispatchDeps {
  return {
    policyId: GM_POLICY_ID,
    allowlist: GM_OPERATIONS,
    resolveAuthority: resolveGmAuthority,
    handlers: gmHandlers(onboardCapture),
  };
}

/**
 * Dispatches one GM command envelope through the checked path (the test
 * entry; production goes through dispatchGmCommand below).
 */
export async function dispatchGmCommandWith(
  deps: GmDispatchDeps,
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const decodedEnvelope = decodeInput(CommandEnvelope, envelope);
  if (!decodedEnvelope.ok) {
    return decodedEnvelope.error;
  }
  const command = decodedEnvelope.value;

  if (composedOperations[command.operation] === undefined) {
    return errorResult(unsupportedError(command.operation, "unknown_operation"));
  }
  if (!deps.allowlist.includes(command.operation)) {
    // A registered operation that is NOT a GM operation (a member or
    // source-editing name, an arbitrary model probe): this surface does not
    // route it. Fail closed exactly like an unimplemented name.
    return errorResult(unsupportedError(command.operation));
  }
  const handler = deps.handlers[command.operation];
  if (handler === undefined) {
    return errorResult(unsupportedError(command.operation));
  }

  const resolution = await deps.resolveAuthority(ctx);
  if (!resolution.ok) {
    return resolution.result;
  }

  const entry = composedOperations[command.operation];
  if (entry === undefined) {
    return errorResult(unsupportedError(command.operation, "unknown_operation"));
  }
  const decodedInput = decodeInput(entry.input, command.input);
  if (!decodedInput.ok) {
    return decodedInput.error;
  }

  try {
    return await handler.run(ctx, gmTx(ctx), resolution.authority, decodedInput.value);
  } catch (cause) {
    return errorResult(sanitizeUnknownError(cause));
  }
}

/** The production GM dispatch (the public mutation's handler). */
export async function dispatchGmCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchGmCommandWith(gmCommandDeps(), ctx, envelope);
}

/**
 * The onboarding dispatch leg: the FULL checked path inside the
 * transaction, with the single-use invitation code captured for the action
 * wrapper (email delivery happens OUTSIDE the transaction, exactly like
 * B3's issuance leg; the code never crosses a client boundary).
 */
export async function dispatchGmOnboard(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<IssuedOnboarding> {
  let issued: IssuedOnboarding["issued"] = null;
  const result = await dispatchGmCommandWith(
    gmCommandDeps({ capture: (value) => (issued = value) }),
    ctx,
    envelope,
  );
  return { result, issued };
}
