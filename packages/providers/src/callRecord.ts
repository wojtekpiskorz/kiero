/**
 * Route/model/version recording per provider call (E2).
 *
 * Every provider call produces one immutable record of its attempts: which
 * model was requested (the accepted order position actually tried), which
 * model actually served the request as observed in the provider's response
 * (never assumed from the request), the routing configuration version the
 * decision was made under, latency, observed usage and the sanitized failure
 * classification when an attempt failed.
 *
 * Consumers:
 * - `processingAttempts` rows (platform pipeline tables) carry the
 *   provider/model/outcome columns; E3+ stages copy these values when a
 *   durable step owns the call.
 * - the corpus runner (J3, `evals/expected/scoring/run-report.schema.json`)
 *   needs per-component `provider`/`model`/`route`, `latencyMs` and `cost`
 *   from exactly these fields.
 *
 * The record schema is decode-checked (Effect Schema) like every other
 * contract value, and carries no prompt, transcript, tool argument, image or
 * provider payload — only routing metadata.
 */

import { Schema } from "effect";
import { ProviderFailureKind } from "./failures";
import { ROUTING_CONFIG_VERSION } from "./routing";

/** Route ids reuse the A2 integrations contract vocabulary. */
export const ProviderCallRouteId = Schema.Literals([
  "chat_analysis",
  "vision_extraction",
  "speech_to_text",
  "embedding",
]);
export type ProviderCallRouteId = Schema.Schema.Type<typeof ProviderCallRouteId>;

/** Observed token/cost usage as reported by the provider (absent is not zero). */
export const UsageObservation = Schema.Struct({
  promptTokens: Schema.optionalKey(Schema.Number),
  completionTokens: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.optionalKey(Schema.Number),
  /** Reported audio duration in seconds (transcription routes). */
  audioSeconds: Schema.optionalKey(Schema.Number),
  /** Reported request cost in USD/credits when the provider reports one. */
  costUsd: Schema.optionalKey(Schema.Number),
});
export type UsageObservation = Schema.Schema.Type<typeof UsageObservation>;

/** Outcome of one ordered attempt against one requested model. */
export const ProviderCallAttempt = Schema.Struct({
  routeId: ProviderCallRouteId,
  /** Frozen routing configuration version the attempt ran under. */
  routingConfigVersion: Schema.NonEmptyString,
  /** The model this attempt requested (position in the accepted order). */
  requestedModel: Schema.NonEmptyString,
  /** The model that actually served the response, as observed in it. */
  observedModel: Schema.optionalKey(Schema.NonEmptyString),
  outcome: Schema.Literals(["succeeded", "failed"]),
  /** Sanitized failure classification; present exactly when outcome is failed. */
  failureKind: Schema.optionalKey(ProviderFailureKind),
  /** Whether the failure was classified eligible for the ordered fallback. */
  fallbackEligible: Schema.optionalKey(Schema.Boolean),
  startedAtMs: Schema.Number,
  finishedAtMs: Schema.Number,
  /** First streamed output observed, when the adapter reported one. */
  firstOutputAtMs: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(UsageObservation),
});
export type ProviderCallAttempt = Schema.Schema.Type<typeof ProviderCallAttempt>;

/** The record of one complete provider call (attempts in accepted order). */
export const ProviderCallRecord = Schema.Struct({
  routeId: ProviderCallRouteId,
  routingConfigVersion: Schema.NonEmptyString,
  attempts: Schema.Array(ProviderCallAttempt).pipe(
    Schema.check(Schema.isMinLength(1)),
  ),
});
export type ProviderCallRecord = Schema.Schema.Type<typeof ProviderCallRecord>;

/** Constructs a fresh in-progress record context for one route. */
export function newCallRecord(routeId: ProviderCallRouteId): {
  routeId: ProviderCallRouteId;
  routingConfigVersion: string;
  attempts: ProviderCallAttempt[];
} {
  return {
    routeId,
    routingConfigVersion: ROUTING_CONFIG_VERSION,
    attempts: [],
  };
}

/** Seals the attempts into the decoded record value. */
export function sealCallRecord(
  builder: ReturnType<typeof newCallRecord>,
): ProviderCallRecord {
  return Schema.decodeUnknownSync(ProviderCallRecord)({
    routeId: builder.routeId,
    routingConfigVersion: builder.routingConfigVersion,
    attempts: builder.attempts,
  });
}

/** The attempt that succeeded, when one did (the route that actually served). */
export function succeededAttempt(
  record: ProviderCallRecord,
): ProviderCallAttempt | undefined {
  return record.attempts.find((attempt) => attempt.outcome === "succeeded");
}

/** The last recorded failure, when no attempt succeeded. */
export function finalFailure(
  record: ProviderCallRecord,
): ProviderCallAttempt | undefined {
  if (succeededAttempt(record) !== undefined) {
    return undefined;
  }
  return record.attempts[record.attempts.length - 1];
}
