/**
 * Read-state command dispatch wiring (F1): the SAME checked path A3 proved
 * and D1 lifted, with this lane's handler registry.
 *
 * `dispatchReadStateCommand` is @kiero/runtime's `dispatchCommand` over the
 * canonical context resolution (verified identity -> session -> user -> one
 * active membership -> company) and the platform authorization seam,
 * through the attention lane's shared resolver (../context.ts). Two
 * identity sources exist and only two, both verified server-side: Convex
 * Auth (`ctx.auth`, the user path) and the service bridge (a verified
 * service session id, used by the internal transactional entry and the
 * guarded dev-proof actions). There is no development-auth shortcut.
 *
 * The handler runs inside ONE Convex mutation, so the read-state row and
 * the canonical `attention.sourceReadChanged` event commit atomically.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type CommandDeps, type HandlerRegistry } from "@kiero/runtime";
import { attentionContextResolver } from "../context";
import type { MutationCtx } from "../../_generated/server";
import { markSourceReadOperation, performMarkSourceRead } from "./operations";

/** Handler table for read-state mutation-transaction dispatches (tests pin keys). */
export function readStateHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "attention.markSourceRead": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(markSourceReadOperation.input)(input);
        return performMarkSourceRead(tx, context, decoded);
      },
    },
  };
}

/**
 * Dispatches one read-state command envelope inside a mutation transaction.
 * The optional `serviceSessionId` marks the service-bridge path (identity
 * verified before this point); without it, Convex Auth is the only identity
 * source. Unimplemented attention operations fail closed `unsupported`.
 */
export async function dispatchReadStateCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<MutationCtx> = {
    resolveContext: attentionContextResolver(serviceSessionId),
    policy: membershipPolicy,
    handlers: readStateHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
