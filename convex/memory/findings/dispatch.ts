/**
 * Memory/findings command dispatch wiring (C2): the SAME checked path A3
 * proved and B3/D1 reuse, with this lane's handler registry.
 *
 * Two identity sources exist and only two, both verified server-side (see
 * convex/platform/context.ts): Convex Auth (`ctx.auth`) for the user path,
 * and the service bridge (a verified service session id) for the internal
 * transactional entry and the guarded dev-proof actions. There is no
 * development-auth shortcut.
 *
 * The whole dispatch runs inside ONE Convex mutation, so a publication group
 * commits its revisions, provenance and current projections atomically —
 * or nothing does.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import { bridgeIdentity, identityFromConvexAuth, resolveRequestContext } from "../../platform/context";
import { extensionHandlers } from "../extensions/dispatch";
import type { MutationCtx } from "../../_generated/server";
import { performPrepareChangeSet } from "./prepare";
import { performPublishChangeSet } from "./publish";
import {
  performCorrectFinding,
  performRaiseClarification,
  performResolveClarification,
} from "./corrections";
import { readCurrentFindingsRows } from "./read";
import type {
  CorrectFindingInput,
  PrepareChangeSetInput,
  PublishChangeSetInput,
  RaiseClarificationInput,
  ReadCurrentFindingsInput,
  ResolveClarificationInput,
} from "./semantics";

/**
 * Handler table for memory mutation-transaction dispatches (exported for
 * tests). `memory.readCurrentFindings` is registered here so the operation
 * is reachable through the SAME checked command path (the barebones UI query
 * in ./functions.ts is the reactive convenience read).
 *
 * C3 amendment (additive, flagged): the extension operations this dispatch
 * left fail-closed `unsupported` are now registered from the extensions
 * lane's own registry (memory.defineExtension, versionExtensionDefinition,
 * searchExtensionCatalog, validateExtensionValue) — one merged handler table,
 * one checked path.
 *
 * The dispatch decodes the envelope input ONCE and hands the handler the
 * DECODED value (packages/runtime command.ts passes `decodedInput.value`).
 * The handlers below therefore FORWARD that value — re-decoding it (the
 * B3/D1 handler pattern) only works while every field is an untransformed
 * wire shape: schema-transformed values do not decode twice (Effect
 * BigDecimal accepts a decimal string once, then is a BigDecimal), so money
 * plans would always fail with `input_rejected_by_contract_schema`. The
 * single type assertion per handler is backed by the runtime's guarantee
 * that the value was decoded through THIS entry's input schema; a drift
 * between the assertion and the registry still fails the dispatch decode.
 */
export function memoryHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "memory.readCurrentFindings": {
      intent: "read",
      run: async (tx, context, input) => {
        const rows = await readCurrentFindingsRows(
          tx.db,
          context,
          input as ReadCurrentFindingsInput,
        );
        return rows.ok ? okResult({ rows: rows.rows }) : errorResult(rows.error);
      },
    },
    "memory.prepareChangeSet": {
      intent: "write",
      run: (tx, context, input) =>
        performPrepareChangeSet(tx, context, input as PrepareChangeSetInput),
    },
    "memory.publishChangeSet": {
      intent: "write",
      run: (tx, context, input) =>
        performPublishChangeSet(tx, context, input as PublishChangeSetInput),
    },
    "memory.correctFinding": {
      intent: "write",
      run: (tx, context, input) =>
        performCorrectFinding(tx, context, input as CorrectFindingInput),
    },
    "memory.raiseClarification": {
      intent: "write",
      run: (tx, context, input) =>
        performRaiseClarification(tx, context, input as RaiseClarificationInput),
    },
    "memory.resolveClarification": {
      intent: "write",
      run: (tx, context, input) =>
        performResolveClarification(tx, context, input as ResolveClarificationInput),
    },
    ...extensionHandlers(),
  };
}

/**
 * Dispatches one memory command envelope inside a mutation
 * transaction. The optional `serviceSessionId` marks the service-bridge
 * path (identity verified before this point); without it, Convex Auth is
 * the only identity source.
 */
export async function dispatchMemoryCommand(
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
    handlers: memoryHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
