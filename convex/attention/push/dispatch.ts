/**
 * Web Push command dispatch wiring (F3): the SAME checked path every lane
 * uses, with this lane's handler registry (the F1/F2 precedent).
 *
 * `dispatchPushCommand` is @kiero/runtime's `dispatchCommand` over the
 * canonical context resolution and the platform authorization seam,
 * through the attention lane's shared resolver (../context.ts). Two
 * identity sources exist and only two, both verified server-side (Convex
 * Auth for the public mutation; the verified service session for the
 * internal transactional entry and the guarded dev-proof actions).
 *
 * The handler runs inside ONE Convex mutation, so one registration or
 * device removal commits atomically. The subscription binding is ALWAYS
 * the resolved actor (user, company, session) - a client never asserts
 * who a subscription belongs to.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type CommandDeps, type HandlerRegistry } from "@kiero/runtime";
import { attentionContextResolver } from "../context";
import type { MutationCtx } from "../../_generated/server";
import {
  performRegisterPushSubscription,
  performRevokePushSubscription,
  registerPushOperation,
  revokePushOperation,
} from "./operations";

/** Handler table for push mutation-transaction dispatches (tests pin keys). */
export function pushHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "attention.registerPushSubscription": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(registerPushOperation.input)(input);
        return performRegisterPushSubscription(tx, context, decoded);
      },
    },
    "attention.revokePushSubscription": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(revokePushOperation.input)(input);
        return performRevokePushSubscription(tx, context, decoded);
      },
    },
  };
}

/**
 * Dispatches one push command envelope inside a mutation transaction.
 * The optional `serviceSessionId` marks the service-bridge path; without
 * it, Convex Auth is the only identity source.
 */
export async function dispatchPushCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<MutationCtx> = {
    resolveContext: attentionContextResolver(serviceSessionId),
    policy: membershipPolicy,
    handlers: pushHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
