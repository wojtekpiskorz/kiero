/**
 * Search command dispatch wiring (E5): the SAME checked path A3 proved, with
 * this lane's handler registries.
 *
 * Two dispatch shapes, mirroring the sources (D1) and AI (E2) precedents:
 *
 * - the MUTATION dispatch (`dispatchSearchLifecycleCommand`) serves the two
 *   index-generation operations, which are administrative writes on global
 *   derived state: they run (and commit the generation row, the canonical
 *   event and the durable build job atomically) inside one Convex mutation.
 *   Identity resolves exactly like D1's accept path: the B1 live-session
 *   chain for users, the verified service session for the bridge path.
 *
 * - the ACTION dispatch (`dispatchSearchQueryCommand`) serves
 *   `search.queryEvidence`: the query-side embedding is a provider call, so
 *   the handler runs in an action (never in a transaction), reading through
 *   internal queries (actions have no db handle) and reusing the one query
 *   core (./query.ts runEvidenceQuery).
 *
 * Unimplemented search operations fail closed `unsupported` (the A3
 * fail-closed contract); `search.startIndexGeneration` refuses anything but
 * the pinned initial candidate with a typed conflict.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { searchOperations } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "../access/identity/resolution";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  performCutOverIndexGeneration,
  performStartIndexGeneration,
} from "./generations";
import { runEvidenceQuery, type QueryEvidenceInput } from "./query";

export const startIndexEntry = searchOperations["search.startIndexGeneration"];
export const cutOverIndexEntry = searchOperations["search.cutOverIndexGeneration"];
export const queryEvidenceEntry = searchOperations["search.queryEvidence"];

/** Handler table for the lifecycle mutations (exported for tests). */
export function searchMutationHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "search.startIndexGeneration": {
      intent: "administer",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(startIndexEntry.input)(input);
        return performStartIndexGeneration(tx, context, decoded);
      },
    },
    "search.cutOverIndexGeneration": {
      intent: "administer",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(cutOverIndexEntry.input)(input);
        return performCutOverIndexGeneration(tx, context, decoded);
      },
    },
  };
}

/** Dispatches one lifecycle command envelope inside a mutation transaction. */
export async function dispatchSearchLifecycleCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const resolveContext = async (tx: MutationCtx): Promise<RequestContext | null> => {
    if (serviceSessionId !== undefined) {
      return resolveRequestContext(tx.db, bridgeIdentity(serviceSessionId, Date.now()));
    }
    return resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL);
  };
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: searchMutationHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}

/** The action context the query dispatch runs over. */
export type SearchActionCtx = ActionCtx;

/** Handler table for the query action (exported for tests). */
export function searchQueryHandlers(): HandlerRegistry<
  SearchActionCtx,
  Parameters<typeof runEvidenceQuery>[1]
> {
  return {
    "search.queryEvidence": {
      intent: "read",
      run: async (action, context, input) => {
        const decoded = Schema.decodeUnknownSync(queryEvidenceEntry.input)(input);
        return runEvidenceQuery(action, context, decoded as QueryEvidenceInput);
      },
    },
  };
}

/**
 * Dispatches one query command envelope inside an action. The optional
 * `serviceSessionId` marks the bridge path (identity verified before this
 * point); without it, the Convex Auth live session is the only identity
 * source, resolved through the internal context query (auth propagates
 * through runQuery).
 */
export async function dispatchSearchQueryCommand(
  ctx: SearchActionCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const resolveContext =
    serviceSessionId === undefined
      ? () => ctx.runQuery(internal.search.views.userContext, {})
      : () => ctx.runQuery(internal.search.views.serviceContext, { serviceSessionId });
  const deps: CommandDeps<SearchActionCtx, Parameters<typeof runEvidenceQuery>[1]> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: searchQueryHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
