/**
 * The observability honesty block (I2).
 *
 * PURE MODULE, single definition: consumed by `convex/platform/health.ts`
 * (the A3 re-scope) and the telemetry state reads, and mirrored in
 * infra/observability/dashboards.md. Dashboards and health surfaces must
 * state retention and blind spots accurately; application events never claim
 * full native Convex logging (unavailable on the Free plan, and not simulated).
 */

export interface ObservabilityHonesty {
  /** The accepted diagnostic retention window, in days. */
  readonly diagnosticWindowDays: 30;
  /** Native Convex platform log history is NOT available on the Free plan. */
  readonly nativeConvexLogHistory: "unavailable_on_free_plan";
  /** What the application event stream actually is. */
  readonly applicationEvents: "explicit_redacted_events_only";
  /** Known coverage gaps every dashboard must display. */
  readonly blindSpots: readonly string[];
  /** Telemetry is best effort; domain tables are canonical. */
  readonly authority: "domain_tables_canonical_telemetry_best_effort";
}

export const OBSERVABILITY_HONESTY: ObservabilityHonesty = {
  diagnosticWindowDays: 30,
  nativeConvexLogHistory: "unavailable_on_free_plan",
  applicationEvents: "explicit_redacted_events_only",
  blindSpots: [
    "convex_platform_logs (native log streaming requires Pro)",
    "cloudflare_worker_console_logs (not exported to the sink yet)",
    "provider_console_metrics (OpenRouter/Resend dashboards remain external)",
  ],
  authority: "domain_tables_canonical_telemetry_best_effort",
};
