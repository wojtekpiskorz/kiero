/**
 * Notification-preference command dispatch wiring (F1): the SAME checked
 * path every lane uses, with this lane's handler registry.
 *
 * `dispatchPreferencesCommand` is @kiero/runtime's `dispatchCommand` over
 * the canonical context resolution and the platform authorization seam.
 * Two identity sources exist and only two, both verified server-side
 * (Convex Auth for the public mutation; the verified service session for
 * the internal transactional entry and the guarded dev-proof actions).
 *
 * The handler runs inside ONE Convex mutation, so the whole preference
 * upsert commits atomically.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import {
  bridgeIdentity,
  identityFromConvexAuth,
  resolveRequestContext,
} from "../../platform/context";
import type { MutationCtx } from "../../_generated/server";
import { changePreferencesOperation, performChangeNotificationPreferences } from "./operations";

/** Handler table for preference mutation-transaction dispatches (tests pin keys). */
export function preferencesHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "attention.changeNotificationPreferences": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(changePreferencesOperation.input)(input);
        return performChangeNotificationPreferences(tx, context, decoded);
      },
    },
  };
}

/**
 * Dispatches one preference command envelope inside a mutation
 * transaction. The optional `serviceSessionId` marks the service-bridge
 * path; without it, Convex Auth is the only identity source.
 */
export async function dispatchPreferencesCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const resolveContext = async (tx: MutationCtx): Promise<RequestContext | null> => {
    const identity =
      serviceSessionId === undefined
        ? await identityFromConvexAuth(tx.auth, Date.now())
        : bridgeIdentity(serviceSessionId, Date.now());
    return resolveRequestContext(tx.db, identity);
  };
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: preferencesHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
