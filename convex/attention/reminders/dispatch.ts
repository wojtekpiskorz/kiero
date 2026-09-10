/**
 * Task-reminder command dispatch wiring (F4): the SAME checked path every
 * lane uses, with this lane's handler registry.
 *
 * `dispatchRemindersCommand` is @kiero/runtime's `dispatchCommand` over
 * the canonical context resolution and the platform authorization seam,
 * through the attention lane's shared resolver (../context.ts). Two
 * identity sources exist and only two, both verified server-side (Convex
 * Auth for the public mutations; the verified service session for the
 * internal transactional entry and the guarded dev-proof actions).
 *
 * The handler runs inside ONE Convex mutation, so one snooze (the row, the
 * deferrals, the event) or one evaluation sweep commits atomically.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type CommandDeps, type HandlerRegistry } from "@kiero/runtime";
import { attentionContextResolver } from "../context";
import type { MutationCtx } from "../../_generated/server";
import {
  evaluateDueRemindersOperation,
  snoozeTaskRemindersOperation,
  performEvaluateDueReminders,
  performSnoozeTaskReminders,
} from "./operations";

/** Handler table for reminder mutation-transaction dispatches (tests pin keys). */
export function remindersHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "attention.snoozeTaskReminders": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(snoozeTaskRemindersOperation.input)(input);
        return performSnoozeTaskReminders(tx, context, decoded);
      },
    },
    "attention.evaluateDueReminders": {
      intent: "write",
      run: async (tx, _context, input) => {
        const decoded = Schema.decodeUnknownSync(evaluateDueRemindersOperation.input)(input);
        return performEvaluateDueReminders(tx, decoded);
      },
    },
  };
}

/**
 * Dispatches one reminder command envelope inside a mutation transaction.
 * The optional `serviceSessionId` marks the service-bridge path; without
 * it, Convex Auth is the only identity source.
 */
export async function dispatchRemindersCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<MutationCtx> = {
    resolveContext: attentionContextResolver(serviceSessionId),
    policy: membershipPolicy,
    handlers: remindersHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
