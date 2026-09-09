/**
 * Sources uploads dispatch wiring (D2): the SAME checked path A3/D1 proved,
 * for both entry classes of the uploads lane.
 *
 * 1. The certified client operations (`sources.prepareUpload`,
 *    `sources.resumeUpload`) dispatch through @kiero/runtime's
 *    `dispatchCommand` — Convex Auth identity on the user path, the verified
 *    service session on the Worker path — and keep their certified result
 *    shapes ({uploadId, stage}).
 *
 * 2. The gateway upload protocol steps (begin/part/complete/finalize/
 *    reconcile) are NOT certified client operations; they run through the
 *    lane's own mirror of the same check order: step envelope decode ->
 *    known step -> context resolution from a verified identity -> policy
 *    authorization -> input decode -> handler, with handler throws
 *    sanitized to `unavailable`. The identity sources are exactly the two
 *    verified ones (Convex Auth, service bridge); there is no shortcut.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  decodeInput,
  dispatchCommand,
  membershipPolicy,
  sanitizeUnknownError,
  unsupportedError,
  validationError,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import { bridgeIdentity, identityFromConvexAuth, resolveRequestContext } from "../../platform/context";
import type { MutationCtx } from "../../_generated/server";
import {
  BeginInput,
  CompleteInput,
  PartInput,
  PrepareInput,
  UploadRefInput,
  UploadStepEnvelope,
} from "./protocol";
import {
  beginUploadTransaction,
  completeAttachmentTransaction,
  finalizeUploadTransaction,
  prepareUploadTransaction,
  recordPartTransaction,
  reconcileUploadsTransaction,
  resumeUploadTransaction,
} from "./ledger";

/** Handler table for sources uploads command dispatches (exported for tests). */
export function uploadsHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "sources.prepareUpload": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(PrepareInput)(input);
        const result = await prepareUploadTransaction(tx, context, decoded);
        if (result._tag === "error") {
          return result;
        }
        const value = result.value as {
          uploadId: string;
          stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
        };
        // The certified client result shape: exactly {uploadId, stage}.
        return { _tag: "ok" as const, value: { uploadId: value.uploadId, stage: value.stage } };
      },
    },
    "sources.resumeUpload": {
      intent: "read",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(UploadRefInput)(input);
        return resumeUploadTransaction(tx, context, decoded.uploadId);
      },
    },
  };
}

/**
 * Dispatches one certified sources uploads command envelope inside a
 * mutation transaction (the D1 dispatchSourcesCommand pattern).
 */
export async function dispatchUploadsCommand(
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
    handlers: uploadsHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}

// ---------------------------------------------------------------------------
// The gateway protocol step dispatch (same check order as dispatchCommand).
// ---------------------------------------------------------------------------

/** The codec shape `decodeInput` accepts (the checked decode boundary). */
type StepInputCodec = Parameters<typeof decodeInput>[0];

interface StepBinding {
  readonly intent: "read" | "write";
  readonly input: StepInputCodec;
  readonly run: (tx: MutationCtx, context: RequestContext, input: unknown) => Promise<ResultEnvelope>;
}

const EmptyInput = Schema.Struct({});

const stepHandlers: Record<string, StepBinding> = {
  begin: {
    intent: "write",
    input: BeginInput,
    run: (tx, context, input) => beginUploadTransaction(tx, context, input as never),
  },
  part: {
    intent: "write",
    input: PartInput,
    run: (tx, context, input) => recordPartTransaction(tx, context, input as never),
  },
  complete: {
    intent: "write",
    input: CompleteInput,
    run: (tx, context, input) => completeAttachmentTransaction(tx, context, input as never),
  },
  finalize: {
    intent: "write",
    input: UploadRefInput,
    run: (tx, context, input) => finalizeUploadTransaction(tx, context, input as never),
  },
  reconcile: {
    intent: "write",
    input: EmptyInput,
    run: (tx, context) => reconcileUploadsTransaction(tx, context),
  },
};

/**
 * Dispatches one gateway protocol step inside a mutation transaction.
 * `prepare` routes through the CERTIFIED operation path (the same handler
 * the client uses), so client and Worker see one prepare implementation.
 */
export async function dispatchUploadsStep(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const decodedEnvelope = decodeInput(UploadStepEnvelope, envelope);
  if (!decodedEnvelope.ok) {
    return decodedEnvelope.error;
  }
  const { step, input } = decodedEnvelope.value;
  if (step === "prepare") {
    return dispatchUploadsCommand(
      ctx,
      { operation: "sources.prepareUpload", input, expectedRevisions: [] },
      serviceSessionId,
    );
  }
  const binding = stepHandlers[step];
  if (binding === undefined) {
    return {
      _tag: "error",
      error: unsupportedError(`sources.uploads.${step}`, "unknown_step"),
    } as ResultEnvelope;
  }
  const decodedInput = decodeInput(binding.input, input);
  if (!decodedInput.ok) {
    return decodedInput.error;
  }
  const identity =
    serviceSessionId === undefined
      ? await identityFromConvexAuth(ctx.auth, Date.now())
      : bridgeIdentity(serviceSessionId, Date.now());
  const context = await resolveRequestContext(ctx.db, identity);
  const decision = await membershipPolicy.authorize(context, { intent: binding.intent });
  if (!decision.allowed) {
    return { _tag: "error", error: decision.error } as ResultEnvelope;
  }
  if (context === null) {
    // Unreachable when the policy is sane; kept fail-closed regardless.
    return { _tag: "error", error: validationError("no_verified_identity") } as ResultEnvelope;
  }
  try {
    return await binding.run(ctx, context, decodedInput.value);
  } catch (cause) {
    return { _tag: "error", error: sanitizeUnknownError(cause) } as ResultEnvelope;
  }
}
