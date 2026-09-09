/**
 * The speech-to-text adapter (E2) over OpenRouter's dedicated transcription
 * endpoint (`/api/v1/audio/transcriptions` via `@openrouter/sdk`).
 *
 * STT routing differs from chat (STT research facts): provider order and
 * allowlists from chat routing do NOT apply to transcription requests, so the
 * accepted order (`microsoft/mai-transcribe-2` first, `openai/whisper-large-v3`
 * backup) is applied by THIS application-owned bounded loop, one model per
 * attempt, exactly like the chat adapter. The JSON base64 request shape is
 * used (not 25MB-limited multipart).
 *
 * Honest limitation recorded for D6: this JSON endpoint returns text and
 * usage only — no segment/word timestamps. Segment timing must come from the
 * segmentation D6 owns (per-segment requests anchored to original audio
 * offsets), never from inventing timestamps here. The transcript is verbatim
 * provider output: cleanup is not this adapter's business.
 */

import { Schema } from "effect";
import { OpenRouter } from "@openrouter/sdk";
import {
  PROVIDER_ROUTING,
  STT_ATTEMPT_DEADLINE_MS,
  type ModelRoute,
} from "./routing";
import { classifySdkFailure, providerFailure, type ProviderFailure } from "./failures";
import {
  newCallRecord,
  sealCallRecord,
  ProviderCallAttempt as ProviderCallAttemptSchema,
  type ProviderCallRecord,
} from "./callRecord";
import type { OpenRouterCredentials } from "./chat";

/** Audio container formats the JSON transcription body accepts. */
export const SttAudioFormat = Schema.Literals(["wav", "mp3", "webm", "m4a", "ogg"]);
export type SttAudioFormat = Schema.Schema.Type<typeof SttAudioFormat>;

/** The typed transcription request (no model field: route is owned). */
export interface SttRequest {
  /** Base64-encoded segment audio (the caller owns segmentation). */
  readonly audioBase64: string;
  readonly audioFormat: SttAudioFormat;
  /** Polish speech is the product's primary input. */
  readonly language: "pl";
}

/**
 * The decoded transcription result. `text` must be non-empty: an empty
 * transcript is a rejected output, not a success (a missing required segment
 * stays pending, never silently complete). The `usage` fields model the
 * endpoint's wire vocabulary (`seconds`, `totalTokens`, `cost` in USD).
 */
export const SttTranscription = Schema.Struct({
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  usage: Schema.optionalKey(
    Schema.Struct({
      /** Reported audio duration in seconds, when the provider returns it. */
      seconds: Schema.optionalKey(Schema.Number),
      /** Reported billed tokens, when the provider returns them. */
      totalTokens: Schema.optionalKey(Schema.Number),
      /** Reported request cost in USD, when reported. */
      cost: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type SttTranscription = Schema.Schema.Type<typeof SttTranscription>;

/** What one STT call returns: typed output plus the route record. */
export interface SttCallResult {
  readonly outcome:
    | { readonly outcome: "succeeded"; readonly value: SttTranscription }
    | { readonly outcome: "failed"; readonly failure: ProviderFailure };
  readonly record: ProviderCallRecord;
}

/**
 * The provider body is untrusted data: decoded through `SttTranscription`
 * before it can be consumed. A body that is not the expected object shape,
 * empty text or non-finite usage rejects as `output_rejected` (fail closed).
 * Exported for the focused verification fixtures (tests/e2).
 */
export function decodeTranscription(
  body: unknown,
): { ok: true; value: SttTranscription } | { ok: false } {
  const decoded = Schema.decodeUnknownOption(SttTranscription)(body);
  return decoded._tag === "Some" ? { ok: true, value: decoded.value } : { ok: false };
}

/** Runs ONE transcription attempt against one model (no fallback decisions). */
export async function sttAttempt(
  credentials: OpenRouterCredentials,
  model: string,
  request: SttRequest,
): Promise<
  | { ok: true; value: SttTranscription; observedModel: string | undefined }
  | { ok: false; failure: ProviderFailure }
> {
  const client = new OpenRouter({
    apiKey: credentials.apiKey,
    timeoutMs: STT_ATTEMPT_DEADLINE_MS,
    retryConfig: { strategy: "none" },
  });
  try {
    // The SDK types this response, but the wire body is still provider
    // output: it is re-decoded below, not trusted by type assertion.
    const response: unknown = await client.stt.createTranscription({
      sttRequest: {
        model,
        language: request.language,
        inputAudio: { data: request.audioBase64, format: request.audioFormat },
      },
    });
    const decoded = decodeTranscription(response);
    if (!decoded.ok) {
      return { ok: false, failure: providerFailure("output_rejected") };
    }
    // The JSON transcription body does not echo the serving model; the
    // requested model is the honest recorded route for this endpoint.
    return { ok: true, value: decoded.value, observedModel: undefined };
  } catch (cause) {
    return { ok: false, failure: classifySdkFailure(cause) };
  }
}

/**
 * Runs one transcription over an ordered (server-owned) STT route with the
 * same bounded classification discipline as chat: eligible failures advance
 * to the backup model, incompatible output fails closed.
 */
export async function transcriptionWithRoute(
  credentials: OpenRouterCredentials,
  route: ModelRoute,
  request: SttRequest,
  attemptFunction: typeof sttAttempt = sttAttempt,
): Promise<SttCallResult> {
  const builder = newCallRecord("speech_to_text");
  let lastFailure: ProviderFailure = providerFailure("provider_unavailable");
  for (const model of route.order) {
    const startedAtMs = Date.now();
    const attempt = await attemptFunction(credentials, model, request);
    const finishedAtMs = Date.now();
    if (!attempt.ok) {
      lastFailure = attempt.failure;
      builder.attempts.push(
        Schema.decodeUnknownSync(ProviderCallAttemptSchema)({
          routeId: "speech_to_text",
          routingConfigVersion: builder.routingConfigVersion,
          requestedModel: model,
          outcome: "failed",
          failureKind: attempt.failure.kind,
          fallbackEligible: attempt.failure.fallbackEligible,
          startedAtMs,
          finishedAtMs,
        }),
      );
      if (!attempt.failure.fallbackEligible) {
        return {
          outcome: { outcome: "failed", failure: attempt.failure },
          record: sealCallRecord(builder),
        };
      }
      continue;
    }
    builder.attempts.push(
      Schema.decodeUnknownSync(ProviderCallAttemptSchema)({
        routeId: "speech_to_text",
        routingConfigVersion: builder.routingConfigVersion,
        requestedModel: model,
        outcome: "succeeded",
        startedAtMs,
        finishedAtMs,
        ...(attempt.value.usage === undefined
          ? {}
          : {
              usage: {
                ...(attempt.value.usage.totalTokens === undefined &&
                attempt.value.usage.seconds === undefined
                  ? {}
                  : {
                      totalTokens:
                        attempt.value.usage.totalTokens ?? attempt.value.usage.seconds,
                    }),
                ...(attempt.value.usage.cost === undefined
                  ? {}
                  : { costUsd: attempt.value.usage.cost }),
              },
            }),
      }),
    );
    return {
      outcome: { outcome: "succeeded", value: attempt.value },
      record: sealCallRecord(builder),
    };
  }
  return { outcome: { outcome: "failed", failure: lastFailure }, record: sealCallRecord(builder) };
}

/** The public STT entry point: the frozen accepted transcription route. */
export async function runTranscription(
  credentials: OpenRouterCredentials,
  request: SttRequest,
): Promise<SttCallResult> {
  return transcriptionWithRoute(credentials, PROVIDER_ROUTING.speech_to_text, request);
}
