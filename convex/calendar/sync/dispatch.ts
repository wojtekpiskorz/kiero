/**
 * Calendar sync command dispatch wiring (G3): the SAME checked path A3
 * proved and G1/G2 reuse, with this lane's handler registry and policy.
 *
 * The registry implements exactly ONE certified operation —
 * `calendar.reconcileCopy` (write): the actor's explicit request that ONE
 * of their own copies be reconciled NOW. The Google legs never run inside
 * the dispatch mutation (no external calls in transactions): the handler
 * registers the durable `calendar.reconcile_outcome` job transactionally
 * — the certified path — and answers the copy's CURRENT recorded outcome
 * (possibly `unknown`; the scheduled observation resolves it).
 *
 * Everything resolves through B1's identity source (provision-or-refresh,
 * then the canonical user -> earliest active membership -> company chain),
 * so a revoked membership fails `unauthenticated` before any handler runs.
 */

import { Schema } from "effect";
import { calendarOperations, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  notFoundError,
  unavailableError,
  type AccessPolicy,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import { newDurableJobKey } from "@kiero/contracts";
import type { MutationCtx } from "../../_generated/server";
import { DEFAULT_DEVICE_LABEL, resolveAccessContextWithProvisioning } from "../../access/identity/resolution";
import { registerDurableJob } from "../../platform/publish";

// The contract entry this handler implements (decode authority).
export const reconcileCopyEntry = calendarOperations["calendar.reconcileCopy"];

/** G3's registered policy: the certified membership semantics, unchanged. */
export const calendarSyncPolicy: AccessPolicy = {
  policyId: "calendar.g3-sync-v1",
  authorize: async (context, request) => {
    // Pre-condition owned by the composed resolution: a context exists only
    // for a live session with an active membership (the canonical chain).
    return await membershipPolicy.authorize(context, request);
  },
};

/** Handler table for the calendar sync dispatch (exported for tests). */
export function calendarSyncHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "calendar.reconcileCopy": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(reconcileCopyEntry.input)(input);
        return await performReconcileCopy(tx, context, {
          copyId: decoded.copyId,
        });
      },
    },
  };
}

/**
 * `calendar.reconcileCopy`: ownership is the actor's OWN copy (the same
 * rule G2's setCopyHidden applies — a foreign copy is not_found, no
 * existence leak). A healthy connected row gets the durable
 * reconciliation job registered IN this transaction; anything that cannot
 * serve reconciliation now answers the certified `unavailable` error
 * honestly (never a fake outcome).
 */
export async function performReconcileCopy(
  ctx: MutationCtx,
  context: RequestContext,
  input: { readonly copyId: string },
): Promise<ResultEnvelope> {
  const id = ctx.db.normalizeId("calendarCopies", input.copyId);
  if (id === null) {
    return errorResult(notFoundError("calendarCopies"));
  }
  const copy = await ctx.db.get(id);
  if (copy === null) {
    return errorResult(notFoundError("calendarCopies"));
  }
  const connection = await ctx.db.get(copy.connectionId);
  const actorUserId = ctx.db.normalizeId("users", context.actor.userId);
  const actorCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
  if (
    connection === null ||
    actorUserId === null ||
    actorCompanyId === null ||
    connection.userId !== actorUserId ||
    connection.companyId !== actorCompanyId
  ) {
    // Not the actor's own copy in the actor's own firm: not_found.
    return errorResult(notFoundError("calendarCopies"));
  }
  if (connection.state !== "connected" || connection.googleCalendarId === undefined) {
    // The certified `unavailable` error kind: reconciliation cannot be
    // served for this copy right now (no healthy connection, no dedicated
    // calendar) — an honest refusal, never a fake outcome.
    return errorResult(unavailableError(false, "calendar_reconcile_unavailable"));
  }
  await registerDurableJob(ctx, {
    kind: "calendar.reconcile_outcome",
    input: { copyId: id, lastKnownOutcome: copy.remoteOutcome },
    companyId: connection.companyId,
    policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
    jobKey: newDurableJobKey(),
  });
  return okResult({ copyId: id, remoteOutcome: copy.remoteOutcome });
}

/**
 * Dispatches one calendar sync command envelope inside ONE mutation
 * transaction, through the checked path with B1's identity source and the
 * G3 policy.
 */
export async function dispatchCalendarSyncCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: calendarSyncPolicy,
      handlers: calendarSyncHandlers(),
    },
    ctx,
    envelope,
  );
}
