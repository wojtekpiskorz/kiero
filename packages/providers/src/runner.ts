/**
 * The ONE ordered-route runner (E2 structural repair, advisory review
 * round 1; E8 provider-qualified positions): the bounded fallback loop, the
 * per-attempt records, the eligibility short-circuit and the record seal
 * live here exactly once.
 *
 * Every role adapter (chat, vision via chat, STT, embeddings) supplies only
 * its attempt function — one bounded request against ONE provider-qualified
 * target, returning either a typed value plus the observed routing
 * metadata, or a sanitized classified failure. The runner then owns the
 * shared discipline:
 *
 * - each target in the accepted order gets ONE attempt, in order — the
 *   E8 order crosses supplier boundaries (direct DeepSeek first, the
 *   authorized OpenRouter fallback positions next) and the runner treats
 *   them uniformly: eligibility is a property of the FAILURE CLASS, not of
 *   the provider;
 * - a failure advances to the next target ONLY when it was classified
 *   eligible (transport/availability); incompatible output and
 *   configuration failures are terminal for the whole call — a rejected
 *   DeepSeek key or schema must never silently activate OpenRouter;
 * - every attempt is recorded with its provider, requested model, the
 *   observed model and usage when the provider reported them, latency,
 *   first output and the sanitized failure classification — under the
 *   calling role's route id and the frozen routing configuration version;
 * - exhausting the order leaves the last observed eligible failure standing
 *   (both providers failing is the recorded degraded outcome).
 *
 * This is the single place later lanes (D6, E3–E5) reuse for classification
 * and recording; adding a role means writing an attempt function, never a
 * fourth copy of the loop.
 */

import { Schema } from "effect";
import {
  newCallRecord,
  sealCallRecord,
  ProviderCallAttempt as ProviderCallAttemptSchema,
  type ProviderCallRecord,
  type ProviderCallRouteId,
  type UsageObservation,
} from "./callRecord";
import { providerFailure, type ProviderFailure } from "./failures";
import { normalizeRoutePosition, type ModelRoute, type RouteTarget } from "./routing";

/** Routing metadata an attempt can report for its record, when observed. */
export interface AttemptObservation {
  /** The model that actually served the response, as observed in it. */
  readonly observedModel?: string;
  /** Usage as reported by the provider; absent is not zero. */
  readonly usage?: UsageObservation;
  /** First streamed output observed, when the adapter reported one. */
  readonly firstOutputAtMs?: number;
}

/** What one role adapter's attempt function returns for one model. */
export type RouteAttempt<T> =
  | ({ readonly ok: true; readonly value: T } & AttemptObservation)
  | ({ readonly ok: false; readonly failure: ProviderFailure } & AttemptObservation);

/** What one ordered-route call returns: typed output plus the route record. */
export interface RouteCallResult<T> {
  readonly outcome:
    | { readonly outcome: "succeeded"; readonly value: T }
    | { readonly outcome: "failed"; readonly failure: ProviderFailure };
  readonly record: ProviderCallRecord;
}

/** Builds one attempt's record row (decode through the schema, no casts). */
function attemptRow(
  routeId: ProviderCallRouteId,
  routingConfigVersion: string,
  target: RouteTarget,
  observation: AttemptObservation,
  outcome: { readonly succeeded: true } | { readonly succeeded: false; readonly failure: ProviderFailure },
  startedAtMs: number,
  finishedAtMs: number,
) {
  return Schema.decodeUnknownSync(ProviderCallAttemptSchema)({
    routeId,
    routingConfigVersion,
    provider: target.provider,
    requestedModel: target.model,
    ...(observation.observedModel === undefined ? {} : { observedModel: observation.observedModel }),
    ...(outcome.succeeded
      ? { outcome: "succeeded" as const }
      : {
          outcome: "failed" as const,
          failureKind: outcome.failure.kind,
          fallbackEligible: outcome.failure.fallbackEligible,
        }),
    startedAtMs,
    finishedAtMs,
    ...(observation.firstOutputAtMs === undefined ? {} : { firstOutputAtMs: observation.firstOutputAtMs }),
    ...(observation.usage === undefined ? {} : { usage: observation.usage }),
  });
}

/**
 * Runs one role call over an ordered (server-owned) route. `attemptRoute`
 * runs once per provider-qualified target in `route.order`; the runner
 * records, classifies and decides. See the module docs for the exact
 * discipline.
 */
export async function runOrderedRoute<T>(
  routeId: ProviderCallRouteId,
  route: ModelRoute,
  attemptRoute: (target: RouteTarget) => Promise<RouteAttempt<T>>,
): Promise<RouteCallResult<T>> {
  const builder = newCallRecord(routeId);
  let lastFailure: ProviderFailure | undefined;
  for (const position of route.order) {
    // Legacy slug positions normalize to their (only possible) provider;
    // the frozen production routes arrive already provider-qualified.
    const target = normalizeRoutePosition(position);
    const startedAtMs = Date.now();
    const attempt = await attemptRoute(target);
    const finishedAtMs = Date.now();
    if (!attempt.ok) {
      lastFailure = attempt.failure;
      builder.attempts.push(
        attemptRow(routeId, builder.routingConfigVersion, target, attempt, {
          succeeded: false,
          failure: attempt.failure,
        }, startedAtMs, finishedAtMs),
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
      attemptRow(routeId, builder.routingConfigVersion, target, attempt, { succeeded: true }, startedAtMs, finishedAtMs),
    );
    return {
      outcome: { outcome: "succeeded", value: attempt.value },
      record: sealCallRecord(builder),
    };
  }
  // Every position failed with an eligible failure: the last observed one
  // stands (recorded per attempt above). `ModelRoute.order` is a non-empty
  // tuple, so the loop provably ran at least once; the fallback default is
  // unreachable defensive typing, not a real classification.
  const terminal = lastFailure ?? providerFailure("provider_unavailable");
  return { outcome: { outcome: "failed", failure: terminal }, record: sealCallRecord(builder) };
}
