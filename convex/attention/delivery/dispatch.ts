/**
 * Notification-delivery command dispatch wiring (F2): the SAME checked
 * path every lane uses, with this lane's handler registry.
 *
 * `dispatchDeliveryCommand` is @kiero/runtime's `dispatchCommand` over
 * the canonical context resolution and the platform authorization seam,
 * through the attention lane's shared resolver (../context.ts). Two
 * identity sources exist and only two, both verified server-side (Convex
 * Auth for the public mutation; the verified service session for the
 * internal transactional entry and the guarded dev-proof actions).
 *
 * The handler runs inside ONE Convex mutation, so one evaluation sweep
 * commits atomically.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type CommandDeps, type HandlerRegistry } from "@kiero/runtime";
import { attentionContextResolver } from "../context";
import type { MutationCtx } from "../../_generated/server";
import { evaluateDueIntentsOperation, performEvaluateDueIntents } from "./operations";

/** Handler table for delivery mutation-transaction dispatches (tests pin keys). */
export function deliveryHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "attention.evaluateDueIntents": {
      intent: "write",
      run: async (tx, _context, input) => {
        const decoded = Schema.decodeUnknownSync(evaluateDueIntentsOperation.input)(input);
        return performEvaluateDueIntents(tx, decoded);
      },
    },
  };
}

/**
 * Dispatches one delivery command envelope inside a mutation transaction.
 * The optional `serviceSessionId` marks the service-bridge path; without
 * it, Convex Auth is the only identity source.
 */
export async function dispatchDeliveryCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<MutationCtx> = {
    resolveContext: attentionContextResolver(serviceSessionId),
    policy: membershipPolicy,
    handlers: deliveryHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
