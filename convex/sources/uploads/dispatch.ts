/**
 * Sources uploads dispatch wiring (D2): the SAME checked path A3/D1 proved,
 * with ONE identity source — the END USER's verified Convex Auth session
 * (B1's live-session resolution feeding A3's canonical chain).
 *
 * 1. The certified client operations (`sources.prepareUpload`,
 *    `sources.resumeUpload`) dispatch through @kiero/runtime's
 *    `dispatchCommand` with `ctx.auth` (the browser's Convex Auth token)
 * and keep their certified result shapes ({uploadId, stage}).
 *
 * 2. The gateway upload protocol steps (prepare/begin/part/complete/
 *    finalize/reconcile) are NOT certified client operations, but they ride
 *    the SAME `dispatchCommand` through the optional `entries` override on
 *    `CommandDeps`: this channel maps the wire envelope `{step, input}` to
 *    an operation name and resolves the step's input codec itself
 *    (`sources.prepareUpload` falls through to the composed registry, so
 *    client and Worker see one prepare implementation). The channel's HTTP
 *    boundary forwards the browser's `Authorization` header, Convex
 *    propagates it into this mutation's `ctx.auth`, and the SAME user
 *    identity resolves — the service account is never substituted for a
 *    user-owned ledger row. The checked order is the certified one,
 *    unchanged: envelope decode -> known operation -> context resolution
 *    from a verified identity -> policy authorization -> input decode ->
 *    handler with sanitized throws.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import { operationEntry, type AnyOperationEntry } from "@kiero/contracts";
import {
  decodeInput,
  dispatchCommand,
  membershipPolicy,
  unsupportedError,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "../../access/identity/resolution";
import type { MutationCtx } from "../../_generated/server";
import {
  BeginInput,
  CompleteInput,
  PartInput,
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

/** Step name -> operation name of the uploads channel (closed vocabulary). */
const STEP_OPERATIONS = {
  prepare: "sources.prepareUpload",
  begin: "sources.uploads.begin",
  part: "sources.uploads.part",
  complete: "sources.uploads.complete",
  finalize: "sources.uploads.finalize",
  reconcile: "sources.uploads.reconcile",
} as const;

/**
 * The channel's operation entries: input codecs for the five gateway steps.
 * Certified names (prepare) are absent on purpose and fall through to the
 * composed registry inside `dispatchCommand`.
 */
const channelEntries: Record<string, AnyOperationEntry> = {
  "sources.uploads.begin": operationEntry({
    kind: "operation",
    name: "sources.uploads.begin",
    input: BeginInput,
    result: Schema.Unknown,
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "sources.uploads.part": operationEntry({
    kind: "operation",
    name: "sources.uploads.part",
    input: PartInput,
    result: Schema.Unknown,
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "sources.uploads.complete": operationEntry({
    kind: "operation",
    name: "sources.uploads.complete",
    input: CompleteInput,
    result: Schema.Unknown,
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "sources.uploads.finalize": operationEntry({
    kind: "operation",
    name: "sources.uploads.finalize",
    input: UploadRefInput,
    result: Schema.Unknown,
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "sources.uploads.reconcile": operationEntry({
    kind: "operation",
    name: "sources.uploads.reconcile",
    input: Schema.Struct({}),
    result: Schema.Unknown,
    errorKinds: ["forbidden", "validation"],
  }),
};

/** Handler table for sources uploads command dispatches (exported for tests). */
export function uploadsHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "sources.prepareUpload": {
      intent: "write",
      run: async (tx, context, input) => {
        const result = await prepareUploadTransaction(tx, context, input);
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

/** The ONE identity source: the caller's verified live session (B1 -> A3). */
const resolveContext = (tx: MutationCtx): Promise<RequestContext | null> =>
  resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL);

/**
 * Dispatches one certified sources uploads command envelope inside a
 * mutation transaction, as the authenticated user (B1 identity source).
 */
export async function dispatchUploadsCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: uploadsHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}

/** The gateway protocol steps' handlers (the transactions re-decode input). */
function stepHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "sources.uploads.begin": {
      intent: "write",
      run: (tx, context, input) => beginUploadTransaction(tx, context, input),
    },
    "sources.uploads.part": {
      intent: "write",
      run: (tx, context, input) => recordPartTransaction(tx, context, input),
    },
    "sources.uploads.complete": {
      intent: "write",
      run: (tx, context, input) => completeAttachmentTransaction(tx, context, input),
    },
    "sources.uploads.finalize": {
      intent: "write",
      run: (tx, context, input) => finalizeUploadTransaction(tx, context, input),
    },
    "sources.uploads.reconcile": {
      intent: "write",
      run: (tx, context) => reconcileUploadsTransaction(tx, context),
    },
  };
}

/**
 * Dispatches one gateway protocol step envelope through the SAME checked
 * path AS THE AUTHENTICATED USER: the `{step, input}` wire envelope maps to
 * an operation name, `dispatchCommand` runs with this channel's `entries`
 * override, and the identity is the caller's verified live session (the
 * browser's credential the HTTP boundary forwarded). There is no service
 * substitution and no shortcut.
 */
export async function dispatchUploadsStep(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const decodedEnvelope = decodeInput(UploadStepEnvelope, envelope);
  if (!decodedEnvelope.ok) {
    return decodedEnvelope.error;
  }
  const { step, input } = decodedEnvelope.value;
  const operation = STEP_OPERATIONS[step];
  if (operation === undefined) {
    // Unreachable through the closed step vocabulary; kept fail-closed.
    return {
      _tag: "error",
      error: unsupportedError(`sources.uploads.${step}`, "unknown_step"),
    } as ResultEnvelope;
  }
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: { ...uploadsHandlers(), ...stepHandlers() },
    entries: (name) => channelEntries[name],
  };
  return dispatchCommand(deps, ctx, { operation, input, expectedRevisions: [] });
}
