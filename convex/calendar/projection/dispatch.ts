/**
 * Calendar projection command dispatch wiring (G2, extended by G5): the SAME
 * checked path A3 proved and G1/C4 reuse, with this lane's handler registry
 * and policy.
 *
 * The registry implements exactly TWO certified operations today:
 * `calendar.setCopyHidden` (write): the actor's personal hide or explicit
 * restore of one copy, and `calendar.setSelection` (write, G5 issue #107):
 * the actor's personal project selection. `calendar.reconcileCopy` is G3's
 * lane and stays unregistered: it fails closed `unsupported` here, honestly,
 * until G3 implements it.
 *
 * Everything resolves through B1's identity source (provision-or-refresh,
 * then the canonical user -> earliest active membership -> company chain),
 * so a revoked membership fails `unauthenticated` before any handler runs.
 */

import { Schema } from "effect";
import { calendarOperations, type ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type AccessPolicy, type HandlerRegistry } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import { DEFAULT_DEVICE_LABEL, resolveAccessContextWithProvisioning } from "../../access/identity/resolution";
import { performSetCopyHidden, performSetSelection } from "./operations";

// The contract entries these handlers implement (decode authority).
export const setCopyHiddenEntry = calendarOperations["calendar.setCopyHidden"];
export const setSelectionEntry = calendarOperations["calendar.setSelection"];

/** G2's registered policy: the certified membership semantics, unchanged. */
export const calendarProjectionPolicy: AccessPolicy = {
  policyId: "calendar.g2-projection-v1",
  authorize: async (context, request) => {
    // Pre-condition owned by the composed resolution: a context exists only
    // for a live session with an active membership (the canonical chain).
    return await membershipPolicy.authorize(context, request);
  },
};

/** Handler table for the calendar projection dispatch (exported for tests). */
export function calendarProjectionHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "calendar.setCopyHidden": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(setCopyHiddenEntry.input)(input);
        return performSetCopyHidden(tx, context, {
          copyId: decoded.copyId,
          hidden: decoded.hidden,
        });
      },
    },
    "calendar.setSelection": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(setSelectionEntry.input)(input);
        return performSetSelection(tx, context, {
          mode: decoded.mode,
          ...(decoded.mode === "explicit" ? { projectIds: decoded.projectIds } : {}),
        });
      },
    },
  };
}

/**
 * Dispatches one calendar projection command envelope inside ONE mutation
 * transaction, through the checked path with B1's identity source and the
 * G2 policy. Unimplemented operations (including G3's reconcileCopy) fail
 * closed `unsupported`.
 */
export async function dispatchCalendarProjectionCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: calendarProjectionPolicy,
      handlers: calendarProjectionHandlers(),
    },
    ctx,
    envelope,
  );
}
