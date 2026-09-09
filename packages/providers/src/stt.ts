/**
 * The speech-to-text adapter (E2) over OpenRouter's dedicated transcription
 * endpoint (`/api/v1/audio/transcriptions` via `@openrouter/sdk`).
 *
 * STT routing differs from chat (STT research facts): provider order and
 * allowlists from chat routing do NOT apply to transcription requests, so the
 * accepted order (`microsoft/mai-transcribe-2` first, `openai/whisper-large-v3`
 * backup) is applied by this application-owned bounded loop, one model per
 * attempt, over the shared ordered-route runner (./runner.ts). The JSON
 * base64 request shape is used (not 25MB-limited multipart).
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
import { runOrderedRoute, type RouteCallResult } from "./runner";
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

/** What one STT call returns: the shared call result over the transcript type. */
export type SttCallResult = RouteCallResult<SttTranscription>;

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

/** Maps the wire usage fields onto the record's usage observation. */
function usageObservation(value: SttTranscription) {
  if (value.usage === undefined) {
    return undefined;
  }
  const usage: { totalTokens?: number; audioSeconds?: number; costUsd?: number } = {};
  if (value.usage.totalTokens !== undefined) {
    usage.totalTokens = value.usage.totalTokens;
  }
  // Audio duration is duration, not tokens: it gets its own record field so
  // a 30-second segment never appears as `usageTokens: 30`.
  if (value.usage.seconds !== undefined) {
    usage.audioSeconds = value.usage.seconds;
  }
  if (value.usage.cost !== undefined) {
    usage.costUsd = value.usage.cost;
  }
  return usage;
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
 * Runs one transcription over an ordered (server-owned) STT route: the
 * shared ordered-route runner owns the loop, records, eligibility
 * short-circuit and record seal; this adapter supplies only the attempt.
 */
export async function transcriptionWithRoute(
  credentials: OpenRouterCredentials,
  route: ModelRoute,
  request: SttRequest,
  attemptFunction: typeof sttAttempt = sttAttempt,
): Promise<SttCallResult> {
  return runOrderedRoute("speech_to_text", route, async (model) => {
    const attempt = await attemptFunction(credentials, model, request);
    if (!attempt.ok) {
      return { ok: false as const, failure: attempt.failure };
    }
    const usage = usageObservation(attempt.value);
    return {
      ok: true as const,
      value: attempt.value,
      ...(attempt.observedModel === undefined ? {} : { observedModel: attempt.observedModel }),
      ...(usage === undefined ? {} : { usage }),
    };
  });
}

/** The public STT entry point: the frozen accepted transcription route. */
export async function runTranscription(
  credentials: OpenRouterCredentials,
  request: SttRequest,
): Promise<SttCallResult> {
  return transcriptionWithRoute(credentials, PROVIDER_ROUTING.speech_to_text, request);
}
