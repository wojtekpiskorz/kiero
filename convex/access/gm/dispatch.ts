/**
 * GM command dispatch wiring (B4): the checked path for audited GM
 * operations, with this lane's authority resolution.
 *
 * Why a dedicated dispatch (not the runtime's `dispatchCommand`): the
 * runtime seam requires a company-scoped RequestContext (ActorContext
 * carries companyId + membershipRole), which a GM WITHOUT membership can
 * never honestly have. Exactly like B3's admission surface, GM operations
 * enter one seam earlier: envelope decode -> operation allowlist (this
 * lane's) -> B1 identity resolution (provision-or-refresh) -> the policy
 * gate `decideGmRequest` over an OPEN GRANT (./policy.ts) -> contract
 * input decode -> handler. The check order mirrors `dispatchCommand`
 * (packages/runtime/src/command.ts) so the closed-error discipline is
 * identical; the authority object carries {userId, grantId} and every
 * handler re-decides per-company authority inside the transaction
 * (current authority at commit, OCC-serialized).
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
import { openGrantOfUser } from "./cores";
import { gmStore, gmTx } from "./storeAdapter";
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
import {
  exitGmModeEntry,
  gmActivateCompanyEntry,
  gmEndCompanyAlphaEntry,
  gmInspectCompanyEntry,
  gmOnboardCompanyEntry,
  recoverAccountEntry,
  gmRestoreAdministratorEntry,
} from "./operations";
import { GM_OPERATIONS, decideGmRequest } from "./policy";
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

/**
 * Builds one handler from its contract entry. The dispatch has ALREADY
 * decoded the input against the same entry's schema (its check order:
 * authority, then input decode, then handler — invalid input never reaches
 * a handler); this decode is the single typing seam that narrows the
 * already-validated value to its contract type, in one place instead of
 * seven hand-rolled copies.
 */
function gmHandlerOf<Input>(
  entry: { readonly input: Schema.Codec<Input, unknown, never, never> },
  run: (
    ctx: MutationCtx,
    tx: GmTx,
    authority: GmAuthority,
    input: Input,
  ) => Promise<ResultEnvelope>,
): GmHandler {
  return {
    run: (ctx, tx, authority, input) =>
      run(ctx, tx, authority, Schema.decodeUnknownSync(entry.input)(input)),
  };
}

/** The GM handler table (exported for tests: exact keys are pinned). */
export function gmHandlers(onboardCapture?: {
  capture: (issued: IssuedOnboarding["issued"]) => void;
}): Record<string, GmHandler> {
  return {
    "access.exitGmMode": gmHandlerOf(exitGmModeEntry, (_ctx, tx, authority, input) =>
      performExitGmMode(tx, { userId: authority.userId, grantId: input.grantId }),
    ),
    "access.recoverAccount": gmHandlerOf(recoverAccountEntry, (ctx, tx, authority, input) =>
      // The production recovery runner: B2's checked command with the
      // RESOLVED GM actor as the performer, in this transaction.
      performGmRecoverAccount(tx, authority, input, (recoveryInput, performedBy) =>
        recoverAccountCommand.run(ctx, recoveryInput, performedBy),
      ),
    ),
    "access.gmInspectCompany": gmHandlerOf(gmInspectCompanyEntry, (_ctx, tx, authority, input) =>
      performGmInspectCompany(tx, authority, input),
    ),
    "access.gmOnboardCompany": gmHandlerOf(gmOnboardCompanyEntry, async (_ctx, tx, authority, input) => {
      const outcome = await performGmOnboardCompany(tx, authority, input);
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
    }),
    "access.gmActivateCompany": gmHandlerOf(gmActivateCompanyEntry, (_ctx, tx, authority, input) =>
      performGmActivateCompany(tx, authority, input),
    ),
    "access.gmRestoreAdministrator": gmHandlerOf(
      gmRestoreAdministratorEntry,
      (_ctx, tx, authority, input) => performGmRestoreAdministrator(tx, authority, input),
    ),
    "access.gmEndCompanyAlpha": gmHandlerOf(gmEndCompanyAlphaEntry, (_ctx, tx, authority, input) =>
      performGmEndCompanyAlpha(tx, authority, input),
    ),
  };
}

/** The resolved GM authority or the closed denial that replaces it. */
export type AuthorityResolution =
  | { readonly ok: true; readonly authority: GmAuthority }
  | { readonly ok: false; readonly result: ResultEnvelope };

/** What a GM dispatch needs (injectable so tests run the REAL path). */
export interface GmDispatchDeps {
  readonly allowlist: readonly string[];
  readonly resolveAuthority: (ctx: MutationCtx) => Promise<AuthorityResolution>;
  readonly handlers: Record<string, GmHandler>;
}

/**
 * The production authority resolution: live session -> the policy gate.
 * Session liveness is decided by the composed B1 resolution (upstream of
 * the policy — see ./policy.ts); with a live session, `decideGmRequest`
 * decides over resolved facts: an open grant, membership deliberately not
 * consulted. The open-grant predicate is the cores' one spelling
 * (`openGrantOfUser`), read through the same store adapter the handlers
 * use.
 */
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
  const open = openGrantOfUser(await gmStore(ctx.db).grantsOfUser(live.session.userId));
  const decision = decideGmRequest({ hasLiveSession: true, hasOpenGrant: open !== null });
  if (!decision.allowed && decision.kind === "forbidden") {
    return { ok: false, result: errorResult(forbiddenError(decision.code, "gm")) };
  }
  if (open === null) {
    // decideGmRequest's unauthenticated branch is unreachable here (session
    // liveness decided above); an open grant is the only allowed shape, so
    // this is kept fail-closed rather than reachable.
    return { ok: false, result: errorResult(unauthenticatedError("no_live_session_no_identity")) };
  }
  return { ok: true, authority: { userId: live.session.userId, grantId: open.id } };
}

/** The production deps. */
export function gmCommandDeps(onboardCapture?: {
  capture: (issued: IssuedOnboarding["issued"]) => void;
}): GmDispatchDeps {
  return {
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

  const entry = composedOperations[command.operation];
  if (entry === undefined) {
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
