/**
 * @kiero/runtime: the platform runtime (A3).
 *
 * Small public interface, deep internals (execution charter: "Effect
 * execution, checked runtime interfaces, durable stage registration"):
 *
 * - `dispatchCommand` — the one checked path every operation invocation takes
 *   (registry lookup, context resolution, authorization seam, contract input
 *   decode, sanitized handlers). Invalid input reaches no domain effect.
 * - `VerifiedIdentity`, `resolveContextFrom*`, `RequestContext`,
 *   `AccessPolicy`/`membershipPolicy` — the actor/session/tenant context and
 *   the authorization seam B1/B3 plug authoritative rules into.
 * - `decideEventPublication`, `decideJobRegistration`, `nextDeliveryState`,
 *   `backoffDelayMs`, `reconcileMayRetry` — the single definition of outbox
 *   idempotency, retry and uncertain-outcome rules used by the transactional
 *   publishers in `convex/platform/publish.ts`.
 * - `runDomainEffect` — Effect 4 RC execution inside Convex functions with a
 *   bounded deadline and defect sanitization.
 * - `toolJsonSchema` — the TanStack AI standard-schema -> JSON-schema
 *   conversion over A2 contract schemas (no provider calls).
 *
 * The Convex-coupled halves (real table access, the native scheduler, the
 * workflow engine, HTTP boundaries) live in `convex/platform/**` and
 * `apps/gateway/src/platform/**`; this package stays Convex-free and pure so
 * every decision rule is unit-testable without mocks.
 */

export * from "./errors";
export * from "./decode";
export * from "./context";
export * from "./command";
export * from "./outbox";
export * from "./effectRun";
export * from "./tools";

/** Version of the platform runtime (exposed through health/diagnostics). */
export const RUNTIME_VERSION = "a3.0" as const;
