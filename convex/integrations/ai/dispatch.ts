/**
 * AI integration dispatch wiring (E2): `integrations.executeModelCall`.
 *
 * The adapters from `@kiero/providers` sit behind the SAME A3 checked path
 * every other operation takes (`dispatchCommand`): registry lookup, context
 * resolution from a verified identity, authorization, contract input decode,
 * sanitized handler. This module follows the Worker-bridge dispatch template
 * (convex/platform/dispatch.ts) because provider calls are external effects:
 * they run in an ACTION, never inside the transaction that would commit a
 * domain change (the echo executor's protocol, A3).
 *
 * External-outcome discipline (echo template):
 * - the call happens exactly once per dispatched operation attempt here;
 * - a bounded deadline bounds it; the sanitized classified outcome is
 *   published as the declared `integrations.providerCallCompleted` event
 *   (route + actual model + outcome only) through the standard outbox;
 * - uncertain outcomes (`deadline_exceeded`, connection-level failures) are
 *   recorded as `timeout_unknown`, the vocabulary the event contract
 *   reserves for them;
 * - if the action itself dies mid-call, no event is written: that absence is
 *   the observable "unknown outcome" reconciliation input for the operations
 *   owner (H4/I2), never a license for a blind retry.
 *
 * Named prerequisite (recorded honestly, not worked around): the certified
 * contracts have no durable job kind for model calls and no provider-call
 * table. Durable model-call executors (per-segment STT, extraction steps)
 * need a coordinated `DurableJobKind` addition in `@kiero/contracts`; the
 * processing pipeline lanes (D6/E3-E5) own those kinds, and their executors
 * reuse the provider package's classification and recording rather than the
 * reverse. `processingAttempts` remains the per-step recording surface once
 * steps exist.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  errorResult,
  okResult,
  integrationsOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  unavailableError,
  validationError,
  type CommandDeps,
} from "@kiero/runtime";
import {
  ProbeExtractionSchema,
  ProviderPayload,
  failureToClosedError,
  finalFailure,
  providerFailure,
  runChatTurn,
  runEmbedding,
  runTranscription,
  runVisionExtraction,
  succeededAttempt,
  type ChatMessagePart,
  type OpenRouterCredentials,
  type ProviderCallRecord,
  type ProviderFailureKind,
} from "@kiero/providers";
import type { ActionCtx } from "../../_generated/server";
import type { BridgeResolvedContext } from "../../platform/dispatch";

const executeModelCallEntry = integrationsOperations["integrations.executeModelCall"];

/** The AI dispatch context: the HTTP/bridge action plus its verified session. */
export interface AiBridgeCtx {
  readonly action: ActionCtx;
  readonly serviceSessionId: string;
}

/** Reads the server-held OpenRouter key; presence only, never its value. */
function openRouterCredentials(): OpenRouterCredentials | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/** Event-outcome vocabulary mapping per the echo uncertain-outcome template. */
function eventOutcome(
  failureKind: ProviderFailureKind | undefined,
): "succeeded" | "failed" | "timeout_unknown" {
  if (failureKind === undefined) {
    return "succeeded";
  }
  return failureKind === "deadline_exceeded" || failureKind === "connection_failed"
    ? "timeout_unknown"
    : "failed";
}

/** Publishes the sanitized per-call record event through the standard outbox. */
async function publishCallCompleted(
  ctx: AiBridgeCtx,
  companyId: string,
  record: {
    readonly routeId: string;
    readonly actualModel: string;
    readonly failureKind?: ProviderFailureKind;
  },
): Promise<void> {
  await ctx.action.runMutation(internal.integrations.ai.record.recordProviderCall, {
    companyId,
    routeId: record.routeId,
    actualModel: record.actualModel,
    outcome: eventOutcome(record.failureKind),
  });
}

/** The metadata one executed call reports through the contract result. */
interface CallMetadata {
  readonly actualModel: string;
  readonly usageTokens: number;
  readonly durationMs: number;
}

/** The per-call record summary published as the completion event. */
interface CallRecordSummary {
  readonly routeId: string;
  readonly actualModel: string;
  readonly failureKind?: ProviderFailureKind;
}

