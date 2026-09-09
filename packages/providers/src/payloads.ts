/**
 * Serializable per-route payload contracts (E2).
 *
 * These are the JSON-shaped requests the `integrations.executeModelCall`
 * operation accepts per route id: bounded, serializable subsets of the typed
 * adapter requests, with NO model, provider or dimensions fields anywhere.
 * In-process consumers (E3+/D6/E5) call the typed adapter interfaces
 * directly; this surface exists so a checked Convex operation can prove and
 * exercise the routes without shipping schema code over the wire.
 */

import { Schema } from "effect";
import { EmbeddingInputKind } from "./embeddings";
import { SttAudioFormat } from "./stt";

/** Bounded conversation text for the serializable chat payload. */
const payloadText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(8_000)),
);

/** Bounded base64 media (audio/image) for the serializable payloads. */
const payloadBase64 = Schema.String.pipe(
  Schema.check(Schema.isMinLength(16)),
  Schema.check(Schema.isMaxLength(1_500_000)),
);

/**
 * `chat_analysis` payload: a plain-text turn (no tools/schema over the wire).
 * No output-token cap: recorded live finding — `max_completion_tokens` under
 * `require_parameters: true` excluded every GLM endpoint.
 */
export const ChatAnalysisPayload = Schema.Struct({
  kind: Schema.Literal("chat_analysis"),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "user", "assistant"]),
      text: payloadText,
    }),
  ).pipe(Schema.check(Schema.isMinLength(1))),
});
export type ChatAnalysisPayload = Schema.Schema.Type<typeof ChatAnalysisPayload>;

/** `vision_extraction` payload: inline image(s) plus a bounded instruction. */
export const VisionExtractionPayload = Schema.Struct({
  kind: Schema.Literal("vision_extraction"),
  instruction: payloadText,
  images: Schema.Array(
    Schema.Struct({
      base64: payloadBase64,
      mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
    }),
  ).pipe(Schema.check(Schema.isMinLength(1))),
});
export type VisionExtractionPayload = Schema.Schema.Type<typeof VisionExtractionPayload>;

/** `speech_to_text` payload: one audio segment for transcription. */
export const SpeechToTextPayload = Schema.Struct({
  kind: Schema.Literal("speech_to_text"),
  audioBase64: payloadBase64,
  audioFormat: SttAudioFormat,
  language: Schema.Literal("pl"),
});
export type SpeechToTextPayload = Schema.Schema.Type<typeof SpeechToTextPayload>;

/** `embedding` payload: one prepared text with its retrieval side. */
export const EmbeddingPayload = Schema.Struct({
  kind: Schema.Literal("embedding"),
  text: payloadText,
  inputKind: EmbeddingInputKind,
});
export type EmbeddingPayload = Schema.Schema.Type<typeof EmbeddingPayload>;

/** The discriminated union of every route payload. */
export const ProviderPayload = Schema.Union([
  ChatAnalysisPayload,
  VisionExtractionPayload,
  SpeechToTextPayload,
  EmbeddingPayload,
]);
export type ProviderPayload = Schema.Schema.Type<typeof ProviderPayload>;

/**
 * The pinned structured-output contract used by the serializable vision and
 * probe paths: bounded text claims only. Real extraction contracts (E4) are
 * richer and stay in-process with the typed adapter.
 */
export const ProbeExtractionSchema = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      text: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(2_000)),
      ),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50))),
});
export type ProbeExtraction = Schema.Schema.Type<typeof ProbeExtractionSchema>;
