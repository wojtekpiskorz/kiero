/**
 * The image-extraction adapter (E2).
 *
 * Image reading rides the chat adapter's typed request shape with inline
 * image content parts, routed over the accepted vision order (GLM then
 * Gemini; the text-only DeepSeek route is never eligible for vision — it
 * receives completed extraction TEXT only, through the ordinary chat route).
 * Extraction results are always structured: the caller's Effect Schema
 * contract (E4 owns the real extraction schema) is pinned as strict
 * `json_schema` and the completion must decode through it.
 *
 * If every image-capable route fails, the caller keeps the image extraction
 * pending and processes only information whose basis is available
 * (architecture "Provider configuration"): this adapter fails honestly
 * instead of substituting a text-only model.
 */

import { Schema } from "effect";
import { PROVIDER_ROUTING, type ModelRoute } from "./routing";
import {
  chatWithRoute,
  type ChatCallResult,
  type OpenRouterCredentials,
} from "./chat";

/** One inline image for extraction (bounded by the caller's media pipeline). */
export interface VisionImage {
  readonly base64: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

/** The typed image-extraction request (no model field: route is owned). */
export interface VisionExtractionRequest {
  readonly images: readonly VisionImage[];
  /**
   * Task instruction for the extraction. Bounded plain text; extraction
   * structure comes from `outputSchema`, never from free-form prompting.
   */
  readonly instruction: string;
  /** The extraction result contract the completion must decode through. */
  readonly outputSchema: Schema.Codec<unknown, unknown, never, never>;
}

/** Runs one image extraction over an ordered (server-owned) vision route. */
export async function visionExtractionWithRoute(
  credentials: OpenRouterCredentials,
  route: ModelRoute,
  request: VisionExtractionRequest,
): Promise<ChatCallResult> {
  return chatWithRoute(credentials, "vision_extraction", route, {
    messages: [
      {
        role: "user",
        content: [
          { kind: "text", text: request.instruction },
          ...request.images.map((image) => ({
            kind: "image" as const,
            base64: image.base64,
            mimeType: image.mimeType,
          })),
        ],
      },
    ],
    outputSchema: request.outputSchema,
  });
}

/** The public vision entry point: the frozen accepted vision route. */
export async function runVisionExtraction(
  credentials: OpenRouterCredentials,
  request: VisionExtractionRequest,
): Promise<ChatCallResult> {
  return visionExtractionWithRoute(credentials, PROVIDER_ROUTING.vision_extraction, request);
}