/** Summarizes one adapter call into the executed-payload outcome. */
function summarize(
  routeId: string,
  call: { readonly record: ProviderCallRecord },
): PayloadExecution {
  const success = succeededAttempt(call.record);
  const failure = finalFailure(call.record);
  if (success !== undefined) {
    const actualModel = success.observedModel ?? success.requestedModel;
    return {
      kind: "executed",
      ok: true,
      metadata: {
        actualModel,
        usageTokens: success.usage?.totalTokens ?? 0,
        durationMs: success.finishedAtMs - success.startedAtMs,
      },
      summary: { routeId, actualModel },
    };
  }
  const kind = failure?.failureKind ?? "provider_unavailable";
  return {
    kind: "executed",
    ok: false,
    summary: {
      routeId,
      actualModel: failure?.observedModel ?? failure?.requestedModel ?? "unknown",
      failureKind: kind,
    },
  };
}

/** The outcome of executing one serializable payload. */
type PayloadExecution =
  | {
      readonly kind: "executed";
      readonly ok: boolean;
      readonly metadata?: CallMetadata;
      readonly summary: CallRecordSummary;
    }
  | { readonly kind: "invalid_payload" };

/** Maps one serializable payload to its adapter call (external, in-action). */
async function executePayload(
  credentials: OpenRouterCredentials,
  payload: unknown,
): Promise<PayloadExecution> {
  const decodedPayload = Schema.decodeUnknownOption(ProviderPayload)(payload);
  if (decodedPayload._tag === "None") {
    return { kind: "invalid_payload" };
  }
  const value = decodedPayload.value;
  switch (value.kind) {
    case "chat_analysis": {
      const messages: ChatMessagePart[] = value.messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: [{ kind: "text", text: message.text }],
      }));
      const call = await runChatTurn(credentials, { messages });
      return summarize("chat_analysis", call);
    }
    case "vision_extraction": {
      const call = await runVisionExtraction(credentials, {
        images: value.images,
        instruction: value.instruction,
        outputSchema: ProbeExtractionSchema,
      });
      return summarize("vision_extraction", call);
    }
    case "speech_to_text": {
      const call = await runTranscription(credentials, {
        audioBase64: value.audioBase64,
        audioFormat: value.audioFormat,
        language: value.language,
      });
      // The transcription endpoint does not echo the serving model; the
      // requested (accepted-order) model is the honest recorded route.
      return summarize("speech_to_text", call);
    }
    case "embedding": {
      const call = await runEmbedding(credentials, {
        text: value.text,
        inputKind: value.inputKind,
      });
      return summarize("embedding", call);
    }
  }
}

/**
 * Dispatches one AI command envelope through the A3 checked path from the
 * verified bridge session. The provider call runs inside the action (never
 * in a transaction); its outcome is recorded through the outbox event.
 */
export async function dispatchAiCommand(
  ctx: AiBridgeCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const deps: CommandDeps<AiBridgeCtx, BridgeResolvedContext> = {
    resolveContext: () =>
      ctx.action.runQuery(internal.platform.context.resolveServiceContext, {
        sessionId: ctx.serviceSessionId,
      }),
    policy: membershipPolicy,
    handlers: {
      "integrations.executeModelCall": {
        intent: "execute",
        run: async (bridge, context, input) => {
          // dispatchCommand already decoded the input against the contract
          // entry; this is the same defensive re-read the A3 probe handlers
          // use (one schema, one authority).
          const decoded = Schema.decodeUnknownSync(executeModelCallEntry.input)(input);
          const credentials = openRouterCredentials();
          if (credentials === null) {
            return errorResult(unavailableError(false, "provider_key_not_configured"));
          }
          const outcome = await executePayload(credentials, decoded.payload);
          if (outcome.kind === "invalid_payload") {
            // Route/payload mismatch: a validation failure, not a provider
            // failure; no provider call happened, so no event is published.
            return errorResult(validationError("provider_payload_route_mismatch"));
          }
          await publishCallCompleted(bridge, context.actor.companyId, outcome.summary);
          if (!outcome.ok || outcome.metadata === undefined) {
            return errorResult(
              failureToClosedError(
                providerFailure(outcome.summary.failureKind ?? "provider_unavailable"),
              ),
            );
          }
          return okResult(Schema.decodeUnknownSync(executeModelCallEntry.result)(outcome.metadata));
        },
      },
    },
  };
  return dispatchCommand(deps, ctx, envelope);
}

/**
 * The callable Convex entry for later joins (gateway/A4 composition): one
 * verified-session action running the checked AI dispatch.
 */
export const executeModelCall = internalAction({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchAiCommand({ action: ctx, serviceSessionId: args.serviceSessionId }, args.envelope),
});
