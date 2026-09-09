/**
 * Calendar connection command dispatch wiring (G1): the SAME checked path
 * A3 proved and B1/B3/D1 reuse, with this lane's handler registry and
 * policy.
 *
 * The registry implements exactly the two certified calendar connection
 * operations (packages/contracts/src/modules/calendar.ts):
 *
 * - `calendar.connectCalendar` (write): completes the ACTOR's pending
 *   authorization with a dedicated calendar id. The OAuth callback path
 *   completes with credentials through ./operations.ts; this typed entry
 *   is the contract surface tests, the UI and integrators use, running the
 *   identical connected transition (credential capability stays honestly
 *   "absent" without the OAuth legs).
 * - `calendar.disconnectCalendar` (write): the stop core (cancel pending,
 *   stop publishing, record unconfirmed cleanup) with a tenant-checked
 *   connection id (a foreign row is not_found, no existence leak).
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
import { performConnectCalendar, performDisconnectCalendar } from "./operations";

// The contract entries these handlers implement (decode authority).
export const connectCalendarEntry = calendarOperations["calendar.connectCalendar"];
export const disconnectCalendarEntry = calendarOperations["calendar.disconnectCalendar"];

/** G1's registered policy: the certified membership semantics, unchanged. */
export const calendarLanePolicy: AccessPolicy = {
  policyId: "calendar.g1-connection-v1",
  authorize: async (context, request) => {
    // Pre-condition owned by the composed resolution: a context exists only
    // for a live session with an active membership (the canonical chain).
    return await membershipPolicy.authorize(context, request);
  },
};

/** Handler table for the calendar connection dispatch (exported for tests). */
export function calendarHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "calendar.connectCalendar": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(connectCalendarEntry.input)(input);
        return performConnectCalendar(tx, context, { googleCalendarId: decoded.googleCalendarId });
      },
    },
    "calendar.disconnectCalendar": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(disconnectCalendarEntry.input)(input);
        return performDisconnectCalendar(tx, context, { connectionId: decoded.connectionId });
      },
    },
  };
}

/**
 * Dispatches one calendar connection command envelope inside ONE mutation
 * transaction, through the checked path with B1's identity source and the
 * G1 policy. Unimplemented operations fail closed `unsupported`.
 */
export async function dispatchCalendarCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: calendarLanePolicy,
      handlers: calendarHandlers(),
    },
    ctx,
    envelope,
  );
}
