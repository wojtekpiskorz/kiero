/**
 * Work command dispatch wiring (C4): the SAME checked path A3 proved and
 * B1/B3/C1/C2/D1 reuse, with this lane's handler registry and policy.
 *
 * `dispatchWorkCommand` is @kiero/runtime's `dispatchCommand` over the
 * B3-preceded identity resolution: provision-or-refresh the B1 live session,
 * then the canonical chain (user -> earliest active membership -> company)
 * whose rows B3 owns. The resolved context is the ONLY company scope — no
 * client input names a company. The handlers run inside ONE Convex mutation,
 * so each state change, its history row and its canonical `work.*` event
 * commit atomically.
 *
 * The dispatch decodes the envelope input ONCE and hands the handler the
 * DECODED value; the handlers re-decode (the B3/C1 pattern), which is
 * sound here because every work input field is an untransformed wire shape
 * (ids, literals, strings, integers) — no schema-transformed values.
 *
 * Unknown operation names (including any invented "complete from
 * checklist" or "occurred because the date passed" operation) fail closed
 * `unsupported` through the shared runtime path.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, type HandlerRegistry } from "@kiero/runtime";
import type { MutationCtx } from "../_generated/server";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "../access/identity/resolution";
import { workLanePolicy } from "./policy";
import {
  changeChecklistItemEntry,
  changeEventEntry,
  changeEventStateEntry,
  changeTaskEntry,
  changeTaskStateEntry,
  performChangeChecklistItem,
  performChangeEvent,
  performChangeEventState,
  performChangeTask,
  performChangeTaskState,
  performPromoteChecklistItem,
  promoteChecklistItemEntry,
} from "./operations";

/** Handler table for the company-scoped work dispatch (exported for tests). */
export function workHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "work.changeTask": {
      intent: "write",
      run: async (tx, context, input) =>
        performChangeTask(tx, context, Schema.decodeUnknownSync(changeTaskEntry.input)(input)),
    },
    "work.changeTaskState": {
      intent: "write",
      run: async (tx, context, input) =>
        performChangeTaskState(
          tx,
          context,
          Schema.decodeUnknownSync(changeTaskStateEntry.input)(input),
        ),
    },
    "work.changeChecklistItem": {
      intent: "write",
      run: async (tx, context, input) =>
        performChangeChecklistItem(
          tx,
          context,
          Schema.decodeUnknownSync(changeChecklistItemEntry.input)(input),
        ),
    },
    "work.promoteChecklistItem": {
      intent: "write",
      run: async (tx, context, input) =>
        performPromoteChecklistItem(
          tx,
          context,
          Schema.decodeUnknownSync(promoteChecklistItemEntry.input)(input),
        ),
    },
    "work.changeEvent": {
      intent: "write",
      run: async (tx, context, input) =>
        performChangeEvent(tx, context, Schema.decodeUnknownSync(changeEventEntry.input)(input)),
    },
    "work.changeEventState": {
      intent: "write",
      run: async (tx, context, input) =>
        performChangeEventState(
          tx,
          context,
          Schema.decodeUnknownSync(changeEventStateEntry.input)(input),
        ),
    },
  };
}

/**
 * Dispatches one company-scoped work command envelope inside ONE Convex
 * mutation transaction, through the checked path with B1's identity source
 * and the C4 policy. Unimplemented operations fail closed `unsupported`.
 */
export async function dispatchWorkCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: workLanePolicy,
      handlers: workHandlers(),
    },
    ctx,
    envelope,
  );
}
