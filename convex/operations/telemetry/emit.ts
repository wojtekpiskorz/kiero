/**
 * The emit boundary (I2): the ONE write path into `diagnosticEvents`.
 *
 * Every producer - Convex lanes (in-transaction), the HTTP ingest endpoint,
 * the incident scan, the cost evaluator, the gateway - goes through
 * `emitDiagnosticEvent`, which:
 *
 * 1. sanitizes through the single redaction definition (`./redact.ts`);
 * 2. rejects malformed events WITHOUT throwing (telemetry is best effort and
 *    must never abort a caller's transaction);
 * 3. dedups on `dedupKey` so periodic incident scans diagnose one row once;
 * 4. stamps trusted server time and `forwardedAtMs: 0` (not yet forwarded).
 *
 * Deliberately NOT an outbox publication: diagnostics are best-effort
 * telemetry, not canonical domain history (architecture: "Treat telemetry
 * delivery as best effort and canonical audit/domain records as authority").
 * The registered `operations.diagnosticEmitted` domain event stays available
 * for the checked GM dispatch path (H4/B4 wiring).
 */

import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { REDACTION_VERSION, sanitizeDiagnosticEvent } from "./redact";

export interface EmitInput {
  /** Untyped on purpose: the sanitizer is the validation authority. */
  readonly kind: unknown;
  readonly metadata: unknown;
  readonly serviceName?: string;
  readonly environment?: string;
  /** Idempotent scan identity; an event with this key exists -> skip. */
  readonly dedupKey?: string;
}

export interface EmitResult {
  readonly emitted: boolean;
  readonly reason?: string;
  readonly diagnosticEventId?: Id<"diagnosticEvents">;
  readonly redactionsApplied?: number;
}

/**
 * Emits one redacted diagnostic event inside the caller's transaction.
 * Never throws: rejected/deduplicated inputs return a result.
 */
export async function emitDiagnosticEvent(
  tx: MutationCtx,
  input: EmitInput,
): Promise<EmitResult> {
  const sanitized = sanitizeDiagnosticEvent({
    kind: input.kind,
    metadata: input.metadata,
    ...(input.serviceName === undefined ? {} : { serviceName: input.serviceName }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  if (sanitized.status === "rejected") {
    return { emitted: false, reason: sanitized.reason };
  }
  const event = sanitized.event;

  if (input.dedupKey !== undefined) {
    const existing = await tx.db
      .query("diagnosticEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey as string))
      .first();
    if (existing !== null) {
      return { emitted: false, reason: "deduplicated", diagnosticEventId: existing._id };
    }
  }

  const diagnosticEventId = await tx.db.insert("diagnosticEvents", {
    kind: event.kind,
    technicalMetadata: event.metadata.map((entry) => ({ key: entry.key, value: entry.value })),
    ...(event.redactionsApplied > 0 ? { redactionsApplied: event.redactionsApplied } : {}),
    redactionVersion: REDACTION_VERSION,
    ...(event.serviceName === undefined ? {} : { serviceName: event.serviceName }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
    forwardedAtMs: 0,
    atMs: Date.now(),
  });
  return {
    emitted: true,
    diagnosticEventId,
    ...(event.redactionsApplied > 0 ? { redactionsApplied: event.redactionsApplied } : {}),
  };
}

/**
 * Typed metadata constructor: builds a format-safe entry list at compile-time
 * call sites. Producers should prefer this over hand-writing `{key, value}`
 * arrays; the sanitizer still validates (defense in depth).
 */
export function metadata(
  ...entries: readonly { key: string; value: string }[]
): { key: string; value: string }[] {
  return entries.map((entry) => ({ key: entry.key, value: entry.value }));
}
