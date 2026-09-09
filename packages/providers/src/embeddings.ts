/**
 * The embeddings adapter (E2) over OpenRouter's `/api/v1/embeddings`.
 *
 * The accepted candidate is `qwen/qwen3-embedding-8b` with native 4096
 * dimensions as the versioned initial proof baseline (architecture
 * "Provider configuration"). The request does not ask for reduced dimensions:
 * any change to dimensions, model or text preparation is a new versioned
 * index generation, not a per-request knob.
 *
 * The response is untrusted data: the vector is decoded as a bounded array of
 * finite floats and its OBSERVED dimension must equal the baseline — a
 * different dimension (or a non-float/base64 body we did not request) is
 * incompatible output and fails closed, because mixing vector generations in
 * one index would silently corrupt retrieval (E5 owns the index lifecycle).
 *
 * Query-side vs document-side text preparation differs for this model family;
 * the caller (E5) versions its preparation and passes the prepared string.
 */

import { Schema } from "effect";
import { OpenRouter } from "@openrouter/sdk";
import {
  EMBEDDING_ATTEMPT_DEADLINE_MS,
  EMBEDDING_DIMENSIONS_BASELINE,
  PROVIDER_ROUTING,
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

/** Which side of retrieval the text belongs to (provider task hint). */
export const EmbeddingInputKind = Schema.Literals(["search_query", "search_document"]);
export type EmbeddingInputKind = Schema.Schema.Type<typeof EmbeddingInputKind>;

/** The typed embedding request (no model/dimensions fields: versioned). */
export interface EmbeddingRequest {
  /** Prepared text; preparation versioning belongs to the caller (E5). */
  readonly text: string;
  readonly inputKind: EmbeddingInputKind;
}

/** The decoded embedding result: a baseline-dimension float vector. */
export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly observedModel: string;
  readonly usage: {
    readonly promptTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
}

/** What one embedding call returns: typed output plus the route record. */
export interface EmbeddingCallResult {
  readonly outcome:
    | { readonly outcome: "succeeded"; readonly value: EmbeddingResult }
    | { readonly outcome: "failed"; readonly failure: ProviderFailure };
  readonly record: ProviderCallRecord;
}

const finiteFloat = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
);

/**
 * Decodes one embeddings response body (unknown) into the typed result.
 * Exported for the focused verification fixtures (tests/e2).
 */
export function decodeEmbedding(
  body: unknown,
): { ok: true; value: EmbeddingResult } | { ok: false } {
  if (typeof body !== "object" || body === null) {
    return { ok: false };
  }
  const record = body as Record<string, unknown>;
  // We request float encoding; a base64 string body is incompatible output.
  const data = record.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false };
  }
  const first = data[0];
  if (typeof first !== "object" || first === null) {
    return { ok: false };
  }
  const embedding = (first as Record<string, unknown>).embedding;
  if (!Array.isArray(embedding)) {
    return { ok: false };
  }
  const vectorDecode = Schema.decodeUnknownOption(Schema.Array(finiteFloat))(embedding);
  if (vectorDecode._tag === "None") {
    return { ok: false };
  }
  const vector = vectorDecode.value;
  if (vector.length !== EMBEDDING_DIMENSIONS_BASELINE) {
    return { ok: false };
  }
  const observedModel = record.model;
  if (typeof observedModel !== "string" || observedModel.length === 0) {
    return { ok: false };
  }
  const usage: { promptTokens?: number; totalTokens?: number; costUsd?: number } = {};
  const rawUsage = record.usage;
  if (typeof rawUsage === "object" && rawUsage !== null) {
    const usageRecord = rawUsage as { promptTokens?: unknown; totalTokens?: unknown; cost?: unknown };
    if (typeof usageRecord.promptTokens === "number") {
      usage.promptTokens = usageRecord.promptTokens;
    }
    if (typeof usageRecord.totalTokens === "number") {
      usage.totalTokens = usageRecord.totalTokens;
    }
    if (typeof usageRecord.cost === "number" && Number.isFinite(usageRecord.cost)) {
      usage.costUsd = usageRecord.cost;
    }
  }
  return { ok: true, value: { vector, observedModel, usage } };
}

/** Runs ONE embedding attempt against one model (no fallback decisions). */
export async function embeddingAttempt(
  credentials: OpenRouterCredentials,
  model: string,
  request: EmbeddingRequest,
): Promise<
  | { ok: true; value: EmbeddingResult }
  | { ok: false; failure: ProviderFailure }
> {
  const client = new OpenRouter({
    apiKey: credentials.apiKey,
    timeoutMs: EMBEDDING_ATTEMPT_DEADLINE_MS,
    retryConfig: { strategy: "none" },
  });
  try {
    // The SDK types this response, but the wire body is still provider
    // output: it is re-decoded below, never trusted by type assertion.
    const response: unknown = await client.embeddings.generate({
      requestBody: {
        model,
        input: request.text,
        inputType: request.inputKind,
        encodingFormat: "float",
      },
    });
    const decoded = decodeEmbedding(response);
    if (!decoded.ok) {
      return { ok: false, failure: providerFailure("output_rejected") };
    }
    return decoded;
  } catch (cause) {
    return { ok: false, failure: classifySdkFailure(cause) };
  }
}

/**
 * Runs one embedding over an ordered (server-owned) route. The accepted
 * embedding route has a single model, so in practice this is one bounded
 * attempt; the loop keeps the same classification/recording discipline as
 * the other adapters for when a coordinated order change ever lands.
 */
export async function embeddingWithRoute(
  credentials: OpenRouterCredentials,
  route: ModelRoute,
  request: EmbeddingRequest,
  attemptFunction: typeof embeddingAttempt = embeddingAttempt,
): Promise<EmbeddingCallResult> {
  const builder = newCallRecord("embedding");
  let lastFailure: ProviderFailure = providerFailure("provider_unavailable");
  for (const model of route.order) {
    const startedAtMs = Date.now();
    const attempt = await attemptFunction(credentials, model, request);
    const finishedAtMs = Date.now();
    if (!attempt.ok) {
      lastFailure = attempt.failure;
      builder.attempts.push(
        Schema.decodeUnknownSync(ProviderCallAttemptSchema)({
          routeId: "embedding",
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
        routeId: "embedding",
        routingConfigVersion: builder.routingConfigVersion,
        requestedModel: model,
        observedModel: attempt.value.observedModel,
        outcome: "succeeded",
        startedAtMs,
        finishedAtMs,
        ...(Object.keys(attempt.value.usage).length === 0
          ? {}
          : { usage: attempt.value.usage }),
      }),
    );
    return {
      outcome: { outcome: "succeeded", value: attempt.value },
      record: sealCallRecord(builder),
    };
  }
  return { outcome: { outcome: "failed", failure: lastFailure }, record: sealCallRecord(builder) };
}

/** The public embedding entry point: the frozen accepted embedding route. */
export async function runEmbedding(
  credentials: OpenRouterCredentials,
  request: EmbeddingRequest,
): Promise<EmbeddingCallResult> {
  return embeddingWithRoute(credentials, PROVIDER_ROUTING.embedding, request);
}
