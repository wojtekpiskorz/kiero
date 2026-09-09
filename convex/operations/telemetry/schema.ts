/**
 * Audit and diagnostic tables (A2 candidate, certified by A3; amended by I2).
 *
 * Owning implementer: I2 (redacted diagnostics, health, cost alerts).
 * Audit records are canonical protected data with actor and change/run
 * references. Diagnostic events are redacted, bounded to the accepted 30-day
 * window, and exclude raw messages, audio/images, transcripts, prompts and
 * tokens; the ONLY writer of `diagnosticEvents` is the sanitizer path in
 * `./redact.ts` + `./emit.ts`, so a row that never passed redaction cannot
 * exist (redaction by construction, not by convention). GM activity is
 * audited and excluded from alpha success metrics.
 *
 * I2 amendments (see docs/implementation/contracts/README.md):
 * - `diagnosticEvents`: closed kind union, origin (`serviceName`,
 *   `environment`), `dedupKey` (incident scans diagnose one row once),
 *   required `forwardedAtMs` (0 = not yet forwarded to the external sink)
 *   and a global `by_time` index for windowed retention.
 * - `healthHeartbeats`: the heartbeat ledger backing backend-silence
 *   detection that is independent of Convex's own liveness (an external
 *   prober/the gateway records heartbeats HERE; the sink-side monitor alerts
 *   when they stop arriving).
 * - `costEntries` / `costAlertStates`: the all-in monthly spend accounting
 *   (PLN minor units) behind the accepted 400/500 PLN alert thresholds,
 *   with per-level cooldown bookkeeping.
 *
 * B4 amendment (issue #23, coordinated with I2): `auditRecords` carries the
 * GM request's stated basis and closed outcome plus a `by_grant_time` index
 * — the protected record the issue requires ("GM actor, target company,
 * operation, reason and outcome") and the read path for the alpha-metrics
 * exclusion and H4's audit views.
 *
 * Tables: auditRecords, diagnosticEvents, healthHeartbeats, costEntries,
 * costAlertStates.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";
import { DIAGNOSTIC_EVENT_KINDS } from "./redact";
import { HEARTBEAT_SERVICES } from "./heartbeat";
import { SPEND_PROVIDERS } from "./costs";

/** Closed diagnostic event kind union pinned to the single redaction definition. */
const diagnosticEventKind = v.union(
  ...DIAGNOSTIC_EVENT_KINDS.map((kind) => v.literal(kind)),
);

const heartbeatService = v.union(
  ...HEARTBEAT_SERVICES.map((service) => v.literal(service)),
);

const spendProvider = v.union(
  ...SPEND_PROVIDERS.map((provider) => v.literal(provider)),
);

export const telemetryTables = {
  /** Canonical protected audit trail of significant actions. */
  auditRecords: defineTable({
    companyId: v.optional(shared.companyId),
    actorUserId: v.optional(shared.userId),
    gmGrantId: v.optional(shared.gmAccessGrantId),
    operationName: v.string(),
    changeSetId: v.optional(shared.changeSetId),
    processingRunId: v.optional(shared.processingRunId),
    /**
     * B4 amendment (issue #23): the GM actor's stated basis ("podstawa") and
     * the closed outcome of the audited action. Optional because only GM
     * requests are required to state both; every GM row fills them ("ok" or
     * the closed error code) together with `gmGrantId`, which stays the
     * alpha-metrics exclusion tag.
     */
    gmBasis: v.optional(v.string()),
    outcome: v.optional(v.string()),
    atMs: shared.tsMs,
  })
    .index("by_company_time", ["companyId", "atMs"])
    .index("by_run", ["processingRunId"])
    .index("by_grant_time", ["gmGrantId", "atMs"]),

  /**
   * Redacted technical event within the accepted retention window.
   * `technicalMetadata` is allow-listed per kind and format-checked per key by
   * the sanitizer; there is deliberately no free-form string column.
   */
  diagnosticEvents: defineTable({
    kind: diagnosticEventKind,
    /** Bounded allow-listed technical metadata only; never content. */
    technicalMetadata: v.array(v.object({ key: v.string(), value: v.string() })),
    /** How many values/fields the sanitizer had to drop or redact. */
    redactionsApplied: v.optional(shared.counter),
    redactionVersion: v.string(),
    /** Origin service (gateway.worker, backup.job, convex, ...). */
    serviceName: v.optional(v.string()),
    environment: v.optional(v.string()),
    /** Incident-scan dedup identity (e.g. jobKey of an exhausted row). */
    dedupKey: v.optional(v.string()),
    /** 0 = not yet forwarded to the external sink; set on best-effort delivery. */
    forwardedAtMs: shared.tsMs,
    atMs: shared.tsMs,
  })
    .index("by_kind_time", ["kind", "atMs"])
    .index("by_time", ["atMs"])
    .index("by_dedup", ["dedupKey"]),

  /**
   * Heartbeats from services whose continued operation must be visible.
   * Written by the HTTP boundary when an external prober/gateway/worker
   * pings; the recorder keeps a bounded tail per service. Silence is judged
   * externally (monitor on absent sink events) AND internally (staleness).
   */
  healthHeartbeats: defineTable({
    serviceName: heartbeatService,
    status: v.union(v.literal("ok"), v.literal("degraded")),
    atMs: shared.tsMs,
  }).index("by_service_time", ["serviceName", "atMs"]),

  /**
   * All-in monthly spend accounting per provider, PLN minor units (grosze).
   * Entries are accounting bookkeeping, NOT diagnostics: they outlive the
   * diagnostic window (see retention.ts) and never carry content.
   */
  costEntries: defineTable({
    /** UTC month "YYYY-MM" (cloud billing months are UTC). */
    period: v.string(),
    provider: spendProvider,
    category: v.string(),
    /** Amount in PLN minor units (grosze); non-negative. */
    amountMinor: shared.counter,
    basis: v.union(v.literal("observed"), v.literal("estimate")),
    /** Bounded staging/proof marker; format-checked like all telemetry. */
    label: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
    recordedAtMs: shared.tsMs,
  })
    .index("by_period_provider", ["period", "provider"])
    .index("by_dedup", ["dedupKey"]),

  /** Cooldown bookkeeping for the 400/500 PLN threshold alerts, per period+level. */
  costAlertStates: defineTable({
    period: v.string(),
    level: v.union(v.literal("warning_400"), v.literal("alert_500")),
    thresholdMinor: shared.counter,
    firstFiredAtMs: shared.tsMs,
    lastFiredAtMs: shared.tsMs,
    fireCount: shared.counter,
    lastTotalMinor: shared.counter,
  }).index("by_period_level", ["period", "level"]),
} as const;
