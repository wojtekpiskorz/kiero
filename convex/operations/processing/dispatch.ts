/**
 * GM processing command dispatch wiring (H4): the checked path for the
 * audited processing operations, composed OVER B4's dispatch machinery
 * (envelope decode -> operation allowlist -> GM authority resolution ->
 * contract input decode -> handler) rather than a second copy of it.
 *
 * The allowlist is exactly this lane's three operations. The two-way
 * fail-closed routing stays structural: B4's GM registry
 * (convex/access/gm) contains none of these names, this registry contains
 * none of B4's or any member operation, and the membership dispatches
 * register neither; pinned as such by the focused verification against the
 * REAL registries (tests/h4/dispatch.test.ts).
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import type { MutationCtx } from "../../_generated/server";
import type { GmAuthority } from "../../access/gm/operations";
import {
  dispatchGmCommandWith,
  resolveGmAuthority,
  type GmDispatchDeps,
  type GmHandler,
} from "../../access/gm/dispatch";
import { processingTx } from "./storeAdapter";
import type { ProcessingTx } from "./store";
import {
  inspectProcessingRunEntry,
  performInspectProcessingRun,
  performRequestReanalysis,
  performRetryProcessingStep,
  requestReanalysisEntry,
  retryProcessingStepEntry,
} from "./operations";

/** The operation names the GM processing dispatch routes (this lane). */
export const GM_PROCESSING_OPERATIONS: readonly string[] = [
  "operations.inspectProcessingRun",
  "operations.retryProcessingStep",
  "operations.requestReanalysis",
];

/**
 * Builds one handler from its contract entry. The dispatch has ALREADY
 * decoded the input against the same entry's schema; this decode is the
 * single typing seam that narrows the validated value to its contract type
 * (B4's gmHandlerOf pattern, one home per lane). Each handler builds this
 * lane's ProcessingTx from the mutation context and re-derives nothing:
 * the transactional core re-derives the authority at commit itself.
 */
function processingHandlerOf<Input>(
  entry: { readonly input: Schema.Codec<Input, unknown, never, never> },
  run: (tx: ProcessingTx, authority: GmAuthority, input: Input) => Promise<ResultEnvelope>,
): GmHandler {
  return {
    run: (ctx, _tx, authority, input) =>
      run(processingTx(ctx), authority, Schema.decodeUnknownSync(entry.input)(input)),
  };
}

/** The GM processing handler table (exported for tests: exact keys pinned). */
export function gmProcessingHandlers(): Record<string, GmHandler> {
  return {
    "operations.inspectProcessingRun": processingHandlerOf(
      inspectProcessingRunEntry,
      (tx, authority, input) => performInspectProcessingRun(tx, authority, input),
    ),
    "operations.retryProcessingStep": processingHandlerOf(
      retryProcessingStepEntry,
      (tx, authority, input) => performRetryProcessingStep(tx, authority, input),
    ),
    "operations.requestReanalysis": processingHandlerOf(
      requestReanalysisEntry,
      (tx, authority, input) => performRequestReanalysis(tx, authority, input),
    ),
  };
}

/** The production deps (B4's authority resolution, this lane's registry). */
export function gmProcessingDeps(): GmDispatchDeps {
  return {
    allowlist: GM_PROCESSING_OPERATIONS,
    resolveAuthority: resolveGmAuthority,
    handlers: gmProcessingHandlers(),
  };
}

/** The production GM processing dispatch (the public mutation's handler). */
export async function dispatchGmProcessingCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchGmCommandWith(gmProcessingDeps(), ctx, envelope);
}
